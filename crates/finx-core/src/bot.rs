//! Bots (bot-design): a bot is a name, an avatar and one session. Its session has one tool
//! of its own, `send_to_user`, the only way what it writes reaches the user.

use async_trait::async_trait;
use finx_llm::Message;
use finx_tools::Environment;
use finx_tools::Tool;
use finx_tools::ToolCategory;
use finx_tools::ToolCtx;
use finx_tools::ToolDescription;
use finx_tools::ToolError;
use finx_tools::ToolOutput;
use finx_tools::Typed;
use finx_tools::TypedTool;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

use crate::history::History;
use crate::store::EntryKind;

/// The bot a session is started for: its id, and its name now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BotIdentity {
    pub id: String,
    pub name: String,
}

pub const SEND_TO_USER: &str = "send_to_user";

/// The tools a bot's session gets on top of a session's. Its sub-agents do not get them: their
/// replies are reports to the bot.
pub(crate) fn tools() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(Typed::new(SendToUser))]
}

/// Whether nothing reached the owner since their latest message: no `send_to_user` after it
/// succeeded (bot-design §3.11). The message may be an earlier task's, as when a failed task is
/// retried; a report that woke the bot after its reply leaves nobody waiting.
pub(crate) fn unanswered(history: &History) -> bool {
    for entry in history.branch_back() {
        match &entry.kind {
            EntryKind::Message {
                message: Message::ToolResult(result),
                ..
            } if result.tool_name == SEND_TO_USER && !result.is_error => return false,
            EntryKind::Message {
                message: Message::User(_), ..
            } => return true,
            _ => {}
        }
    }
    false
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct SendArgs {
    /// The message.
    text: String,
    /// True on your last message, once your work for now is done: the turn ends right after it. Leave it out for a first reply or an update while you keep working.
    #[serde(default)]
    end_turn: bool,
}

struct SendToUser;

#[async_trait]
impl TypedTool for SendToUser {
    type Args = SendArgs;
    const NAME: &'static str = SEND_TO_USER;
    const DESCRIPTION: &'static str = "Send a message to the user. It is the only way they see anything from you: each call \
        shows up as one chat bubble, all at once, rendered as Markdown.";

    fn describe(&self, args: &Value, _env: &dyn Environment) -> ToolDescription {
        let first = args
            .get("text")
            .and_then(Value::as_str)
            .and_then(|text| text.lines().map(str::trim).find(|line| !line.is_empty()));
        ToolDescription {
            category: ToolCategory::Other,
            title: match first {
                Some(line) => line.chars().take(80).collect(),
                None => SEND_TO_USER.to_string(),
            },
            locations: Vec::new(),
        }
    }

    async fn run(&self, args: SendArgs, _ctx: ToolCtx) -> Result<ToolOutput, ToolError> {
        if args.text.trim().is_empty() {
            return Err(ToolError::InvalidArgs("text must not be empty".into()));
        }
        let sent = ToolOutput::text("Sent.");
        Ok(if args.end_turn { sent.ending_task() } else { sent })
    }
}
