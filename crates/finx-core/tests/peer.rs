//! An external bot's session (bot-contacts-design §5.3): the other side answers, and what it says
//! is recorded exactly as a local bot's `send_to_user` call would be.

use async_trait::async_trait;
use bytes::Bytes;
use finx_core::BotIdentity;
use finx_core::Config;
use finx_core::FinxHome;
use finx_core::JsonlStore;
use finx_core::Kernel;
use finx_core::KernelDeps;
use finx_core::Peer;
use finx_core::PeerError;
use finx_core::PeerEvent;
use finx_core::PeerMessage;
use finx_core::PeerRef;
use finx_core::PeerThread;
use finx_core::StartOptions;
use finx_core::TaskEnd;
use finx_core::store::EntryKind;
use finx_core::store::SessionRef;
use finx_core::store::SessionStore;
use finx_llm::Catalog;
use finx_llm::Message;
use finx_llm::ModelRegistry;
use finx_llm::RegistryOptions;
use finx_llm::ThinkingLevel;
use finx_llm::UserContent;
use finx_llm::api::scripted::Script;
use finx_llm::api::scripted::ScriptedApi;
use finx_protocol::Event;
use finx_protocol::EventMsg;
use finx_protocol::PermissionMode;
use finx_tools::BashTool;
use finx_tools::LocalEnvironment;
use finx_tools::builtin_registry;
use futures::StreamExt;
use futures::stream::BoxStream;
use parking_lot::Mutex;
use serde_json::Value;
use serde_json::json;
use std::collections::VecDeque;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

/// The other side, answering from a fixed script.
struct FakePeer {
    script: Mutex<VecDeque<PeerEvent>>,
    /// After the script, keep the stream open and silent: the other side is slow (§5.5).
    hang: bool,
    sent: Mutex<Vec<PeerMessage>>,
    threads: Mutex<Vec<PeerThread>>,
    cancelled: Mutex<u32>,
}

impl FakePeer {
    fn new(events: Vec<PeerEvent>) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(events.into()),
            hang: false,
            sent: Mutex::new(Vec::new()),
            threads: Mutex::new(Vec::new()),
            cancelled: Mutex::new(0),
        })
    }

    fn stream(&self) -> BoxStream<'static, PeerEvent> {
        let events = self.script.lock().drain(..).collect::<Vec<_>>();
        if self.hang {
            return Box::pin(futures::stream::iter(events).chain(futures::stream::pending()));
        }
        Box::pin(futures::stream::iter(events))
    }

    fn push(&self, events: Vec<PeerEvent>) {
        self.script.lock().extend(events);
    }

    fn hanging(events: Vec<PeerEvent>) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(events.into()),
            hang: true,
            sent: Mutex::new(Vec::new()),
            threads: Mutex::new(Vec::new()),
            cancelled: Mutex::new(0),
        })
    }
}

#[async_trait]
impl Peer for FakePeer {
    async fn send(
        &self,
        message: PeerMessage,
        thread: PeerThread,
        _cancel: CancellationToken,
    ) -> Result<BoxStream<'static, PeerEvent>, PeerError> {
        self.sent.lock().push(message);
        self.threads.lock().push(thread);
        Ok(self.stream())
    }

    async fn resume(
        &self,
        thread: PeerThread,
        _cancel: CancellationToken,
    ) -> Result<BoxStream<'static, PeerEvent>, PeerError> {
        self.threads.lock().push(thread);
        Ok(self.stream())
    }

    async fn cancel(&self, _thread: PeerThread) {
        *self.cancelled.lock() += 1;
    }
}

struct Harness {
    kernel: Kernel,
    home: FinxHome,
    folder: PathBuf,
    store: Arc<dyn SessionStore>,
    _dir: TempDir,
}

fn options(home: &FinxHome, folder: &Path, bot: &str, peer: bool, model: &str) -> StartOptions {
    StartOptions {
        model: model.into(),
        thinking: ThinkingLevel::Off,
        permission_mode: PermissionMode::BypassPermissions,
        cwd: folder.to_path_buf(),
        home: home.clone(),
        config: Arc::new(Config::default()),
        project_root: None,
        trusted: false,
        interactive_approvals: false,
        bot: Some(BotIdentity {
            id: "b1".into(),
            name: bot.into(),
        }),
        peer: peer.then(|| PeerRef {
            host: "peer.example".into(),
        }),
    }
}

