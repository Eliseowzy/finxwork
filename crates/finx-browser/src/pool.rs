//! One browser process per profile, shared by the sessions of this process (browser-design
//! §6.1). The pool keeps only weak references: the browser closes when its last session lets
//! go, and the next `acquire` waits for that close to finish before starting another.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::sync::watch;

use crate::BrowserError;
use crate::cdp::Conn;
use crate::launch::LaunchOptions;
use crate::launch::Launcher;
use crate::launch::ManagedLauncher;
use crate::launch::ProfileLock;
use crate::router::Router;

/// How long `Browser.close` may take before the process is killed.
const CLOSE_GRACE: Duration = Duration::from_secs(5);
/// How long `acquire` waits for the previous browser on a profile to exit.
const CLOSE_WAIT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Headless {
    /// Without a window for `finx exec` and where there is no display.
    #[default]
    Auto,
    On,
    Off,
}

/// Which browser a session gets (§8.3.3).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Backend {
    /// The desktop app's embedded browser while one is connected, else the managed one.
    #[default]
    Auto,
    Embedded,
    Managed,
    /// The user's own Chrome through the finx extension (§8.4); only when configured.
    Extension,
}

/// The `[browser]` settings that decide which browser a session gets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserConfig {
    pub backend: Backend,
    pub executable: Option<PathBuf>,
    pub profile: String,
    pub headless: Headless,
}

impl Default for BrowserConfig {
    fn default() -> Self {
        Self {
            backend: Backend::Auto,
            executable: None,
            profile: "default".into(),
            headless: Headless::Auto,
        }
    }
}

/// Both ends of a CDP byte stream.
pub type Stream = (Box<dyn AsyncRead + Send + Unpin>, Box<dyn AsyncWrite + Send + Unpin>);

/// A desktop app that shows embedded browsers (§8.3.1), or the finx extension in the user's
/// Chrome (§8.4). Each `connect` is a new browser: a CDP stream to the host, which acts as
/// the browser end.
pub trait EmbeddedHost: Send + Sync + 'static {
    /// Tells hosts apart: a host that replaced another gets its own browser.
    fn id(&self) -> u64;
    fn connect(&self) -> Result<Stream, BrowserError>;
}

const NO_HOST: &str = "No desktop app is connected to show the embedded browser. Open FinxWork, \
    or set browser.backend = \"managed\" in ~/.finx/config.toml to use a separate browser window.";

/// Said in the first result of every session on the user's Chrome.
const EXTENSION_NOTE: &str = "This browser is the user's own Chrome: the tabs you open appear in their window, \
    in a tab group named FinxWork, and their sign-ins are real. Act as carefully as with their accounts.";

const NO_EXTENSION: &str = "The FinxWork extension is not connected, so the user's Chrome cannot be used. \
    Ask the user to open Chrome with the FinxWork extension (after running `finx browser extension install` once), \
    or to set browser.backend = \"managed\" in ~/.finx/config.toml.";

pub struct BrowserPool {
    /// `~/.finx/browser`.
    root: PathBuf,
    /// What `Headless::Auto` means in this process.
    auto_headless: bool,
    launcher: Arc<dyn Launcher>,
    /// The desktop app connected to this process, if any.
    host: Mutex<Option<Arc<dyn EmbeddedHost>>>,
    /// The finx extension in the user's Chrome, if connected.
    extension: Mutex<Option<Arc<dyn EmbeddedHost>>>,
    inner: Arc<PoolInner>,
}

#[derive(Default)]
struct PoolInner {
    browsers: Mutex<HashMap<String, Weak<Browser>>>,
    /// One start at a time per profile.
    starting: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Set while a profile's previous browser is closing; true once it has.
    closing: Mutex<HashMap<String, watch::Receiver<bool>>>,
}

impl BrowserPool {
    /// `interactive`: a person may watch, so `Headless::Auto` shows a window when there is a
    /// display. `finx exec` passes false.
    pub fn new(root: PathBuf, interactive: bool) -> Self {
        Self::with_launcher(root, interactive && has_display(), Arc::new(ManagedLauncher))
    }

    pub fn with_launcher(root: PathBuf, auto_headless_off: bool, launcher: Arc<dyn Launcher>) -> Self {
        Self {
            root,
            auto_headless: !auto_headless_off,
            launcher,
            host: Mutex::new(None),
            extension: Mutex::new(None),
            inner: Arc::default(),
        }
    }

    /// The desktop app that shows embedded browsers from now on; `None` when it left. A
    /// browser on a host that left is dead (its stream ended), so its sessions start over.
    pub fn set_host(&self, host: Option<Arc<dyn EmbeddedHost>>) {
        *self.host.lock() = host;
    }

