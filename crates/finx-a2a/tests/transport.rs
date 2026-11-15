//! The transport end to end against `tools/a2a-fake` (bot-contacts-design §11): the card, two
//! rounds of a conversation, a question, files, and no answer at all. No real model, no network
//! beyond loopback, nothing that needs a credential.

use std::io::BufRead;
use std::io::BufReader;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;

use finx_a2a::A2aPeer;
use finx_a2a::Source;
use finx_a2a::card::Card;
use finx_a2a::card::CardOptions;
use finx_core::BotIdentity;
use finx_core::Config;
use finx_core::FinxHome;
use finx_core::JsonlStore;
use finx_core::Kernel;
use finx_core::KernelDeps;
use finx_core::PeerRef;
use finx_core::StartOptions;
use finx_core::TaskEnd;
use finx_llm::Catalog;
use finx_llm::ModelRegistry;
use finx_llm::RegistryOptions;
use finx_llm::ThinkingLevel;
use finx_llm::UserContent;
use finx_protocol::Event;
use finx_protocol::EventMsg;
use finx_protocol::PermissionMode;
use finx_tools::BashTool;
use finx_tools::LocalEnvironment;
use finx_tools::builtin_registry;
use serde_json::Value;
use tempfile::TempDir;

/// The fake peer, killed when the test ends.
struct Fake {
    child: Child,
    url: String,
}

