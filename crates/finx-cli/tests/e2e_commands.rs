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
        (&["models", "login", "chatgpt-api"], "finx login chatgpt"),
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_action_nobody_could_approve_is_exit_3() {
    let env = TestEnv::new("manual", "").await;
    let cwd = env.workspace("refused");
    let out = env
        .finx_in(&cwd, &["exec", "--json", "[[mock:bash:touch made.txt]] go"])
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .unwrap();
    assert_eq!(out.status.code(), Some(3), "{}", String::from_utf8_lossy(&out.stderr));
    let result = parsed(&String::from_utf8_lossy(&out.stdout));
    assert_eq!(result["exit_code"], 3);
    assert_eq!(result["refused"][0]["name"], "bash", "{result:#}");
    assert!(result["refused"][0]["summary"].as_str().unwrap().contains("touch made.txt"), "{result:#}");
    assert!(!cwd.join("made.txt").exists());
    assert!(String::from_utf8_lossy(&out.stderr).contains("--permission-mode"), "stderr says what to do");

    // With a mode that lets it through: 0, and nothing refused.
    let out = env
        .finx_in(&cwd, &["exec", "--json", "--permission-mode", "bypass-permissions", "[[mock:bash:touch made.txt]] go"])
        .output()
        .await
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(parsed(&String::from_utf8_lossy(&out.stdout))["refused"], serde_json::json!([]));
    assert!(cwd.join("made.txt").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tools_add_dir_and_image_reach_the_run() {
    let env = TestEnv::new("bypass-permissions", "").await;
    // A tool name that does not exist is a usage problem.
    let (code, _, stderr) = run(&env, &["exec", "--tools", "read,nonsense", "hi"]).await;
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("nonsense"), "{stderr}");
    let (code, stdout, stderr) = run(&env, &["exec", "--tools", "read,bash", "--json", "say hi"]).await;
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(parsed(&stdout)["final_output"], "Hello from mock.");

    // An image that is not one, and one that is.
    let (code, _, stderr) = run(&env, &["exec", "--image", "notes.txt", "hi"]).await;
    assert_eq!(code, 2);
    assert!(stderr.contains("--image notes.txt"), "{stderr}");
    let picture = env.work().join("p.png");
    std::fs::write(&picture, [0x89, b'P', b'N', b'G']).unwrap();
    let (code, stdout, stderr) = run(&env, &["exec", "--json", "--image", picture.to_str().unwrap(), "hi"]).await;
    assert_eq!(code, 0, "{stderr}");
    let log = std::fs::read_to_string(parsed(&stdout)["session_file"].as_str().unwrap()).unwrap();
    assert!(log.contains("image/png"), "the image is part of the message: {log}");

    // Writing outside the workspace with --add-dir, in a mode that keeps to the workspace.
    let elsewhere = env.workspace("elsewhere");
    let cwd = env.workspace("here");
    let target = elsewhere.join("made.txt");
    let prompt = format!("[[mock:bash:touch {}]] go", target.display());
    let out = env
        .finx_in(&cwd, &["exec", "--add-dir", elsewhere.to_str().unwrap(), "--permission-mode", "accept-edits", &prompt])
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .unwrap();
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(target.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_completion_script_knows_the_commands() {
    let env = TestEnv::new("manual", "").await;
    for shell in ["bash", "zsh", "fish"] {
        let (code, stdout, stderr) = run(&env, &["completion", shell]).await;
        assert_eq!(code, 0, "{shell}: {stderr}");
        for word in ["exec", "models", "unhide", "--permission-mode"] {
            assert!(stdout.contains(word), "{shell}: {word}");
        }
    }
    let (code, _, _) = run(&env, &["completion", "tcsh"]).await;
    assert_eq!(code, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_setting_from_a_newer_version_stops_nothing() {
    let env = TestEnv::new("manual", "").await;
    let config = env.home.path().join("config.toml");
    let mut text = std::fs::read_to_string(&config).unwrap();
    text.push_str("\n[from_the_future]\nanswer = 42\n");
    std::fs::write(&config, text).unwrap();
    let models = env.home.path().join("models.toml");
    let mut text = std::fs::read_to_string(&models).unwrap();
    text.push_str("\n[providers.deepseek.from_the_future]\nanswer = 42\n");
    std::fs::write(&models, text).unwrap();

    for args in [&["status", "--json"][..], &["models", "--json"], &["sessions", "--json"]] {
        let (code, stdout, stderr) = run(&env, args).await;
        assert_eq!(code, 0, "{args:?}: {stderr}");
        parsed(&stdout);
    }
    let (code, stdout, _) = run(&env, &["doctor", "--json"]).await;
    assert_eq!(code, 0);
    let doctor = parsed(&stdout);
    let warnings = doctor["warnings"].to_string();
    assert!(warnings.contains("from_the_future"), "{doctor:#}");
    let (code, stdout, _) = run(&env, &["doctor", "--json", "--strict"]).await;
    assert_eq!(code, 1, "--strict counts warnings as failures");
    assert_eq!(parsed(&stdout)["ok"], false);
    let (code, _, stderr) = run(&env, &["exec", "say hi"]).await;
    assert_eq!(code, 0, "{stderr}");
    assert!(stderr.contains("from_the_future"), "the warning is shown: {stderr}");

    // The editors' way in works too.
    let (mut child, client, _incoming) = env.spawn_rpc(&["acp"]);
    client
        .request("initialize", serde_json::json!({"protocolVersion": 1, "clientCapabilities": {}, "clientInfo": {"name": "e2e", "version": "1"}}))
        .await
        .unwrap();
    drop(client);
    assert_eq!(common::exit_code(&mut child).await, 0);

    // A value this version cannot read still stops it: it must not guess.
    let mut text = std::fs::read_to_string(&config).unwrap();
    text = text.replace("permission_mode = \"manual\"", "permission_mode = \"plan\"");
    std::fs::write(&config, text).unwrap();
    let (code, _, stderr) = run(&env, &["status"]).await;
    assert_eq!(code, 2, "{stderr}");
}

/// A key saved by another process reaches a running service: its clients hear, and see it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_key_saved_elsewhere_reaches_a_running_service() {
    let env = TestEnv::new("manual", "").await;
    let (_service, service, mut incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    common::native_init(&service).await;
    let credential = |models: &Value| {
        models["providers"].as_array().unwrap().iter().find(|p| p["id"] == "deepseek").unwrap()["credential"].as_str().unwrap().to_string()
    };
    let before = service.request("models/list", serde_json::json!({})).await.unwrap();
    assert_eq!(credential(&before), "missing");

    let (_other, other, _other_incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    common::native_init(&other).await;
    other.request("auth/set", serde_json::json!({"provider": "deepseek", "api_key": "sk-from-elsewhere"})).await.unwrap();

    let after = service.request("models/list", serde_json::json!({})).await.unwrap();
    assert_eq!(credential(&after), "stored", "seen at the next look");
    // And without looking: within the watcher's tick.
    let heard = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let message = common::next(&mut incoming).await;
            if message.method() == "models/changed" {
                return;
            }
        }
    })
    .await;
    assert!(heard.is_ok(), "models/changed never came");
}
