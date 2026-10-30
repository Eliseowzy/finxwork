use super::*;
use finx_llm::{Catalog, RegistryOptions};
use finx_protocol::api::ConnectionDiscovery;
use platform::{Environment, Login};
use serde_json::json;
use std::sync::atomic::{AtomicI64, AtomicUsize};
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{method, path},
};

struct Fake {
    calls: AtomicUsize,
    now: AtomicI64,
    identity: RwLock<String>,
    expires: AtomicI64,
    store: Mutex<BTreeMap<String, String>>,
}
impl Fake {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicUsize::new(0),
            now: AtomicI64::new(1_000_000),
            identity: RwLock::new("account-a".into()),
            expires: AtomicI64::new(9_000_000),
            store: Mutex::new(BTreeMap::new()),
        })
    }
}
#[async_trait]
impl Environment for Fake {
    fn now(&self) -> i64 {
        self.now.load(Ordering::Relaxed)
    }
    async fn discover(&self) -> Result<ConnectionDiscovery> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        Ok(ConnectionDiscovery {
            adapter_id: "qwenwork".into(),
            installed: true,
            version: Some("1.4.0".into()),
            login: "unknown".into(),
            discovery_id: "qwenwork-standard".into(),
        })
    }
    async fn login(&self) -> Result<Login> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        Ok(Login {
            subject: None,
            token: "account-secret".into(),
            identity: self.identity.read().clone(),
            expires: self.expires.load(Ordering::Relaxed),
        })
    }
    async fn headers(&self) -> Result<BTreeMap<String, String>> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        Ok(BTreeMap::new())
    }
    async fn get(&self, id: &str) -> Result<Option<String>> {
        Ok(self.store.lock().await.get(id).cloned())
    }
    async fn set(&self, id: &str, value: &str) -> Result<()> {
        self.store.lock().await.insert(id.into(), value.into());
        Ok(())
    }
    async fn delete(&self, id: &str) -> Result<()> {
        self.store.lock().await.remove(id);
        Ok(())
    }
}
fn registry() -> Arc<ModelRegistry> {
    Arc::new(ModelRegistry::new(
        Catalog::builtin().unwrap(),
        RegistryOptions::default(),
    ))
}
fn client() -> reqwest::Client {
    registry().http_client().unwrap()
}
fn record(enabled: bool) -> Record {
    Record {
        connection_id: uuid::Uuid::new_v4().to_string(),
        // Written before provider IDs were kept: published as `local-<connection_id>`.
        provider_id: String::new(),
        adapter_id: "qwenwork".into(),
        identity_key: "account-a".into(),
        enabled,
        idempotency_key: "test".into(),
        models: vec![ConnectionModel {
            id: "flash".into(),
            name: "Flash".into(),
            context_window: Some(1000000),
            max_output_tokens: None,
            reasoning: true,
            images: false,
        }],
        models_fetched_at: None,
    }
}
fn save_config(dir: &Path, r: &Record) {
    std::fs::create_dir_all(dir.join("connections")).unwrap();
    std::fs::write(
        dir.join("connections/config.json"),
        serde_json::to_vec(&Config {
            schema: 1,
            connections: vec![r.clone()],
        })
        .unwrap(),
    )
    .unwrap();
}
async fn save_session(env: &Fake, id: &str) {
    env.set(id,&json!({"identity":"account-a","session":{"token":"private-model-token","session_id":"private-session","base":"https://api9.qwenwork.cn/v1","expires":8_000_000,"ttl":7_200_000}}).to_string()).await.unwrap();
}

