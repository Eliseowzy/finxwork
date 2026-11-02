//! The native protocol: JSON-RPC 2.0 methods around the Op/Event pair. Field names are
//! snake_case like the rest of the protocol; unknown fields are ignored.

use finx_llm::Message;
use finx_llm::ThinkingLevel;
use finx_llm::ToolResultMessage;
use finx_llm::UsageTotals;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

use crate::event::AgentStatus;
use crate::event::CompletionReason;
use crate::event::ErrorInfo;
use crate::event::Event;
use crate::event::MailInfo;
pub use crate::event::QueuedInput;
use crate::event::SkillUse;
use crate::event::ToolCategory;
use crate::op::CommandRule;
use crate::op::Op;
use crate::op::PermissionMode;
use crate::op::SiteGrant;
use finx_llm::Timestamp;

/// Method names.
pub mod method {
    pub const INITIALIZE: &str = "initialize";
    pub const SESSION_NEW: &str = "session/new";
    pub const SESSION_RESUME: &str = "session/resume";
    pub const SESSION_ATTACH: &str = "session/attach";
    pub const SESSION_DETACH: &str = "session/detach";
    pub const SESSION_OP: &str = "session/op";
    pub const SESSION_HISTORY: &str = "session/history";
    /// What fills a loaded session's context window (`ContextReport`).
    pub const SESSION_CONTEXT: &str = "session/context";
    pub const SESSION_LIST: &str = "session/list";
    pub const SESSION_CLOSE: &str = "session/close";
    pub const SESSION_DELETE: &str = "session/delete";
    pub const RESOURCE_READ: &str = "resource/read";
    pub const CHATGPT_LOGIN: &str = "chatgpt/login";
    pub const CHATGPT_STATUS: &str = "chatgpt/status";
    pub const CHATGPT_CANCEL: &str = "chatgpt/cancel";
    pub const CHATGPT_LOGOUT: &str = "chatgpt/logout";
    pub const CONNECTIONS_LIST: &str = "connections/list";
    pub const CONNECTIONS_DISCOVER: &str = "connections/discover";
    pub const CONNECTIONS_CONNECT: &str = "connections/connect";
    pub const CONNECTIONS_RETRY: &str = "connections/retry";
    pub const CONNECTIONS_DISCONNECT: &str = "connections/disconnect";
    pub const CONNECTIONS_REMOVE: &str = "connections/remove";
    pub const CONNECTIONS_MODELS: &str = "connections/models";
    pub const MODELS_CHANGED: &str = "models/changed";
    pub const MODELS_LIST: &str = "models/list";
    pub const MODELS_REFRESH: &str = "models/refresh";
    pub const MODELS_SHOW: &str = "models/show";
    pub const SERVER_SHUTDOWN: &str = "server/shutdown";
    /// The session list now, and `sessions/changed` on this connection from then on.
    pub const SESSIONS_SUBSCRIBE: &str = "sessions/subscribe";
    pub const SESSIONS_UNSUBSCRIBE: &str = "sessions/unsubscribe";
    pub const SESSION_RENAME: &str = "session/rename";
    pub const SESSION_ARCHIVE: &str = "session/archive";
    pub const SESSION_UNARCHIVE: &str = "session/unarchive";
    /// A loaded session's skills and `/` commands, or the skills a directory would give a session.
    pub const SKILLS_LIST: &str = "skills/list";
    /// Stores a provider's API key in the credential store.
    pub const AUTH_SET: &str = "auth/set";
    pub const AUTH_DELETE: &str = "auth/delete";
    pub const CANCEL_REQUEST: &str = "$/cancel_request";
    /// Server notification carrying one event.
    pub const SESSION_EVENT: &str = "session/event";
    /// Server notification: the connection no longer receives a session's events.
    pub const SESSION_DETACHED: &str = "session/detached";
    /// Server notification to `sessions/subscribe`rs: summaries that changed, sessions deleted.
    pub const SESSIONS_CHANGED: &str = "sessions/changed";
    // The 自定义 page (docs/desktop/customize-design.md §6).
    pub const CONFIG_READ: &str = "config/read";
    pub const CONFIG_WRITE: &str = "config/write";
    /// Server notification to connections that called `config/read`.
    pub const CONFIG_CHANGED: &str = "config/changed";
    pub const CREDENTIALS_SET: &str = "credentials/set";
    pub const CREDENTIALS_DELETE: &str = "credentials/delete";
    pub const SKILLS_FILES: &str = "skills/files";
    pub const SKILLS_INSTALL: &str = "skills/install";
    pub const SKILLS_REMOVE: &str = "skills/remove";
    pub const SKILLS_SET_ENABLED: &str = "skills/set_enabled";
    /// Server notification to connections that called `skills/list`.
    pub const SKILLS_CHANGED: &str = "skills/changed";
    pub const MCP_LIST: &str = "mcp/list";
    pub const MCP_TOOLS: &str = "mcp/tools";
    pub const MCP_CHECK: &str = "mcp/check";
    /// Server notification to connections that called `mcp/list`.
    pub const MCP_CHANGED: &str = "mcp/changed";
    pub const MCP_PROBE: &str = "mcp/probe";
    pub const MCP_PROBE_CANCEL: &str = "mcp/probe_cancel";
    /// Server notification to the connection that called `mcp/probe`.
    pub const MCP_PROBE_PROGRESS: &str = "mcp/probe_progress";
    pub const MCP_LOGIN: &str = "mcp/login";
    pub const MCP_LOGOUT: &str = "mcp/logout";
    /// This connection shows embedded browsers (browser-design §8.3.1), or lends the user's
    /// Chrome through the finx extension (§8.4).
    pub const BROWSER_HOST: &str = "browser/host";
    /// One CDP message between the kernel and the browser host, either way.
    pub const BROWSER_CDP: &str = "browser/cdp";
    /// Which browsers are connected; the connection hears `browser/changed` from then on.
    pub const BROWSER_STATUS: &str = "browser/status";
    /// Server notification to connections that called `browser/status`.
    pub const BROWSER_CHANGED: &str = "browser/changed";
}

