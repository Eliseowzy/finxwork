//! Product behavior stays behind this boundary; the manager owns lifecycle and storage.
use crate::{Result, qwenwork::QwenWork};
use async_trait::async_trait;
use finx_llm::connection::Authorization;
use finx_protocol::api::ConnectionModel;
#[async_trait]
pub(crate) trait ProductAdapter: Send + Sync {
    async fn catalog(&mut self, http: &reqwest::Client) -> Result<Vec<ConnectionModel>>;
    async fn authorize(&mut self, http: &reqwest::Client, rejected: bool) -> Result<Authorization>;
}
#[async_trait]
impl ProductAdapter for QwenWork {
    async fn catalog(&mut self, http: &reqwest::Client) -> Result<Vec<ConnectionModel>> {
        QwenWork::catalog(self, http).await
    }
    async fn authorize(&mut self, http: &reqwest::Client, rejected: bool) -> Result<Authorization> {
        QwenWork::authorize(self, http, rejected).await
    }
}
pub(crate) fn name(adapter: &str) -> &'static str {
    match adapter {
        "qoder" => "Qoder",
        _ => "千问办公",
    }
}
pub(crate) fn base(adapter: &str) -> &'static str {
    match adapter {
        "qoder" => "https://api2-v2.qoder.sh/model/v1",
        _ => "https://gateway.qwenwork.cn/v1",
    }
}

pub(crate) fn create(
    adapter: &str,
    id: String,
    identity: String,
    env: std::sync::Arc<dyn crate::platform::Environment>,
) -> Box<dyn ProductAdapter> {
    match adapter {
        "qoder" => Box::new(crate::qoder::Qoder::new(id, identity, env)),
        _ => Box::new(QwenWork::new(id, identity, env)),
    }
}
pub(crate) fn supported(adapter: &str, model: &str) -> bool {
    adapter != "qoder" || model == "auto"
}

pub(crate) fn authentication_failure(adapter: &str, error: &finx_llm::LlmError) -> bool {
    error.kind == finx_llm::ErrorKind::Auth
        && (adapter != "qoder"
            || error.status == Some(401)
            || matches!(
                error.provider_code.as_deref(),
                Some("connection_login_required" | "identity_changed")
            ))
}