    /// Clears the host only if it is still `id`: a newer one may have replaced it.
    pub fn remove_host(&self, id: u64) {
        let mut host = self.host.lock();
        if host.as_ref().is_some_and(|h| h.id() == id) {
            *host = None;
        }
    }

    pub fn has_host(&self) -> bool {
        self.host.lock().is_some()
    }

    /// The finx extension that lends the user's Chrome from now on (§8.4); `None` when it
    /// left. Like the desktop app, a later one replaces the one before.
    pub fn set_extension(&self, host: Option<Arc<dyn EmbeddedHost>>) {
        *self.extension.lock() = host;
    }

    /// Clears the extension only if it is still `id`.
    pub fn remove_extension(&self, id: u64) {
        let mut host = self.extension.lock();
        if host.as_ref().is_some_and(|h| h.id() == id) {
            *host = None;
        }
    }

    pub fn has_extension(&self) -> bool {
        self.extension.lock().is_some()
    }

    /// The browser for `config`: the embedded one or the managed one for `config.profile`,
    /// started when there is none.
    pub async fn acquire(&self, config: &BrowserConfig) -> Result<Arc<Browser>, BrowserError> {
        let host = match config.backend {
            Backend::Managed => None,
            Backend::Auto | Backend::Embedded => self.host.lock().clone(),
            Backend::Extension => self.extension.lock().clone(),
        };
        if host.is_none() {
            match config.backend {
                Backend::Embedded => return Err(BrowserError::Launch(NO_HOST.into())),
                Backend::Extension => return Err(BrowserError::Launch(NO_EXTENSION.into())),
                Backend::Auto | Backend::Managed => {}
            }
        }
        let extension = config.backend == Backend::Extension;
        let key = match &host {
            Some(host) if extension => format!("extension#{}", host.id()),
            Some(host) => format!("embedded#{}", host.id()),
            None => config.profile.clone(),
        };
        let gate = self.inner.starting.lock().entry(key.clone()).or_default().clone();
        let _started = gate.lock().await;
        let existing = self.inner.browsers.lock().get(&key).and_then(Weak::upgrade);
        if let Some(browser) = existing {
            if !browser.is_dead() {
                return Ok(browser);
            }
            // Crashed or closed by the user: release the profile now, not when the last
            // session lets go of it.
            browser.shut_down();
        }
        let closing = self.inner.closing.lock().get(&key).cloned();
        if let Some(mut done) = closing {
            let _ = tokio::time::timeout(CLOSE_WAIT, done.wait_for(|done| *done)).await;
        }
        let browser = match host {
            Some(host) => self.hosted(host.as_ref(), &key, extension).await?,
            None => self.launch(config).await?,
        };
        self.inner.browsers.lock().insert(key, Arc::downgrade(&browser));
        Ok(browser)
    }

    /// A browser in the desktop app or in the user's Chrome: no process or profile of ours,
    /// only the stream.
    async fn hosted(&self, host: &dyn EmbeddedHost, key: &str, extension: bool) -> Result<Arc<Browser>, BrowserError> {
        let (reader, writer) = host.connect()?;
        let (conn, events) = Conn::start(reader, writer, crate::launch::COMMAND_TIMEOUT);
        let downloads = self.root.join("downloads").join(format!("{}-{}", std::process::id(), key.replace('#', "-")));
        let router = Router::start(conn.clone(), events, downloads.clone(), true);
        router.init().await?;
        let (done_tx, _) = watch::channel(false);
        Ok(Arc::new(Browser {
            conn,
            router,
            note: extension.then(|| EXTENSION_NOTE.to_string()),
            kind: if extension { BrowserKind::Extension } else { BrowserKind::Embedded },
            close: Mutex::new(Some(Closing {
                child: None,
                lock: None,
                temporary: None,
                downloads,
                done: done_tx,
                pool: Arc::downgrade(&self.inner),
                key: key.to_string(),
            })),
            runtime: tokio::runtime::Handle::current(),
        }))
    }