/// Application error codes, shared with the ACP projection. The `data` of these errors
/// always carries `kind`.
pub mod error_code {
    pub const SESSION_NOT_FOUND: i64 = -32002;
    pub const NOT_INITIALIZED: i64 = -32010;
    pub const SESSION_BUSY: i64 = -32011;
    pub const SESSION_NOT_LOADED: i64 = -32012;
    pub const NOT_ATTACHED: i64 = -32013;
    pub const PROMPT_IN_PROGRESS: i64 = -32014;
    pub const APPROVAL_NOT_PENDING: i64 = -32015;
    pub const SERVER_FULL: i64 = -32016;
    pub const OVERLOADED: i64 = -32017;
    pub const UNSUPPORTED_CONTENT: i64 = -32018;
    pub const SESSION_CLOSED: i64 = -32019;
    pub const TASK_FAILED: i64 = -32020;
    /// `auth/set`: the provider refused the key.
    pub const KEY_REJECTED: i64 = -32021;
    /// The model asked for belongs to a provider that is not there (a connection that was
    /// removed or disconnected); `data.provider` names it.
    pub const MODEL_UNAVAILABLE: i64 = -32022;
    /// `config/write`: the file changed after it was read; `data.version` is the current one.
    pub const CONFIG_VERSION_CONFLICT: i64 = -32023;
    /// `config/write`: the layer is not one finx writes for the user.
    pub const CONFIG_LAYER_READONLY: i64 = -32024;
    /// `config/write`: the changed file or the merged result is not valid; `data.errors`
    /// lists `{key_path, message}`.
    pub const CONFIG_VALIDATION_ERROR: i64 = -32025;
    /// The configuration file stayed locked for 2 seconds.
    pub const CONFIG_BUSY: i64 = -32026;
    /// `skills/install`: no usable `SKILL.md`, or too large.
    pub const SKILL_INVALID: i64 = -32027;
    /// `skills/install`: a skill of that name is there and `replace` was not given.
    pub const SKILL_CONFLICT: i64 = -32028;
    /// `skills/remove`: only skills in `~/.finx/skills` can be removed.
    pub const NOT_REMOVABLE: i64 = -32029;
    /// The keychain (or credential file) could not be used.
    pub const CREDENTIAL_STORE_UNAVAILABLE: i64 = -32030;
    /// `mcp/login`: the server publishes no usable sign-in, or the sign-in could not start.
    pub const MCP_LOGIN_FAILED: i64 = -32031;

