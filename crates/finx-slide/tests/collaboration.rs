use betteroffice_pptx::{EditCtx, Presentation, TextStyle};
use finx_slide::Deck;

#[test]
fn replica_updates_round_trip_through_authority_and_save() {
    let bytes = include_bytes!("fixtures/editor.pptx").to_vec();
    let authority = Deck::open(bytes.clone()).unwrap();
    let replica = Presentation::open_from_update(&authority.encode_state(), 42, Some(&bytes)).unwrap();
    let matches = authority.find_text("Quarterly review").unwrap();
    let target = &matches[0].range;
    replica.insert_text(&EditCtx::local("replica"), &target.story_id, target.start, "Updated ", &TextStyle::default()).unwrap();
    let delta = replica.encode_diff_v1(&authority.state_vector()).unwrap();
    authority.apply_update(&delta).unwrap();
    assert_eq!(authority.find_text("Updated Quarterly review").unwrap().len(), 1);
    let saved = authority.save().unwrap();
    let reopened = Deck::open(saved).unwrap();
    assert_eq!(reopened.find_text("Updated Quarterly review").unwrap().len(), 1);
    assert_eq!(authority.replace_text("Updated Quarterly review", "Approved review").unwrap(), 1);
    replica.apply_update_v1(&authority.encode_diff(&replica.encode_state_vector_v1()).unwrap()).unwrap();
    assert_eq!(replica.find_text(&betteroffice_pptx::FindRequest { text: "Approved review".into(), within: None, limit: None }).unwrap().unwrap().matches.len(), 1);
}

#[test]
fn malformed_replica_update_is_rejected() {
    let authority = Deck::open(include_bytes!("fixtures/editor.pptx").to_vec()).unwrap();
    let before = authority.markdown().unwrap();
    assert!(authority.apply_update(&[0xff]).is_err());
    assert_eq!(authority.markdown().unwrap(), before);
}

// TODO: BetterOffice's Presentation holds RefCell/Rc (yrs undo, caches), so Deck is not Send + Sync
// yet. Re-enable once the fork makes the edit session thread-safe.
// #[test]
// fn authority_can_be_owned_by_server_tasks() {
//     fn assert_send_sync<T: Send + Sync>() {}
//     assert_send_sync::<Deck>();
// }
