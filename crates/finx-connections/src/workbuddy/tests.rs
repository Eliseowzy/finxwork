#![allow(clippy::print_stderr)]
use super::*;
use finx_llm::{
    Catalog, Context, Message, ModelRegistry, RegistryOptions, RequestOptions, StreamEvent,
    UserMessage,
};
use futures::StreamExt;
use parking_lot::Mutex;
use serde_json::json;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{header, method, path},
};

fn http_client() -> reqwest::Client {
    ModelRegistry::new(Catalog::builtin().unwrap(), RegistryOptions::default())
        .http_client()
        .unwrap()
}

fn source() -> Value {
    json!({"account":{"uid":"user-a"},"auth":{"accessToken":"test-access","domain":"www.workbuddy.cn","expiresAt":9999999999999_i64}})
}
struct Env(Mutex<Value>);
#[async_trait]
impl Environment for Env {
    async fn discover(&self) -> Result<finx_protocol::api::ConnectionDiscovery> {
        unreachable!()
    }
    async fn login(&self) -> Result<Login> {
        source_login(&self.0.lock())
    }
    async fn headers(&self) -> Result<BTreeMap<String, String>> {
        Ok(BTreeMap::new())
    }
    async fn get(&self, _: &str) -> Result<Option<String>> {
        panic!("must not persist borrowed tokens")
    }
    async fn set(&self, _: &str, _: &str) -> Result<()> {
        panic!("must not persist borrowed tokens")
    }
    async fn delete(&self, _: &str) -> Result<()> {
        Ok(())
    }
}

#[test]
fn rejects_untrusted_domains_encrypted_values_and_missing_expiry() {
    for (field, value) in [
        ("domain", json!("attacker.example")),
        ("accessToken", json!({"$wbEncrypted":1})),
        ("expiresAt", Value::Null),
        ("accessToken", json!("bad\r\nheader")),
    ] {
        let mut s = source();
        s["auth"][field] = value;
        assert!(source_login(&s).is_err());
    }
    let mut s = source();
    s["account"]["enterpriseId"] = json!("enterprise");
    assert_eq!(source_login(&s).err().unwrap().code, "unsupported_account");
}

fn config() -> Value {
    json!({"agents":[{"name":"cli","models":["auto","hy4free","hy4std","claude-test","missing","auto"]}],
    "models":[
        {"id":"auto","name":"Auto","supportsToolCall":true,"supportsImages":true,"supportsReasoning":true,"maxInputTokens":256000,"maxOutputTokens":32000,"reasoning":{"effort":"high"}},
        {"id":"hy4free","name":"Hy4","supportsToolCall":true,"supportsReasoning":true,"reasoning":{"defaultEffort":"high","supportedEfforts":["low","high"],"canDisableThinking":false}},
        {"id":"hy4std","name":"Hy4","supportsToolCall":true,"supportsReasoning":true,"reasoning":{"defaultEffort":"high","supportedEfforts":["high"],"canDisableThinking":true}},
        {"id":"claude-test","supportsToolCall":true},
        {"id":"not-in-agent","supportsToolCall":true}
    ]})
}
#[test]
fn catalog_uses_cli_allowlist_limits_and_declared_controls() {
    let models = catalog(&config()).unwrap();
    assert_eq!(
        models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["auto", "hy4free", "hy4std"]
    );
    assert_eq!(models[0].context_window, Some(256000));
    assert_eq!(models[0].max_output_tokens, Some(32000));
    assert_eq!(models[0].default_thinking, ThinkingLevel::High);
    assert_eq!(
        models[1].thinking,
        [ThinkingLevel::Low, ThinkingLevel::High]
    );
    assert_eq!(
        models[2].thinking,
        [ThinkingLevel::Off, ThinkingLevel::High]
    );
    assert_ne!(models[1].name, models[2].name);
    let mut mandatory = config();
    mandatory["models"][2]["onlyReasoning"] = json!(true);
    assert!(
        !catalog(&mandatory).unwrap()[2]
            .thinking
            .contains(&ThinkingLevel::Off)
    );
    assert!(catalog(&json!({"models":[]})).is_err());
}

