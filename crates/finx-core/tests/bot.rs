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
use finx_core::store::CreatedSession;
use finx_core::store::Entry;
use finx_core::store::EntryKind;
use finx_core::store::LoadedSession;
use finx_core::store::SessionHeader;
use finx_core::store::SessionStore;
use finx_core::store::SessionSummary;
use finx_core::store::SessionWriter;
use finx_core::store::StoreError;
use finx_core::store::writer::LineSink;
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
use std::io;
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
    bot_on(None, name, mode, scripts).await
}

/// The same, with its log in `store` instead of the usual file.
async fn bot_on(store: Option<Arc<dyn SessionStore>>, name: &str, mode: PermissionMode, scripts: Vec<Script>) -> Harness {
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
    let mut deps = deps(&api, &folder, &home);
    if let Some(store) = store {
        deps.store = store;
    }
    let kernel = Kernel::start(options, deps).await.unwrap();
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
    assert_eq!(names, ["read", "write", "edit", "bash", "spawn_agent", "send_message", "send_to_user", "tool_search", "call_tool"]);

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

/// An answer only written as plain text while another message waits: the reply to that one would
/// count as answering both, and the owner would never see this answer. It is reminded first, with
/// the reminder the last thing the model reads; the message joins after (bot-design §3.11).
#[tokio::test]
async fn a_private_answer_is_reminded_before_the_next_message_joins() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![
            Script::text("春天的诗。").then_sleep(Duration::from_millis(400)),
            send("c1", "春天的诗。"),
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
    let requests = h.api.requests();
    assert_eq!(requests.len(), 3);
    assert!(texts(requests[1].messages.last().unwrap()).starts_with(REMINDER));
    assert!(requests[1].messages.iter().all(|m| texts(m) != "再写一首夏天的"));
    assert_eq!(texts(requests[2].messages.last().unwrap()), "再写一首夏天的");
}

/// A message that lands before the first request joins it: the model reads both at once, and the
/// reminder still stands if it answers neither.
#[tokio::test]
async fn a_message_before_the_first_request_joins_it() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![
            Script::text("春。夏。"),
            send("c1", "春。").then_tool_call("c2", "send_to_user", json!({ "text": "夏。", "end_turn": true })),
        ],
    )
    .await;
    // Nothing else runs between these two, so the task starts with both already in.
    h.kernel.submit(Op::prompt("写一首春天的诗")).await.unwrap();
    h.kernel.submit(Op::prompt("写一首夏天的诗")).await.unwrap();
    let events = until(&mut h.kernel, |m| m.is_task_end()).await;
    assert!(matches!(events.last().unwrap().msg, EventMsg::TaskCompleted { .. }), "{:?}", events.last().unwrap().msg);
    assert_eq!(sent(&events), ["春。", "夏。"]);
    assert_eq!(reminders(&h), 1);
    let requests = h.api.requests();
    assert_eq!(requests.len(), 2);
    let asked: Vec<String> = requests[0].messages.iter().filter(|m| matches!(m, Message::User(_))).map(texts).collect();
    assert_eq!(asked, ["写一首春天的诗", "写一首夏天的诗"]);
}

/// A message that lands while the reminder's reply is written joins after it, like one that lands
/// before: the reply it brings answers the first message.
#[tokio::test]
async fn a_message_during_the_reminders_reply_joins_after_it() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![
            Script::text("春天的诗。"),
            send_last("c1", "春天的诗。").then_sleep(Duration::from_millis(400)),
            send_last("c2", "夏天的诗。"),
        ],
    )
    .await;
    h.kernel.submit(Op::prompt("写一首春天的诗")).await.unwrap();
    until(&mut h.kernel, |m| matches!(m, EventMsg::TurnStarted { turn: 1, .. })).await;
    h.kernel.submit(Op::prompt("再写一首夏天的")).await.unwrap();
    let events = until(&mut h.kernel, |m| matches!(m, EventMsg::TaskCompleted { .. })).await;
    assert_eq!(sent(&events), ["春天的诗。", "夏天的诗。"]);
    assert_eq!(reminders(&h), 1);
    let requests = h.api.requests();
    assert_eq!(requests.len(), 3);
    assert!(requests[1].messages.iter().all(|m| texts(m) != "再写一首夏天的"));
    assert_eq!(texts(requests[2].messages.last().unwrap()), "再写一首夏天的");
}

