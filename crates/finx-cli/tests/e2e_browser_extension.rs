//! End-to-end: the user's own Chrome through the FinxWork extension (browser-design §8.4).
//! A real Chrome loads apps/chrome-extension, starts the real `finx browser native-host`
//! through the manifest that `finx browser extension install` wrote, and that host lends the
//! browser to a real `finx serve`, whose session (driven by the mock model) opens a page and
//! clicks on it. Skipped when no Chromium-family browser is installed. Another test stands in
//! for the extension to check the bridge versions (D-219) without a browser.

mod common;

use common::Demux;
use common::TestEnv;
use common::native_init;
use common::native_prompt;
use finx_browser::launch::LaunchOptions;
use finx_browser::launch::Launcher;
use finx_browser::launch::ManagedLauncher;
use finx_rpc::Client;
use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::UnixStream;

const EXTENSION_ID: &str = "fgaadfmkicjchgjlomjemofnllanlcoo";

async fn serve_page(body: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut buf = vec![0u8; 4096];
            let _ = tokio::io::AsyncReadExt::read(&mut stream, &mut buf).await;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        }
    });
    format!("http://127.0.0.1:{port}/")
}

async fn wait_for(what: &str, mut check: impl FnMut() -> bool) {
    for _ in 0..300 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

fn logs(home: &Path) -> String {
    let mut text = String::new();
    for entry in std::fs::read_dir(home.join("logs")).into_iter().flatten().flatten() {
        text.push_str(&std::fs::read_to_string(entry.path()).unwrap_or_default());
    }
    text
}

/// The URLs of the browser's pages, as Chrome itself lists them.
async fn pages(chrome: &finx_browser::cdp::Conn) -> Vec<String> {
    let targets = chrome.send(None, "Target.getTargets", json!({})).await.unwrap();
    targets["targetInfos"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["type"] == "page")
        .map(|t| t["url"].as_str().unwrap_or_default().to_string())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_session_drives_the_users_chrome_through_the_extension() {
    let Some(chrome_exe) = finx_browser::launch::find_executable() else {
        eprintln!("no Chromium-family browser installed; skipping");
        return;
    };
    let env = TestEnv::new("bypass-permissions", "[browser]\nenabled = true\nbackend = \"extension\"\n").await;
    let profile = env.work().join("chrome-profile");
    let socket = env.home.path().join("run").join("finx.sock");

    // The service, as the desktop app starts it.
    let mut service = env
        .finx(&["serve", "--listen", &format!("unix://{}", socket.display())])
        .spawn()
        .unwrap();
    for _ in 0..200 {
        if UnixStream::connect(&socket).await.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let stream = UnixStream::connect(&socket).await.expect("the service listens");
    let (read, write) = stream.into_split();
    let (client, incoming) = Client::connect(read, write);
    native_init(&client).await;
    let demux = Demux::spawn(incoming);

    // Without the extension, the browser tools say how to get it.
    let cwd = env.workspace("ext");
    let new = client.request("session/new", json!({"cwd": cwd})).await.unwrap();
    let session = new["session_id"].as_str().unwrap().to_string();
    let mut events = demux.subscribe(&session);
    let missing = native_prompt(&client, &mut events, &session, "[[mock:browser:http://127.0.0.1:9/]] open it", true).await;
    let results = serde_json::to_string(&missing.events).unwrap();
    assert!(results.contains("extension is not connected"), "{results}");

    // Register the host for this profile, the way a user does for their Chrome.
    let installed = env
        .finx(&["browser", "extension", "install", "--user-data-dir", profile.to_str().unwrap()])
        .output()
        .await
        .unwrap();
    assert!(installed.status.success(), "{}", String::from_utf8_lossy(&installed.stderr));
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(profile.join("NativeMessagingHosts/com.finxwork.browser.json")).unwrap())
            .unwrap();
    assert_eq!(manifest["allowed_origins"], json!([format!("chrome-extension://{EXTENSION_ID}/")]));

    // Chrome, with the extension loaded (branded Chrome only lets CDP load one, behind a flag).
    let wrapper = env.work().join("chrome.sh");
    std::fs::write(
        &wrapper,
        format!("#!/bin/sh\nexec '{}' --enable-unsafe-extension-debugging \"$@\"\n", chrome_exe.display()),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let launched = ManagedLauncher
        .launch(&LaunchOptions {
            executable: Some(wrapper),
            user_data_dir: profile.clone(),
            headless: true,
        })
        .await
        .expect("Chrome starts");
    let chrome = launched.conn.clone();
    let _child = launched.child;
    let extension = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/chrome-extension");
    let loaded = chrome
        .send(None, "Extensions.loadUnpacked", json!({"path": std::fs::canonicalize(extension).unwrap()}))
        .await
        .expect("the extension loads");
    assert_eq!(loaded["id"], EXTENSION_ID, "the key in manifest.json fixes the ID");

    // The extension starts the host, and the host reaches the service.
    let home = env.home.path().to_path_buf();
    wait_for("the extension host to connect", || logs(&home).contains("extension host connected")).await;

    // A tab the user had open stays out of the agent's reach.
    let mine = serve_page("<title>Mine</title><p>the user's own page</p>").await;
    chrome.send(None, "Target.createTarget", json!({"url": mine})).await.unwrap();

    // The session opens a page and clicks its button, in the user's Chrome.
    let page = serve_page(
        "<title>Lent</title><h1>In the user's Chrome</h1>\
         <button onclick=\"document.body.insertAdjacentHTML('beforeend','<p>clicked it</p>')\">Go</button>",
    )
    .await;
    let turn = native_prompt(&client, &mut events, &session, &format!("[[mock:browser:{page}]] open it"), true).await;
    assert_eq!(turn.end["type"], "task_completed", "{:?}", turn.events);
    assert!(turn.text.contains("clicked it"), "{}", turn.text);
    let opened = turn
        .events
        .iter()
        .find(|e| e["type"] == "tool_completed" && e["result"].to_string().contains("In the user's Chrome"))
        .unwrap_or_else(|| panic!("the navigation's result: {:?}", turn.events));
    let opened = opened["result"].to_string();
    assert!(opened.contains("the user's own Chrome"), "the model is told whose browser it is: {opened}");
    assert!(!opened.contains("the user's own page"), "{opened}");
    let urls = pages(&chrome).await;
    assert!(urls.contains(&page) && urls.contains(&mine), "{urls:?}");

    // Closing the session closes the agent's tab, and only that one.
    client.request("session/close", json!({"session_id": session})).await.unwrap();
    let mut urls = Vec::new();
    for _ in 0..100 {
        urls = pages(&chrome).await;
        if !urls.contains(&page) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!urls.contains(&page) && urls.contains(&mine), "{urls:?}");

    client.request("server/shutdown", json!({})).await.unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(20), service.wait()).await;
}

/// One Native Messaging frame, as Chrome writes it.
fn frame(message: &Value) -> Vec<u8> {
    let json = message.to_string();
    let mut out = (json.len() as u32).to_ne_bytes().to_vec();
    out.extend_from_slice(json.as_bytes());
    out
}

/// The host's next message with a `status`, skipping CDP.
async fn next_status(out: &mut tokio::process::ChildStdout) -> Value {
    use tokio::io::AsyncReadExt as _;
    loop {
        let mut length = [0u8; 4];
        tokio::time::timeout(Duration::from_secs(20), out.read_exact(&mut length)).await.expect("the host answers").unwrap();
        let mut body = vec![0u8; u32::from_ne_bytes(length) as usize];
        out.read_exact(&mut body).await.unwrap();
        let message: Value = serde_json::from_slice(&body).unwrap();
        if message.get("status").is_some() {
            return message;
        }
    }
}

/// Stands in for the extension: starts the real host, says hello, and returns its first status.
async fn hello(env: &TestEnv, hello: Value) -> (tokio::process::Child, Value) {
    let mut host = env
        .finx(&["browser", "native-host"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    host.stdin.as_mut().unwrap().write_all(&frame(&json!({"hello": hello}))).await.unwrap();
    let status = next_status(host.stdout.as_mut().unwrap()).await;
    (host, status)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_extension_and_finx_agree_on_a_bridge_version_or_say_which_to_update() {
    let env = TestEnv::new("manual", "").await;
    let socket = env.home.path().join("run").join("finx.sock");
    let mut service = env
        .finx(&["serve", "--listen", &format!("unix://{}", socket.display())])
        .spawn()
        .unwrap();
    for _ in 0..200 {
        if UnixStream::connect(&socket).await.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let stream = UnixStream::connect(&socket).await.expect("the service listens");
    let (read, write) = stream.into_split();
    let (client, incoming) = Client::connect(read, write);
    native_init(&client).await;
    let _demux = Demux::spawn(incoming);
    let status = || async { client.request("browser/status", json!({})).await.unwrap() };

    // An extension newer than this finx: held, not used, and the app is told to update.
    let future = finx_browser::methods::BRIDGE + 1;
    let (mut host, said) =
        hello(&env, json!({"browser": "Google Chrome 999", "extension_version": "9.0.0", "bridge": {"min": future, "max": future}}))
            .await;
    assert_eq!(said["status"], "outdated", "{said}");
    assert_eq!(said["update"], "finx", "{said}");
    let now = status().await;
    assert_eq!(now["extension"]["problem"], "update_finx", "{now}");
    assert_eq!(now["extension"]["extension_version"], "9.0.0", "{now}");
    host.kill().await.unwrap();
    let _ = host.wait().await;
    let mut gone = Value::Null;
    for _ in 0..100 {
        gone = status().await;
        if gone.get("extension").is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(gone.get("extension").is_none(), "its status goes with it: {gone}");

    // An extension from before bridge versions speaks version 1, which this finx still drives.
    let (mut host, said) = hello(&env, json!({"browser": "Google Chrome 141", "extension_version": "0.1.0"})).await;
    assert_eq!(said, json!({"status": "connected", "bridge": 1}), "{said}");
    let now = status().await;
    assert!(now["extension"].get("problem").is_none(), "{now}");
    host.kill().await.unwrap();

    client.request("server/shutdown", json!({})).await.unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(20), service.wait()).await;
}