fn deps(
    llm: Arc<ModelRegistry>,
    folder: &Path,
    home: &FinxHome,
    peer: Option<Arc<dyn Peer>>,
) -> KernelDeps {
    KernelDeps {
        llm,
        tools: Arc::new(builtin_registry(BashTool::default())),
        env: Arc::new(LocalEnvironment::new(folder.to_path_buf())),
        store: Arc::new(JsonlStore::new(home.sessions_dir())),
        hooks: vec![],
        mcp_servers: Vec::new(),
        browser_pool: None,
        docs: None,
        decks: None,
        words: None,
        routines: None,
        peer,
    }
}

/// A registry with no provider at all: an external bot needs no model (§5.3, D-716).
fn no_models() -> Arc<ModelRegistry> {
    Arc::new(ModelRegistry::new(
        Catalog::default(),
        RegistryOptions::default(),
    ))
}

async fn peer_harness(events: Vec<PeerEvent>) -> (Harness, Arc<FakePeer>) {
    let dir = tempfile::tempdir().unwrap();
    let home = FinxHome::new(dir.path().canonicalize().unwrap().join("home"));
    home.ensure().unwrap();
    let folder = home.bot_files_dir("b1");
    std::fs::create_dir_all(&folder).unwrap();
    let folder = folder.canonicalize().unwrap();
    let peer = FakePeer::new(events);
    let store: Arc<dyn SessionStore> = Arc::new(JsonlStore::new(home.sessions_dir()));
    let mut deps = deps(
        no_models(),
        &folder,
        &home,
        Some(peer.clone() as Arc<dyn Peer>),
    );
    deps.store = store.clone();
    let kernel = Kernel::start(
        options(&home, &folder, "PeerBot", true, "unused/scripted"),
        deps,
    )
    .await
    .unwrap();
    (
        Harness {
            kernel,
            home,
            folder,
            store,
            _dir: dir,
        },
        peer,
    )
}

async fn local_harness(scripts: Vec<Script>) -> Harness {
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
    let mut registry = ModelRegistry::new(Catalog::default(), RegistryOptions::default());
    registry.register_api(api);
    registry.insert_provider(ScriptedApi::provider());
    let store: Arc<dyn SessionStore> = Arc::new(JsonlStore::new(home.sessions_dir()));
    let mut deps = deps(Arc::new(registry), &folder, &home, None);
    deps.store = store.clone();
    let kernel = Kernel::start(
        options(&home, &folder, "LocalBot", false, "test/scripted"),
        deps,
    )
    .await
    .unwrap();
    Harness {
        kernel,
        home,
        folder,
        store,
        _dir: dir,
    }
}

fn prompt(text: &str) -> Vec<UserContent> {
    vec![UserContent::Text { text: text.into() }]
}

/// What downstream code sees of one `send_to_user` message, without the ids and timestamps it
/// makes up on each side.
fn delivered(events: &[Event]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut call = None;
    for event in events {
        match &event.msg {
            EventMsg::MessageCompleted {
                message: Message::Assistant(assistant),
                ..
            } => {
                for content in &assistant.content {
                    if let finx_llm::AssistantContent::ToolCall(tool_call) = content
                        && tool_call.name == "send_to_user"
                    {
                        call = Some(json!({
                            "name": tool_call.name,
                            "args": normalized_args(&tool_call.arguments.to_value()),
                        }));
                    }
                }
            }
            EventMsg::ToolStarted {
                name,
                args,
                category,
                title,
                locations,
                ..
            } if name == "send_to_user" => {
                out.push(json!({
                    "assistant": call.take(),
                    "started": {
                        "name": name,
                        "args": normalized_args(args),
                        "category": category,
                        "title": title,
                        "locations": locations,
                    },
                }));
            }
            EventMsg::ToolCompleted { result, .. } if result.tool_name == "send_to_user" => {
                out.last_mut().unwrap()["completed"] = json!({
                    "tool_name": result.tool_name,
                    "content": result.content,
                    "is_error": result.is_error,
                    "details": result.details.as_ref().map(|details| details.to_value()),
                });
            }
            _ => {}
        }
    }
    out
}

