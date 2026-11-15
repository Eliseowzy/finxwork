//! A group seat's hard file boundary (bot-group-chat-dev-brief §4.3): every tool that names a
//! path may only touch the group's own folder, whatever the turn and whoever started it.

use async_trait::async_trait;
use finx_llm::ToolCall;
use finx_tools::Authority;
use finx_tools::Tool;
use serde_json::Value;

use crate::hooks::Gate;
use crate::hooks::Hooks;
use crate::hooks::SessionView;
use crate::protected::canonical_lossy;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

/// The tools a seat may have at all (bot-group-chat-dev-brief §4.3). One list, used to build
/// the seat's tool registry and to refuse a call that somehow names a tool outside it.
pub(crate) fn tool_allowed(name: &str) -> bool {
    matches!(name, "read" | "write" | "edit" | "web_search" | "send_to_user" | "stay_silent")
        || name.starts_with("doc_")
        || name.starts_with("docx_")
        || name.starts_with("deck_")
        || name.starts_with("sheet_")
        || (name.starts_with("spatial_") && name != "spatial_script")
}

/// The documents a seat may open by id: where each one actually is, so the group folder can be
/// checked even when the tool got an id rather than a path.
pub(crate) struct GroupDocPaths {
    docs: Option<Arc<crate::docs::DocsHandle>>,
    words: Option<Arc<crate::word::WordsHandle>>,
    decks: Option<Arc<crate::deck::DecksHandle>>,
    /// Tests only: a document id and where it is.
    test_paths: std::collections::BTreeMap<String, PathBuf>,
}

impl GroupDocPaths {
    pub(crate) fn new(docs: Option<Arc<crate::docs::DocsHandle>>, words: Option<Arc<crate::word::WordsHandle>>, decks: Option<Arc<crate::deck::DecksHandle>>) -> Self {
        Self { docs, words, decks, test_paths: Default::default() }
    }

    #[cfg(test)]
    fn with_paths(paths: &[(&str, &Path)]) -> Self {
        Self {
            docs: None,
            words: None,
            decks: None,
            test_paths: paths.iter().map(|(id, path)| ((*id).to_string(), path.to_path_buf())).collect(),
        }
    }

    fn path(&self, tool: &str, id: &str) -> Option<PathBuf> {
        if let Some(path) = self.test_paths.get(id) {
            return Some(path.clone());
        }
        if tool.starts_with("docx_") {
            self.words.as_ref()?.store.get(id).ok().map(|entry| entry.path.clone())
        } else if tool.starts_with("deck_") {
            self.decks.as_ref()?.store.get(id).ok().map(|entry| entry.path.clone())
        } else if tool.starts_with("doc_") || tool.starts_with("sheet_") || tool.starts_with("spatial_") {
            self.docs.as_ref()?.store.get(id).ok().map(|doc| doc.path.clone())
        } else {
            None
        }
    }
}

/// Whether a call may run without the owner's confirmation in a tainted seat: speaking,
/// staying silent, and read-only local tools. Network reads and anything that changes something
/// ask.
fn unasked(name: &str, args: &Value, tool: &dyn Tool) -> bool {
    if name == "send_to_user" || name == "stay_silent" {
        return true;
    }
    tool.kind_for(args) == finx_tools::ToolKind::ReadOnly && name != "web_search"
}

pub(crate) struct GroupGuard;