/// A log whose sync takes a while, the only wait between a task's last look at the queue and its
/// end. Nothing is read back.
struct SlowSyncStore;

struct SlowSyncLog;

impl LineSink for SlowSyncLog {
    fn write_line(&mut self, _line: &str) -> io::Result<()> {
        Ok(())
    }

    fn sync(&mut self) -> io::Result<()> {
        std::thread::sleep(Duration::from_millis(200));
        Ok(())
    }
}

impl SessionStore for SlowSyncStore {
    fn create(&self, _header: &SessionHeader) -> Result<CreatedSession, StoreError> {
        Ok(CreatedSession {
            location: PathBuf::from("memory://slow"),
            writer: SessionWriter::spawn(SlowSyncLog).unwrap(),
        })
    }

    fn header(&self, reference: &SessionRef) -> Result<(SessionHeader, PathBuf), StoreError> {
        Err(StoreError::NotFound(format!("{reference:?}")))
    }

    fn open(&self, reference: &SessionRef) -> Result<LoadedSession, StoreError> {
        Err(StoreError::NotFound(format!("{reference:?}")))
    }

    fn read(&self, reference: &SessionRef) -> Result<(SessionHeader, Vec<Entry>), StoreError> {
        Err(StoreError::NotFound(format!("{reference:?}")))
    }

    fn list(&self, _limit: usize, _within: Option<&Path>) -> Result<Vec<SessionSummary>, StoreError> {
        Ok(Vec::new())
    }
}

/// A message that lands as an answered task ends, past its last look at the queue, starts the next.
#[tokio::test]
async fn a_message_that_lands_as_a_task_ends_starts_the_next() {
    let mut h = bot_on(
        Some(Arc::new(SlowSyncStore)),
        "FinxBot",
        PermissionMode::Manual,
        vec![send_last("c1", "春。"), send_last("c2", "夏。")],
    )
    .await;
    h.kernel.submit(Op::prompt("写一首春天的诗")).await.unwrap();
    // The task goes straight on from this event to the sync: this test runs again only then.
    until(&mut h.kernel, |m| matches!(m, EventMsg::TurnCompleted { turn: 0, .. })).await;
    h.kernel.submit(Op::prompt("写一首夏天的诗")).await.unwrap();
    let first = until(&mut h.kernel, |m| m.is_task_end()).await;
    assert!(matches!(first.last().unwrap().msg, EventMsg::TaskCompleted { .. }), "{:?}", first.last().unwrap().msg);
    let second = until(&mut h.kernel, |m| m.is_task_end()).await;
    assert!(matches!(second.last().unwrap().msg, EventMsg::TaskCompleted { .. }), "{:?}", second.last().unwrap().msg);
    assert_eq!(sent(&second), ["夏。"]);
}

/// A message that lands as a silent bot's task ends, past its last look at the queue: the owner
/// hears the task failed and the message is answered, as when it lands a moment later. It does
/// not go back to the composer: the model works, and nobody would have answered it.
#[tokio::test]
async fn a_message_that_lands_as_a_silent_task_ends_is_answered() {
    let mut h = bot_on(
        Some(Arc::new(SlowSyncStore)),
        "FinxBot",
        PermissionMode::Manual,
        vec![Script::text("春。"), Script::text("还是春。"), send_last("c1", "夏。")],
    )
    .await;
    h.kernel.submit(Op::prompt("写一首春天的诗")).await.unwrap();
    // The task goes straight on from this event to the sync: this test runs again only then.
    until(&mut h.kernel, |m| matches!(m, EventMsg::TurnCompleted { turn: 1, .. })).await;
    h.kernel.submit(Op::prompt("写一首夏天的诗")).await.unwrap();
    let events = until(&mut h.kernel, |m| matches!(m, EventMsg::TaskCompleted { .. })).await;
    let failure = events.iter().find_map(|e| match &e.msg {
        EventMsg::TaskFailed { error, returned_input, .. } => Some((error.kind.as_str(), returned_input.len())),
        _ => None,
    });
    assert_eq!(failure, Some(("no_reply", 0)));
    assert_eq!(sent(&events), ["夏。"]);
}

