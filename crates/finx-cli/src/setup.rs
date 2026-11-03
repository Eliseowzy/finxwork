//! Shared start-up: data directory, logging, configuration, model registry, tools.

use anyhow::Context as _;
use finx_core::Config;
use finx_core::FinxHome;
use finx_core::JsonlStore;
use finx_core::MemoryStore;
use finx_core::KernelDeps;
use finx_core::SessionStore;
use finx_core::Workspace;
use finx_core::instructions;
use finx_core::runtime;
use finx_llm::ModelRegistry;
use finx_protocol::McpServerConfig;
use finx_protocol::PermissionMode;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::EnvFilter;

pub struct Runtime {
    pub home: FinxHome,
    pub config: Config,
    pub llm: Arc<ModelRegistry>,
    pub connections: Arc<finx_connections::Manager>,
    pub cwd: PathBuf,
    pub project_root: Option<PathBuf>,
    pub trusted: bool,
    pub warnings: Vec<String>,
    /// Settings taken from FINX_MODEL and FINX_PERMISSION_MODE, as `key=value`.
    pub env_overrides: Vec<String>,
    /// MCP servers of a session here: the configured ones, then `--mcp-config`. Disabled ones
    /// are kept for listing; sessions do not start them.
    pub mcp_servers: Vec<McpServerConfig>,
    /// Where each MCP server is defined.
    pub mcp_sources: BTreeMap<String, Vec<String>>,
    _log_guard: Option<WorkerGuard>,
}

/// The servers of the `--mcp-config` files, read once at start-up.
#[derive(Default)]
pub struct McpConfigFiles {
    pub servers: Vec<McpServerConfig>,
    /// The file each server came from.
    pub sources: BTreeMap<String, String>,
    pub warnings: Vec<String>,
}

static MCP_CONFIG_FILES: OnceLock<McpConfigFiles> = OnceLock::new();

/// Reads the `--mcp-config` files (the `.mcp.json` format) in order; a later file replaces
/// servers of the same name.
pub fn load_mcp_config(paths: &[PathBuf]) -> anyhow::Result<()> {
    let mut files = McpConfigFiles::default();
    for path in paths {
        let text = std::fs::read_to_string(path).with_context(|| format!("cannot read --mcp-config {}", path.display()))?;
        let (servers, warnings) =
            finx_core::mcp::parse_mcp_json(&text, path).map_err(|e| anyhow::anyhow!("--mcp-config {e}"))?;
        for server in servers {
            files.sources.insert(server.name.clone(), format!("--mcp-config {}", path.display()));
            files.servers.push(server);
        }
        files.warnings.extend(warnings);
    }
    let _ = MCP_CONFIG_FILES.set(files);
    Ok(())
}

pub fn mcp_config_files() -> &'static McpConfigFiles {
    MCP_CONFIG_FILES.get_or_init(McpConfigFiles::default)
}

pub fn home() -> anyhow::Result<FinxHome> {
    let home = FinxHome::from_env()?;
    home.ensure()
        .with_context(|| format!("cannot create {}", home.root().display()))?;
    // Saved keys come after the configuration and the environment (models.toml stays the way
    // to configure them; `auth/set` adds to it).
    if let Some(store) = finx_llm::credentials::default_store(home.root().join("credentials.toml")) {
        finx_llm::credentials::install(store);
    }
    Ok(home)
}

/// Whether a command writes the log file. Commands that only show local information skip it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Logging {
    On,
    Off,
}

pub fn init(cwd: PathBuf, overrides: &[String], logging: Logging) -> anyhow::Result<Runtime> {
    let home = home()?;
    let log_guard = if logging == Logging::On { init_logging(&home) } else { None };
    // Environment variables beat the config files; `-c` beats them.
    let mut warnings = Vec::new();
    let env_overrides = env_overrides(&mut warnings)?;
    let all: Vec<String> = env_overrides.iter().chain(overrides).cloned().collect();
    let workspace = Workspace::open(&home, &cwd, &all)?;
    warnings.extend(workspace.warnings.iter().cloned());
    let files = mcp_config_files();
    warnings.extend(files.warnings.iter().cloned());
    let (mcp_servers, problems) = workspace.mcp_servers_with(&files.servers);
    warnings.extend(problems);
    let mut mcp_sources = workspace.mcp_sources;
    for (name, source) in &files.sources {
        mcp_sources.insert(name.clone(), vec![source.clone()]);
    }
    let llm = Arc::new(runtime::model_registry(&home, &workspace.config)?);
    let connections = finx_connections::Manager::new(home.root().to_path_buf(), &llm);
    tracing::info!(cwd = %workspace.cwd.display(), project_root = ?workspace.project_root, trusted = workspace.trusted, "finx started");
    Ok(Runtime {
        home,
        config: workspace.config,
        llm,
        connections,
        cwd: workspace.cwd,
        project_root: workspace.project_root,
        trusted: workspace.trusted,
        warnings,
        env_overrides,
        mcp_servers,
        mcp_sources,
        _log_guard: log_guard,
    })
}

