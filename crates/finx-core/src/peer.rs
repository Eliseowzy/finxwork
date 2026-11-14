//! The other side of an external bot's conversation (docs/kernel/bot-contacts-design.md §5.3):
//! an outside service answers, and the kernel only forwards what the owner said and records what
//! came back. The kernel knows no protocol here; `finx-a2a` implements [`Peer`].

use async_trait::async_trait;
use bytes::Bytes;
use futures::stream::BoxStream;
use serde::Deserialize;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

/// The outside service a session talks to, as its header keeps it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerRef {
    /// The host the words go to; the log shows it as the model of what the other side said.
    pub host: String,
}

/// A service that answers for a session. One per session.
#[async_trait]
pub trait Peer: Send + Sync {
    /// Sends one message and gives the events of this round.
    async fn send(
        &self,
        message: PeerMessage,
        thread: PeerThread,
        cancel: CancellationToken,
    ) -> Result<BoxStream<'static, PeerEvent>, PeerError>;

    /// Picks up a task that has not ended: looks first, then subscribes.
    async fn resume(
        &self,
        thread: PeerThread,
        cancel: CancellationToken,
    ) -> Result<BoxStream<'static, PeerEvent>, PeerError>;

    /// Asks the other side to stop. Best effort.
    async fn cancel(&self, thread: PeerThread);
}

/// What goes to the other side: the owner's words and pictures, nothing else.
#[derive(Clone, Debug)]
pub struct PeerMessage {
    pub id: String,
    pub text: String,
    pub images: Vec<PeerImage>,
}

/// A picture, base64 encoded as the protocol carries it.
#[derive(Clone, Debug)]
pub struct PeerImage {
    pub media_type: String,
    pub data: String,
}

/// The other side's conversation and its current task.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerThread {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// The other side is waiting for an answer to that task: the next message belongs to it
    /// (bot-contacts-design §5.4). A task that ended otherwise does not keep the next message.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub waiting: bool,
}

impl PeerThread {
    pub fn is_empty(&self) -> bool {
        self.context_id.is_none() && self.task_id.is_none()
    }
}

/// One round's events, as the other side gives them.
#[derive(Debug)]
pub enum PeerEvent {
    /// The conversation and task identifiers: the first event, and again when they change.
    Thread(PeerThread),
    /// The other side is still working; only proof that the connection is alive.
    Working,
    /// A complete message from the other side.
    Said {
        text: String,
    },
    /// A file from the other side, not on disk yet.
    File {
        name: String,
        media_type: Option<String>,
        bytes: Bytes,
    },
    /// The other side is waiting for this side's answer.
    Asked {
        text: String,
    },
    Done,
    Failed(PeerError),
}

/// Why a round failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerError {
    /// A name the service layer turns into an error code, as `bot_auth_required`.
    pub kind: String,
    pub message: String,
    pub retryable: bool,
}

impl PeerError {
    pub fn new(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
            retryable: false,
        }
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    /// The other side no longer has the task (it restarted, say).
    pub fn gone(message: impl Into<String>) -> Self {
        Self::new("bot_task_gone", message)
    }

    /// The other side refused the credential.
    pub fn auth_required(message: impl Into<String>) -> Self {
        Self::new("bot_auth_required", message)
    }
}

impl std::fmt::Display for PeerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PeerError {}
