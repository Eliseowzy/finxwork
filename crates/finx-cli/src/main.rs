//! `finx`: command-line front end of the kernel.

mod approval_prompt;
#[cfg(test)]
mod cli_shape;
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
use clap::CommandFactory;
use clap::FromArgMatches;
use clap::Parser;
use clap::Subcommand;
use finx_llm::ThinkingLevel;
use finx_protocol::PermissionMode;
use std::path::PathBuf;
use std::process::ExitCode;

/// The top-level help, by what the commands are for. `cli_shape` keeps it in step with them.
const TOP_LEVEL_HELP: &str = "\
{about-with-newline}
{usage-heading} {usage}

Run tasks:
  exec      Run a task without an interactive interface
  sessions  List recent sessions of this project

Models:
  models    List the models in the model menu

Tools and extensions:
  mcp       List, add and remove MCP servers
  skills    List the skills a session here would offer
  browser   Set up the browser the agent uses

Setup:
  status    Show the effective configuration
  doctor    Check configuration, credentials and directories
  trust     Trust a project's own configuration

For other programs:
  serve     Serve JSON-RPC on stdio or a Unix socket
  acp       Serve ACP on stdio, for editors such as Zed
  protocol  Describe the native protocol

Options:
{options}

Examples:
  finx exec \"fix the failing test\"
  finx exec --json \"summarize the changes\" | jq -r .final_output
  finx exec --resume last \"now update the changelog\"
  finx models
  finx doctor

Run `finx <command> --help` for a command's options.
";

#[derive(Parser)]
#[command(
    name = "finx",
    version,
    about = "finx: an agent kernel for software tasks",
    help_template = TOP_LEVEL_HELP,
    disable_version_flag = true,
    // The last one wins, so that a wrapper or an alias can set a flag and the command line can
    // still change it. Clap applies this to every subcommand.
    args_override_self = true
)]
struct Cli {
    /// Override a configuration value, e.g. -c thinking=low (repeatable)
    #[arg(short = 'c', long = "config", global = true, value_name = "KEY=VALUE")]
    overrides: Vec<String>,

    /// Add the MCP servers of a file in the .mcp.json format (repeatable)
    #[arg(long = "mcp-config", global = true, value_name = "FILE")]
    mcp_config: Vec<PathBuf>,

