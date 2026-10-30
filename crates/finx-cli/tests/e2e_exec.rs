//! End-to-end: `finx exec` in text, JSON-events and ops-on-stdin modes, against the mock model.

mod common;

use common::SchemaCheck;
use common::TestEnv;
use common::assert_increasing;
use serde_json::Value;
use serde_json::json;
use std::process::Stdio;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;

/// Runs finx and returns its exit code and JSON lines, each checked against the `Event` schema.
async fn json_lines(env: &TestEnv, args: &[&str]) -> (i32, Vec<Value>) {
    let output = env.finx(args).output().await.expect("run finx");
    let events: Vec<Value> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("not JSON ({e}): {l}")))
        .collect();
    let schema = SchemaCheck::new(&["Event"]);
    for event in &events {
        schema.check("Event", event);
    }
    (output.status.code().unwrap_or(-1), events)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn protocol_schema_prints_the_document() {
    let env = TestEnv::new("manual", "").await;
    let output = env.finx(&["protocol", "schema"]).output().await.unwrap();
    assert_eq!(output.status.code(), Some(0));
    let printed: Value = serde_json::from_slice(&output.stdout).expect("JSON on stdout");
    assert!(printed == finx_protocol::schema::document());
    assert_eq!(printed["x-methods"]["session/op"]["params"], "SessionOpParams");
    // An operation in the shape `--ops-stdin` and `session/op` take is valid.
    let ops = SchemaCheck::new(&["Op"]);
    ops.check("Op", &json!({"type": "approval", "call_id": "c1", "decision": {"type": "deny", "feedback": "no"}}));
    ops.check("Op", &json!({"type": "prompt", "input": [{"type": "text", "text": "hi"}], "mode": "follow_up"}));
}

fn of_type<'a>(events: &'a [Value], kind: &str) -> Vec<&'a Value> {
    events.iter().filter(|e| e["type"] == kind).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exec_text_prints_the_streamed_reply() {
    let env = TestEnv::new("bypass-permissions", "").await;
    let output = env.finx(&["exec", "say hi"]).output().await.unwrap();
    assert_eq!(output.status.code(), Some(0), "stderr: {}", String::from_utf8_lossy(&output.stderr));
    assert!(String::from_utf8_lossy(&output.stdout).contains("Hello from mock."));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exec_json_emits_enriched_tool_events() {
    let env = TestEnv::new("bypass-permissions", "").await;
    let (code, events) = json_lines(&env, &["exec", "--json", "[[mock:bash:echo e2e-marker]] run it"]).await;
    assert_eq!(code, 0);
    assert_increasing(&events);
    let started = of_type(&events, "session_started");
    assert_eq!(started[0]["model"], "mock/mock-1");
    assert_eq!(started[0]["context_window"], 200000);
    assert_eq!(started[0]["permission_mode"], "bypass-permissions");
    let tool = of_type(&events, "tool_started")[0];
    assert_eq!(tool["category"], "execute");
    assert_eq!(tool["title"], "echo e2e-marker");
    assert_eq!(of_type(&events, "tool_running").len(), 1);
    let done = of_type(&events, "tool_completed")[0];
    assert!(done["result"]["content"][0]["text"].as_str().unwrap().contains("e2e-marker"));
    let end = events.last().unwrap();
    assert_eq!(end["type"], "session_closed");
    let completed = of_type(&events, "task_completed")[0];
    assert_eq!(completed["reason"], "done");
    assert_eq!(completed["last_message"], "bash done");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exec_ops_stdin_answers_approvals() {
    let env = TestEnv::new("manual", "").await;
    let mut child = env
        .finx(&["exec", "--json", "--ops-stdin", "[[mock:files]] edit notes"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut approvals = 0;
    let mut events = Vec::new();
    while let Some(line) = lines.next_line().await.unwrap() {
        let event: Value = serde_json::from_str(&line).unwrap();
        if event["type"] == "approval_requested" {
            approvals += 1;
            let op = json!({"type": "approval", "call_id": event["call_id"], "decision": {"type": "approve_for_session"}});
            stdin.write_all(format!("{op}\n").as_bytes()).await.unwrap();
            stdin.flush().await.unwrap();
        }
        events.push(event);
    }
    assert_eq!(common::exit_code(&mut child).await, 0);
    // The write asks; after "always for this session" the edit does not.
    assert_eq!(approvals, 1);
    assert_eq!(of_type(&events, "approval_resolved").len(), 1);
    assert_eq!(of_type(&events, "tool_completed").len(), 3);
    assert_eq!(std::fs::read_to_string(env.work().join("notes.txt")).unwrap(), "gamma\nbeta\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exec_reports_retries_failures_and_cutoffs() {
    let env = TestEnv::new("bypass-permissions", "").await;
    let (code, events) = json_lines(&env, &["exec", "--json", "[[mock:retry]] once"]).await;
    assert_eq!(code, 0);
    assert_eq!(of_type(&events, "stream_retry").len(), 1);
    assert_eq!(of_type(&events, "task_completed")[0]["last_message"], "recovered after a retry");

    let (code, events) = json_lines(&env, &["exec", "--json", "[[mock:fail]] please"]).await;
    assert_eq!(code, 1);
    let failed = of_type(&events, "task_failed");
    assert_eq!(failed.len(), 1);
    assert!(failed[0]["error"]["message"].as_str().unwrap().contains("mock rejects"));

    let (code, events) = json_lines(&env, &["exec", "--json", "[[mock:cut]] long answer"]).await;
    assert_eq!(code, 0);
    assert_eq!(of_type(&events, "task_completed")[0]["reason"], "output_limit");

    let (code, events) = json_lines(&env, &["exec", "--json", "--max-turns", "2", "[[mock:loop:5]] spin"]).await;
    assert_eq!(code, 0);
    assert_eq!(of_type(&events, "task_completed")[0]["reason"], "max_turns");
}
