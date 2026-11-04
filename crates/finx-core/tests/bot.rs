//! A bot's session (bot-design): scripted model, real tools, real JSONL session log.

use finx_core::BotIdentity;
use finx_core::Config;
use finx_core::FinxHome;
use finx_core::JsonlStore;
use finx_core::Kernel;
use finx_core::KernelDeps;
use finx_core::ResumeOptions;
use finx_core::SessionRef;
use finx_core::StartOptions;
use finx_core::TaskEnd;
use finx_core::store::EntryKind;
use finx_core::store::SessionStore;
use finx_llm::Catalog;
use finx_llm::ErrorKind;
use finx_llm::Message;
use finx_llm::ModelRegistry;
use finx_llm::RegistryOptions;
use finx_llm::ThinkingLevel;
use finx_llm::UserContent;
use finx_llm::api::scripted::Script;
use finx_llm::api::scripted::ScriptedApi;
use finx_protocol::Event;
use finx_protocol::EventMsg;
use finx_protocol::Op;
use finx_protocol::PermissionMode;
use finx_tools::BashTool;
use finx_tools::LocalEnvironment;
use finx_tools::builtin_registry;
use serde_json::json;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use tempfile::TempDir;

struct Harness {
    kernel: Kernel,
    api: Arc<ScriptedApi>,
    home: FinxHome,
    folder: PathBuf,
    _dir: TempDir,
}

fn deps(api: &Arc<ScriptedApi>, work: &Path, home: &FinxHome) -> KernelDeps {
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
        docs: None,
    }
}

/// A bot named `name` in its own folder, as the server starts one.
async fn bot(name: &str, mode: PermissionMode, scripts: Vec<Script>) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let home = FinxHome::new(dir.path().canonicalize().unwrap().join("home"));
    home.ensure().unwrap();
    let folder = home.bot_files_dir("b1");
    std::fs::create_dir_all(&folder).unwrap();
    let folder = folder.canonicalize().unwrap();
    let api = ScriptedApi::new();
    for script in scripts {
        api.push(script);
    }
    let options = StartOptions {
        model: "test/scripted".into(),
        thinking: ThinkingLevel::Off,
        permission_mode: mode,
        cwd: folder.clone(),
        home: home.clone(),
        config: Arc::new(Config::default()),
        project_root: None,
        trusted: false,
        interactive_approvals: false,
        bot: Some(BotIdentity {
            id: "b1".into(),
            name: name.into(),
        }),
    };
    let kernel = Kernel::start(options, deps(&api, &folder, &home)).await.unwrap();
    Harness {
        kernel,
        api,
        home,
        folder,
        _dir: dir,
    }
}

fn send(id: &str, text: &str) -> Script {
    Script::tool_call(id, "send_to_user", json!({ "text": text }))
}

fn send_last(id: &str, text: &str) -> Script {
    Script::tool_call(id, "send_to_user", json!({ "text": text, "end_turn": true }))
}

fn prompt(text: &str) -> Vec<UserContent> {
    vec![UserContent::Text { text: text.into() }]
}

/// Collects events until `stop` matches (inclusive). Fails after 10 seconds.
async fn until(kernel: &mut Kernel, stop: impl Fn(&EventMsg) -> bool) -> Vec<Event> {
    let mut events = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let event = tokio::time::timeout(remaining, kernel.next_event())
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

/// The texts the user saw, in order: each `send_to_user` call.
fn sent(events: &[Event]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match &e.msg {
            EventMsg::ToolStarted { name, args, .. } if name == "send_to_user" => args["text"].as_str().map(str::to_string),
            _ => None,
        })
        .collect()
}

