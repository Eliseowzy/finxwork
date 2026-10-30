use super::*;
use parking_lot::Mutex;
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, AtomicI64, Ordering},
};
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_json, method, path},
};
struct Env {
    now: AtomicI64,
    source_expires: AtomicI64,
    identity: Mutex<String>,
    store: Mutex<BTreeMap<String, String>>,
    fail_save: AtomicBool,
}
impl Env {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            now: AtomicI64::new(1_000_000),
            source_expires: AtomicI64::new(100_000_000),
            identity: Mutex::new("account-a".into()),
            store: Mutex::new(BTreeMap::new()),
            fail_save: AtomicBool::new(false),
        })
    }
}
#[async_trait]
impl Environment for Env {
    async fn discover(&self) -> Result<finx_protocol::api::ConnectionDiscovery> {
        unreachable!()
    }
    async fn login(&self) -> Result<Login> {
        Ok(Login {
            token: "source-access".into(),
            expires: self.source_expires.load(Ordering::Relaxed),
            identity: self.identity.lock().clone(),
            subject: Some("user-a".into()),
        })
    }
    async fn headers(&self) -> Result<BTreeMap<String, String>> {
        Ok(BTreeMap::new())
    }
    async fn get(&self, id: &str) -> Result<Option<String>> {
        Ok(self.store.lock().get(id).cloned())
    }
    async fn set(&self, id: &str, v: &str) -> Result<()> {
        if self.fail_save.load(Ordering::Relaxed) {
            return Err(ConnectionError::new(
                "connection_permission_required",
                "save denied",
            ));
        }
        self.store.lock().insert(id.into(), v.into());
        Ok(())
    }
    async fn delete(&self, id: &str) -> Result<()> {
        self.store.lock().remove(id);
        Ok(())
    }
    fn now(&self) -> i64 {
        self.now.load(Ordering::Relaxed)
    }
}
fn pair(token: &str, refresh: &str) -> Value {
    json!({"token":token,"refresh_token":refresh,"expires_in":86_400_000,"refresh_token_expires_in":172_800_000})
}
async fn setup() -> (MockServer, Arc<Env>, Qoder, reqwest::Client) {
    let server = MockServer::start().await;
    let env = Env::new();
    let mut q = Qoder::new("connection".into(), "account-a".into(), env.clone());
    q.openapi = server.uri();
    q.catalog_url = format!("{}/algo/api/v2/model/list?Encode=1", server.uri());
    (
        server,
        env,
        q,
        finx_llm::ModelRegistry::new(
            finx_llm::Catalog::builtin().unwrap(),
            finx_llm::RegistryOptions::default(),
        )
        .http_client()
        .unwrap(),
    )
}
async fn issue(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/api/v1/me/jobToken"))
        .and(body_json(json!({"clientId":CLIENT_ID})))
        .respond_with(ResponseTemplate::new(200).set_body_json(pair("job-a", "refresh-a")))
        .expect(1)
        .mount(server)
        .await;
}
#[tokio::test]
async fn issue_and_reload_use_independent_pair_without_account_refresh() {
    let (s, env, mut q, http) = setup().await;
    issue(&s).await;
    let a = q.authorize(&http, false).await.unwrap();
    assert_eq!(a.credentials.api_key.as_deref(), Some("job-a"));
    assert_eq!(q.saved.job.as_ref().unwrap().expires, 87_400_000);
    let mut other = Qoder::new("connection".into(), "account-a".into(), env);
    other.openapi = s.uri();
    other.authorize(&http, false).await.unwrap();
    assert_eq!(s.received_requests().await.unwrap().len(), 1);
}
#[tokio::test]
async fn refresh_rotates_entire_pair_even_when_source_access_expired() {
    let (s, env, mut q, http) = setup().await;
    issue(&s).await;
    q.authorize(&http, false).await.unwrap();
    env.source_expires.store(0, Ordering::Relaxed);
    Mock::given(path("/api/v1/jobToken/refresh"))
        .and(body_json(json!({"refresh_token":"refresh-a"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(pair("job-b", "refresh-b")))
        .expect(1)
        .mount(&s)
        .await;
    q.authorize(&http, true).await.unwrap();
    let saved: Saved = serde_json::from_str(env.store.lock().get("connection").unwrap()).unwrap();
    assert_eq!(saved.job.unwrap().refresh_token, "refresh-b");
}
#[tokio::test]
async fn save_failure_retries_persistence_without_reusing_spent_refresh() {
    let (s, env, mut q, http) = setup().await;
    issue(&s).await;
    q.authorize(&http, false).await.unwrap();
    Mock::given(path("/api/v1/jobToken/refresh"))
        .respond_with(ResponseTemplate::new(200).set_body_json(pair("job-b", "refresh-b")))
        .expect(1)
        .mount(&s)
        .await;
    env.fail_save.store(true, Ordering::Relaxed);
    assert!(q.authorize(&http, true).await.is_err());
    env.fail_save.store(false, Ordering::Relaxed);
    let a = q.authorize(&http, false).await.unwrap();
    assert_eq!(a.credentials.api_key.as_deref(), Some("job-b"));
}
#[tokio::test]
async fn account_switch_deletes_only_own_record() {
    let (s, env, mut q, http) = setup().await;
    issue(&s).await;
    q.authorize(&http, false).await.unwrap();
    *env.identity.lock() = "account-b".into();
    assert_eq!(
        q.authorize(&http, false).await.err().unwrap().code,
        "identity_changed"
    );
    assert!(env.store.lock().is_empty());
}
#[tokio::test]
async fn listing_preserves_other_models_without_publishing_them() {
    let (s, _, mut q, http) = setup().await;
    issue(&s).await;
    Mock::given(path("/algo/api/v2/model/list")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"app":[{"key":"auto","display_name":"Auto","enable":true,"max_input_tokens":200000},{"key":"qfmodel","enable":true},{"key":"disabled","enable":false}]}))).expect(1).mount(&s).await;
    let models = q.catalog(&http).await.unwrap();
    assert_eq!(
        models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["auto", "qfmodel"]
    );
}
#[test]
fn source_rejects_unknown_schema_and_dates() {
    assert!(source_login(&json!({"schemaVersion":2})).is_err());
    assert!(parse_job(&json!({"token":"a","refresh_token":"b","expires_in":86400,"refresh_token_expires_in":0}),1_000_000).is_err());
}