    /// Print version
    #[arg(short = 'V', short_alias = 'v', long, action = clap::ArgAction::Version)]
    version: Option<bool>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
// Build arguments only for the selected command; help still expands its own command.
#[command(defer = true)]
enum Command {
    /// The document worker `finx serve` starts: PDFium, one request a line on stdin
    #[command(hide = true)]
    DocWorker,
    /// Run a managed connector's internal tool adapter
    #[command(hide = true)]
    Connector {
        #[command(subcommand)]
        command: ConnectorCommand,
    },
    /// Chat with a model directly, without tools (checks the model setup)
    #[command(hide = true)]
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
        /// Continue a session: `last` (of this project) or a session id or a unique part of one
        #[arg(long, value_name = "last|ID", conflicts_with = "cwd")]
        resume: Option<String>,
        /// Do not keep a session log
        #[arg(long, conflicts_with = "resume")]
        no_save: bool,
        #[command(flatten)]
        run: RunArgs,
    },
    /// List recent sessions of this project
    #[command(args_conflicts_with_subcommands = true)]
    Sessions {
        #[command(flatten)]
        list: SessionsArgs,
        #[command(subcommand)]
        action: Option<SessionsAction>,
    },
    /// List the models in the model menu
    ///
    /// By provider. `hide` and `unhide` change the menu.
    #[command(args_conflicts_with_subcommands = true)]
    Models {
        #[command(flatten)]
        list: ModelsArgs,
        #[command(subcommand)]
        action: Option<ModelsAction>,
    },
    /// Show the effective configuration
    ///
    /// Model, provider, credentials and directories.
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
    /// List the skills a session here would offer
    ///
    /// `add`, `remove`, `enable` and `disable` change them.
    #[command(args_conflicts_with_subcommands = true)]
    Skills {
        #[command(flatten)]
        list: SkillsArgs,
        #[command(subcommand)]
        action: Option<SkillsAction>,
    },
    /// Set up the browser the agent uses
    Browser {
        #[command(subcommand)]
        command: BrowserCommand,
    },
    /// Trust a project's own configuration
    ///
    /// Its .finx/config.toml may then change security settings.
    Trust {
        /// Project directory (default: the current directory)
        dir: Option<PathBuf>,
    },
    /// List, add and remove MCP servers
    #[command(args_conflicts_with_subcommands = true)]
    Mcp {
        #[command(flatten)]
        list: McpListArgs,
        #[command(subcommand)]
        command: Option<McpCommand>,
    },
    /// Serve JSON-RPC on stdio or a Unix socket
    ///
    /// The native protocol, for programs that drive finx.
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
    /// Serve ACP on stdio, for editors such as Zed
    ///
    /// The Agent Client Protocol.
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
    Status {
        /// Print JSON
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
#[command(defer = true)]
enum McpCommand {
    /// List the servers: name, transport, exposure and where each is configured
    List(McpListArgs),
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
        /// In your own configuration, ~/.finx/config.toml (the default)
        #[arg(long, overrides_with_all = ["local", "project"])]
        global: bool,
        /// Only for you, only in this project (your personal project settings)
        #[arg(long, overrides_with_all = ["global", "project"])]
        local: bool,
        /// In the project's .finx/config.toml, for everyone who uses the repository
        #[arg(long, overrides_with_all = ["global", "local"])]
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
        /// In your own configuration (the default)
        #[arg(long, overrides_with = "local")]
        global: bool,
        /// Only for you, only in this project
        #[arg(long, overrides_with = "global")]
        local: bool,
    },
    /// Turn a server off; a server of the repository is turned off for you alone
    Disable {
        name: String,
        /// In your own configuration (the default)
        #[arg(long, overrides_with = "local")]
        global: bool,
        /// Only for you, only in this project
        #[arg(long, overrides_with = "global")]
        local: bool,
    },
}

// What `finx mcp` and `finx mcp list` show. (A doc comment here would become their description.)
#[derive(Args, Clone)]
struct McpListArgs {
    /// Connect to every server and list its tools
    #[arg(long)]
    check: bool,
    /// Print JSON
    #[arg(long)]
    json: bool,
}

#[derive(Subcommand)]
#[command(defer = true)]
enum SessionsAction {
    /// List recent sessions of this project
    List(SessionsArgs),
}

// What `finx sessions` and `finx sessions list` show.
#[derive(Args, Clone)]
struct SessionsArgs {
    /// Sessions of every project
    #[arg(long)]
    all: bool,
    #[arg(long, default_value_t = 20)]
    limit: usize,
    /// Print JSON
    #[arg(long)]
    json: bool,
}

// What `finx models` and `finx models list` show.
#[derive(Args, Clone)]
pub(crate) struct ModelsArgs {
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
}

// What `finx skills` and `finx skills list` show.
#[derive(Args, Clone)]
struct SkillsArgs {
    /// Directory (default: the current directory)
    dir: Option<PathBuf>,
    /// Also list skills that are shadowed, disabled or failed to load
    #[arg(long)]
    all: bool,
    /// Print JSON
    #[arg(long)]
    json: bool,
}

#[derive(Subcommand)]
#[command(defer = true)]
enum SkillsAction {
    /// List the skills a session here would offer
    List(SkillsArgs),
    /// Copy a skill (a folder with SKILL.md, or a .zip or .skill archive) into ~/.finx/skills
    Add {
        path: PathBuf,
        /// Into ~/.finx/skills (the default)
        #[arg(long, overrides_with = "project")]
        global: bool,
        /// Into the project's .agents/skills instead
        #[arg(long, overrides_with = "global")]
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
    /// List the models in the model menu
    List(ModelsArgs),
    /// Sign in with ChatGPT to use subscription models (no API key)
    Login { #[arg(value_parser = ["chatgpt-api"])] connection: String },
    /// Disconnect and revoke the ChatGPT subscription connection
    Logout { #[arg(value_parser = ["chatgpt-api"])] connection: String },
    /// Forget a signed-out ChatGPT registration so another account can be connected
    Forget { #[arg(value_parser = ["chatgpt-api"])] connection: String },
    /// Show ChatGPT connection status, without credentials
    Status { #[arg(value_parser = ["chatgpt-api"])] connection: String },
    /// Put a model back in the model menu
    Unhide {
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
    #[arg(long, alias = "approval", value_name = "MODE", value_parser = parse_permission_mode, overrides_with = "dangerously_skip_permissions")]
    pub permission_mode: Option<ModeArg>,
    /// Same as --permission-mode bypass-permissions: every action runs without asking,
    /// including changes to .git and shell profiles. Use only in an isolated environment
    #[arg(long, overrides_with = "permission_mode")]
    pub dangerously_skip_permissions: bool,
    /// text: the reply as it streams; json: one result object at the end; stream-json: events
    /// as JSON lines
    #[arg(long, value_enum, default_value_t = OutputFormat::Text, overrides_with = "json")]
    pub output: OutputFormat,
    /// Same as --output json
    #[arg(long, overrides_with = "output")]
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
        if self.json { OutputFormat::Json } else { self.output }
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
            resume,
            no_save,
            run,
        } => match resume {
            Some(session) => cmd_exec::resume(overrides, &session, &prompt, &run).await,
            None => cmd_exec::exec(overrides, &prompt, cwd, !no_save, &run).await,
        },
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
            ExtensionCommand::Status { json } => cmd_browser::status(json),
        },
        // Only `--check` gets here; a plain listing runs without the async runtime.
        Command::Mcp { list, command: None }
        | Command::Mcp { command: Some(McpCommand::List(list)), .. } => cmd_mcp::check(overrides, list.json).await,
        Command::Mcp {
            command: Some(McpCommand::Add { name, url, headers, env, secret_env, token, local, project, force, no_login, command, .. }),
            ..
        } => {
            cmd_customize::mcp_add(cmd_customize::AddArgs { name, url, headers, env, secret_env, token, local, project, command, force, no_login })
                .await
        }
        Command::Mcp {
            command: Some(McpCommand::Login { name }),
            ..
        } => cmd_customize::mcp_login(&name).await,
        Command::Mcp {
            command: Some(McpCommand::Remove { name, project }),
            ..
        } => cmd_customize::mcp_remove(&name, project).await,
        Command::Mcp {
            command: Some(McpCommand::Logout { name }),
            ..
        } => cmd_customize::mcp_logout(&name).await,
        Command::Sessions { .. }
        | Command::Models { .. }
        | Command::Status { .. }
        | Command::Doctor { .. }
        | Command::Skills { .. }
        | Command::Trust { .. }
        | Command::Mcp { .. }
        | Command::Protocol { .. }
        | Command::DocWorker => {
            unreachable!("local commands run without the async runtime")
        }
    }
}

fn run_async(overrides: &[String], command: Command) -> anyhow::Result<u8> {
    // A foreground command is driven by the calling thread. Its asynchronous tools and
    // sub-agents still make progress together; filesystem work uses the blocking pool.
    // The service runs many clients' sessions on a worker per available CPU. Other commands,
    // `finx acp` among them, serve one client: four workers are plenty, and each idle worker
    // costs its stack and queues.
    let mut builder = match command {
        Command::Exec { .. } | Command::Chat { .. } => {
            tokio::runtime::Builder::new_current_thread()
        }
        _ => {
            let limit = if matches!(command, Command::Serve { .. }) { 16 } else { 4 };
            let workers = std::thread::available_parallelism().map_or(4, |n| n.get().min(limit));
            let mut builder = tokio::runtime::Builder::new_multi_thread();
            builder.worker_threads(workers);
            builder
        }
    };
    if !matches!(command, Command::Serve { .. }) {
        // The I/O driver reserves this many events up front (48 bytes each on macOS). One
        // client's sockets and pipes never have a thousand ready at once.
        builder.max_io_events_per_tick(256);
    }
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

/// Parses a command line that names no global option, or returns None for `Cli::parse` to do it.
///
/// When its parser is built, clap copies each global option into every subcommand: about 40 KiB
/// of fresh memory on each launch. A command line that names none has no use for the copies, and
/// a parser without them reads it the same way. The help and the errors come from the full
/// parser, because they list the global options.
fn parse_plain(args: &[std::ffi::OsString]) -> Option<Cli> {
    let plain = args.iter().skip(1).all(|arg| {
        let arg = arg.as_encoded_bytes();
        !(arg.starts_with(b"-c") || arg.starts_with(b"--config") || arg.starts_with(b"--mcp-config"))
            && ![&b"-h"[..], b"--help", b"help", b"-V", b"-v", b"--version"].contains(&arg)
    });
    if !plain {
        return None;
    }
    let mut matches = parser_without_global_options().try_get_matches_from(args).ok()?;
    Cli::from_arg_matches_mut(&mut matches).ok()
}

fn parser_without_global_options() -> clap::Command {
    Cli::command()
        .mut_arg("overrides", |arg| arg.global(false))
        .mut_arg("mcp_config", |arg| arg.global(false))
}

/// Whether a command line asks for JSON. Its failures are then JSON too, on stdout.
fn wants_json(args: &[std::ffi::OsString]) -> bool {
    let mut words = args.iter().skip(1).map(|arg| arg.to_string_lossy()).take_while(|word| word != "--").peekable();
    while let Some(word) = words.next() {
        if ["--json", "--output=json", "--output=stream-json"].contains(&word.as_ref()) {
            return true;
        }
        if word == "--output" && words.peek().is_some_and(|value| value == "json" || value == "stream-json") {
            return true;
        }
    }
    false
}

/// A failure as JSON: the fields of the result object of `finx exec --json`.
fn print_failure(kind: &str, message: &str, help: Option<&str>) {
    let mut error = serde_json::json!({ "kind": kind, "message": message });
    if let Some(help) = help {
        error["help"] = help.into();
    }
    println!("{}", serde_json::json!({ "error": error, "exit_code": 2 }));
}

/// What to write instead of a spelling from another tool or from before a rename.
fn pointer(args: &[std::ffi::OsString]) -> Option<&'static str> {
    let words: Vec<_> = args.iter().skip(1).map(|arg| arg.to_string_lossy()).take_while(|word| word != "--").collect();
    let words: Vec<&str> = words.iter().map(|word| word.as_ref()).collect();
    let has = |names: &[&str]| words.iter().any(|word| names.contains(word));
    if words.first() == Some(&"resume") || has(&["--continue", "-r"]) || (words.first() != Some(&"exec") && has(&["--resume"])) {
        return Some("To continue a session: finx exec --resume <last|ID> \"PROMPT\"");
    }
    if has(&["-p", "--print"]) {
        return Some("To run one task: finx exec \"PROMPT\"");
    }
    if words.starts_with(&["models", "show"]) {
        return Some("`finx models unhide MODEL` puts a model back in the menu; `finx models` lists them");
    }
    None
}

/// A command line clap did not take. Help and the version go out as usual; a mistake says what to
/// write instead.
fn usage_error(err: clap::Error, args: &[std::ffi::OsString]) -> ExitCode {
    if !err.use_stderr() {
        let _ = err.print();
        return ExitCode::SUCCESS;
    }
    let hint = pointer(args);
    if wants_json(args) {
        let text = err.render().to_string();
        print_failure("usage_error", text.trim().trim_start_matches("error: "), hint);
    } else {
        let _ = err.print();
        if let Some(hint) = hint {
            eprintln!("\n{hint}");
        }
    }
    ExitCode::from(2)
}

fn main() -> ExitCode {
    // When the reader goes away (`finx sessions | head`), stop quietly like other Unix tools
    // instead of panicking on the failed write.
    #[cfg(unix)]
    // SAFETY: restoring the default disposition of SIGPIPE before any thread is started.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    let args: Vec<_> = std::env::args_os().collect();
    let parsed = parse_plain(&args).map_or_else(|| Cli::try_parse_from(&args), Ok);
    let Cli {
        overrides,
        mcp_config,
        command,
        ..
    } = match parsed {
        Ok(cli) => cli,
        Err(err) => return usage_error(err, &args),
    };
    let result = setup::load_mcp_config(&mcp_config).and_then(|()| match command {
        // Local commands skip the async runtime: starting it costs more than they do.
        Command::Sessions { list, action: None } | Command::Sessions { action: Some(SessionsAction::List(list)), .. } => {
            cmd_info::sessions(list.all, list.limit, list.json)
        }
        Command::Models { list, action: None } | Command::Models { action: Some(ModelsAction::List(list)), .. } => {
            cmd_info::models(&overrides, list.provider.as_deref(), list.all, list.refresh, list.json, None)
        }
        Command::Models { action, .. } => cmd_info::models(&overrides, None, false, false, false, action),
        Command::Status { json } => cmd_info::status(&overrides, json),
        Command::Doctor { json } => cmd_info::doctor(&overrides, json),
        Command::Skills { list, action: None } | Command::Skills { action: Some(SkillsAction::List(list)), .. } => {
            cmd_info::skills(&overrides, list.dir, list.all, list.json)
        }
        Command::Skills { action: Some(action), .. } => match action {
            SkillsAction::List(_) => unreachable!("handled above"),
            SkillsAction::Add { path, project, replace, .. } => cmd_customize::skills_add(&path, project, replace),
            SkillsAction::Remove { skill } => cmd_customize::skills_remove(&skill),
            SkillsAction::Enable { skill } => cmd_customize::skills_switch(&skill, true),
            SkillsAction::Disable { skill } => cmd_customize::skills_switch(&skill, false),
        },
        Command::Trust { dir } => cmd_info::trust(dir),
        Command::Mcp { list, command: None } | Command::Mcp { command: Some(McpCommand::List(list)), .. } if !list.check => {
            cmd_mcp::list(&overrides, list.json)
        }
        Command::Mcp {
            command: Some(McpCommand::Get { name, json }),
            ..
        } => cmd_mcp::get(&overrides, &name, json),
        Command::Mcp {
            command: Some(McpCommand::Enable { name, local, .. }),
            ..
        } => cmd_customize::mcp_switch(&name, true, local),
        Command::Mcp {
            command: Some(McpCommand::Disable { name, local, .. }),
            ..
        } => cmd_customize::mcp_switch(&name, false, local),
        Command::Protocol {
            command: ProtocolCommand::Schema,
        } => cmd_serve::schema(),
        Command::DocWorker => {
            finx_docs::engine::serve(std::io::stdin().lock(), std::io::stdout().lock())?;
            Ok(0)
        }
        command => run_async(&overrides, command),
    });
    match result {
        Ok(code) => ExitCode::from(code),
        Err(err) => {
            if wants_json(&args) {
                match err.downcast_ref::<setup::NoModel>() {
                    Some(no_model) => print_failure("no_model", "no model is set up", Some(&no_model.help)),
                    None => print_failure("error", &format!("{err:#}"), None),
                }
            } else {
                eprintln!("error: {err:#}");
            }
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod parsing_tests {
    use super::*;
    use clap::error::ErrorKind;

    fn os(args: &[&str]) -> Vec<std::ffi::OsString> {
        args.iter().map(Into::into).collect()
    }

    /// What a parser made of a command line, level by level, apart from the global options
    /// (the full parser leaves its copies of them behind).
    fn understood(mut matches: &clap::ArgMatches) -> String {
        let mut out = String::new();
        loop {
            let mut ids: Vec<_> = matches.ids().map(|id| id.as_str()).filter(|id| !["overrides", "mcp_config"].contains(id)).collect();
            ids.sort_unstable();
            for id in ids {
                out.push_str(&format!("{id}={:?} ", matches.get_raw(id).map(Iterator::collect::<Vec<_>>)));
            }
            let Some((name, sub)) = matches.subcommand() else { return out };
            out.push_str(&format!("[{name}] "));
            matches = sub;
        }
    }

    #[test]
    fn a_command_line_without_global_options_parses_the_same_without_them() {
        let lines: &[&[&str]] = &[
            &["finx", "status"],
            &["finx", "status", "--json"],
            &["finx", "doctor", "--json"],
            &["finx", "sessions", "--all", "--limit", "3", "--json"],
            &["finx", "models", "--provider", "deepseek", "--json"],
            &["finx", "models", "unhide", "deepseek/deepseek-flash"],
            &["finx", "models", "list", "--json"],
            &["finx", "sessions", "list", "--all"],
            &["finx", "skills", "list", "--json"],
            &["finx", "mcp"],
            &["finx", "mcp", "--json"],
            &["finx", "skills", "--all"],
            &["finx", "skills", "disable", "pdf"],
            &["finx", "trust", "/tmp/project"],
            &["finx", "exec", "hello"],
            &["finx", "exec", "hello", "-m", "mock/bench", "--permission-mode", "manual", "--no-save"],
            &["finx", "exec", "--resume", "last", "next"],
            &["finx", "exec", "hello", "-m", "a/b", "-m", "c/d", "--json", "--output", "text"],
            &["finx", "chat", "hello", "--thinking", "low"],
            &["finx", "serve", "--listen", "unix://", "--idle-exit", "30"],
            &["finx", "acp"],
            &["finx", "doc-worker"],
            &["finx", "mcp", "list", "--json"],
            &["finx", "mcp", "add", "tools", "--", "npx", "--yes", "tools"],
            &["finx", "browser", "native-host", "chrome-extension://abc/", "--parent-window=0"],
        ];
        for line in lines {
            assert!(parse_plain(&os(line)).is_some(), "{line:?}");
            let full = Cli::command().try_get_matches_from(*line).unwrap();
            let plain = parser_without_global_options().try_get_matches_from(*line).unwrap();
            assert_eq!(understood(&plain), understood(&full), "{line:?}");
        }
    }

    #[test]
    fn everything_else_goes_to_the_full_parser() {
        let lines: &[&[&str]] = &[
            // Global options, wherever they stand and however they are spelled.
            &["finx", "-c", "thinking=low", "status"],
            &["finx", "status", "-c", "thinking=low"],
            &["finx", "status", "-cthinking=low"],
            &["finx", "status", "--config=thinking=low"],
            &["finx", "exec", "hello", "--mcp-config", "tools.json"],
            // A word that only looks like one: the full parser sorts it out, as it always did.
            &["finx", "mcp", "add", "tools", "--", "sh", "-c", "serve"],
            // Help and version.
            &["finx", "--help"],
            &["finx", "-h"],
            &["finx", "status", "--help"],
            &["finx", "help", "status"],
            &["finx", "--version"],
            &["finx", "-V"],
            &["finx", "-v"],
            // Mistakes: their messages list the global options.
            &["finx"],
            &["finx", "no-such-command"],
            &["finx", "status", "--no-such-option"],
            &["finx", "exec"],
            &["finx", "exec", "hello", "--no-save", "--resume", "last"],
        ];
        for line in lines {
            assert!(parse_plain(&os(line)).is_none(), "{line:?}");
        }
    }

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
        let error = Cli::try_parse_from(["finx", "exec", "hello", "--no-save", "--resume", "last"])
            .err().expect("conflicting arguments");
        assert_eq!(error.kind(), ErrorKind::ArgumentConflict);
        let cli = Cli::try_parse_from(["finx", "mcp", "get", "example", "-c", "thinking=low"]).unwrap();
        assert_eq!(cli.overrides, ["thinking=low"]);
        assert!(matches!(cli.command, Command::Mcp { command: Some(McpCommand::Get { name, .. }), .. } if name == "example"));
    }
}
