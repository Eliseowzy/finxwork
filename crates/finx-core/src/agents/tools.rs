//! `spawn_agent` and `send_message`: the main agent's tools for its sub-agents.

use async_trait::async_trait;
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

use super::AgentTree;

/// The tools a main session gets. Sub-agents get neither. They hold no session: a call finds
/// the calling session's sub-agents in its context, so every main session shares one pair.
pub(crate) fn agent_tools() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(Typed::new(SpawnAgent)), Arc::new(Typed::new(SendMessage))]
}

/// The sub-agents of the session that made the call.
fn tree(ctx: &ToolCtx) -> Result<Arc<AgentTree>, ToolError> {
    ctx.session_state
        .get::<AgentTree>()
        .ok_or_else(|| ToolError::Failed("this session cannot start sub-agents".into()))
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct SpawnArgs {
    /// A short label the user sees for this agent: what it works on, in the user's language, within 20 Chinese characters or 5 words.
    pub(crate) description: String,
    /// All the agent knows: the goal, what you know or ruled out, the files to read and the files it may change, and what to report.
    pub(crate) task: String,
    /// Short handle for addressing the agent later: lowercase letters, digits, '-' or '_'. Generated when omitted.
    #[serde(default)]
    pub(crate) name: Option<String>,
    /// Block until the agent is done and return its report. Only when the next step of this reply needs it. Default false.
    #[serde(default)]
    pub(crate) wait: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct SendArgs {
    /// Name or id of one of your sub-agents.
    pub(crate) to: String,
    /// The message.
    pub(crate) message: String,
    /// Block until the agent is done and return its report. Only when the next step of this reply needs it. Default false.
    #[serde(default)]
    pub(crate) wait: bool,
    /// Stop the agent's current work before delivering the message. Default false.
    #[serde(default)]
    pub(crate) interrupt: bool,
}

struct SpawnAgent;

#[async_trait]
impl TypedTool for SpawnAgent {
    type Args = SpawnArgs;
    const NAME: &'static str = "spawn_agent";
    const DESCRIPTION: &'static str = "Start a sub-agent: a separate agent with your workspace, permissions, model and \
        tools, except that it cannot start agents. It sees none of this conversation: the task you write is all it \
        knows.\n\n\
        Delegate self-contained work that takes many steps: broad searches, independent changes, long \
        investigations, test runs. Do quick, blocking or tightly coupled steps yourself.\n\n\
        Several agents can run at once: call spawn_agent several times in one reply. You all share one workspace, \
        so give each agent its own files to change, and run tasks that change the same file one after another.\n\n\
        The agent runs in the background. Its report comes to you as a new message when it finishes, even after you \
        end your turn. So to wait, end your turn: that is not your final answer. Set wait=true only when the next \
        step of this reply needs the report.\n\n\
        Leave delegated work to the agent: do not redo it or guess its result, and if asked before it reports, say \
        it is still working. Only you see the reports; the user sees each agent's status, so relay what matters.";

    fn describe(&self, args: &Value, _env: &dyn Environment) -> ToolDescription {
        let title = match args.get("name").and_then(Value::as_str) {
            Some(name) if !name.trim().is_empty() => format!("spawn agent {}", name.trim()),
            _ => "spawn agent".to_string(),
        };
        ToolDescription {
            category: ToolCategory::Other,
            title,
            locations: Vec::new(),
        }
    }

    async fn run(&self, args: SpawnArgs, ctx: ToolCtx) -> Result<ToolOutput, ToolError> {
        tree(&ctx)?.spawn(args, &ctx.call_id, &ctx.cancel).await
    }
}

struct SendMessage;

#[async_trait]
impl TypedTool for SendMessage {
    type Args = SendArgs;
    const NAME: &'static str = "send_message";
    const DESCRIPTION: &'static str = "Send a message to one of your sub-agents. It keeps the context of its earlier \
        work, so use this for follow-ups and corrections and to let an interrupted agent continue; spawn_agent would \
        start from scratch. A running agent reads the message at its next step; an idle one works on it and reports \
        back as after spawn_agent.";

    fn describe(&self, args: &Value, _env: &dyn Environment) -> ToolDescription {
        let title = match args.get("to").and_then(Value::as_str) {
            Some(to) => format!("message agent {to}"),
            None => "message agent".to_string(),
        };
        ToolDescription {
            category: ToolCategory::Other,
            title,
            locations: Vec::new(),
        }
    }

    async fn run(&self, args: SendArgs, ctx: ToolCtx) -> Result<ToolOutput, ToolError> {
        tree(&ctx)?.send(args, &ctx.cancel).await
    }
}
