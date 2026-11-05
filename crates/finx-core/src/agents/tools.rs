//! The main agent's tools for its sub-agents: `spawn_agent` and `send_message` in its tool list,
//! `check_agents` and `stop_agents` loaded on demand.

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

/// The tools a main session gets. Sub-agents get none. They hold no session: a call finds the
/// calling session's sub-agents in its context, so every main session shares one set.
pub(crate) fn agent_tools() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(Typed::new(SpawnAgent)), Arc::new(Typed::new(SendMessage))]
}

/// A bot's: the same without `wait`. Its sub-agents always work in the background, so that it
/// stays free for its owner (bot-turn-design §5.1).
pub(crate) fn bot_agent_tools() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(Typed::new(BotSpawnAgent)), Arc::new(Typed::new(BotSendMessage))]
}

/// Every main session's, loaded on demand (bot-turn-design §5.3).
pub(crate) fn deferred_agent_tools() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(Typed::new(CheckAgents)), Arc::new(Typed::new(StopAgents))]
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

/// [`SpawnArgs`] without `wait`.
#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct BotSpawnArgs {
    /// A short label the user sees for this agent: what it works on, in the user's language, within 20 Chinese characters or 5 words.
    description: String,
    /// All the agent knows: the goal, what you know or ruled out, the files to read and the files it may change, and what to report.
    task: String,
    /// Short handle for addressing the agent later: lowercase letters, digits, '-' or '_'. Generated when omitted.
    #[serde(default)]
    name: Option<String>,
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

/// [`SendArgs`] without `wait`.
#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct BotSendArgs {
    /// Name or id of one of your sub-agents.
    to: String,
    /// The message.
    message: String,
    /// Stop the agent's current work before delivering the message. Default false.
    #[serde(default)]
    interrupt: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct CheckArgs {
    /// Names or ids of the agents to look at. All of them when left out.
    #[serde(default)]
    agents: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct StopArgs {
    /// Names or ids of the agents to stop.
    #[serde(default)]
    agents: Option<Vec<String>>,
    /// Stop every running agent.
    #[serde(default)]
    all: bool,
}

/// `spawn_agent`'s description; the paragraph on waiting differs.
macro_rules! spawn_description {
    ($waiting:literal) => {
        concat!(
            "Start a sub-agent: a separate agent with your workspace, permissions, model and tools, except that it \
            cannot start agents. It sees none of this conversation: the task you write is all it knows.\n\n\
            Delegate self-contained work that takes many steps: broad searches, independent changes, long \
            investigations, test runs. Do quick, blocking or tightly coupled steps yourself.\n\n\
            Several agents can run at once: call spawn_agent several times in one reply. You all share one workspace, \
            so give each agent its own files to change, and run tasks that change the same file one after another.\n\n",
            $waiting,
            "\n\nLeave delegated work to the agent: do not redo it or guess its result; check_agents shows how it stands. \
            Only you see the reports; the user sees each agent's status, so relay what matters."
        )
    };
}

const SEND_DESCRIPTION: &str = "Send a message to one of your sub-agents. It keeps the context of its earlier \
    work, so use this for follow-ups and corrections and to let an interrupted agent continue; spawn_agent would \
    start from scratch. A running agent reads the message at its next step; an idle one works on it and reports \
    back as after spawn_agent.";

fn describe_spawn(args: &Value) -> ToolDescription {
    let title = match args.get("name").and_then(Value::as_str) {
        Some(name) if !name.trim().is_empty() => format!("spawn agent {}", name.trim()),
        _ => "spawn agent".to_string(),
    };
    other(title)
}

fn describe_send(args: &Value) -> ToolDescription {
    let title = match args.get("to").and_then(Value::as_str) {
        Some(to) => format!("message agent {to}"),
        None => "message agent".to_string(),
    };
    other(title)
}

fn other(title: String) -> ToolDescription {
    ToolDescription {
        category: ToolCategory::Other,
        title,
        locations: Vec::new(),
    }
}

struct SpawnAgent;

#[async_trait]
impl TypedTool for SpawnAgent {
    type Args = SpawnArgs;
    const NAME: &'static str = "spawn_agent";
    const DESCRIPTION: &'static str = spawn_description!(
        "The agent runs in the background. Its report comes to you as a new message when it finishes, even after you \
        end your turn. So to wait, end your turn: that is not your final answer. Set wait=true only when the next \
        step of this reply needs the report."
    );

    fn describe(&self, args: &Value, _env: &dyn Environment) -> ToolDescription {
        describe_spawn(args)
    }

    async fn run(&self, args: SpawnArgs, ctx: ToolCtx) -> Result<ToolOutput, ToolError> {
        tree(&ctx)?.spawn(args, &ctx.call_id, &ctx.cancel).await
    }
}

