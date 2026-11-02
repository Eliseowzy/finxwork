//! End-to-end: `browser/site_icon` (browser-design §10.1), the icons of Settings › Browser's
//! sites. One kept in `~/.finx/browser/icons` is given without asking the site; a page with no
//! site (http, here) has none, and nothing is written for it.

mod common;

use common::SchemaCheck;
use common::TestEnv;
use serde_json::json;

const PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
    0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x00, 0x02, 0x00, 0x00, 0x05, 0x00, 0x01, 0xe9, 0xfa, 0xdc, 0xd8, 0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_kept_icon_is_given_and_a_page_without_a_site_has_none() {
    let env = TestEnv::new("manual", "").await;
    let schema = SchemaCheck::new(&["BrowserSiteIconResult"]);
    let dir = env.home.path().join("browser/icons");
    // As a first visit to the page left it: `example.test` cannot be reached, so the icon
    // can only come from here.
    let icon = finx_mcp::icon::Icon { bytes: PNG.to_vec(), mime: "image/png", source: "https://example.test/favicon.png".into(), declared: false };
    finx_mcp::icon::store(&dir, "https://example.test", Some(&icon)).unwrap();

    let (mut child, client, _rx) = env.spawn_rpc(&["serve", "--stdio"]);
    client.request("initialize", json!({"protocol_version": 2, "client_info": {"name": "e2e"}})).await.unwrap();

    let kept = client.request("browser/site_icon", json!({"origin": "https://example.test"})).await.unwrap();
    schema.check("BrowserSiteIconResult", &kept);
    assert_eq!(kept["icon"], json!(icon.data_uri()));

    let local = client.request("browser/site_icon", json!({"origin": "http://localhost:3000"})).await.unwrap();
    assert!(local.get("icon").is_none(), "{local}");
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "something was written for a local page");

    drop(client);
    let _ = child.kill().await;
}
