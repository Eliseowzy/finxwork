//! The worker's side: every open deck lives on a thread of its own (`Deck` is not `Send`, K3),
//! which also makes each deck's requests run strictly one after another.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use finx_slide::Deck;
use serde_json::Value;

use super::journal::{self, Journal};
use super::wire::{Bytes, Envelope, Opened, Request, Saved, Summary, Synced};

type Reply = Box<dyn FnOnce(Result<Value, String>) + Send>;

struct Job {
    request: Request,
    reply: Reply,
}

/// Serves requests from `input` until it ends or an `exit` comes.
pub fn serve(input: impl BufRead, output: impl Write + Send + 'static) -> std::io::Result<()> {
    let output = Arc::new(Mutex::new(output));
    let mut decks: HashMap<String, mpsc::Sender<Job>> = HashMap::new();
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let envelope: Envelope<Request> = match serde_json::from_str(&line) {
            Ok(e) => e,
            Err(e) => {
                // Without an id nobody waits for the reply; the line is only logged.
                eprintln!("deck-worker: bad request: {e}");
                continue;
            }
        };
        let id = envelope.id;
        let out = output.clone();
        let reply: Reply = Box::new(move |result| write_reply(&out, id, result));
        match envelope.body {
            Request::Exit => return Ok(()),
            Request::Open { deck, dir } => {
                if decks.contains_key(&deck) {
                    reply(Err(format!("deck {deck} is already open")));
                    continue;
                }
                let (tx, rx) = mpsc::channel();
                decks.insert(deck.clone(), tx);
                std::thread::Builder::new()
                    .name(format!("deck-{deck}"))
                    .spawn(move || run(dir, rx, reply))
                    .expect("spawn deck thread");
            }
            Request::Close { deck } => {
                // The thread ends once its queue is drained and the sender is gone.
                match decks.remove(&deck) {
                    Some(tx) => {
                        let _ = tx.send(Job { request: Request::Close { deck }, reply });
                    }
                    None => reply(Ok(Value::Null)),
                }
            }
            request => {
                let deck = request.deck().unwrap_or_default().to_owned();
                match decks.get(&deck) {
                    Some(tx) => {
                        if let Err(mpsc::SendError(job)) = tx.send(Job { request, reply }) {
                            decks.remove(&deck);
                            (job.reply)(Err(format!("deck {deck} stopped")));
                        }
                    }
                    None => reply(Err(format!("{NOT_OPEN}{deck}"))),
                }
            }
        }
    }
    Ok(())
}

/// Prefix of the error for a deck this process has not opened: the store opens it and retries.
pub const NOT_OPEN: &str = "not open: ";