fn texts(message: &Message) -> String {
    match message {
        Message::User(user) => user
            .content
            .iter()
            .filter_map(|c| match c {
                UserContent::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[tokio::test]
async fn a_bot_talks_through_send_to_user_and_ends_its_turn() {
    let mut h = bot(
        "研究员",
        PermissionMode::Manual,
        vec![send("c1", "在查了。"), send_last("c2", "三种：甲、乙、丙。")],
    )
    .await;
    let result = h.kernel.run(prompt("常见的方案有哪些？")).await.unwrap();
    assert!(matches!(result.end, TaskEnd::Completed { .. }));
    assert_eq!(sent(&result.events), ["在查了。", "三种：甲、乙、丙。"]);
    // end_turn: no request after the last message.
    let requests = h.api.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(h.api.remaining(), 0);

    // A bot's own prompt, and its tool.
    let system = &requests[0].system;
    assert!(system.starts_with("You are 研究员, one of the user's bots in FinxWork."), "{system}");
    assert!(!system.contains("You are FinxWork"));
    assert!(!system.contains("{{"), "every mark is filled in");
    assert!(system.contains("Numbers and data:") && system.contains("Acting with care:"));
    let names: Vec<&str> = requests[0].tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, ["read", "write", "edit", "bash", "spawn_agent", "send_message", "send_to_user"]);

    // The header names the bot; lists leave the session out.
    let store = JsonlStore::new(h.home.sessions_dir());
    let (header, _) = store.header(&SessionRef::Id(h.kernel.session_id().to_string())).unwrap();
    let bot = header.bot.expect("a bot's header");
    assert_eq!((bot.id.as_str(), bot.name.as_str()), ("b1", "研究员"));
    assert!(store.list(10, None).unwrap().is_empty());
}

#[tokio::test]
async fn an_empty_message_is_an_error_and_ends_nothing() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![
            Script::tool_call("c1", "send_to_user", json!({ "text": "  ", "end_turn": true })),
            send_last("c2", "好的。"),
        ],
    )
    .await;
    let result = h.kernel.run(prompt("hi")).await.unwrap();
    assert!(matches!(result.end, TaskEnd::Completed { .. }));
    let requests = h.api.requests();
    assert_eq!(requests.len(), 2, "the failed send did not end the task");
    let Some(Message::ToolResult(result)) = requests[1].messages.last() else {
        panic!("the result of the empty send")
    };
    assert!(result.is_error);
    assert!(result.text_content().contains("text must not be empty"));
}

/// A message that came while the bot worked is answered before the task ends, even when the
/// bot said its last word (bot-design §3.3).
#[tokio::test]
async fn end_turn_waits_for_input_that_came_meanwhile() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![
            send_last("c1", "春天的诗。").then_sleep(Duration::from_millis(400)),
            send_last("c2", "夏天的诗。"),
        ],
    )
    .await;
    h.kernel.submit(Op::prompt("写一首春天的诗")).await.unwrap();
    until(&mut h.kernel, |m| matches!(m, EventMsg::TurnStarted { .. })).await;
    h.kernel.submit(Op::prompt("再写一首夏天的")).await.unwrap();
    let events = until(&mut h.kernel, |m| matches!(m, EventMsg::TaskCompleted { .. })).await;
    assert_eq!(sent(&events), ["春天的诗。", "夏天的诗。"]);
    let requests = h.api.requests();
    assert_eq!(requests.len(), 2);
    let last_user = requests[1].messages.iter().rev().find(|m| matches!(m, Message::User(_))).unwrap();
    assert_eq!(texts(last_user), "再写一首夏天的");
}

const REMINDER: &str = "<reply_reminder>";

fn reminders(h: &Harness) -> usize {
    let store = JsonlStore::new(h.home.sessions_dir());
    let (_, entries) = store.read(&SessionRef::Id(h.kernel.session_id().to_string())).unwrap();
    entries.iter().filter(|e| matches!(e.kind, EntryKind::Unanswered)).count()
}

/// A bot that writes its answer as plain text, which the user never sees, is reminded once and
/// sends it (bot-design §3.11).
#[tokio::test]
async fn a_bot_that_answers_in_plain_text_is_reminded_to_send() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![Script::text("2。"), send_last("c1", "2。")],
    )
    .await;
    let result = h.kernel.run(prompt("1 加 1 等于几？")).await.unwrap();
    assert!(matches!(result.end, TaskEnd::Completed { .. }));
    assert_eq!(sent(&result.events), ["2。"]);
    let requests = h.api.requests();
    assert_eq!(requests.len(), 2);
    let last = requests[1].messages.last().unwrap();
    assert!(texts(last).starts_with(REMINDER), "{}", texts(last));
    assert_eq!(reminders(&h), 1);
    // The reminder is the model's alone: no event shows it.
    assert!(result.events.iter().all(|e| !format!("{:?}", e.msg).contains(REMINDER)));
}