/// A model's call and the kernel's own differ in the defaults each leaves out: `type` is text
/// when absent, and `end_turn` means nothing to the other side.
fn normalized_args(args: &Value) -> Value {
    let mut args = args.clone();
    if let Some(map) = args.as_object_mut() {
        map.remove("end_turn");
        map.remove("type");
    }
    args
}

fn entries(store: &Arc<dyn SessionStore>, session: &str) -> Vec<EntryKind> {
    let (_, entries) = store.read(&SessionRef::Id(session.to_string())).unwrap();
    entries.into_iter().map(|entry| entry.kind).collect()
}

#[tokio::test]
async fn the_other_side_answers_without_any_model() {
    let (mut h, peer) = peer_harness(vec![
        PeerEvent::Thread(PeerThread {
            context_id: Some("ctx-1".into()),
            task_id: Some("task-1".into()),
            ..Default::default()
        }),
        PeerEvent::Working,
        PeerEvent::Said {
            text: "hello from the other side".into(),
        },
        PeerEvent::Done,
    ])
    .await;
    let result = h.kernel.run(prompt("hello")).await.unwrap();
    assert!(matches!(result.end, TaskEnd::Completed { .. }));
    let messages = peer.sent.lock();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].text, "hello");
    assert!(!messages[0].id.is_empty());

    let calls = delivered(&result.events);
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0]["started"]["args"]["text"],
        "hello from the other side"
    );
    assert_eq!(calls[0]["completed"]["content"][0]["text"], "Sent.");
}

#[tokio::test]
async fn the_three_steps_are_the_same_as_a_local_bots() {
    let mut local = local_harness(vec![Script::tool_call(
        "call-1",
        "send_to_user",
        json!({ "text": "same words", "end_turn": true }),
    )])
    .await;
    let local_events = local.kernel.run(prompt("say it")).await.unwrap().events;
    let local_steps = delivered(&local_events);
    assert_eq!(local_steps.len(), 1, "the local bot sent once");

    let (mut peer, _) = peer_harness(vec![
        PeerEvent::Thread(PeerThread {
            context_id: Some("ctx".into()),
            task_id: None,
            ..Default::default()
        }),
        PeerEvent::Said {
            text: "same words".into(),
        },
        PeerEvent::Done,
    ])
    .await;
    let peer_events = peer.kernel.run(prompt("say it")).await.unwrap().events;
    let peer_steps = delivered(&peer_events);
    assert_eq!(peer_steps.len(), 1, "the other side said one thing");
    assert_eq!(local_steps, peer_steps);
}

#[tokio::test]
async fn a_local_bots_message_gets_a_reply_nudge_and_an_external_ones_does_not() {
    let mut local = local_harness(vec![Script::tool_call(
        "call-1",
        "send_to_user",
        json!({ "text": "hi", "end_turn": true }),
    )])
    .await;
    local.kernel.run(prompt("hello")).await.unwrap();
    let kinds = entries(&local.store, local.kernel.session_id());
    assert!(
        kinds
            .iter()
            .any(|kind| matches!(kind, EntryKind::ReplyNudge))
    );

    let (mut peer, _) = peer_harness(vec![
        PeerEvent::Thread(PeerThread {
            context_id: Some("ctx".into()),
            task_id: None,
            ..Default::default()
        }),
        PeerEvent::Said { text: "hi".into() },
        PeerEvent::Done,
    ])
    .await;
    peer.kernel.run(prompt("hello")).await.unwrap();
    let kinds = entries(&peer.store, peer.kernel.session_id());
    assert!(
        !kinds
            .iter()
            .any(|kind| matches!(kind, EntryKind::ReplyNudge))
    );
    // The other side's conversation is in the log, for the next message to carry on (D-716).
    assert!(
        kinds
            .iter()
            .any(|kind| matches!(kind, EntryKind::PeerThread(_)))
    );
    let _ = (&local.home, &peer.home);
}

