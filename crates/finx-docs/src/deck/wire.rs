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
            | Request::Close { deck } => Some(deck),
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
