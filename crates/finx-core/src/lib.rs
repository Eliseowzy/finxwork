//! Kernel runtime: sessions, the agent loop, approvals, context assembly and the session log.
//!
//! Front ends drive a [`Kernel`] with [`finx_protocol::Op`]s and consume
//! [`finx_protocol::Event`]s; the kernel never prints or reads the terminal.

mod agents;
pub mod approval;
mod browser;
pub mod browser_install;
mod budget;
pub mod commands;
mod compaction;
pub mod config;
pub mod config_edit;
pub mod connectors;
pub mod context;
pub mod context_report;
mod deferred;
mod desktop;
mod docs;
mod emitter;
pub mod files;
pub mod history;
pub mod hooks;
pub mod instructions;
pub mod kernel;
pub mod mcp;
pub mod models;
pub mod paths;
pub mod prompt;
mod protected;
pub mod rules;
pub mod runtime;
mod session;
mod site_policy;
pub mod skills;
pub mod system;
pub mod store;
pub mod trash;
mod task;
mod tool_exec;

pub use agents::RestoredAgent;
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
pub use system::SystemSettings;
pub use session::clean_title;
pub use store::JsonlStore;
pub use store::MemoryStore;
pub use store::SessionRef;
pub use store::SessionStore;
pub use store::short_id;

pub use finx_browser::BrowserPool;
