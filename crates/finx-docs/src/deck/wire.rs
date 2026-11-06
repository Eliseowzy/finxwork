//! Requests between DeckStore and `finx deck-worker`: one JSON object a line each way, tagged
//! with an id so replies for different decks may come back in any order.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Envelope<T> {
    pub id: u64,
    #[serde(flatten)]
    pub body: T,
}

/// Binary payloads are base64.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// Opens the deck in `dir` (its source, snapshot and log), on a thread of its own.
    Open { deck: String, dir: PathBuf },
    /// Merges a replica's update, logs it, and replies with the new revision.
    Sync { deck: String, update: String },
    /// What a replica with `state_vector` lacks.
    Diff { deck: String, state_vector: String },
    /// The whole state, for a replica joining.
    State { deck: String },
    /// Saves to `to` after the guard (finx-slide `Deck::save`).
    Save { deck: String, to: PathBuf },
    /// Slide lines and size for `DeckSummary`, from the deck as it is now.
    Summary { deck: String },
    Close { deck: String },
    /// Makes a proposal of the engine's `ProposalEdit`s (JSON); replies `Proposed`.
    Propose { deck: String, agent_id: String, note: Option<String>, edits: serde_json::Value },
    /// Accepts a pending proposal; replies `Accepted`.
    Accept { deck: String, proposal: String, force: bool },
    /// Withdraws a pending proposal; replies `Rejected`.
    Reject { deck: String, proposal: String },
    /// Pending proposals and those decided; replies `DeckProposalsResult`.
    Proposals { deck: String },
    /// The deterministic checks of the deck now, or as `proposal` would leave it.
    Check { deck: String, proposal: Option<String> },
    /// The engine's snapshot of the deck now (JSON): its ids are the ones edits address.
    Snapshot { deck: String },
    /// Ends the process: after shutdown, and in tests as a crash.
    Exit,
}

impl Request {
    pub fn deck(&self) -> Option<&str> {
        match self {
            Request::Open { deck, .. }
            | Request::Sync { deck, .. }
            | Request::Diff { deck, .. }
            | Request::State { deck }
            | Request::Save { deck, .. }
            | Request::Summary { deck }
            | Request::Close { deck }
            | Request::Propose { deck, .. }
            | Request::Accept { deck, .. }
            | Request::Reject { deck, .. }
            | Request::Proposals { deck }
            | Request::Check { deck, .. }
            | Request::Snapshot { deck } => Some(deck),
            Request::Exit => None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Opened {
    pub revision: u64,
    pub slide_count: usize,
    /// Edits replayed from the log or snapshot.
    pub recovered: bool,
    /// A log written by another engine could not be replayed safely: set aside, not used.
    #[serde(default)]
    pub set_aside: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Synced {
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bytes {
    pub data: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Saved {
    pub revision: u64,
    pub hash: String,
    pub size: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Summary {
    pub width_pt: f64,
    pub height_pt: f64,
    pub slides: Vec<finx_protocol::deck::SlideLine>,
}

/// A change's reply: the revision after it, and the update it made (base64, empty for none:
/// then nothing was logged and the revision is as it was).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Changed {
    pub revision: u64,
    #[serde(default)]
    pub update: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Proposed {
    #[serde(flatten)]
    pub changed: Changed,
    /// Its id, the worker's: stable across a worker restart.
    pub proposal_id: String,
    /// The engine's proposal JSON, under that id.
    pub proposal: serde_json::Value,
    /// What it does to each slide, in the order the deck would have.
    pub strip: Vec<StripEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StripEntry {
    pub slide_id: String,
    /// `unchanged`, `changed`, `inserted`, `deleted` or `moved`.
    pub status: String,
    /// From 0: where it is in the deck as proposed, or for a deleted slide where it was.
    pub index: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Accepted {
    #[serde(flatten)]
    pub changed: Changed,
    pub applied: bool,
    #[serde(default)]
    pub stale_targets: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rejected {
    pub revision: u64,
    pub rejected: bool,
}