    /// Every code with its `kind`, standard JSON-RPC codes included.
    pub const ALL: &[(i64, &str)] = &[
        (-32700, "parse_error"),
        (-32600, "invalid_request"),
        (-32601, "method_not_found"),
        (-32602, "invalid_params"),
        (-32603, "internal_error"),
        (-32800, "request_cancelled"),
        (SESSION_NOT_FOUND, "session_not_found"),
        (NOT_INITIALIZED, "not_initialized"),
        (SESSION_BUSY, "session_busy"),
        (SESSION_NOT_LOADED, "session_not_loaded"),
        (NOT_ATTACHED, "not_attached"),
        (PROMPT_IN_PROGRESS, "prompt_in_progress"),
        (APPROVAL_NOT_PENDING, "approval_not_pending"),
        (SERVER_FULL, "server_full"),
        (OVERLOADED, "overloaded"),
        (UNSUPPORTED_CONTENT, "unsupported_content"),
        (SESSION_CLOSED, "session_closed"),
        (TASK_FAILED, "task_failed"),
        (KEY_REJECTED, "key_rejected"),
        (MODEL_UNAVAILABLE, "model_unavailable"),
        (CONFIG_VERSION_CONFLICT, "config_version_conflict"),
        (CONFIG_LAYER_READONLY, "config_layer_readonly"),
        (CONFIG_VALIDATION_ERROR, "config_validation_error"),
        (CONFIG_BUSY, "config_busy"),
        (SKILL_INVALID, "skill_invalid"),
        (SKILL_CONFLICT, "skill_conflict"),
        (NOT_REMOVABLE, "not_removable"),
        (CREDENTIAL_STORE_UNAVAILABLE, "credential_store_unavailable"),
        (MCP_LOGIN_FAILED, "mcp_login_failed"),
    ];
}

/// The result of methods that return nothing: `{}`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Empty {}

/// A JSON-RPC request id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum RequestId {
    Int(i64),
    Str(String),
}

/// Parameters of the `$/cancel_request` notification.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CancelRequestParams {
    pub id: RequestId,
}

/// Which browser a `browser/host` connection provides.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BrowserHostKind {
    /// The desktop app's embedded browser (browser-design §8.3).
    #[default]
    Embedded,
    /// The user's own Chrome, through the finx extension and `finx browser native-host`
    /// (§8.4). Only that program may say so: the service checks the peer's executable.
    Extension,
}

/// Parameters of `browser/host`. Older hosts send none: the embedded browser.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BrowserHostParams {
    #[serde(default)]
    pub kind: BrowserHostKind,
    /// The browser the host is in, as it names itself: "Google Chrome 141.0.7390.54".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<String>,
    /// The FinxWork extension's version, for an extension host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension_version: Option<String>,
    /// The bridge versions the extension speaks (browser-design D-219). An extension host
    /// that sends none has an extension from before them: version 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bridge: Option<BridgeRange>,
}

/// A range of bridge versions, both ends included.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BridgeRange {
    pub min: u32,
    pub max: u32,
}

/// Why a connected extension cannot be used: it and finx share no bridge version.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionProblem {
    /// The extension is older than this finx can drive; the store updates it by itself.
    UpdateExtension,
    /// The extension is newer than this finx; update FinxWork.
    UpdateFinx,
}

/// The result of `browser/host`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BrowserHostResult {
    /// The bridge version to speak, for an extension host that finx can use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bridge: Option<u32>,
    /// Set when the extension cannot be used. The connection stays, so clients can say what
    /// to update, but carries no browser.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<ExtensionProblem>,
}

/// The user's own browser, lent through the FinxWork extension (browser-design §8.4).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ExtensionStatus {
    /// "Google Chrome 141.0.7390.54", when the extension said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension_version: Option<String>,
    /// Set when the extension is connected but cannot be used until one side is updated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<ExtensionProblem>,
}

/// The result of `browser/status`, and the parameters of `browser/changed`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BrowserStatus {
    /// Set while the FinxWork extension is connected; with `problem` when it cannot be used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension: Option<ExtensionStatus>,
    /// Whether a desktop app shows embedded browsers.
    pub embedded: bool,
}

