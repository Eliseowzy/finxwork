//! The machine-readable description of the native protocol: a JSON Schema (draft 7) whose
//! `definitions` cover every type, plus which method takes and returns which type, the
//! notifications and the error codes. `finx protocol schema` prints it; clients generate
//! their types from it (for example TypeScript with json-schema-to-typescript).

use schemars::JsonSchema;
use schemars::r#gen::SchemaGenerator;
use schemars::r#gen::SchemaSettings;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::PROTOCOL_VERSION;
use crate::api;
use crate::api::error_code;
use crate::api::method;
use crate::customize;
use crate::event::Event;
use crate::op::Op;

/// Registers `T` and returns its definition name.
fn name<T: JsonSchema>(generator: &mut SchemaGenerator) -> String {
    generator.subschema_for::<T>();
    T::schema_name()
}

/// The schema document. Object keys are sorted, so the output is stable.
pub fn document() -> Value {
    let mut generator = SchemaSettings::draft07().into_generator();
    let g = &mut generator;
    let methods: Vec<(&str, Option<String>, String)> = vec![
        (
            method::INITIALIZE,
            Some(name::<api::InitializeParams>(g)),
            name::<api::InitializeResult>(g),
        ),
        (
            method::SESSION_NEW,
            Some(name::<api::SessionNewParams>(g)),
            name::<api::SessionNewResult>(g),
        ),
        (
            method::SESSION_RESUME,
            Some(name::<api::SessionResumeParams>(g)),
            name::<api::SnapshotResult>(g),
        ),
        (
            method::SESSION_ATTACH,
            Some(name::<api::SessionAttachParams>(g)),
            name::<api::SnapshotResult>(g),
        ),
        (
            method::SESSION_DETACH,
            Some(name::<api::SessionIdParams>(g)),
            name::<api::Empty>(g),
        ),
        (
            method::SESSION_OP,
            Some(name::<api::SessionOpParams>(g)),
            name::<api::Empty>(g),
        ),
        (
            method::SESSION_HISTORY,
            Some(name::<api::SessionHistoryParams>(g)),
            name::<api::TranscriptPage>(g),
        ),
        (
            method::SESSION_CONTEXT,
            Some(name::<api::SessionIdParams>(g)),
            name::<crate::ContextReport>(g),
        ),
        (
            method::SESSION_LIST,
            Some(name::<api::SessionListParams>(g)),
            name::<api::SessionListResult>(g),
        ),
        (
            method::SESSION_CLOSE,
            Some(name::<api::SessionIdParams>(g)),
            name::<api::Empty>(g),
        ),
        (
            method::SESSION_DELETE,
            Some(name::<api::SessionIdParams>(g)),
            name::<api::Empty>(g),
        ),
        (
            method::RESOURCE_READ,
            Some(name::<api::ResourceReadParams>(g)),
            name::<api::ResourceReadResult>(g),
        ),
        (method::MODELS_LIST, None, name::<api::ModelsListResult>(g)),
        (method::SERVER_SHUTDOWN, None, name::<api::Empty>(g)),
        (
            method::SESSIONS_SUBSCRIBE,
            Some(name::<api::SessionListParams>(g)),
            name::<api::SessionListResult>(g),
        ),
        (method::SESSIONS_UNSUBSCRIBE, None, name::<api::Empty>(g)),
        (
            method::SESSION_RENAME,
            Some(name::<api::SessionRenameParams>(g)),
            name::<api::Empty>(g),
        ),
        (
            method::SESSION_ARCHIVE,
            Some(name::<api::SessionIdParams>(g)),
            name::<api::Empty>(g),
        ),
        (
            method::SESSION_UNARCHIVE,
            Some(name::<api::SessionIdParams>(g)),
            name::<api::Empty>(g),
        ),
        (
            method::AUTH_SET,
            Some(name::<api::AuthSetParams>(g)),
            name::<api::AuthSetResult>(g),
        ),
        (
            method::MODELS_REFRESH,
            Some(name::<api::ModelsRefreshParams>(g)),
            name::<api::ModelsRefreshResult>(g),
        ),
        (
            method::MODELS_SHOW,
            Some(name::<api::ModelsShowParams>(g)),
            name::<api::Empty>(g),
        ),
        (
            method::AUTH_DELETE,
            Some(name::<api::AuthDeleteParams>(g)),
            name::<api::Empty>(g),
        ),
        (method::CHATGPT_LOGIN, None, name::<api::ChatGptStatus>(g)),
        (method::CHATGPT_STATUS, None, name::<api::ChatGptStatus>(g)),
        (method::CHATGPT_CANCEL, Some(name::<api::ChatGptCancelParams>(g)), name::<api::ChatGptStatus>(g)),
        (method::CHATGPT_LOGOUT, None, name::<api::ChatGptStatus>(g)),
        (method::CONNECTIONS_LIST, None, name::<api::ConnectionsSnapshot>(g)),
        (method::CONNECTIONS_DISCOVER, None, name::<api::ConnectionsDiscoveryResult>(g)),
        (method::CONNECTIONS_CONNECT, Some(name::<api::ConnectionConnectParams>(g)), name::<api::ConnectionsSnapshot>(g)),
        (method::CONNECTIONS_RETRY, Some(name::<api::ConnectionIdParams>(g)), name::<api::ConnectionsSnapshot>(g)),
        (method::CONNECTIONS_DISCONNECT, Some(name::<api::ConnectionIdParams>(g)), name::<api::ConnectionsSnapshot>(g)),
        (method::CONNECTIONS_REMOVE, Some(name::<api::ConnectionIdParams>(g)), name::<api::ConnectionsSnapshot>(g)),
        (method::CONNECTIONS_MODELS, Some(name::<api::ConnectionIdParams>(g)), name::<api::ConnectionsSnapshot>(g)),
        (method::SKILLS_LIST, Some(name::<api::SkillsListParams>(g)), name::<api::SkillsListResult>(g)),
        (method::CONFIG_READ, Some(name::<customize::ConfigReadParams>(g)), name::<customize::ConfigReadResult>(g)),
        (method::CONFIG_WRITE, Some(name::<customize::ConfigWriteParams>(g)), name::<customize::ConfigWriteResult>(g)),
        (method::CREDENTIALS_SET, Some(name::<customize::CredentialsSetParams>(g)), name::<api::Empty>(g)),
        (method::CREDENTIALS_DELETE, Some(name::<customize::CredentialsDeleteParams>(g)), name::<api::Empty>(g)),
        (method::SKILLS_FILES, Some(name::<customize::SkillsFilesParams>(g)), name::<customize::SkillsFilesResult>(g)),
        (method::SKILLS_READ, Some(name::<customize::SkillsReadParams>(g)), name::<customize::SkillsReadResult>(g)),
        (method::SKILLS_INSTALL, Some(name::<customize::SkillsInstallParams>(g)), name::<customize::SkillsInstallResult>(g)),
        (method::SKILLS_REMOVE, Some(name::<customize::SkillsRemoveParams>(g)), name::<api::Empty>(g)),
        (method::SKILLS_SET_ENABLED, Some(name::<customize::SkillsSetEnabledParams>(g)), name::<customize::SkillsSetEnabledResult>(g)),
        (method::MCP_LIST, Some(name::<customize::McpListParams>(g)), name::<customize::McpListResult>(g)),
        (method::MCP_TOOLS, Some(name::<customize::McpServerParams>(g)), name::<customize::McpToolsResult>(g)),
        (method::MCP_CHECK, Some(name::<customize::McpServerParams>(g)), name::<customize::McpCheckResult>(g)),
        (method::MCP_PROBE, Some(name::<customize::McpProbeParams>(g)), name::<customize::McpProbeResult>(g)),
        (method::MCP_PROBE_CANCEL, Some(name::<customize::McpProbeCancelParams>(g)), name::<api::Empty>(g)),
        (method::MCP_LOGIN, Some(name::<customize::McpLoginParams>(g)), name::<customize::McpLoginResult>(g)),
        (method::MCP_LOGOUT, Some(name::<customize::McpLogoutParams>(g)), name::<api::Empty>(g)),
        (method::BROWSER_HOST, Some(name::<api::BrowserHostParams>(g)), name::<api::BrowserHostResult>(g)),
        (method::BROWSER_STATUS, None, name::<api::BrowserStatus>(g)),
        (method::BROWSER_SITE_ICON, Some(name::<api::BrowserSiteIconParams>(g)), name::<api::BrowserSiteIconResult>(g)),
    ];
    let client_notifications = [
        (method::CANCEL_REQUEST, name::<api::CancelRequestParams>(g)),
        (method::BROWSER_CDP, name::<api::BrowserCdpParams>(g)),
    ];
    let server_notifications = [
        (method::MODELS_CHANGED, name::<api::Empty>(g)),
        (method::BROWSER_CHANGED, name::<api::BrowserStatus>(g)),
        (method::CONFIG_CHANGED, name::<customize::ConfigChangedParams>(g)),
        (method::SKILLS_CHANGED, name::<customize::SkillsChangedParams>(g)),
        (method::MCP_CHANGED, name::<customize::McpChangedParams>(g)),
        (method::MCP_PROBE_PROGRESS, name::<customize::McpProbeProgressParams>(g)),
        (method::SESSION_EVENT, name::<api::SessionEventParams>(g)),
        (method::BROWSER_CDP, name::<api::BrowserCdpParams>(g)),
        (
            method::SESSION_DETACHED,
            name::<api::SessionDetachedParams>(g),
        ),
        (
            method::SESSIONS_CHANGED,
            name::<api::SessionsChangedParams>(g),
        ),
    ];
    // Also used on their own: `finx exec --json` lines and `--ops-stdin` lines.
    let standalone = [name::<Event>(g), name::<Op>(g)];

    let reference = |name: &str| json!({ "$ref": format!("#/definitions/{name}") });
    let mut methods_doc = Map::new();
    let mut roots = Vec::new();
    for (method, params, result) in &methods {
        let mut entry = Map::new();
        if let Some(params) = params {
            entry.insert("params".into(), json!(params));
            roots.push(params.clone());
        }
        entry.insert("result".into(), json!(result));
        roots.push(result.clone());
        methods_doc.insert(method.to_string(), Value::Object(entry));
    }
    let notifications = |list: &[(&str, String)]| -> Value {
        Value::Object(
            list.iter()
                .map(|(m, n)| (m.to_string(), json!(n)))
                .collect(),
        )
    };
    roots.extend(client_notifications.iter().map(|(_, n)| n.clone()));
    roots.extend(server_notifications.iter().map(|(_, n)| n.clone()));
    roots.extend(standalone.iter().cloned());
    roots.sort();
    roots.dedup();
    let errors: Map<String, Value> = error_code::ALL
        .iter()
        .map(|(code, kind)| (code.to_string(), json!(kind)))
        .collect();
    let definitions = serde_json::to_value(generator.take_definitions()).unwrap_or_default();
    sorted(json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "finx native protocol",
        "description": "JSON-RPC 2.0 over newline-delimited JSON. Every message type is under `definitions`; the root accepts any top-level payload. `x-methods` maps each request to its params and result types, `x-client-notifications` and `x-server-notifications` map notifications to their params, and `x-error-codes` maps error codes to the `kind` in the error data.",
        "x-protocol-version": PROTOCOL_VERSION,
        "x-methods": methods_doc,
        "x-client-notifications": notifications(&client_notifications),
        "x-server-notifications": notifications(&server_notifications),
        "x-error-codes": errors,
        "anyOf": roots.iter().map(|n| reference(n)).collect::<Vec<_>>(),
        "definitions": definitions,
    }))
}

