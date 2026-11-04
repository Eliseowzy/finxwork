//! End-to-end: a workbook over the native protocol (spreadsheet-design §6, §7), with the real
//! `finx doc-worker` behind `finx serve`. A person opens a DCF model, looks at the inputs, tries
//! a higher WACC, keeps it, undoes and redoes it, saves, and meets Excel having changed the file.

mod common;

use common::Demux;
use common::SchemaCheck;
use common::TestEnv;
use common::native_init;
use common::native_prompt;
use finx_sheet::book::Book;
use finx_sheet::book::Value;
use finx_sheet::cellref::CellRef;
use serde_json::Value as Json;
use serde_json::json;
use std::path::Path;

fn fixture() -> Vec<u8> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../finx-sheet/tests/fixtures/gen/dcf_settled.xlsx")).unwrap()
}

fn cell<'a>(cells: &'a Json, at: &str) -> &'a Json {
    cells["cells"].as_array().unwrap().iter().find(|c| c["cell"] == at).unwrap_or_else(|| panic!("no {at} in {cells}"))
}

fn on_disk(path: &Path, sheet: &str, at: &str) -> Value {
    let book = Book::open(&std::fs::read(path).unwrap()).unwrap();
    book.value(book.sheet_index(sheet).unwrap(), CellRef::parse(at).unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_workbook_is_read_edited_and_saved_over_the_protocol() {
    let env = TestEnv::new("manual", "").await;
    let schema = SchemaCheck::new(&["DocOpenResult", "DocCellsResult", "DocApplyResult", "DocInfo"]);
    let (_child, client, _incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    client.request("initialize", json!({"protocol_version": 2, "client_info": {"name": "e2e"}})).await.unwrap();
    let cwd = env.workspace("a");
    let session = client.request("session/new", json!({"cwd": cwd})).await.unwrap()["session_id"].as_str().unwrap().to_string();
    let file = cwd.join("模型.xlsx");
    std::fs::write(&file, fixture()).unwrap();

    let opened = client.request("doc/open", json!({"session_id": session, "path": file})).await.unwrap();
    schema.check("DocOpenResult", &opened);
    let info = &opened["info"];
    assert_eq!(info["format"], "xlsx");
    assert_eq!(info["layout"], "grid");
    let sheets: Vec<&str> = info["sheets"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(sheets, ["假设", "利润表", "估值", "可比公司"]);
    assert_eq!(info["sheets"][1]["frozen"], json!([2, 1]));
    assert!(info["capabilities"].as_array().unwrap().contains(&json!("calc")));
    let doc = info["doc_id"].as_str().unwrap().to_string();

    // The inputs as the grid shows them: formats applied, the input font blue.
    let inputs = client.request("doc/cells", json!({"session_id": session, "doc_id": doc, "sheet": "假设", "range": "A1:C9"})).await.unwrap();
    schema.check("DocCellsResult", &inputs);
    assert_eq!(cell(&inputs, "A6")["text"], "WACC");
    assert_eq!(cell(&inputs, "B6")["text"], "8.5%");
    assert_eq!(cell(&inputs, "B6")["value"], json!({"type": "number", "value": 0.085}));
    assert_eq!(cell(&inputs, "B6")["look"]["color"], "0000FF");
    let valuation = client.request("doc/cells", json!({"session_id": session, "doc_id": doc, "sheet": "估值", "range": "A15:D15"})).await.unwrap();
    assert_eq!(cell(&valuation, "D15")["text"], "6,121.33");
    assert_eq!(cell(&valuation, "D15")["formula"], "=SUM(D3:D12)+D14");

    // Trying 9% changes nothing yet, and says what would move.
    let wacc = json!([{"op": "set_value", "sheet": "假设", "cell": "B6", "value": 0.09}]);
    let tried = client.request("doc/apply", json!({"session_id": session, "doc_id": doc, "ops": wacc, "preview": true})).await.unwrap();
    schema.check("DocApplyResult", &tried);
    assert_eq!(tried["revision"], 0);
    assert_eq!(tried["dirty"], false);
    let outputs = tried["impact"]["key_outputs"].as_array().unwrap();
    let ev = outputs.iter().find(|o| o["sheet"] == "估值" && o["cell"] == "D15").unwrap_or_else(|| panic!("{outputs:?}"));
    assert_eq!(ev["label"], "企业价值");
    assert_eq!(ev["before_text"], "6,121.33");
    assert!(ev["after"]["value"].as_f64().unwrap() < 6121.33);
    assert_eq!(tried["impact"]["edited"][0]["before_text"], "8.5%");
    assert_eq!(tried["impact"]["edited"][0]["after_text"], "9.0%");
    let unchanged = client.request("doc/cells", json!({"session_id": session, "doc_id": doc, "sheet": "假设", "range": "B6"})).await.unwrap();
    assert_eq!(cell(&unchanged, "B6")["text"], "8.5%");

    // Kept: a revision, the grid shows the new values, the file is untouched until saved.
    let kept = client.request("doc/apply", json!({"session_id": session, "doc_id": doc, "ops": wacc, "base_revision": 0})).await.unwrap();
    assert_eq!(kept["revision"], 1);
    assert_eq!(kept["dirty"], true);
    assert_eq!(kept["impact"], tried["impact"]);
    let new_ev = ev["after_text"].clone();
    let valuation = client.request("doc/cells", json!({"session_id": session, "doc_id": doc, "sheet": "估值", "range": "D15"})).await.unwrap();
    assert_eq!(cell(&valuation, "D15")["text"], new_ev);
    assert_eq!(on_disk(&file, "假设", "B6"), Value::Number(0.085));

    // An edit made against an older revision, and one that would break a merged title, are refused.
    let stale = client.request("doc/apply", json!({"session_id": session, "doc_id": doc, "ops": wacc, "base_revision": 0})).await.unwrap_err();
    assert_eq!(stale.code, -32035);
    let merged = json!([{"op": "set_value", "sheet": "利润表", "cell": "C1", "value": "x"}]);
    let refused = client.request("doc/apply", json!({"session_id": session, "doc_id": doc, "ops": merged})).await.unwrap_err();
    assert_eq!(refused.code, -32034);
    assert!(refused.message.contains("merged"), "{}", refused.message);

    // Undo and redo, by revision.
    let undone = client.request("doc/undo", json!({"session_id": session, "doc_id": doc})).await.unwrap();
    assert_eq!(undone["dirty"], false);
    let back = client.request("doc/cells", json!({"session_id": session, "doc_id": doc, "sheet": "估值", "range": "D15"})).await.unwrap();
    assert_eq!(cell(&back, "D15")["text"], "6,121.33");
    client.request("doc/redo", json!({"session_id": session, "doc_id": doc})).await.unwrap();

    // Saved: the file now holds 9% and the new valuation, with everything else as it was.
    let saved = client.request("doc/save", json!({"session_id": session, "doc_id": doc})).await.unwrap();
    schema.check("DocInfo", &saved);
    assert_eq!(saved["dirty"], false);
    assert_eq!(on_disk(&file, "假设", "B6"), Value::Number(0.09));
    let Value::Number(saved_ev) = on_disk(&file, "估值", "D15") else { panic!() };
    assert!(saved_ev < 6121.33);

    // Excel changes the file meanwhile: an unsaved edit survives, saving says so, force writes over.
    std::fs::write(&file, fixture()).unwrap();
    let growth = json!([{"op": "set_value", "sheet": "假设", "cell": "B2", "value": 0.1}]);
    client.request("doc/apply", json!({"session_id": session, "doc_id": doc, "ops": growth})).await.unwrap();
    let conflict = client.request("doc/save", json!({"session_id": session, "doc_id": doc})).await.unwrap_err();
    assert_eq!(conflict.code, -32036);
    assert_eq!(on_disk(&file, "假设", "B6"), Value::Number(0.085));
    client.request("doc/save", json!({"session_id": session, "doc_id": doc, "force": true})).await.unwrap();
    assert_eq!(on_disk(&file, "假设", "B2"), Value::Number(0.1));
    assert_eq!(on_disk(&file, "假设", "B6"), Value::Number(0.09));

    // Save as leaves the original alone.
    let copy = cwd.join("模型-副本.xlsx");
    client.request("doc/save", json!({"session_id": session, "doc_id": doc, "path": copy})).await.unwrap();
    assert_eq!(on_disk(&copy, "假设", "B2"), Value::Number(0.1));
}

/// The agent's side (spreadsheet-design §9): the scripted model opens the model, reads the
/// inputs, tries 9%, makes the change, traces what reads WACC and saves. In manual mode the
/// edit and the save are asked about; the tool results say what a model needs to know.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_agent_reads_tries_edits_and_saves_a_workbook() {
    let env = TestEnv::new("manual", "").await;
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let demux = Demux::spawn(incoming);
    let cwd = env.workspace("agent");
    let file = cwd.join("模型.xlsx");
    std::fs::write(&file, fixture()).unwrap();
    let session = client.request("session/new", json!({"cwd": cwd})).await.unwrap()["session_id"].as_str().unwrap().to_string();
    let mut events = demux.subscribe(&session);

    let turn = native_prompt(&client, &mut events, &session, "[[mock:sheet:模型.xlsx]] 把 WACC 调到 9% 看看估值", true).await;
    assert_eq!(turn.end["type"], "task_completed", "{:#?}", turn.events);
    assert_eq!(turn.approvals, 2, "doc_edit and doc_save are asked about");
    let results: Vec<String> = turn
        .events
        .iter()
        .filter(|e| e["type"] == "tool_completed")
        .map(|e| e["result"]["content"].as_array().unwrap().iter().filter_map(|c| c["text"].as_str()).collect::<String>())
        .collect();
    assert_eq!(results.len(), 6, "{results:#?}");
    let [opened, read, tried, edited, traced, saved] = &results[..] else { unreachable!() };
    assert!(opened.contains("a workbook: 假设, 利润表, 估值, 可比公司"), "{opened}");
    assert!(opened.contains("估值!D15 企业价值 = 6,121.33"), "{opened}");
    assert!(opened.contains("WSS("), "the Wind call is said to stand at its saved value: {opened}");
    assert!(read.contains("| 6 | WACC | 8.5% |"), "{read}");
    assert!(tried.contains("Tried, nothing was changed") && tried.contains("估值!D15 企业价值: 6,121.33 →"), "{tried}");
    assert!(edited.contains("Revision 1") && edited.contains("Note: WACC 上调到 9%") && edited.contains("Changed 假设!B6: 8.5% → 9.0%"), "{edited}");
    assert!(traced.contains("假设!B6 is read by:") && traced.contains("估值!C3"), "{traced}");
    assert!(saved.starts_with("Saved"), "{saved}");
    assert_eq!(on_disk(&file, "假设", "B6"), Value::Number(0.09));
}