#[tokio::test]
async fn credentials_follow_source_rotation_and_reject_account_changes() {
    let env = Arc::new(Env(Mutex::new(source())));
    let identity = env.login().await.unwrap().identity;
    let mut adapter = WorkBuddy::new(identity, env.clone());
    let http = http_client();
    assert_eq!(
        adapter
            .authorize(&http, false)
            .await
            .unwrap()
            .credentials
            .api_key
            .as_deref(),
        Some("test-access")
    );
    env.0.lock()["auth"]["accessToken"] = json!("rotated-access");
    assert_eq!(
        adapter
            .authorize(&http, true)
            .await
            .unwrap()
            .credentials
            .api_key
            .as_deref(),
        Some("rotated-access")
    );
    env.0.lock()["auth"]["expiresAt"] = json!(1);
    assert_eq!(
        adapter.authorize(&http, false).await.err().unwrap().code,
        "connection_login_required"
    );
    env.0.lock()["account"]["uid"] = json!("user-b");
    assert_eq!(
        adapter.authorize(&http, false).await.err().unwrap().code,
        "identity_changed"
    );
}

#[tokio::test]
async fn catalog_request_uses_account_headers_and_keeps_remote_errors_private() {
    let server = MockServer::start().await;
    let env = Arc::new(Env(Mutex::new(source())));
    let mut adapter = WorkBuddy::new(env.login().await.unwrap().identity, env);
    adapter.endpoint = server.uri();
    Mock::given(method("GET"))
        .and(path("/v3/config"))
        .and(header("authorization", "Bearer test-access"))
        .and(header("x-user-id", "user-a"))
        .and(header("x-domain", "www.workbuddy.cn"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"code":0,"data":config()})))
        .expect(1)
        .mount(&server)
        .await;
    assert_eq!(adapter.catalog(&http_client()).await.unwrap().len(), 3);
    server.verify().await;
    server.reset().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(403).set_body_string("SECRET-TOKEN"))
        .mount(&server)
        .await;
    let error = adapter.catalog(&http_client()).await.err().unwrap();
    assert_eq!(error.http_status, Some(403));
    assert!(!format!("{error:?}").contains("SECRET"));
}

#[tokio::test]
async fn transport_preserves_controls_and_scopes_and_rejects_truncated_streams() {
    use finx_llm::{AuthConfig, Compat, ProviderConfig, WireApi, WireRequest};
    let server = MockServer::start().await;
    let provider = ProviderConfig {
        plan: None,
        endpoints: Default::default(),
        custom: false,
        id: "workbuddy-test".into(),
        name: "WorkBuddy".into(),
        names: Default::default(),
        api: "openai-chat".into(),
        base_url: server.uri(),
        auth: AuthConfig::Managed,
        headers: BTreeMap::new(),
        currency: Default::default(),
        listing: Default::default(),
        compat: Compat {
            thinking_format: crate::adapter::thinking_format("workbuddy"),
            ..Default::default()
        },
    };
    let mut model = provider.ad_hoc_model("auto");
    model.reasoning = true;
    model.thinking = vec![ThinkingLevel::High];
    let model = Arc::new(model);
    let make = |context: Context| WireRequest {
        model: model.clone(),
        context: Arc::new(context),
        credentials: Credentials {
            api_key: Some("synthetic".into()),
            headers: BTreeMap::from([("X-User-Id".into(), "test-user".into())]),
        },
        options: RequestOptions {
            max_output_tokens: Some(512),
            thinking: ThinkingLevel::High,
            cache_key: Some("/private/session/path".into()),
            ..Default::default()
        },
        http: http_client(),
        timeouts: Default::default(),
    };
    let context = Context {
        system: "test-system".into(),
        messages: vec![UserMessage::text("你好").into()],
        tools: vec![],
    };
    Mock::given(method("POST")).and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_string("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"))
        .mount(&server).await;
    for _ in 0..2 {
        let events: Vec<_> = transport::Http
            .stream(make(context.clone()))
            .collect()
            .await;
        assert!(matches!(events.last(), Some(StreamEvent::Done(_))));
    }
    let mut next_turn = context.clone();
    next_turn.messages.push(UserMessage::text("你好").into());
    let _: Vec<_> = transport::Http.stream(make(next_turn)).collect().await;
    let requests = server.received_requests().await.unwrap();
    let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(body["max_tokens"], 512);
    assert!(body.get("max_completion_tokens").is_none());
    assert_eq!(body["reasoning_effort"], "high");
    assert_eq!(body["messages"][0]["content"], "test-system");
    assert_eq!(requests[0].headers["authorization"], "Bearer synthetic");
    for header in ["x-conversation-id", "x-conversation-request-id"] {
        assert_eq!(requests[0].headers[header], requests[1].headers[header]);
        assert!(
            !requests[0].headers[header]
                .to_str()
                .unwrap()
                .contains("/private")
        );
    }
    assert_ne!(
        requests[0].headers["x-request-id"],
        requests[1].headers["x-request-id"]
    );
    assert_ne!(
        requests[1].headers["x-conversation-request-id"],
        requests[2].headers["x-conversation-request-id"]
    );
    server.reset().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n",
        ))
        .mount(&server)
        .await;
    let events: Vec<_> = transport::Http.stream(make(context)).collect().await;
    assert!(matches!(events.last(), Some(StreamEvent::Failed(_))));
}