/// Parameters of the `browser/cdp` notification, in both directions.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct BrowserCdpParams {
    /// Which browser on the host: each one the kernel starts gets a new number, and the host
    /// answers with the number of the command. Messages of an earlier browser are dropped.
    pub stream: u64,
    /// One CDP message, as a JSON object: a command from the kernel; a response or an event
    /// from the host. Carried as is, so a large one (a screenshot, an accessibility tree) is
    /// neither escaped into a string nor parsed on the way through.
    #[schemars(with = "serde_json::Map<String, serde_json::Value>")]
    pub data: Box<serde_json::value::RawValue>,
}

// ---- Initialization ----

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct InitializeParams {
    pub protocol_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_info: Option<PeerInfo>,
    #[serde(default)]
    pub capabilities: ClientCapabilities,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PeerInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ClientCapabilities {
    /// Adjacent deltas may be merged while the connection is backlogged.
    #[serde(default = "yes")]
    pub coalesce: bool,
}

impl Default for ClientCapabilities {
    fn default() -> Self {
        Self { coalesce: true }
    }
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct InitializeResult {
    pub protocol_version: u32,
    pub server_info: PeerInfo,
    pub capabilities: ServerCapabilities,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ServerCapabilities {
    pub max_frame_bytes: u64,
    pub session_delete: bool,
    pub resource_read: bool,
    pub event_filter: bool,
    /// `sessions/subscribe`, `sessions/changed`, and the state fields of SessionSummary.
    #[serde(default)]
    pub sessions_subscribe: bool,
    /// `session/rename`, `session/archive`, `session/unarchive`.
    #[serde(default)]
    pub session_metadata: bool,
    /// Transcripts carry `task_end` items.
    #[serde(default)]
    pub transcript_task_end: bool,
    /// `auth/set`, `auth/delete`, and `providers` in `models/list`.
    #[serde(default)]
    pub auth: bool,
    /// Sub-agents: `agent_event`, `agents` in snapshots, `mail` on transcript messages, and the
    /// `agent_interrupt` op.
    #[serde(default)]
    pub agents: bool,
    #[serde(default)]
    pub model_connections: bool,
    /// Model lists asked from providers (docs/kernel/model-catalog-design.md §8): `shown`,
    /// `known`, `deprecated` on models, `listing` on providers, `models/refresh`, `models/show`,
    /// and a checked `auth/set`.
    #[serde(default)]
    pub model_discovery: bool,
    /// The 自定义 page's methods: `config/*`, `credentials/*`, `skills/install`,
    /// `skills/remove`, `skills/set_enabled`, `skills/files`, `mcp/list`, `mcp/tools`,
    /// `mcp/check`, and their notifications (docs/desktop/customize-design.md §6).
    #[serde(default)]
    pub customize: bool,
    /// `browser/host` and `browser/cdp`: a client can show the browser tools' pages
    /// (browser-design §8.3).
    #[serde(default)]
    pub embedded_browser: bool,
    /// Input that waits for the running task, as a client shows and changes it:
    /// `queue_changed`, `input_withdrawn`, the `withdraw`, `requeue` and `steer_now` ops, and
    /// `returned_input` on `task_failed` (docs/kernel/input-queue-design.md).
    #[serde(default)]
    pub input_queue: bool,
}

// ---- Sessions ----

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionNewParams {
    /// Absolute path. Without one the session has no project: it works in an empty folder of
    /// its own, made for it (`no_project` in its summary).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathBuf>,
    /// Extra workspace roots, absolute.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_roots: Vec<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<ThinkingLevel>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "approval_mode"
    )]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default)]
    pub events: EventFilter,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_limit: Option<u32>,
    /// MCP servers for this session, on top of the configured ones; same name wins.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<crate::McpServerConfig>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionNewResult {
    pub session_id: String,
    pub snapshot: SessionSnapshot,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionResumeParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<ThinkingLevel>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "approval_mode"
    )]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default)]
    pub events: EventFilter,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_limit: Option<u32>,
    /// MCP servers for this session when it is loaded; not allowed for a loaded session.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<crate::McpServerConfig>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionAttachParams {
    pub session_id: String,
    #[serde(default)]
    pub events: EventFilter,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_limit: Option<u32>,
}

/// Result of `session/resume` and `session/attach`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SnapshotResult {
    pub snapshot: SessionSnapshot,
}

