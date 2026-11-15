//! External bots in groups, over the native protocol (bot-group-chat-dev-brief §6 M6, §7 3–8):
//! a real `finx serve`, the A2A fake on loopback, and no model for the group itself.

mod common;

use common::TestEnv;
use common::WAIT;
use common::native_init;
use finx_rpc::Client;
use finx_rpc::IncomingRx;
use serde_json::Value;
use serde_json::json;
use std::io::BufRead;
use std::io::BufReader;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use tokio::sync::mpsc;

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

struct Wire {
    messages: mpsc::UnboundedReceiver<Value>,
    approvals: mpsc::UnboundedReceiver<Value>,
}

fn route(mut incoming: IncomingRx) -> Wire {
    let (tx, messages) = mpsc::unbounded_channel();
    let (atx, approvals) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(message) = incoming.recv().await {
            match message.method() {
                "group/message" => {
                    let _ = tx.send(message.params().clone());
                }
                "group/approval" => {
                    let _ = atx.send(message.params().clone());
                }
                _ => {}
            }
        }
    });
    Wire { messages, approvals }
}

async fn until_message(wire: &mut Wire, group: &str, want: impl Fn(&Value) -> bool) -> Value {
    loop {
        let params = tokio::time::timeout(WAIT, wire.messages.recv())
            .await
            .expect("timed out waiting for group/message")
            .expect("closed");
        if params["group_id"] == group && want(&params["message"]) {
            return params["message"].clone();
        }
    }
}

async fn no_bot_message(wire: &mut Wire, group: &str, wait: std::time::Duration) {
    let seen = tokio::time::timeout(wait, until_message(wire, group, |m| m["from"]["kind"] == "bot")).await;
    assert!(seen.is_err(), "the external bot must stay quiet");
}

async fn add_external(client: &Client, fake: &Fake) -> String {
    let card = client.request("bots/preview", json!({"url": fake.url})).await.expect("a card");
    let sha = card["card_sha256"].as_str().unwrap().to_string();
    let added = client
        .request("bots/add", json!({"url": fake.url, "card_sha256": sha}))
        .await
        .expect("bots/add");
    added["bot"]["id"].as_str().unwrap().to_string()
}

async fn create_group(client: &Client, name: &str, members: Value) -> String {
    let made = client
        .request("groups/create", json!({"name": name, "members": members}))
        .await
        .expect("groups/create");
    made["id"].as_str().unwrap().to_string()
}

fn requests(fake: &Fake) -> Vec<Value> {
    let out = Command::new("curl")
        .arg("-s")
        .arg(format!("{}/requests", fake.url))
        .output()
        .expect("curl the fake's requests");
    let value: Value = serde_json::from_slice(&out.stdout).expect("the fake's requests");
    value["requests"].as_array().cloned().unwrap_or_default()
}

/// The requests that are group batches, not the stateless probe.
fn group_batches(fake: &Fake) -> Vec<Value> {
    requests(fake)
        .into_iter()
        .filter(|request| {
            let message = &request["body"]["params"]["message"];
            message.get("metadata").and_then(|m| m.get("group")).is_some()
                || message["parts"][0]["text"].as_str().is_some_and(|text| {
                    text.contains("You are in the finx group") || text.contains("【")
                })
        })
        .collect()
}

fn message_of<'a>(batch: &'a Value) -> &'a Value {
    &batch["body"]["params"]["message"]
}

