//! The [`finx_core::Peer`] of an A2A bot (docs/kernel/bot-contacts-design.md §5.3): delegates to
//! [`Client`] and turns its errors into the kinds the kernel records.

use std::fmt;

use async_trait::async_trait;
use finx_core::Peer;
use finx_core::PeerError;
use finx_core::PeerEvent;
use finx_core::PeerMessage;
use finx_core::PeerThread;
use futures::stream::BoxStream;
use tokio_util::sync::CancellationToken;

use crate::client::Auth;
use crate::client::Client;
use crate::client::ClientError;
use crate::client::ClientOptions;
use crate::client::Endpoint;

/// Where a bot's conversation goes, as the bot's settings keep it.
#[derive(Clone)]
pub struct Source {
    pub endpoint: String,
    pub host: String,
    pub tenant: Option<String>,
    pub auth: Auth,
    pub allow_local: bool,
}

impl fmt::Debug for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Source")
            .field("endpoint", &self.endpoint)
            .field("host", &self.host)
            .field("tenant", &self.tenant)
            .field("auth", &self.auth)
            .field("allow_local", &self.allow_local)
            .finish()
    }
}

/// One external bot, as a session's task loop sees it.
#[derive(Clone)]
pub struct A2aPeer {
    source: Source,
}

impl A2aPeer {
    pub fn new(source: Source) -> Self {
        Self { source }
    }
}

impl fmt::Debug for A2aPeer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("A2aPeer")
            .field("source", &self.source)
            .finish()
    }
}

impl A2aPeer {
    fn client(&self) -> Result<Client, PeerError> {
        Client::new(
            Endpoint {
                url: self.source.endpoint.clone(),
                tenant: self.source.tenant.clone(),
            },
            self.source.auth.clone(),
            ClientOptions {
                allow_local: self.source.allow_local,
            },
        )
        .map_err(|error| error.to_peer_error())
    }
}

#[async_trait]
impl Peer for A2aPeer {
    async fn send(
        &self,
        message: PeerMessage,
        thread: PeerThread,
        cancel: CancellationToken,
    ) -> Result<BoxStream<'static, PeerEvent>, PeerError> {
        let client = self.client()?;
        client
            .send(message, thread, cancel)
            .await
            .map_err(|error| error.to_peer_error())
    }

    async fn resume(
        &self,
        thread: PeerThread,
        cancel: CancellationToken,
    ) -> Result<BoxStream<'static, PeerEvent>, PeerError> {
        let client = self.client()?;
        client
            .resume(thread, cancel)
            .await
            .map_err(|error| error.to_peer_error())
    }

    async fn cancel(&self, thread: PeerThread) {
        let client = match self.client() {
            Ok(client) => client,
            Err(error) => {
                tracing::debug!(host = %self.source.host, %error, "could not ask the other side to cancel");
                return;
            }
        };
        if let Err(error) = client.cancel(&thread).await {
            tracing::debug!(host = %self.source.host, %error, "the other side did not cancel the task");
        }
    }
}

impl ClientError {
    pub(crate) fn to_peer_error(&self) -> PeerError {
        match self {
            ClientError::Auth(message) => PeerError::auth_required(message.clone()),
            ClientError::Gone(message) => PeerError::gone(message.clone()),
            ClientError::JsonRpc { reason, message } if reason == "TASK_NOT_FOUND" => {
                PeerError::gone(message.clone())
            }
            ClientError::JsonRpc { message, .. } | ClientError::Protocol(message) => {
                PeerError::new("bot_peer_failed", message.clone())
            }
            ClientError::Http { status, message } => {
                // An answer that never came, or a server error, is the connection's trouble:
                // the task can be picked up again (§5.5). A refusal is the task's.
                let lost = status.is_none()
                    || (*status).is_some_and(|status| (500..=599).contains(&status));
                if lost {
                    PeerError::new("bot_peer_lost", message.clone()).retryable()
                } else {
                    PeerError::new("bot_peer_failed", message.clone())
                }
            }
            ClientError::Cancelled => {
                PeerError::new("bot_peer_failed", "the request was cancelled")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::Mock;
    use wiremock::MockServer;
    use wiremock::ResponseTemplate;
    use wiremock::matchers::body_string_contains;
    use wiremock::matchers::method;

    fn source(server: &MockServer, auth: Auth) -> Source {
        Source {
            endpoint: server.uri(),
            host: "127.0.0.1".to_string(),
            tenant: None,
            auth,
            allow_local: true,
        }
    }

    fn message() -> PeerMessage {
        PeerMessage {
            id: "m1".to_string(),
            text: "hello".to_string(),
            images: Vec::new(),
        }
    }

    #[test]
    fn debug_does_not_show_credentials() {
        let auth = Auth::ApiKey {
            header: "X-API-Key".to_string(),
            value: "secret-key".to_string(),
        };
        let printed = format!("{auth:?}");
        assert!(!printed.contains("secret-key"), "{printed}");
        let auth = Auth::Bearer {
            token: "secret-token".to_string(),
        };
        let printed = format!("{auth:?}");
        assert!(!printed.contains("secret-token"), "{printed}");
    }

    #[tokio::test]
    async fn an_unaccepted_credential_is_auth_required() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string_contains("SendStreamingMessage"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let peer = A2aPeer::new(source(
            &server,
            Auth::Bearer {
                token: "bad".to_string(),
            },
        ));
        let error = peer
            .send(message(), PeerThread::default(), CancellationToken::new())
            .await
            .err()
            .expect("401");
        assert_eq!(error.kind, "bot_auth_required");
    }

    #[tokio::test]
    async fn a_missing_task_on_resume_is_gone() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string_contains("GetTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0", "id": 1,
                "error": {
                    "code": -32001,
                    "message": "Task not found",
                    "data": [{ "reason": "TASK_NOT_FOUND" }]
                }
            })))
            .mount(&server)
            .await;
        let peer = A2aPeer::new(source(&server, Auth::None));
        let thread = PeerThread {
            context_id: None,
            task_id: Some("gone".to_string()),
            ..Default::default()
        };
        let error = peer
            .resume(thread, CancellationToken::new())
            .await
            .err()
            .expect("task gone");
        assert_eq!(error.kind, "bot_task_gone");
    }

    #[tokio::test]
    async fn cancelling_a_task_nobody_has_anymore_is_fine() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string_contains("CancelTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0", "id": 1,
                "error": {
                    "code": -32001,
                    "message": "Task not found",
                    "data": [{ "reason": "TASK_NOT_FOUND" }]
                }
            })))
            .mount(&server)
            .await;
        let peer = A2aPeer::new(source(&server, Auth::None));
        let thread = PeerThread {
            context_id: None,
            task_id: Some("gone".to_string()),
            ..Default::default()
        };
        peer.cancel(thread).await;
    }
}
