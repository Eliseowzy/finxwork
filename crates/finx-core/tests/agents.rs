//! Sub-agents end to end: a scripted model per session, real tools, real session logs.
//!
//! Sessions run concurrently, so each one gets its own queue of scripts ("lane"), picked by
//! the first message of the request: a sub-agent's starts with its name.

use finx_core::Config;
use finx_core::FinxHome;
use finx_core::JsonlStore;
use finx_core::Kernel;
use finx_core::KernelDeps;
use finx_core::SessionRef;
use finx_core::SessionStore;
use finx_core::StartOptions;
use finx_core::store::EntryKind;
use finx_llm::Catalog;
use finx_llm::Context;
use finx_llm::Message;
use finx_llm::ModelRegistry;
use finx_llm::RegistryOptions;
use finx_llm::ThinkingLevel;
use finx_llm::api::scripted::Script;
use finx_llm::api::scripted::ScriptedApi;
use finx_protocol::AgentStatus;
use finx_protocol::Event;
use finx_protocol::EventMsg;
use finx_protocol::Op;
use finx_protocol::PermissionMode;
use finx_protocol::TaskTrigger;
use finx_tools::BashTool;
use finx_tools::LocalEnvironment;
use finx_tools::builtin_registry;
use parking_lot::Mutex;
use serde_json::json;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use tempfile::TempDir;

const ROOT: &str = "root";

#[derive(Default)]
struct Lanes(Mutex<HashMap<String, VecDeque<Script>>>);

impl Lanes {
    fn push(&self, lane: &str, script: Script) {
        self.0.lock().entry(lane.to_string()).or_default().push_back(script);
    }
}

/// The session a request comes from: a sub-agent's name, or `root`.
fn lane_of(context: &Context) -> String {
    let first = context.messages.iter().find_map(|m| match m {
        Message::User(u) => Some(u.text_content()),
        _ => None,
    });
    first
        .and_then(|text| {
            text.strip_prefix("You are a sub-agent named \"")
                .and_then(|rest| rest.split('"').next())
                .map(str::to_string)
        })
        .unwrap_or_else(|| ROOT.to_string())
}

struct Harness {
    kernel: Kernel,
    api: Arc<ScriptedApi>,
    lanes: Arc<Lanes>,
    work: PathBuf,
    home: FinxHome,
    _dir: TempDir,
}

impl Harness {
    async fn start(mode: PermissionMode, interactive: bool) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        let home = FinxHome::new(dir.path().join("home"));
        home.ensure().unwrap();
        let api = ScriptedApi::new();
        let lanes = Arc::new(Lanes::default());
        let routed = lanes.clone();
        api.respond_with(move |context| routed.0.lock().get_mut(&lane_of(context))?.pop_front());
        let deps = deps(&api, &work, &home);
        let options = StartOptions {
            model: "test/scripted".into(),
            thinking: ThinkingLevel::Off,
            permission_mode: mode,
            cwd: work.clone(),
            home: home.clone(),
            config: Arc::new(Config::default()),
            project_root: None,
            trusted: false,
            interactive_approvals: interactive,
        };
        let kernel = Kernel::start(options, deps).await.unwrap();
        Harness {
            kernel,
            api,
            lanes,
            work,
            home,
            _dir: dir,
        }
    }

    fn script(&self, lane: &str, script: Script) {
        self.lanes.push(lane, script);
    }

    /// Requests from one session, oldest first.
    fn requests(&self, lane: &str) -> Vec<Context> {
        self.api
            .calls()
            .into_iter()
            .filter(|call| lane_of(&call.context) == lane)
            .map(|call| call.context)
            .collect()
    }

    async fn prompt(&mut self, text: &str) {
        self.kernel.submit(Op::prompt(text)).await.unwrap();
    }

    async fn until(&mut self, stop: impl Fn(&EventMsg) -> bool) -> Vec<Event> {
        let mut events = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let event = tokio::time::timeout(remaining, self.kernel.next_event())
                .await
                .expect("timed out waiting for an event")
                .expect("session closed");
            let done = stop(&event.msg);
            events.push(event);
            if done {
                return events;
            }
        }
    }

    async fn until_idle(&mut self) -> Vec<Event> {
        self.until(|m| matches!(m, EventMsg::Idle)).await
    }

    fn store(&self) -> JsonlStore {
        JsonlStore::new(self.home.sessions_dir())
    }
}