/// Parameters of `session/detach`, `session/close` and `session/delete`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionIdParams {
    pub session_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionOpParams {
    pub session_id: String,
    pub op: Op,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionHistoryParams {
    pub session_id: String,
    pub before: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionListParams {
    /// Only sessions of this project (same matching as `finx sessions`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionListResult {
    pub sessions: Vec<SessionSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionSummary {
    pub session_id: String,
    pub cwd: PathBuf,
    /// Started without a project: `cwd` is the folder made for it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_project: bool,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339; the last activity: when a task last started or ended, else `created_at`. Opening,
    /// closing, renaming, archiving or changing settings does not move it.
    pub updated_at: String,
    /// The start of the first user message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// The name given with `session/rename`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub state: SessionState,
    /// The model the session uses (`provider/model-id`), when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default)]
    pub archived: bool,
    /// When the running task started (RFC 3339).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_started_at: Option<String>,
    /// Loaded in this server.
    pub loaded: bool,
    /// A task is running.
    pub busy: bool,
    pub attached_clients: u32,
}

/// What a session is doing, for lists.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    #[default]
    Idle,
    Running,
    /// A task waits for an approval.
    AwaitingApproval,
    /// The last task failed.
    Failed,
}

/// Parameters of the `sessions/changed` notification.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionsChangedParams {
    /// Whole summaries of the sessions that changed or appeared.
    pub sessions: Vec<SessionSummary>,
    /// Ids of deleted sessions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deleted: Vec<String>,
}

/// Parameters of `session/rename`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionRenameParams {
    pub session_id: String,
    /// At most 200 characters; trimmed.
    pub title: String,
}

// ---- Event delivery ----

/// Event classes a connection can opt out of when attaching.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EventClass {
    TextDelta,
    ThinkingDelta,
    ToolCallDelta,
    ToolProgress,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct EventFilter {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclude: Vec<EventClass>,
}

/// Parameters of the `session/event` notification.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionEventParams {
    pub session_id: String,
    pub event: Event,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DetachReason {
    /// The connection fell too far behind; attach again for a fresh snapshot.
    Overflow,
    /// The session was closed.
    Closed,
    /// The idle session was unloaded; resume it to continue.
    Unloaded,
}

/// Parameters of the `session/detached` notification.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionDetachedParams {
    pub session_id: String,
    pub reason: DetachReason,
    pub last_seq: u64,
}

// ---- Snapshots ----

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionSnapshot {
    pub session: SessionInfo,
    /// The last event reflected here; later events have larger sequence numbers.
    pub last_seq: u64,
    pub transcript: TranscriptPage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_task: Option<ActiveTask>,
    pub usage: UsageTotals,
    /// The latest status of each MCP server, by name.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<crate::McpServerInfo>,
    /// The sub-agents started since the session was loaded, in the order they started.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<AgentSnapshot>,
    /// Input waiting for the running task, as the last `queue_changed` gave it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub queued: Vec<QueuedInput>,
}

