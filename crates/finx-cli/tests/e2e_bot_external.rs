//! Another subject's bot over the native protocol (docs/kernel/bot-contacts-design.md §4.2,
//! §5): a real `finx serve`, a real card on loopback, no model at all.

mod common;

use common::TestEnv;
use common::WAIT;
use common::native_init;
use finx_rpc::Client;
use finx_rpc::RpcError;
use serde_json::Value;
use serde_json::json;
use std::io::BufRead;
use std::io::BufReader;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use tokio::sync::mpsc;
use finx_rpc::IncomingRx;

const CONFIG: &str = "[bots]\nexternal = true\nallow_local = true";

/// `tools/a2a-fake`, killed when the test ends.
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

fn fake(flags: &[&str]) -> Fake {
    let server = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools/a2a-fake/server.mjs");
    let mut child = Command::new("node")
        .arg(server)
        .arg("--port")
        .arg("0")
        .args(flags)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("node and the fake peer");
    let stdout = child.stdout.take().expect("the fake's stdout");
    let mut line = String::new();
    BufReader::new(stdout).read_line(&mut line).expect("the fake's address");
    let url = line.trim().strip_prefix("listening on ").expect("the startup line").to_string();
    Fake { child, url }
}

fn kind(error: RpcError) -> String {
    error.data.and_then(|data| data["kind"].as_str().map(str::to_string)).unwrap_or_default()
}

async fn say(client: &Client, session: &str, text: &str) {
    client
        .request(
            "session/op",
            json!({"session_id": session, "op": {"type": "prompt", "input": [{"type": "text", "text": text}]}}),
        )
        .await
        .expect("prompt accepted");
}

fn route(mut incoming: IncomingRx) -> mpsc::UnboundedReceiver<Value> {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(message) = incoming.recv().await {
            if message.method() == "session/event" {
                let _ = tx.send(message.params()["event"].clone());
            }
        }
    });
    rx
}

async fn until_end(events: &mut mpsc::UnboundedReceiver<Value>) -> Vec<Value> {
    let mut seen = Vec::new();
    loop {
        let event = tokio::time::timeout(WAIT, events.recv()).await.expect("timed out").expect("closed");
        let done = matches!(event["type"].as_str(), Some("task_completed" | "task_failed" | "task_interrupted"));
        seen.push(event);
        if done {
            return seen;
        }
    }
}

fn sent(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter(|e| e["type"] == "tool_started" && e["name"] == "send_to_user")
        .filter_map(|e| e["args"]["text"].as_str().map(str::to_string))
        .collect()
}

async fn preview(client: &Client, url: &str) -> Value {
    client.request("bots/preview", json!({"url": url})).await.expect("a card")
}

#[tokio::test]
async fn a_card_is_added_and_its_conversation_carries_on_across_a_restart() {
    let env = TestEnv::new("manual", CONFIG).await;
    let fake = fake(&["--images", "--provider"]);
    let (mut child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut events = route(incoming);

    let card = preview(&client, &fake.url).await;
    let host = fake.url.trim_start_matches("http://");
    assert_eq!(card["host"], host);
    assert_eq!(card["provider"], "A2A Fake");
    assert!(card["accepts"].as_array().unwrap().contains(&json!("image")));
    assert_eq!(card["auth"], "none");
    eprintln!("preview: {} from {} — {} skills, accepts {:?}", card["name"], card["host"], card["skills"].as_array().map(Vec::len).unwrap_or(0), card["accepts"]);
    let sha = card["card_sha256"].as_str().unwrap().to_string();

    let added = client
        .request("bots/add", json!({"url": fake.url, "card_sha256": sha}))
        .await
        .expect("added");
    let bot = added["bot"]["id"].as_str().unwrap().to_string();
    assert_eq!(added["bot"]["source"]["kind"], "remote");
    assert_eq!(added["bot"]["source"]["protocol"], "a2a");
    assert!(added["bot"]["source"]["noticed"].is_null(), "noticed is false until the first message");
    assert_eq!(added["bot"]["source"]["host"], host);

    eprintln!("added bot {bot} (source host {host})");
    // `bot.json` is version 2 with the source; nothing secret is in it (there is none here).
    let file = std::fs::read_to_string(env.home.path().join("bots").join(&bot).join("bot.json")).unwrap();
    assert!(file.contains("\"version\": 2"), "{file}");
    assert!(file.contains("\"kind\": \"remote\""), "{file}");

    let opened = client
        .request(
            "bots/open",
            json!({"bot_id": bot, "events": {"exclude": ["text_delta", "thinking_delta", "tool_call_delta", "tool_progress"]}}),
        )
        .await
        .expect("opened");
    let session = opened["session_id"].as_str().unwrap().to_string();

    say(&client, &session, "你好").await;
    let first = until_end(&mut events).await;
    eprintln!("turn 1: {:?}", sent(&first));
    assert_eq!(sent(&first), ["hello (1)"]);
    // The reply is marked as the other side's, not this machine's model.
    let reply = first
        .iter()
        .find(|e| e["type"] == "message_completed" && e["message"]["role"] == "assistant")
        .expect("the reply's message");
    assert_eq!(reply["message"]["provider"], "a2a");
    assert_eq!(reply["message"]["model"], host);

    // An image goes along (the card takes images); its words still answer.
    client
        .request(
            "session/op",
            json!({"session_id": session, "op": {"type": "prompt", "input": [
                {"type": "text", "text": "这张图是什么"},
                {"type": "image", "mime_type": "image/png", "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="}
            ]}}),
        )
        .await
        .expect("image prompt accepted");
    let second = until_end(&mut events).await;
    eprintln!("turn 2 (with a picture): {:?}", sent(&second));
    assert_eq!(sent(&second).len(), 1);

    eprintln!("turn 3 asks for a file");
    say(&client, &session, "file").await;
    let third = until_end(&mut events).await;
    let attachment = third.iter().find(|e| e["type"] == "tool_started" && e["args"]["type"] == "attachment").expect("a file");
    eprintln!("file kept at {}", attachment["args"]["files"][0]["path"]);
    assert!(attachment["args"]["files"][0]["path"].as_str().unwrap().contains("/files/"));

    // The application restarts; the conversation is resumed and carries on.
    drop(client);
    let _ = child.kill();
    let _ = child.wait();
    let (_child2, client2, incoming2) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client2).await;
    let mut events2 = route(incoming2);
    let opened = client2
        .request(
            "bots/open",
            json!({"bot_id": bot, "events": {"exclude": ["text_delta", "thinking_delta", "tool_call_delta", "tool_progress"]}}),
        )
        .await
        .expect("opened again");
    let session2 = opened["session_id"].as_str().unwrap().to_string();
    say(&client2, &session2, "刚才说了什么").await;
    let fourth = until_end(&mut events2).await;
    eprintln!("after a restart: {:?}", sent(&fourth));
    let said = sent(&fourth);
    assert!(said.first().is_some_and(|text| text.contains("you said")), "{said:?}");
}

