//! QwenWork product protocol. Only this module knows its remote endpoints.
use crate::{
    ConnectionError, Result,
    platform::{Environment, Login},
};
use finx_llm::{Credentials, connection::Authorization};
use finx_protocol::api::ConnectionModel;
use finx_llm::ThinkingLevel;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
const GATEWAY: &str = "https://gateway.qwenwork.cn";

// No Debug: these structures hold bearer credentials.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Session {
    pub token: String,
    pub session_id: String,
    pub base: String,
    pub expires: i64,
    pub ttl: i64,
}
#[derive(Serialize, Deserialize)]
struct Saved {
    identity: String,
    session: Session,
}
pub struct QwenWork {
    id: String,
    identity: String,
    environment: Arc<dyn Environment>,
    pub(crate) session: Option<Session>,
    loaded: bool,
    retry_at: i64,
    #[cfg(test)]
    pub(crate) gateway: String,
}
/// The thinking levels QwenWork offers for a catalog entry, and the one it uses itself
/// (model-catalog-design §18). Its gateway takes OpenAI's `reasoning_effort`, `low` to `max`.
/// `none` switches thinking off only for models without a `thinking_config`: a model the
/// catalog gives one keeps thinking (measured 2026-10-30: "pro" still reasons at `none`), so it
/// is not offered "off". The qwen3.7 models only switch thinking on and off; QwenWork itself
/// asks qwen3.8-max for `xhigh` and the others for `high` unless the catalog names a level.
pub(crate) fn thinking_of(id: &str, entry: &serde_json::Value) -> (Vec<ThinkingLevel>, ThinkingLevel) {
    use ThinkingLevel::*;
    let config = &entry["thinking_config"];
    let reasoning = entry["is_reasoning"].as_bool().unwrap_or(false) || config["enabled"].as_bool() == Some(true);
    if !reasoning {
        return (Vec::new(), Default);
    }
    let id = id.to_ascii_lowercase();
    if id.starts_with("qwen3.7") {
        return (vec![Off, On], On);
    }
    let named = config["effort"].as_str().and_then(|e| e.parse::<ThinkingLevel>().ok()).filter(|l| l.is_effort() && *l != Minimal);
    let own = if id.starts_with("qwen3.8-max") { Xhigh } else { High };
    let mut levels = vec![Off, Low, Medium, High, Xhigh, Max];
    if config.is_object() {
        levels.retain(|l| *l != Off);
    }
    (levels, named.unwrap_or(own))
}