/// Each message in a row counts anew: the first one's reminder does not use up the next one's,
/// which would fail the task with both already answered.
#[tokio::test]
async fn each_message_in_a_row_gets_its_own_reminder() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![
            Script::text("春。").then_sleep(Duration::from_millis(400)),
            send("c1", "春。"),
            Script::text("夏。"),
            send_last("c2", "夏。"),
        ],
    )
    .await;
    h.kernel.submit(Op::prompt("写一首春天的诗")).await.unwrap();
    until(&mut h.kernel, |m| matches!(m, EventMsg::TurnStarted { .. })).await;
    h.kernel.submit(Op::prompt("写一首夏天的诗")).await.unwrap();
    let events = until(&mut h.kernel, |m| m.is_task_end()).await;
    assert!(matches!(events.last().unwrap().msg, EventMsg::TaskCompleted { .. }), "{:?}", events.last().unwrap().msg);
    assert_eq!(sent(&events), ["春。", "夏。"]);
    assert_eq!(reminders(&h), 2);
}

/// Reminded and still silent with another message waiting: that message gets its turn. Failing
/// here would hand it back to the owner unread.
#[tokio::test]
async fn silence_after_a_reminder_gives_way_to_the_next_message() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![
            Script::text("春。").then_sleep(Duration::from_millis(400)),
            Script::text("还是春。"),
            send_last("c1", "夏。"),
        ],
    )
    .await;
    h.kernel.submit(Op::prompt("写一首春天的诗")).await.unwrap();
    until(&mut h.kernel, |m| matches!(m, EventMsg::TurnStarted { .. })).await;
    h.kernel.submit(Op::prompt("写一首夏天的诗")).await.unwrap();
    let events = until(&mut h.kernel, |m| m.is_task_end()).await;
    assert!(matches!(events.last().unwrap().msg, EventMsg::TaskCompleted { .. }), "{:?}", events.last().unwrap().msg);
    assert_eq!(sent(&events), ["夏。"]);
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

// ---- Message types (bot-design §3.12) ----

fn attach(id: &str, files: &[&str]) -> Script {
    let files: Vec<_> = files.iter().map(|path| json!({ "path": path })).collect();
    Script::tool_call(id, "send_to_user", json!({ "type": "attachment", "files": files, "end_turn": true }))
}

/// The head of a PNG of that size: enough to tell what it is.
fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    bytes.extend(width.to_be_bytes());
    bytes.extend(height.to_be_bytes());
    bytes.extend([8, 6, 0, 0, 0, 0, 0, 0, 0]);
    bytes
}

/// What the `send_to_user` results told user interfaces.
fn details(events: &[Event]) -> Vec<serde_json::Value> {
    events
        .iter()
        .filter_map(|e| match &e.msg {
            EventMsg::ToolCompleted { result, .. } if result.tool_name == "send_to_user" => {
                result.details.as_ref().map(|d| serde_json::from_str(d.as_str()).unwrap())
            }
            _ => None,
        })
        .collect()
}

