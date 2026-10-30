//! Per-directory set-up shared by the command line and the server: project root, trust,
//! layered configuration, the model registry and the dependencies of a kernel.

use finx_llm::Catalog;
use finx_llm::CatalogError;
use finx_llm::ModelRegistry;
use finx_llm::RegistryOptions;
use finx_llm::RetryPolicy;
use finx_llm::Timeouts;
use finx_protocol::McpServerConfig;
use finx_tools::BashTool;
use finx_tools::LocalEnvironment;
use finx_tools::RegistryError;
use finx_tools::ToolRegistry;
use finx_tools::builtin_registry;
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

use crate::config;
use crate::config::Config;
use crate::config::ConfigError;
use crate::instructions;
use crate::kernel::KernelDeps;
use crate::mcp;
use crate::paths::FinxHome;
use crate::store::SessionStore;

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("working directory {path} not found: {source}")]
    Cwd {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Catalog(#[from] CatalogError),
    #[error(transparent)]
    Tools(#[from] RegistryError),
}

/// A working directory with its project, trust state and configuration resolved.
#[derive(Debug, Clone)]
pub struct Workspace {
    /// Canonical.
    pub cwd: PathBuf,
    pub project_root: Option<PathBuf>,
    pub trusted: bool,
    pub config: Config,
    pub warnings: Vec<String>,
    /// MCP servers from the configuration (and `.mcp.json` when enabled), validated.
    /// Disabled ones are kept, so they can be listed; sessions do not start them.
    pub mcp_servers: Vec<McpServerConfig>,
    /// Where each server is defined: configuration layers, or ".mcp.json".
    pub mcp_sources: BTreeMap<String, Vec<String>>,
}

impl Workspace {
    /// `overrides` are `key=value` settings that beat both configuration files.
    pub fn open(home: &FinxHome, cwd: &Path, overrides: &[String]) -> Result<Self, RuntimeError> {
        let cwd = std::fs::canonicalize(cwd).map_err(|source| RuntimeError::Cwd {
            path: cwd.to_path_buf(),
            source,
        })?;
        // A session without a project has its own folder, whatever lies around it.
        let project_root = if home.is_chat_dir(&cwd) {
            None
        } else {
            instructions::find_project_root(&cwd, &[".git".to_string()])
        };
        let project_dir = project_root.clone().unwrap_or_else(|| cwd.clone());
        let trusted = instructions::is_trusted(home, &project_dir);
        let project_config = project_dir.join(".finx").join("config.toml");
        let loaded = config::load(&home.config_file(), Some(&project_config), trusted, overrides)?;
        let mut warnings = loaded.warnings;
        let config = loaded.config;
        let mut mcp_sources = loaded.mcp_sources;
        let mcp_servers = if config.mcp.enabled {
            let project_json = project_mcp_json(&config, &project_dir, trusted, &mut warnings);
            // `.mcp.json` only adds servers the configuration does not name.
            for server in &project_json {
                mcp_sources.entry(server.name.clone()).or_insert_with(|| vec![".mcp.json".to_string()]);
            }
            let (servers, problems) = mcp::merge_servers(&config.mcp_servers, project_json, &[]);
            warnings.extend(problems);
            servers
        } else {
            Vec::new()
        };
        Ok(Self {
            cwd,
            project_root,
            trusted,
            config,
            warnings,
            mcp_servers,
            mcp_sources,
        })
    }

    /// The servers of a session: this workspace's, then `extra` (from the command line or a
    /// client), which replace servers of the same name.
    pub fn mcp_servers_with(&self, extra: &[McpServerConfig]) -> (Vec<McpServerConfig>, Vec<String>) {
        if !self.config.mcp.enabled {
            return (Vec::new(), Vec::new());
        }
        mcp::merge_servers(&self.mcp_servers, Vec::new(), extra)
    }

    /// Dependencies for a session in this workspace, with its MCP servers.
    pub fn kernel_deps(
        &self,
        llm: Arc<ModelRegistry>,
        store: Arc<dyn SessionStore>,
        extra_roots: &[PathBuf],
    ) -> Result<KernelDeps, RuntimeError> {
        let mut deps = kernel_deps(&self.config, &self.cwd, self.project_root.as_deref(), llm, store, extra_roots)?;
        deps.mcp_servers = self.mcp_servers.clone();
        Ok(deps)
    }
}

/// `.mcp.json` at the project root, when `mcp.project_json` is on and the project trusted.
fn project_mcp_json(config: &Config, project_dir: &Path, trusted: bool, warnings: &mut Vec<String>) -> Vec<McpServerConfig> {
    let path = project_dir.join(".mcp.json");
    if !config.mcp.project_json || !path.is_file() {
        return Vec::new();
    }
    if !trusted {
        warnings.push(format!(
            "ignored {} because the project is not trusted (run `finx trust` to allow it)",
            path.display()
        ));
        return Vec::new();
    }
    match std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|text| mcp::parse_mcp_json(&text, &path)) {
        Ok((servers, problems)) => {
            warnings.extend(problems);
            servers
        }
        Err(err) => {
            warnings.push(format!("ignored {}: {err}", path.display()));
            Vec::new()
        }
    }
}

/// Built-in tools enabled by `config`, a local environment rooted at the project, and `store`.
pub fn kernel_deps(
    config: &Config,
    cwd: &Path,
    project_root: Option<&Path>,
    llm: Arc<ModelRegistry>,
    store: Arc<dyn SessionStore>,
    extra_roots: &[PathBuf],
) -> Result<KernelDeps, RuntimeError> {
    let tools = shared_tools(config)?;
    let mut roots = vec![project_root.unwrap_or(cwd).to_path_buf()];
    roots.extend(config.extra_writable_roots.iter().cloned());
    roots.extend(extra_roots.iter().cloned());
    let scrubbed = if config.pass_provider_keys {
        Vec::new()
    } else {
        llm.key_env_vars()
    };
    let mut env = LocalEnvironment::new(cwd.to_path_buf())
        .with_roots(roots)
        .with_scrubbed_env(scrubbed);
    if let Some(shell) = &config.bash_shell {
        env = env.with_shell(shell.clone());
    }
    Ok(KernelDeps {
        llm,
        tools,
        env: Arc::new(env),
        store,
        hooks: Vec::new(),
        mcp_servers: Vec::new(),
    })
}

/// Key of a built-in tool set: the enabled tools and the bash timeouts.
type ToolsKey = (Vec<String>, Duration, Duration);

/// Built-in tools hold no session state, so sessions with the same settings share one
/// registry, including its tool definitions.
fn shared_tools(config: &Config) -> Result<Arc<ToolRegistry>, RuntimeError> {
    static CACHE: OnceLock<Mutex<HashMap<ToolsKey, Arc<ToolRegistry>>>> = OnceLock::new();
    let key = (config.enabled_tools.clone(), config.bash_default_timeout, config.bash_max_timeout);
    let cache = CACHE.get_or_init(Default::default);
    if let Some(tools) = cache.lock().get(&key) {
        return Ok(tools.clone());
    }
    let all = builtin_registry(BashTool {
        default_timeout: config.bash_default_timeout,
        max_timeout: config.bash_max_timeout,
    });
    let tools = Arc::new(all.subset(&config.enabled_tools)?);
    cache.lock().insert(key, tools.clone());
    Ok(tools)
}

/// The built-in catalog merged with `models.toml`, with the timeouts and retries of `config`.
pub fn model_registry(home: &FinxHome, config: &Config) -> Result<ModelRegistry, RuntimeError> {
    let catalog = Catalog::load(Some(&home.models_file()))?;
    let options = RegistryOptions {
        timeouts: Timeouts {
            connect: config.llm_connect_timeout,
            first_byte: Duration::from_secs(60),
            idle: config.llm_idle_timeout,
        },
        retry: RetryPolicy {
            max_retries: config.llm_max_retries,
            ..Default::default()
        },
        user_agent: None,
        models_dir: Some(home.models_dir()),
    };
    Ok(ModelRegistry::new(catalog, options))
}
