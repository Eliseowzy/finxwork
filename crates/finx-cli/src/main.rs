//! `finx`: command-line front end of the kernel.

mod approval_prompt;
mod cmd_chat;
mod cmd_exec;
mod cmd_info;
mod cmd_mcp;
mod cmd_serve;
mod render;
mod setup;

use anyhow::Context as _;
use clap::Args;
use clap::Parser;
use clap::Subcommand;
use finx_llm::ThinkingLevel;
use finx_protocol::PermissionMode;
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "finx", version, about = "finx: an agent kernel for software tasks")]
struct Cli {
    /// Override a configuration value, e.g. -c thinking=low (repeatable)
    #[arg(short = 'c', long = "config", global = true, value_name = "KEY=VALUE")]
    overrides: Vec<String>,

    /// Add the MCP servers of a file in the .mcp.json format (repeatable)
    #[arg(long = "mcp-config", global = true, value_name = "FILE")]
    mcp_config: Vec<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Chat with a model directly, without tools (checks the model setup)
    Chat {
        /// Message to send; without it an interactive chat starts ("-" reads stdin)
        prompt: Option<String>,
        /// Model as provider/model-id
        #[arg(short, long)]
        model: Option<String>,
        /// Reasoning level: off, minimal, low, medium, high, max
        #[arg(long)]
        thinking: Option<ThinkingLevel>,
        /// System prompt
        #[arg(long)]
        system: Option<String>,
        /// Offer a sample get_time tool to check tool calling
        #[arg(long)]
        tool_test: bool,
    },
    /// Run a task without an interactive interface
    Exec {
        /// The task ("-" reads it from stdin)
        prompt: String,
        /// Working directory (default: the current directory)
        #[arg(long)]
        cwd: Option<PathBuf>,
        /// Continue the latest session of this project
        #[arg(long = "continue", conflicts_with_all = ["resume", "cwd"])]
        continue_last: bool,
        /// Continue a session: `last` (of this project) or a session id
        #[arg(long, value_name = "last|ID", conflicts_with = "cwd")]
        resume: Option<String>,
        /// Do not keep a session log
        #[arg(long, conflicts_with_all = ["resume", "continue_last"])]
        no_save: bool,
        #[command(flatten)]
        run: RunArgs,
    },
    /// Continue an earlier session
    Resume {
        /// `last` (of this project, the default) or a session id or a unique part of one
        session: Option<String>,
        /// The next instruction ("-" reads it from stdin)
        #[arg(short, long)]
        prompt: Option<String>,
        #[command(flatten)]
        run: RunArgs,
    },
    /// List recent sessions of this project
    Sessions {
        /// Sessions of every project
        #[arg(long)]
        all: bool,
        #[arg(long, default_value_t = 20)]
        limit: usize,
        /// Print JSON
        #[arg(long)]
        json: bool,
    },
    /// List providers and models
    Models {
        /// Only this provider
        #[arg(long)]
        provider: Option<String>,
        /// Print JSON
        #[arg(long)]
        json: bool,
    },
    /// Show the effective configuration: model, provider, credentials, directories
    Status {
        /// Print JSON
        #[arg(long)]
        json: bool,
    },
    /// Check configuration, credentials and directories
    Doctor {
        /// Print JSON
        #[arg(long)]
        json: bool,
    },
    /// List the skills that a session started here would offer the model
    Skills {
        /// Directory (default: the current directory)
        dir: Option<PathBuf>,
        /// Also list skills that are shadowed, disabled or failed to load
        #[arg(long)]
        all: bool,
        /// Print JSON
        #[arg(long)]
        json: bool,
    },
    /// Trust a project so its .finx/config.toml may change security settings
    Trust {
        /// Project directory (default: the current directory)
        dir: Option<PathBuf>,
    },
    /// Show the MCP servers of this project
    Mcp {
        #[command(subcommand)]
        command: McpCommand,
    },
    /// Serve the native protocol (JSON-RPC) to clients, on stdio or a Unix socket
    Serve {
        /// Serve one client on stdin and stdout (the default)
        #[arg(long, conflicts_with = "listen")]
        stdio: bool,
        /// Listen on a Unix socket: unix:// for $FINX_HOME/run/finx.sock, or unix://PATH
        #[arg(long, value_name = "URL")]
        listen: Option<String>,
        /// With --listen: exit after this many seconds without clients or running tasks
        #[arg(long, value_name = "SECS", requires = "listen")]
        idle_exit: Option<u64>,
    },
    /// Serve ACP (Agent Client Protocol) on stdio, for editors such as Zed
    Acp,
    /// Describe the native protocol
    Protocol {
        #[command(subcommand)]
        command: ProtocolCommand,
    },
}