#[tokio::test]
async fn a_file_from_the_other_side_lands_in_the_bots_folder_with_a_clean_name() {
    let (mut h, _) = peer_harness(vec![
        PeerEvent::File {
            name: "../../.bashrc".into(),
            media_type: Some("text/plain".into()),
            bytes: Bytes::from_static(b"#!/bin/sh\n"),
        },
        PeerEvent::Done,
    ])
    .await;
    let result = h.kernel.run(prompt("send a file")).await.unwrap();
    let calls = delivered(&result.events);
    assert_eq!(calls.len(), 1);
    let details = &calls[0]["completed"]["details"];
    assert_eq!(details["files"][0]["size"], 10);
    let path = details["files"][0]["path"].as_str().unwrap();
    assert!(!path.contains(".."), "the name was cleaned: {path}");
    assert!(path.starts_with(h.folder.to_str().unwrap()));
    assert!(std::path::Path::new(path).exists());
    assert!(
        !path.ends_with(".bashrc"),
        "a leading dot becomes an underscore: {path}"
    );
}

#[tokio::test]
async fn the_context_identifier_is_carried_to_the_next_message() {
    let (mut h, peer) = peer_harness(vec![
        PeerEvent::Thread(PeerThread {
            context_id: Some("ctx-1".into()),
            task_id: Some("task-1".into()),
            ..Default::default()
        }),
        PeerEvent::Said {
            text: "first".into(),
        },
        PeerEvent::Done,
    ])
    .await;
    h.kernel.run(prompt("one")).await.unwrap();
    // The second round: the script is empty, so the other side says nothing and the task fails
    // with no_reply; what matters here is the thread it was given.
    let _ = h.kernel.run(prompt("two")).await;
    let threads = peer.threads.lock();
    assert!(threads.len() >= 2, "the second round asked the other side");
    // The first message starts the conversation; from then on each round carries its
    // identifier (§5.5).
    assert!(threads[0].context_id.is_none());
    assert!(
        threads[1..]
            .iter()
            .all(|thread| thread.context_id.as_deref() == Some("ctx-1"))
    );
}

#[tokio::test]
async fn no_answer_from_the_other_side_fails_the_task_with_no_reply() {
    let (mut h, _) = peer_harness(vec![PeerEvent::Working, PeerEvent::Done]).await;
    let result = h.kernel.run(prompt("hello")).await.unwrap();
    match result.end {
        TaskEnd::Failed(error) => assert_eq!(error.kind, "no_reply"),
        other => panic!("expected a failure, got {other:?}"),
    }
}
#[tokio::test]
async fn waiting_for_the_other_side_can_be_stopped() {
    let dir = tempfile::tempdir().unwrap();
    let home = FinxHome::new(dir.path().canonicalize().unwrap().join("home"));
    home.ensure().unwrap();
    let folder = home.bot_files_dir("b1");
    std::fs::create_dir_all(&folder).unwrap();
    let folder = folder.canonicalize().unwrap();
    let peer = FakePeer::hanging(vec![
        PeerEvent::Thread(PeerThread {
            context_id: Some("ctx".into()),
            task_id: Some("task-1".into()),
            ..Default::default()
        }),
        PeerEvent::Working,
    ]);
    let store: Arc<dyn SessionStore> = Arc::new(JsonlStore::new(home.sessions_dir()));
    let mut kdeps = deps(
        no_models(),
        &folder,
        &home,
        Some(peer.clone() as Arc<dyn Peer>),
    );
    kdeps.store = store;
    let mut kernel = Kernel::start(
        options(&home, &folder, "PeerBot", true, "unused/scripted"),
        kdeps,
    )
    .await
    .unwrap();
    kernel
        .submit(finx_protocol::Op::Prompt {
            input: prompt("hello"),
            mode: finx_protocol::PromptMode::Steer,
            commands: true,
        })
        .await
        .unwrap();
    // Until the other side has the task, then stop: the kernel asks it to cancel (§5.5).
    let mut stopped = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        let Some(event) = kernel.next_event().await else {
            break;
        };
        if matches!(event.msg, EventMsg::MessageCompleted { .. }) {
            kernel.submit(finx_protocol::Op::Interrupt).await.unwrap();
        }
        if let EventMsg::TaskInterrupted { .. } = event.msg {
            stopped = true;
            break;
        }
    }
    assert!(stopped, "the task stopped");
    assert_eq!(
        *peer.cancelled.lock(),
        1,
        "the other side was asked to cancel"
    );
    let _ = kernel.shutdown().await;
}

