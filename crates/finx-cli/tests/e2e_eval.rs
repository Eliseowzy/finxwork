//! End-to-end: the browser eval harness (finx-eval) runs a case through the real `finx exec`
//! and a real Chromium, with the mock model playing the agent, and judges it by what the
//! fixture site received.

mod common;

use common::TestEnv;
use finx_eval::Case;
use finx_eval::Runner;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

fn write_case(root: &Path, name: &str, toml_text: &str) -> Case {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("case.toml"), toml_text).unwrap();
    std::fs::write(
        dir.join("index.html"),
        r#"<!doctype html><title>Order</title><h1>Order</h1>
        <button onclick="fetch('/api/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item:'mug'})}).then(()=>document.body.append('Ordered.'))">Order a mug</button>"#,
    )
    .unwrap();
    Case::load(&dir).unwrap()
}

fn runner(env: &TestEnv) -> Runner {
    Runner {
        finx: PathBuf::from(env!("CARGO_BIN_EXE_finx")),
        model: None,
        thinking: None,
        config: vec!["browser.headless=true".into()],
        env: vec![
            ("FINX_HOME".into(), env.home.path().into()),
            ("HOME".into(), env.user_home().into()),
            ("FINX_CREDENTIAL_STORE".into(), "file".into()),
            ("FINX_MODEL_CATALOG_URL".into(), env.mock.catalog_url().into()),
        ],
        timeout: Duration::from_secs(120),
        keep_sessions: false,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_case_runs_through_finx_exec_and_is_judged_by_what_the_site_received() {
    if finx_browser::launch::find_executable().is_none() {
        eprintln!("no Chromium-family browser installed; skipping");
        return;
    }
    let env = TestEnv::new("manual", "").await;
    let cases = env.workspace("cases");
    // The mock navigates to the page, clicks its first button and reports the click.
    let pass = write_case(
        &cases,
        "order",
        r#"
        description = "click the order button"
        prompt = "[[mock:browser:{base}/]]"
        [[expect]]
        request = "POST /api/order"
        fields = { item = "mug" }
        [[expect]]
        answer = "browser done"
        "#,
    );
    let fail = write_case(
        &cases,
        "never",
        r#"
        description = "expects what the page never sends, and forbids what it does"
        prompt = "[[mock:browser:{base}/]]"
        [[expect]]
        request = "POST /api/cancel"
        [[forbid]]
        request = "POST /api/order"
        "#,
    );
    let runner = runner(&env);

    let result = runner.run(&pass, 1).await;
    assert!(result.passed, "{:#?}", result);
    assert_eq!(result.model, "mock/mock-1");
    assert_eq!(result.requests.len(), 1);
    // Only the browser tools: the eval turns every other tool off.
    assert!(result.tools.keys().all(|name| name.starts_with("browser_")), "{:?}", result.tools);
    assert_eq!(result.tools["browser_navigate"].ok, 1);
    assert_eq!(result.tools["browser_act"].ok, 1);
    assert!(result.turns >= 1 && result.input_tokens > 0);

    let result = runner.run(&fail, 1).await;
    assert!(!result.passed);
    assert_eq!(
        result.failures,
        vec!["expected request POST /api/cancel".to_string(), "forbidden request POST /api/order".to_string()]
    );
}