/// A sub-agent as a snapshot shows it: what `agent_started` and `agent_status` said, and its own
/// conversation as far as `agent_event` carried it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AgentSnapshot {
    pub agent_id: String,
    pub name: String,
    /// The `spawn_agent` call that started it.
    pub call_id: String,
    pub session_file: PathBuf,
    pub status: AgentStatus,
    /// When the status was last set: a running agent's round of work started then.
    pub since: Timestamp,
    /// The start of its last report.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<UsageTotals>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorInfo>,
    /// How long its last finished round of work took.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    pub transcript: TranscriptPage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_task: Option<ActiveTask>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionInfo {
    pub session_id: String,
    pub cwd: PathBuf,
    pub session_file: PathBuf,
    pub model: String,
    pub thinking: ThinkingLevel,
    #[serde(alias = "approval_mode")]
    pub permission_mode: PermissionMode,
    pub context_window: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TranscriptPage {
    /// Oldest first.
    pub items: Vec<TranscriptItem>,
    /// Cursor for earlier items (opaque); absent at the start of the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TranscriptItem {
    /// A user or assistant message; `skills` as in `message_completed`. `mail` marks a sub-agent's report.
    // The rare parts are boxed: a client's transcript holds an item per message of the whole
    // session.
    Message {
        message_id: String,
        message: Message,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        skills: Vec<SkillUse>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mail: Option<Box<MailInfo>>,
    },
    ToolResult { call_id: String, result: Arc<ToolResultMessage> },
    /// Where a task ended. Usage and reason are absent for tasks logged before they were recorded.
    TaskEnd {
        task_id: String,
        outcome: TaskOutcome,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<CompletionReason>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<Box<ErrorInfo>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<UsageTotals>,
        ts: Timestamp,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskOutcome {
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ActiveTask {
    pub task_id: String,
    pub turn: u32,
    /// The assistant message being generated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub streaming: Option<PartialMessage>,
    /// Tool calls that have not completed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolState>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub approvals: Vec<PendingApproval>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PartialMessage {
    pub message_id: String,
    /// Ordered by index.
    pub blocks: Vec<PartialBlock>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PartialBlock {
    Text {
        index: usize,
        text: String,
    },
    Thinking {
        index: usize,
        text: String,
    },
    ToolCall {
        index: usize,
        call_id: String,
        name: String,
        args_json: String,
    },
}

impl PartialBlock {
    pub fn index(&self) -> usize {
        match self {
            PartialBlock::Text { index, .. }
            | PartialBlock::Thinking { index, .. }
            | PartialBlock::ToolCall { index, .. } => *index,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ToolState {
    pub call_id: String,
    pub name: String,
    pub category: ToolCategory,
    pub title: String,
    pub args: Value,
    pub running: bool,
    /// The most recent progress output, capped.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub progress_tail: String,
}

/// Same fields as the `approval_requested` event.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PendingApproval {
    pub call_id: String,
    pub name: String,
    pub args: Value,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposed_rule: Option<CommandRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposed_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub proposed_grants: Vec<SiteGrant>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub own_browser: bool,
}

// ---- Resources and models ----

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ResourceReadParams {
    /// `finx://tool-output/<session_id>/<call_id>`
    pub uri: String,
    #[serde(default)]
    pub offset: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ResourceReadResult {
    pub text: String,
    pub offset: u64,
    pub eof: bool,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ModelsListResult {
    pub models: Vec<ModelSummary>,
    /// Every provider with where its credentials come from.
    #[serde(default)]
    pub providers: Vec<ProviderSummary>,
    /// What a new session starts with when `session/new` leaves a setting out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defaults: Option<SessionDefaults>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionDefaults {
    /// `provider/model-id`
    pub model: String,
    pub thinking: ThinkingLevel,
    pub permission_mode: PermissionMode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderSummary {
    pub id: String,
    pub name: String,
    pub auth: AuthKind,
    pub credential: CredentialState,
    /// The environment variable the key comes from, when `credential` is `env`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_source: Option<String>,
    /// Environment variables that may hold the key.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_env: Vec<String>,
    /// Where its models came from; absent while it has no credentials.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listing: Option<ProviderListing>,
}

/// A provider's model list as the kernel last saw it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderListing {
    pub source: ListingSource,
    /// The last successful answer (RFC 3339).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
    /// A refresh is running in the background.
    #[serde(default)]
    pub refreshing: bool,
    /// Why the last refresh failed; the older list is still in use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ListingError>,
    /// Models of this provider in `models/list`.
    pub models: u32,
    /// Of those, the ones in the model menu.
    pub shown: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ListingSource {
    /// The provider's own list.
    Provider,
    /// Not asked yet, or no list: the public catalog's models.
    Catalog,
    /// The provider has no list endpoint and the catalog does not know it.
    Unsupported,
    /// Only the models written in models.toml.
    Config,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ListingError {
    /// An error kind (`auth`, `network`, …).
    pub kind: String,
    pub message: String,
}

/// Result of `auth/set`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AuthSetResult {
    /// The provider accepted the key (its model list answered). `false` when it could not be
    /// asked; the key is saved either way.
    #[serde(default)]
    pub verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<u32>,
}

/// Parameters of `models/refresh`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ModelsRefreshParams {
    /// One provider; all with credentials when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Refresh the public model catalog too.
    #[serde(default)]
    pub catalog: bool,
}

/// Result of `models/refresh`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ModelsRefreshResult {
    pub providers: Vec<ProviderSummary>,
}

/// Parameters of `models/show`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ModelsShowParams {
    /// `provider/model-id`
    pub model: String,
    /// In the model menu or not.
    pub shown: bool,
}

/// How a provider authenticates.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    Connection,
    /// An API key, which `auth/set` can store.
    ApiKey,
    /// A configured command prints the key.
    Command,
    None,
}

/// Where a provider's key comes from, checked without contacting the provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CredentialState {
    Connection,
    Missing,
    /// `api_key` in models.toml.
    Config,
    /// An environment variable (`credential_source`).
    Env,
    /// The credential store (`auth/set`).
    Stored,
    /// `api_key_command`; whether it works shows on the first request.
    Command,
    NotRequired,
}

/// Parameters of `auth/set`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AuthSetParams {
    pub provider: String,
    pub api_key: String,
}

impl std::fmt::Debug for AuthSetParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthSetParams")
            .field("provider", &self.provider)
            .finish_non_exhaustive()
    }
}

/// Parameters of `auth/delete`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AuthDeleteParams {
    pub provider: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ModelSummary {
    /// `provider/model-id`
    pub id: String,
    pub name: String,
    pub provider: String,
    pub context_window: u64,
    pub reasoning: bool,
    /// The provider's own thinking levels this model offers, `off` when it can be switched off;
    /// `default` (the provider decides) is always possible and not listed. Empty: no control.
    pub thinking_levels: Vec<ThinkingLevel>,
    /// The level a session starts with on this model: the one last chosen on it, else its
    /// configured default, else `default`.
    #[serde(default)]
    pub default_thinking: ThinkingLevel,
    pub images: bool,
    /// The provider's credentials are available.
    pub available: bool,
    /// In the model menu (the defaults and the user's choices).
    #[serde(default = "yes")]
    pub shown: bool,
    /// Its details come from somewhere; `false` means default limits.
    #[serde(default = "yes")]
    pub known: bool,
    /// The provider retired it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deprecated: bool,
    /// `YYYY-MM-DD`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<ModelPrice>,
}

/// Prices per million tokens.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ModelPrice {
    pub input: f64,
    pub output: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
    pub currency: finx_llm::Currency,
}

