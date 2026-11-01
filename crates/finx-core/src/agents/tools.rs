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
    /// Everything the agent needs: the goal, the relevant context (files, decisions, constraints) and what its report should contain.
    pub(crate) task: String,
    /// Short handle for addressing the agent later: lowercase letters, digits, '-' or '_'. Generated when omitted.
    #[serde(default)]
    pub(crate) name: Option<String>,
    /// Block until the agent is done and return its report. Default false.
    #[serde(default)]
    pub(crate) wait: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct SendArgs {
    /// Name or id of one of your sub-agents.
    pub(crate) to: String,
    /// The message.
    pub(crate) message: String,
    /// Block until the agent is done and return its report. Default false.
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
        tools, except that it cannot start agents of its own. It works on one task and reports back. It does not see \
        this conversation, so put everything it needs into task.\n\n\
        Delegate only work that is self-contained and takes many steps, such as broad searches, independent changes, \
        long investigations or test runs. Do quick, blocking or tightly coupled steps yourself.\n\n\
        Several agents can run at once: call spawn_agent several times in one reply. All agents and you share one \
        workspace. Work that only reads files may overlap freely, but never let two agents, or an agent and you, \
        change the same file at the same time: give each agent its own files to change, and run tasks that must \
        change the same file one after another.\n\n\
        By default the agent runs in the background and this call returns at once. When it finishes, its report \
        comes to you as a new message, even if you have ended your turn. So to wait for background agents, end your \
        turn: each report brings you back, and you continue from there. Set wait=true only when you cannot continue \
        without the result; the call then blocks until the agent is done and returns its report. Several such calls \
        in one reply run at the same time.\n\n\
        Leave delegated work to the agent: do not redo it yourself or guess its result while it runs, and if asked \
        before its report arrives, say it is still working. Only you see the reports; the user sees just each \
        agent's status, so relay what matters.";

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
    const DESCRIPTION: &'static str = "Send a message to one of your sub-agents. The agent keeps the context of its \
        earlier work, so use this for follow-ups and corrections and to let an interrupted agent continue; \
        spawn_agent would start from scratch. A running agent reads the message at its next step; an idle agent \
        starts working on it and reports back when done. wait=true blocks until the agent is done and returns its \
        report; interrupt=true makes it stop its current work first.";

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