/// Once per task: a bot that again sends nothing ends its task.
#[tokio::test]
async fn the_reminder_comes_once_per_task() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![Script::text("嗯。"), Script::text("嗯嗯。"), Script::text("在。"), send_last("c1", "在。")],
    )
    .await;
    let result = h.kernel.run(prompt("在吗")).await.unwrap();
    // Reminded and still silent: the owner is told (D-321).
    let TaskEnd::Failed(error) = &result.end else { panic!("{:?}", result.end) };
    assert_eq!((error.kind.as_str(), error.retryable), ("no_reply", true));
    assert!(sent(&result.events).is_empty());
    assert_eq!(h.api.requests().len(), 2);
    // The next task gets its own.
    let result = h.kernel.run(prompt("在吗？")).await.unwrap();
    assert_eq!(sent(&result.events), ["在。"]);
    assert_eq!((h.api.requests().len(), reminders(&h)), (4, 2));
}

/// A retry after a failure answers the failed task's message: it is reminded too.
#[tokio::test]
async fn a_retried_task_is_reminded_too() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![Script::fail(ErrorKind::QuotaExceeded, "quota exceeded"), Script::text("2。"), send_last("c1", "2。")],
    )
    .await;
    let result = h.kernel.run(prompt("1 加 1 等于几？")).await.unwrap();
    assert!(matches!(result.end, TaskEnd::Failed(_)), "{:?}", result.end);
    h.kernel.submit(Op::Continue).await.unwrap();
    let events = until(&mut h.kernel, |m| matches!(m, EventMsg::TaskCompleted { .. })).await;
    assert_eq!(sent(&events), ["2。"]);
    assert_eq!(reminders(&h), 1);
}

/// Answered, or nobody waiting: no reminder. A message that came after the bot's last one is
/// waiting for its own answer.
#[tokio::test]
async fn only_an_unanswered_message_brings_a_reminder() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![
            // Answered, then a private last word.
            send("c1", "好的。"),
            Script::text("Done."),
            // A report wakes the bot, which has nothing to tell.
            Script::tool_call("c2", "spawn_agent", json!({ "description": "查资料", "task": "Find it." }))
                .then_tool_call("c3", "send_to_user", json!({ "text": "交给子智能体了。", "end_turn": true })),
            Script::text("Found: 42."),
            Script::text("Nothing to add."),
        ],
    )
    .await;
    h.kernel.run(prompt("记一下")).await.unwrap();
    until(&mut h.kernel, |m| matches!(m, EventMsg::Idle)).await;
    h.kernel.submit(Op::prompt("帮我查一下")).await.unwrap();
    until(&mut h.kernel, |m| matches!(m, EventMsg::Idle)).await;
    assert_eq!(h.api.requests().len(), 5);
    assert_eq!(reminders(&h), 0);

    // A message that comes while the bot works, then a private last word: reminded.
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![
            send("c1", "春天的诗。").then_sleep(Duration::from_millis(400)),
            Script::text("Both done."),
            send_last("c2", "夏天的诗。"),
        ],
    )
    .await;
    h.kernel.submit(Op::prompt("写一首春天的诗")).await.unwrap();
    until(&mut h.kernel, |m| matches!(m, EventMsg::TurnStarted { .. })).await;
    h.kernel.submit(Op::prompt("再写一首夏天的")).await.unwrap();
    let events = until(&mut h.kernel, |m| matches!(m, EventMsg::TaskCompleted { .. })).await;
    assert_eq!(sent(&events), ["春天的诗。", "夏天的诗。"]);
    assert_eq!(reminders(&h), 1);
}

/// A bot's sub-agents write reports, not chat: a session's prompt, and no send_to_user
/// (bot-design §2.3, D-311).
#[tokio::test]
async fn a_bots_sub_agents_get_a_sessions_prompt_and_no_send_to_user() {
    let mut h = bot(
        "研究员",
        PermissionMode::Manual,
        vec![
            Script::tool_call("c1", "spawn_agent", json!({ "description": "查资料", "task": "Find it." }))
                .then_tool_call("c2", "send_to_user", json!({ "text": "交给子智能体了。", "end_turn": true })),
            // The sub-agent's only request.
            Script::text("Found: 42."),
            // The bot, woken by the report.
            send_last("c3", "查到了：42。"),
        ],
    )
    .await;
    h.kernel.submit(Op::prompt("帮我查一下")).await.unwrap();
    let events = until(&mut h.kernel, |m| matches!(m, EventMsg::Idle)).await;
    assert_eq!(sent(&events), ["交给子智能体了。", "查到了：42。"]);
    let requests = h.api.requests();
    assert_eq!(requests.len(), 3);
    let agent = &requests[1];
    assert!(agent.system.starts_with("You are FinxWork"), "{}", agent.system);
    let names: Vec<&str> = agent.tools.iter().map(|t| t.name.as_str()).collect();
    assert!(!names.contains(&"send_to_user") && !names.contains(&"spawn_agent"), "{names:?}");
    // The sub-agent works in the bot's folder too.
    assert!(agent.system.contains(&format!("cwd: {}", h.folder.display())));
    assert!(requests[2].system.starts_with("You are 研究员"));
}