/// The result text of each call the model was told about, in the last request.
fn results(h: &Harness) -> Vec<(bool, String)> {
    h.api
        .requests()
        .last()
        .unwrap()
        .messages
        .iter()
        .filter_map(|m| match m {
            Message::ToolResult(r) => Some((r.is_error, r.text_content())),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn an_attachment_is_one_message_of_files_and_says_what_they_are() {
    let mut h = bot("FinxBot", PermissionMode::Manual, vec![attach("c1", &["毛利率.png", "./报告.pdf"])]).await;
    std::fs::write(h.folder.join("毛利率.png"), png(960, 600)).unwrap();
    std::fs::write(h.folder.join("报告.pdf"), b"%PDF-1.7").unwrap();
    let result = h.kernel.run(prompt("发我")).await.unwrap();
    assert!(matches!(result.end, TaskEnd::Completed { .. }));
    assert_eq!(h.api.requests().len(), 1, "end_turn ends it");
    let image = h.folder.join("毛利率.png");
    let file = h.folder.join("报告.pdf");
    assert_eq!(
        details(&result.events),
        [json!({ "files": [
            { "path": image, "size": png(960, 600).len(), "image": true, "width": 960, "height": 600 },
            { "path": file, "size": 8 },
        ] })]
    );
}

#[tokio::test]
async fn an_image_is_told_by_its_contents_and_only_up_to_the_panels_limit() {
    let mut h = bot("FinxBot", PermissionMode::Manual, vec![attach("c1", &["photo.pdf", "chart.png", "huge.png"])]).await;
    std::fs::write(h.folder.join("photo.pdf"), png(10, 20)).unwrap();
    std::fs::write(h.folder.join("chart.png"), b"not a picture").unwrap();
    let mut huge = png(4000, 3000);
    huge.resize(finx_core::files::MAX_IMAGE as usize + 1, 0);
    std::fs::write(h.folder.join("huge.png"), huge).unwrap();
    let result = h.kernel.run(prompt("发我")).await.unwrap();
    let sent = details(&result.events);
    let files = sent[0]["files"].as_array().unwrap();
    assert_eq!(files[0]["image"], true, "a picture under another name");
    assert_eq!((files[0]["width"].as_u64(), files[0]["height"].as_u64()), (Some(10), Some(20)));
    assert!(files[1].get("image").is_none(), "only named like one");
    assert!(files[2].get("image").is_none(), "too large to show");
}

#[tokio::test]
async fn a_file_made_in_the_same_step_can_be_sent() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::AcceptEdits,
        vec![Script::tool_call("c1", "write", json!({ "path": "report.md", "content": "# 周报" })).then_tool_call(
            "c2",
            "send_to_user",
            json!({ "type": "attachment", "files": [{ "path": "report.md" }], "end_turn": true }),
        )],
    )
    .await;
    let result = h.kernel.run(prompt("写一份周报发我")).await.unwrap();
    assert!(matches!(result.end, TaskEnd::Completed { .. }));
    assert_eq!(details(&result.events)[0]["files"][0]["size"], 8);
}

#[tokio::test]
async fn a_wrong_path_sends_nothing_and_names_each_one() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![
            attach("c1", &["there.txt", "gone.pdf", ".", "https://example.com/a.png"]),
            attach("c2", &["there.txt"]),
        ],
    )
    .await;
    std::fs::write(h.folder.join("there.txt"), "x").unwrap();
    let result = h.kernel.run(prompt("发我")).await.unwrap();
    assert!(matches!(result.end, TaskEnd::Completed { .. }));
    let told = results(&h);
    assert!(told[0].0, "{told:?}");
    for part in ["gone.pdf: no such file", ".: not a file", "https://example.com/a.png: a web address, save it to a file first"] {
        assert!(told[0].1.contains(part), "{told:?}");
    }
    assert!(!told[0].1.contains("there.txt"), "{told:?}");
    assert_eq!(details(&result.events).len(), 1, "only the second call went out");
}

/// What a real model does on its own: words and files in one call, often with no type
/// (19 of 59 calls were refused before this was allowed, bot-design §3.12).
#[tokio::test]
async fn files_may_come_with_words_and_need_no_type() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![
            Script::tool_call("c1", "send_to_user", json!({ "type": "attachment", "text": "在这里。", "files": [{ "path": "a.txt" }] })),
            Script::tool_call("c2", "send_to_user", json!({ "text": "还有这个。", "files": [{ "path": "a.txt" }], "end_turn": true })),
        ],
    )
    .await;
    std::fs::write(h.folder.join("a.txt"), "x").unwrap();
    let result = h.kernel.run(prompt("发我")).await.unwrap();
    assert!(matches!(result.end, TaskEnd::Completed { .. }));
    let told = details(&result.events);
    assert_eq!(told.len(), 2, "both went out: {told:?}");
    assert_eq!((told[0]["text"].as_str(), told[1]["text"].as_str()), (Some("在这里。"), Some("还有这个。")));
    assert_eq!(h.api.requests().len(), 2, "no request wasted on a refusal");
}

/// A question whose answers cannot be listed is still a question (2 of 12 were refused before).
#[tokio::test]
async fn a_question_may_have_no_options_and_still_ends_the_turn() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![Script::tool_call("c1", "send_to_user", json!({ "type": "question", "text": "发给谁？" }))],
    )
    .await;
    let result = h.kernel.run(prompt("发出去")).await.unwrap();
    assert!(matches!(result.end, TaskEnd::Completed { .. }));
    assert_eq!(sent(&result.events), ["发给谁？"]);
    assert_eq!(h.api.requests().len(), 1);
}

#[tokio::test]
async fn options_without_a_type_make_a_question() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![Script::tool_call("c1", "send_to_user", json!({ "text": "发给谁？", "options": [{ "label": "财务组" }] }))],
    )
    .await;
    h.kernel.run(prompt("发出去")).await.unwrap();
    assert_eq!(h.api.requests().len(), 1, "a question ends the turn");
}