#[derive(Subcommand)]
enum McpCommand {
    /// List the servers: name, transport, exposure and where each is configured
    List {
        /// Connect to every server and list its tools
        #[arg(long)]
        check: bool,
        /// Print JSON
        #[arg(long)]
        json: bool,
    },
    /// Show one server's settings, with secret values hidden
    Get {
        name: String,
        /// Print JSON
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum ProtocolCommand {
    /// Print the JSON Schema of every message, with the methods and error codes
    Schema,
}

#[derive(Args, Clone)]
pub struct RunArgs {
    /// Model as provider/model-id
    #[arg(short, long)]
    pub model: Option<String>,
    /// Reasoning level: off, minimal, low, medium, high, max
    #[arg(long)]
    pub thinking: Option<ThinkingLevel>,
    /// Permission mode: manual (ask before changes), accept-edits (file changes in the
    /// workspace run without asking) or bypass-permissions (everything runs without asking)
    #[arg(long, alias = "approval", value_name = "MODE", value_parser = parse_permission_mode)]
    pub permission_mode: Option<ModeArg>,
    /// Same as --permission-mode bypass-permissions: every action runs without asking,
    /// including changes to .git and shell profiles. Use only in an isolated environment
    #[arg(long, conflicts_with = "permission_mode")]
    pub dangerously_skip_permissions: bool,
    /// text: the reply as it streams; json: one result object at the end; stream-json: events
    /// as JSON lines
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    pub output: OutputFormat,
    /// Same as --output stream-json
    #[arg(long, conflicts_with = "output")]
    pub json: bool,
    /// Read operations (JSON lines) from stdin, e.g. approvals
    #[arg(long)]
    pub ops_stdin: bool,
    /// Stop a task after this many turns
    #[arg(long)]
    pub max_turns: Option<u32>,
    /// Write the last assistant message to this file
    #[arg(long, value_name = "FILE")]
    pub output_last_message: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum OutputFormat {
    Text,
    Json,
    StreamJson,
}

/// A `--permission-mode` value, with a notice when it uses a name from before the rename.
#[derive(Clone, Debug)]
pub struct ModeArg {
    pub mode: PermissionMode,
    pub notice: Option<String>,
}

fn parse_permission_mode(name: &str) -> Result<ModeArg, String> {
    PermissionMode::parse_with_notice(name).map(|(mode, notice)| ModeArg { mode, notice })
}

impl RunArgs {
    pub fn format(&self) -> OutputFormat {
        if self.json { OutputFormat::StreamJson } else { self.output }
    }

    /// The mode chosen on the command line, if any.
    pub fn permission_mode(&self) -> Option<PermissionMode> {
        if self.dangerously_skip_permissions {
            return Some(PermissionMode::BypassPermissions);
        }
        self.permission_mode.as_ref().map(|arg| arg.mode)
    }

    /// Warnings about the arguments themselves.
    pub fn warnings(&self) -> impl Iterator<Item = String> + '_ {
        self.permission_mode.iter().filter_map(|arg| arg.notice.clone())
    }
}

async fn run(overrides: &[String], command: Command) -> anyhow::Result<u8> {
    match command {
        Command::Chat {
            prompt,
            model,
            thinking,
            system,
            tool_test,
        } => {
            cmd_chat::chat(
                overrides,
                cmd_chat::ChatOptions {
                    prompt,
                    model,
                    thinking,
                    system,
                    tool_test,
                },
            )
            .await
        }
        Command::Exec {
            prompt,
            cwd,
            continue_last,
            resume,
            no_save,
            run,
        } => match resume.or(continue_last.then(|| "last".to_string())) {
            Some(session) => cmd_exec::resume(overrides, Some(session), Some(&prompt), &run).await,
            None => cmd_exec::exec(overrides, &prompt, cwd, !no_save, &run).await,
        },
        Command::Resume { session, prompt, run } => {
            cmd_exec::resume(overrides, session, prompt.as_deref(), &run).await
        }
        Command::Serve { listen, idle_exit, .. } => cmd_serve::serve(overrides, listen, idle_exit).await,
        Command::Acp => cmd_serve::acp(overrides).await,
        Command::Mcp {
            command: McpCommand::List { check: true, json },
        } => cmd_mcp::check(overrides, json).await,
        Command::Sessions { .. }
        | Command::Models { .. }
        | Command::Status { .. }
        | Command::Doctor { .. }
        | Command::Skills { .. }
        | Command::Trust { .. }
        | Command::Mcp { .. }
        | Command::Protocol { .. } => {
            unreachable!("local commands run without the async runtime")
        }
    }
}

fn run_async(overrides: &[String], command: Command) -> anyhow::Result<u8> {
    // One task is I/O-bound: four workers start faster than one per core. The service runs
    // many sessions at once and uses every core.
    let workers = match command {
        Command::Serve { .. } | Command::Acp => std::thread::available_parallelism().map_or(4, |n| n.get().clamp(4, 16)),
        _ => 4,
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        // Blocking threads (file tools, log writes) go away soon after a burst.
        .thread_keep_alive(std::time::Duration::from_secs(3))
        // Many sessions writing logs or files at once share these instead of each adding one.
        .max_blocking_threads(64)
        .enable_all()
        .build()
        .context("cannot start the async runtime")?;
    let result = runtime.block_on(run(overrides, command));
    // Background readers (stdin) must not keep the process alive.
    runtime.shutdown_timeout(std::time::Duration::from_millis(200));
    result
}

fn main() -> ExitCode {
    // When the reader goes away (`finx sessions | head`), stop quietly like other Unix tools
    // instead of panicking on the failed write.
    #[cfg(unix)]
    // SAFETY: restoring the default disposition of SIGPIPE before any thread is started.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    let Cli {
        overrides,
        mcp_config,
        command,
    } = Cli::parse();
    let result = setup::load_mcp_config(&mcp_config).and_then(|()| match command {
        // Local commands skip the async runtime: starting it costs more than they do.
        Command::Sessions { all, limit, json } => cmd_info::sessions(all, limit, json),
        Command::Models { provider, json } => cmd_info::models(&overrides, provider.as_deref(), json),
        Command::Status { json } => cmd_info::status(&overrides, json),
        Command::Doctor { json } => cmd_info::doctor(&overrides, json),
        Command::Skills { dir, all, json } => cmd_info::skills(&overrides, dir, all, json),
        Command::Trust { dir } => cmd_info::trust(dir),
        Command::Mcp {
            command: McpCommand::List { check: false, json },
        } => cmd_mcp::list(&overrides, json),
        Command::Mcp {
            command: McpCommand::Get { name, json },
        } => cmd_mcp::get(&overrides, &name, json),
        Command::Protocol {
            command: ProtocolCommand::Schema,
        } => cmd_serve::schema(),
        command => run_async(&overrides, command),
    });
    match result {
        Ok(code) => ExitCode::from(code),
        Err(err) => {
            eprintln!("error: {err:#}");
            ExitCode::from(2)
        }
    }
}
