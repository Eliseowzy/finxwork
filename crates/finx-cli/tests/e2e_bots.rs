//! Bots over the native protocol (docs/kernel/bot-design.md §4–§5): the real `finx serve`, the
//! mock model's bot scenarios, a private FINX_HOME.

mod common;

use common::SchemaCheck;
use common::TestEnv;
use common::WAIT;
use common::native_init;
use finx_rpc::Client;
use finx_rpc::IncomingRx;
use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::path::PathBuf;
use tokio::sync::mpsc;

/// What the server sends, split: `bots/changed` params, and session events.
struct Wire {
    bots: mpsc::UnboundedReceiver<Value>,
    events: mpsc::UnboundedReceiver<Value>,
}

fn route(mut incoming: IncomingRx) -> Wire {
    let (bots_tx, bots) = mpsc::unbounded_channel();
    let (events_tx, events) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(message) = incoming.recv().await {
            match message.method() {
                "bots/changed" => {
                    let _ = bots_tx.send(message.params().clone());
                }
                "session/event" => {
                    let _ = events_tx.send(message.params()["event"].clone());
                }
                _ => {}
            }
        }
    });
    Wire { bots, events }
}

/// Events until one matches `stop`, inclusive.
async fn until_event(wire: &mut Wire, stop: impl Fn(&Value) -> bool) -> Vec<Value> {
    let mut seen = Vec::new();
    loop {
        let event = tokio::time::timeout(WAIT, wire.events.recv()).await.expect("timed out waiting for an event").expect("closed");
        let done = stop(&event);
        seen.push(event);
        if done {
            return seen;
        }
    }
}

/// The first `bots/changed` row of `bot` that matches `want`.
async fn until_row(wire: &mut Wire, bot: &str, want: impl Fn(&Value) -> bool) -> Value {
    loop {
        let changed = tokio::time::timeout(WAIT, wire.bots.recv()).await.expect("timed out waiting for bots/changed").expect("closed");
        if let Some(row) = changed["bots"].as_array().into_iter().flatten().find(|b| b["id"] == bot && want(b)) {
            return row.clone();
        }
    }
}

/// The texts the bot sent the user among `events`, in order.
fn sent(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter(|e| e["type"] == "tool_started" && e["name"] == "send_to_user")
        .filter_map(|e| e["args"]["text"].as_str().map(str::to_string))
        .collect()
}

fn ended(e: &Value) -> bool {
    matches!(e["type"].as_str(), Some("task_completed" | "task_failed" | "task_interrupted"))
}

async fn open(client: &Client, bot: &str) -> String {
    let opened = client
        .request(
            "bots/open",
            json!({"bot_id": bot, "events": {"exclude": ["text_delta", "thinking_delta", "tool_call_delta", "tool_progress"]}}),
        )
        .await
        .expect("bots/open");
    opened["session_id"].as_str().unwrap().to_string()
}

async fn say(client: &Client, session: &str, text: &str) {
    let op = json!({"session_id": session, "op": {"type": "prompt", "input": [{"type": "text", "text": text}]}});
    client.request("session/op", op).await.expect("prompt accepted");
}

/// Every session log under `home`, as text.
fn logs(home: &Path) -> Vec<(PathBuf, String)> {
    fn walk(dir: &Path, out: &mut Vec<(PathBuf, String)>) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|e| e == "jsonl") {
                out.push((path.clone(), std::fs::read_to_string(&path).unwrap_or_default()));
            }
        }
    }
    let mut out = Vec::new();
    walk(&home.join("sessions"), &mut out);
    out
}

/// A 1 × 1 PNG.
const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