// ---- Skills ----

/// Where a skill comes from. Earlier layers win when names collide.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillScope {
    Project,
    User,
    Extra,
    /// Built into finx, written to `~/.finx/skills/.system`; after every other root.
    System,
}

impl SkillScope {
    pub fn as_str(self) -> &'static str {
        match self {
            SkillScope::Project => "project",
            SkillScope::User => "user",
            SkillScope::Extra => "extra",
            SkillScope::System => "system",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillState {
    Active,
    /// A skill of the same name with a higher priority is active.
    Shadowed,
    /// Turned off by `skills.disabled`.
    Disabled,
    /// Not loaded: the header is broken or has no description.
    Invalid,
}

/// One `SKILL.md` that was found, and what became of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SkillEntry {
    /// From the header, or the directory's name when the header has none.
    pub name: String,
    /// One line, at most 1,024 characters; empty when invalid.
    pub description: String,
    /// The `SKILL.md`, absolute, as found: symbolic links are kept.
    pub path: PathBuf,
    pub scope: SkillScope,
    /// False when only the user may invoke it (`disable-model-invocation`).
    pub model_invocable: bool,
    /// What to type after `/name`, from the header's `argument-hint`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
    pub state: SkillState,
    /// The winner's path when shadowed; the reason when invalid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Remarks that did not stop the skill from loading.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
    /// Where finx installed it from (`.finx-source.json`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<crate::customize::SkillSource>,
    /// In `~/.finx/skills` (not built in), so `skills/remove` takes it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub removable: bool,
    /// Whether it is on when the user has not turned it on or off: false for a project's
    /// `.claude/skills`, which `skills.opt_in` turns on. Then `disabled` means "off by default".
    #[serde(default = "yes")]
    pub default_enabled: bool,
}

impl SkillEntry {
    /// The skill directory: relative paths in the skill are relative to it.
    pub fn dir(&self) -> &std::path::Path {
        self.path.parent().unwrap_or(&self.path)
    }
}

/// Something the user can type as `/name` at the start of a message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CommandInfo {
    pub name: String,
    pub description: String,
    /// What to type after the name, from the skill's `argument-hint`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// The `SKILL.md` of the skill it invokes; absent for a built-in command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<PathBuf>,
}

