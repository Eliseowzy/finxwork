//! Layered configuration: defaults < user file < project file < command-line overrides.

use finx_llm::ThinkingLevel;
use finx_protocol::CommandRule;
use finx_protocol::McpExposure;
use finx_protocol::McpServerConfig;
use finx_protocol::PermissionMode;
use std::collections::BTreeMap;
use finx_tools::OutputLimits;
use serde::Deserialize;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

pub const DEFAULT_MODEL: &str = "deepseek/deepseek-flash";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigFile {
    pub model: Option<String>,
    pub thinking: Option<ThinkingLevel>,
    #[serde(alias = "approval_mode")]
    pub permission_mode: Option<PermissionMode>,
    pub max_turns: Option<u32>,
    pub extra_writable_roots: Option<Vec<PathBuf>>,
    pub system_prompt_file: Option<PathBuf>,
    pub instructions: Option<InstructionsFile>,
    pub tools: Option<ToolsFile>,
    pub compaction: Option<CompactionFile>,
    pub llm: Option<LlmFile>,
    pub rules: Option<Vec<CommandRule>>,
    pub server: Option<ServerFile>,
    pub acp: Option<AcpFile>,
    pub agents: Option<AgentsFile>,
    pub skills: Option<SkillsFile>,
    pub mcp: Option<McpFile>,
    pub models: Option<ModelsFile>,
    /// `[mcp_servers.<name>]`, by name.
    pub mcp_servers: Option<BTreeMap<String, McpServerConfig>>,
}

/// `[mcp]`: settings for every MCP server.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpFile {
    pub enabled: Option<bool>,
    /// Read `.mcp.json` at the root of a trusted project.
    pub project_json: Option<bool>,
    /// How long the first request waits for servers whose tools go into the tool list.
    pub startup_wait_secs: Option<u64>,
    /// Default exposure of servers that do not set one.
    pub exposure: Option<McpExposure>,
}

/// `[models]`: model lists and the public catalog (docs/kernel/model-catalog-design.md §11).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelsFile {
    /// `false`: no background refresh of the catalog and the lists.
    pub network: Option<bool>,
}

/// `[agents]`: sub-agents (`spawn_agent`, `send_message`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentsFile {
    pub enabled: Option<bool>,
}

/// `[skills]` (docs/kernel/skill-design.md §10).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkillsFile {
    pub enabled: Option<bool>,
    pub dirs: Option<Vec<String>>,
    pub paths: Option<Vec<String>>,
    pub disabled: Option<Vec<String>>,
    pub max_catalog_tokens: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct SkillsSettings {
    /// Look for skills and list them in the system prompt.
    pub enabled: bool,
    /// Directories holding a `skills` folder, looked for in every layer in this order.
    pub dirs: Vec<String>,
    /// Further skill roots, skill directories or `SKILL.md` files, after the user layer.
    /// `~/` is the home directory; other relative paths are relative to the working
    /// directory, except in a project's own file, where they are relative to the project.
    pub paths: Vec<String>,
    /// Skill names, or paths of skill directories or `SKILL.md` files.
    pub disabled: Vec<String>,
    /// Catalog budget in tokens; 0 for 2% of the context window, at most 10,000.
    pub max_catalog_tokens: u64,
}

impl Default for SkillsSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            dirs: [".finx", ".agents", ".claude"].map(String::from).to_vec(),
            paths: Vec::new(),
            disabled: Vec::new(),
            max_catalog_tokens: 0,
        }
    }
}

/// `[server]`: the protocol service (`finx serve`, `finx acp`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerFile {
    pub max_frame_bytes: Option<u64>,
    pub queue_hard_bytes: Option<u64>,
    pub max_sessions: Option<usize>,
    pub idle_session_secs: Option<u64>,
    pub history_limit: Option<u32>,
}

/// `[acp]`: the ACP projection.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcpFile {
    pub progress_interval_ms: Option<u64>,
    pub progress_tail_bytes: Option<usize>,
    pub delegate_fs: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct ServerSettings {
    pub max_frame_bytes: usize,
    pub queue_hard_bytes: usize,
    pub max_sessions: usize,
    /// 0 keeps idle sessions loaded.
    pub idle_session_secs: u64,
    pub history_limit: u32,
}

