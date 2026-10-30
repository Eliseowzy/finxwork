//! Kernel runtime: sessions, the agent loop, approvals, context assembly and the session log.
//!
//! Front ends drive a [`Kernel`] with [`finx_protocol::Op`]s and consume
//! [`finx_protocol::Event`]s; the kernel never prints or reads the terminal.

mod agents;
pub mod approval;
mod budget;
pub mod commands;
mod compaction;
pub mod config;
pub mod context;
mod emitter;
pub mod history;
pub mod hooks;
pub mod instructions;
pub mod kernel;
pub mod mcp;
pub mod paths;
pub mod prompt;
mod protected;
pub mod rules;
pub mod runtime;
mod session;
pub mod skills;
pub mod store;
mod task;
mod tool_exec;

pub use config::Config;
pub use config::ConfigError;
pub use config::DEFAULT_MODEL;
pub use config::LoadedConfig;
pub use hooks::Gate;
pub use hooks::Hooks;
pub use hooks::SessionView;
pub use hooks::TurnDecision;
pub use kernel::Kernel;
pub use kernel::KernelClosed;
pub use kernel::KernelDeps;
pub use kernel::KernelError;
pub use kernel::ResumeOptions;
pub use kernel::StartOptions;
pub use kernel::TaskEnd;
pub use kernel::TaskResult;
pub use paths::FinxHome;
pub use runtime::Workspace;
pub use session::MAX_TITLE_CHARS;
pub use session::clean_title;
pub use store::JsonlStore;
pub use store::MemoryStore;
pub use store::SessionRef;
pub use store::SessionStore;
pub use store::short_id;