fn write_reply(out: &Mutex<impl Write>, id: u64, result: Result<Value, String>) {
    let reply = match result {
        Ok(value) => serde_json::json!({ "id": id, "ok": value }),
        Err(e) => serde_json::json!({ "id": id, "err": e }),
    };
    let mut out = out.lock().unwrap_or_else(|e| e.into_inner());
    let _ = serde_json::to_writer(&mut *out, &reply);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

struct Held {
    deck: Deck,
    journal: Journal,
    revision: u64,
}

fn run(dir: PathBuf, jobs: mpsc::Receiver<Job>, opened: Reply) {
    let mut held = match open(&dir) {
        Ok((held, reply)) => {
            opened(to_value(reply));
            held
        }
        Err(e) => {
            opened(Err(e));
            return;
        }
    };
    for job in jobs {
        let close = matches!(job.request, Request::Close { .. });
        let result = handle(&mut held, job.request);
        (job.reply)(result);
        if close {
            return;
        }
    }
}

fn open(dir: &Path) -> Result<(Held, Opened), String> {
    let source = std::fs::read(dir.join(journal::SOURCE)).map_err(|e| format!("source: {e}"))?;
    let (journal, recovered) = Journal::open(dir).map_err(|e| format!("log: {e}"))?;
    if recovered.dropped_bytes > 0 {
        eprintln!("deck-worker: {}: dropped {} bytes of a torn log tail", dir.display(), recovered.dropped_bytes);
    }
    let fresh = || Deck::open(source.clone()).map_err(|e| e.to_string());
    let mut deck = fresh()?;
    let mut set_aside = None;
    let mut revision = 0;
    if !recovered.is_empty() {
        let same_engine = recovered.engine.as_deref().is_none_or(|e| e == finx_slide::ENGINE);
        // Replay; under another engine the result must also still save (§7.2).
        let replayed = replay(&deck, &recovered).and_then(|()| if same_engine { Ok(()) } else { deck.save().map(drop).map_err(|e| e.to_string()) });
        match replayed {
            Ok(()) => revision = recovered.revision(),
            Err(e) => {
                let tag = recovered.engine.clone().unwrap_or_else(|| "unknown".into()).replace(|c: char| !c.is_ascii_alphanumeric(), "-");
                eprintln!("deck-worker: {}: log not replayed ({e}); kept as .{tag}", dir.display());
                drop(journal);
                Journal::set_aside(dir, &tag).map_err(|e| e.to_string())?;
                set_aside = Some(tag);
                deck = fresh()?;
                let (journal, _) = Journal::open(dir).map_err(|e| e.to_string())?;
                journal.stamp_engine(finx_slide::ENGINE).map_err(|e| e.to_string())?;
                let opened = Opened { revision: 0, slide_count: deck.slide_count(), recovered: false, set_aside };
                return Ok((Held { deck, journal, revision: 0 }, opened));
            }
        }
    }
    journal.stamp_engine(finx_slide::ENGINE).map_err(|e| e.to_string())?;
    let opened = Opened { revision, slide_count: deck.slide_count(), recovered: revision > 0, set_aside };
    Ok((Held { deck, journal, revision }, opened))
}

fn replay(deck: &Deck, recovered: &journal::Recovered) -> Result<(), String> {
    if let Some((_, state)) = &recovered.snapshot {
        deck.apply_update(state).map_err(|e| format!("snapshot: {e}"))?;
    }
    for (revision, update) in &recovered.records {
        deck.apply_update(update).map_err(|e| format!("record {revision}: {e}"))?;
    }
    Ok(())
}

fn handle(held: &mut Held, request: Request) -> Result<Value, String> {
    match request {
        Request::Sync { update, .. } => {
            let update = B64.decode(update).map_err(|e| format!("update: {e}"))?;
            // A rejected update leaves the deck as it was (I5) and is not logged.
            held.deck.apply_update(&update).map_err(|e| format!("protocol: {e}"))?;
            held.revision += 1;
            // Logged and synced before the acknowledgement (§5.2-4).
            held.journal.append(held.revision, &update).map_err(|e| format!("log: {e}"))?;
            if held.journal.wants_compaction()
                && let Err(e) = held.journal.compact(held.revision, &held.deck.encode_state())
            {
                eprintln!("deck-worker: compaction failed, the log keeps growing: {e}");
            }
            to_value(Synced { revision: held.revision })
        }
        Request::Diff { state_vector, .. } => {
            let sv = B64.decode(state_vector).map_err(|e| format!("state vector: {e}"))?;
            let diff = held.deck.encode_diff(&sv).map_err(|e| format!("protocol: {e}"))?;
            to_value(Bytes { data: B64.encode(diff) })
        }
        Request::State { .. } => to_value(Bytes { data: B64.encode(held.deck.encode_state()) }),
        Request::Save { to, .. } => {
            let bytes = held.deck.save().map_err(|e| format!("save: {e}"))?;
            crate::atomic::write(&to, &bytes).map_err(|e| format!("write: {e}"))?;
            to_value(Saved { revision: held.revision, hash: super::sha256_hex(&bytes), size: bytes.len() as u64 })
        }
        Request::Summary { .. } => {
            let outline = held.deck.outline().map_err(|e| e.to_string())?;
            let slides = outline
                .slides
                .iter()
                .map(|s| finx_protocol::deck::SlideLine {
                    index: s.index as u32,
                    slide_id: s.slide_id.clone(),
                    layout_id: s.layout.clone().unwrap_or_default(),
                    title: s.title.clone(),
                    shape_count: s.objects.iter().filter(|o| o.depth == 0).count() as u32,
                    has_table: s.has("table"),
                    has_chart: s.has("chart"),
                    has_picture: s.has("picture"),
                    has_notes: !s.notes.trim().is_empty(),
                    hidden: s.hidden,
                    section_id: None,
                })
                .collect();
            to_value(Summary { width_pt: outline.width_pt, height_pt: outline.height_pt, slides })
        }
        Request::Close { .. } => Ok(Value::Null),
        Request::Open { .. } | Request::Exit => Err("unexpected request".into()),
    }
}

fn to_value(v: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}