/// Explicit opt-in: reads local Qoder login, creates a private finx connection and sends a small request.
#[tokio::test]
#[ignore = "requires local Qoder login and an explicit live test"]
async fn live_qoder_connection() {
    use finx_llm::{
        Catalog, Context, Message, ModelRegistry, RegistryOptions, RequestOptions, StreamEvent,
        UserMessage,
    };
    use futures::StreamExt;
    let home = dirs::home_dir().unwrap().join(".finx-qoder-e2e");
    tokio::fs::create_dir_all(&home).await.unwrap();
    let env = crate::platform::system_for(&home, "qoder");
    let source = env.interactive_login().await.unwrap();
    assert!(source.subject.is_some());
    let llm = Arc::new(ModelRegistry::new(
        Catalog::builtin().unwrap(),
        RegistryOptions::default(),
    ));
    let manager = crate::Manager::with_environments(
        home.clone(),
        &llm,
        BTreeMap::from([("qoder".into(), env)]),
    );
    let initial = manager.snapshot().unwrap();
    let snapshot = if let Some(c) = initial.connections.first() {
        manager.retry(&c.connection_id).await.unwrap()
    } else {
        manager
            .connect(finx_protocol::api::ConnectionConnectParams {
                adapter_id: "qoder".into(),
                discovery_id: "qoder-standard".into(),
                idempotency_key: "live-qoder".into(),
            })
            .await
            .unwrap()
    };
    let c = &snapshot.connections[0];
    assert!(c.models.iter().any(|m| m.id == "auto"));
    let provider = llm.provider(&format!("local-{}", c.connection_id)).unwrap();
    assert_eq!(provider.models.len(), 1);
    let model = provider.model("auto").unwrap();
    let context = Context {
        system: "Reply with exactly FINX_QODER_RUST_OK.".into(),
        messages: vec![Message::User(UserMessage::text("Hello").into())],
        tools: vec![],
    };
    let mut stream = llm.stream(model, context, RequestOptions::default());
    let mut success = false;
    while let Some(event) = stream.next().await {
        match event {
            StreamEvent::Done(message) => {
                assert!(message.text().contains("FINX_QODER_RUST_OK"));
                success = true;
            }
            StreamEvent::Failed(message) => panic!(
                "live inference failed: {:?}",
                message.error.as_ref().map(|e| e.kind)
            ),
            _ => {}
        }
    }
    assert!(success);
}