struct BotSpawnAgent;

#[async_trait]
impl TypedTool for BotSpawnAgent {
    type Args = BotSpawnArgs;
    const NAME: &'static str = "spawn_agent";
    const DESCRIPTION: &'static str = spawn_description!(
        "The agent runs in the background. Its report comes to you as a new message when it finishes, even after you \
        end your turn. So end your turn rather than wait for it: that is not your final answer."
    );

    fn describe(&self, args: &Value, _env: &dyn Environment) -> ToolDescription {
        describe_spawn(args)
    }

    async fn run(&self, args: BotSpawnArgs, ctx: ToolCtx) -> Result<ToolOutput, ToolError> {
        let args = SpawnArgs {
            description: args.description,
            task: args.task,
            name: args.name,
            wait: false,
        };
        tree(&ctx)?.spawn(args, &ctx.call_id, &ctx.cancel).await
    }
}

struct SendMessage;

#[async_trait]
impl TypedTool for SendMessage {
    type Args = SendArgs;
    const NAME: &'static str = "send_message";
    const DESCRIPTION: &'static str = SEND_DESCRIPTION;

    fn describe(&self, args: &Value, _env: &dyn Environment) -> ToolDescription {
        describe_send(args)
    }

    async fn run(&self, args: SendArgs, ctx: ToolCtx) -> Result<ToolOutput, ToolError> {
        tree(&ctx)?.send(args, &ctx.cancel).await
    }
}

struct BotSendMessage;

#[async_trait]
impl TypedTool for BotSendMessage {
    type Args = BotSendArgs;
    const NAME: &'static str = "send_message";
    const DESCRIPTION: &'static str = SEND_DESCRIPTION;

    fn describe(&self, args: &Value, _env: &dyn Environment) -> ToolDescription {
        describe_send(args)
    }

    async fn run(&self, args: BotSendArgs, ctx: ToolCtx) -> Result<ToolOutput, ToolError> {
        let args = SendArgs {
            to: args.to,
            message: args.message,
            wait: false,
            interrupt: args.interrupt,
        };
        tree(&ctx)?.send(args, &ctx.cancel).await
    }
}

struct CheckAgents;

#[async_trait]
impl TypedTool for CheckAgents {
    type Args = CheckArgs;
    const NAME: &'static str = "check_agents";
    const DESCRIPTION: &'static str = "See how your agents stand: each one's label, status, how long it has run, its \
        recent steps and how long ago it last did anything. Name agents, or leave it out for all. For diagnosing, not \
        for waiting: a report comes to you when an agent is done.";

    fn describe(&self, _args: &Value, _env: &dyn Environment) -> ToolDescription {
        other("check agents".to_string())
    }

    async fn run(&self, args: CheckArgs, ctx: ToolCtx) -> Result<ToolOutput, ToolError> {
        Ok(ToolOutput::text(tree(&ctx)?.check(args.agents.as_deref())))
    }
}

struct StopAgents;

#[async_trait]
impl TypedTool for StopAgents {
    type Args = StopArgs;
    const NAME: &'static str = "stop_agents";
    const DESCRIPTION: &'static str = "Stop running agents at once: name them, or set all to true. A stopped agent keeps \
        its context, and send_message lets it continue later. The result lists what stopped and what had already \
        finished.";

    fn describe(&self, args: &Value, _env: &dyn Environment) -> ToolDescription {
        other(if args.get("all").and_then(Value::as_bool).unwrap_or(false) {
            "stop all agents".to_string()
        } else {
            "stop agents".to_string()
        })
    }

    async fn run(&self, args: StopArgs, ctx: ToolCtx) -> Result<ToolOutput, ToolError> {
        let names = match (args.all, args.agents.as_deref()) {
            (true, _) => None,
            (false, Some(names)) if !names.is_empty() => Some(names),
            // Stopping everything takes saying so.
            _ => return Err(ToolError::InvalidArgs("name the agents to stop, or set all to true".into())),
        };
        tree(&ctx)?.stop(names, &ctx.cancel).await.map(ToolOutput::text)
    }
}