#[tokio::test]
async fn a_bot_talks_in_messages_and_its_row_follows() {
    let env = TestEnv::new("manual", "").await;
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut wire = route(incoming);
    let schema = SchemaCheck::new(&["BotsResult", "BotResult", "BotsChangedParams", "SessionNewResult"]);

    // The default bot is there from the start.
    let listed = client.request("bots/subscribe", Value::Null).await.unwrap();
    schema.check("BotsResult", &listed);
    let bots = listed["bots"].as_array().unwrap();
    assert_eq!(bots.len(), 1);
    assert_eq!((bots[0]["name"].as_str(), bots[0]["default"].as_bool()), (Some("FinxBot"), Some(true)));
    assert_eq!(bots[0]["avatar"], json!({"kind": "mark"}));

    let created = client
        .request("bots/create", json!({"name": "  研究员 ", "avatar": {"kind": "char", "shape": "cat", "hue": "teal"}}))
        .await
        .unwrap();
    schema.check("BotResult", &created);
    let bot = created["bot"]["id"].as_str().unwrap().to_string();
    assert_eq!(created["bot"]["name"], "研究员");
    until_row(&mut wire, &bot, |b| b["name"] == "研究员").await;

    let opened = client
        .request("bots/open", json!({"bot_id": bot, "events": {"exclude": ["text_delta", "thinking_delta", "tool_call_delta", "tool_progress"]}}))
        .await
        .unwrap();
    schema.check("SessionNewResult", &opened);
    let session = opened["session_id"].as_str().unwrap().to_string();
    let row = until_row(&mut wire, &bot, |b| b["session_id"].is_string()).await;
    assert_eq!(row["session_id"], session.as_str());

    say(&client, &session, "[[mock:send:你好，我是研究员。]] 你是谁").await;
    let events = until_event(&mut wire, ended).await;
    assert_eq!(sent(&events), ["你好，我是研究员。"]);
    assert!(events.iter().all(|e| e["type"] != "message_delta"), "no streaming for a bot");
    let row = until_row(&mut wire, &bot, |b| b["last"]["from"] == "bot").await;
    schema.check("BotsChangedParams", &json!({"bots": [row.clone()]}));
    assert_eq!(row["last"]["text"], "你好，我是研究员。");
    assert_eq!(row["unread"], 1);
    client.request("bots/read", json!({"bot_id": bot})).await.unwrap();
    until_row(&mut wire, &bot, |b| b.get("unread").is_none()).await;

    // Not a session of the session list.
    let list = client.request("session/list", json!({})).await.unwrap();
    assert!(list["sessions"].as_array().unwrap().iter().all(|s| s["session_id"] != session.as_str()));

    // Its prompt is a bot's, with its name, and it works in its folder.
    let (_, log) = logs(env.home.path()).into_iter().find(|(_, text)| text.contains(&session)).expect("the log");
    assert!(log.contains("You are 研究员, one of the user's bots in FinxWork."));
    let folder = env.home.path().join("bots").join(&bot).join("files");
    assert!(log.contains(&format!("\"cwd\":\"{}", std::fs::canonicalize(&folder).unwrap().display())));
}

#[tokio::test]
async fn messages_in_a_row_are_answered_in_order() {
    let env = TestEnv::new("manual", "").await;
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut wire = route(incoming);
    let listed = client.request("bots/subscribe", Value::Null).await.unwrap();
    let bot = listed["bots"][0]["id"].as_str().unwrap().to_string();
    let session = open(&client, &bot).await;
    for poem in ["春", "夏", "秋", "冬"] {
        say(&client, &session, &format!("[[mock:send:{poem}天的诗]] 写一首{poem}天的诗")).await;
    }
    let mut seen = Vec::new();
    while sent(&seen).len() < 4 {
        seen.extend(until_event(&mut wire, ended).await);
    }
    assert_eq!(sent(&seen), ["春天的诗", "夏天的诗", "秋天的诗", "冬天的诗"]);
}

/// Reminded and still silent, the task fails: the owner is told, not left waiting (bot-design
/// §3.11, D-321). What it only wrote stays private.
#[tokio::test]
async fn a_bot_that_never_sends_fails_so_the_owner_knows() {
    let env = TestEnv::new("manual", "").await;
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut wire = route(incoming);
    let listed = client.request("bots/subscribe", Value::Null).await.unwrap();
    let bot = listed["bots"][0]["id"].as_str().unwrap().to_string();
    let session = open(&client, &bot).await;
    say(&client, &session, "[[mock:mute]] 还在吗").await;
    let events = until_event(&mut wire, ended).await;
    let end = events.last().unwrap();
    assert_eq!(end["type"], "task_failed", "{end}");
    assert_eq!(end["error"]["kind"], "no_reply", "{end}");
    assert_eq!(end["error"]["retryable"], true, "{end}");
    assert!(sent(&events).is_empty());
    assert_eq!(events.iter().filter(|e| e["type"] == "turn_started").count(), 2);
    // Retrying asks again rather than saying there is nothing to continue.
    client.request("session/op", json!({"session_id": session, "op": {"type": "continue"}})).await.unwrap();
    let again = until_event(&mut wire, ended).await;
    assert_eq!(again.last().unwrap()["type"], "task_failed", "{again:?}");
}

