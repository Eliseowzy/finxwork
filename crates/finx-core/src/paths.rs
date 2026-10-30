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

    pub fn sessions_dir(&self) -> PathBuf {
        self.root.join("sessions")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
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
