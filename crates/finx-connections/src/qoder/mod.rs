//! Qoder global desktop 0.4.11. Independent JobTokens; source login is read-only.
mod cosy;
mod sse;
#[cfg(test)]
mod tests;
use crate::{
    ConnectionError, Result,
    adapter::ProductAdapter,
    platform::{Environment, Login, digest},
};
use async_trait::async_trait;
use finx_llm::{Credentials, connection::Authorization};
use finx_protocol::api::ConnectionModel;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
const CLIENT_ID: &str = "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa";
const OPENAPI: &str = "https://openapi.qoder.sh";
const CATALOG: &str = "https://api3.qoder.sh/algo/api/v2/model/list?Encode=1";
const MODEL_BASE: &str = "https://api2-v2.qoder.sh/model/v1";
#[derive(Clone, Serialize, Deserialize)]
struct Job {
    token: String,
    refresh_token: String,
    expires: i64,
    refresh_expires: i64,
    ttl: i64,
}
#[derive(Serialize, Deserialize)]
struct Saved {
    identity: String,
    machine_id: String,
    job: Option<Job>,
}
pub(crate) struct Qoder {
    id: String,
    identity: String,
    environment: Arc<dyn Environment>,
    saved: Saved,
    loaded: bool,
    dirty: bool,
    retry_at: i64,
    refresh_uncertain: bool,
    #[cfg(test)]
    openapi: String,
    #[cfg(test)]
    catalog_url: String,
}
pub(crate) fn source_login(v: &Value) -> Result<Login> {
    if v["schemaVersion"] != 1
        || v.get("openApiBase")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
    {
        return Err(ConnectionError::unsupported());
    }
    if let Some(context) = v["authenticationContext"].as_str() {
        let context: Value =
            serde_json::from_str(context).map_err(|_| ConnectionError::unsupported())?;
        if context[1] != OPENAPI || context[2] != CLIENT_ID {
            return Err(ConnectionError::unsupported());
        }
    }
    let uid = v["user"]["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| v["user"]["id"].as_u64().map(|n| n.to_string()))
        .ok_or_else(ConnectionError::unsupported)?;
    let token = v["token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(ConnectionError::login)?
        .to_owned();
    let expires = date(&v["expiresAt"]).ok_or_else(ConnectionError::login)?;
    Ok(Login {
        identity: digest(json!(["qoder-global", uid]).to_string().as_bytes()),
        token,
        expires,
        subject: Some(uid),
    })
}
fn date(v: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(v.as_str()?)
        .ok()
        .map(|v| v.timestamp_millis())
}
fn parse_job(v: &Value, now: i64) -> Result<Job> {
    let string = |key: &str| {
        v[key]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 32_768)
            .map(str::to_owned)
            .ok_or_else(ConnectionError::unsupported)
    };
    let expires = date(&v["expires_at"])
        .or_else(|| now.checked_add(v["expires_in"].as_i64()?))
        .filter(|e| *e > now + 30_000)
        .ok_or_else(ConnectionError::unsupported)?;
    let refresh_expires = date(&v["refresh_token_expires_at"])
        .or_else(|| now.checked_add(v["refresh_token_expires_in"].as_i64()?))
        .filter(|e| *e > now)
        .ok_or_else(ConnectionError::unsupported)?;
    Ok(Job {
        token: string("token")?,
        refresh_token: string("refresh_token")?,
        expires,
        refresh_expires,
        ttl: expires - now,
    })
}
impl Qoder {
    pub fn new(id: String, identity: String, environment: Arc<dyn Environment>) -> Self {
        Self {
            id,
            saved: Saved {
                identity: identity.clone(),
                machine_id: uuid::Uuid::new_v4().to_string(),
                job: None,
            },
            identity,
            environment,
            loaded: false,
            dirty: false,
            retry_at: 0,
            refresh_uncertain: false,
            #[cfg(test)]
            openapi: OPENAPI.into(),
            #[cfg(test)]
            catalog_url: CATALOG.into(),
        }
    }
    fn openapi(&self) -> &str {
        #[cfg(test)]
        {
            &self.openapi
        }
        #[cfg(not(test))]
        {
            OPENAPI
        }
    }
    fn catalog_url(&self) -> &str {
        #[cfg(test)]
        {
            &self.catalog_url
        }
        #[cfg(not(test))]
        {
            CATALOG
        }
    }
    async fn source(&mut self) -> Result<Login> {
        self.environment.headers().await?;
        let login = self.environment.login().await?;
        if login.identity != self.identity {
            self.saved.job = None;
            self.environment.delete(&self.id).await?;
            return Err(ConnectionError::new(
                "identity_changed",
                "Qoder 账户已切换，请移除旧连接后重新连接",
            ));
        }
        Ok(login)
    }
    async fn save(&mut self) -> Result<()> {
        let value = zeroize::Zeroizing::new(
            serde_json::to_string(&self.saved).map_err(|_| ConnectionError::unavailable())?,
        );
        self.environment.set(&self.id, &value).await?;
        self.dirty = false;
        Ok(())
    }
    async fn resolve(&mut self, http: &reqwest::Client, rejected: bool) -> Result<Job> {
        let login = self.source().await?;
        let now = self.environment.now();
        if !self.loaded {
            if let Some(value) = self.environment.get(&self.id).await? {
                let saved: Saved =
                    serde_json::from_str(&value).map_err(|_| ConnectionError::unsupported())?;
                if saved.identity != self.identity
                    || uuid::Uuid::parse_str(&saved.machine_id).is_err()
                {
                    return Err(ConnectionError::unsupported());
                }
                self.saved = saved;
            }
            self.loaded = true;
        }
        if self.dirty {
            self.save().await?;
            self.refresh_uncertain = false;
        }
        if let Some(job) = self.saved.job.clone() {
            let margin = 300_000.min(job.ttl / 2).max(30_000);
            if !rejected && job.expires > now + margin {
                return Ok(job);
            }
            if now < self.retry_at {
                if !rejected && job.expires > now + 60_000 {
                    return Ok(job);
                }
                return Err(ConnectionError::unavailable());
            }
            if !self.refresh_uncertain && job.refresh_expires > now + 30_000 {
                let result = json_request(
                    http,
                    &format!("{}/api/v1/jobToken/refresh", self.openapi()),
                    None,
                    &json!({"refresh_token":job.refresh_token}),
                )
                .await;
                match result {
                    Ok(v) => {
                        // If parsing or persistence fails, the previous refresh may be spent.
                        self.refresh_uncertain = true;
                        let next = parse_job(&v, now)?;
                        self.saved.job = Some(next.clone());
                        self.dirty = true;
                        self.save().await?;
                        self.refresh_uncertain = false;
                        self.retry_at = 0;
                        return Ok(next);
                    }
                    Err(e) if e.code == "auth_rejected" => {
                        self.refresh_uncertain = true;
                    }
                    Err(e) if e.code == "permission_denied" => return Err(e),
                    Err(_) => {
                        self.refresh_uncertain = true;
                    }
                }
            }
        }
        if login.expires <= now {
            if !rejected {
                if let Some(job) = self.saved.job.clone() {
                    if job.expires > now + 60_000 {
                        self.retry_at = now + 30_000;
                        return Ok(job);
                    }
                }
            }
            return Err(ConnectionError::login());
        }
        let issued = json_request(
            http,
            &format!("{}/api/v1/me/jobToken", self.openapi()),
            Some(&login.token),
            &json!({"clientId":CLIENT_ID}),
        )
        .await;
        let value = match issued {
            Ok(v) => v,
            Err(e) => {
                self.retry_at = now + 30_000;
                if e.code == "connection_unavailable" && !rejected {
                    if let Some(job) = self.saved.job.clone() {
                        if job.expires > now + 60_000 {
                            return Ok(job);
                        }
                    }
                }
                return Err(if e.code == "auth_rejected" {
                    ConnectionError::login()
                } else {
                    e
                });
            }
        };
        let job = parse_job(&value, now)?;
        self.saved.job = Some(job.clone());
        self.dirty = true;
        self.save().await?;
        self.refresh_uncertain = false;
        self.retry_at = 0;
        Ok(job)
    }
}
#[async_trait]
impl ProductAdapter for Qoder {
    async fn authorize(&mut self, http: &reqwest::Client, rejected: bool) -> Result<Authorization> {
        let job = self.resolve(http, rejected).await?;
        Ok(Authorization {
            base_url: MODEL_BASE.into(),
            credentials: Credentials::with_key(job.token),
            transport: Some(Arc::new(Http)),
        })
    }
    async fn catalog(&mut self, http: &reqwest::Client) -> Result<Vec<ConnectionModel>> {
        let job = self.resolve(http, false).await?;
        let login = self.source().await?;
        let headers = cosy::headers(
            self.catalog_url(),
            login
                .subject
                .as_deref()
                .ok_or_else(ConnectionError::unsupported)?,
            &job.token,
            &self.saved.machine_id,
        )?;
        let response = http
            .get(self.catalog_url())
            .headers(headers)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| ConnectionError::unavailable())?;
        let value = response_json(response).await?;
        let entries = value["app"]
            .as_array()
            .ok_or_else(ConnectionError::unsupported)?;
        let mut ids = std::collections::HashSet::new();
        let models: Vec<_> = entries
            .iter()
            .filter(|m| m["enable"] == true)
            .filter_map(|m| {
                let id = m["key"].as_str()?;
                if !crate::valid_id(id) || !ids.insert(id.to_owned()) {
                    return None;
                }
                Some(ConnectionModel {
                    id: id.into(),
                    name: m["display_name"].as_str().unwrap_or(id).into(),
                    context_window: m["max_input_tokens"]
                        .as_u64()
                        .and_then(|v| u32::try_from(v).ok()),
                    max_output_tokens: None,
                    reasoning: m["is_reasoning"].as_bool().unwrap_or(false),
                    images: false,
                    thinking: Vec::new(),
                    default_thinking: Default::default(),
                })
            })
            .collect();
        if !models.iter().any(|m| m.id == "auto") {
            return Err(ConnectionError::new(
                "unsupported",
                "Qoder 目录未提供已适配的 Auto 模型",
            ));
        }
        Ok(models)
    }
}
async fn json_request(
    http: &reqwest::Client,
    url: &str,
    token: Option<&str>,
    body: &Value,
) -> Result<Value> {
    let mut request = http.post(url).json(body).timeout(Duration::from_secs(30));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    response_json(
        request
            .send()
            .await
            .map_err(|_| ConnectionError::unavailable())?,
    )
    .await
}
async fn response_json(mut response: reqwest::Response) -> Result<Value> {
    let status = response.status().as_u16();
    if status != 200 {
        return Err(match status {
            400 | 401 => ConnectionError::new("auth_rejected", "Qoder 授权失效"),
            403 => ConnectionError::new("permission_denied", "Qoder 拒绝此操作，请检查账户权限"),
            _ => ConnectionError::unavailable(),
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ConnectionError::unavailable())?
    {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err(ConnectionError::unsupported());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| ConnectionError::unsupported())
}

struct Http;
impl finx_llm::WireApi for Http {
    fn id(&self) -> &'static str {
        "openai-chat"
    }
    fn stream(&self, mut req: finx_llm::WireRequest) -> finx_llm::LlmStream {
        // Public extra_body cannot replace identities, routing, messages or tool definitions.
        req.options
            .extra_body
            .retain(|k, _| ["reasoning_effort", "enable_thinking"].contains(&k.as_str()));
        finx_llm::api::openai_chat::OpenAiChatApi::stream_with_events(req, sse::decode)
    }
}