/// A bot that answers in plain text is reminded and sends it; the reminder is the model's alone
/// (bot-design §3.11).
#[tokio::test]
async fn a_bot_that_forgets_to_send_is_reminded_and_the_user_sees_one_message() {
    let env = TestEnv::new("manual", "").await;
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut wire = route(incoming);
    let listed = client.request("bots/subscribe", Value::Null).await.unwrap();
    let bot = listed["bots"][0]["id"].as_str().unwrap().to_string();
    let session = open(&client, &bot).await;
    say(&client, &session, "[[mock:quiet:2。]] 1 加 1 等于几？").await;
    let events = until_event(&mut wire, ended).await;
    assert_eq!(sent(&events), ["2。"]);
    assert_eq!(events.iter().filter(|e| e["type"] == "turn_started").count(), 2);
    assert!(events.iter().all(|e| !e.to_string().contains("reply_reminder")));
    let row = until_row(&mut wire, &bot, |b| b["last"]["from"] == "bot").await;
    assert_eq!((row["last"]["text"].as_str(), row["unread"].as_u64()), (Some("2。"), Some(1)));
    // The conversation loads without it; the log keeps it.
    let opened = client.request("bots/open", json!({"bot_id": bot})).await.unwrap();
    let transcript = opened["snapshot"]["transcript"].to_string();
    assert!(transcript.contains("2。") && !transcript.contains("reply_reminder"), "{transcript}");
    let (_, log) = logs(env.home.path()).into_iter().find(|(_, text)| text.contains(&session)).expect("the log");
    assert_eq!(log.matches("\"type\":\"unanswered\"").count(), 1);
}

#[tokio::test]
async fn a_sub_agent_works_in_the_background_and_the_bot_relays_its_report() {
    let env = TestEnv::new("manual", "").await;
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut wire = route(incoming);
    let listed = client.request("bots/subscribe", Value::Null).await.unwrap();
    let bot = listed["bots"][0]["id"].as_str().unwrap().to_string();
    let session = open(&client, &bot).await;
    say(&client, &session, "[[mock:relay:查资料]] 帮我查一下").await;
    let events = until_event(&mut wire, |e| e["type"] == "idle").await;
    let texts = sent(&events);
    assert_eq!(texts.len(), 2, "{texts:?}");
    assert_eq!(texts[0], "在查了。");
    assert!(texts[1].starts_with("查到了："), "{texts:?}");
    assert!(events.iter().any(|e| e["type"] == "agent_started" && e["description"] == "查资料"));
    // The row counted the sub-agent while it worked.
    let mut working = Vec::new();
    while let Ok(changed) = wire.bots.try_recv() {
        for row in changed["bots"].as_array().into_iter().flatten().filter(|b| b["id"] == bot.as_str()) {
            working.push(row["agents_working"].as_u64().unwrap_or(0));
        }
    }
    assert!(working.contains(&1), "{working:?}");
    assert_eq!(working.last(), Some(&0));
}