    async fn launch(&self, config: &BrowserConfig) -> Result<Arc<Browser>, BrowserError> {
        if config.profile.is_empty() || config.profile.contains(['/', '\\']) || config.profile.starts_with('.') {
            return Err(BrowserError::Launch(format!("invalid browser.profile \"{}\"", config.profile)));
        }
        let profile = self.root.join("profiles").join(&config.profile);
        let (user_data_dir, lock, temporary, note) = match ProfileLock::acquire(&profile) {
            Ok(lock) => (profile, Some(lock), false, None),
            Err(holder) => {
                static NEXT: AtomicU64 = AtomicU64::new(0);
                let dir = self
                    .root
                    .join(format!("tmp-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
                let holder = holder.map_or("another process".to_string(), |pid| format!("process {pid}"));
                let note = format!(
                    "The browser profile \"{}\" is in use by {holder}, so this browser uses a temporary profile \
                     without saved logins. Tell the user if a login is missing; a different browser.profile avoids this.",
                    config.profile
                );
                (dir, None, true, Some(note))
            }
        };
        let headless = match config.headless {
            Headless::On => true,
            Headless::Off => false,
            Headless::Auto => self.auto_headless,
        };
        // The configured one, else one installed on the machine, else finx's own (D-194).
        let executable = config.executable.clone().or_else(|| {
            crate::launch::find_executable()
                .is_none()
                .then(|| crate::launch::installed_executable(&self.root))
                .flatten()
        });
        let options = LaunchOptions {
            executable,
            user_data_dir: user_data_dir.clone(),
            headless,
        };
        let launched = match self.launcher.launch(&options).await {
            Ok(launched) => launched,
            Err(err) => {
                if temporary {
                    let _ = std::fs::remove_dir_all(&user_data_dir);
                }
                return Err(err);
            }
        };
        let downloads = self.root.join("downloads").join(format!("{}-{}", std::process::id(), short_key(&user_data_dir)));
        let router = Router::start(launched.conn.clone(), launched.events, downloads.clone(), false);
        router.init().await?;
        let (done_tx, _) = watch::channel(false);
        Ok(Arc::new(Browser {
            conn: launched.conn,
            router,
            note,
            kind: BrowserKind::Managed,
            close: Mutex::new(Some(Closing {
                child: launched.child,
                lock,
                temporary: temporary.then_some(user_data_dir),
                downloads,
                done: done_tx,
                pool: Arc::downgrade(&self.inner),
                key: config.profile.clone(),
            })),
            runtime: tokio::runtime::Handle::current(),
        }))
    }
}

fn short_key(path: &std::path::Path) -> String {
    use std::hash::Hash;
    use std::hash::Hasher;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    format!("{:x}", hasher.finish() & 0xffff_ffff)
}

/// Whether a window can be shown: a desktop session, not a remote shell.
pub fn has_display() -> bool {
    if std::env::var_os("SSH_CONNECTION").is_some() || std::env::var_os("SSH_TTY").is_some() {
        return false;
    }
    if cfg!(any(target_os = "macos", windows)) {
        return true;
    }
    std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// Where a running browser is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrowserKind {
    /// Started by finx, with a profile of its own.
    Managed,
    /// In the desktop app's window.
    Embedded,
    /// The user's own Chrome, through the finx extension.
    Extension,
}

/// A running browser shared by the sessions that use its profile.
pub struct Browser {
    pub(crate) conn: Arc<Conn>,
    pub(crate) router: Arc<Router>,
    /// Said in the first result of every session: the profile was taken.
    pub(crate) note: Option<String>,
    kind: BrowserKind,
    close: Mutex<Option<Closing>>,
    runtime: tokio::runtime::Handle,
}

/// What closing a browser releases.
struct Closing {
    child: Option<tokio::process::Child>,
    lock: Option<ProfileLock>,
    temporary: Option<PathBuf>,
    downloads: PathBuf,
    done: watch::Sender<bool>,
    pool: Weak<PoolInner>,
    key: String,
}

impl Browser {
    /// The process exited or the connection broke: every holder starts over.
    pub fn is_dead(&self) -> bool {
        self.conn.is_closed()
    }

    pub fn note(&self) -> Option<&str> {
        self.note.as_deref()
    }

    pub fn is_embedded(&self) -> bool {
        self.kind == BrowserKind::Embedded
    }

    pub fn kind(&self) -> BrowserKind {
        self.kind
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        self.shut_down();
    }
}

impl Browser {
    /// Starts closing the browser in the background; the pool waits for it on this profile.
    fn shut_down(&self) {
        let Some(closing) = self.close.lock().take() else {
            return;
        };
        if let Some(pool) = closing.pool.upgrade() {
            pool.closing.lock().insert(closing.key.clone(), closing.done.subscribe());
        }
        let conn = self.conn.clone();
        self.runtime.spawn(close(conn, closing));
    }
}

async fn close(conn: Arc<Conn>, mut closing: Closing) {
    if !conn.is_closed() {
        let _ = conn
            .send_with_timeout(None, "Browser.close", serde_json::json!({}), Duration::from_secs(2))
            .await;
    }
    if let Some(child) = &mut closing.child
        && tokio::time::timeout(CLOSE_GRACE, child.wait()).await.is_err()
    {
        let _ = child.kill().await;
    }
    drop(closing.lock.take());
    if let Some(dir) = &closing.temporary {
        let _ = std::fs::remove_dir_all(dir);
    }
    let _ = std::fs::remove_dir_all(&closing.downloads);
    let _ = closing.done.send(true);
}