/// The value with object keys in sorted order, whatever order serde_json keeps maps in.
fn sorted(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map.into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Object(entries.into_iter().map(|(k, v)| (k, sorted(v))).collect())
        }
        Value::Array(items) => Value::Array(items.into_iter().map(sorted).collect()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn every_method_and_event_is_described() {
        let doc = document();
        let defs = doc["definitions"].as_object().unwrap();
        for (_, entry) in doc["x-methods"].as_object().unwrap() {
            for key in ["params", "result"] {
                if let Some(name) = entry.get(key).and_then(Value::as_str) {
                    assert!(defs.contains_key(name), "missing definition {name}");
                }
            }
        }
        // The event kinds are inlined into `Event`, next to `seq` and `ts`.
        let event = &defs["Event"];
        let kinds: Vec<&str> = event["oneOf"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v["properties"]["type"]["enum"][0].as_str())
            .collect();
        for kind in [
            "session_started",
            "tool_started",
            "tool_running",
            "task_completed",
            "session_closed",
        ] {
            assert!(kinds.contains(&kind), "Event lacks {kind}: {kinds:?}");
        }
        assert!(event["properties"].get("seq").is_some());
        assert_eq!(doc["x-error-codes"]["-32015"], "approval_not_pending");
    }

    /// The committed copy (`crates/finx-protocol/schema.json`) must match the types. Run with
    /// FINX_UPDATE_SNAPSHOTS=1 to rewrite it after a deliberate protocol change.
    #[test]
    fn committed_schema_matches_the_types() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("schema.json");
        let doc = document();
        if std::env::var_os("FINX_UPDATE_SNAPSHOTS").is_some() {
            std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
            return;
        }
        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_default())
                .expect("schema.json exists; create it with FINX_UPDATE_SNAPSHOTS=1");
        assert!(
            saved == doc,
            "schema.json is out of date; rerun with FINX_UPDATE_SNAPSHOTS=1 and review the diff"
        );
    }
}
