//! MCP client for finx: connects to MCP servers over stdio or Streamable HTTP and offers their
//! tools as finx tools. It knows nothing about sessions; the kernel decides which servers to
//! start and how their tools reach the model.

pub mod client;
pub mod content;
pub mod env;
pub mod naming;
pub mod schema;
pub mod search;
pub mod server;
pub mod tool;
mod transport;
pub mod types;

pub use client::McpClient;
pub use client::ProgressFn;
pub use server::CallOptions;
pub use server::McpServer;
pub use server::ServerContext;
pub use server::ServerStatus;
pub use tool::McpTool;
pub use types::CallToolResult;
pub use types::ToolInfo;

#[derive(Debug, Clone, thiserror::Error)]
pub enum McpError {
    #[error("{0}")]
    Transport(String),
    /// A JSON-RPC error from the server.
    #[error("MCP error {code}: {message}")]
    Rpc { code: i64, message: String },
    /// No answer, and no progress, for this many seconds.
    #[error("no answer within {0} s")]
    Timeout(u64),
    #[error("cancelled")]
    Cancelled,
    #[error("{0}")]
    Closed(String),
    #[error("{0}")]
    Protocol(String),
    #[error("the server requires authorization (HTTP 401); finx does not sign in to MCP servers yet")]
    AuthRequired,
    #[error("the server ended the session (HTTP 404)")]
    SessionExpired,
    /// The server cannot take calls now; the reason says why.
    #[error("{0}")]
    Unavailable(String),
    /// The server no longer lists this tool.
    #[error("the server no longer offers the tool {0}")]
    UnknownTool(String),
}