/// A new name reaches the model once, at the next turn, as the date does (bot-design §2.4).
#[tokio::test]
async fn a_new_name_is_told_once() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![send_last("c1", "在。"), send_last("c2", "我是研究员。"), send_last("c3", "好。")],
    )
    .await;
    h.kernel.run(prompt("在吗")).await.unwrap();
    h.kernel.set_bot_name("研究员".into());
    h.kernel.run(prompt("你叫什么")).await.unwrap();
    h.kernel.run(prompt("好")).await.unwrap();
    let update = "<environment_update>\nyour name: 研究员\n</environment_update>";
    let requests = h.api.requests();
    let count = |i: usize| requests[i].messages.iter().filter(|m| texts(m) == update).count();
    assert_eq!((count(0), count(1), count(2)), (0, 1, 1), "told at the second task, then kept");
    // The system prompt stays as it was.
    assert!(requests[2].system.starts_with("You are FinxBot"));
    let store = JsonlStore::new(h.home.sessions_dir());
    let (_, entries) = store.read(&SessionRef::Id(h.kernel.session_id().to_string())).unwrap();
    let names: Vec<&str> = entries
        .iter()
        .filter_map(|e| match &e.kind {
            EntryKind::BotName { name } => Some(name.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(names, ["研究员"]);
}

/// A resumed bot session keeps its tool and prompt; a name changed meanwhile is told.
#[tokio::test]
async fn a_resumed_bot_keeps_send_to_user_and_learns_its_new_name() {
    let h = bot("FinxBot", PermissionMode::Manual, vec![send_last("c1", "在。")]).await;
    let mut kernel = h.kernel;
    kernel.run(prompt("在吗")).await.unwrap();
    let id = kernel.session_id().to_string();
    kernel.shutdown().await;
    h.api.push(send_last("c2", "我叫运维。"));
    let options = ResumeOptions {
        session: SessionRef::Id(id),
        model: None,
        thinking: None,
        permission_mode: None,
        home: h.home.clone(),
        config: Arc::new(Config::default()),
        project_root: None,
        trusted: false,
        interactive_approvals: false,
        bot_name: Some("运维".into()),
    };
    let mut kernel = Kernel::resume(options, deps(&h.api, &h.folder, &h.home)).await.unwrap();
    let result = kernel.run(prompt("你叫什么")).await.unwrap();
    assert_eq!(sent(&result.events), ["我叫运维。"]);
    let requests = h.api.requests();
    let last = requests.last().unwrap();
    assert!(last.system.starts_with("You are FinxBot"), "the logged prompt");
    assert!(last.tools.iter().any(|t| t.name == "send_to_user"));
    let update = "<environment_update>\nyour name: 运维\n</environment_update>";
    assert!(last.messages.iter().any(|m| texts(m) == update));
}

/// Writing in the bot's own folder needs no approval where the workspace's files need none,
/// though the folder is in the data directory (bot-design §2.5).
#[tokio::test]
async fn a_bot_writes_in_its_own_folder_without_asking() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::AcceptEdits,
        vec![
            Script::tool_call("c1", "write", json!({ "path": "report.md", "content": "# 周报" })),
            Script::tool_call("c2", "write", json!({ "path": "../bot.json", "content": "{}" })),
            send_last("c3", "写好了。"),
        ],
    )
    .await;
    let result = h.kernel.run(prompt("写一份周报")).await.unwrap();
    assert!(matches!(result.end, TaskEnd::Completed { .. }));
    assert_eq!(std::fs::read_to_string(h.folder.join("report.md")).unwrap(), "# 周报");
    // Outside its folder, the data directory stays protected: nobody can approve here.
    assert!(!h.folder.parent().unwrap().join("bot.json").exists());
    let results: Vec<String> = h.api.requests()[2]
        .messages
        .iter()
        .filter_map(|m| match m {
            Message::ToolResult(r) => Some(r.text_content()),
            _ => None,
        })
        .collect();
    assert!(results[0].starts_with("Wrote"), "{results:?}");
    assert!(!results[1].starts_with("Wrote"), "{results:?}");
}
