//! End-to-end: how the commands behave as people and scripts meet them
//! (docs/kernel/standalone-cli-design.md §4).

mod common;

use common::TestEnv;
use serde_json::Value;

async fn run(env: &TestEnv, args: &[&str]) -> (i32, String, String) {
    let out = env.finx(args).output().await.expect("run finx");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn parsed(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|err| panic!("not one JSON value ({err}): {text}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn json_is_one_value_and_the_stream_has_its_own_name() {
    let env = TestEnv::new("bypass-permissions", "").await;
    let (code, stdout, stderr) = run(&env, &["exec", "--json", "say hi"]).await;
    assert_eq!(code, 0, "{stderr}");
    let result = parsed(&stdout);
    assert_eq!(result["final_output"], "Hello from mock.", "{result:#}");
    assert_eq!(result["exit_code"], 0);

    let (code, plain, _) = run(&env, &["exec", "--output", "json", "say hi"]).await;
    assert_eq!(code, 0);
    assert_eq!(parsed(&plain)["final_output"], "Hello from mock.");

    let (code, stream, _) = run(&env, &["exec", "--output", "stream-json", "say hi"]).await;
    assert_eq!(code, 0);
    let events: Vec<Value> = stream.lines().map(parsed).collect();
    assert!(events.len() > 1, "{stream}");
    assert!(events.iter().any(|event| event["type"] == "task_completed"), "{stream}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failure_under_json_is_json_on_stdout() {
    let env = TestEnv::new("manual", "").await;
    let (code, stdout, stderr) = run(&env, &["status", "--json", "--nope"]).await;
    assert_eq!(code, 2);
    assert_eq!(stderr, "", "nothing else to parse around it");
    let failure = parsed(&stdout);
    assert_eq!(failure["error"]["kind"], "usage_error", "{failure:#}");
    assert_eq!(failure["exit_code"], 2);
    assert!(failure["error"]["message"].as_str().unwrap().contains("--nope"), "{failure:#}");

    // Without --json, as ever: words on stderr.
    let (code, stdout, stderr) = run(&env, &["status", "--nope"]).await;
    assert_eq!(code, 2);
    assert_eq!(stdout, "");
    assert!(stderr.contains("--nope"), "{stderr}");

    // A failure after parsing goes the same way.
    let (code, stdout, stderr) = run(&env, &["exec", "--json", "--resume", "no-such-session", "hi"]).await;
    assert_eq!(code, 2, "{stderr}");
    assert_eq!(stderr, "");
    assert_eq!(parsed(&stdout)["error"]["kind"], "error", "{stdout}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn spellings_from_elsewhere_say_what_to_write() {
    let env = TestEnv::new("manual", "").await;
    for (args, expected) in [
        (&["-p", "hi"][..], "finx exec \"PROMPT\""),
        (&["--print", "hi"], "finx exec \"PROMPT\""),
        (&["--continue"], "finx exec --resume"),
        (&["resume", "last"], "finx exec --resume"),
        (&["resume", "last", "-p", "next"], "finx exec --resume"),
        (&["exec", "hi", "--continue"], "finx exec --resume"),
        (&["models", "show", "a/b"], "finx models unhide"),
    ] {
        let (code, stdout, stderr) = run(&env, args).await;
        assert_eq!(code, 2, "{args:?}: {stderr}");
        assert_eq!(stdout, "", "{args:?}");
        assert!(stderr.contains(expected), "{args:?}: {stderr}");
    }
    // With --json the same advice is a field.
    let (code, stdout, _) = run(&env, &["exec", "hi", "--continue", "--json"]).await;
    assert_eq!(code, 2);
    assert!(parsed(&stdout)["error"]["help"].as_str().unwrap().contains("finx exec --resume"), "{stdout}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_version_and_the_help() {
    let env = TestEnv::new("manual", "").await;
    for flag in ["-v", "-V", "--version"] {
        let (code, stdout, _) = run(&env, &[flag]).await;
        assert_eq!(code, 0, "{flag}");
        assert!(stdout.starts_with("finx "), "{flag}: {stdout}");
    }
    let (code, help, _) = run(&env, &["--help"]).await;
    assert_eq!(code, 0);
    for heading in ["Run tasks:", "Models:", "Tools and extensions:", "Setup:", "For other programs:", "Options:", "Examples:"] {
        assert!(help.contains(heading), "{heading}: {help}");
    }
    assert!(help.contains("-c, --config"), "{help}");
    assert!(!help.contains("  chat "), "chat is not offered: {help}");
    // Hidden, not gone: it still checks a model by hand.
    let (code, help, _) = run(&env, &["chat", "--help"]).await;
    assert_eq!(code, 0);
    assert!(help.contains("--tool-test"), "{help}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_group_lists_with_or_without_the_word() {
    let env = TestEnv::new("manual", "").await;
    for (bare, with_list) in [
        (&["mcp", "--json"][..], &["mcp", "list", "--json"][..]),
        (&["models", "--json"], &["models", "list", "--json"]),
        (&["sessions", "--json"], &["sessions", "list", "--json"]),
        (&["skills", "--json"], &["skills", "list", "--json"]),
    ] {
        let (code, first, stderr) = run(&env, bare).await;
        assert_eq!(code, 0, "{bare:?}: {stderr}");
        let (code, second, stderr) = run(&env, with_list).await;
        assert_eq!(code, 0, "{with_list:?}: {stderr}");
        assert_eq!(parsed(&first), parsed(&second), "{bare:?}");
    }
    // Text as well, for the one that needed the word until now.
    let (code, _, stderr) = run(&env, &["mcp"]).await;
    assert_eq!(code, 0, "{stderr}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_setter_says_what_it_set_and_where() {
    let env = TestEnv::new("manual", "").await;
    let (code, stdout, stderr) = run(&env, &["models", "hide", "mock/mock-2"]).await;
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(stdout.lines().count(), 1, "{stdout}");
    assert!(stdout.contains("hid mock/mock-2 in ") && stdout.contains("selection.json"), "{stdout}");
    let (code, stdout, stderr) = run(&env, &["models", "unhide", "mock/mock-2"]).await;
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("unhid mock/mock-2 in ") && stdout.contains("selection.json"), "{stdout}");

    let project = env.workspace("trusted");
    let (code, stdout, stderr) = run(&env, &["trust", project.to_str().unwrap()]).await;
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("trusted ") && stdout.contains("trusted.toml"), "{stdout}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_status_of_the_browser_extension_takes_json() {
    let env = TestEnv::new("manual", "").await;
    let (code, stdout, stderr) = run(&env, &["browser", "extension", "status", "--json"]).await;
    assert_eq!(code, 0, "{stderr}");
    let status = parsed(&stdout);
    assert_eq!(status["browsers"], serde_json::json!([]), "{status:#}");
    assert_eq!(status["host"], Value::Null, "{status:#}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scopes_for_mcp_have_git_s_words() {
    let env = TestEnv::new("manual", "").await;
    let (code, _, stderr) = run(&env, &["mcp", "disable", "nothing", "--here"]).await;
    assert_eq!(code, 2);
    assert!(stderr.contains("--here"), "the old word is gone: {stderr}");
    let (_, _, stderr) = run(&env, &["mcp", "disable", "nothing", "--local"]).await;
    assert!(!stderr.contains("unexpected argument"), "{stderr}");
    let (_, _, stderr) = run(&env, &["mcp", "disable", "nothing", "--global"]).await;
    assert!(!stderr.contains("unexpected argument"), "{stderr}");
}