/// FINX_MODEL and FINX_PERMISSION_MODE as `key=value` overrides. FINX_APPROVAL is the old
/// name of FINX_PERMISSION_MODE.
pub fn env_overrides(warnings: &mut Vec<String>) -> anyhow::Result<Vec<String>> {
    let var = |name: &str| {
        let value = std::env::var(name).ok()?;
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    };
    let mut overrides = Vec::new();
    if let Some(model) = var("FINX_MODEL") {
        overrides.push(format!("model={model}"));
    }
    let mode = match (var("FINX_PERMISSION_MODE"), var("FINX_APPROVAL")) {
        (Some(mode), _) => Some(("FINX_PERMISSION_MODE", mode)),
        (None, Some(mode)) => {
            warnings.push("FINX_APPROVAL is now called FINX_PERMISSION_MODE".to_string());
            Some(("FINX_APPROVAL", mode))
        }
        (None, None) => None,
    };
    if let Some((name, value)) = mode {
        let (mode, notice) = PermissionMode::parse_with_notice(&value).map_err(|err| anyhow::anyhow!("{name}: {err}"))?;
        warnings.extend(notice.map(|notice| format!("{name}: {notice}")));
        overrides.push(format!("permission_mode={mode}"));
    }
    Ok(overrides)
}

/// The project that `dir` belongs to (its git checkout), or `dir` itself. Sessions are
/// listed and continued per workspace.
pub fn workspace(dir: &Path) -> PathBuf {
    let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    instructions::find_project_root(&dir, &[".git".to_string()]).unwrap_or(dir)
}

impl Runtime {
    /// `save: false` keeps the session log in memory only.
    pub fn kernel_deps(&self, save: bool) -> anyhow::Result<KernelDeps> {
        let store: Arc<dyn SessionStore> = if save {
            Arc::new(JsonlStore::new(self.home.sessions_dir()))
        } else {
            Arc::new(MemoryStore::new())
        };
        let mut deps = runtime::kernel_deps(&self.config, &self.cwd, self.project_root.as_deref(), self.llm.clone(), store, &[])?;
        deps.mcp_servers = self.mcp_servers.clone();
        // `finx exec` runs one session: its own pool, without a window unless configured.
        if self.config.browser.configured_on() {
            deps.browser_pool = Some(Arc::new(finx_core::BrowserPool::new(self.home.browser_dir(), false)));
        }
        Ok(deps)
    }
}

/// Logs go to `~/.finx/logs/finx.YYYY-MM-DD.log`, never to the terminal. Filter with `FINX_LOG`.
pub fn init_logging(home: &FinxHome) -> Option<WorkerGuard> {
    std::fs::create_dir_all(home.logs_dir()).ok()?;
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("finx")
        .filename_suffix("log")
        .max_log_files(7)
        .build(home.logs_dir())
        .ok()?;
    // Every buffered line is a slot reserved at start-up (4096 took 144 KiB, a quarter of an
    // idle process's heap). In a week of real use the busiest second logged 38 lines, and the
    // writer thread drains the queue as lines arrive.
    let (writer, guard) = tracing_appender::non_blocking::NonBlockingBuilder::default()
        .buffered_lines_limit(256)
        .finish(appender);
    let fmt = tracing_subscriber::fmt().with_writer(writer).with_ansi(false);
    // Parsing filter directives costs more than the rest of this; the default needs none.
    let installed = match std::env::var_os("FINX_LOG") {
        Some(_) => fmt
            .with_env_filter(EnvFilter::try_from_env("FINX_LOG").unwrap_or_else(|_| EnvFilter::new("info")))
            .try_init(),
        None => fmt.with_max_level(tracing::Level::INFO).try_init(),
    };
    installed.ok()?;
    Some(guard)
}

/// The prompt argument; "-" reads it from stdin.
pub fn read_prompt(arg: &str) -> anyhow::Result<String> {
    let text = if arg == "-" {
        std::io::read_to_string(std::io::stdin()).context("cannot read the prompt from stdin")?
    } else {
        arg.to_string()
    };
    let text = text.trim().to_string();
    anyhow::ensure!(!text.is_empty(), "the prompt is empty");
    Ok(text)
}