#[tokio::test]
async fn a_resumed_session_carries_the_conversation_on() {
    let dir = tempfile::tempdir().unwrap();
    let home = FinxHome::new(dir.path().canonicalize().unwrap().join("home"));
    home.ensure().unwrap();
    let folder = home.bot_files_dir("b1");
    std::fs::create_dir_all(&folder).unwrap();
    let folder = folder.canonicalize().unwrap();
    let store: Arc<dyn SessionStore> = Arc::new(JsonlStore::new(home.sessions_dir()));
    let first = FakePeer::new(vec![
        PeerEvent::Thread(PeerThread {
            context_id: Some("ctx-1".into()),
            task_id: None,
            ..Default::default()
        }),
        PeerEvent::Said {
            text: "first".into(),
        },
        PeerEvent::Done,
    ]);
    let mut kdeps = deps(no_models(), &folder, &home, Some(first as Arc<dyn Peer>));
    kdeps.store = store.clone();
    let mut kernel = Kernel::start(
        options(&home, &folder, "PeerBot", true, "unused/scripted"),
        kdeps,
    )
    .await
    .unwrap();
    let session = kernel.session_id().to_string();
    kernel.run(prompt("hello")).await.unwrap();
    kernel.shutdown().await;

    let second = FakePeer::new(vec![
        PeerEvent::Said {
            text: "second".into(),
        },
        PeerEvent::Done,
    ]);
    let mut kdeps = deps(
        no_models(),
        &folder,
        &home,
        Some(second.clone() as Arc<dyn Peer>),
    );
    kdeps.store = store;
    let mut kernel = Kernel::resume(
        finx_core::ResumeOptions {
            session: SessionRef::Id(session.clone()),
            model: None,
            thinking: None,
            permission_mode: None,
            home: home.clone(),
            config: Arc::new(Config::default()),
            project_root: None,
            trusted: false,
            interactive_approvals: false,
            bot_name: None,
            peer: Some(second.clone() as Arc<dyn Peer>),
        },
        kdeps,
    )
    .await
    .unwrap();
    kernel.run(prompt("and again")).await.unwrap();
    // The identifier from the log went with the second message (§5.5).
    assert_eq!(
        second.threads.lock()[0].context_id.as_deref(),
        Some("ctx-1")
    );
    let _ = &home;
}

#[tokio::test]
async fn a_new_message_does_not_carry_a_failed_task_but_does_carry_a_question() {
    let (mut h, peer) = peer_harness(vec![
        PeerEvent::Thread(PeerThread {
            context_id: Some("ctx".into()),
            task_id: Some("task-1".into()),
            ..Default::default()
        }),
        PeerEvent::Failed(PeerError::new("bot_peer_failed", "the other side broke")),
    ])
    .await;
    let failed = h.kernel.run(prompt("one")).await.unwrap();
    assert!(matches!(failed.end, TaskEnd::Failed(_)));

    // A new message starts a new task on the other side: the failed one does not go along
    // (§5.4), while the conversation does.
    peer.push(vec![
        PeerEvent::Said {
            text: "again".into(),
        },
        PeerEvent::Done,
    ]);
    h.kernel.run(prompt("two")).await.unwrap();
    assert_eq!(peer.threads.lock()[1].task_id, None);
    assert_eq!(peer.threads.lock()[1].context_id.as_deref(), Some("ctx"));

    // A question leaves the task open: the answer belongs to it.
    peer.push(vec![
        PeerEvent::Thread(PeerThread {
            context_id: Some("ctx".into()),
            task_id: Some("task-2".into()),
            ..Default::default()
        }),
        PeerEvent::Asked {
            text: "what is your name?".into(),
        },
    ]);
    h.kernel.run(prompt("ask")).await.unwrap();
    peer.push(vec![
        PeerEvent::Said {
            text: "thanks".into(),
        },
        PeerEvent::Done,
    ]);
    h.kernel.run(prompt("Ada")).await.unwrap();
    let threads = peer.threads.lock();
    assert_eq!(threads.last().unwrap().task_id.as_deref(), Some("task-2"));
}
