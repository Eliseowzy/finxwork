//! Model connection management hosted by the existing kernel process.
//! No listener, child service, heartbeat, or periodic token refresh is created.
mod adapter;
pub mod platform;
mod qoder;
mod qwenwork;
use adapter::ProductAdapter;
use async_trait::async_trait;
use finx_llm::connection::{Authorization, ConnectionAuthorizer, ConnectionRequest};
use finx_llm::{AuthConfig, Compat, ErrorKind, LlmError, Modality, ModelRegistry, ProviderConfig};
use finx_protocol::api::{
    ConnectionConnectParams, ConnectionDiscovery, ConnectionModel, ConnectionState, ConnectionView,
    ConnectionsSnapshot,
};
use parking_lot::RwLock;
use platform::Environment;
#[cfg(test)]
use qwenwork::QwenWork;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Weak,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    io::AsyncWriteExt,
    sync::{Mutex, watch},
};
use tokio_util::sync::CancellationToken;

pub type Result<T> = std::result::Result<T, ConnectionError>;
#[derive(Clone, Debug)]
pub struct ConnectionError {
    pub code: String,
    pub message: String,
}
impl ConnectionError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn unavailable() -> Self {
        Self::new("connection_unavailable", "模型连接暂时不可用，请重试")
    }
    pub fn unsupported() -> Self {
        Self::new("unsupported", "来源应用或服务响应格式尚未通过兼容性验证")
    }
    pub fn login() -> Self {
        Self::new(
            "connection_login_required",
            "请打开来源应用恢复登录，然后重新连接",
        )
    }
    fn llm(&self) -> LlmError {
        let kind = match self.code.as_str() {
            "connection_login_required" | "identity_changed" | "connection_permission_required" => {
                ErrorKind::Auth
            }
            "connection_unavailable" => ErrorKind::Network,
            _ => ErrorKind::InvalidRequest,
        };
        let mut e = LlmError::new(kind, &self.message);
        e.provider_code = Some(self.code.clone());
        e
    }
}
impl std::fmt::Display for ConnectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for ConnectionError {}
pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