fn part_texts(batch: &Value) -> Vec<String> {
    message_of(batch)["parts"]
        .as_array()
        .map(|parts| parts.iter().filter_map(|part| part["text"].as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn no_context(batch: &Value) -> bool {
    message_of(batch).get("contextId").is_none()
}

fn context_of(batch: &Value) -> Option<String> {
    message_of(batch)["contextId"].as_str().map(str::to_string)
}

#[tokio::test]
async fn a_group_batch_is_incremental_and_keeps_one_context_per_stream() {
    let env = TestEnv::new(
        "bypass-permissions",
        "[bots]\nexternal = true\nallow_local = true\n[groups]\nquiet_secs = 2\nmax_wait_secs = 3",
    )
    .await;
    let fake = fake(&["--group-ext"]);
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut wire = route(incoming);
    let _ = client.request("groups/subscribe", Value::Null).await.expect("groups/subscribe");

    let bot = add_external(&client, &fake).await;
    let group = create_group(&client, "外部群", json!([{ "bot_id": bot, "history": "none" }])).await;
    let notice = until_message(&mut wire, &group, |m| m["from"]["kind"] == "system").await;
    assert!(notice["text"].as_str().is_some_and(|t| t.contains("外部成员")), "{notice}");

    let mut ids = Vec::new();
    for i in 0..5 {
        let sent = client
            .request("groups/send", json!({"id": group, "text": format!("普通消息 {i}")}))
            .await
            .expect("groups/send");
        ids.push(sent["message"]["id"].as_str().unwrap().to_string());
    }
    let _ = until_message(&mut wire, &group, |m| m["from"]["kind"] == "bot").await;
    let batches = group_batches(&fake);
    assert_eq!(batches.len(), 1, "five quiet messages are one call: {batches:?}");
    assert_eq!(part_texts(&batches[0]).len(), 5);
    // Seq 0 is the "external member is here" system line; the five owner messages follow.
    assert_eq!(message_of(&batches[0])["metadata"]["seq"]["from"], 1);
    assert_eq!(message_of(&batches[0])["metadata"]["seq"]["to"], 5);
    assert!(no_context(&batches[0]), "the first batch has no context yet");
    assert_eq!(batches[0]["headers"]["a2a-extensions"], "https://finx.work/a2a/ext/group-chat/v1");
    let speakers: Vec<&str> = message_of(&batches[0])["parts"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|part| part["metadata"]["speaker"]["name"].as_str())
        .collect();
    assert_eq!(speakers, ["Owner", "Owner", "Owner", "Owner", "Owner"]);

    let prompted = client
        .request("groups/send", json!({"id": group, "text": "@A2A Fake 你好"}))
        .await
        .expect("groups/send");
    let root = prompted["message"]["id"].as_str().unwrap().to_string();
    let _ = until_message(&mut wire, &group, |m| m["from"]["kind"] == "bot").await;
    let batches = group_batches(&fake);
    assert_eq!(batches.len(), 2, "a mention is immediate");
    let main_context = context_of(&batches[1]).expect("the second batch carries the context");

    client
        .request("groups/send", json!({"id": group, "text": "@A2A Fake 再说一句"}))
        .await
        .expect("groups/send");
    let _ = until_message(&mut wire, &group, |m| m["from"]["kind"] == "bot").await;
    let batches = group_batches(&fake);
    assert_eq!(context_of(&batches[2]).as_deref(), Some(main_context.as_str()));

    // A thread is another stream with its own context (brief §4.7).
    client
        .request("groups/send", json!({"id": group, "text": "@A2A Fake 话题里说", "thread": root}))
        .await
        .expect("groups/send");
    let _ = until_message(&mut wire, &group, |m| m["from"]["kind"] == "bot").await;
    let batches = group_batches(&fake);
    let thread_batch = batches.last().expect("a thread batch");
    assert_eq!(message_of(thread_batch)["metadata"]["group"]["thread"], root);
    assert!(no_context(thread_batch), "the first batch in a thread starts a new context");
    client
        .request("groups/send", json!({"id": group, "text": "@A2A Fake 话题里再说", "thread": root}))
        .await
        .expect("groups/send");
    let _ = until_message(&mut wire, &group, |m| m["from"]["kind"] == "bot").await;
    let batches = group_batches(&fake);
    let thread_context = context_of(batches.last().unwrap()).expect("a thread context");
    assert_ne!(thread_context, main_context);

    // A thread the member takes no part in is not sent at all (brief §4.7).
    client
        .request("groups/set_member", json!({"id": group, "bot_id": bot, "mode": "mentions"}))
        .await
        .expect("groups/set_member");
    let another = client
        .request("groups/send", json!({"id": group, "text": "别的话题"}))
        .await
        .expect("groups/send");
    let another = another["message"]["id"].as_str().unwrap().to_string();
    let before = group_batches(&fake).len();
    client
        .request("groups/send", json!({"id": group, "text": "这句不给外部看", "thread": another}))
        .await
        .expect("groups/send");
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    assert_eq!(group_batches(&fake).len(), before, "a thread it is not in stays here");
    assert!(!ids.is_empty());
}

#[tokio::test]
async fn a_stateless_member_gets_the_recent_messages_every_time_and_can_be_changed() {
    let env = TestEnv::new(
        "bypass-permissions",
        "[bots]\nexternal = true\nallow_local = true\n[groups]\nquiet_secs = 2\nmax_wait_secs = 3\nrecent_count = 2",
    )
    .await;
    let fake = fake(&["--stateless"]);
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut wire = route(incoming);
    let _ = client.request("groups/subscribe", Value::Null).await.expect("groups/subscribe");

    let bot = add_external(&client, &fake).await;
    let group = create_group(&client, "不记上下文的群", json!([{ "bot_id": bot, "history": "none" }])).await;
    // The probe's two questions went out before the group had a batch.
    let probes: Vec<Value> = requests(&fake)
        .into_iter()
        .filter(|request| {
            let text = request["body"]["params"]["message"]["parts"][0]["text"].as_str().unwrap_or_default();
            text.contains("KIWI") || text.contains("remember")
        })
        .collect();
    assert_eq!(probes.len(), 2, "the KIWI probe asks twice");

    client.request("groups/send", json!({"id": group, "text": "第一句"})).await.expect("groups/send");
    let _ = until_message(&mut wire, &group, |m| m["from"]["kind"] == "bot").await;
    client.request("groups/send", json!({"id": group, "text": "第二句"})).await.expect("groups/send");
    let _ = until_message(&mut wire, &group, |m| m["from"]["kind"] == "bot").await;
    let batches = group_batches(&fake);
    assert!(batches.len() >= 2, "{batches:?}");
    assert!(no_context(batches.last().unwrap()), "a stateless batch has no contextId");
    let text = part_texts(batches.last().unwrap()).join("\n");
    assert!(text.contains("[#1 Owner] 第一句"), "the recent window comes along: {text}");
    assert!(text.contains("【Owner】第二句"), "{text}");

    // The owner says it does remember: the next batches carry a context.
    client
        .request("groups/set_member", json!({"id": group, "bot_id": bot, "stateless": false}))
        .await
        .expect("groups/set_member");
    client.request("groups/send", json!({"id": group, "text": "第三句"})).await.expect("groups/send");
    let _ = until_message(&mut wire, &group, |m| m["from"]["kind"] == "bot").await;
    client.request("groups/send", json!({"id": group, "text": "第四句"})).await.expect("groups/send");
    let _ = until_message(&mut wire, &group, |m| m["from"]["kind"] == "bot").await;
    let batches = group_batches(&fake);
    assert!(no_context(&batches[batches.len() - 2]), "the first batch after the switch is new");
    assert!(context_of(batches.last().unwrap()).is_some(), "then the context is kept");
}

#[tokio::test]
async fn history_choices_and_file_descriptions_are_what_the_owner_allowed() {
    let env = TestEnv::new(
        "bypass-permissions",
        "[bots]\nexternal = true\nallow_local = true\n[groups]\nquiet_secs = 2\nmax_wait_secs = 3\nrecent_count = 2\nsummary_after = 2",
    )
    .await;
    let fake = fake(&["--group-ext"]);
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut wire = route(incoming);
    let _ = client.request("groups/subscribe", Value::Null).await.expect("groups/subscribe");
    let bot = add_external(&client, &fake).await;

    // none: only what was said after the join.
    let none = create_group(&client, "不给看历史", json!([{ "bot_id": bot, "history": "none" }])).await;
    client.request("groups/send", json!({"id": none, "text": "@A2A Fake 新消息"})).await.expect("groups/send");
    let _ = until_message(&mut wire, &none, |m| m["from"]["kind"] == "bot").await;
    let batches = group_batches(&fake);
    let none_text = part_texts(batches.last().unwrap()).join("\n");
    assert!(none_text.contains("新消息"), "{none_text}");
    assert!(!none_text.contains("旧消息"), "{none_text}");

    // Seed a group without the external bot, and let the rolling summary catch up.
    let seeded = create_group(&client, "看摘要", json!([])).await;
    for i in 0..5 {
        client
            .request("groups/send", json!({"id": seeded, "text": format!("旧消息 {i}")}))
            .await
            .expect("groups/send");
    }
    client
        .request("groups/add_member", json!({"id": seeded, "bot_id": bot, "history": "summary"}))
        .await
        .expect("groups/add_member");
    let mut summarized = String::new();
    for _ in 0..100 {
        let text = std::fs::read_to_string(env.home.path().join("groups").join(&seeded).join("group.json")).unwrap_or_default();
        let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        summarized = value["summary"]["text"].as_str().unwrap_or_default().to_string();
        if !summarized.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(!summarized.is_empty(), "the rolling summary was written");
    client.request("groups/send", json!({"id": seeded, "text": "@A2A Fake 只给摘要"})).await.expect("groups/send");
    let _ = until_message(&mut wire, &seeded, |m| m["from"]["kind"] == "bot").await;
    let batches = group_batches(&fake);
    let summary_batch = part_texts(batches.last().unwrap()).join("\n");
    assert!(summary_batch.contains("Earlier in this group"), "{summary_batch}");
    assert!(!summary_batch.contains("旧消息 0"), "the old words themselves stay out: {summary_batch}");

    // recent: the summary and the last few messages.
    let recent = create_group(&client, "看最近", json!([])).await;
    for i in 0..4 {
        client
            .request("groups/send", json!({"id": recent, "text": format!("最近 {i}")}))
            .await
            .expect("groups/send");
    }
    client
        .request("groups/add_member", json!({"id": recent, "bot_id": bot, "history": "recent"}))
        .await
        .expect("groups/add_member");
    client.request("groups/send", json!({"id": recent, "text": "@A2A Fake 新的一句"})).await.expect("groups/send");
    let _ = until_message(&mut wire, &recent, |m| m["from"]["kind"] == "bot").await;
    let batches = group_batches(&fake);
    let recent_texts = part_texts(batches.last().unwrap());
    assert!(recent_texts[0].contains("Earlier in this group"), "{recent_texts:?}");
    assert!(recent_texts[0].contains("最近 2"), "{recent_texts:?}");
    assert_eq!(recent_texts[1], "最近 3", "{recent_texts:?}");
    assert!(recent_texts[2].contains("新的一句"), "{recent_texts:?}");

    // A file is only a line; the file's content and this machine's path stay out.
    let files = create_group(&client, "文件群", json!([{ "bot_id": bot, "history": "none" }])).await;
    let path = env.work().join("report.txt");
    std::fs::write(&path, "the file's words").unwrap();
    client
        .request("groups/send", json!({"id": files, "text": "看一下", "files": [path.to_str().unwrap()]}))
        .await
        .expect("groups/send");
    let _ = until_message(&mut wire, &files, |m| m["from"]["kind"] == "bot").await;
    let batches = group_batches(&fake);
    let with_file = part_texts(batches.last().unwrap()).join("\n");
    assert!(with_file.contains("sent report.txt"), "{with_file}");
    assert!(!with_file.contains("the file's words"));
    assert!(!with_file.contains(path.to_str().unwrap()));

    // A file the other side gives is written under the group's files, with a cleaned name.
    client
        .request("groups/send", json!({"id": files, "text": "file2"}))
        .await
        .expect("groups/send");
    let answer = until_message(&mut wire, &files, |m| {
        m["from"]["kind"] == "bot" && !m["files"].as_array().map(Vec::is_empty).unwrap_or(true)
    })
    .await;
    assert_eq!(answer["files"][0]["path"], "files/x", "{answer}");
    assert!(env.home.path().join("groups").join(&files).join("files").join("x").exists());
    assert!(!env.home.path().join("groups").join(&files).join("..").join("..").join("x").exists());
}

#[tokio::test]
async fn pass_and_silent_are_not_messages_but_are_written_to_the_debug_log() {
    let env = TestEnv::new(
        "bypass-permissions",
        "[bots]\nexternal = true\nallow_local = true\n[groups]\nquiet_secs = 2\nmax_wait_secs = 3",
    )
    .await;
    let fallback = fake(&[]);
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut wire = route(incoming);
    let _ = client.request("groups/subscribe", Value::Null).await.expect("groups/subscribe");
    let bot = add_external(&client, &fallback).await;
    let group = create_group(&client, "降级群", json!([{ "bot_id": bot, "history": "none" }])).await;
    client.request("groups/send", json!({"id": group, "text": "PASS"})).await.expect("groups/send");
    no_bot_message(&mut wire, &group, std::time::Duration::from_secs(3)).await;
    let batch = group_batches(&fallback).last().cloned().expect("a fallback batch");
    let text = part_texts(&batch).join("\n");
    assert!(text.contains("You are in the finx group"), "{text}");
    assert!(text.contains("【Owner】PASS"), "{text}");
    let silence = std::fs::read_to_string(env.home.path().join("groups").join(&group).join("silence.jsonl")).unwrap();
    assert!(silence.contains("no content"), "{silence}");
    let opened = client.request("groups/open", json!({"id": group})).await.unwrap();
    assert!(!serde_json::to_string(&opened).unwrap().contains("\"kind\":\"bot\""), "silence is not a group message");

    let extended = fake(&["--group-ext"]);
    let bot = add_external(&client, &extended).await;
    let group = create_group(&client, "扩展群", json!([{ "bot_id": bot, "history": "none" }])).await;
    client.request("groups/send", json!({"id": group, "text": "silent"})).await.expect("groups/send");
    no_bot_message(&mut wire, &group, std::time::Duration::from_secs(3)).await;
    let silence = std::fs::read_to_string(env.home.path().join("groups").join(&group).join("silence.jsonl")).unwrap();
    assert!(silence.contains("no content"), "{silence}");
}


async fn create_local_bot(client: &Client, name: &str) -> String {
    let made = client
        .request("bots/create", json!({ "name": name, "avatar": { "kind": "mono", "hue": "slate" } }))
        .await
        .expect("bots/create");
    made["bot"]["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn external_words_make_a_tainted_turn_ask_before_files_and_network() {
    let env = TestEnv::new(
        "bypass-permissions",
        "[bots]\nexternal = true\nallow_local = true\n[groups]\nquiet_secs = 1\nmax_wait_secs = 2",
    )
    .await;
    let fake = fake(&["--group-ext", "--evil"]);
    let (mut child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut wire = route(incoming);
    let _ = client.request("groups/subscribe", Value::Null).await.expect("groups/subscribe");

    let local = create_local_bot(&client, "Alice").await;
    let external = add_external(&client, &fake).await;
    let group = create_group(
        &client,
        "有外人的群",
        json!([{ "bot_id": local, "history": "none" }, { "bot_id": external, "history": "none" }]),
    )
    .await;

    client
        .request("groups/send", json!({ "id": group, "text": "大家看一下" }))
        .await
        .expect("groups/send");

    let external_word = until_message(&mut wire, &group, |m| m["from"]["kind"] == "bot" && m["from"]["external"] == true).await;
    assert!(external_word["text"].as_str().is_some_and(|t| t.contains("pwned.txt")));

    let approval = tokio::time::timeout(WAIT, wire.approvals.recv())
        .await
        .expect("timed out waiting for group/approval")
        .expect("closed");
    assert_eq!(approval["group_id"], group);
    assert_eq!(approval["cause"]["kind"], "direct");
    assert_eq!(approval["cause"]["name"], "A2A Fake");
    assert_eq!(approval["name"], "web_search", "the network read asks too");
    let approvals = vec![approval];
    let session = approvals[0]["session_id"].as_str().unwrap().to_string();
    client.request("session/resume", json!({ "session_id": session })).await.expect("session/resume");
    for approval in &approvals {
        let call_id = approval["call_id"].as_str().unwrap();
        client
            .request(
                "session/op",
                json!({ "session_id": session, "op": { "type": "approval", "call_id": call_id, "decision": { "type": "deny" } } }),
            )
            .await
            .expect("deny");
    }
    let _ = client.request("session/detach", json!({ "session_id": session })).await;

    let file = env.home.path().join("groups").join(&group).join("files").join("pwned.txt");
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(!file.exists(), "the denied write makes no file");

    // The same write after a restart still asks, and the card names the earlier external words.
    client
        .request("groups/set_member", json!({ "id": group, "bot_id": external, "mode": "mentions" }))
        .await
        .expect("groups/set_member");
    child.kill().await.expect("stop the service");
    let _ = child.wait().await;
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut wire = route(incoming);
    let _ = client.request("groups/subscribe", Value::Null).await.expect("subscribe again");
    client
        .request("groups/send", json!({ "id": group, "text": "pwned.txt" }))
        .await
        .expect("groups/send after restart");
    let approval = tokio::time::timeout(WAIT, wire.approvals.recv())
        .await
        .expect("timed out waiting for the restarted approval")
        .expect("closed");
    assert_eq!(approval["cause"]["kind"], "earlier");
    assert!(
        approval["cause"]["text"].as_str().is_some_and(|text| text.contains("此前群里有外部消息")),
        "{approval}"
    );
    let session = approval["session_id"].as_str().unwrap().to_string();
    client.request("session/resume", json!({ "session_id": session })).await.expect("resume seat");
    client
        .request(
            "session/op",
            json!({ "session_id": session, "op": { "type": "approval", "call_id": approval["call_id"], "decision": { "type": "deny" } } }),
        )
        .await
        .expect("deny after restart");
    let _ = client.request("session/detach", json!({ "session_id": session })).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(!file.exists(), "restart does not weaken the write boundary");
}

#[tokio::test]
async fn a_task_left_running_is_picked_up_after_a_restart() {
    let env = TestEnv::new(
        "bypass-permissions",
        "[bots]\nexternal = true\nallow_local = true\n[groups]\nquiet_secs = 1\nmax_wait_secs = 2",
    )
    .await;
    let fake = fake(&["--group-ext"]);
    let (mut child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let wire = route(incoming);
    let _ = client.request("groups/subscribe", Value::Null).await.expect("groups/subscribe");

    let bot = add_external(&client, &fake).await;
    let group = create_group(&client, "重启的群", json!([{ "bot_id": bot, "history": "none" }])).await;
    client
        .request("groups/send", json!({ "id": group, "text": "drop" }))
        .await
        .expect("groups/send");

    // The fake drops the stream but leaves the task WORKING; wait for the task id to be saved.
    let group_file = env.home.path().join("groups").join(&group).join("group.json");
    let mut saved = false;
    let mut last_text = String::new();
    for _ in 0..100 {
        last_text = std::fs::read_to_string(&group_file).unwrap_or_default();
        if last_text.contains("\"task_id\"") {
            saved = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(saved, "the task id is written down: {last_text}");
    let _ = wire;
    child.kill().await.expect("stop the service");
    let _ = child.wait().await;

    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let _ = client.request("groups/subscribe", Value::Null).await.expect("subscribe again");
    let mut messages = route(incoming).messages;
    let mut found = false;
    for _ in 0..100 {
        let opened = client.request("groups/open", json!({ "id": group })).await.expect("groups/open");
        if opened["messages"].as_array().into_iter().flatten().any(|m| m["from"]["kind"] == "bot" && m["from"]["external"] == true) {
            found = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(found, "the result arrives in the group after the restart");
    let _ = &mut messages;
}