impl Drop for Fake {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn fake(extra: &[&str]) -> Option<Fake> {
    let Ok(version) = Command::new("node").arg("--version").output() else {
        return None;
    };
    if !version.status.success() {
        return None;
    }
    let server = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools/a2a-fake/server.mjs");
    let mut child = Command::new("node")
        .arg(server)
        .arg("--port")
        .arg("0")
        .args(extra)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("start the fake peer");
    let stdout = child.stdout.take().expect("the fake's stdout");
    let mut line = String::new();
    BufReader::new(stdout)
        .read_line(&mut line)
        .expect("the fake's address");
    let url = line
        .trim()
        .strip_prefix("listening on ")
        .expect("the startup line")
        .to_string();
    Some(Fake { child, url })
}

struct Harness {
    kernel: Kernel,
    folder: PathBuf,
    _dir: TempDir,
}

async fn harness(url: &str) -> Harness {
    let card = Card::read(url, &CardOptions { allow_local: true })
        .await
        .expect("the card");
    let host = reqwest::Url::parse(&card.endpoint.url)
        .unwrap()
        .host_str()
        .unwrap()
        .to_string();
    let peer = A2aPeer::new(Source {
        endpoint: card.endpoint.url.clone(),
        host: host.clone(),
        tenant: card.endpoint.tenant.clone(),
        auth: card.auth.clone(),
        allow_local: true,
    });
    let dir = tempfile::tempdir().unwrap();
    let home = FinxHome::new(dir.path().canonicalize().unwrap().join("home"));
    home.ensure().unwrap();
    let folder = home.bot_files_dir("b1");
    std::fs::create_dir_all(&folder).unwrap();
    let folder = folder.canonicalize().unwrap();
    let deps = KernelDeps {
        llm: Arc::new(ModelRegistry::new(
            Catalog::default(),
            RegistryOptions::default(),
        )),
        tools: Arc::new(builtin_registry(BashTool::default())),
        env: Arc::new(LocalEnvironment::new(folder.clone())),
        store: Arc::new(JsonlStore::new(home.sessions_dir())),
        hooks: vec![],
        mcp_servers: Vec::new(),
        browser_pool: None,
        docs: None,
        decks: None,
        words: None,
        routines: None,
        peer: Some(Arc::new(peer)),
    };
    let options = StartOptions {
        model: "a2a".into(),
        thinking: ThinkingLevel::Off,
        permission_mode: PermissionMode::BypassPermissions,
        cwd: folder.clone(),
        home,
        config: Arc::new(Config::default()),
        project_root: None,
        trusted: false,
        interactive_approvals: false,
        bot: Some(BotIdentity {
            id: "b1".into(),
            name: "A2A Fake".into(),
        }),
        peer: Some(PeerRef { host }),
        group: None,
    };
    let kernel = Kernel::start(options, deps).await.unwrap();
    Harness {
        kernel,
        folder,
        _dir: dir,
    }
}

fn prompt(text: &str) -> Vec<UserContent> {
    vec![UserContent::Text { text: text.into() }]
}

/// What the owner saw: each `send_to_user` call's arguments.
fn bubbles(events: &[Event]) -> Vec<Value> {
    events
        .iter()
        .filter_map(|event| match &event.msg {
            EventMsg::ToolStarted { name, args, .. } if name == "send_to_user" => {
                Some(args.clone())
            }
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn two_rounds_of_a_conversation() {
    let Some(fake) = fake(&[]) else { return };
    let mut h = harness(&fake.url).await;
    let first = h.kernel.run(prompt("你好")).await.unwrap();
    assert!(matches!(first.end, TaskEnd::Completed { .. }));
    let shown = bubbles(&first.events);
    assert_eq!(shown.len(), 1);
    assert!(
        shown[0]["text"].as_str().unwrap().contains("hello (1)"),
        "{shown:?}"
    );

    let second = h.kernel.run(prompt("刚才说了什么")).await.unwrap();
    let shown = bubbles(&second.events);
    assert!(
        shown[0]["text"]
            .as_str()
            .unwrap()
            .contains("you said: 你好"),
        "{shown:?}"
    );
    h.kernel.shutdown().await;
}

#[tokio::test]
async fn a_question_and_the_answer_to_it() {
    let Some(fake) = fake(&[]) else { return };
    let mut h = harness(&fake.url).await;
    let asked = h.kernel.run(prompt("ask")).await.unwrap();
    let shown = bubbles(&asked.events);
    assert_eq!(shown[0]["type"], "question", "{shown:?}");
    assert!(
        shown[0]["text"]
            .as_str()
            .unwrap()
            .contains("What is your name?")
    );

    // The answer goes to the same task on the other side (§5.3).
    let answered = h.kernel.run(prompt("Ada")).await.unwrap();
    let shown = bubbles(&answered.events);
    assert!(
        shown[0]["text"].as_str().unwrap().contains("thanks, Ada"),
        "{shown:?}"
    );
    h.kernel.shutdown().await;
}

#[tokio::test]
async fn files_from_the_other_side_are_kept_in_the_bots_folder() {
    let Some(fake) = fake(&[]) else { return };
    let mut h = harness(&fake.url).await;
    let result = h.kernel.run(prompt("file")).await.unwrap();
    let shown = bubbles(&result.events);
    assert_eq!(shown[0]["type"], "attachment", "{shown:?}");
    let details = result
        .events
        .iter()
        .find_map(|event| match &event.msg {
            EventMsg::ToolCompleted { result, .. } if result.tool_name == "send_to_user" => {
                result.details.as_ref().map(|details| details.to_value())
            }
            _ => None,
        })
        .expect("the attachment's details");
    let path = details["files"][0]["path"].as_str().unwrap();
    assert!(path.starts_with(h.folder.to_str().unwrap()), "{path}");
    let bytes = std::fs::read(path).unwrap();
    assert!(
        bytes.starts_with(b"%PDF"),
        "it is the file the other side gave"
    );
    h.kernel.shutdown().await;
}

#[tokio::test]
async fn an_empty_answer_is_a_failure() {
    let Some(fake) = fake(&[]) else { return };
    let mut h = harness(&fake.url).await;
    let result = h.kernel.run(prompt("empty")).await.unwrap();
    match result.end {
        TaskEnd::Failed(error) => assert_eq!(error.kind, "no_reply"),
        other => panic!("expected no_reply, got {other:?}"),
    }
    h.kernel.shutdown().await;
}

#[tokio::test]
async fn the_other_side_failing_is_a_failure_with_its_words() {
    let Some(fake) = fake(&[]) else { return };
    let mut h = harness(&fake.url).await;
    let result = h.kernel.run(prompt("fail")).await.unwrap();
    match result.end {
        TaskEnd::Failed(error) => {
            assert_eq!(error.kind, "bot_peer_failed", "{error:?}");
            assert!(error.message.contains("the fake failed"), "{error:?}");
        }
        other => panic!("expected a failure, got {other:?}"),
    }
    h.kernel.shutdown().await;
}

#[tokio::test]
async fn a_stalled_stream_is_picked_up_again() {
    let Some(fake) = fake(&[]) else { return };
    let mut h = harness(&fake.url).await;
    let result = h.kernel.run(prompt("drop")).await.unwrap();
    // The stream broke after two fragments; what the other side finished is delivered once.
    let shown = bubbles(&result.events);
    assert_eq!(shown.len(), 1, "{shown:?}");
    assert!(
        shown[0]["text"].as_str().unwrap().contains("drop reply"),
        "{shown:?}"
    );
    h.kernel.shutdown().await;
}
