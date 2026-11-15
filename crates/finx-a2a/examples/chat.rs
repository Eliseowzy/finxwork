// A command-line check, so it prints to the terminal on purpose.
#![allow(clippy::print_stdout)]

//! A command-line check of an A2A peer (bot-contacts-design §5.7): read its card, start an
//! external bot's session with no model at all, say a thing or two, and print what came back.
//!
//! `cargo run -p finx-a2a --example chat -- http://localhost:9999 "你好" "刚才说了什么"`
//!
//! `A2A_ALLOW_LOCAL=0` refuses a service on this machine (the default allows one, for the demo).

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
use finx_llm::Message;
use finx_llm::ModelRegistry;
use finx_llm::RegistryOptions;
use finx_llm::ThinkingLevel;
use finx_llm::UserContent;
use finx_protocol::EventMsg;
use finx_protocol::PermissionMode;
use finx_tools::BashTool;
use finx_tools::LocalEnvironment;
use finx_tools::builtin_registry;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let url = args
        .next()
        .unwrap_or_else(|| "http://localhost:9999".into());
    let said: Vec<String> = args.collect();
    let said = if said.is_empty() {
        vec![
            "只回答两个字：收到".to_string(),
            "刚才我说了什么？".to_string(),
        ]
    } else {
        said
    };
    let allow_local = std::env::var("A2A_ALLOW_LOCAL")
        .map(|value| value != "0")
        .unwrap_or(true);
    let card = Card::read(&url, &CardOptions { allow_local }).await?;
    let host = reqwest::Url::parse(&card.endpoint.url)?
        .host_str()
        .unwrap_or_default()
        .to_string();
    println!(
        "card: {} from {host}, accepts {:?}, auth {:?}",
        card.name,
        card.accepts,
        card.auth.scheme()
    );
    let peer = A2aPeer::new(Source {
        endpoint: card.endpoint.url.clone(),
        host: host.clone(),
        tenant: card.endpoint.tenant.clone(),
        auth: card.auth.clone(),
        allow_local,
    });

    let root = std::env::temp_dir().join(format!("finx-a2a-chat-{}", std::process::id()));
    std::fs::create_dir_all(&root)?;
    let home = FinxHome::new(root.join("home"));
    home.ensure()?;
    let folder = home.bot_files_dir("demo");
    std::fs::create_dir_all(&folder)?;
    let config = Arc::new(Config::default());
    let registry = ModelRegistry::new(Catalog::default(), RegistryOptions::default());
    let deps = KernelDeps {
        llm: Arc::new(registry),
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
        cwd: folder,
        home,
        config,
        project_root: None,
        trusted: false,
        interactive_approvals: false,
        bot: Some(BotIdentity {
            id: "demo".into(),
            name: card.name.clone(),
        }),
        peer: Some(PeerRef { host }),
        group: None,
    };
    let mut kernel = Kernel::start(options, deps).await?;
    for line in &said {
        println!("you: {line}");
        let result = kernel
            .run(vec![UserContent::Text { text: line.clone() }])
            .await?;
        for event in &result.events {
            match &event.msg {
                EventMsg::MessageCompleted {
                    message: Message::Assistant(assistant),
                    ..
                } => {
                    for content in &assistant.content {
                        if let finx_llm::AssistantContent::ToolCall(call) = content {
                            println!(
                                "  [{} -> {}] {}",
                                assistant.provider, assistant.model, call.name
                            );
                        }
                    }
                }
                EventMsg::ToolStarted { name, args, .. } if name == "send_to_user" => {
                    if let Some(files) = args.get("files").and_then(|files| files.as_array()) {
                        for file in files {
                            println!("  [file] {}", file["path"].as_str().unwrap_or_default());
                        }
                        if let Some(text) = args.get("text").and_then(|text| text.as_str()) {
                            println!("  bot: {text}");
                        }
                    } else if let Some(text) = args.get("text").and_then(|text| text.as_str()) {
                        println!("  bot: {text}");
                    }
                }
                EventMsg::Warning { message, .. } => println!("  warning: {message}"),
                _ => {}
            }
        }
        match result.end {
            TaskEnd::Completed { .. } => println!("  -- done"),
            TaskEnd::Interrupted => println!("  -- stopped"),
            TaskEnd::Failed(error) => println!("  -- failed: {}: {}", error.kind, error.message),
        }
    }
    kernel.shutdown().await;
    Ok(())
}
