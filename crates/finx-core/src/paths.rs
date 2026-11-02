//! Layout of the data directory (`~/.finx`, or `FINX_HOME`).

use std::io;
use std::path::Path;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct FinxHome {
    root: PathBuf,
    user_home: Option<PathBuf>,
}

impl FinxHome {
    /// A data directory without a user home: skills come only from the project and `root`.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            user_home: None,
        }
    }

    /// The user's home directory, where `~/.agents/skills` and the like are looked for.
    pub fn with_user_home(mut self, dir: impl Into<PathBuf>) -> Self {
        self.user_home = Some(dir.into());
        self
    }

    /// `FINX_HOME`, or `~/.finx`; the user home is the home directory.
    pub fn from_env() -> io::Result<Self> {
        let user_home = dirs::home_dir();
        let home = match std::env::var("FINX_HOME") {
            Ok(value) if !value.trim().is_empty() => Self::new(value),
            _ => user_home
                .as_ref()
                .map(|home| Self::new(home.join(".finx")))
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "cannot find the home directory; set FINX_HOME"))?,
        };
        Ok(Self { user_home, ..home })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn user_home(&self) -> Option<&Path> {
        self.user_home.as_deref()
    }

    pub fn config_file(&self) -> PathBuf {
        self.root.join("config.toml")
    }

    pub fn models_file(&self) -> PathBuf {
        self.root.join("models.toml")
    }

    /// Model list and catalog caches, and the model menu selection.
    pub fn models_dir(&self) -> PathBuf {
        self.root.join("models")
    }

    pub fn agents_md(&self) -> PathBuf {
        self.root.join("AGENTS.md")
    }

    /// The user's own skills, the `.finx` entry of the user layer.
    pub fn skills_dir(&self) -> PathBuf {
        self.root.join("skills")
    }

    pub fn trusted_file(&self) -> PathBuf {
        self.root.join("trusted.toml")
    }

    /// `projects/`: the user's own settings for each project (docs/desktop/customize-design.md §4.3).
    pub fn projects_dir(&self) -> PathBuf {
        self.root.join("projects")
    }

    /// The user's own configuration for the project at `project_dir` (canonical), only theirs
    /// and only there: `projects/<key>/config.toml`.
    pub fn user_project_config(&self, project_dir: &Path) -> PathBuf {
        self.projects_dir().join(project_key(project_dir)).join("config.toml")
    }

    /// `skills/.system`: the skills built into finx, written there on first use.
    pub fn system_skills_dir(&self) -> PathBuf {
        self.skills_dir().join(".system")
    }

    /// `browser`: the managed browser's profiles, temporary profiles and downloads.
    pub fn browser_dir(&self) -> PathBuf {
        self.root.join("browser")
    }

    /// The icons of the sites the browsers may open (browser-design §10.1).
    pub fn site_icons_dir(&self) -> PathBuf {
        self.browser_dir().join("icons")
    }

    /// `mcp/cache`: each MCP server's last connection and tool list.
    pub fn mcp_cache_dir(&self) -> PathBuf {
        self.root.join("mcp").join("cache")
    }

    /// Each MCP service's logo (mcp-design §13.9).
    pub fn mcp_icons_dir(&self) -> PathBuf {
        finx_mcp::icon::dir(&self.root)
    }

    pub fn sessions_dir(&self) -> PathBuf {
        self.root.join("sessions")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    /// The working folders of sessions started without a project, one each.
    pub fn chats_dir(&self) -> PathBuf {
        self.root.join("chats")
    }

    /// Creates an empty working folder for a session without a project.
    pub fn new_chat_dir(&self) -> io::Result<PathBuf> {
        let dir = self.chats_dir().join(uuid::Uuid::now_v7().to_string());
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// Whether `cwd` (canonical, as sessions keep it) is one of those folders, or the folder
    /// that holds them: a session there has no project.
    pub fn is_chat_dir(&self, cwd: &Path) -> bool {
        let chats = self.chats_dir();
        let chats = std::fs::canonicalize(&chats).unwrap_or(chats);
        cwd == chats || cwd.parent() == Some(chats.as_path())
    }


    /// Files that belong to a session (the full output of cut tool results) live next to its
    /// log, in a directory of the same name, and share its lifetime. A session without a log
    /// file gets a temporary directory instead; the flag says so.
    pub fn session_data_dir(log: &Path, session_id: &str) -> (PathBuf, bool) {
        if log.extension().is_some_and(|e| e == "jsonl") {
            (log.with_extension(""), false)
        } else {
            (std::env::temp_dir().join(format!("finx-{session_id}")), true)
        }
    }

    /// Creates the data directory with owner-only permissions.
    pub fn ensure(&self) -> io::Result<()> {
        std::fs::create_dir_all(self.sessions_dir())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.root, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }
}

/// `<name>-<8 hex digits>`: the directory's name, made safe and at most 40 characters, and the
/// start of the SHA-256 of its full path, so two projects of the same name stay apart.
pub fn project_key(project_dir: &Path) -> String {
    let name: String = project_dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' })
        .take(40)
        .collect();
    let name = name.trim_matches(['-', '.']);
    let digest = ring::digest::digest(&ring::digest::SHA256, project_dir.as_os_str().as_encoded_bytes());
    let hex: String = digest.as_ref()[..4].iter().map(|b| format!("{b:02x}")).collect();
    if name.is_empty() { format!("project-{hex}") } else { format!("{name}-{hex}") }
}