fn deps(api: &Arc<ScriptedApi>, work: &std::path::Path, home: &FinxHome) -> KernelDeps {
    let mut registry = ModelRegistry::new(Catalog::default(), RegistryOptions::default());
    registry.register_api(api.clone());
    registry.insert_provider(ScriptedApi::provider());
    KernelDeps {
        llm: Arc::new(registry),
        tools: Arc::new(builtin_registry(BashTool::default())),
        env: Arc::new(LocalEnvironment::new(work.to_path_buf())),
        store: Arc::new(JsonlStore::new(home.sessions_dir())),
        hooks: vec![],
        mcp_servers: Vec::new(),
        browser_pool: None,
    }
}

fn spawn(id: &str, name: &str, task: &str, wait: bool) -> Script {
    Script::tool_call(id, "spawn_agent", json!({ "description": format!("{name} work"), "task": task, "name": name, "wait": wait }))
}

fn user_texts(context: &Context) -> Vec<String> {
    context
        .messages
        .iter()
        .filter_map(|m| match m {
            Message::User(u) => Some(u.text_content()),
            _ => None,
        })
        .collect()
}

fn tool_results(context: &Context) -> Vec<String> {
    context
        .messages
        .iter()
        .filter_map(|m| match m {
            Message::ToolResult(r) => Some(r.text_content()),
            _ => None,
        })
        .collect()
}

fn agent_ids(events: &[Event]) -> Vec<(String, String, PathBuf)> {
    events
        .iter()
        .filter_map(|e| match &e.msg {
            EventMsg::AgentStarted {
                agent_id,
                name,
                session_file,
                ..
            } => Some((agent_id.clone(), name.clone(), session_file.clone())),
            _ => None,
        })
        .collect()
}