#[tokio::test]
async fn approvals_come_after_the_message_that_asks_and_count_as_unread() {
    let env = TestEnv::new("manual", "").await;
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut wire = route(incoming);
    let listed = client.request("bots/subscribe", Value::Null).await.unwrap();
    let bot = listed["bots"][0]["id"].as_str().unwrap().to_string();
    let session = open(&client, &bot).await;
    say(&client, &session, "[[mock:confirm:touch confirmed.txt]] 建个文件").await;
    let events = until_event(&mut wire, |e| e["type"] == "approval_requested").await;
    // The message that asks shows before the approval: the call's start, not its result.
    assert_eq!(sent(&events), ["要执行命令，确认一下。"]);
    let call = events.last().unwrap()["call_id"].clone();
    let row = until_row(&mut wire, &bot, |b| b["waiting"].is_string()).await;
    assert_eq!(row["waiting"], "touch confirmed.txt");
    assert_eq!(row["unread"], 2, "the message and the approval");
    let op = json!({"session_id": session, "op": {"type": "approval", "call_id": call, "decision": {"type": "approve"}}});
    client.request("session/op", op).await.unwrap();
    let events = until_event(&mut wire, ended).await;
    assert!(sent(&events)[0].starts_with("做完了"));
    assert!(env.home.path().join("bots").join(&bot).join("files").join("confirmed.txt").exists());
    until_row(&mut wire, &bot, |b| b.get("waiting").is_none() && b.get("typing").is_none()).await;
}

#[tokio::test]
async fn what_a_sub_agent_asks_waits_on_the_row_and_the_bot_keeps_talking() {
    let env = TestEnv::new("manual", "").await;
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut wire = route(incoming);
    let listed = client.request("bots/subscribe", Value::Null).await.unwrap();
    let bot = listed["bots"][0]["id"].as_str().unwrap().to_string();
    let session = open(&client, &bot).await;
    say(&client, &session, "[[mock:relay_run:touch made.txt]] 建个文件").await;
    let asked = |e: &Value| e["type"] == "agent_event" && e["event"]["type"] == "approval_requested";
    let events = until_event(&mut wire, asked).await;
    assert_eq!(sent(&events), ["交给子智能体了。"]);
    let ask = events.last().unwrap().clone();

    let row = until_row(&mut wire, &bot, |b| b["waiting"].is_string()).await;
    assert_eq!(row["waiting"], "touch made.txt");
    assert_eq!(row["agents_working"], 1);
    assert_eq!(row["unread"], 2, "the message and the approval");

    // The question does not hold the bot up.
    say(&client, &session, "还在吗").await;
    until_event(&mut wire, |e| e["type"] == "tool_started" && e["args"]["text"] == "做完了：还在吗").await;
    let files = env.home.path().join("bots").join(&bot).join("files");
    assert!(!files.join("made.txt").exists());

    let op = json!({"session_id": session, "op": {"type": "agent_approval", "agent": ask["agent_id"], "call_id": ask["event"]["call_id"], "decision": {"type": "approve"}}});
    client.request("session/op", op).await.unwrap();
    let events = until_event(&mut wire, |e| e["type"] == "idle").await;
    assert!(files.join("made.txt").exists());
    assert!(sent(&events).iter().any(|t| t.contains("<agent_report")), "{events:?}");
    until_row(&mut wire, &bot, |b| b.get("waiting").is_none() && b.get("agents_working").is_none()).await;
}

