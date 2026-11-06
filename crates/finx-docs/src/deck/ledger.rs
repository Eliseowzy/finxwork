//! A deck's proposals, as the worker keeps them (presentation-deck-edit §3).
//!
//! The engine holds pending proposals beside the Yrs document, not in it: they reach no replica
//! and are not in the update log. So the worker gives each one an id of its own and keeps its
//! request in `proposals.json`; a worker that starts again over the directory replays the log,
//! then proposes the pending ones again under the same ids. Decided proposals stay listed (the
//! newest [`KEEP_DECIDED`]) so a conversation's card can tell accepted from rejected.

// The worker has no other log than its stderr, which the kernel keeps.
#![allow(clippy::print_stderr)]

use std::path::{Path, PathBuf};

use finx_protocol::deck::{DeckProposalEntry, DeckProposalState};
use finx_slide::{Deck, Proposal, ProposalRequest};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const FILE: &str = "proposals.json";
const KEEP_DECIDED: usize = 64;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Entry {
    id: String,
    request: ProposalRequest,
    status: DeckProposalState,
    /// The engine's proposal as last seen, under `id`.
    proposal: Value,
    /// The engine's id in this run, while pending.
    #[serde(skip)]
    engine: Option<String>,
}

#[derive(Default)]
pub struct Ledger {
    path: PathBuf,
    entries: Vec<Entry>,
}

impl Ledger {
    /// The ledger of `dir`, its pending proposals made again on `deck`. One that no longer
    /// applies is listed as rejected.
    pub fn open(dir: &Path, deck: &Deck) -> Self {
        let path = dir.join(FILE);
        let entries: Vec<Entry> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let mut ledger = Self { path, entries };
        let mut dropped = false;
        for entry in ledger.entries.iter_mut().filter(|e| e.status == DeckProposalState::Pending) {
            match deck.propose(entry.request.clone()) {
                Ok((proposal, _)) => entry.engine = Some(proposal.id),
                Err(e) => {
                    eprintln!("deck-worker: proposal {} not made again ({e}); listed as rejected", entry.id);
                    entry.status = DeckProposalState::Rejected;
                    dropped = true;
                }
            }
        }
        if dropped {
            ledger.persist();
        }
        ledger
    }

    /// Records a proposal just made; returns its id.
    pub fn add(&mut self, request: ProposalRequest, proposal: &Proposal) -> String {
        let id = format!("p-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
        let json = relabel(proposal, &id);
        self.entries.push(Entry { id: id.clone(), request, status: DeckProposalState::Pending, proposal: json, engine: Some(proposal.id.clone()) });
        self.persist();
        id
    }

    /// The engine's id of a pending proposal.
    pub fn engine_id(&self, id: &str) -> Option<String> {
        self.entries.iter().find(|e| e.id == id && e.status == DeckProposalState::Pending).and_then(|e| e.engine.clone())
    }

    /// A pending proposal was decided.
    pub fn decide(&mut self, id: &str, status: DeckProposalState) {
        if let Some(entry) = self.entries.iter_mut().find(|e| e.id == id) {
            entry.status = status;
            entry.engine = None;
        }
        let decided = self.entries.iter().filter(|e| e.status != DeckProposalState::Pending).count();
        if decided > KEEP_DECIDED {
            let mut extra = decided - KEEP_DECIDED;
            self.entries.retain(|e| {
                let drop = extra > 0 && e.status != DeckProposalState::Pending;
                if drop {
                    extra -= 1;
                }
                !drop
            });
        }
        self.persist();
    }

    /// Pending proposals as the engine sees them now (with their stale targets), then the
    /// decided ones.
    pub fn list(&self, pending: &[Proposal]) -> Vec<DeckProposalEntry> {
        let mut out = Vec::new();
        for proposal in pending {
            if let Some(entry) = self.entries.iter().find(|e| e.engine.as_deref() == Some(&proposal.id)) {
                out.extend(entry_of(relabel(proposal, &entry.id), DeckProposalState::Pending));
            }
        }
        for entry in self.entries.iter().filter(|e| e.status != DeckProposalState::Pending) {
            out.extend(entry_of(entry.proposal.clone(), entry.status));
        }
        out
    }

    fn persist(&self) {
        let written = serde_json::to_vec(&self.entries).map_err(std::io::Error::other).and_then(|b| crate::atomic::write(&self.path, &b));
        if let Err(e) = written {
            eprintln!("deck-worker: {}: {e}", self.path.display());
        }
    }
}

/// The engine's proposal JSON under the worker's id.
pub fn relabel(proposal: &Proposal, id: &str) -> Value {
    let mut json = serde_json::to_value(proposal).unwrap_or(Value::Null);
    json["id"] = Value::String(id.to_owned());
    json
}

fn entry_of(mut json: Value, status: DeckProposalState) -> Option<DeckProposalEntry> {
    json["status"] = serde_json::to_value(status).ok()?;
    serde_json::from_value(json).ok()
}