#[derive(Clone, Serialize, Deserialize)]
struct Record {
    connection_id: String,
    /// Empty in records written before it existed; they keep `local-<connection_id>`.
    #[serde(default)]
    provider_id: String,
    adapter_id: String,
    identity_key: String,
    enabled: bool,
    idempotency_key: String,
    #[serde(default)]
    models: Vec<ConnectionModel>,
    /// When `models` was last taken from the source (RFC 3339).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    models_fetched_at: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Config {
    schema: u32,
    connections: Vec<Record>,
}
struct Entry {
    record: RwLock<Record>,
    view: RwLock<ConnectionView>,
    adapter: Mutex<Box<dyn ProductAdapter>>,
    /// Requests running on it; disconnecting waits for none.
    requests: watch::Sender<usize>,
    cancel: RwLock<CancellationToken>,
}
type Changed = Arc<dyn Fn() + Send + Sync>;
pub struct Manager {
    home: PathBuf,
    registry: Weak<ModelRegistry>,
    environments: BTreeMap<String, Arc<dyn Environment>>,
    entries: RwLock<BTreeMap<String, Arc<Entry>>>,
    revision: AtomicU64,
    mutations: Mutex<()>,
    changed: RwLock<Option<Changed>>,
    myself: Weak<Manager>,
    load_error: Option<ConnectionError>,
}
impl Manager {
    /// Loads only non-secret configuration. No network, Keychain, timers, or spawned processes.
    pub fn new(home: PathBuf, registry: &Arc<ModelRegistry>) -> Arc<Self> {
        let environments = BTreeMap::from([
            ("qwenwork".into(), platform::system(&home)),
            ("qoder".into(), platform::system_for(&home, "qoder")),
        ]);
        Self::with_environments(home, registry, environments)
    }
    pub fn with_environment(
        home: PathBuf,
        registry: &Arc<ModelRegistry>,
        environment: Arc<dyn Environment>,
    ) -> Arc<Self> {
        Self::with_environments(
            home,
            registry,
            BTreeMap::from([("qwenwork".into(), environment)]),
        )
    }
    pub fn with_environments(
        home: PathBuf,
        registry: &Arc<ModelRegistry>,
        environments: BTreeMap<String, Arc<dyn Environment>>,
    ) -> Arc<Self> {
        let loaded = read_config(&home);
        let (records, load_error) = match loaded {
            Ok(v) => (v, None),
            Err(e) => (vec![], Some(e)),
        };
        let result = Arc::new_cyclic(|myself| Self {
            home,
            registry: Arc::downgrade(registry),
            environments,
            entries: RwLock::new(BTreeMap::new()),
            revision: AtomicU64::new(1),
            mutations: Mutex::new(()),
            changed: RwLock::new(None),
            myself: myself.clone(),
            load_error,
        });
        for r in records {
            if result.environments.contains_key(&r.adapter_id) {
                result.add(r);
            }
        }
        registry.install_authorizer(result.clone());
        result.publish();
        result
    }
    pub fn on_change(&self, callback: Changed) {
        *self.changed.write() = Some(callback);
    }
    fn check(&self) -> Result<()> {
        self.load_error.clone().map_or(Ok(()), Err)
    }
    pub fn snapshot(&self) -> Result<ConnectionsSnapshot> {
        self.check()?;
        Ok(ConnectionsSnapshot {
            revision: self.revision.load(Ordering::Acquire),
            connections: self
                .entries
                .read()
                .values()
                .map(|e| e.view.read().clone())
                .collect(),
        })
    }
    pub async fn discover(&self) -> Result<Vec<ConnectionDiscovery>> {
        let mut discoveries = Vec::new();
        for (id, env) in &self.environments {
            discoveries.push(env.discover().await.unwrap_or(ConnectionDiscovery {
                adapter_id: id.clone(),
                installed: false,
                version: None,
                login: "unavailable".into(),
                discovery_id: format!("{id}-standard"),
            }));
        }
        Ok(discoveries)
    }
    fn add(&self, r: Record) -> Arc<Entry> {
        let view = ConnectionView {
            connection_id: r.connection_id.clone(),
            provider_id: r.provider_id.clone(),
            adapter_id: r.adapter_id.clone(),
            display_name: adapter::name(&r.adapter_id).into(),
            state: if !r.enabled {
                ConnectionState::Disabled
            } else if r.models.is_empty() {
                ConnectionState::Unavailable
            } else {
                ConnectionState::Ready
            },
            reason_code: None,
            models: r.models.clone(),
            models_fetched_at: r.models_fetched_at.clone(),
        };
        let e = Arc::new(Entry {
            adapter: Mutex::new(adapter::create(
                &r.adapter_id,
                r.connection_id.clone(),
                r.identity_key.clone(),
                self.environments[&r.adapter_id].clone(),
            )),
            record: RwLock::new(r),
            view: RwLock::new(view),
            requests: watch::Sender::new(0),
            cancel: RwLock::new(CancellationToken::new()),
        });
        self.entries
            .write()
            .insert(e.record.read().connection_id.clone(), e.clone());
        e
    }
    fn entry(&self, id: &str) -> Result<Arc<Entry>> {
        self.entries
            .read()
            .get(id)
            .cloned()
            .ok_or_else(|| ConnectionError::new("not_found", "连接不存在"))
    }
    fn http(&self) -> Result<reqwest::Client> {
        self.registry
            .upgrade()
            .ok_or_else(ConnectionError::unavailable)?
            .http_client()
            .map_err(|_| ConnectionError::unavailable())
    }
    fn publish(&self) {
        let providers = self
            .entries
            .read()
            .values()
            .filter_map(|e| {
                let record = e.record.read();
                let view = e.view.read();
                if !record.enabled || !matches!(view.state, ConnectionState::Ready) {
                    return None;
                }
                let mut p = ProviderConfig {
                    id: record.provider_id.clone(),
                    name: view.display_name.clone(),
                    api: "openai-chat".into(),
                    base_url: adapter::base(&record.adapter_id).into(),
                    auth: AuthConfig::Managed,
                    headers: BTreeMap::new(),
                    currency: Default::default(),
                    compat: Compat { thinking_format: adapter::thinking_format(&record.adapter_id), ..Compat::default() },
                    models: vec![],
                    listing: Default::default(),
                };
                p.models = view
                    .models
                    .iter()
                    .filter(|m| adapter::supported(&record.adapter_id, &m.id))
                    .map(|m| {
                        let mut model = p.ad_hoc_model(&m.id);
                        model.name = m.name.clone();
                        model.context_window =
                            m.context_window.unwrap_or(32768).clamp(1024, 2_000_000);
                        model.max_output_tokens =
                            m.max_output_tokens.unwrap_or(8192).clamp(1, 128_000);
                        model.reasoning = m.reasoning;
                        if m.images {
                            model.input = vec![Modality::Text, Modality::Image];
                        }
                        // The application's own levels; without a format they could not be sent.
                        if p.compat.thinking_format.is_some() {
                            model.thinking = m.thinking.clone();
                            model.default_thinking = m.default_thinking;
                        }
                        Arc::new(model)
                    })
                    .collect();
                Some(p)
            })
            .collect();
        if let Some(registry) = self.registry.upgrade() {
            let _ = registry.replace_source("model-connections", providers);
        }
        self.revision.fetch_add(1, Ordering::AcqRel);
        if let Some(callback) = self.changed.read().clone() {
            callback();
        }
    }
    fn failed(&self, e: &Entry, error: &ConnectionError) {
        // A draining request must not overwrite the user's explicit disconnect.
        let record = e.record.read();
        if !record.enabled && matches!(e.view.read().state, ConnectionState::Disabled) {
            if error.code == "identity_changed" {
                e.cancel.read().cancel();
            }
            return;
        }
        {
            let mut view = e.view.write();
            view.state = match error.code.as_str() {
                "connection_login_required" | "identity_changed" => ConnectionState::NeedsLogin,
                "connection_permission_required" => ConnectionState::PermissionRequired,
                c if c.starts_with("unsupported") => ConnectionState::Unsupported,
                "connection_unavailable" if record.enabled && !view.models.is_empty() => {
                    ConnectionState::Ready
                }
                _ => ConnectionState::Unavailable,
            };
            view.reason_code = Some(error.code.clone());
        }
        drop(record);
        if error.code == "identity_changed" {
            e.cancel.read().cancel();
        }
        self.publish();
    }
    async fn persist(&self) -> Result<()> {
        let connections = self
            .entries
            .read()
            .values()
            .map(|e| e.record.read().clone())
            .collect();
        let data = serde_json::to_vec(&Config {
            schema: 1,
            connections,
        })
        .map_err(|_| ConnectionError::unavailable())?;
        let dir = self.home.join("connections");
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|_| ConnectionError::unavailable())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
                .await
                .map_err(|_| ConnectionError::unavailable())?;
        }
        let temporary = dir.join("config.rust.tmp");
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&temporary)
            .await
            .map_err(|_| ConnectionError::unavailable())?;
        file.write_all(&data)
            .await
            .map_err(|_| ConnectionError::unavailable())?;
        file.sync_all()
            .await
            .map_err(|_| ConnectionError::unavailable())?;
        tokio::fs::rename(&temporary, dir.join("config.json"))
            .await
            .map_err(|_| ConnectionError::unavailable())
    }
    /// Asks ready connections whose model catalog is older than `max_age` for it again
    /// (model-catalog-design §14). Quiet: a failure keeps the old catalog and the connection's
    /// state. Returns whether any connection's models changed.
    pub async fn refresh_stale_catalogs(&self, max_age: std::time::Duration) -> bool {
        let due: Vec<Arc<Entry>> = self
            .entries
            .read()
            .values()
            .filter(|e| {
                let record = e.record.read();
                record.enabled
                    && matches!(e.view.read().state, ConnectionState::Ready)
                    && record
                        .models_fetched_at
                        .as_deref()
                        .and_then(finx_llm::discovery::age_secs)
                        .is_none_or(|age| age >= max_age.as_secs() as i64)
            })
            .cloned()
            .collect();
        let mut changed = false;
        for e in due {
            let Ok(http) = self.http() else { return changed };
            let fetched = e.adapter.lock().await.catalog(&http).await;
            let Ok(models) = fetched else { continue };
            let same = serde_json::to_value(&e.record.read().models).ok() == serde_json::to_value(&models).ok();
            {
                let mut record = e.record.write();
                record.models_fetched_at = Some(finx_llm::discovery::now());
                if !same {
                    record.models = models.clone();
                }
            }
            let mut view = e.view.write();
            view.models_fetched_at = e.record.read().models_fetched_at.clone();
            if !same {
                view.models = models;
                changed = true;
            }
        }
        if changed {
            let _ = self.persist().await;
            self.publish();
        }
        changed
    }

    async fn prepare(&self, e: &Arc<Entry>) -> Result<()> {
        {
            let mut view = e.view.write();
            view.state = ConnectionState::Connecting;
            view.reason_code = None;
        }
        self.publish();
        let result = async {
            let http = self.http()?;
            let mut adapter = e.adapter.lock().await;
            let models = adapter.catalog(&http).await?;
            let _ = adapter.authorize(&http, false).await?;
            {
                let mut record = e.record.write();
                record.enabled = true;
                record.models = models.clone();
                record.models_fetched_at = Some(finx_llm::discovery::now());
            }
            {
                let mut view = e.view.write();
                view.models = models;
                view.models_fetched_at = e.record.read().models_fetched_at.clone();
            }
            *e.cancel.write() = CancellationToken::new();
            self.persist().await?;
            e.view.write().state = ConnectionState::Ready;
            self.publish();
            Ok(())
        }
        .await;
        if let Err(ref error) = result {
            self.failed(e, error);
        }
        result
    }
    pub async fn connect(&self, p: ConnectionConnectParams) -> Result<ConnectionsSnapshot> {
        let _guard = self.mutations.lock().await;
        self.check()?;
        if !self.environments.contains_key(&p.adapter_id)
            || p.discovery_id != format!("{}-standard", p.adapter_id)
            || !valid_id(&p.idempotency_key)
        {
            return Err(ConnectionError::new("invalid_params", "连接参数无效"));
        }
        let existing = self
            .entries
            .read()
            .values()
            .find(|e| {
                let r = e.record.read();
                r.idempotency_key == p.idempotency_key && r.adapter_id == p.adapter_id
            })
            .cloned();
        if let Some(e) = existing {
            self.prepare(&e).await?;
            return self.snapshot();
        }
        let environment = &self.environments[&p.adapter_id];
        let discovery = environment.discover().await?;
        if !discovery.installed {
            return Err(ConnectionError::new("unsupported", "未检测到来源应用"));
        }
        let _ = environment.headers().await?;
        let login = environment.interactive_login().await?;
        if self.entries.read().values().any(|e| {
            let r = e.record.read();
            r.adapter_id == p.adapter_id && r.identity_key == login.identity
        }) {
            return Err(ConnectionError::new("conflict", "这个账户已经连接"));
        }
        let e = self.add(Record {
            connection_id: uuid::Uuid::new_v4().to_string(),
            provider_id: provider_id(&p.adapter_id, &login.identity),
            adapter_id: p.adapter_id,
            identity_key: login.identity,
            enabled: true,
            idempotency_key: p.idempotency_key,
            models: vec![],
            models_fetched_at: None,
        });
        self.persist().await?;
        self.prepare(&e).await?;
        self.snapshot()
    }
    pub async fn retry(&self, id: &str) -> Result<ConnectionsSnapshot> {
        let _guard = self.mutations.lock().await;
        self.check()?;
        let e = self.entry(id)?;
        let adapter_id = e.record.read().adapter_id.clone();
        self.environments[&adapter_id].interactive_login().await?;
        self.prepare(&e).await?;
        self.snapshot()
    }
    pub async fn disconnect(&self, id: &str) -> Result<ConnectionsSnapshot> {
        let _guard = self.mutations.lock().await;
        self.check()?;
        let e = self.entry(id)?;
        e.record.write().enabled = false;
        e.view.write().state = ConnectionState::Disabled;
        self.publish();
        self.persist().await?;
        let _ = e.requests.subscribe().wait_for(|running| *running == 0).await;
        self.snapshot()
    }
    pub async fn remove(&self, id: &str) -> Result<ConnectionsSnapshot> {
        let _guard = self.mutations.lock().await;
        self.check()?;
        let e = self.entry(id)?;
        if e.record.read().enabled || *e.requests.borrow() > 0 {
            return Err(ConnectionError::new(
                "conflict",
                "请先断开连接并等待任务结束",
            ));
        }
        let adapter_id = e.record.read().adapter_id.clone();
        self.environments[&adapter_id].delete(id).await?;
        self.entries.write().remove(id);
        self.persist().await?;
        self.publish();
        self.snapshot()
    }
}
fn read_config(home: &Path) -> Result<Vec<Record>> {
    let file = home.join("connections/config.json");
    let data = match std::fs::read(file) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => {
            return Err(ConnectionError::new(
                "invalid_config",
                "无法读取模型连接配置",
            ));
        }
    };
    if data.len() > 1024 * 1024 {
        return Err(ConnectionError::new("invalid_config", "模型连接配置过大"));
    }
    let config: Config = serde_json::from_slice(&data)
        .map_err(|_| ConnectionError::new("invalid_config", "模型连接配置格式无效"))?;
    let mut ids = std::collections::HashSet::new();
    if config.schema != 1
        || config.connections.iter().any(|r| {
            uuid::Uuid::parse_str(&r.connection_id).is_err()
                || !ids.insert(r.connection_id.clone())
                || !["qwenwork", "qoder"].contains(&r.adapter_id.as_str())
                || r.models.iter().any(|m| !valid_id(&m.id))
        })
    {
        return Err(ConnectionError::new("invalid_config", "模型连接配置不兼容"));
    }
    let mut connections = config.connections;
    for r in &mut connections {
        if r.provider_id.is_empty() {
            r.provider_id = format!("local-{}", r.connection_id);
        }
    }
    let mut providers = std::collections::HashSet::new();
    if connections
        .iter()
        .any(|r| !valid_id(&r.provider_id) || !providers.insert(r.provider_id.clone()))
    {
        return Err(ConnectionError::new("invalid_config", "模型连接配置不兼容"));
    }
    Ok(connections)
}
/// Derived from the application and the account, which a connection never changes: removing a
/// connection and making it again publishes the same provider, so sessions that used its models
/// still find them.
fn provider_id(adapter_id: &str, identity: &str) -> String {
    let hash = platform::digest(format!("{adapter_id}\0{identity}").as_bytes());
    format!("local-{adapter_id}-{}", &hash[..12])
}
struct RequestLease {
    entry: Arc<Entry>,
    manager: Weak<Manager>,
    http: reqwest::Client,
    _running: Running,
    cancellation: CancellationToken,
}
/// Counts a request on its connection while it lives.
struct Running(Arc<Entry>);
impl Running {
    fn start(e: &Arc<Entry>) -> Self {
        e.requests.send_modify(|running| *running += 1);
        Self(e.clone())
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        self.0.requests.send_modify(|running| *running -= 1);
    }
}
#[async_trait]
impl ConnectionAuthorizer for Manager {
    async fn begin(
        &self,
        provider: &str,
        model: &str,
        http: reqwest::Client,
    ) -> std::result::Result<Box<dyn ConnectionRequest>, LlmError> {
        self.check().map_err(|e| e.llm())?;
        let e = self
            .entries
            .read()
            .values()
            .find(|e| e.record.read().provider_id == provider)
            .cloned()
            .ok_or_else(|| ConnectionError::new("not_found", "连接不存在").llm())?;
        // Counted before the checks, so that a disconnect either refuses it or waits for it.
        let running = Running::start(&e);
        if !e.record.read().enabled || !matches!(e.view.read().state, ConnectionState::Ready) {
            return Err(ConnectionError::new("connection_disabled", "连接当前不可用").llm());
        }
        if !adapter::supported(&e.record.read().adapter_id, model)
            || !e.view.read().models.iter().any(|m| m.id == model)
        {
            return Err(ConnectionError::new("unsupported_capability", "模型不在当前目录中").llm());
        }
        let cancellation = e.cancel.read().clone();
        Ok(Box::new(RequestLease {
            entry: e,
            manager: self.myself.clone(),
            http,
            _running: running,
            cancellation,
        }))
    }
}
#[async_trait]
impl ConnectionRequest for RequestLease {
    async fn authorize(&self, rejected: bool) -> std::result::Result<Authorization, LlmError> {
        let result = self
            .entry
            .adapter
            .lock()
            .await
            .authorize(&self.http, rejected)
            .await;
        if let Err(ref error) = result {
            if let Some(manager) = self.manager.upgrade() {
                manager.failed(&self.entry, error);
            }
        }
        if result.is_ok() {
            let recovered = {
                let mut view = self.entry.view.write();
                if matches!(view.state, ConnectionState::Ready)
                    && view.reason_code.as_deref() == Some("connection_unavailable")
                {
                    view.reason_code = None;
                    true
                } else {
                    false
                }
            };
            if recovered && let Some(manager) = self.manager.upgrade() {
                manager.publish();
            }
        }
        result.map_err(|e| e.llm())
    }
    fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }
    fn failed(&self, error: &mut LlmError) {
        if adapter::authentication_failure(&self.entry.record.read().adapter_id, error) {
            if let Some(manager) = self.manager.upgrade() {
                manager.failed(&self.entry, &ConnectionError::login());
            }
            error.message = ConnectionError::login().message;
        } else {
            error.message = format!("模型请求未完成（{}），请重试", error.kind);
        }
    }
}

#[cfg(test)]
mod tests;