impl QwenWork {
    pub fn new(id: String, identity: String, environment: Arc<dyn Environment>) -> Self {
        Self {
            id,
            identity,
            environment,
            session: None,
            loaded: false,
            retry_at: 0,
            #[cfg(test)]
            gateway: GATEWAY.into(),
        }
    }
    fn gateway(&self) -> &str {
        #[cfg(test)]
        {
            &self.gateway
        }
        #[cfg(not(test))]
        {
            GATEWAY
        }
    }
    async fn login(&mut self) -> Result<Login> {
        let login = self.environment.login().await?;
        if login.identity != self.identity {
            self.session = None;
            self.environment.delete(&self.id).await?;
            return Err(ConnectionError::new(
                "identity_changed",
                "千问账户已切换，请断开并移除旧连接后重新连接",
            ));
        }
        Ok(login)
    }
    pub async fn catalog(&mut self, http: &reqwest::Client) -> Result<Vec<ConnectionModel>> {
        let headers = self.environment.headers().await?;
        let login = self.login().await?;
        if login.expires <= self.environment.now() {
            return Err(ConnectionError::login());
        }
        let r = json_request(
            http,
            &format!("{}/api/desktop/chat-modes", self.gateway()),
            &login.token,
            &headers,
            None,
            "catalog",
        )
        .await
        .map_err(ConnectionError::source_rejected)?;
        let entries = r["catalog"]
            .as_array()
            .ok_or_else(|| ConnectionError::format("catalog", "catalog"))?;
        for (index, entry) in entries.iter().enumerate() {
            if entry["enable"] == true && entry["format"] == "openai/chat-completions"
                && !entry["key"].as_str().is_some_and(crate::valid_id)
            {
                return Err(ConnectionError::format("catalog", &format!("catalog[{index}].key")));
            }
        }
        let models: Vec<_> = entries
            .iter()
            .filter(|m| m["enable"] == true && m["format"] == "openai/chat-completions")
            .filter_map(|m| {
                let id = m["key"].as_str()?;
                if !crate::valid_id(id) {
                    return None;
                }
                tracing::debug!(model = id, is_reasoning = %m["is_reasoning"], thinking = %m["thinking_config"], "QwenWork catalog entry");
                let (thinking, default_thinking) = thinking_of(id, m);
                Some(ConnectionModel {
                    id: id.into(),
                    name: id.into(),
                    context_window: m["max_input_tokens"]
                        .as_u64()
                        .and_then(|n| u32::try_from(n).ok()),
                    max_output_tokens: None,
                    reasoning: !thinking.is_empty(),
                    // The catalog does not say; QwenWork takes images (checked with flash).
                    images: true,
                    thinking,
                    default_thinking,
                })
            })
            .collect();
        if models.is_empty() {
            return Err(if entries.iter().all(|m| m["enable"] != true) {
                ConnectionError::new("catalog_empty", "账户当前没有启用的模型").at("catalog")
            } else {
                ConnectionError::new("unsupported_model_protocol", "模型目录中没有可解析且支持的模型协议").at("catalog")
            });
        }
        Ok(models)
    }
    pub async fn authorize(
        &mut self,
        http: &reqwest::Client,
        rejected: bool,
    ) -> Result<Authorization> {
        let headers = self.environment.headers().await?;
        let login = self.login().await?;
        let now = self.environment.now();
        if !self.loaded {
            if let Some(value) = self.environment.get(&self.id).await? {
                if let Ok(saved) = serde_json::from_str::<Saved>(&value) {
                    if saved.identity == self.identity
                        && saved.session.expires > now
                        && saved.session.ttl > 0
                        && checked_base(&saved.session.base).is_ok()
                    {
                        self.session = Some(saved.session);
                    }
                }
            }
            self.loaded = true;
        }
        if rejected {
            self.session = None;
            self.retry_at = 0;
        }
        let s = self.resolve(http, &login, &headers, now).await?;
        let mut credentials = Credentials::with_key(s.token);
        credentials.headers = headers;
        credentials
            .headers
            .insert("X-Session-Id".into(), s.session_id);
        Ok(Authorization {
            base_url: s.base,
            credentials,
            transport: None,
        })
    }
    async fn save(&mut self, session: Session) -> Result<Session> {
        let value = serde_json::to_string(&Saved {
            identity: self.identity.clone(),
            session: session.clone(),
        })
        .map_err(|_| ConnectionError::new("saved_session_invalid", "无法编码连接授权数据").at("credential_store"))?;
        self.environment.set(&self.id, &value).await?;
        self.session = Some(session.clone());
        Ok(session)
    }
    async fn resolve(
        &mut self,
        http: &reqwest::Client,
        login: &Login,
        headers: &BTreeMap<String, String>,
        now: i64,
    ) -> Result<Session> {
        if let Some(s) = self.session.clone() {
            if s.expires - now > 30_000.max(s.ttl / 2) {
                return Ok(s);
            }
            if s.expires > now + 30_000 {
                if self.retry_at > now {
                    return Ok(s);
                }
                match json_request(
                    http,
                    &format!("{}/access-tokens/exchange", s.base),
                    &s.token,
                    headers,
                    Some(json!({"ttl_ms":s.ttl})),
                    "refresh",
                )
                .await
                {
                    Ok(r) => {
                        if let (Some(token), Some(expires)) = (
                            r["access_token"].as_str().filter(|s| !s.is_empty()),
                            r["expires_at"].as_i64().filter(|e| *e > now + 30_000),
                        ) {
                            return self
                                .save(Session {
                                    token: token.into(),
                                    expires,
                                    ttl: expires - now,
                                    ..s
                                })
                                .await;
                        }
                        let field = if r["access_token"].as_str().is_none_or(|s| s.is_empty()) { "access_token" } else { "expires_at" };
                        return Err(ConnectionError::format("refresh", field));
                    }
                    Err(e) if e.retryable => {
                        tracing::info!(stage = "refresh", backoff_ms = 30_000, "connection_using_valid_cached_authorization");
                        self.retry_at = now + 30_000;
                        return Ok(s);
                    }
                    Err(e) if e.code == "auth_rejected" => {
                        tracing::info!("connection_refresh_rejected_reissue_from_source");
                    }
                    Err(e) => return Err(e),
                }
            }
        }
        if login.expires <= now {
            return Err(ConnectionError::login());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let r = json_request(
            http,
            &format!("{}/api/desktop-sessions", self.gateway()),
            &login.token,
            headers,
            Some(json!({"session_id":id})),
            "authorization",
        )
        .await
        .map_err(ConnectionError::source_rejected)?;
        let token = r["access_token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ConnectionError::format("authorization", "access_token"))?;
        let expires = r["expires_at_ms"]
            .as_i64()
            .filter(|e| *e > now + 30_000)
            .ok_or_else(|| ConnectionError::format("authorization", "expires_at_ms"))?;
        let ttl = match r.get("ttl_ms") {
            None => expires - now,
            Some(v) => v.as_i64().ok_or_else(|| ConnectionError::format("authorization", "ttl_ms"))?,
        };
        if r["session_id"] != id {
            return Err(ConnectionError::format("authorization", "session_id"));
        }
        if ttl <= 0 {
            return Err(ConnectionError::format("authorization", "ttl_ms"));
        }
        let base = checked_base(
            r["base_url"]
                .as_str()
                .ok_or_else(|| ConnectionError::format("authorization", "base_url"))?,
        )?;
        self.save(Session {
            token: token.into(),
            session_id: id,
            base,
            expires,
            ttl,
        })
        .await
    }
}
pub(crate) fn checked_base(input: &str) -> Result<String> {
    let u = reqwest::Url::parse(input).map_err(|_| ConnectionError::format("authorization", "base_url"))?;
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.port().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || ![
            "gateway.qwenwork.cn",
            "api9.qwenwork.cn",
            "maas.xiaoluozi.cn",
        ]
        .contains(&u.host_str().unwrap_or(""))
        || !["/", "/v1", "/v1/"].contains(&u.path())
    {
        return Err(ConnectionError::new(
            "unsupported_origin",
            "模型服务地址不在允许范围内",
        ).at("authorization").field("base_url"));
    }
    Ok(format!("{}/v1", u.origin().ascii_serialization()))
}
async fn json_request(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    headers: &BTreeMap<String, String>,
    body: Option<Value>,
    stage: &'static str,
) -> Result<Value> {
    let mut request = if let Some(body) = body {
        http.post(url).json(&body)
    } else {
        http.get(url)
    };
    request = request.bearer_auth(token).timeout(Duration::from_secs(30));
    for (name, value) in headers {
        request = request.header(name, value);
    }
    crate::diagnostic::request_json(request, stage).await
}
