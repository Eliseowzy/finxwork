//! DeckStore end to end, with the worker on a thread (presentation-kernel-authority §11.2).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use betteroffice_pptx::{EditCtx, FindRequest, Presentation, TextStyle};
use finx_docs::deck::{DeckError, DeckEvent, DeckLauncher, DeckStore};

const FIXTURE: &[u8] = include_bytes!("../../finx-slide/tests/fixtures/editor.pptx");

struct Setup {
    _dir: tempfile::TempDir,
    root: PathBuf,
    file: PathBuf,
}

fn setup() -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("deck.pptx");
    std::fs::write(&file, FIXTURE).unwrap();
    Setup { root: dir.path().join("decks"), file, _dir: dir }
}

fn store(s: &Setup) -> DeckStore {
    DeckStore::new(s.root.clone(), DeckLauncher::Thread)
}

/// A replica joined from the store's state, as the editor would.
fn replica(state: &[u8], id: u64) -> Presentation {
    Presentation::open_from_update(state, id, Some(FIXTURE)).unwrap()
}

/// Types `text` before "Quarterly review" and returns the update.
fn type_text(replica: &Presentation, text: &str) -> Vec<u8> {
    let sv = replica.encode_state_vector_v1();
    let found = replica.find_text(&FindRequest { text: "Quarterly review".into(), within: None, limit: None }).unwrap().unwrap();
    let range = &found.matches[0].range;
    replica.insert_text(&EditCtx::local("replica"), &range.story_id, range.start, text, &TextStyle::default()).unwrap();
    replica.encode_diff_v1(&sv).unwrap()
}

fn file_has(path: &Path, text: &str) -> bool {
    let deck = finx_slide::Deck::open(std::fs::read(path).unwrap()).unwrap();
    !deck.find_text(text).unwrap().is_empty()
}