#[tokio::test]
async fn a_question_ends_the_turn_and_its_answer_is_an_ordinary_message() {
    let question = json!({ "type": "question", "text": "发给谁？", "options": [{ "label": "财务组" }, { "label": "全部门" }] });
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![Script::tool_call("c1", "send_to_user", question), send_last("c2", "发好了。")],
    )
    .await;
    let result = h.kernel.run(prompt("整理好发出去")).await.unwrap();
    assert!(matches!(result.end, TaskEnd::Completed { .. }));
    assert_eq!(sent(&result.events), ["发给谁？"]);
    assert_eq!(h.api.requests().len(), 1, "no end_turn needed: it waits for the answer");
    let result = h.kernel.run(prompt("财务组")).await.unwrap();
    assert_eq!(sent(&result.events), ["发好了。"]);
    let requests = h.api.requests();
    let Some(Message::User(answer)) = requests[1].messages.last() else {
        panic!("the answer is the owner's message")
    };
    assert_eq!(answer.text_content(), "财务组");
    assert!(!requests[1].messages.iter().any(|m| texts(m).contains("<reply_reminder>")), "a question is a reply");
}

#[tokio::test]
async fn a_type_takes_its_own_parameters_and_says_what_is_wrong() {
    let cases = [
        (json!({ "type": "attachment" }), "give at least one file"),
        (json!({ "type": "text", "text": "你好", "files": [{ "path": "a" }] }), "files goes with type attachment"),
        (json!({ "type": "text", "text": "你好", "options": [{ "label": "好" }] }), "options goes with type question"),
        (json!({ "text": "你好", "files": [{ "path": "a" }], "options": [{ "label": "好" }] }), "options goes with type question"),
        (json!({ "type": "question", "options": [{ "label": "好" }] }), "text must not be empty"),
        (json!({ "type": "question", "text": "好吗", "options": [{ "label": " " }] }), "label must not be empty"),
        (json!({ "type": "question", "text": "好吗", "options": [{ "label": "好" }, { "label": "好" }] }), "the same label: 好"),
        (json!({ "type": "image", "text": "你好" }), "unknown variant"),
    ];
    for (args, expected) in cases {
        let mut h = bot(
            "FinxBot",
            PermissionMode::Manual,
            vec![Script::tool_call("c1", "send_to_user", args.clone()), send_last("c2", "好的。")],
        )
        .await;
        let result = h.kernel.run(prompt("hi")).await.unwrap();
        assert!(matches!(result.end, TaskEnd::Completed { .. }));
        let told = results(&h);
        assert!(told[0].0 && told[0].1.contains(expected), "{args}: {told:?}");
    }
}

#[tokio::test]
async fn an_empty_value_counts_as_left_out() {
    let mut h = bot(
        "FinxBot",
        PermissionMode::Manual,
        vec![Script::tool_call(
            "c1",
            "send_to_user",
            json!({ "type": "text", "text": "你好", "files": [], "options": [], "end_turn": true }),
        )],
    )
    .await;
    let result = h.kernel.run(prompt("hi")).await.unwrap();
    assert_eq!(sent(&result.events), ["你好"]);
    assert_eq!(h.api.requests().len(), 1);
}

/// What every request carries: plain enough for any provider (bot-design §3.12).
#[tokio::test]
async fn the_tools_parameters_are_flat_with_a_plain_enum() {
    let mut h = bot("FinxBot", PermissionMode::Manual, vec![send_last("c1", "好的。")]).await;
    h.kernel.run(prompt("hi")).await.unwrap();
    let requests = h.api.requests();
    let tool = requests[0].tools.iter().find(|t| t.name == "send_to_user").unwrap();
    let schema = &tool.parameters;
    assert_eq!(schema["properties"]["type"]["type"], "string");
    assert_eq!(schema["properties"]["type"]["enum"], json!(["text", "attachment", "question"]));
    assert!(schema.get("required").is_none_or(|r| r.as_array().unwrap().is_empty()), "{schema}");
    assert_eq!(schema["properties"]["files"]["items"]["required"], json!(["path"]));
    assert_eq!(schema["properties"]["options"]["items"]["required"], json!(["label"]));
    let text = schema.to_string();
    assert!(!text.contains("oneOf") && !text.contains("anyOf") && !text.contains("$ref"), "{text}");
}