#[tokio::test]
async fn unused_and_disabled_connections_do_no_platform_or_network_work() {
    let dir = tempfile::tempdir().unwrap();
    let env = Fake::new();
    let llm = registry();
    let m = Manager::with_environment(dir.path().into(), &llm, env.clone());
    assert!(m.snapshot().unwrap().connections.is_empty());
    assert_eq!(env.calls.load(Ordering::Relaxed), 0);
    let r = record(false);
    save_config(dir.path(), &r);
    let llm = registry();
    let m = Manager::with_environment(dir.path().into(), &llm, env.clone());
    assert!(matches!(
        m.snapshot().unwrap().connections[0].state,
        ConnectionState::Disabled
    ));
    assert!(
        llm.resolve(&format!("local-{}/flash", r.connection_id))
            .is_err()
    );
    assert_eq!(env.calls.load(Ordering::Relaxed), 0);
}
#[tokio::test]
async fn existing_connection_restores_without_secrets_in_catalog_and_disconnect_drains() {
    let dir = tempfile::tempdir().unwrap();
    let r = record(true);
    save_config(dir.path(), &r);
    let env = Fake::new();
    save_session(&env, &r.connection_id).await;
    let llm = registry();
    let m = Manager::with_environment(dir.path().into(), &llm, env.clone());
    let provider = format!("local-{}", r.connection_id);
    assert!(llm.resolve(&format!("{provider}/flash")).is_ok());
    assert!(llm.resolve(&format!("{provider}/invented")).is_err());
    assert_eq!(env.calls.load(Ordering::Relaxed), 0);
    let lease = m.begin(&provider, "flash", client()).await.unwrap();
    let auth = lease.authorize(false).await.unwrap();
    assert_eq!(
        auth.credentials.api_key.as_deref(),
        Some("private-model-token")
    );
    assert_eq!(auth.credentials.headers["X-Session-Id"], "private-session");
    assert!(
        !serde_json::to_string(&m.snapshot().unwrap())
            .unwrap()
            .contains("private")
    );
    assert!(!format!("{:?}", auth.credentials).contains("private-session"));
    assert!(m.begin(&provider, "flash", client()).await.is_err());
    let manager = m.clone();
    let id = r.connection_id.clone();
    let disconnect = tokio::spawn(async move { manager.disconnect(&id).await });
    for _ in 0..50 {
        if matches!(
            m.snapshot().unwrap().connections[0].state,
            ConnectionState::Disabled
        ) {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(!disconnect.is_finished());
    assert!(llm.resolve(&format!("{provider}/flash")).is_err());
    m.failed(
        &m.entry(&r.connection_id).unwrap(),
        &ConnectionError::login(),
    );
    assert!(matches!(
        m.snapshot().unwrap().connections[0].state,
        ConnectionState::Disabled
    ));
    drop(lease);
    disconnect.await.unwrap().unwrap();
    env.expires.store(0, Ordering::Relaxed);
    assert!(m.retry(&r.connection_id).await.is_err());
    assert!(matches!(
        m.snapshot().unwrap().connections[0].state,
        ConnectionState::NeedsLogin
    ));
    m.disconnect(&r.connection_id).await.unwrap();
    m.remove(&r.connection_id).await.unwrap();
    assert!(env.get(&r.connection_id).await.unwrap().is_none());
}
#[tokio::test]
async fn connecting_the_same_account_again_keeps_the_provider() {
    let dir = tempfile::tempdir().unwrap();
    let env = Fake::new();
    // Expired: the connection is saved, then its catalog fails before any request.
    env.expires.store(0, Ordering::Relaxed);
    let llm = registry();
    let m = Manager::with_environment(dir.path().into(), &llm, env.clone());
    let connect = |key: &str| {
        m.connect(ConnectionConnectParams {
            adapter_id: "qwenwork".into(),
            discovery_id: "qwenwork-standard".into(),
            idempotency_key: key.into(),
        })
    };
    assert!(connect("first").await.is_err());
    let first = m.snapshot().unwrap().connections.remove(0);
    assert_eq!(first.provider_id, provider_id("qwenwork", "account-a"));
    m.disconnect(&first.connection_id).await.unwrap();
    m.remove(&first.connection_id).await.unwrap();
    assert!(connect("second").await.is_err());
    let second = m.snapshot().unwrap().connections.remove(0);
    assert_ne!(second.connection_id, first.connection_id);
    assert_eq!(second.provider_id, first.provider_id);
    // Kept across a restart; another account or application gets its own.
    let m = Manager::with_environment(dir.path().into(), &registry(), env);
    assert_eq!(m.snapshot().unwrap().connections[0].provider_id, first.provider_id);
    assert_ne!(provider_id("qwenwork", "account-b"), first.provider_id);
    assert_ne!(provider_id("qoder", "account-a"), first.provider_id);
}
#[tokio::test]
async fn connection_publishes_and_authorizes_under_its_provider() {
    let dir = tempfile::tempdir().unwrap();
    let mut r = record(true);
    r.provider_id = provider_id("qwenwork", "account-a");
    save_config(dir.path(), &r);
    let env = Fake::new();
    save_session(&env, &r.connection_id).await;
    let llm = registry();
    let m = Manager::with_environment(dir.path().into(), &llm, env);
    assert!(llm.resolve(&format!("{}/flash", r.provider_id)).is_ok());
    assert!(llm.resolve(&format!("local-{}/flash", r.connection_id)).is_err());
    assert!(m.begin(&r.provider_id, "flash", client()).await.is_ok());
}
#[tokio::test]
async fn identity_switch_cancels_connection_and_removes_only_its_session() {
    let dir = tempfile::tempdir().unwrap();
    let r = record(true);
    save_config(dir.path(), &r);
    let env = Fake::new();
    save_session(&env, &r.connection_id).await;
    let llm = registry();
    let m = Manager::with_environment(dir.path().into(), &llm, env.clone());
    let lease = m
        .begin(&format!("local-{}", r.connection_id), "flash", client())
        .await
        .unwrap();
    *env.identity.write() = "account-b".into();
    assert!(lease.authorize(false).await.is_err());
    assert!(lease.cancellation().is_cancelled());
    assert!(matches!(
        m.snapshot().unwrap().connections[0].state,
        ConnectionState::NeedsLogin
    ));
    assert!(env.get(&r.connection_id).await.unwrap().is_none());
}
#[tokio::test]
async fn parallel_refreshes_exchange_once_and_keep_session_pairing() {
    let server = MockServer::start().await;
    let env = Fake::new();
    Mock::given(method("POST"))
        .and(path("/v1/access-tokens/exchange"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"access_token":"new-token","expires_at":1_120_000})),
        )
        .expect(1)
        .mount(&server)
        .await;
    let mut adapter = QwenWork::new("test".into(), "account-a".into(), env);
    adapter.session = Some(qwenwork::Session {
        token: "old-token".into(),
        session_id: "own-session".into(),
        base: format!("{}/v1", server.uri()),
        expires: 1_040_000,
        ttl: 120_000,
    });
    let shared = Arc::new(Mutex::new(adapter));
    let futures = (0..20).map(|_| {
        let a = shared.clone();
        async move { a.lock().await.authorize(&client(), false).await.unwrap() }
    });
    for a in futures::future::join_all(futures).await {
        assert_eq!(a.credentials.api_key.as_deref(), Some("new-token"));
        assert_eq!(a.credentials.headers["X-Session-Id"], "own-session");
    }
}
#[tokio::test]
async fn transient_refresh_backoff_and_expired_account_fail_without_refreshing_source() {
    let server = MockServer::start().await;
    let env = Fake::new();
    Mock::given(method("POST"))
        .and(path("/v1/access-tokens/exchange"))
        .respond_with(ResponseTemplate::new(503))
        .expect(1)
        .mount(&server)
        .await;
    let mut a = QwenWork::new("test".into(), "account-a".into(), env.clone());
    a.session = Some(qwenwork::Session {
        token: "old".into(),
        session_id: "own".into(),
        base: format!("{}/v1", server.uri()),
        expires: 1_040_000,
        ttl: 120_000,
    });
    assert_eq!(
        a.authorize(&client(), false)
            .await
            .unwrap()
            .credentials
            .api_key
            .as_deref(),
        Some("old")
    );
    a.authorize(&client(), false).await.unwrap();
    env.now.store(1_200_000, Ordering::Relaxed);
    env.expires.store(0, Ordering::Relaxed);
    assert_eq!(
        a.authorize(&client(), false).await.err().unwrap().code,
        "connection_login_required"
    );
}
#[tokio::test]
async fn expired_session_mints_an_independent_session_with_millisecond_expiry() {
    let server = MockServer::start().await;
    let env = Fake::new();
    Mock::given(method("POST")).and(path("/api/desktop-sessions")).respond_with(|req:&wiremock::Request|{
        let body:serde_json::Value=serde_json::from_slice(&req.body).unwrap();assert_ne!(body["session_id"],"old-session");
        ResponseTemplate::new(200).set_body_json(json!({"session_id":body["session_id"],"access_token":"minted","expires_at_ms":8_200_000,"ttl_ms":7_200_000,"base_url":"https://api9.qwenwork.cn"}))
    }).expect(1).mount(&server).await;
    let mut a = QwenWork::new("test".into(), "account-a".into(), env);
    a.gateway = server.uri();
    let auth = a.authorize(&client(), false).await.unwrap();
    assert_eq!(auth.credentials.api_key.as_deref(), Some("minted"));
    assert_eq!(auth.base_url, "https://api9.qwenwork.cn/v1");
}
#[test]
fn source_origin_allowlist_rejects_credentials_paths_and_non_https() {
    for url in [
        "http://api9.qwenwork.cn",
        "https://secret@api9.qwenwork.cn",
        "https://api9.qwenwork.cn/other",
        "https://attacker.test",
    ] {
        assert!(qwenwork::checked_base(url).is_err());
    }
    assert_eq!(
        qwenwork::checked_base("https://api9.qwenwork.cn").unwrap(),
        "https://api9.qwenwork.cn/v1"
    );
}
#[test]
fn chrome_v10_login_decrypts_and_preserves_existing_identity_hash() {
    use cbc::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
    use std::num::NonZeroU32;
    let plain = json!({"schemaVersion":2,"token":"secret-account","user":{"id":"user-1"},"expiresAt":"2030-01-01T00:00:00Z"});
    let mut key = [0u8; 16];
    ring::pbkdf2::derive(
        ring::pbkdf2::PBKDF2_HMAC_SHA1,
        NonZeroU32::new(1003).unwrap(),
        b"saltysalt",
        b"password",
        &mut key,
    );
    let mut sealed = b"v10".to_vec();
    sealed.extend(
        cbc::Encryptor::<aes::Aes128>::new_from_slices(&key, &[32; 16])
            .unwrap()
            .encrypt_padded_vec_mut::<Pkcs7>(plain.to_string().as_bytes()),
    );
    let login = platform::decrypt_login(&sealed, b"password").unwrap();
    assert_eq!(login.token, "secret-account");
    assert_eq!(
        login.identity,
        platform::digest(br#"["user-1","","standard"]"#)
    );
    assert!(platform::decrypt_login(&sealed, b"incorrect").is_err());
}

#[tokio::test]
async fn transient_failure_keeps_route_and_success_clears_diagnostic() {
    let dir = tempfile::tempdir().unwrap();
    let env = Fake::new();
    let llm = registry();
    let r = record(true);
    save_config(dir.path(), &r);
    save_session(&env, &r.connection_id).await;
    let manager = Manager::with_environment(dir.path().into(), &llm, env);
    let entry = manager.entry(&r.connection_id).unwrap();
    manager.failed(&entry, &ConnectionError::unavailable());
    assert!(
        llm.provider(&format!("local-{}", r.connection_id))
            .is_some()
    );
    assert_eq!(
        entry.view.read().reason_code.as_deref(),
        Some("connection_unavailable")
    );
    let lease = manager
        .begin(&format!("local-{}", r.connection_id), "flash", client())
        .await
        .unwrap();
    lease.authorize(false).await.unwrap();
    assert!(entry.view.read().reason_code.is_none());
}
#[tokio::test]
async fn catalogs_are_asked_again_only_when_old_and_failures_change_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let mut r = record(true);
    r.models_fetched_at = Some(finx_llm::discovery::now());
    save_config(dir.path(), &r);
    let env = Fake::new();
    save_session(&env, &r.connection_id).await;
    let llm = registry();
    let m = Manager::with_environment(dir.path().into(), &llm, env.clone());
    let day = std::time::Duration::from_secs(24 * 60 * 60);
    // Fresh: not asked.
    assert!(!m.refresh_stale_catalogs(day).await);
    assert_eq!(env.calls.load(Ordering::Relaxed), 0);
    // Old, and the source's login has expired: asked, and the failure leaves all as it was.
    env.expires.store(0, Ordering::Relaxed);
    assert!(!m.refresh_stale_catalogs(std::time::Duration::ZERO).await);
    assert!(env.calls.load(Ordering::Relaxed) > 0);
    let provider = format!("local-{}", r.connection_id);
    assert!(llm.resolve(&format!("{provider}/flash")).is_ok());
    assert!(matches!(m.snapshot().unwrap().connections[0].state, ConnectionState::Ready));
}