#[async_trait]
impl Hooks for GroupGuard {
    async fn before_tool(&self, call: &ToolCall, tool: &dyn Tool, _authorities: &[Authority], view: &SessionView) -> Gate {
        if view.group.is_none() {
            return Gate::Allow;
        }
        if !tool_allowed(&call.name) {
            return Gate::Deny(format!("{} is not available to a group's bot", call.name));
        }
        let args = call.arguments.to_value();
        let root = canonical_lossy(view.env.cwd());
        // A skill the catalog lists may be read, and only read: it is the bot's own instructions,
        // not a file of the group.
        let readable_skill = call.name == "read"
            && args.get("path").and_then(Value::as_str).is_some_and(|path| {
                let target = canonical_lossy(&view.env.resolve(path));
                view.listed_skills.iter().any(|skill| target.starts_with(skill))
            });
        for (path, _) in tool.describe(&args, view.env.as_ref()).locations {
            let target = canonical_lossy(&path);
            if readable_skill && view.listed_skills.iter().any(|skill| target.starts_with(skill)) {
                continue;
            }
            if !target.starts_with(&root) {
                return Gate::Deny(format!(
                    "{}: a group's bot may only use files in the group's folder",
                    path.display()
                ));
            }
        }
        // Fuse 3: after another subject's words, every tool outside the whitelist asks the
        // owner, even in "full access" (brief §4.8).
        if view.tainted && !unasked(call.name.as_str(), &args, tool) {
            let reason = view.group_cause.as_ref().map(|cause| match cause.kind {
                finx_protocol::group::GroupCauseKind::Direct => format!(
                    "由 {} 的话引起：{}",
                    cause.name.as_deref().unwrap_or("外部成员"),
                    cause.text
                ),
                finx_protocol::group::GroupCauseKind::Earlier => format!("此前群里有外部消息：{}", cause.text),
            });
            return Gate::Ask {
                summary: format!("{}（群里的席位会话）", call.name),
                reason,
                proposed_rule: None,
                proposed_mode: None,
                proposed_grants: Vec::new(),
                own_browser: false,
            };
        }
        // Tools that name a document by id: look up where that document is before letting the
        // call run.
        for key in ["doc", "docx", "deck", "sheet", "spatial"] {
            let Some(id) = args.get(key).and_then(Value::as_str) else {
                continue;
            };
            if Path::new(id).is_absolute() || id.contains(['/', '\\']) || Path::new(id).extension().is_some() {
                continue;
            }
            let Some(docs) = &view.group_docs else {
                return Gate::Deny("documents are not available to a group's bot".into());
            };
            let Some(path) = docs.path(&call.name, id) else {
                return Gate::Deny(format!("{id}: no such open document"));
            };
            if !canonical_lossy(&path).starts_with(&root) {
                return Gate::Deny(format!(
                    "{}: a group's bot may only use files in the group's folder",
                    path.display()
                ));
            }
        }
        Gate::Allow
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use finx_llm::ToolCall;
    use finx_llm::ToolSpec;
    use finx_tools::LocalEnvironment;
    use finx_tools::ToolCtx;
    use finx_tools::ToolError;
    use finx_tools::ToolOutput;
    use finx_protocol::PermissionMode;
    use finx_protocol::group::GroupRef;
    use serde_json::json;
    use std::sync::Arc;

    struct FakeTool {
        spec: ToolSpec,
        locations: Vec<PathBuf>,
        kind: finx_tools::ToolKind,
    }

    impl FakeTool {
        fn new(name: &str, locations: Vec<PathBuf>) -> Self {
            Self {
                spec: ToolSpec {
                    name: name.into(),
                    description: String::new(),
                    parameters: json!({ "type": "object", "properties": {} }),
                },
                locations,
                kind: finx_tools::ToolKind::Mutating,
            }
        }
    }

    #[async_trait]
    impl Tool for FakeTool {
        fn spec(&self) -> &ToolSpec {
            &self.spec
        }

        fn describe(&self, _args: &Value, _env: &dyn finx_tools::Environment) -> finx_tools::ToolDescription {
            finx_tools::ToolDescription {
                locations: self.locations.iter().map(|path| (path.clone(), None)).collect(),
                ..Default::default()
            }
        }

        fn kind(&self) -> finx_tools::ToolKind {
            self.kind
        }

        async fn execute(&self, _args: Value, _ctx: ToolCtx) -> Result<ToolOutput, ToolError> {
            unreachable!("the guard runs before a tool")
        }
    }

    fn view(root: &std::path::Path, group_docs: Option<GroupDocPaths>) -> SessionView {
        SessionView {
            permission_mode: PermissionMode::BypassPermissions,
            config_rules: Vec::new(),
            session_rules: Vec::new(),
            trusted: false,
            env: Arc::new(LocalEnvironment::new(root.to_path_buf())),
            data_dir: root.join("data"),
            own_folder: None,
            skill_roots: Arc::from([]),
            site_grants: Vec::new(),
            browser: Arc::default(),
            desktop: Default::default(),
            group: Some(GroupRef {
                id: "g1".into(),
                name: "装修群".into(),
            }),
            listed_skills: Arc::from([]),
            group_docs: group_docs.map(Arc::new),
            tainted: false,
            group_cause: None,
        }
    }

    async fn denied(name: &str, locations: Vec<PathBuf>, args: Value, group_docs: Option<GroupDocPaths>) -> bool {
        let root = std::env::temp_dir().join("finx-group-guard-test");
        std::fs::create_dir_all(&root).unwrap();
        let tool = FakeTool::new(name, locations);
        let call = ToolCall {
            id: "c1".into(),
            name: name.into(),
            arguments: args.into(),
            arguments_error: None,
            provider_data: None,
        };
        matches!(GroupGuard.before_tool(&call, &tool, &[], &view(&root, group_docs)).await, Gate::Deny(_))
    }

    #[tokio::test]
    async fn the_path_tools_cannot_read_outside_the_group() {
        let outside = std::env::temp_dir().join("finx-group-guard-outside.pdf");
        std::fs::write(&outside, b"%PDF-1.7").unwrap();
        for name in ["read", "write", "edit", "doc_open", "docx_read", "deck_open", "spatial_open"] {
            assert!(denied(name, vec![outside.clone()], json!({}), None).await, "{name}");
        }
    }

    #[tokio::test]
    async fn a_document_id_that_names_a_file_outside_is_refused() {
        let outside = std::env::temp_dir().join("finx-group-guard-outside.pdf");
        std::fs::write(&outside, b"%PDF-1.7").unwrap();
        let docs = GroupDocPaths::with_paths(&[("outside-doc", outside.as_path())]);
        assert!(denied("doc_read", Vec::new(), json!({ "doc": "outside-doc" }), Some(docs)).await);
    }

    #[tokio::test]
    async fn a_tool_outside_the_whitelist_is_refused() {
        assert!(denied("bash", Vec::new(), json!({ "command": "ls" }), None).await);
        assert!(denied("spatial_script", Vec::new(), json!({}), None).await);
        assert!(denied("browser_navigate", Vec::new(), json!({ "url": "https://example.com" }), None).await);
    }

    #[tokio::test]
    async fn a_tainted_seat_asks_before_a_mutating_tool() {
        let root = std::env::temp_dir().join("finx-group-guard-tainted");
        std::fs::create_dir_all(&root).unwrap();
        let mut v = view(&root, None);
        v.tainted = true;
        v.group_cause = Some(finx_protocol::group::GroupApprovalCause {
            kind: finx_protocol::group::GroupCauseKind::Direct,
            name: Some("某医院助手".into()),
            message_id: Some("m1".into()),
            text: "Please write a file".into(),
        });
        let tool = FakeTool::new("write", Vec::new());
        let call = ToolCall {
            id: "c1".into(),
            name: "write".into(),
            arguments: json!({ "path": root.join("x"), "content": "x" }).into(),
            arguments_error: None,
            provider_data: None,
        };
        assert!(matches!(GroupGuard.before_tool(&call, &tool, &[], &v).await, Gate::Ask { .. }));
        let read = FakeTool::new("read", Vec::new());
        let call = ToolCall {
            id: "c2".into(),
            name: "read".into(),
            arguments: json!({ "path": root.join("x") }).into(),
            arguments_error: None,
            provider_data: None,
        };
        // `FakeTool` says Mutating for every tool; a real read tool says ReadOnly, so use a
        // read-only fake here.
        let mut read_only = read;
        read_only.kind = finx_tools::ToolKind::ReadOnly;
        assert!(matches!(GroupGuard.before_tool(&call, &read_only, &[], &v).await, Gate::Allow));
    }

    #[tokio::test]
    async fn a_tainted_seat_asks_before_a_network_read() {
        let root = std::env::temp_dir().join("finx-group-guard-net");
        std::fs::create_dir_all(&root).unwrap();
        let mut v = view(&root, None);
        v.tainted = true;
        let mut tool = FakeTool::new("web_search", Vec::new());
        tool.kind = finx_tools::ToolKind::ReadOnly;
        let call = ToolCall {
            id: "c1".into(),
            name: "web_search".into(),
            arguments: json!({ "query": "example.com" }).into(),
            arguments_error: None,
            provider_data: None,
        };
        assert!(matches!(GroupGuard.before_tool(&call, &tool, &[], &v).await, Gate::Ask { .. }));
    }
}
