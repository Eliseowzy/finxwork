//! The tool contract. Tools only declare what they are; approval, concurrency, truncation and
//! recording are the kernel's job.

use async_trait::async_trait;
use finx_llm::ToolSpec;
use finx_llm::UserContent;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::any::Any;
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

use crate::env::Environment;
use crate::files::FileTracker;
use crate::files::PathLocks;
use crate::truncate::OutputLimits;

#[async_trait]
pub trait Tool: Send + Sync + 'static {
    /// Name, description and JSON Schema of the parameters.
    fn spec(&self) -> &ToolSpec;

    /// Read-only tools may run in parallel and skip approval by default; mutating tools run
    /// exclusively and go through the approval policy.
    fn kind(&self) -> ToolKind {
        ToolKind::ReadOnly
    }

    /// The kind of one call. Differs from [`Tool::kind`] only for tools that run another
    /// tool named in their arguments.
    fn kind_for(&self, args: &Value) -> ToolKind {
        let _ = args;
        self.kind()
    }

    /// Where the tool comes from. The kernel can judge what built-in tools do; it cannot for
    /// tools from outside, such as MCP servers.
    fn origin(&self) -> ToolOrigin {
        ToolOrigin::Builtin
    }

    /// Lines added to the "tool guidelines" part of the system prompt.
    fn guidelines(&self) -> &[&'static str] {
        &[]
    }

    /// What a call does, for user interfaces. `args` may be invalid; describe what you can.
    fn describe(&self, args: &Value, env: &dyn Environment) -> ToolDescription {
        let _ = (args, env);
        ToolDescription::named(&self.spec().name)
    }

    /// Repairs well-known mistakes in the arguments, such as a list sent as a JSON string. The
    /// kernel calls it first; hooks, approval, events and `execute` see the result.
    fn prepare_arguments(&self, args: Value) -> Value {
        args
    }

    /// Checks a call before the user is asked to approve it, so nobody approves a call that
    /// cannot succeed. Must not change anything.
    async fn check(&self, args: &Value, ctx: &ToolCtx) -> Result<(), ToolError> {
        let _ = (args, ctx);
        Ok(())
    }

    async fn execute(&self, args: Value, ctx: ToolCtx) -> Result<ToolOutput, ToolError>;
}

/// Display category of a call; independent of [`ToolKind`], which only drives locking.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ToolCategory {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Fetch,
    #[default]
    Other,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ToolDescription {
    pub category: ToolCategory,
    /// One line, e.g. the command or `read <path>`.
    pub title: String,
    /// Absolute paths the call reads or changes, with an optional 1-based line.
    pub locations: Vec<(PathBuf, Option<u32>)>,
}

impl ToolDescription {
    pub fn named(name: &str) -> Self {
        Self {
            title: name.to_string(),
            ..Self::default()
        }
    }

    /// `<verb> <path>` for a call whose `path` argument names one file.
    pub fn for_path(category: ToolCategory, verb: &str, args: &Value, env: &dyn Environment, line: Option<u32>) -> Self {
        match args.get("path").and_then(Value::as_str) {
            Some(raw) => Self {
                category,
                title: format!("{verb} {raw}"),
                locations: vec![(env.resolve(raw), line)],
            },
            None => Self {
                category,
                ..Self::named(verb)
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ToolOrigin {
    /// Part of finx, including kernel tools such as the agent tools.
    #[default]
    Builtin,
    /// Provided by an MCP server, or a kernel tool that runs MCP tools.
    Mcp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    ReadOnly,
    Mutating,
}

#[derive(Clone)]
pub struct ToolCtx {
    pub call_id: String,
    pub env: Arc<dyn Environment>,
    pub files: Arc<FileTracker>,
    /// Serializes changes to the same file across the sessions that share a workspace.
    pub locks: Arc<PathLocks>,
    pub limits: OutputLimits,
    pub progress: ProgressSink,
    pub cancel: CancellationToken,
    /// Whether the current model accepts image input.
    pub model_accepts_images: bool,
    /// Where the full output of a cut result is saved: the session's `tool-output` directory.
    pub output_dir: PathBuf,
    /// What the kernel's own tools need from the calling session, such as its sub-agents. It
    /// lets one instance of such a tool serve every session. The tools here ignore it.
    pub session_state: Option<Arc<dyn Any + Send + Sync>>,
}

/// What a tool returns. `content` goes to the model, `details` to user interfaces and logs.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToolOutput {
    pub content: Vec<UserContent>,
    pub details: Option<Value>,
    pub is_error: bool,
}

impl ToolOutput {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![UserContent::Text { text: text.into() }],
            details: None,
            is_error: false,
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            is_error: true,
            ..Self::text(text)
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("invalid arguments: {0}")]
    InvalidArgs(String),
    #[error("{0}")]
    Failed(String),
    #[error("cancelled")]
    Cancelled,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

type ProgressFn = dyn Fn(&str) + Send + Sync;

/// Live output of a running tool (for example command output), forwarded as events.
#[derive(Clone, Default)]
pub struct ProgressSink(Option<Arc<ProgressFn>>);

impl ProgressSink {
    pub fn new(f: impl Fn(&str) + Send + Sync + 'static) -> Self {
        Self(Some(Arc::new(f)))
    }

    pub fn noop() -> Self {
        Self(None)
    }

    pub fn emit(&self, text: &str) {
        if let Some(f) = &self.0
            && !text.is_empty()
        {
            f(text);
        }
    }
}

impl fmt::Debug for ProgressSink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(if self.0.is_some() { "ProgressSink(active)" } else { "ProgressSink(noop)" })
    }
}