async fn answer(
    registry: &ModelRegistry,
    model: Arc<finx_llm::Model>,
    context: Context,
) -> finx_llm::AssistantMessage {
    let mut stream = registry.stream(
        model,
        context,
        RequestOptions {
            max_output_tokens: Some(2048),
            cache_key: Some("workbuddy-probe".into()),
            ..Default::default()
        },
    );
    while let Some(event) = stream.next().await {
        match event {
            StreamEvent::Done(message) => return message,
            StreamEvent::Failed(message) => {
                panic!("WorkBuddy inference failed: {:?}", message.error)
            }
            _ => {}
        }
    }
    panic!("stream ended without completion")
}

/// Opt-in account test: synthetic prompts only; no real tools are executed.
#[tokio::test]
#[ignore = "uses the installed WorkBuddy account for three small inference requests"]
async fn live_workbuddy_connection() {
    let home = tempfile::tempdir().unwrap();
    let registry = Arc::new(ModelRegistry::new(
        Catalog::builtin().unwrap(),
        RegistryOptions {
            retry: finx_llm::RetryPolicy {
                max_retries: Some(0),
                ..Default::default()
            },
            ..Default::default()
        },
    ));
    let env = crate::platform::system_for(home.path(), "workbuddy");
    let manager = crate::Manager::with_environments(
        home.path().into(),
        &registry,
        BTreeMap::from([("workbuddy".into(), env)]),
    );
    let discoveries = manager.discover().await.unwrap();
    assert!(discoveries[0].installed);
    let snapshot = manager
        .connect(finx_protocol::api::ConnectionConnectParams {
            adapter_id: "workbuddy".into(),
            discovery_id: "workbuddy-standard".into(),
            idempotency_key: "workbuddy-live".into(),
        })
        .await
        .unwrap();
    let connection = &snapshot.connections[0];
    let provider = registry.provider(&connection.provider_id).unwrap();
    let model_id = std::env::var("FINX_WORKBUDDY_TEST_MODEL").unwrap_or_else(|_| "auto".into());
    let model = registry.lookup(&provider, &model_id).unwrap();
    eprintln!(
        "WorkBuddy live: {} catalog models; testing {}",
        connection.models.len(),
        model_id
    );
    let message = answer(
        &registry,
        model.clone(),
        Context {
            system: "Reply only FINX_WORKBUDDY_OK.".into(),
            messages: vec![UserMessage::text("Follow the system instruction.").into()],
            tools: vec![],
        },
    )
    .await;
    assert!(message.text().contains("FINX_WORKBUDDY_OK"));
    eprintln!("WorkBuddy live: system/text/SSE passed");
    let mut context = Context {
        system:
            "Call finx_probe with text=你好. After the tool returns, reply with its exact result."
                .into(),
        messages: vec![UserMessage::text("Run the probe now.").into()],
        tools: vec![finx_llm::ToolSpec {
            name: "finx_probe".into(),
            description: "Returns a marker.".into(),
            parameters: json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}),
        }],
    };
    let message = answer(&registry, model.clone(), context.clone()).await;
    let calls = message.tool_calls();
    assert_eq!(calls.len(), 1);
    let call = calls[0];
    assert_eq!(call.name, "finx_probe");
    assert_eq!(call.arguments.to_value()["text"], "你好");
    assert!(call.arguments_error.is_none());
    let result = finx_llm::ToolResultMessage {
        call_id: call.id.clone(),
        tool_name: call.name.clone(),
        content: vec![finx_llm::UserContent::Text {
            text: "FINX_WORKBUDDY_TOOL_OK".into(),
        }],
        is_error: false,
        details: None,
        ts: Default::default(),
        duration_ms: None,
    };
    context.messages.push(Message::Assistant(message.into()));
    context.messages.push(result.into());
    eprintln!("WorkBuddy live: tool ID/name/Unicode arguments passed");
    assert!(
        answer(&registry, model, context)
            .await
            .text()
            .contains("FINX_WORKBUDDY_TOOL_OK")
    );
    eprintln!("WorkBuddy live: tool result roundtrip passed");
    let saved = std::fs::read_to_string(home.path().join("connections/config.json")).unwrap();
    assert!(!saved.contains("accessToken") && !saved.contains("refreshToken"));
}
