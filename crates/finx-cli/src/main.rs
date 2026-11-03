//! `finx`: command-line front end of the kernel.

mod approval_prompt;
mod cmd_browser;
mod cmd_chat;
mod cmd_customize;
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
// Build arguments only for the selected command; help still expands its own command.
#[command(defer = true)]
enum Command {
    /// Run a managed connector's internal tool adapter
    #[command(hide = true)]
    Connector {
        #[command(subcommand)]
        command: ConnectorCommand,
    },
    /// Chat with a model directly, without tools (checks the model setup)
    Chat {
        /// Message to send; without it an interactive chat starts ("-" reads stdin)
        prompt: Option<String>,
        /// Model as provider/model-id
        #[arg(short, long)]
        model: Option<String>,
        /// Thinking level: default (the provider decides), or one the model offers: off, on,
        /// minimal, low, medium, high, xhigh, max
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
    /// List the models in the model menu, by provider; `show` and `hide` change the menu
    Models {
        /// Only this provider
        #[arg(long)]
        provider: Option<String>,
        /// Also the hidden models
        #[arg(long)]
        all: bool,
        /// Ask the providers and the public model catalog first
        #[arg(long)]
        refresh: bool,
        /// Print JSON (the `models/list` result)
        #[arg(long)]
        json: bool,
        #[command(subcommand)]
        action: Option<ModelsAction>,
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
    /// List the skills that a session started here would offer the model; `add`, `remove`,
    /// `enable` and `disable` change them
    #[command(args_conflicts_with_subcommands = true)]
    Skills {
        /// Directory (default: the current directory)
        dir: Option<PathBuf>,
        /// Also list skills that are shadowed, disabled or failed to load
        #[arg(long)]
        all: bool,
        /// Print JSON
        #[arg(long)]
        json: bool,
        #[command(subcommand)]
        action: Option<SkillsAction>,
    },
    /// The browser tools' own browser
    Browser {
        #[command(subcommand)]
        command: BrowserCommand,
    },
    /// Trust a project so its .finx/config.toml may change security settings
    Trust {
        /// Project directory (default: the current directory)
        dir: Option<PathBuf>,
    },
    /// Show, add and remove the MCP servers of this project
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
#[command(defer = true)]
enum ConnectorCommand {
    Serve { id: String, #[arg(long)] home: PathBuf },
}

#[derive(Subcommand)]
#[command(defer = true)]
enum BrowserCommand {
    /// Download Chrome for Testing into ~/.finx/browser/chromium, for machines without Chrome,
    /// Edge or Chromium (used only when none is installed)
    Install,
    /// Let the agent use your own Chrome through the FinxWork extension
    Extension {
        #[command(subcommand)]
        command: ExtensionCommand,
    },
    /// The Native Messaging host that Chrome starts for the FinxWork extension
    #[command(hide = true)]
    NativeHost {
        /// What Chrome passes: the extension's origin, and on Windows the parent window
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
}

#[derive(Subcommand)]
#[command(defer = true)]
enum ExtensionCommand {
    /// Register finx with Chrome, Chromium, Edge and Brave as the extension's host
    Install {
        /// Also allow this extension ID (a copy from a store or loaded from another folder)
        #[arg(long = "extension-id", value_name = "ID")]
        extension_ids: Vec<String>,
        /// Register for this browser user data directory only
        #[arg(long, value_name = "DIR")]
        user_data_dir: Option<PathBuf>,
    },
    /// Remove what install wrote
    Uninstall,
    /// Show where the host is registered
    Status,
}

#[derive(Subcommand)]
#[command(defer = true)]
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
    /// Check a server, then add it to your configuration; one that signs in with OAuth is signed in first
    Add {
        name: String,
        /// The server's URL (streamable HTTP)
        #[arg(long, conflicts_with = "command")]
        url: Option<String>,
        /// An HTTP header, as KEY=VALUE (repeatable)
        #[arg(long = "header", value_name = "KEY=VALUE", requires = "url")]
        headers: Vec<String>,
        /// A variable for the command, as KEY=VALUE (repeatable)
        #[arg(long = "env", value_name = "KEY=VALUE")]
        env: Vec<String>,
        /// Keep this --env variable's value in the keychain; the configuration refers to it
        #[arg(long = "secret-env", value_name = "KEY")]
        secret_env: Vec<String>,
        /// Read a bearer token from standard input and keep it in the keychain
        #[arg(long, requires = "url")]
        token: bool,
        /// Only for you, only in this project (your personal project settings)
        #[arg(long, conflicts_with = "project")]
        here: bool,
        /// In the project's .finx/config.toml, for everyone who uses the repository
        #[arg(long)]
        project: bool,
        /// Add it even when the check fails
        #[arg(long)]
        force: bool,
        /// Do not sign in now; sign in later with `finx mcp login`
        #[arg(long)]
        no_login: bool,
        /// The command that runs the server, after --
        #[arg(last = true, value_name = "COMMAND")]
        command: Vec<String>,
    },
    /// Sign in to a server with OAuth in your browser
    Login { name: String },
    /// Sign out of a server: revoke and delete its tokens
    Logout { name: String },
    /// Remove a server from the file that defines it
    Remove {
        name: String,
        /// Also from the project's .finx/config.toml
        #[arg(long)]
        project: bool,
    },
    /// Turn a server on again
    Enable {
        name: String,
        /// Only for you, only in this project
        #[arg(long)]
        here: bool,
    },
    /// Turn a server off; a server of the repository is turned off for you alone
    Disable {
        name: String,
        /// Only for you, only in this project
        #[arg(long)]
        here: bool,
    },
}

#[derive(Subcommand)]
#[command(defer = true)]
enum SkillsAction {
    /// Copy a skill (a folder with SKILL.md, or a .zip or .skill archive) into ~/.finx/skills
    Add {
        path: PathBuf,
        /// Into the project's .agents/skills instead
        #[arg(long)]
        project: bool,
        /// Put it in place of a skill of the same name (the old one goes to the trash)
        #[arg(long)]
        replace: bool,
    },
    /// Move one of your own skills to the trash
    Remove {
        /// A name, or a path to the skill
        skill: String,
    },
    /// Turn a skill on again
    Enable {
        /// A name (every skill of the name), or a path (that copy)
        skill: String,
    },
    /// Turn a skill off in your configuration
    Disable {
        /// A name (every skill of the name), or a path (that copy)
        skill: String,
    },
}

#[derive(Subcommand)]
#[command(defer = true)]
pub(crate) enum ModelsAction {
    /// Sign in with ChatGPT to use subscription models (no API key)
    Login { #[arg(value_parser = ["chatgpt-api"])] connection: String },
    /// Disconnect and revoke the ChatGPT subscription connection
    Logout { #[arg(value_parser = ["chatgpt-api"])] connection: String },
    /// Forget a signed-out ChatGPT registration so another account can be connected
    Forget { #[arg(value_parser = ["chatgpt-api"])] connection: String },
    /// Show ChatGPT connection status, without credentials
    Status { #[arg(value_parser = ["chatgpt-api"])] connection: String },
    /// Put a model in the model menu
    Show {
        /// provider/model-id
        model: String,
    },
    /// Take a model out of the model menu
    Hide {
        /// provider/model-id
        model: String,
    },
}

#[derive(Subcommand)]
#[command(defer = true)]
enum ProtocolCommand {
    /// Print the JSON Schema of every message, with the methods and error codes
    Schema,
}

#[derive(Args, Clone)]
pub struct RunArgs {
    /// Model as provider/model-id
    #[arg(short, long)]
    pub model: Option<String>,
    /// Thinking level: default (the provider decides), or one the model offers: off, on,
    /// minimal, low, medium, high, xhigh, max
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
        Command::Connector { command: ConnectorCommand::Serve { id, home } } => {
            if !home.is_absolute() { anyhow::bail!("connector home must be absolute"); }
            finx_core::connectors::serve(&home, &id, tokio::io::stdin(), tokio::io::stdout()).await.map_err(anyhow::Error::msg)?;
            Ok(0)
        }
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
        Command::Browser {
            command: BrowserCommand::Install,
        } => cmd_info::browser_install().await,
        Command::Browser {
            command: BrowserCommand::NativeHost { .. },
        } => cmd_browser::native_host().await,
        Command::Browser {
            command: BrowserCommand::Extension { command },
        } => match command {
            ExtensionCommand::Install { extension_ids, user_data_dir } => cmd_browser::install(&extension_ids, user_data_dir),
            ExtensionCommand::Uninstall => cmd_browser::uninstall(),
            ExtensionCommand::Status => cmd_browser::status(),
        },
        Command::Mcp {
            command: McpCommand::List { check: true, json },
        } => cmd_mcp::check(overrides, json).await,
        Command::Mcp {
            command: McpCommand::Add { name, url, headers, env, secret_env, token, here, project, force, no_login, command },
        } => {
            cmd_customize::mcp_add(cmd_customize::AddArgs { name, url, headers, env, secret_env, token, here, project, command, force, no_login })
                .await
        }
        Command::Mcp {
            command: McpCommand::Login { name },
        } => cmd_customize::mcp_login(&name).await,
        Command::Mcp {
            command: McpCommand::Remove { name, project },
        } => cmd_customize::mcp_remove(&name, project).await,
        Command::Mcp {
            command: McpCommand::Logout { name },
        } => cmd_customize::mcp_logout(&name).await,
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
    // A foreground command is driven by the calling thread. Its asynchronous tools and
    // sub-agents still make progress together; filesystem work uses the blocking pool.
    // Services retain a worker pool, sized to the CPUs actually available to this process.
    let mut builder = match command {
        Command::Exec { .. } | Command::Resume { .. } | Command::Chat { .. } => {
            tokio::runtime::Builder::new_current_thread()
        }
        _ => {
            let workers = std::thread::available_parallelism().map_or(4, |n| n.get().min(16));
            let mut builder = tokio::runtime::Builder::new_multi_thread();
            builder.worker_threads(workers);
            builder
        }
    };
    let runtime = builder
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
        Command::Models { provider, all, refresh, json, action } => {
            cmd_info::models(&overrides, provider.as_deref(), all, refresh, json, action)
        }
        Command::Status { json } => cmd_info::status(&overrides, json),
        Command::Doctor { json } => cmd_info::doctor(&overrides, json),
        Command::Skills { action: Some(action), .. } => match action {
            SkillsAction::Add { path, project, replace } => cmd_customize::skills_add(&path, project, replace),
            SkillsAction::Remove { skill } => cmd_customize::skills_remove(&skill),
            SkillsAction::Enable { skill } => cmd_customize::skills_switch(&skill, true),
            SkillsAction::Disable { skill } => cmd_customize::skills_switch(&skill, false),
        },
        Command::Skills { dir, all, json, action: None } => cmd_info::skills(&overrides, dir, all, json),
        Command::Trust { dir } => cmd_info::trust(dir),
        Command::Mcp {
            command: McpCommand::List { check: false, json },
        } => cmd_mcp::list(&overrides, json),
        Command::Mcp {
            command: McpCommand::Get { name, json },
        } => cmd_mcp::get(&overrides, &name, json),
        Command::Mcp {
            command: McpCommand::Enable { name, here },
        } => cmd_customize::mcp_switch(&name, true, here),
        Command::Mcp {
            command: McpCommand::Disable { name, here },
        } => cmd_customize::mcp_switch(&name, false, here),
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

#[cfg(test)]
mod parsing_tests {
    use super::*;
    use clap::CommandFactory;
    use clap::error::ErrorKind;

    #[test]
    fn help_expands_every_deferred_command() {
        fn visit(mut command: clap::Command, path: Vec<String>) {
            command.build();
            let mut args = path.clone();
            args.push("--help".into());
            let error = Cli::try_parse_from(args).err().expect("help exits the parser");
            assert_eq!(error.kind(), ErrorKind::DisplayHelp, "{path:?}: {error}");
            assert!(error.to_string().contains("Usage:"), "{path:?}: {error}");
            for child in command.get_subcommands().filter(|child| child.get_name() != "help") {
                let mut path = path.clone();
                path.push(child.get_name().into());
                visit(child.clone(), path);
            }
        }
        visit(Cli::command(), vec!["finx".into()]);
    }

    #[test]
    fn deferred_arguments_keep_global_options_and_conflicts() {
        let cli = Cli::try_parse_from([
            "finx", "-c", "thinking=low", "exec", "hello", "-m", "mock/bench",
            "--mcp-config", "tools.json", "--permission-mode", "manual",
        ]).unwrap();
        assert_eq!(cli.overrides, ["thinking=low"]);
        assert_eq!(cli.mcp_config, [PathBuf::from("tools.json")]);
        assert!(matches!(cli.command, Command::Exec { run, .. } if run.model.as_deref() == Some("mock/bench")));
        let error = Cli::try_parse_from(["finx", "exec", "hello", "--no-save", "--continue"])
            .err().expect("conflicting arguments");
        assert_eq!(error.kind(), ErrorKind::ArgumentConflict);
        let cli = Cli::try_parse_from(["finx", "mcp", "get", "example", "-c", "thinking=low"]).unwrap();
        assert_eq!(cli.overrides, ["thinking=low"]);
        assert!(matches!(cli.command, Command::Mcp { command: McpCommand::Get { name, .. } } if name == "example"));
    }
}