#[tokio::test]
async fn renaming_avatars_clearing_and_deleting() {
    let env = TestEnv::new("manual", "").await;
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut wire = route(incoming);
    client.request("bots/subscribe", Value::Null).await.unwrap();
    let created = client.request("bots/create", json!({"name": "写作助手", "avatar": {"kind": "mono", "hue": "clay"}})).await.unwrap();
    let bot = created["bot"]["id"].as_str().unwrap().to_string();
    let session = open(&client, &bot).await;
    say(&client, &session, "[[mock:send:在。]] 在吗").await;
    until_event(&mut wire, ended).await;

    // A new name reaches the model at its next turn.
    client.request("bots/update", json!({"bot_id": bot, "name": "编辑", "pinned": true})).await.unwrap();
    let row = until_row(&mut wire, &bot, |b| b["name"] == "编辑").await;
    assert_eq!(row["pinned"], true);
    say(&client, &session, "[[mock:send:我是编辑。]] 你叫什么").await;
    until_event(&mut wire, ended).await;
    let (_, log) = logs(env.home.path()).into_iter().find(|(_, text)| text.contains(&session)).unwrap();
    assert!(log.contains(r#""type":"bot_name","name":"编辑""#), "{log}");

    // Avatars.
    let updated = client.request("bots/update", json!({"bot_id": bot, "avatar": {"kind": "image", "png": PNG}})).await.unwrap();
    assert_eq!(updated["bot"]["avatar"], json!({"kind": "image", "rev": 1}));
    let avatar = client.request("bots/avatar", json!({"bot_id": bot})).await.unwrap();
    assert!(avatar["data"].as_str().unwrap().starts_with("data:image/png;base64,iVBOR"));
    let refused = |e: finx_rpc::RpcError| e.data.and_then(|d| d["kind"].as_str().map(str::to_string)).unwrap_or_default();
    let not_png = client.request("bots/update", json!({"bot_id": bot, "avatar": {"kind": "image", "png": "aGVsbG8="}})).await;
    assert_eq!(refused(not_png.unwrap_err()), "bot_invalid");
    let mark = client.request("bots/update", json!({"bot_id": bot, "avatar": {"kind": "mark"}})).await;
    assert_eq!(refused(mark.unwrap_err()), "bot_default");
    let long = client.request("bots/create", json!({"name": "一二三四五六七八九十一二三四五六七八九十一", "avatar": {"kind": "mono", "hue": "sage"}})).await;
    assert_eq!(refused(long.unwrap_err()), "bot_invalid");

    // Clearing: the conversation goes to the trash, the next one is new.
    client.request("bots/clear", json!({"bot_id": bot})).await.unwrap();
    until_row(&mut wire, &bot, |b| b.get("session_id").is_none() && b.get("last").is_none()).await;
    assert!(logs(env.home.path()).iter().all(|(_, text)| !text.contains(&session)), "the log left");
    let trashed = std::fs::read_dir(env.home.path().join("trash").join("sessions")).unwrap().count();
    assert!(trashed >= 1);
    let again = open(&client, &bot).await;
    assert_ne!(again, session);

    // Deleting: never the default bot.
    let listed = client.request("bots/subscribe", Value::Null).await.unwrap();
    let default = listed["bots"].as_array().unwrap().iter().find(|b| b["default"] == true).unwrap()["id"].as_str().unwrap().to_string();
    let refused_default = client.request("bots/delete", json!({"bot_id": default})).await;
    assert_eq!(refused(refused_default.unwrap_err()), "bot_default");
    client.request("bots/delete", json!({"bot_id": bot})).await.unwrap();
    loop {
        let changed = tokio::time::timeout(WAIT, wire.bots.recv()).await.unwrap().unwrap();
        if changed["deleted"].as_array().is_some_and(|d| d.iter().any(|id| id == bot.as_str())) {
            break;
        }
    }
    assert!(!env.home.path().join("bots").join(&bot).exists());
    assert!(env.home.path().join("trash").join("bots").join(&bot).exists());
    let missing = client.request("bots/open", json!({"bot_id": bot})).await;
    assert_eq!(refused(missing.unwrap_err()), "bot_not_found");
}

#[tokio::test]
async fn bots_and_their_rows_survive_a_restart() {
    let env = TestEnv::new("manual", "").await;
    let bot;
    {
        let (mut child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
        native_init(&client).await;
        let mut wire = route(incoming);
        let listed = client.request("bots/subscribe", Value::Null).await.unwrap();
        bot = listed["bots"][0]["id"].as_str().unwrap().to_string();
        let session = open(&client, &bot).await;
        say(&client, &session, "[[mock:send:记下了。]] 记一下").await;
        until_event(&mut wire, ended).await;
        until_row(&mut wire, &bot, |b| b["unread"] == 1).await;
        client.request("server/shutdown", json!({})).await.unwrap();
        common::exit_code(&mut child).await;
    }
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let _wire = route(incoming);
    let listed = client.request("bots/subscribe", Value::Null).await.unwrap();
    let bots = listed["bots"].as_array().unwrap();
    assert_eq!(bots.len(), 1, "the default bot is made once");
    assert_eq!(bots[0]["id"], bot.as_str());
    assert_eq!(bots[0]["last"]["text"], "记下了。");
    assert_eq!(bots[0]["unread"], 1);
    // Its conversation loads again, with what was said.
    let opened = client.request("bots/open", json!({"bot_id": bot})).await.unwrap();
    assert!(opened["snapshot"]["transcript"].to_string().contains("记下了。"));
}
