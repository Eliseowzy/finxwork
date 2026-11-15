//! A group seat's hard file boundary (bot-group-chat-dev-brief §4.3): every tool that names a
//! path may only touch the group's own folder, whatever the turn and whoever started it.

use async_trait::async_trait;
use finx_llm::ToolCall;
use finx_tools::Authority;
use finx_tools::Tool;
use serde_json::Value;

use crate::bot;
use crate::hooks::Gate;
use crate::hooks::Hooks;
use crate::hooks::SessionView;
use crate::protected::canonical_lossy;

pub(crate) struct GroupGuard;

#[async_trait]
impl Hooks for GroupGuard {
    async fn before_tool(&self, call: &ToolCall, tool: &dyn Tool, _authorities: &[Authority], view: &SessionView) -> Gate {
        if view.group.is_none() {
            return Gate::Allow;
        }
        // Speaking and saying nothing has no path of its own; an attachment is checked by
        // `send_to_user` itself.
        if call.name == bot::SEND_TO_USER || call.name == bot::STAY_SILENT {
            return Gate::Allow;
        }
        // These cannot be confined to a folder, so a seat does not get them (the kernel also
        // leaves them out; this keeps a tool added later from slipping through).
        if call.name == "bash" || call.name.starts_with("cua_") {
            return Gate::Deny("a group's bot cannot use the shell or computer use".into());
        }
        let args = call.arguments.to_value();
        if call.name == "browser_navigate"
            && let Some(url) = args.get("url").and_then(Value::as_str)
            && url.starts_with("file:")
        {
            return Gate::Deny("a group's bot cannot open a local file in the browser".into());
        }
        let root = canonical_lossy(view.env.cwd());
        for (path, _) in tool.describe(&args, view.env.as_ref()).locations {
            let target = canonical_lossy(&path);
            if !target.starts_with(&root) {
                return Gate::Deny(format!(
                    "{}: a group's bot may only use files in the group's folder",
                    path.display()
                ));
            }
        }
        Gate::Allow
    }
}