/// The skill catalog in the system prompt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CatalogInfo {
    pub listed: usize,
    /// Estimated size of the catalog.
    pub tokens: u64,
    pub budget: u64,
    /// Descriptions were cut to this many characters to fit the budget.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortened_to: Option<usize>,
    /// Skills left out to fit the budget, in priority order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub left_out: Vec<String>,
}

/// Parameters of `skills/list`: `session_id` or `cwd`, or neither for what a session without
/// a project would find.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SkillsListParams {
    /// A loaded session: the skills it started with, described from their files now, and
    /// what typing `/` offers there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// An absolute directory: every skill a session started there would find now, those it
    /// would not use included, and its catalog. The same as `finx skills --all --json`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SkillsListResult {
    /// In priority order.
    pub skills: Vec<SkillEntry>,
    /// What typing `/` offers there: the built-in commands first, then the skills as
    /// `skill:name`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<CommandInfo>,
    /// For a directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<CatalogInfo>,
    /// `skills.enabled`
    pub enabled: bool,
    pub warnings: Vec<String>,
    /// Other apps' folders that hold skills but are not read (`skills.other_apps` is off).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub not_read: Vec<PathBuf>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_default_to_coalescing() {
        let params: InitializeParams = serde_json::from_str(r#"{"protocol_version":1}"#).unwrap();
        assert!(params.capabilities.coalesce);
        let params: InitializeParams =
            serde_json::from_str(r#"{"protocol_version":1,"capabilities":{"coalesce":false}}"#)
                .unwrap();
        assert!(!params.capabilities.coalesce);
    }

    #[test]
    fn ops_travel_unchanged_inside_session_op() {
        let params: SessionOpParams =
            serde_json::from_str(r#"{"session_id":"s","op":{"type":"approval","call_id":"c1","decision":{"type":"approve"}}}"#)
                .unwrap();
        assert!(matches!(params.op, Op::Approval { .. }));
    }
}

/// Public connection management DTOs. Never contain credentials or session tokens.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ConnectionModel {
    pub id: String,
    pub name: String,
    pub context_window: Option<u32>,
    pub max_output_tokens: Option<u32>,
    #[serde(default)] pub reasoning: bool,
    #[serde(default)] pub images: bool,
    /// The thinking levels the application offers for it (model-catalog-design §18).
    #[serde(default, skip_serializing_if = "Vec::is_empty")] pub thinking: Vec<ThinkingLevel>,
    /// The level the application itself uses when none is chosen.
    #[serde(default)] pub default_thinking: ThinkingLevel,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState { Connecting, Ready, Disabled, NeedsLogin, PermissionRequired, Unsupported, Unavailable }
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ConnectionView {
    pub connection_id: String,
    /// The provider its models are published under: the same for the same account of the same
    /// application, so sessions keep their model when the connection is removed and made again.
    pub provider_id: String,
    pub adapter_id: String,
    pub display_name: String,
    pub state: ConnectionState,
    #[serde(skip_serializing_if = "Option::is_none")] pub reason_code: Option<String>,
    pub models: Vec<ConnectionModel>,
    /// When `models` was last taken from the application (RFC 3339).
    #[serde(default, skip_serializing_if = "Option::is_none")] pub models_fetched_at: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ConnectionsSnapshot { pub revision: u64, pub connections: Vec<ConnectionView> }
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ConnectionDiscovery {
    pub adapter_id: String,
    pub installed: bool,
    pub version: Option<String>,
    pub login: String,
    pub discovery_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConnectionConnectParams {
    pub adapter_id: String,
    pub discovery_id: String,
    pub idempotency_key: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConnectionIdParams { pub connection_id: String }

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ConnectionsDiscoveryResult { pub discoveries: Vec<ConnectionDiscovery> }

/// Only public login progress crosses RPC. OAuth tokens stay in the kernel credential store.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChatGptLoginState { Idle, Pending, Connected, Failed, Cancelled }
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ChatGptStatus {
    pub state: ChatGptLoginState,
    pub login_id: Option<String>,
    pub authorize_url: Option<String>,
    pub account: Option<String>,
    pub message: Option<String>,
    pub connection: Option<ConnectionView>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChatGptCancelParams { pub login_id: String }