#[derive(Debug, Clone)]
pub struct AcpSettings {
    pub progress_interval: Duration,
    pub progress_tail_bytes: usize,
    pub delegate_fs: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstructionsFile {
    pub files: Option<Vec<String>>,
    pub extra: Option<String>,
    pub project_root_markers: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolsFile {
    pub enabled: Option<Vec<String>>,
    pub bash: Option<BashFile>,
    pub limits: Option<LimitsFile>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BashFile {
    pub default_timeout_secs: Option<u64>,
    pub max_timeout_secs: Option<u64>,
    pub shell: Option<String>,
    pub pass_provider_keys: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LimitsFile {
    pub max_lines: Option<usize>,
    pub max_bytes: Option<usize>,
    pub max_saved_bytes: Option<u64>,
    pub max_parallel: Option<usize>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompactionFile {
    pub enabled: Option<bool>,
    pub threshold: Option<f64>,
    pub token_limit: Option<u64>,
    pub keep_user_tokens: Option<u64>,
    pub keep_skill_tokens: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LlmFile {
    pub max_retries: Option<u32>,
    pub connect_timeout_secs: Option<u64>,
    pub idle_timeout_secs: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct CompactionSettings {
    /// Compact automatically; manual compaction works either way.
    pub enabled: bool,
    /// Soft limit as a share of the usable window (the window minus the reply's room).
    pub threshold: f64,
    /// Absolute cap on the soft limit, 0 for none.
    pub token_limit: u64,
    /// Budget for the user messages kept word for word, before the 15% cap.
    pub keep_user_tokens: u64,
    /// Budget for the instructions of skills in use, before the 10% cap.
    pub keep_skill_tokens: u64,
}

#[derive(Debug, Clone)]
pub struct McpSettings {
    pub enabled: bool,
    pub project_json: bool,
    pub startup_wait: Duration,
    pub exposure: McpExposure,
}

/// Resolved configuration with every default applied.
#[derive(Debug, Clone)]
pub struct Config {
    pub model: String,
    pub thinking: ThinkingLevel,
    pub permission_mode: PermissionMode,
    pub max_turns: u32,
    pub extra_writable_roots: Vec<PathBuf>,
    pub system_prompt_file: Option<PathBuf>,
    pub instruction_files: Vec<String>,
    pub instructions_extra: String,
    pub project_root_markers: Vec<String>,
    pub enabled_tools: Vec<String>,
    pub bash_default_timeout: Duration,
    pub bash_max_timeout: Duration,
    pub bash_shell: Option<String>,
    pub pass_provider_keys: bool,
    pub limits: OutputLimits,
    pub max_parallel_tools: usize,
    pub compaction: CompactionSettings,
    pub llm_max_retries: u32,
    pub llm_connect_timeout: Duration,
    pub llm_idle_timeout: Duration,
    pub rules: Vec<CommandRule>,
    pub server: ServerSettings,
    pub acp: AcpSettings,
    /// Whether the main agent gets the sub-agent tools.
    pub agents_enabled: bool,
    pub skills: SkillsSettings,
    pub mcp: McpSettings,
    /// Refresh model lists and the public catalog in the background (`[models] network`).
    pub models_network: bool,
    /// The configured servers by name, names filled in; not yet validated.
    pub mcp_servers: Vec<McpServerConfig>,
}

impl Default for Config {
    fn default() -> Self {
        Self::from_file(ConfigFile::default()).expect("defaults are valid")
    }
}

impl Config {
    pub fn from_file(file: ConfigFile) -> Result<Self, ConfigError> {
        let instructions = file.instructions.unwrap_or_default();
        let tools = file.tools.unwrap_or_default();
        let bash = tools.bash.unwrap_or_default();
        let limits_file = tools.limits.unwrap_or_default();
        let compaction = file.compaction.unwrap_or_default();
        let llm = file.llm.unwrap_or_default();
        let server = file.server.unwrap_or_default();
        let acp = file.acp.unwrap_or_default();
        let skills_file = file.skills.unwrap_or_default();
        let mut skills = SkillsSettings::default();
        if let Some(dirs) = skills_file.dirs {
            let not_a_name =
                |d: &&String| d.is_empty() || matches!(d.as_str(), "." | "..") || crate::skills::is_path(d);
            if let Some(bad) = dirs.iter().find(not_a_name) {
                return Err(ConfigError::Invalid(format!(
                    "skills.dirs takes directory names such as \".agents\", got \"{bad}\""
                )));
            }
            skills.dirs = dirs;
        }
        skills.enabled = skills_file.enabled.unwrap_or(skills.enabled);
        skills.paths = skills_file.paths.unwrap_or_default();
        skills.disabled = skills_file.disabled.unwrap_or_default();
        skills.max_catalog_tokens = skills_file.max_catalog_tokens.unwrap_or(0);
        let mcp = file.mcp.unwrap_or_default();
        let threshold = compaction.threshold.unwrap_or(0.9);
        if !(0.1..=1.0).contains(&threshold) {
            return Err(ConfigError::Invalid(format!(
                "compaction.threshold must be between 0.1 and 1.0, got {threshold}"
            )));
        }
        let mut limits = OutputLimits::default();
        if let Some(v) = limits_file.max_lines {
            limits.max_lines = v.max(1);
        }
        if let Some(v) = limits_file.max_bytes {
            // A smaller limit also shrinks the command output's head and tail to fit.
            limits = limits.capped(v);
            limits.max_bytes = v.max(1024);
        }
        if let Some(v) = limits_file.max_saved_bytes {
            limits.max_saved_bytes = v.max(1024);
        }
        let bash_max = Duration::from_secs(bash.max_timeout_secs.unwrap_or(600).max(1));
        Ok(Self {
            model: file.model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            thinking: file.thinking.unwrap_or_default(),
            permission_mode: file.permission_mode.unwrap_or_default(),
            max_turns: file.max_turns.unwrap_or(0),
            extra_writable_roots: file.extra_writable_roots.unwrap_or_default(),
            system_prompt_file: file.system_prompt_file,
            instruction_files: instructions.files.unwrap_or_else(|| vec!["AGENTS.md".to_string()]),
            instructions_extra: instructions.extra.unwrap_or_default(),
            project_root_markers: instructions
                .project_root_markers
                .unwrap_or_else(|| vec![".git".to_string()]),
            enabled_tools: tools
                .enabled
                .unwrap_or_else(|| finx_tools::DEFAULT_TOOLS.iter().map(|s| s.to_string()).collect()),
            bash_default_timeout: Duration::from_secs(bash.default_timeout_secs.unwrap_or(120).max(1)).min(bash_max),
            bash_max_timeout: bash_max,
            bash_shell: bash.shell,
            pass_provider_keys: bash.pass_provider_keys.unwrap_or(false),
            limits,
            max_parallel_tools: limits_file.max_parallel.unwrap_or(8).max(1),
            compaction: CompactionSettings {
                enabled: compaction.enabled.unwrap_or(true),
                threshold,
                token_limit: compaction.token_limit.unwrap_or(0),
                keep_user_tokens: compaction.keep_user_tokens.unwrap_or(20_000),
                keep_skill_tokens: compaction.keep_skill_tokens.unwrap_or(20_000),
            },
            llm_max_retries: llm.max_retries.unwrap_or(4),
            llm_connect_timeout: Duration::from_secs(llm.connect_timeout_secs.unwrap_or(10).max(1)),
            llm_idle_timeout: Duration::from_secs(llm.idle_timeout_secs.unwrap_or(300).max(5)),
            rules: file.rules.unwrap_or_default(),
            server: ServerSettings {
                max_frame_bytes: server.max_frame_bytes.unwrap_or(32 << 20).max(64 << 10) as usize,
                queue_hard_bytes: server.queue_hard_bytes.unwrap_or(16 << 20).max(64 << 10) as usize,
                max_sessions: server.max_sessions.unwrap_or(1000).max(1),
                idle_session_secs: server.idle_session_secs.unwrap_or(900),
                history_limit: server.history_limit.unwrap_or(100).clamp(1, 1000),
            },
            acp: AcpSettings {
                progress_interval: Duration::from_millis(acp.progress_interval_ms.unwrap_or(100)),
                progress_tail_bytes: acp.progress_tail_bytes.unwrap_or(16 << 10).max(256),
                delegate_fs: acp.delegate_fs.unwrap_or(false),
            },
            agents_enabled: file.agents.and_then(|a| a.enabled).unwrap_or(true),
            skills,
            mcp: McpSettings {
                enabled: mcp.enabled.unwrap_or(true),
                project_json: mcp.project_json.unwrap_or(false),
                startup_wait: Duration::from_secs(mcp.startup_wait_secs.unwrap_or(10)),
                exposure: mcp.exposure.unwrap_or_default(),
            },
            models_network: file.models.and_then(|m| m.network).unwrap_or(true),
            mcp_servers: file
                .mcp_servers
                .unwrap_or_default()
                .into_iter()
                .map(|(name, mut server)| {
                    server.name = name;
                    server
                })
                .collect(),
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("failed to read {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("invalid config {path}: {message}")]
    Parse { path: String, message: String },
    #[error("invalid config: {0}")]
    Invalid(String),
}

pub struct LoadedConfig {
    pub config: Config,
    pub warnings: Vec<String>,
    pub sources: Vec<PathBuf>,
    /// The layers that define each MCP server, in order: "user config", "project config", "-c".
    pub mcp_sources: BTreeMap<String, Vec<String>>,
}

/// Loads and merges the configuration layers. Settings that loosen security are dropped
/// from an untrusted project's file.
pub fn load(
    user_file: &Path,
    project_file: Option<&Path>,
    project_trusted: bool,
    overrides: &[String],
) -> Result<LoadedConfig, ConfigError> {
    let mut merged = toml::Table::new();
    let mut warnings = Vec::new();
    let mut sources = Vec::new();
    let mut mcp_sources = BTreeMap::new();
    if user_file.exists() {
        let mut table = read_table(user_file)?;
        migrate_legacy(&mut table, &user_file.display().to_string(), &mut warnings);
        note_mcp_servers(&table, "user config", &mut mcp_sources);
        merge_tables(&mut merged, table);
        sources.push(user_file.to_path_buf());
    }
    if let Some(project_file) = project_file
        && project_file.exists()
    {
        let mut table = read_table(project_file)?;
        // Where models come from is the user's to say, trusted project or not.
        if table.remove("models").is_some() {
            warnings.push(format!("ignored [models] in {}: it can only be set in the user config", project_file.display()));
        }
        if !project_trusted {
            let removed = strip_untrusted(&mut table);
            if !removed.is_empty() {
                warnings.push(format!(
                    "ignored {} in {} because the project is not trusted (run `finx trust` to allow them)",
                    removed.join(", "),
                    project_file.display()
                ));
            }
        }
        migrate_legacy(&mut table, &project_file.display().to_string(), &mut warnings);
        // `<project>/.finx/config.toml`
        if let Some(project_root) = project_file.parent().and_then(Path::parent) {
            anchor_skill_paths(&mut table, project_root);
        }
        note_mcp_servers(&table, "project config", &mut mcp_sources);
        merge_tables(&mut merged, table);
        sources.push(project_file.to_path_buf());
    }
    for item in overrides {
        let mut table = parse_override(item)?;
        migrate_legacy(&mut table, &format!("-c {item}"), &mut warnings);
        note_mcp_servers(&table, "-c", &mut mcp_sources);
        merge_tables(&mut merged, table);
    }
    let file: ConfigFile = toml::Value::Table(merged)
        .try_into()
        .map_err(|e: toml::de::Error| ConfigError::Parse {
            path: "merged configuration".into(),
            message: e.to_string(),
        })?;
    Ok(LoadedConfig {
        config: Config::from_file(file)?,
        warnings,
        sources,
        mcp_sources,
    })
}

/// Records that `layer` defines (part of) each MCP server in `table`.
fn note_mcp_servers(table: &toml::Table, layer: &str, sources: &mut BTreeMap<String, Vec<String>>) {
    if let Some(toml::Value::Table(servers)) = table.get("mcp_servers") {
        for name in servers.keys() {
            let layers = sources.entry(name.clone()).or_default();
            if !layers.iter().any(|l| l == layer) {
                layers.push(layer.to_string());
            }
        }
    }
}

fn read_table(path: &Path) -> Result<toml::Table, ConfigError> {
    let text = std::fs::read_to_string(path).map_err(|source| ConfigError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let parse_error = |e: toml::de::Error| ConfigError::Parse {
        path: path.display().to_string(),
        message: e.to_string(),
    };
    // Validate against the schema first so errors point at the right file and line.
    toml::from_str::<ConfigFile>(&text).map_err(parse_error)?;
    toml::from_str::<toml::Table>(&text).map_err(parse_error)
}

fn merge_tables(base: &mut toml::Table, over: toml::Table) {
    for (key, value) in over {
        match (base.get_mut(&key), value) {
            (Some(toml::Value::Table(existing)), toml::Value::Table(incoming)) => merge_tables(existing, incoming),
            (Some(toml::Value::Array(existing)), toml::Value::Array(incoming)) if key == "rules" => {
                existing.extend(incoming)
            }
            (_, value) => {
                base.insert(key, value);
            }
        }
    }
}

/// Renames settings from before the permission modes were renamed, with a warning.
fn migrate_legacy(table: &mut toml::Table, source: &str, warnings: &mut Vec<String>) {
    if let Some(value) = table.remove("approval_mode") {
        warnings.push(format!("`approval_mode` is now called `permission_mode` ({source})"));
        table.entry("permission_mode").or_insert(value);
    }
    if let Some(toml::Value::String(name)) = table.get_mut("permission_mode")
        && let Some(mode) = PermissionMode::from_legacy(name)
    {
        warnings.push(format!("permission mode '{name}' is now called '{mode}' ({source})"));
        *name = mode.to_string();
    }
}

/// Makes relative paths in a project's `skills.paths` and `skills.disabled` relative to the
/// project, before the layers are merged and their origin is lost.
fn anchor_skill_paths(table: &mut toml::Table, project_root: &Path) {
    let Some(toml::Value::Table(skills)) = table.get_mut("skills") else {
        return;
    };
    for key in ["paths", "disabled"] {
        let Some(toml::Value::Array(items)) = skills.get_mut(key) else {
            continue;
        };
        for item in items {
            if let toml::Value::String(path) = item
                && (key == "paths" || crate::skills::is_path(path))
                && !path.starts_with('~')
                && Path::new(path.as_str()).is_relative()
            {
                *path = project_root.join(path.as_str()).display().to_string();
            }
        }
    }
}

fn strip_untrusted(table: &mut toml::Table) -> Vec<String> {
    let mut removed = Vec::new();
    for key in ["permission_mode", "approval_mode", "extra_writable_roots", "system_prompt_file"] {
        if table.remove(key).is_some() {
            removed.push(key.to_string());
        }
    }
    if let Some(toml::Value::Table(tools)) = table.get_mut("tools")
        && tools.remove("bash").is_some()
    {
        removed.push("tools.bash".to_string());
    }
    // A project may turn sub-agents off, not on.
    if let Some(toml::Value::Table(agents)) = table.get_mut("agents")
        && agents.get("enabled").and_then(toml::Value::as_bool) == Some(true)
    {
        agents.remove("enabled");
        removed.push("agents.enabled".to_string());
    }
    // A server in the project runs code on this machine as soon as a session starts.
    if let Some(toml::Value::Table(servers)) = table.remove("mcp_servers") {
        let names: Vec<String> = servers.keys().cloned().collect();
        removed.push(format!("mcp_servers ({})", names.join(", ")));
    }
    if let Some(toml::Value::Table(mcp)) = table.get_mut("mcp")
        && mcp.remove("project_json").is_some()
    {
        removed.push("mcp.project_json".to_string());
    }
    if let Some(toml::Value::Array(rules)) = table.get_mut("rules") {
        let before = rules.len();
        rules.retain(|rule| rule.get("decision").and_then(toml::Value::as_str) != Some("allow"));
        if rules.len() != before {
            removed.push("allow rules".to_string());
        }
    }
    removed
}

fn parse_override(item: &str) -> Result<toml::Table, ConfigError> {
    let (key, value) = item
        .split_once('=')
        .ok_or_else(|| ConfigError::Invalid(format!("override '{item}' must look like key=value")))?;
    let (key, value) = (key.trim(), value.trim());
    toml::from_str::<toml::Table>(&format!("{key} = {value}"))
        .or_else(|_| {
            let quoted = toml::Value::String(value.to_string()).to_string();
            toml::from_str::<toml::Table>(&format!("{key} = {quoted}"))
        })
        .map_err(|e| ConfigError::Invalid(format!("override '{item}': {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sensible() {
        let config = Config::default();
        assert_eq!(config.model, DEFAULT_MODEL);
        assert_eq!(config.permission_mode, PermissionMode::Manual);
        assert_eq!(config.enabled_tools, vec!["read", "write", "edit", "bash"]);
        assert_eq!(config.bash_default_timeout, Duration::from_secs(120));
    }

    #[test]
    fn layers_merge_and_untrusted_projects_are_restricted() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("user.toml");
        let project = dir.path().join("project.toml");
        std::fs::write(
            &user,
            "model = \"deepseek/deepseek-v4-pro\"\n[[rules]]\nprefix = [\"git\", \"push\"]\ndecision = \"ask\"\n",
        )
        .unwrap();
        std::fs::write(
            &project,
            "thinking = \"low\"\napproval_mode = \"full-auto\"\n[tools.bash]\nshell = \"/bin/evil\"\n\
             [[rules]]\nprefix = [\"rm\"]\ndecision = \"allow\"\n[[rules]]\nprefix = [\"curl\"]\ndecision = \"deny\"\n",
        )
        .unwrap();
        let loaded = load(&user, Some(&project), false, &["max_turns=7".into(), "tools.enabled=[\"read\"]".into()]).unwrap();
        let config = loaded.config;
        assert_eq!(config.model, "deepseek/deepseek-v4-pro");
        assert_eq!(config.thinking, ThinkingLevel::Low);
        assert_eq!(config.permission_mode, PermissionMode::Manual, "untrusted project cannot loosen approvals");
        assert_eq!(config.bash_shell, None);
        assert_eq!(config.max_turns, 7);
        assert_eq!(config.enabled_tools, vec!["read"]);
        let prefixes: Vec<String> = config.rules.iter().map(|r| r.prefix.join(" ")).collect();
        assert_eq!(prefixes, vec!["git push", "curl"]);
        assert_eq!(loaded.warnings.len(), 1);

        let trusted = load(&user, Some(&project), true, &[]).unwrap();
        assert_eq!(trusted.config.permission_mode, PermissionMode::BypassPermissions);
        assert_eq!(
            trusted.warnings,
            vec![
                format!("`approval_mode` is now called `permission_mode` ({})", project.display()),
                format!(
                    "permission mode 'full-auto' is now called 'bypass-permissions' ({})",
                    project.display()
                ),
            ]
        );
    }

    #[test]
    fn untrusted_projects_cannot_add_mcp_servers() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("user.toml");
        let project = dir.path().join("project.toml");
        std::fs::write(&user, "[mcp_servers.github]\ncommand = \"gh-mcp\"\n").unwrap();
        std::fs::write(
            &project,
            "[mcp]\nproject_json = true\n[mcp_servers.evil]\ncommand = \"./run-me\"\n[mcp_servers.github]\nenabled = false\n",
        )
        .unwrap();
        let overrides = ["mcp_servers.docs.url=\"https://mcp.example.com/mcp\"".to_string()];
        let loaded = load(&user, Some(&project), false, &overrides).unwrap();
        let names: Vec<&str> = loaded.config.mcp_servers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["docs", "github"]);
        assert!(loaded.config.mcp_servers.iter().all(|s| s.is_enabled()));
        assert!(!loaded.config.mcp.project_json);
        let warning = &loaded.warnings[0];
        assert!(warning.contains("mcp_servers (evil, github)") && warning.contains("mcp.project_json"), "{warning}");
        assert_eq!(loaded.mcp_sources["github"], vec!["user config"]);
        assert_eq!(loaded.mcp_sources["docs"], vec!["-c"]);

        let trusted = load(&user, Some(&project), true, &[]).unwrap();
        let github = trusted.config.mcp_servers.iter().find(|s| s.name == "github").unwrap();
        assert!(!github.is_enabled(), "a trusted project can turn a server off");
        assert_eq!(trusted.mcp_sources["github"], vec!["user config", "project config"]);
        assert!(trusted.config.mcp.project_json);
    }

    #[test]
    fn permission_mode_names() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("config.toml");
        std::fs::write(&user, "permission_mode = \"accept-edits\"\n").unwrap();
        let loaded = load(&user, None, false, &[]).unwrap();
        assert_eq!(loaded.config.permission_mode, PermissionMode::AcceptEdits);
        assert!(loaded.warnings.is_empty());

        let legacy = load(&user, None, false, &["approval_mode=ask".into()]).unwrap();
        assert_eq!(legacy.config.permission_mode, PermissionMode::Manual);
        assert_eq!(legacy.warnings.len(), 2, "{:?}", legacy.warnings);

        std::fs::write(&user, "permission_mode = \"plan\"\n").unwrap();
        let err = load(&user, None, false, &[]).err().unwrap().to_string();
        assert!(err.contains("not available yet") && err.contains("config.toml"), "{err}");
        std::fs::write(&user, "permission_mode = \"manual\"\napproval_mode = \"ask\"\n").unwrap();
        assert!(load(&user, None, false, &[]).is_err(), "both names at once");
    }

    #[test]
    fn unknown_keys_are_errors_with_location() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("config.toml");
        std::fs::write(&user, "modle = \"x\"\n").unwrap();
        let err = load(&user, None, false, &[]).err().unwrap();
        let text = err.to_string();
        assert!(text.contains("modle"), "{text}");
        assert!(text.contains("config.toml"), "{text}");
    }

    #[test]
    fn skills_settings_and_project_relative_paths() {
        let defaults = Config::default().skills;
        assert!(defaults.enabled);
        assert_eq!(defaults.dirs, vec![".finx", ".agents", ".claude"]);
        assert_eq!(defaults.max_catalog_tokens, 0);

        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("config.toml");
        std::fs::write(&user, "[skills]\npaths = [\"~/team\", \"rel\"]\nmax_catalog_tokens = 3000\n").unwrap();
        let project_root = dir.path().join("repo");
        std::fs::create_dir_all(project_root.join(".finx")).unwrap();
        let project = project_root.join(".finx/config.toml");
        std::fs::write(
            &project,
            "[skills]\npaths = [\"tools/skills\", \"/abs\", \"~/x\"]\ndisabled = [\"deploy\", \"vendor/skills/old\"]\n",
        )
        .unwrap();
        let skills = load(&user, Some(&project), false, &[]).unwrap().config.skills;
        // Arrays replace each other; the project's relative paths now name the project.
        assert_eq!(
            skills.paths,
            vec![project_root.join("tools/skills").display().to_string(), "/abs".into(), "~/x".into()]
        );
        assert_eq!(
            skills.disabled,
            vec!["deploy".to_string(), project_root.join("vendor/skills/old").display().to_string()]
        );
        assert_eq!(skills.max_catalog_tokens, 3000);
        let user_only = load(&user, None, false, &["skills.enabled=false".into()]).unwrap().config.skills;
        assert_eq!(user_only.paths, vec!["~/team", "rel"], "left for the working directory");
        assert!(!user_only.enabled);

        for bad in ["\"skills/x\"", "\"..\"", "\"\""] {
            std::fs::write(&user, format!("[skills]\ndirs = [{bad}]\n")).unwrap();
            let err = load(&user, None, false, &[]).err().unwrap().to_string();
            assert!(err.contains("skills.dirs"), "{bad}: {err}");
        }
    }

    #[test]
    fn string_overrides_need_no_quotes() {
        let loaded = load(Path::new("/nonexistent"), None, false, &["model=deepseek/deepseek-flash".into()]).unwrap();
        assert_eq!(loaded.config.model, "deepseek/deepseek-flash");
    }
}