#[tokio::test]
async fn offline_past_refresh_expiry_reissues_from_source() {
    let (s, env, mut q, http) = setup().await;
    issue(&s).await;
    q.authorize(&http, false).await.unwrap();
    s.reset().await;
    env.now.store(180_000_000, Ordering::Relaxed);
    env.source_expires.store(300_000_000, Ordering::Relaxed);
    Mock::given(path("/api/v1/me/jobToken"))
        .respond_with(ResponseTemplate::new(200).set_body_json(pair("reissued", "new-refresh")))
        .expect(1)
        .mount(&s)
        .await;
    assert_eq!(
        q.authorize(&http, false)
            .await
            .unwrap()
            .credentials
            .api_key
            .as_deref(),
        Some("reissued")
    );
    assert_eq!(s.received_requests().await.unwrap().len(), 1);
}
#[tokio::test]
async fn uncertain_refresh_never_retries_spent_token() {
    let (s, _, mut q, http) = setup().await;
    issue(&s).await;
    q.authorize(&http, false).await.unwrap();
    s.reset().await;
    Mock::given(path("/api/v1/jobToken/refresh"))
        .respond_with(ResponseTemplate::new(503))
        .expect(1)
        .mount(&s)
        .await;
    Mock::given(path("/api/v1/me/jobToken"))
        .respond_with(ResponseTemplate::new(200).set_body_json(pair("reissued", "new-refresh")))
        .expect(1)
        .mount(&s)
        .await;
    assert_eq!(
        q.authorize(&http, true)
            .await
            .unwrap()
            .credentials
            .api_key
            .as_deref(),
        Some("reissued")
    );
    q.authorize(&http, false).await.unwrap();
}
#[tokio::test]
async fn strict_transport_rejects_partial_and_malformed_tools_and_keeps_system() {
    use finx_llm::{
        AuthConfig, Compat, Context, Message, ProviderConfig, RequestOptions, StreamEvent,
        UserMessage, WireApi, WireRequest,
    };
    use futures::StreamExt;
    let (s, _, _, http) = setup().await;
    let provider = ProviderConfig {
        id: "local-test".into(),
        name: "test".into(),
        api: "openai-chat".into(),
        base_url: s.uri(),
        auth: AuthConfig::Managed,
        headers: BTreeMap::new(),
        currency: Default::default(),
        compat: Compat::default(),
        models: vec![],
    };
    for response in [
        "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c\",\"function\":{\"name\":\"probe\",\"arguments\":\"{broken\"}}]},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
    ] {
        s.reset().await;
        Mock::given(path("/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(response),
            )
            .mount(&s)
            .await;
        let events: Vec<_> = Http
            .stream(WireRequest {
                model: Arc::new(provider.ad_hoc_model("auto")),
                credentials: Credentials::with_key("private".into()),
                context: Arc::new(Context {
                    system: "finx system".into(),
                    messages: vec![Message::from(UserMessage::text("hi"))],
                    tools: vec![],
                }),
                options: RequestOptions {
                    extra_body: serde_json::from_value(
                        json!({"model":"injected","messages":[],"metadata":{"token":"bad"}}),
                    )
                    .unwrap(),
                    ..Default::default()
                },
                http: http.clone(),
                timeouts: Default::default(),
            })
            .collect()
            .await;
        assert!(
            matches!(events.last(),Some(StreamEvent::Failed(m)) if m.error.as_ref().unwrap().kind==finx_llm::ErrorKind::Protocol)
        );
        let req = &s.received_requests().await.unwrap()[0];
        let body: Value = serde_json::from_slice(&req.body).unwrap();
        assert_eq!(body["model"], "auto");
        assert_eq!(body["messages"][0]["content"], "finx system");
        assert!(body.get("metadata").is_none());
    }
}

#[tokio::test]
async fn catalog_only_models_cannot_be_invoked_through_ad_hoc_references() {
    use finx_llm::connection::ConnectionAuthorizer;
    let dir = tempfile::tempdir().unwrap();
    let llm = Arc::new(finx_llm::ModelRegistry::new(
        finx_llm::Catalog::builtin().unwrap(),
        finx_llm::RegistryOptions::default(),
    ));
    let id = uuid::Uuid::new_v4().to_string();
    let models = ["auto", "qfmodel"]
        .into_iter()
        .map(|id| ConnectionModel {
            id: id.into(),
            name: id.into(),
            context_window: None,
            max_output_tokens: None,
            reasoning: false,
            images: false,
        })
        .collect();
    let record = crate::Record {
        connection_id: id.clone(),
        adapter_id: "qoder".into(),
        identity_key: "account-a".into(),
        enabled: true,
        idempotency_key: "test".into(),
        models,
    };
    std::fs::create_dir_all(dir.path().join("connections")).unwrap();
    std::fs::write(
        dir.path().join("connections/config.json"),
        serde_json::to_vec(&crate::Config {
            schema: 1,
            connections: vec![record],
        })
        .unwrap(),
    )
    .unwrap();
    let manager = crate::Manager::with_environments(
        dir.path().into(),
        &llm,
        BTreeMap::from([("qoder".into(), Env::new() as Arc<dyn Environment>)]),
    );
    let provider = format!("local-{id}");
    assert_eq!(llm.provider(&provider).unwrap().models.len(), 1);
    assert_eq!(
        manager
            .begin(&provider, "qfmodel", llm.http_client().unwrap())
            .await
            .err()
            .unwrap()
            .provider_code
            .as_deref(),
        Some("unsupported_capability")
    );
}
