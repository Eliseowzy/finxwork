//! End-to-end: the native protocol over `finx serve --stdio` and `finx serve --listen unix://`.

mod common;

use common::Demux;
use common::SchemaCheck;
use common::TestEnv;
use common::assert_increasing;
use common::native_init;
use common::native_prompt;
use common::recv;
use finx_rpc::Client;
use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::time::Duration;
use tokio::net::UnixStream;

async fn new_session(client: &Client, cwd: &Path) -> (String, Value) {
    let result = client
        .request("session/new", json!({"cwd": cwd}))
        .await
        .expect("session/new");
    (result["session_id"].as_str().unwrap().to_string(), result["snapshot"].clone())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stdio_runs_a_full_session() {
    let env = TestEnv::new("manual", "").await;
    let schema = SchemaCheck::new(&[
        "InitializeResult",
        "SessionNewResult",
        "SnapshotResult",
        "TranscriptPage",
        "SessionListResult",
        "ModelsListResult",
        "Event",
    ]);
    let (mut child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    let init = client
        .request("initialize", json!({"protocol_version": 2, "client_info": {"name": "e2e"}}))
        .await
        .unwrap();
    schema.check("InitializeResult", &init);
    let demux = Demux::spawn(incoming);
    let cwd = env.workspace("a");
    let created = client.request("session/new", json!({"cwd": cwd})).await.unwrap();
    schema.check("SessionNewResult", &created);
    let session = created["session_id"].as_str().unwrap().to_string();
    let snapshot = created["snapshot"].clone();
    assert_eq!(snapshot["last_seq"], 0);
    assert_eq!(snapshot["session"]["model"], "mock/mock-1");
    assert_eq!(snapshot["session"]["cwd"], json!(cwd));
    let mut events = demux.subscribe(&session);
    // Listed before it does anything, although its log is written only then.
    let list = client.request("session/list", json!({"cwd": cwd})).await.unwrap();
    schema.check("SessionListResult", &list);
    assert_eq!(list["sessions"][0]["session_id"], json!(session));
    assert_eq!(list["sessions"][0]["loaded"], true);

    let turn = native_prompt(&client, &mut events, &session, "[[mock:files]] go", true).await;
    assert_eq!(turn.end["type"], "task_completed");
    assert_eq!(turn.end["reason"], "done");
    assert_eq!(turn.approvals, 1);
    assert_eq!(turn.events[0]["type"], "session_started", "the creator sees every event");
    assert_increasing(&turn.events);
    let titles: Vec<&str> = turn
        .events
        .iter()
        .filter(|e| e["type"] == "tool_started")
        .map(|e| e["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles, ["write notes.txt", "read notes.txt", "edit notes.txt"]);
    assert_eq!(std::fs::read_to_string(cwd.join("notes.txt")).unwrap(), "gamma\nbeta\n");
    for event in &turn.events {
        schema.check("Event", event);
    }

    // A second prompt in the same session, then the history pages.
    let turn = native_prompt(&client, &mut events, &session, "[[mock:think]] second", true).await;
    assert_eq!(turn.text, "Thought it through.");
    for event in &turn.events {
        schema.check("Event", event);
    }
    let attach = client
        .request("session/attach", json!({"session_id": session, "history_limit": 2}))
        .await
        .unwrap();
    schema.check("SnapshotResult", &attach);
    let page = &attach["snapshot"]["transcript"];
    assert_eq!(page["items"].as_array().unwrap().len(), 2);
    let history = client
        .request("session/history", json!({"session_id": session, "before": page["before"], "limit": 100}))
        .await
        .unwrap();
    assert!(history["items"].as_array().unwrap().len() >= 6);
    assert!(history.get("before").is_none());
    schema.check("TranscriptPage", &history);

    // Lists, models and errors.
    let list = client.request("session/list", json!({})).await.unwrap();
    schema.check("SessionListResult", &list);
    let entry = &list["sessions"][0];
    assert_eq!(entry["session_id"], json!(session));
    assert_eq!(entry["loaded"], true);
    let models = client.request("models/list", json!({})).await.unwrap();
    schema.check("ModelsListResult", &models);
    assert!(models["models"].as_array().unwrap().iter().any(|m| m["id"] == "mock/mock-1"));
    let err = client
        .request("session/op", json!({"session_id": session, "op": {"type": "approval", "call_id": "nope",
            "decision": {"type": "approve"}}}))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), Some("approval_not_pending"));

    client.request("session/close", json!({"session_id": session})).await.unwrap();
    let err = client
        .request("session/op", json!({"session_id": session, "op": {"type": "interrupt"}}))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), Some("session_not_loaded"));

    // Resume from disk: the transcript comes back, and the session works again. Subscribe
    // first, so the new instance's first event cannot reach the old subscription.
    drop(events);
    let mut events = demux.subscribe(&session);
    let resumed = client.request("session/resume", json!({"session_id": session})).await.unwrap();
    schema.check("SnapshotResult", &resumed);
    assert!(resumed["snapshot"]["transcript"]["items"].as_array().unwrap().len() >= 8);
    let turn = native_prompt(&client, &mut events, &session, "[[mock:bash:echo third]] go", true).await;
    assert_eq!(turn.text, "bash done");
    for event in &turn.events {
        schema.check("Event", event);
    }
    assert_eq!(turn.events[0]["type"], "session_started");
    assert_eq!(turn.events[0]["resumed"], true);

    drop(client);
    assert_eq!(common::exit_code(&mut child).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_session_without_a_project_works_in_a_folder_of_its_own() {
    let env = TestEnv::new("manual", "").await;
    let (mut child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let demux = Demux::spawn(incoming);
    let created = client.request("session/new", json!({})).await.unwrap();
    let session = created["session_id"].as_str().unwrap().to_string();
    let cwd = std::path::PathBuf::from(created["snapshot"]["session"]["cwd"].as_str().unwrap());
    let chats = std::fs::canonicalize(env.home.path().join("chats")).unwrap();
    assert_eq!(cwd.parent(), Some(chats.as_path()));
    assert_eq!(std::fs::read_dir(&cwd).unwrap().count(), 0, "made empty");
    let project = env.workspace("a");
    let (other, _) = new_session(&client, &project).await;

    let mut events = demux.subscribe(&session);
    let turn = native_prompt(&client, &mut events, &session, "[[mock:files]] go", true).await;
    assert_eq!(turn.end["reason"], "done");
    assert_eq!(std::fs::read_to_string(cwd.join("notes.txt")).unwrap(), "gamma\nbeta\n");
    let flags = |list: &Value| -> Vec<(String, bool)> {
        list["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| (s["session_id"].as_str().unwrap().to_string(), s["no_project"] == true))
            .collect()
    };
    let list = client.request("session/list", json!({})).await.unwrap();
    assert!(flags(&list).contains(&(session.clone(), true)), "loaded: {list}");
    assert!(flags(&list).contains(&(other.clone(), false)));
    // Read back from its log once closed, and again when resumed.
    client.request("session/close", json!({"session_id": session})).await.unwrap();
    let list = client.request("session/list", json!({})).await.unwrap();
    assert!(flags(&list).contains(&(session.clone(), true)), "on disk: {list}");
    client.request("session/resume", json!({"session_id": session})).await.unwrap();
    let list = client.request("session/list", json!({})).await.unwrap();
    assert!(flags(&list).contains(&(session.clone(), true)), "resumed: {list}");

    drop(client);
    assert_eq!(common::exit_code(&mut child).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stdio_rejects_bad_input_and_keeps_going() {
    let env = TestEnv::new("manual", "[server]\nmax_frame_bytes = 65536\n").await;
    let (mut child, client, _incoming) = env.spawn_rpc(&["serve"]);
    let err = client.request("session/list", json!({})).await.unwrap_err();
    assert_eq!(err.kind(), Some("not_initialized"));
    let err = client.request("initialize", json!({"protocol_version": 1})).await.unwrap_err();
    assert_eq!(err.code, finx_rpc::code::INVALID_PARAMS);
    assert_eq!(err.data.unwrap()["supported"], json!([2]), "version 1 predates the mode rename");
    native_init(&client).await;
    let err = client.request("no/such", json!({})).await.unwrap_err();
    assert_eq!(err.code, finx_rpc::code::METHOD_NOT_FOUND);
    let err = client.request("session/new", json!({"cwd": 5})).await.unwrap_err();
    assert_eq!(err.code, finx_rpc::code::INVALID_PARAMS);
    let err = client.request("session/new", json!({"cwd": "relative/dir"})).await.unwrap_err();
    assert_eq!(err.code, finx_rpc::code::INVALID_PARAMS);
    client.send_raw(b"{this is not json\n".to_vec());
    client.send_raw(format!("{{\"jsonrpc\":\"2.0\",\"method\":\"x\",\"params\":\"{}\"}}\n", "y".repeat(100_000)).into_bytes());
    let err = client
        .request("session/attach", json!({"session_id": "00000000-0000-0000-0000-000000000000"}))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), Some("session_not_found"));
    // Still serving after the malformed and oversized lines.
    let list = client.request("session/list", json!({})).await.unwrap();
    assert!(list["sessions"].as_array().unwrap().is_empty());
    drop(client);
    assert_eq!(common::exit_code(&mut child).await, 0);
}

fn write_file(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn names(list: &Value, field: &str) -> Vec<String> {
    list[field]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["name"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn skills_list_reports_a_session_and_a_directory() {
    let env = TestEnv::new("manual", "").await;
    let schema = SchemaCheck::new(&["SkillsListResult", "ContextReport"]);
    let report = env.user_home().join(".agents/skills/gen-report/SKILL.md");
    write_file(&report, "---\nname: gen-report\ndescription: Weekly report.\nargument-hint: \"[week]\"\n---\nbody\n");
    write_file(&env.user_home().join(".agents/skills/broken/SKILL.md"), "no header\n");
    let work = env.workspace("skills");
    write_file(
        &work.join(".agents/skills/lint/SKILL.md"),
        "---\nname: lint\ndescription: Lint rules.\ndisable-model-invocation: true\n---\nUse the house rules.\n",
    );
    let lint = work.join(".agents/skills/lint/SKILL.md");
    let (mut child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let demux = Demux::spawn(incoming);

    // A directory: what a session there would find, the same as `finx skills --all --json`.
    let scanned = client.request("skills/list", json!({"cwd": work})).await.unwrap();
    schema.check("SkillsListResult", &scanned);
    assert_eq!(names(&scanned, "skills"), ["lint", "broken", "gen-report"]);
    assert_eq!(scanned["skills"][1]["state"], "invalid");
    assert_eq!(scanned["catalog"]["listed"], 1, "lint is for the user only");
    let output = env.finx_in(&work, &["skills", "--all", "--json"]).output().await.unwrap();
    assert_eq!(scanned, serde_json::from_slice::<Value>(&output.stdout).unwrap());
    // Neither: what a session without a project would find, the user's own.
    let projectless = client.request("skills/list", json!({})).await.unwrap();
    assert_eq!(names(&projectless, "skills"), ["broken", "gen-report"]);

    // A session: the skills it started with and what `/` offers, built-in commands first.
    let (session, _) = new_session(&client, &work).await;
    let mut events = demux.subscribe(&session);
    let listed = client.request("skills/list", json!({"session_id": session})).await.unwrap();
    schema.check("SkillsListResult", &listed);
    assert_eq!(names(&listed, "skills"), ["lint", "gen-report"]);
    assert_eq!(names(&listed, "commands"), ["compact", "context", "skill:lint", "skill:gen-report"]);
    assert!(listed["commands"][0].get("skill").is_none());
    assert_eq!(listed["commands"][3]["hint"], "[week]");
    assert_eq!(listed["commands"][3]["skill"], json!(report));

    // What fills its context: the parts add up to the size, and with the free and the kept
    // room they fill the window. Its skill catalog lists the two skills.
    let context = client.request("session/context", json!({"session_id": session})).await.unwrap();
    schema.check("ContextReport", &context);
    let tokens = |v: &Value| v.as_u64().unwrap();
    let parts: Vec<(&str, u64)> = context["parts"].as_array().unwrap().iter().map(|p| (p["kind"].as_str().unwrap(), tokens(&p["tokens"]))).collect();
    assert_eq!(parts.iter().map(|(kind, _)| *kind).collect::<Vec<_>>(), ["messages", "system_prompt", "tools", "skills"]);
    assert!(parts.iter().skip(1).all(|(_, n)| *n > 0), "{parts:?}");
    let used = tokens(&context["usage"]["tokens"]);
    assert_eq!(parts.iter().map(|(_, n)| n).sum::<u64>(), used);
    assert_eq!(used + tokens(&context["free"]) + tokens(&context["reserved"]), tokens(&context["usage"]["window"]));
    let again = client.request("session/context", json!({"session_id": session})).await.unwrap();
    assert_eq!(again, context, "asked again with nothing changed, the same report");
    assert!(listed.get("catalog").is_none());

    // `/skill:name` and `/compact` through session/op, as in every front end.
    let typed = "this week, please: /skill:gen-report [[mock:invoked]], then /skill:lint";
    let turn = native_prompt(&client, &mut events, &session, typed, true).await;
    assert_eq!(turn.text, "invoked done");
    let user = turn
        .events
        .iter()
        .find(|e| e["type"] == "message_completed" && e["message"]["role"] == "user")
        .unwrap();
    assert_eq!(user["message"]["content"][0]["text"], typed, "the user's words, as written");
    assert_eq!(user["skills"], json!([{"name": "gen-report", "path": report}, {"name": "lint", "path": lint}]));
    let attached = client
        .request("session/attach", json!({"session_id": session, "history_limit": 100}))
        .await
        .unwrap();
    let items = attached["snapshot"]["transcript"]["items"].as_array().unwrap();
    let item = items.iter().find(|i| i["message"]["role"] == "user").unwrap();
    assert_eq!((&item["message"]["content"][0]["text"], &item["skills"]), (&json!(typed), &user["skills"]));
    let turn = native_prompt(&client, &mut events, &session, "/compact", true).await;
    assert_eq!(turn.end["type"], "task_completed");
    let compacted = turn.events.iter().find(|e| e["type"] == "compaction_completed").unwrap();
    assert_eq!(compacted["kept_skills"], json!(["lint", "gen-report"]), "mentioned last, used last");
    // The instructions the compaction kept count as skills, beside the catalog.
    let skills = |report: &Value| report["parts"].as_array().unwrap().iter().find(|p| p["kind"] == "skills").unwrap()["tokens"].as_u64().unwrap();
    let after = client.request("session/context", json!({"session_id": session})).await.unwrap();
    assert!(skills(&after) > skills(&context), "{} then {}", skills(&context), skills(&after));

    // Still the session's skills after files change; descriptions are read again.
    write_file(&env.user_home().join(".agents/skills/late/SKILL.md"), "---\nname: late\ndescription: Late.\n---\n");
    write_file(&report, "---\nname: gen-report\ndescription: Edited.\n---\nbody\n");
    let listed = client.request("skills/list", json!({"session_id": session})).await.unwrap();
    assert_eq!(names(&listed, "commands"), ["compact", "context", "skill:lint", "skill:gen-report"]);
    assert_eq!(listed["commands"][3]["description"], "Edited.");

    for (params, kind) in [
        (json!({"cwd": "relative/dir"}), "invalid_params"),
        (json!({"session_id": "00000000-0000-0000-0000-000000000000"}), "session_not_found"),
    ] {
        let err = client.request("skills/list", params).await.unwrap_err();
        assert_eq!(err.kind(), Some(kind));
    }
    drop(client);
    assert_eq!(common::exit_code(&mut child).await, 0);
}

async fn connect(path: &Path) -> (Client, finx_rpc::IncomingRx) {
    let stream = UnixStream::connect(path).await.expect("connect");
    let (read, write) = stream.into_split();
    let (client, incoming) = Client::connect(read, write);
    native_init(&client).await;
    (client, incoming)
}

async fn wait_for_socket(path: &Path) {
    for _ in 0..200 {
        if UnixStream::connect(path).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the service did not start");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unix_service_shares_sessions_between_clients() {
    let env = TestEnv::new("manual", "").await;
    let socket = env.home.path().join("run").join("t.sock");
    let url = format!("unix://{}", socket.display());
    let mut service = env.finx(&["serve", "--listen", &url]).spawn().unwrap();
    wait_for_socket(&socket).await;

    // A second service on the same socket refuses to start.
    let second = env.finx(&["serve", "--listen", &url]).output().await.unwrap();
    assert_ne!(second.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&second.stderr).contains("already listening"));

    let (a, a_in) = connect(&socket).await;
    let a_demux = Demux::spawn(a_in);
    let cwd = env.workspace("shared");
    let (session, _) = new_session(&a, &cwd).await;
    let mut a_events = a_demux.subscribe(&session);
    a.request("session/op", json!({"session_id": session, "op": {"type": "prompt",
        "input": [{"type": "text", "text": "[[mock:bash:touch shared.txt]] run"}]}}))
        .await
        .unwrap();
    let call_id = loop {
        let msg = recv(&mut a_events).await;
        let event = &msg.params()["event"];
        if event["type"] == "approval_requested" {
            break event["call_id"].as_str().unwrap().to_string();
        }
    };

    // Client B attaches mid-task: the snapshot shows the pending approval, and B answers it.
    let (b, b_in) = connect(&socket).await;
    let b_demux = Demux::spawn(b_in);
    let attach = b.request("session/attach", json!({"session_id": session})).await.unwrap();
    let pending = &attach["snapshot"]["active_task"]["approvals"];
    assert_eq!(pending[0]["call_id"], json!(call_id));
    let mut b_events = b_demux.subscribe(&session);
    b.request("session/op", json!({"session_id": session, "op": {"type": "approval", "call_id": call_id,
        "decision": {"type": "approve"}}}))
        .await
        .unwrap();
    let late = a
        .request("session/op", json!({"session_id": session, "op": {"type": "approval", "call_id": call_id,
            "decision": {"type": "deny"}}}))
        .await
        .unwrap_err();
    assert_eq!(late.kind(), Some("approval_not_pending"));
    for events in [&mut a_events, &mut b_events] {
        loop {
            let msg = recv(events).await;
            let event = &msg.params()["event"];
            if event["type"] == "approval_resolved" {
                assert_eq!(event["decision"]["type"], "approve");
            }
            if event["type"] == "task_completed" {
                break;
            }
        }
    }

    // A leaves; the session stays loaded and B keeps working with it.
    drop(a);
    drop(a_events);
    let turn = native_prompt(&b, &mut b_events, &session, "[[mock:echo]] after a left", true).await;
    assert_eq!(turn.text, "echo: after a left");

    // A comes back and catches up from a snapshot.
    let (a, _a_in) = connect(&socket).await;
    let attach = a.request("session/attach", json!({"session_id": session})).await.unwrap();
    let items = attach["snapshot"]["transcript"]["items"].as_array().unwrap();
    let texts: Vec<String> = items
        .iter()
        .filter(|i| i["type"] == "message")
        .flat_map(|i| i["message"]["content"].as_array().cloned().unwrap_or_default())
        .filter_map(|c| c["text"].as_str().map(str::to_string))
        .collect();
    assert!(texts.iter().any(|t| t == "echo: after a left"), "{texts:?}");
    let list = a.request("session/list", json!({"cwd": cwd})).await.unwrap();
    assert_eq!(list["sessions"][0]["attached_clients"], 2);

    a.request("server/shutdown", json!({})).await.unwrap();
    assert_eq!(common::exit_code(&mut service).await, 0);
    assert!(!socket.exists(), "the socket is removed on exit");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_session_is_open_in_one_process_at_a_time() {
    let env = TestEnv::new("bypass-permissions", "").await;
    let (mut first, a, a_in) = env.spawn_rpc(&["serve"]);
    native_init(&a).await;
    let demux = Demux::spawn(a_in);
    let (session, _) = new_session(&a, &env.workspace("locked")).await;
    let mut events = demux.subscribe(&session);
    native_prompt(&a, &mut events, &session, "[[mock:echo]] hold", false).await;

    let (mut second, b, _b_in) = env.spawn_rpc(&["serve"]);
    native_init(&b).await;
    let err = b.request("session/resume", json!({"session_id": session})).await.unwrap_err();
    assert_eq!(err.kind(), Some("session_busy"));
    drop(b);
    assert_eq!(common::exit_code(&mut second).await, 0);

    // Once the first process closes it, another one can resume it.
    a.request("session/close", json!({"session_id": session})).await.unwrap();
    let (mut third, c, _c_in) = env.spawn_rpc(&["serve"]);
    native_init(&c).await;
    c.request("session/resume", json!({"session_id": session})).await.unwrap();
    drop((a, c));
    assert_eq!(common::exit_code(&mut first).await, 0);
    assert_eq!(common::exit_code(&mut third).await, 0);
}

/// The next `sessions/changed` on a connection that only follows the list.
async fn next_change(incoming: &mut finx_rpc::IncomingRx) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(10), incoming.recv())
            .await
            .expect("timed out waiting for sessions/changed")
            .expect("connection closed");
        if msg.method() == "sessions/changed" {
            return msg.params().clone();
        }
    }
}

/// Changes until one matches, returning the summaries of `session` seen on the way.
async fn changes_until(incoming: &mut finx_rpc::IncomingRx, session: &str, done: impl Fn(&Value) -> bool) -> Vec<Value> {
    let mut seen = Vec::new();
    loop {
        let change = next_change(incoming).await;
        for summary in change["sessions"].as_array().unwrap() {
            if summary["session_id"] == session {
                seen.push(summary.clone());
                if done(summary) {
                    return seen;
                }
            }
        }
    }
}

/// What the desktop app does with the service (desktop-kernel-integration.md): find it by its
/// record, follow the session list, run a task, rename, archive, resume, save a key, delete.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_desktop_flow_over_the_socket() {
    let env = TestEnv::new("manual", "").await;
    let schema = SchemaCheck::new(&["SessionListResult", "SessionsChangedParams", "ModelsListResult", "SnapshotResult"]);
    let socket = env.home.path().join("run").join("finx.sock");
    let url = format!("unix://{}", socket.display());
    let mut service = env
        .finx(&["serve", "--listen", &url, "--idle-exit", "600"])
        .env_remove("DEEPSEEK_API_KEY")
        .spawn()
        .unwrap();
    wait_for_socket(&socket).await;

    // The service record sits in the lock file, and a second service leaves it alone.
    let lock = socket.with_extension("lock");
    let record: Value = serde_json::from_str(&std::fs::read_to_string(&lock).unwrap()).unwrap();
    assert_eq!(record["protocol_version"], 2);
    assert_eq!(record["socket"], json!(socket));
    assert_eq!(record["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(record["pid"].as_u64(), service.id().map(u64::from));
    let second = env.finx(&["serve", "--listen", &url]).output().await.unwrap();
    assert_ne!(second.status.code(), Some(0));
    assert_eq!(std::fs::read_to_string(&lock).unwrap().trim(), serde_json::to_string(&record).unwrap());

    // A connection that follows the list, as the desktop's window does.
    let (watch, mut watch_in) = connect(&socket).await;
    let list = watch.request("sessions/subscribe", json!({})).await.unwrap();
    schema.check("SessionListResult", &list);
    assert!(list["sessions"].as_array().unwrap().is_empty());

    // Another connection starts a task; the follower sees the row change state.
    let (a, a_in) = connect(&socket).await;
    let demux = Demux::spawn(a_in);
    let cwd = env.workspace("desk");
    let (session, _) = new_session(&a, &cwd).await;
    let mut events = demux.subscribe(&session);
    let turn = native_prompt(&a, &mut events, &session, "[[mock:bash:touch d.txt]] make the file", true).await;
    assert_eq!(turn.end["type"], "task_completed");
    let rows = changes_until(&mut watch_in, &session, |s| s["state"] == "idle" && s["preview"].is_string()).await;
    let states: Vec<&str> = rows.iter().map(|s| s["state"].as_str().unwrap()).collect();
    assert!(states.contains(&"running") && states.contains(&"awaiting_approval"), "{states:?}");
    let last = rows.last().unwrap();
    assert_eq!(last["preview"], "[[mock:bash:touch d.txt]] make the file");
    assert_eq!(last["model"], "mock/mock-1");
    assert_eq!(last["loaded"], true);
    assert!(last.get("task_started_at").is_none());

    // Nothing below runs a task, so the row's last activity stays put: renaming, closing,
    // archiving and opening a session are not activity. (Times are to the second, so wait one.)
    let active = last["updated_at"].clone();
    let unmoved = |rows: &[Value]| assert!(rows.iter().all(|s| s["updated_at"] == active), "{rows:?} moved from {active}");
    tokio::time::sleep(Duration::from_millis(1100)).await;

    // Rename while loaded: the kernel records it and attached clients hear it too.
    a.request("session/rename", json!({"session_id": session, "title": "  Desk \n work  "}))
        .await
        .unwrap();
    unmoved(&changes_until(&mut watch_in, &session, |s| s["title"] == "Desk work").await);
    loop {
        let msg = recv(&mut events).await;
        if msg.params()["event"]["type"] == "title_changed" {
            assert_eq!(msg.params()["event"]["title"], "Desk work");
            break;
        }
    }
    let err = a.request("session/rename", json!({"session_id": session, "title": "  "})).await.unwrap_err();
    assert_eq!(err.code, finx_rpc::code::INVALID_PARAMS);

    // Closed, then archived from its log; the list keeps the title and the state.
    a.request("session/close", json!({"session_id": session})).await.unwrap();
    unmoved(&changes_until(&mut watch_in, &session, |s| s["loaded"] == false).await);
    watch.request("session/archive", json!({"session_id": session})).await.unwrap();
    let change = changes_until(&mut watch_in, &session, |s| s["archived"] == true).await;
    schema.check("SessionsChangedParams", &json!({"sessions": change}));
    unmoved(&change);
    let list = watch.request("session/list", json!({})).await.unwrap();
    let row = &list["sessions"][0];
    assert_eq!((&row["title"], &row["archived"], &row["state"], &row["loaded"]), (&json!("Desk work"), &json!(true), &json!("idle"), &json!(false)));
    unmoved(std::slice::from_ref(row));

    // Resumed: the snapshot has the metadata and where the task ended, with its usage.
    let resumed = a.request("session/resume", json!({"session_id": session})).await.unwrap();
    schema.check("SnapshotResult", &resumed);
    let snapshot = &resumed["snapshot"];
    assert_eq!(snapshot["session"]["title"], "Desk work");
    assert_eq!(snapshot["session"]["archived"], true);
    let end = snapshot["transcript"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["type"] == "task_end")
        .expect("a task_end item");
    assert_eq!((&end["task_id"], &end["outcome"], &end["reason"]), (&json!("t1"), &json!("completed"), &json!("done")));
    assert!(end["usage"]["per_model"].is_object());
    watch.request("session/unarchive", json!({"session_id": session})).await.unwrap();
    unmoved(&changes_until(&mut watch_in, &session, |s| s["archived"] == false && s["loaded"] == true).await);
    let list = watch.request("session/list", json!({})).await.unwrap();
    unmoved(std::slice::from_ref(&list["sessions"][0]));

    // Models, defaults and keys: a key saved through the protocol makes the provider available.
    let models = watch.request("models/list", json!({})).await.unwrap();
    schema.check("ModelsListResult", &models);
    assert_eq!(models["defaults"]["model"], "mock/mock-1");
    assert_eq!(models["defaults"]["permission_mode"], "manual");
    let provider = |models: &Value, id: &str| {
        models["providers"].as_array().unwrap().iter().find(|p| p["id"] == id).cloned().unwrap()
    };
    assert_eq!(provider(&models, "mock")["credential"], "not_required");
    let deepseek = provider(&models, "deepseek");
    assert_eq!((&deepseek["auth"], &deepseek["credential"]), (&json!("api_key"), &json!("missing")));
    let err = watch.request("auth/set", json!({"provider": "mock", "api_key": "x"})).await.unwrap_err();
    assert_eq!(err.code, finx_rpc::code::INVALID_PARAMS);
    watch
        .request("auth/set", json!({"provider": "deepseek", "api_key": "sk-test-123"}))
        .await
        .unwrap();
    let models = watch.request("models/list", json!({})).await.unwrap();
    assert_eq!(provider(&models, "deepseek")["credential"], "stored");
    assert!(models["models"].as_array().unwrap().iter().any(|m| m["provider"] == "deepseek" && m["available"] == true));
    assert!(!models.to_string().contains("sk-test-123"), "keys never leave the service");
    let saved = env.home.path().join("credentials.toml");
    assert!(std::fs::read_to_string(&saved).unwrap().contains("sk-test-123"));
    watch.request("auth/delete", json!({"provider": "deepseek"})).await.unwrap();
    let models = watch.request("models/list", json!({})).await.unwrap();
    assert_eq!(provider(&models, "deepseek")["credential"], "missing");

    // Deleted while loaded: closed first, and the follower is told.
    watch.request("session/delete", json!({"session_id": session})).await.unwrap();
    loop {
        let change = next_change(&mut watch_in).await;
        if change["deleted"] == json!([session]) {
            break;
        }
    }

    watch.request("server/shutdown", json!({})).await.unwrap();
    assert_eq!(common::exit_code(&mut service).await, 0);
    assert!(!lock.exists(), "the record goes with the service");
}

/// Waits until `session/list` shows each session loaded or not; unloading finishes in the
/// background.
async fn wait_loaded(client: &Client, expected: &[(&str, bool)]) {
    for _ in 0..250 {
        let list = client.request("session/list", json!({})).await.unwrap();
        let loaded = |id: &str| {
            list["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["session_id"] == id)
                .map(|s| s["loaded"] == true)
        };
        if expected.iter().all(|(id, want)| loaded(id) == Some(*want)) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the sessions never became {expected:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_full_server_unloads_the_session_unused_the_longest() {
    let env = TestEnv::new("bypass-permissions", "[server]\nmax_sessions = 3\n").await;
    let (mut child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let demux = Demux::spawn(incoming);
    let cwd = env.workspace("full");
    let (a, _) = new_session(&client, &cwd).await;
    let (b, _) = new_session(&client, &cwd).await;
    let (c, _) = new_session(&client, &cwd).await;
    let mut b_events = demux.subscribe(&b);
    let turn = native_prompt(&client, &mut b_events, &b, "[[mock:echo]] keep me", true).await;
    assert_eq!(turn.text, "echo: keep me");

    // A client is attached to every session: no room.
    let full = client.request("session/new", json!({"cwd": cwd})).await.unwrap_err();
    assert_eq!(full.kind(), Some("server_full"));

    // B has gone unused longer than A, so B makes room first, then A.
    client.request("session/detach", json!({"session_id": b})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    client.request("session/detach", json!({"session_id": a})).await.unwrap();
    let (d, _) = new_session(&client, &cwd).await;
    wait_loaded(&client, &[(&b, false), (&a, true), (&c, true), (&d, true)]).await;
    let (e, _) = new_session(&client, &cwd).await;
    wait_loaded(&client, &[(&a, false), (&e, true)]).await;
    let full = client.request("session/new", json!({"cwd": cwd})).await.unwrap_err();
    assert_eq!(full.kind(), Some("server_full"));
    let full = client.request("session/resume", json!({"session_id": b})).await.unwrap_err();
    assert_eq!(full.kind(), Some("server_full"));

    // Once C is unused, resuming B takes its place, with its history.
    client.request("session/detach", json!({"session_id": c})).await.unwrap();
    let resumed = client.request("session/resume", json!({"session_id": b})).await.unwrap();
    let texts: Vec<String> = resumed["snapshot"]["transcript"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["type"] == "message")
        .flat_map(|i| i["message"]["content"].as_array().cloned().unwrap_or_default())
        .filter_map(|c| c["text"].as_str().map(str::to_string))
        .collect();
    assert!(texts.iter().any(|t| t == "echo: keep me"), "{texts:?}");
    wait_loaded(&client, &[(&c, false), (&b, true)]).await;

    client.request("server/shutdown", json!({})).await.unwrap();
    assert_eq!(common::exit_code(&mut child).await, 0);
}

/// A model whose connection is gone (desktop-design P15): a new session asked for it gets
/// `model_unavailable` naming the provider, so a client can say so in its own words; a session
/// that last used it opens on the configured model.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_model_whose_connection_is_gone_is_reported_as_unavailable() {
    let env = TestEnv::new("manual", "").await;
    let connection = "35e57942-0000-4000-8000-000000000001";
    // Written before provider IDs were kept: its models are published as `local-<connection_id>`.
    std::fs::create_dir_all(env.home.path().join("connections")).unwrap();
    write_file(
        &env.home.path().join("connections/config.json"),
        &json!({"schema": 1, "connections": [{
            "connection_id": connection, "adapter_id": "qwenwork", "identity_key": "account-a",
            "enabled": true, "idempotency_key": "e2e",
            "models": [{"id": "flash", "name": "Flash", "context_window": 1000000, "max_output_tokens": null}]
        }]})
        .to_string(),
    );
    let flash = format!("local-{connection}/flash");
    let (mut child, client, _incoming) = env.spawn_rpc(&["serve"]);
    native_init(&client).await;
    let models = client.request("models/list", json!({})).await.unwrap();
    assert!(models["models"].as_array().unwrap().iter().any(|m| m["id"] == json!(flash)));
    let cwd = env.workspace("gone");
    let used = client.request("session/new", json!({"cwd": cwd, "model": flash})).await.unwrap();
    let used = used["session_id"].as_str().unwrap().to_string();
    client.request("session/close", json!({"session_id": used})).await.unwrap();

    client.request("connections/disconnect", json!({"connection_id": connection})).await.unwrap();
    let models = client.request("models/list", json!({})).await.unwrap();
    assert!(!models["models"].as_array().unwrap().iter().any(|m| m["id"] == json!(flash)));
    let err = client.request("session/new", json!({"cwd": cwd, "model": flash})).await.unwrap_err();
    assert_eq!(err.code, finx_protocol::api::error_code::MODEL_UNAVAILABLE);
    assert_eq!(err.kind(), Some("model_unavailable"));
    assert_eq!(err.data.as_ref().unwrap()["provider"], json!(format!("local-{connection}")));
    // A reference that is not one stays a parameter error.
    let err = client.request("session/new", json!({"cwd": cwd, "model": "flash"})).await.unwrap_err();
    assert_eq!(err.kind(), Some("invalid_params"));
    // The session that used it opens on the configured model.
    let resumed = client.request("session/resume", json!({"session_id": used})).await.unwrap();
    assert_eq!(resumed["snapshot"]["session"]["model"], json!("mock/mock-1"));
    drop(client);
    assert_eq!(common::exit_code(&mut child).await, 0);
}