#[tokio::test]
async fn a_card_that_cannot_be_read_or_used_says_why() {
    let env = TestEnv::new("manual", CONFIG).await;
    let fake = fake(&[]);
    let (_child, client, _incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;

    let unreachable = client.request("bots/preview", json!({"url": "http://localhost:1/"})).await.unwrap_err();
    assert_eq!(kind(unreachable), "bot_card_unreachable");

    let invalid = client.request("bots/preview", json!({"url": fake.url.clone() + "/bad-card"})).await.unwrap_err();
    assert_eq!(kind(invalid), "bot_card_invalid");

    let moved = client.request("bots/preview", json!({"url": fake.url.clone() + "/card-elsewhere"})).await.unwrap_err();
    assert_eq!(moved.data.as_ref().unwrap()["host"], "example.com");
    assert_eq!(kind(moved), "bot_card_moved");

    // Previewed, then the card changed before the owner confirmed.
    let sha = (preview(&client, &fake.url).await)["card_sha256"].as_str().unwrap().to_string();
    let changed = client
        .request("bots/add", json!({"url": fake.url, "card_sha256": "not-the-card"}))
        .await
        .unwrap_err();
    assert_eq!(kind(changed), "bot_card_changed");
    // With the card it saw, the same add works.
    client
        .request("bots/add", json!({"url": fake.url, "card_sha256": sha}))
        .await
        .expect("added");
}

#[tokio::test]
async fn a_credential_stays_out_of_the_bot_file_and_its_answers() {
    let env = TestEnv::new("manual", CONFIG).await;
    let fake = fake(&["--auth"]);
    let (_child, client, _incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;

    let card = preview(&client, &fake.url).await;
    assert_eq!(card["auth"], "api_key");
    // Without the credential the bot cannot be added.
    let missing = client
        .request("bots/add", json!({"url": fake.url, "card_sha256": card["card_sha256"]}))
        .await
        .unwrap_err();
    assert_eq!(kind(missing), "bot_auth_required");

    let added = client
        .request(
            "bots/add",
            json!({"url": fake.url, "card_sha256": card["card_sha256"], "credential": "test-key"}),
        )
        .await
        .expect("added with its key");
    let bot = added["bot"]["id"].as_str().unwrap().to_string();
    let text = serde_json::to_string(&added).unwrap();
    assert!(!text.contains("test-key"), "the credential is not in the answer: {text}");
    let file = std::fs::read_to_string(env.home.path().join("bots").join(&bot).join("bot.json")).unwrap();
    assert!(!file.contains("test-key"), "the credential is not in bot.json: {file}");
    // It is in the credential store, under the bot's name.
    fn walk(dir: &std::path::Path, out: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if let Ok(text) = std::fs::read_to_string(&path) {
                out.push(text);
            }
        }
    }
    let mut files = Vec::new();
    walk(env.home.path(), &mut files);
    assert!(
        files.iter().any(|text| text.contains("bot.") && text.contains("test-key")),
        "the credential was kept by the credential store"
    );
}