fn mails(events: &[Event]) -> Vec<(String, AgentStatus)> {
    events
        .iter()
        .filter_map(|e| match &e.msg {
            EventMsg::MessageCompleted { mail: Some(mail), .. } => Some((mail.from.name.clone(), mail.status)),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_background_agent_reports_and_wakes_the_main_agent() {
    let mut h = Harness::start(PermissionMode::BypassPermissions, false).await;
    h.script(ROOT, spawn("c1", "counter", "Count the files.", false));
    h.script(ROOT, Script::text("I started an agent to count the files."));
    h.script(ROOT, Script::text("The agent counted 3 files."));
    h.script("counter", Script::text("3 files").then_sleep(Duration::from_millis(200)));
    h.prompt("how many files?").await;
    let events = h.until_idle().await;

    // The main task ends while the agent works; its report starts a second task.
    let triggers: Vec<TaskTrigger> = events
        .iter()
        .filter_map(|e| match &e.msg {
            EventMsg::TaskStarted { trigger, .. } => Some(*trigger),
            _ => None,
        })
        .collect();
    assert_eq!(triggers, [TaskTrigger::User, TaskTrigger::Mail]);
    assert_eq!(mails(&events), [("counter".to_string(), AgentStatus::Completed)]);
    let last = events.iter().rev().find_map(|e| match &e.msg {
        EventMsg::TaskCompleted { last_message, .. } => last_message.clone(),
        _ => None,
    });
    assert_eq!(last.as_deref(), Some("The agent counted 3 files."));
    assert!(matches!(events.last().unwrap().msg, EventMsg::Idle));

    // The tool returned at once; the report reached the model as a user message.
    let root = h.requests(ROOT);
    assert_eq!(root.len(), 3);
    assert!(tool_results(&root[1])[0].starts_with("Agent \"counter\" started in the background"));
    let report = user_texts(&root[2]).pop().unwrap();
    assert_eq!(report, "<agent_report agent=\"counter\" status=\"completed\">\n3 files\n</agent_report>");

    // The sub-agent got the task, with who it is and how to report.
    let child = h.requests("counter");
    let task = &user_texts(&child[0])[0];
    assert!(task.contains("Count the files."), "{task}");
    assert!(task.contains("Markdown report"), "{task}");
    assert_eq!(child[0].system, root[0].system, "same system prompt");
    let child_tools: Vec<&str> = child[0].tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(child_tools, ["read", "write", "edit", "bash"], "no agent tools for a sub-agent");

    // The label the user sees comes with its start and stays in the main session's log.
    let label = events.iter().find_map(|e| match &e.msg {
        EventMsg::AgentStarted { description, .. } => Some(description.clone()),
        _ => None,
    });
    assert_eq!(label.as_deref(), Some("counter work"));
    let log = std::fs::read_to_string(h.kernel.session_file()).unwrap();
    assert!(log.lines().any(|l| l.contains("\"agent_spawned\"") && l.contains("\"description\":\"counter work\"")), "{log}");

    // Its session is an ordinary log that names the parent, but it is not listed.
    let (agent_id, _, file) = agent_ids(&events).pop().unwrap();
    let store = h.store();
    let (header, _) = store.header(&SessionRef::Path(file)).unwrap();
    let origin = header.agent.expect("a sub-agent's header names its parent");
    assert_eq!(origin.name, "counter");
    assert_eq!(origin.call_id, "c1");
    assert_eq!(origin.parent_id, h.kernel.session_id());
    let listed: Vec<String> = store.list(10, None).unwrap().into_iter().map(|s| s.id).collect();
    assert_eq!(listed, [h.kernel.session_id().to_string()]);
    assert_eq!(store.header(&SessionRef::Last).unwrap().0.id, h.kernel.session_id());
    assert_eq!(store.header(&SessionRef::Id(agent_id.clone())).unwrap().0.id, agent_id);
}

#[tokio::test]
async fn a_waiting_spawn_returns_the_report_as_its_result() {
    let mut h = Harness::start(PermissionMode::BypassPermissions, false).await;
    h.script(ROOT, spawn("c1", "solver", "Compute the answer.", true));
    h.script(ROOT, Script::text("It is 42."));
    h.script("solver", Script::text("The answer is 42."));
    h.prompt("answer?").await;
    let events = h.until_idle().await;

    let result = &tool_results(&h.requests(ROOT)[1])[0];
    assert!(result.starts_with("Agent \"solver\" completed after"), "{result}");
    assert!(result.ends_with("The answer is 42."), "{result}");
    assert!(mails(&events).is_empty(), "a waited report is not mailed too");
    let tasks = events.iter().filter(|e| matches!(e.msg, EventMsg::TaskStarted { .. })).count();
    assert_eq!(tasks, 1);
}

#[tokio::test]
async fn waiting_spawns_in_one_reply_run_in_parallel() {
    let mut h = Harness::start(PermissionMode::BypassPermissions, false).await;
    h.script(
        ROOT,
        Script::tool_call("c1", "spawn_agent", json!({ "description": "a work", "task": "a", "name": "a", "wait": true }))
            .then_tool_call("c2", "spawn_agent", json!({ "description": "b work", "task": "b", "name": "b", "wait": true }))
            .then_tool_call("c3", "spawn_agent", json!({ "description": "c work", "task": "c", "name": "c", "wait": true })),
    );
    h.script(ROOT, Script::text("all done"));
    for name in ["a", "b", "c"] {
        h.script(name, Script::default().then_sleep(Duration::from_millis(500)).then_text(format!("{name} done")));
    }
    let started = Instant::now();
    h.prompt("go").await;
    h.until_idle().await;
    assert!(started.elapsed() < Duration::from_millis(1400), "took {:?}", started.elapsed());
    let results = tool_results(&h.requests(ROOT)[1]);
    assert_eq!(results.len(), 3);
    for (result, name) in results.iter().zip(["a", "b", "c"]) {
        assert!(result.ends_with(&format!("{name} done")), "{result}");
    }
}

#[tokio::test]
async fn a_message_to_a_running_agent_joins_its_next_turn() {
    let mut h = Harness::start(PermissionMode::BypassPermissions, false).await;
    h.script(ROOT, spawn("c1", "worker", "Do part a.", false));
    // Sent while the agent runs its command, so it arrives at the agent's next turn boundary.
    h.script(
        ROOT,
        Script::default().then_sleep(Duration::from_millis(200)).then_tool_call(
            "c2",
            "send_message",
            json!({ "to": "worker", "message": "Also do part b." }),
        ),
    );
    h.script(ROOT, Script::text("Both parts are on their way."));
    h.script(ROOT, Script::text("Done."));
    h.script("worker", Script::tool_call("w1", "bash", json!({ "command": "sleep 0.5" })));
    h.script("worker", Script::text("Did a and b."));
    h.prompt("do a and b").await;
    let events = h.until_idle().await;

    let queued = tool_results(&h.requests(ROOT)[2]).pop().unwrap();
    assert_eq!(queued, "Queued for \"worker\"; it reads the message at its next step.");
    // The message arrived at the agent's turn boundary, after its tool result.
    let second = &h.requests("worker")[1];
    let last = second.messages.last().unwrap();
    assert!(matches!(last, Message::User(u) if u.text_content() == "Also do part b."));
    // One round of work, one report.
    assert_eq!(mails(&events), [("worker".to_string(), AgentStatus::Completed)]);
}

#[tokio::test]
async fn an_idle_agent_takes_new_work_and_keeps_its_history() {
    let mut h = Harness::start(PermissionMode::BypassPermissions, false).await;
    h.script(ROOT, spawn("c1", "helper", "First job.", true));
    h.script(
        ROOT,
        Script::tool_call("c2", "send_message", json!({ "to": "helper", "message": "Second job.", "wait": true })),
    );
    h.script(ROOT, Script::text("ok"));
    h.script("helper", Script::text("first result"));
    h.script("helper", Script::text("second result"));
    h.prompt("two jobs").await;
    h.until_idle().await;

    let second = tool_results(&h.requests(ROOT)[2]).pop().unwrap();
    assert!(second.ends_with("second result"), "{second}");
    let history = user_texts(&h.requests("helper")[1]);
    assert!(history[0].contains("First job."));
    assert_eq!(history.last().unwrap(), "Second job.");
}

#[tokio::test]
async fn a_sub_agent_never_asks_for_approval() {
    let mut h = Harness::start(PermissionMode::Manual, true).await;
    h.script(ROOT, spawn("c1", "writer", "Write x.txt.", true));
    h.script(ROOT, Script::text("ok"));
    h.script("writer", Script::tool_call("w1", "write", json!({ "path": "x.txt", "content": "hi" })));
    h.script("writer", Script::text("I could not write x.txt."));
    h.prompt("write x").await;
    let events = h.until_idle().await;

    assert!(
        !events.iter().any(|e| matches!(e.msg, EventMsg::ApprovalRequested { .. })),
        "nobody is asked"
    );
    let refused = &tool_results(&h.requests("writer")[1])[0];
    assert!(refused.contains("a sub-agent cannot ask for it"), "{refused}");
    assert!(!h.work.join("x.txt").exists());
}

#[tokio::test]
async fn sub_agents_follow_the_main_sessions_permissions() {
    let mut h = Harness::start(PermissionMode::Manual, false).await;
    h.script(ROOT, spawn("c1", "writer", "Write x.txt.", false));
    h.script(ROOT, Script::text("started"));
    h.script("writer", Script::default().then_sleep(Duration::from_millis(400)).then_tool_call(
        "w1",
        "write",
        json!({ "path": "x.txt", "content": "hi" }),
    ));
    h.script("writer", Script::text("wrote x.txt"));
    h.prompt("write x").await;
    h.until(|m| matches!(m, EventMsg::AgentStarted { .. })).await;
    h.kernel
        .submit(Op::SetPermissionMode {
            mode: PermissionMode::AcceptEdits,
        })
        .await
        .unwrap();
    h.until_idle().await;
    assert_eq!(std::fs::read_to_string(h.work.join("x.txt")).unwrap(), "hi");
}

#[tokio::test]
async fn stopping_interrupts_every_agent_and_they_can_continue() {
    let mut h = Harness::start(PermissionMode::BypassPermissions, false).await;
    h.script(ROOT, spawn("c1", "slow", "Take your time.", false));
    h.script(ROOT, Script::text("It is working."));
    h.script("slow", Script::text("half way").then_sleep(Duration::from_secs(30)).then_text(" never"));
    h.prompt("start").await;
    h.until(|m| matches!(m, EventMsg::TaskCompleted { .. })).await;
    // Let the agent write "half way" (its events are its own, not the main session's).
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Nothing runs in the main session; stopping stops the agent, which does not wake it.
    h.kernel.submit(Op::Interrupt).await.unwrap();
    let events = h.until_idle().await;
    let statuses: Vec<AgentStatus> = events
        .iter()
        .filter_map(|e| match &e.msg {
            EventMsg::AgentStatus { status, .. } => Some(*status),
            _ => None,
        })
        .collect();
    assert_eq!(statuses, [AgentStatus::Interrupted]);
    assert!(!events.iter().any(|e| matches!(e.msg, EventMsg::TaskStarted { .. })));

    // The report waits for the user's next message, and comes before it.
    h.script(
        ROOT,
        Script::tool_call("c2", "send_message", json!({ "to": "slow", "message": "Go on.", "wait": true })),
    );
    h.script(ROOT, Script::text("finished"));
    h.script("slow", Script::text("all done"));
    h.prompt("continue").await;
    h.until_idle().await;
    let root = h.requests(ROOT);
    let texts = user_texts(&root[2]);
    let report = texts.iter().position(|t| t.starts_with("<agent_report agent=\"slow\" status=\"interrupted\">"));
    let next = texts.iter().position(|t| t == "continue");
    assert!(report.is_some() && report < next, "{texts:?}");
    assert!(texts[report.unwrap()].contains("half way"));
    // It says the agent can go on, so the model resumes it instead of starting a new one.
    assert!(texts[report.unwrap()].ends_with("send_message lets it continue where it stopped."));
    assert!(tool_results(&root[3]).pop().unwrap().ends_with("all done"));
}

#[tokio::test]
async fn a_working_agents_log_is_on_disk_before_its_task_ends() {
    let mut h = Harness::start(PermissionMode::BypassPermissions, false).await;
    h.script(ROOT, spawn("c1", "slow", "Take your time.", false));
    h.script(ROOT, Script::text("It is working."));
    h.script("slow", Script::text("half way").then_sleep(Duration::from_secs(30)).then_text(" never"));
    h.prompt("start").await;
    let events = h.until(|m| matches!(m, EventMsg::TaskCompleted { .. })).await;
    let (_, _, file) = agent_ids(&events).pop().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !std::fs::read_to_string(&file).is_ok_and(|log| log.contains("Take your time.")) {
        assert!(Instant::now() < deadline, "the agent's log is not on disk while it works");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    h.kernel.submit(Op::Interrupt).await.unwrap();
    h.until_idle().await;
}

#[tokio::test]
async fn a_sub_agents_work_is_passed_on_to_the_main_session() {
    let mut h = Harness::start(PermissionMode::BypassPermissions, false).await;
    h.script(ROOT, spawn("c1", "counter", "Count the files.", false));
    h.script(ROOT, Script::text("Started."));
    h.script(ROOT, Script::text("It counted 3."));
    h.script("counter", Script::tool_call("t1", "bash", json!({ "command": "echo 3" })));
    h.script("counter", Script::text("3 files"));
    h.prompt("count").await;
    let events = h.until_idle().await;
    let (agent_id, _, _) = agent_ids(&events).pop().unwrap();

    // What its conversation shows comes as agent_event, in order; deltas stay behind.
    let forwarded: Vec<&EventMsg> = events
        .iter()
        .filter_map(|e| match &e.msg {
            EventMsg::AgentEvent { agent_id: id, event } if *id == agent_id => Some(&event.msg),
            _ => None,
        })
        .collect();
    let kinds: Vec<&str> = forwarded
        .iter()
        .map(|m| match m {
            EventMsg::TaskStarted { .. } => "task_started",
            EventMsg::MessageCompleted { .. } => "message",
            EventMsg::ToolStarted { .. } => "tool_started",
            EventMsg::ToolRunning { .. } => "tool_running",
            EventMsg::ToolCompleted { .. } => "tool_completed",
            EventMsg::TaskCompleted { .. } => "task_completed",
            EventMsg::TurnStarted { .. } | EventMsg::TurnCompleted { .. } => "turn",
            _ => "other",
        })
        .filter(|k| *k != "turn")
        .collect();
    assert_eq!(
        kinds,
        ["task_started", "message", "message", "tool_started", "tool_running", "tool_completed", "message", "task_completed"],
        "{forwarded:?}"
    );
    assert!(!forwarded.iter().any(|m| matches!(m, EventMsg::MessageDelta { .. })));

    // The idle status says how long the round took.
    let elapsed = events.iter().find_map(|e| match &e.msg {
        EventMsg::AgentStatus {
            status: AgentStatus::Completed,
            elapsed_ms,
            ..
        } => *elapsed_ms,
        _ => None,
    });
    assert!(elapsed.is_some());
}

#[tokio::test]
async fn stopping_one_agent_leaves_the_others_working() {
    let mut h = Harness::start(PermissionMode::BypassPermissions, false).await;
    h.script(ROOT, spawn("c1", "slow", "Take your time.", false));
    h.script(ROOT, spawn("c2", "quick", "Be quick.", false));
    h.script(ROOT, Script::text("Both started."));
    h.script(ROOT, Script::text("quick reported."));
    h.script("slow", Script::text("half way").then_sleep(Duration::from_secs(30)).then_text(" never"));
    h.script("quick", Script::text("done").then_sleep(Duration::from_millis(1500)));
    h.prompt("start").await;
    h.until(|m| matches!(m, EventMsg::TaskCompleted { .. })).await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    h.kernel.submit(Op::AgentInterrupt { agent: "slow".into() }).await.unwrap();
    let events = h.until_idle().await;
    let statuses: Vec<(String, AgentStatus)> = events
        .iter()
        .filter_map(|e| match &e.msg {
            EventMsg::AgentStatus { name, status, .. } => Some((name.clone(), *status)),
            _ => None,
        })
        .collect();
    assert_eq!(
        statuses,
        [("slow".to_string(), AgentStatus::Interrupted), ("quick".to_string(), AgentStatus::Completed)]
    );
    // Only the finished agent's report woke the main session; the stopped one came along with it.
    let woken = events
        .iter()
        .filter(|e| matches!(e.msg, EventMsg::TaskStarted { trigger: TaskTrigger::Mail, .. }))
        .count();
    assert_eq!(woken, 1);
    let texts = user_texts(h.requests(ROOT).last().unwrap());
    assert!(texts.iter().any(|t| t.starts_with("<agent_report agent=\"slow\" status=\"interrupted\">")), "{texts:?}");
    assert!(texts.iter().any(|t| t.starts_with("<agent_report agent=\"quick\" status=\"completed\">")), "{texts:?}");

    // An agent that does not run is a warning, not an error.
    h.kernel.submit(Op::AgentInterrupt { agent: "nobody".into() }).await.unwrap();
    let warned = h.until(|m| matches!(m, EventMsg::Warning { .. })).await;
    assert!(matches!(&warned.last().unwrap().msg, EventMsg::Warning { message, .. } if message.contains("nobody")));
}

#[tokio::test]
async fn a_report_of_an_agent_stopped_before_it_replied_is_marked_as_one() {
    let mut h = Harness::start(PermissionMode::BypassPermissions, false).await;
    h.script(ROOT, spawn("c1", "slow", "Take your time.", false));
    h.script(ROOT, Script::text("Started."));
    h.script(ROOT, Script::text("It had stopped."));
    h.script("slow", Script::default().then_sleep(Duration::from_secs(30)).then_text("never"));
    h.prompt("start").await;
    h.until(|m| matches!(m, EventMsg::TaskCompleted { .. })).await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    h.kernel.submit(Op::AgentInterrupt { agent: "slow".into() }).await.unwrap();
    let events = h.until_idle().await;
    // Nothing to sum up: the status carries no summary.
    assert!(events.iter().any(|e| matches!(
        e.msg,
        EventMsg::AgentStatus {
            status: AgentStatus::Interrupted,
            summary: None,
            ..
        }
    )));

    // The report waits for the next input. The model reads that it had not replied; clients
    // get the mark.
    h.prompt("go on").await;
    let events = h.until_idle().await;
    let mail = events.iter().find_map(|e| match &e.msg {
        EventMsg::MessageCompleted { mail: Some(mail), .. } => Some(mail.clone()),
        _ => None,
    });
    assert!(mail.is_some_and(|m| m.no_reply && m.status == AgentStatus::Interrupted));
    let texts = user_texts(h.requests(ROOT).last().unwrap());
    assert!(texts.iter().any(|t| t.contains("(It had not replied yet.)")), "{texts:?}");
}

#[tokio::test]
async fn stopping_a_waiting_call_stops_its_agent() {
    let mut h = Harness::start(PermissionMode::BypassPermissions, false).await;
    h.script(ROOT, spawn("c1", "slow", "Take your time.", true));
    h.script("slow", Script::default().then_sleep(Duration::from_secs(30)).then_text("never"));
    h.prompt("start").await;
    h.until(|m| matches!(m, EventMsg::AgentStarted { .. })).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    h.kernel.submit(Op::Interrupt).await.unwrap();
    let events = h.until_idle().await;
    assert!(events.iter().any(|e| matches!(e.msg, EventMsg::TaskInterrupted { .. })));
    assert!(events.iter().any(|e| matches!(
        e.msg,
        EventMsg::AgentStatus {
            status: AgentStatus::Interrupted,
            ..
        }
    )));
}

#[tokio::test]
async fn user_input_ends_a_wait_and_the_report_arrives_by_mail() {
    let mut h = Harness::start(PermissionMode::BypassPermissions, false).await;
    h.script(ROOT, spawn("c1", "slow", "Take your time.", true));
    h.script(ROOT, Script::text("Noted."));
    h.script(ROOT, Script::text("Got the report."));
    h.script("slow", Script::default().then_sleep(Duration::from_millis(800)).then_text("slow result"));
    h.prompt("start").await;
    h.until(|m| matches!(m, EventMsg::AgentStarted { .. })).await;
    h.prompt("by the way, use tabs").await;
    let events = h.until_idle().await;

    let root = h.requests(ROOT);
    let stopped = &tool_results(&root[1])[0];
    assert!(stopped.starts_with("Stopped waiting because the user sent a new message."), "{stopped}");
    assert_eq!(user_texts(&root[1]).last().unwrap(), "by the way, use tabs");
    assert_eq!(mails(&events), [("slow".to_string(), AgentStatus::Completed)]);
}

#[tokio::test]
async fn shutdown_closes_the_sub_agents_sessions() {
    let mut h = Harness::start(PermissionMode::BypassPermissions, false).await;
    h.script(ROOT, spawn("c1", "slow", "Take your time.", false));
    h.script(ROOT, Script::text("It is working."));
    h.script("slow", Script::default().then_sleep(Duration::from_secs(30)).then_text("never"));
    h.prompt("start").await;
    let events = h.until(|m| matches!(m, EventMsg::TaskCompleted { .. })).await;
    let (_, _, file) = agent_ids(&events).pop().unwrap();
    let store = h.store();
    let started = Instant::now();
    h.kernel.shutdown().await;
    assert!(started.elapsed() < Duration::from_secs(5));
    // The agent's log is closed (it can be opened again) and its task ended as interrupted.
    let loaded = store.open(&SessionRef::Path(file)).unwrap();
    let last_task = loaded.entries.iter().rev().find_map(|e| match &e.kind {
        EntryKind::Task { status, .. } => Some(*status),
        _ => None,
    });
    assert_eq!(last_task, Some(finx_core::store::TaskStatus::Interrupted));
}

#[tokio::test]
async fn a_resumed_session_knows_its_earlier_agents_as_their_logs_left_them() {
    let mut h = Harness::start(PermissionMode::BypassPermissions, false).await;
    h.script(ROOT, spawn("c1", "counter", "Count the files.", false));
    h.script(ROOT, spawn("c2", "slow", "Take your time.", false));
    h.script(ROOT, Script::text("Two agents work."));
    h.script(ROOT, Script::text("The counter is done."));
    h.script("counter", Script::text("3 files"));
    h.script("slow", Script::default().then_sleep(Duration::from_secs(30)).then_text("never"));
    h.prompt("go").await;
    h.until(|m| matches!(m, EventMsg::MessageCompleted { mail: Some(_), .. })).await;
    h.until(|m| matches!(m, EventMsg::TaskCompleted { .. })).await;
    let session = h.kernel.session_id().to_string();
    let Harness { kernel, api, lanes, work, home, _dir } = h;
    kernel.shutdown().await;

    let options = finx_core::ResumeOptions {
        session: SessionRef::Id(session),
        model: None,
        thinking: None,
        permission_mode: None,
        home: home.clone(),
        config: Arc::new(Config::default()),
        project_root: None,
        trusted: false,
        interactive_approvals: false,
    };
    let kernel = Kernel::resume(options, deps(&api, &work, &home)).await.unwrap();
    let mut h = Harness { kernel, api, lanes, work, home, _dir };
    let restored = h.kernel.take_restored_agents();
    let seen: Vec<(&str, &str, AgentStatus)> = restored.iter().map(|a| (a.name.as_str(), a.description.as_str(), a.status)).collect();
    assert_eq!(
        seen,
        [("counter", "counter work", AgentStatus::Completed), ("slow", "slow work", AgentStatus::Interrupted)]
    );
    assert_eq!(restored[0].call_id, "c1");
    // Its own session, as clients show it: the task it got, its reply, where it ended.
    let replied = restored[0].transcript.iter().any(|item| match item {
        finx_protocol::api::TranscriptItem::Message { message: Message::Assistant(m), .. } => m.text() == "3 files",
        _ => false,
    });
    assert!(replied, "{:?}", restored[0].transcript);
    assert!(h.kernel.take_restored_agents().is_empty(), "taken once");

    // Their sessions are not loaded: they take no messages, and their names stay taken.
    h.script(ROOT, Script::tool_call("c3", "send_message", json!({ "to": "counter", "message": "Count again." })));
    h.script(ROOT, spawn("c4", "counter", "Count again.", true));
    h.script(ROOT, Script::text("Counted again."));
    h.script("counter-2", Script::text("4 files"));
    h.prompt("count again").await;
    h.until_idle().await;
    let root = h.requests(ROOT);
    let results = tool_results(root.last().unwrap());
    assert_eq!(results[results.len() - 2], "Agent \"counter\" is closed. Start a new one with spawn_agent.");
    assert!(results[results.len() - 1].starts_with("Agent \"counter-2\" completed after"), "{results:?}");
}

#[tokio::test]
async fn sub_agents_can_be_turned_off() {
    let dir = tempfile::tempdir().unwrap();
    let home = FinxHome::new(dir.path().join("home"));
    home.ensure().unwrap();
    let api = ScriptedApi::new();
    api.push(Script::text("hi"));
    let mut registry = ModelRegistry::new(Catalog::default(), RegistryOptions::default());
    registry.register_api(api.clone());
    registry.insert_provider(ScriptedApi::provider());
    let config = Config {
        agents_enabled: false,
        ..Config::default()
    };
    let mut kernel = Kernel::start(
        StartOptions {
            model: "test/scripted".into(),
            thinking: ThinkingLevel::Off,
            permission_mode: PermissionMode::Manual,
            cwd: dir.path().to_path_buf(),
            home: home.clone(),
            config: Arc::new(config),
            project_root: None,
            trusted: false,
            interactive_approvals: false,
        },
        KernelDeps {
            llm: Arc::new(registry),
            tools: Arc::new(builtin_registry(BashTool::default())),
            env: Arc::new(LocalEnvironment::new(dir.path().to_path_buf())),
            store: Arc::new(JsonlStore::new(home.sessions_dir())),
            hooks: vec![],
            mcp_servers: Vec::new(),
            browser_pool: None,
        },
    )
    .await
    .unwrap();
    kernel.run(vec![finx_llm::UserContent::Text { text: "hi".into() }]).await.unwrap();
    let names: Vec<String> = api.requests()[0].tools.iter().map(|t| t.name.clone()).collect();
    assert_eq!(names, ["read", "write", "edit", "bash"]);
}