#[tokio::test(flavor = "multi_thread")]
async fn edits_sync_and_save_only_when_dirty() {
    let s = setup();
    let store = store(&s);
    let opened = store.open(&s.file, "a", true).await.unwrap();
    let id = opened.entry.deck_id.clone();
    assert!(!opened.entry.info().dirty);
    let r = replica(&opened.state.unwrap(), 42);
    let (revision, _) = store.sync(&id, Some("a"), &type_text(&r, "Draft "), None).await.unwrap();
    assert_eq!(revision, 1);
    assert!(store.get(&id).unwrap().info().dirty);
    // Nothing on disk until the save.
    assert_eq!(std::fs::read(&s.file).unwrap(), FIXTURE);
    let info = store.save(&id, None, false).await.unwrap();
    assert!(!info.dirty);
    assert!(file_has(&s.file, "Draft Quarterly review"));
    // Nothing unsaved: the file is not touched.
    let before = std::fs::metadata(&s.file).unwrap().modified().unwrap();
    store.save(&id, None, false).await.unwrap();
    assert_eq!(std::fs::metadata(&s.file).unwrap().modified().unwrap(), before);
    // The history goes on after a save: the same replica keeps editing.
    store.sync(&id, Some("a"), &type_text(&r, "More "), None).await.unwrap();
    store.save(&id, None, false).await.unwrap();
    assert!(file_has(&s.file, "Draft More Quarterly review"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_worker_crash_loses_nothing_acknowledged() {
    let s = setup();
    let store = store(&s);
    let opened = store.open(&s.file, "a", true).await.unwrap();
    let id = opened.entry.deck_id.clone();
    let r = replica(&opened.state.unwrap(), 42);
    store.sync(&id, Some("a"), &type_text(&r, "One "), None).await.unwrap();
    store.kill_worker().await;
    // The next request starts a worker, which replays the log first.
    let (revision, missing) = store.sync(&id, Some("a"), &type_text(&r, "Two "), Some(&r.encode_state_vector_v1())).await.unwrap();
    assert_eq!(revision, 2);
    r.apply_update_v1(&missing.unwrap()).unwrap();
    store.save(&id, None, false).await.unwrap();
    assert!(file_has(&s.file, "One Two Quarterly review"));
}

#[tokio::test(flavor = "multi_thread")]
async fn unsaved_edits_come_back_after_the_kernel_restarts() {
    let s = setup();
    {
        let store = store(&s);
        let opened = store.open(&s.file, "a", true).await.unwrap();
        let r = replica(&opened.state.unwrap(), 42);
        store.sync(&opened.entry.deck_id, Some("a"), &type_text(&r, "Unsaved "), None).await.unwrap();
        // The app quits without saving or closing.
        store.kill_worker().await;
    }
    let store = store(&s);
    let opened = store.open(&s.file, "b", true).await.unwrap();
    assert!(opened.recovered);
    assert!(opened.entry.info().dirty);
    let r = replica(&opened.state.unwrap(), 43);
    assert_eq!(r.find_text(&FindRequest { text: "Unsaved Quarterly review".into(), within: None, limit: None }).unwrap().unwrap().matches.len(), 1);
    // A clean close leaves nothing to recover.
    store.save(&opened.entry.deck_id, None, false).await.unwrap();
    store.close(&opened.entry.deck_id, "b").await.unwrap();
    let again = store.open(&s.file, "c", false).await.unwrap();
    assert!(!again.recovered);
    assert!(!again.entry.info().dirty);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_changed_on_disk_is_not_written_over() {
    let s = setup();
    let store = store(&s);
    let opened = store.open(&s.file, "a", true).await.unwrap();
    let id = opened.entry.deck_id.clone();
    let r = replica(&opened.state.unwrap(), 42);
    store.sync(&id, Some("a"), &type_text(&r, "Mine "), None).await.unwrap();
    let mut theirs = FIXTURE.to_vec();
    theirs.extend_from_slice(b"\0");
    std::fs::write(&s.file, &theirs).unwrap();
    assert!(matches!(store.save(&id, None, false).await, Err(DeckError::Conflict(_))));
    assert!(store.get(&id).unwrap().info().conflict);
    assert_eq!(std::fs::read(&s.file).unwrap(), theirs);
    store.save(&id, None, true).await.unwrap();
    assert!(file_has(&s.file, "Mine Quarterly review"));
    assert!(!store.get(&id).unwrap().info().conflict);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_changed_while_closed_with_nothing_unsaved_opens_fresh() {
    let s = setup();
    let other = s.file.with_file_name("other.pptx");
    std::fs::write(&other, FIXTURE).unwrap();
    let store = store(&s);
    let opened = store.open(&s.file, "a", true).await.unwrap();
    let r = replica(&opened.state.unwrap(), 42);
    store.sync(&opened.entry.deck_id, Some("a"), &type_text(&r, "Saved "), None).await.unwrap();
    store.save(&opened.entry.deck_id, None, false).await.unwrap();
    store.kill_worker().await;
    drop(store);
    // Someone else rewrites it; our log holds nothing unsaved.
    let mut changed = std::fs::read(&s.file).unwrap();
    changed.extend_from_slice(b"\0");
    std::fs::write(&s.file, &changed).unwrap();
    let store = self::store(&s);
    let opened = store.open(&s.file, "b", false).await.unwrap();
    assert!(!opened.entry.info().conflict);
    assert!(!opened.entry.info().dirty);
    assert_eq!(std::fs::read(opened.entry.source()).unwrap(), changed);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_malformed_update_changes_nothing() {
    let s = setup();
    let store = store(&s);
    let opened = store.open(&s.file, "a", false).await.unwrap();
    let id = opened.entry.deck_id.clone();
    assert!(matches!(store.sync(&id, Some("a"), &[0xff], None).await, Err(DeckError::Protocol(_))));
    assert_eq!(store.get(&id).unwrap().info().revision, 0);
    assert!(!store.get(&id).unwrap().info().dirty);
}

#[tokio::test(flavor = "multi_thread")]
async fn sessions_share_an_entry_and_hear_each_other() {
    let s = setup();
    let store = store(&s);
    let heard = Arc::new(Mutex::new(Vec::new()));
    let h = heard.clone();
    store.on_event(move |e| {
        if let DeckEvent::Update { session, .. } = e {
            h.lock().unwrap().push(session.clone());
        }
    });
    let a = store.open(&s.file, "a", true).await.unwrap();
    let b = store.open(&s.file, "b", true).await.unwrap();
    assert_eq!(a.entry.deck_id, b.entry.deck_id);
    let r = replica(&a.state.unwrap(), 42);
    store.sync(&a.entry.deck_id, Some("a"), &type_text(&r, "Shared "), None).await.unwrap();
    assert_eq!(*heard.lock().unwrap(), vec![Some("a".to_owned())]);
    // One session closing keeps the entry for the other.
    store.close(&a.entry.deck_id, "a").await.unwrap();
    assert!(store.get(&a.entry.deck_id).is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn structural_edits_save_through_the_kernel() {
    let s = setup();
    let store = store(&s);
    let opened = store.open(&s.file, "a", true).await.unwrap();
    let id = opened.entry.deck_id.clone();
    let r = replica(&opened.state.unwrap(), 42);
    let sv = r.encode_state_vector_v1();
    let ids = r.slide_ids().unwrap();
    r.move_slide(&EditCtx::local("replica"), &ids[0], 1).unwrap();
    r.insert_slide(&EditCtx::local("replica"), 0, None).unwrap();
    store.sync(&id, Some("a"), &r.encode_diff_v1(&sv).unwrap(), None).await.unwrap();
    store.save(&id, None, false).await.unwrap();
    assert_eq!(finx_slide::Deck::open(std::fs::read(&s.file).unwrap()).unwrap().slide_count(), 3);
}
