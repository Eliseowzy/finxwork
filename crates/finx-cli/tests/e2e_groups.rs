//! Groups over the native protocol: the real `finx serve`, three local bots, the mock model and a
//! private FINX_HOME (bot-group-chat-dev-brief §6, M3).

mod common;

use common::TestEnv;
use common::WAIT;
use common::native_init;
use finx_rpc::Client;
use finx_rpc::IncomingRx;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;

struct Wire {
    groups: mpsc::UnboundedReceiver<Value>,
    messages: mpsc::UnboundedReceiver<Value>,
}

fn route(mut incoming: IncomingRx) -> Wire {
    let (groups_tx, groups) = mpsc::unbounded_channel();
    let (messages_tx, messages) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(message) = incoming.recv().await {
            match message.method() {
                "groups/changed" => {
                    let _ = groups_tx.send(message.params().clone());
                }
                "group/message" => {
                    let _ = messages_tx.send(message.params().clone());
                }
                _ => {}
            }
        }
    });
    Wire { groups, messages }
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

async fn create_bot(client: &Client, name: &str) -> String {
    let made = client
        .request("bots/create", json!({ "name": name, "avatar": { "kind": "mono", "hue": "slate" } }))
        .await
        .expect("bots/create");
    made["bot"]["id"].as_str().unwrap().to_string()
}

async fn create_group(client: &Client, name: &str, bots: &[String]) -> String {
    let members: Vec<Value> = bots.iter().map(|id| json!({ "bot_id": id })).collect();
    let made = client
        .request("groups/create", json!({ "name": name, "members": members }))
        .await
        .expect("groups/create");
    made["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn a_mention_gets_an_immediate_reply_in_a_new_topic() {
    let env = TestEnv::new("bypass-permissions", "").await;
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut wire = route(incoming);
    let _ = client.request("groups/subscribe", Value::Null).await.expect("groups/subscribe");

    let alice = create_bot(&client, "Alice").await;
    let group = create_group(&client, "装修群", &[alice.clone()]).await;
    let opened = client
        .request("groups/open", json!({ "id": group }))
        .await
        .expect("groups/open");
    assert_eq!(opened["group"]["name"], "装修群");

    let sent = client
        .request("groups/send", json!({ "id": group, "text": "@Alice 这个报价你再看下" }))
        .await
        .expect("groups/send");
    let owner = sent["message"]["id"].as_str().unwrap().to_string();
    assert_eq!(sent["message"]["seq"], 0);
    assert_eq!(sent["message"]["mentions"].as_array().unwrap().len(), 1);

    let reply = until_message(&mut wire, &group, |m| m["from"]["kind"] == "bot").await;
    assert_eq!(reply["from"]["bot_id"], alice);
    assert_eq!(reply["thread"], owner, "an @ in the main flow opens a topic");
    assert!(reply["seq"].as_u64().unwrap() > 0);

    let thread = client
        .request("groups/thread", json!({ "id": group, "root": owner }))
        .await
        .expect("groups/thread");
    assert_eq!(thread["messages"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn three_local_bots_only_the_mentioned_one_answers() {
    let env = TestEnv::new("bypass-permissions", "").await;
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut wire = route(incoming);
    let _ = client.request("groups/subscribe", Value::Null).await.expect("groups/subscribe");

    let alice = create_bot(&client, "Alice").await;
    let bob = create_bot(&client, "Bob").await;
    let carol = create_bot(&client, "Carol").await;
    let group = create_group(&client, "三个人的群", &[alice.clone(), bob.clone(), carol.clone()]).await;
    for bot in [&bob, &carol] {
        client
            .request("groups/set_member", json!({ "id": group, "bot_id": bot, "mode": "mentions" }))
            .await
            .expect("groups/set_member");
    }
    client
        .request("groups/send", json!({ "id": group, "text": "@Alice 只有你回" }))
        .await
        .expect("groups/send");
    let reply = until_message(&mut wire, &group, |m| m["from"]["kind"] == "bot").await;
    assert_eq!(reply["from"]["bot_id"], alice);
    let another = tokio::time::timeout(
        std::time::Duration::from_secs(7),
        until_message(&mut wire, &group, |m| m["from"]["kind"] == "bot"),
    )
    .await;
    assert!(another.is_err(), "the other two stay out of a message that names Alice");
}

#[tokio::test]
async fn a_normal_message_waits_for_the_quiet_period() {
    let env = TestEnv::new("bypass-permissions", "").await;
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut wire = route(incoming);
    let _ = client.request("groups/subscribe", Value::Null).await.expect("groups/subscribe");

    let bob = create_bot(&client, "Bob").await;
    let group = create_group(&client, "闲聊群", &[bob]).await;
    let started = std::time::Instant::now();
    client
        .request("groups/send", json!({ "id": group, "text": "今天过得怎么样" }))
        .await
        .expect("groups/send");
    let reply = until_message(&mut wire, &group, |m| m["from"]["kind"] == "bot").await;
    assert!(started.elapsed() >= std::time::Duration::from_secs(3), "normal waits for quiet");
    assert!(reply["text"].as_str().is_some_and(|t| !t.is_empty()));
}

#[tokio::test]
async fn a_mentions_only_member_does_not_hear_the_main_flow() {
    let env = TestEnv::new("bypass-permissions", "").await;
    let (_child, client, incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    native_init(&client).await;
    let mut wire = route(incoming);
    let _ = client.request("groups/subscribe", Value::Null).await.expect("groups/subscribe");

    let carol = create_bot(&client, "Carol").await;
    let group = create_group(&client, "只看 @" , &[carol.clone()]).await;
    client
        .request("groups/set_member", json!({ "id": group, "bot_id": carol, "mode": "mentions" }))
        .await
        .expect("groups/set_member");
    client
        .request("groups/send", json!({ "id": group, "text": "这个不需要你回" }))
        .await
        .expect("groups/send");
    let quiet = tokio::time::timeout(std::time::Duration::from_secs(7), until_message(&mut wire, &group, |m| m["from"]["kind"] == "bot")).await;
    assert!(quiet.is_err(), "a mentions-only member gets no main-flow message");
}
