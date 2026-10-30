//! The kernel handle: operations in, events out. A background task owns the session loop.

use finx_llm::Message;
use finx_llm::Model;
use finx_llm::ModelRegistry;
use finx_llm::ResolveError;
use finx_llm::ThinkingLevel;
use finx_llm::UsageTotals;
use finx_llm::UserContent;
use finx_protocol::CommandRule;
use finx_protocol::ErrorInfo;
use finx_protocol::Event;
use finx_protocol::EventMsg;
use finx_protocol::Op;
use finx_protocol::PROTOCOL_VERSION;
use finx_protocol::PermissionMode;
use finx_protocol::PromptMode;
use finx_protocol::api::SessionInfo;
use finx_protocol::api::TaskOutcome;
use finx_protocol::api::TranscriptItem;
use finx_tools::Environment;
use finx_tools::FileTracker;
use finx_tools::PathLocks;
use finx_tools::ToolRegistry;
use parking_lot::Mutex;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::Weak;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::agents;
use crate::agents::AgentTree;
use crate::agents::ChildDeps;
use crate::approval::ApprovalPolicy;
use crate::config::Config;
use crate::context;
use crate::emitter::Emitter;
use crate::history::History;
use crate::hooks::Hooks;
use crate::instructions;
use crate::mcp;
use crate::mcp::McpManager;
use crate::mcp::tools::Shown;
use crate::paths::FinxHome;
use crate::prompt;
use crate::prompt::PromptInputs;
use crate::session::Internal;
use crate::session::Session;
use crate::session::SessionState;
use crate::skills;
use crate::skills::SkillRef;
use crate::skills::SkillState;
use crate::store::EntryKind;
use crate::store::SessionHeader;
use crate::store::SessionRef;
use crate::store::SessionStore;
use crate::store::SessionWriter;
use crate::store::WriterClosed;
use crate::store::StoreError;
use crate::store::TaskStatus;
use crate::task;

const OP_CHANNEL_CAPACITY: usize = 64;

pub struct KernelDeps {
    pub llm: Arc<ModelRegistry>,
    pub tools: Arc<ToolRegistry>,
    pub env: Arc<dyn Environment>,
    pub store: Arc<dyn SessionStore>,
    /// Extra hooks; the approval policy is always added last.
    pub hooks: Vec<Arc<dyn Hooks>>,
    /// MCP servers for the session, merged and validated by the front end. Started with the
    /// session; empty means no MCP.
    pub mcp_servers: Vec<finx_protocol::McpServerConfig>,
}

pub struct StartOptions {
    pub model: String,
    pub thinking: ThinkingLevel,
    pub permission_mode: PermissionMode,
    pub cwd: PathBuf,
    pub home: FinxHome,
    pub config: Arc<Config>,
    pub project_root: Option<PathBuf>,
    pub trusted: bool,
    /// Whether a front end can answer approval requests. Without one, "ask" means "deny".
    pub interactive_approvals: bool,
}

pub struct ResumeOptions {
    pub session: SessionRef,
    /// Overrides; `None` keeps the session's own settings.
    pub model: Option<String>,
    pub thinking: Option<ThinkingLevel>,
    pub permission_mode: Option<PermissionMode>,
    pub home: FinxHome,
    pub config: Arc<Config>,
    pub project_root: Option<PathBuf>,
    pub trusted: bool,
    pub interactive_approvals: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum KernelError {
    #[error(transparent)]
    Model(#[from] ResolveError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("{0}")]
    Other(String),
}

#[derive(Debug, thiserror::Error)]
#[error("the session is closed")]
pub struct KernelClosed;

#[derive(Debug, Clone, PartialEq)]
pub enum TaskEnd {
    Completed { last_message: Option<String> },
    Failed(ErrorInfo),
    Interrupted,
}

#[derive(Debug)]
pub struct TaskResult {
    pub end: TaskEnd,
    pub events: Vec<Event>,
}

pub struct Kernel {
    ops: mpsc::Sender<Op>,
    events: mpsc::UnboundedReceiver<Box<Event>>,
    session_id: String,
    session_file: PathBuf,
    submission: JoinHandle<()>,
    log_closed: WriterClosed,
    /// Weak, so the event channel still closes when the session loop ends.
    session: Weak<Session>,
    /// Messages from inside the process: reports, permissions for a sub-agent.
    pub(crate) internal: mpsc::UnboundedSender<Box<Internal>>,
}

struct Launch {
    id: String,
    location: PathBuf,
    writer: SessionWriter,
    home: FinxHome,
    trusted: bool,
    interactive_approvals: bool,
    config: Arc<Config>,
    deps: KernelDeps,
    state: SessionState,
    agents: Option<Arc<AgentTree>>,
    sub_agent: bool,
    locks: Arc<PathLocks>,
    mcp: Option<Arc<McpManager>>,
}

fn launch(launch: Launch) -> (Kernel, Arc<Session>) {
    let (event_tx, event_rx) = mpsc::unbounded_channel();
    let (op_tx, op_rx) = mpsc::channel(OP_CHANNEL_CAPACITY);
    let (internal_tx, internal_rx) = mpsc::unbounded_channel();
    let mut hooks = launch.deps.hooks;
    hooks.push(Arc::new(ApprovalPolicy));
    let log_closed = launch.writer.closed();
    let (session_dir, temporary) = FinxHome::session_data_dir(&launch.location, &launch.id);
    let shown = Arc::new(Mutex::new(Shown::default()));
    let base_tools = mcp::base_tools(&launch.deps.tools, launch.mcp.as_ref(), &shown);
    let (skill_roots, skill_dirs) =
        crate::protected::skill_locations(&launch.config.skills, &launch.home, launch.deps.env.cwd());
    let session = Arc::new(Session {
        id: launch.id.clone(),
        llm: launch.deps.llm,
        tools: Mutex::new(base_tools.clone()),
        base_tools,
        mcp: launch.mcp,
        mcp_applied: AtomicU64::new(u64::MAX),
        mcp_settled: AtomicBool::new(false),
        mcp_shown: shown,
        env: launch.deps.env,
        hooks,
        emitter: Arc::new(Emitter::new(event_tx)),
        writer: launch.writer,
        tool_gate: tokio::sync::RwLock::new(()),
        tool_slots: tokio::sync::Semaphore::new(launch.config.max_parallel_tools),
        files: Arc::new(FileTracker::new()),
        output_dir: session_dir.join("tool-output"),
        temporary_data: temporary.then_some(session_dir),
        fixed_tokens: Mutex::new(None),
        context_report: Mutex::new(None),
        request_estimates: Mutex::new(Vec::new()),
        data_dir: crate::protected::canonical_data_dir(launch.home.root()),
        skill_roots,
        skill_dirs,
        trusted: launch.trusted,
        interactive_approvals: launch.interactive_approvals,
        locks: launch.locks,
        agents: launch.agents,
        sub_agent: launch.sub_agent,
        input_seq: watch::channel(0).0,
        config: launch.config,
        state: Mutex::new(launch.state),
    });
    let handle = tokio::spawn(submission_loop(session.clone(), op_rx, internal_rx));
    let kernel = Kernel {
        ops: op_tx,
        events: event_rx,
        session_id: launch.id,
        session_file: launch.location,
        submission: handle,
        log_closed,
        session: Arc::downgrade(&session),
        internal: internal_tx,
    };
    (kernel, session)
}

/// The sub-agents of a main session: adds `spawn_agent` and `send_message` to its tools.
/// Sub-agents get the tools as they were before, without these two, and share the MCP servers.
fn agent_tree(
    deps: &mut KernelDeps,
    home: &FinxHome,
    config: &Arc<Config>,
    trusted: bool,
    mcp: Option<Arc<McpManager>>,
) -> Option<Arc<AgentTree>> {
    if !config.agents_enabled {
        return None;
    }
    let tree = AgentTree::new(ChildDeps {
        llm: deps.llm.clone(),
        tools: deps.tools.clone(),
        env: deps.env.clone(),
        store: deps.store.clone(),
        hooks: deps.hooks.clone(),
        home: home.clone(),
        config: config.clone(),
        trusted,
        mcp,
    });
    deps.tools = with_agent_tools(&deps.tools);
    Some(tree)
}

/// `tools` plus `spawn_agent` and `send_message`, built once for each registry: the two tools
/// hold no session, so main sessions with the same tools share the result.
fn with_agent_tools(tools: &Arc<ToolRegistry>) -> Arc<ToolRegistry> {
    type Built = Vec<(Weak<ToolRegistry>, Arc<ToolRegistry>)>;
    static BUILT: OnceLock<Mutex<Built>> = OnceLock::new();
    let mut built = BUILT.get_or_init(Default::default).lock();
    built.retain(|(base, _)| base.strong_count() > 0);
    if let Some((_, with)) = built.iter().find(|(base, _)| std::ptr::eq(base.as_ptr(), Arc::as_ptr(tools))) {
        return with.clone();
    }
    let mut with = (**tools).clone();
    for tool in agents::agent_tools() {
        // A custom registry may already define these names; it wins.
        let _ = with.register(tool);
    }
    let with = Arc::new(with);
    built.push((Arc::downgrade(tools), with.clone()));
    with
}

/// What a sub-agent's session starts from: the main session's current settings.
pub(crate) struct ChildLaunch {
    pub(crate) header: SessionHeader,
    /// The main session's prompt as sent, its fixed part and its MCP part.
    pub(crate) system_prompt: Arc<str>,
    pub(crate) base_prompt: Arc<str>,
    pub(crate) mcp_section: Option<String>,
    pub(crate) mcp: Option<Arc<McpManager>>,
    /// The main session's skills, which its system prompt lists.
    pub(crate) skills: Arc<[SkillRef]>,
    pub(crate) model: Arc<Model>,
    pub(crate) thinking: ThinkingLevel,
    pub(crate) permission_mode: PermissionMode,
    pub(crate) session_rules: Vec<CommandRule>,
    pub(crate) deps: KernelDeps,
    pub(crate) home: FinxHome,
    pub(crate) config: Arc<Config>,
    pub(crate) trusted: bool,
    pub(crate) locks: Arc<PathLocks>,
}

/// Starts a sub-agent's session: an ordinary session with its own log, which never asks for
/// approval.
pub(crate) fn start_child(child: ChildLaunch) -> Result<Kernel, KernelError> {
    let created = child.deps.store.create(&child.header)?;
    let model_ref = child.model.reference();
    let context_window = u64::from(child.model.context_window);
    let mut state = SessionState::new(
        History::default(),
        child.system_prompt.clone(),
        child.model,
        child.thinking,
        child.permission_mode,
    );
    state.session_rules = child.session_rules;
    state.base_prompt = child.base_prompt;
    state.mcp_section = child.mcp_section;
    state.skills = child.skills.clone();
    let (kernel, session) = launch(Launch {
        id: child.header.id.clone(),
        location: created.location.clone(),
        writer: created.writer,
        home: child.home,
        trusted: child.trusted,
        interactive_approvals: false,
        config: child.config,
        deps: child.deps,
        state,
        agents: None,
        sub_agent: true,
        locks: child.locks,
        mcp: child.mcp,
    });
    // The main session has waited for the servers already: their tools are in from the start.
    session.refresh_mcp();
    session.record_system_prompt();
    session.record(EntryKind::Settings {
        model: Some(model_ref.clone()),
        thinking: Some(child.thinking),
        permission_mode: Some(child.permission_mode),
    });
    session.emit(EventMsg::SessionStarted {
        session_id: child.header.id.clone(),
        protocol_version: PROTOCOL_VERSION,
        model: model_ref,
        cwd: child.header.cwd.clone(),
        resumed: false,
        session_file: created.location,
        thinking: child.thinking,
        permission_mode: child.permission_mode,
        context_window,
        usage: UsageTotals::default(),
        context: Some(session.budget().usage),
    });
    Ok(kernel)
}

/// The MCP servers of a main session, or `None` without any. Not started yet: status
/// events need the session's emitter.
fn mcp_manager(deps: &KernelDeps, config: &Config, project_root: Option<PathBuf>) -> Option<Arc<McpManager>> {
    if deps.mcp_servers.is_empty() {
        return None;
    }
    // Only remote servers need HTTP; local-only setups skip creating the client.
    let http = deps
        .mcp_servers
        .iter()
        .any(|s| s.is_enabled() && s.url.is_some())
        .then(|| deps.llm.http_client().ok())
        .flatten();
    McpManager::new(
        deps.mcp_servers.clone(),
        &config.mcp,
        http,
        deps.env.workspace_roots().to_vec(),
        deps.env.cwd().to_path_buf(),
        project_root,
    )
}

/// A new session's system prompt, with the skills it lists and warnings for the user.
struct BuiltPrompt {
    text: String,
    skills: Vec<SkillRef>,
    warnings: Vec<String>,
}

/// `context_window` sizes the skill catalog.
fn build_prompt(
    home: &FinxHome,
    config: &Config,
    deps: &KernelDeps,
    project_root: Option<&Path>,
    context_window: u64,
) -> Result<BuiltPrompt, KernelError> {
    let cwd = deps.env.cwd().to_path_buf();
    let (files, mut warnings) = instructions::discover(home, &cwd, project_root, &config.instruction_files);
    let sources = skills::Sources::new(home, &cwd, project_root, &config.skills);
    let scan = skills::Scan::new(&sources, &deps.tools.names(), context_window);
    for shadowed in scan.set.entries.iter().filter(|e| e.state == SkillState::Shadowed) {
        let path = shadowed.path.display();
        tracing::info!(skill = %shadowed.name, %path, by = ?shadowed.detail, "skill shadowed");
    }
    warnings.extend(scan.warnings());
    let text = prompt::build_system_prompt(&PromptInputs {
        config,
        tools: &deps.tools,
        env: deps.env.as_ref(),
        instructions: &files,
        skills: &scan.catalog.text,
        project_root,
        git_branch: project_root.and_then(instructions::git_branch),
        date: chrono::Local::now().format("%Y-%m-%d").to_string(),
    })
    .map_err(|e| KernelError::Other(format!("cannot build the system prompt: {e}")))?;
    Ok(BuiltPrompt {
        text,
        skills: scan.set.references(),
        warnings,
    })
}

impl Kernel {
    pub async fn start(opts: StartOptions, mut deps: KernelDeps) -> Result<Kernel, KernelError> {
        let resolved = deps.llm.resolve(&opts.model)?;
        let mcp = mcp_manager(&deps, &opts.config, opts.project_root.clone());
        let agents = agent_tree(&mut deps, &opts.home, &opts.config, opts.trusted, mcp.clone());
        let mut warnings = Vec::new();
        if resolved.ad_hoc {
            warnings.push(format!("model '{}' is not in the catalog; default limits apply", opts.model));
        }
        let context_window = u64::from(resolved.model.context_window);
        let BuiltPrompt {
            text: system_prompt,
            skills,
            warnings: prompt_warnings,
        } = build_prompt(&opts.home, &opts.config, &deps, opts.project_root.as_deref(), context_window)?;
        warnings.extend(prompt_warnings);
        let id = uuid::Uuid::now_v7().to_string();
        let created = deps.store.create(&SessionHeader::new(id.clone(), opts.cwd.clone()))?;
        let model_ref = resolved.model.reference();
        let mcp_section = mcp.as_ref().and_then(|m| m.prompt_section());
        // The level asked for, when the model offers it; else the provider decides. A level
        // asked for is remembered for the model, as one chosen in a session is (§18).
        let thinking = resolved.model.resolve_thinking(opts.thinking);
        if thinking != ThinkingLevel::Default
            && let Err(err) = deps.llm.directory().remember_thinking(&resolved.model.reference(), thinking)
        {
            tracing::warn!("cannot remember the thinking level: {}", err.message);
        }
        let mut state = SessionState::new(
            History::default(),
            mcp::compose(&system_prompt, mcp_section.as_deref()).into(),
            resolved.model,
            thinking,
            opts.permission_mode,
        );
        state.base_prompt = system_prompt.into();
        state.mcp_section = mcp_section;
        state.skills = Arc::from(skills);
        let (kernel, session) = launch(Launch {
            id: id.clone(),
            location: created.location.clone(),
            writer: created.writer,
            home: opts.home.clone(),
            trusted: opts.trusted,
            interactive_approvals: opts.interactive_approvals,
            config: opts.config,
            deps,
            state,
            agents: agents.clone(),
            sub_agent: false,
            locks: Arc::new(PathLocks::new()),
            mcp: mcp.clone(),
        });
        if let Some(tree) = &agents {
            tree.bind_root(&session, kernel.internal.clone());
        }
        session.record_system_prompt();
        session.record(EntryKind::Settings {
            model: Some(model_ref.clone()),
            thinking: Some(opts.thinking),
            permission_mode: Some(opts.permission_mode),
        });
        // A session that closes without doing anything needs no forced flush of these.
        session.writer.settle();
        session.emit(EventMsg::SessionStarted {
            session_id: id,
            protocol_version: PROTOCOL_VERSION,
            model: model_ref,
            cwd: opts.cwd,
            resumed: false,
            session_file: created.location,
            thinking: opts.thinking,
            permission_mode: opts.permission_mode,
            context_window,
            usage: UsageTotals::default(),
            context: Some(session.budget().usage),
        });
        if opts.permission_mode == PermissionMode::BypassPermissions {
            session.warn_bypass();
        }
        for warning in warnings {
            session.warn(warning);
        }
        if let Some(mcp) = &mcp {
            mcp.start(session.emitter.clone());
        }
        Ok(kernel)
    }

    pub async fn resume(opts: ResumeOptions, mut deps: KernelDeps) -> Result<Kernel, KernelError> {
        let loaded = deps.store.open(&opts.session)?;
        let mcp = mcp_manager(&deps, &opts.config, opts.project_root.clone());
        let agents = agent_tree(&mut deps, &opts.home, &opts.config, opts.trusted, mcp.clone());
        let history = History::from_entries(loaded.entries);
        let mut system_prompt = None;
        let mut last_prompt: Option<(Vec<String>, Option<String>)> = None;
        let mut model_ref = None;
        let mut thinking = None;
        let mut permission_mode = None;
        let mut usage = UsageTotals::default();
        let mut max_task = 0u32;
        let mut open_task: Option<String> = None;
        let mut title = None;
        let mut archived = false;
        let mut skills = Vec::new();
        for entry in history.branch() {
            match &entry.kind {
                EntryKind::Title { title: t } => title = Some(t.clone()),
                EntryKind::Archived { archived: a } => archived = *a,
                EntryKind::SystemPrompt(prompt) => {
                    system_prompt = Some(prompt.text.clone());
                    last_prompt = Some((prompt.tools.clone(), prompt.mcp.clone()));
                    // Entries written again later (a new tool set) may leave the skills out.
                    if !prompt.skills.is_empty() {
                        skills = prompt.skills.clone();
                    }
                }
                EntryKind::Settings {
                    model,
                    thinking: t,
                    permission_mode: a,
                } => {
                    model_ref = model.clone().or(model_ref);
                    thinking = t.or(thinking);
                    permission_mode = a.or(permission_mode);
                }
                EntryKind::Message {
                    message: Message::Assistant(assistant),
                    ..
                } => usage.add(&format!("{}/{}", assistant.provider, assistant.model), &assistant.usage),
                // Summary requests are paid for too.
                EntryKind::Compaction(checkpoint) => usage.add(&checkpoint.model, &checkpoint.usage),
                EntryKind::Task { task_id, status, .. } => {
                    if let Some(n) = task_id.strip_prefix('t').and_then(|n| n.parse::<u32>().ok()) {
                        max_task = max_task.max(n);
                    }
                    open_task = (*status == TaskStatus::Started).then(|| task_id.clone());
                }
                _ => {}
            }
        }
        let reference = opts
            .model
            .clone()
            .or(model_ref)
            .unwrap_or_else(|| opts.config.model.clone());
        // The model the session last used may belong to a provider that is gone (a disconnected
        // or removed connection): the session still opens, on the configured model, and says so.
        // The log keeps the old model, so the session goes back to it once the provider is back.
        // A model asked for by name is not replaced.
        let mut replaced = None;
        let resolved = match deps.llm.resolve(&reference) {
            Ok(resolved) => resolved,
            Err(ResolveError::UnknownProvider { .. }) if opts.model.is_none() && reference != opts.config.model => {
                replaced = Some(format!(
                    "model '{reference}' is not available (its provider is disconnected or removed); this session uses '{}' until it is back",
                    opts.config.model
                ));
                deps.llm.resolve(&opts.config.model)?
            }
            Err(error) => return Err(error.into()),
        };
        // Asked for now: kept when the model offers it. Saved or configured: kept when the model
        // offers it, else the level the model starts with (§18).
        let thinking = match opts.thinking {
            Some(level) => resolved.model.resolve_thinking(level),
            None => crate::models::thinking_for(&deps.llm, &resolved.model, thinking.unwrap_or(opts.config.thinking)),
        };
        let permission_mode = opts.permission_mode.or(permission_mode).unwrap_or(opts.config.permission_mode);
        let mut warnings = loaded.warnings;
        warnings.extend(replaced);
        let context_window = u64::from(resolved.model.context_window);
        let system_prompt = match system_prompt {
            Some(text) => text,
            None => {
                let project_root = opts.project_root.as_deref();
                let built = build_prompt(&opts.home, &opts.config, &deps, project_root, context_window)?;
                warnings.extend(built.warnings);
                skills = built.skills;
                built.text.into()
            }
        };
        let mcp_section = mcp.as_ref().and_then(|m| m.prompt_section());
        let mut state = SessionState::new(
            history,
            mcp::compose(&system_prompt, mcp_section.as_deref()).into(),
            resolved.model,
            thinking,
            permission_mode,
        );
        state.base_prompt = system_prompt;
        state.mcp_section = mcp_section.clone();
        state.skills = Arc::from(skills);
        state.usage = usage.clone();
        state.next_task_no = max_task;
        state.title = title;
        state.archived = archived;
        let model_ref = state.model.reference();
        let overridden = opts.model.is_some() || opts.thinking.is_some() || opts.permission_mode.is_some();
        let (kernel, session) = launch(Launch {
            id: loaded.header.id.clone(),
            location: loaded.location.clone(),
            writer: loaded.writer,
            home: opts.home.clone(),
            trusted: opts.trusted,
            interactive_approvals: opts.interactive_approvals,
            config: opts.config,
            deps,
            state,
            agents: agents.clone(),
            sub_agent: false,
            locks: Arc::new(PathLocks::new()),
            mcp: mcp.clone(),
        });
        if let Some(tree) = &agents {
            tree.bind_root(&session, kernel.internal.clone());
        }
        // A new entry only when the tools or the MCP part differ from what the log has.
        let current = (session.tools().names(), mcp_section);
        if last_prompt.as_ref() != Some(&current) {
            session.record_system_prompt();
        }
        if let Some(task_id) = open_task {
            // The process stopped in the middle of this task.
            session.record(EntryKind::Task {
                task_id,
                status: TaskStatus::Interrupted,
                error: None,
                reason: None,
                usage: None,
            });
        }
        if overridden {
            session.record(EntryKind::Settings {
                model: Some(model_ref.clone()),
                thinking: Some(thinking),
                permission_mode: Some(permission_mode),
            });
        }
        session.emit(EventMsg::SessionStarted {
            session_id: loaded.header.id,
            protocol_version: PROTOCOL_VERSION,
            model: model_ref,
            cwd: loaded.header.cwd,
            resumed: true,
            session_file: loaded.location,
            thinking,
            permission_mode,
            context_window,
            usage,
            // From the usage that the log keeps with every response.
            context: Some(session.budget().usage),
        });
        if permission_mode == PermissionMode::BypassPermissions {
            session.warn_bypass();
        }
        for warning in warnings {
            session.warn(warning);
        }
        if let Some(mcp) = &mcp {
            mcp.start(session.emitter.clone());
        }
        Ok(kernel)
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn session_file(&self) -> &Path {
        &self.session_file
    }

    /// Current settings. After the session closed, only the id and the file are meaningful.
    pub fn info(&self) -> SessionInfo {
        let mut info = SessionInfo {
            session_id: self.session_id.clone(),
            cwd: PathBuf::new(),
            session_file: self.session_file.clone(),
            model: String::new(),
            thinking: ThinkingLevel::Off,
            permission_mode: PermissionMode::Manual,
            context_window: 0,
            title: None,
            archived: false,
        };
        if let Some(session) = self.session.upgrade() {
            info.cwd = session.env.cwd().to_path_buf();
            let state = session.state.lock();
            info.model = state.model.reference();
            info.thinking = state.thinking;
            info.permission_mode = state.permission_mode;
            info.context_window = u64::from(state.model.context_window);
            info.title = state.title.clone();
            info.archived = state.archived;
        }
        info
    }

    /// The skills the session started with, and whether skills are turned on. Nothing after
    /// the session closed.
    pub fn skills(&self) -> (Arc<[SkillRef]>, bool) {
        match self.session.upgrade() {
            Some(session) => (session.state.lock().skills.clone(), session.config.skills.enabled),
            None => (Arc::from(Vec::new()), false),
        }
    }

    /// What fills the context window now; `None` after the session closed. Kept until the
    /// history, the model or the tools change, so it may be asked for often.
    pub fn context(&self) -> Option<finx_protocol::ContextReport> {
        self.session.upgrade().map(|session| session.context_report())
    }

    /// Messages and tool results on the current branch, oldest first. Clones `Arc`s only.
    pub fn transcript(&self) -> Vec<TranscriptItem> {
        let Some(session) = self.session.upgrade() else {
            return Vec::new();
        };
        let state = session.state.lock();
        state
            .history
            .branch()
            .into_iter()
            .filter_map(|entry| match &entry.kind {
                EntryKind::Message {
                    message: Message::ToolResult(result),
                    ..
                } => Some(TranscriptItem::ToolResult {
                    call_id: result.call_id.clone(),
                    result: result.clone(),
                }),
                EntryKind::Message { message, skills, skill } => Some(TranscriptItem::Message {
                    message_id: entry.id.clone(),
                    message: context::written(message, skill.as_deref()),
                    skills: context::skill_uses(skills, skill.as_deref()),
                    mail: None,
                }),
                EntryKind::Mail { mail, message } => Some(TranscriptItem::Message {
                    message_id: entry.id.clone(),
                    message: message.clone(),
                    skills: Vec::new(),
                    mail: Some(mail.clone()),
                }),
                EntryKind::Task {
                    task_id,
                    status,
                    error,
                    reason,
                    usage,
                } => {
                    let outcome = match status {
                        TaskStatus::Started => return None,
                        TaskStatus::Completed => TaskOutcome::Completed,
                        TaskStatus::Failed => TaskOutcome::Failed,
                        TaskStatus::Interrupted => TaskOutcome::Interrupted,
                    };
                    Some(TranscriptItem::TaskEnd {
                        task_id: task_id.clone(),
                        outcome,
                        reason: *reason,
                        error: error.clone(),
                        usage: usage.as_deref().cloned(),
                        ts: entry.ts,
                    })
                }
                _ => None,
            })
            .collect()
    }

    /// A sender for use from other tasks (signal handlers, stdin readers).
    pub fn op_sender(&self) -> mpsc::Sender<Op> {
        self.ops.clone()
    }

    pub async fn submit(&self, op: Op) -> Result<(), KernelClosed> {
        self.ops.send(op).await.map_err(|_| KernelClosed)
    }

    /// `None` once the session is closed.
    pub async fn next_event(&mut self) -> Option<Event> {
        self.events.recv().await.map(|event| *event)
    }

    /// Submits input and collects events until the task ends. Approval requests are not
    /// answered here; use `submit` and `next_event` for interactive use.
    pub async fn run(&mut self, input: Vec<UserContent>) -> Result<TaskResult, KernelClosed> {
        self.submit(Op::Prompt {
            input,
            mode: PromptMode::Steer,
            commands: true,
        })
        .await?;
        let mut events = Vec::new();
        while let Some(event) = self.next_event().await {
            let end = match &event.msg {
                EventMsg::TaskCompleted { last_message, .. } => Some(TaskEnd::Completed {
                    last_message: last_message.clone(),
                }),
                EventMsg::TaskFailed { error, .. } => Some(TaskEnd::Failed(error.clone())),
                EventMsg::TaskInterrupted { .. } => Some(TaskEnd::Interrupted),
                _ => None,
            };
            events.push(event);
            if let Some(end) = end {
                return Ok(TaskResult { end, events });
            }
        }
        Err(KernelClosed)
    }

    /// Stops the session and waits until it is closed.
    pub async fn shutdown(mut self) -> Vec<Event> {
        let _ = self.ops.send(Op::Shutdown).await;
        let mut rest = Vec::new();
        while let Some(event) = self.events.recv().await.map(|event| *event) {
            let closed = matches!(event.msg, EventMsg::SessionClosed);
            rest.push(event);
            if closed {
                break;
            }
        }
        // The loop owns the session. Once it ends, the log writer drains, closes the file and
        // releases its lock, so the session can be reopened right away.
        let _ = self.submission.await;
        let _ = tokio::time::timeout(Duration::from_secs(5), self.log_closed.wait()).await;
        rest
    }

    /// After `session_closed`: waits until the loop has ended and the log is closed.
    pub(crate) async fn closed(self) {
        let _ = self.submission.await;
        let _ = tokio::time::timeout(Duration::from_secs(5), self.log_closed.wait()).await;
    }
}

async fn submission_loop(
    session: Arc<Session>,
    mut ops: mpsc::Receiver<Op>,
    mut internal: mpsc::UnboundedReceiver<Box<Internal>>,
) {
    loop {
        tokio::select! {
            op = ops.recv() => {
                let Some(op) = op else { break };
                match op {
                    Op::Prompt { input, mode, commands } => task::on_prompt(&session, input, mode, commands),
                    Op::Continue => task::on_continue(&session),
                    Op::Interrupt => session.interrupt(),
                    Op::AgentInterrupt { agent } => session.interrupt_agent(&agent),
                    Op::Approval { call_id, decision } => session.resolve_approval(&call_id, decision),
                    Op::SetModel { model, thinking } => session.set_model(&model, thinking),
                    Op::SetPermissionMode { mode } => session.set_permission_mode(mode),
                    Op::SetTitle { title } => session.set_title(&title),
                    Op::SetArchived { archived } => session.set_archived(archived),
                    Op::Compact => task::on_compact(&session),
                    Op::Shutdown => break,
                }
            }
            Some(message) = internal.recv() => match *message {
                Internal::Mail(mail) => task::on_mail(&session, mail),
                Internal::Permissions { mode, rules } => session.apply_permissions(mode, rules),
            },
        }
    }
    let handle = {
        let mut state = session.state.lock();
        state.active_task.as_mut().and_then(|task| {
            task.cancel.cancel();
            task.handle.take()
        })
    };
    if let Some(handle) = handle {
        let _ = handle.await;
    }
    // The sub-agents end with the main session, then the MCP servers they shared.
    if let Some(tree) = &session.agents {
        tree.shutdown().await;
    }
    if !session.sub_agent
        && let Some(mcp) = &session.mcp
    {
        mcp.shutdown().await;
    }
    if let Err(err) = session.writer.sync().await {
        tracing::warn!(%err, "failed to sync the session log on shutdown");
    }
    if let Some(dir) = &session.temporary_data {
        let _ = std::fs::remove_dir_all(dir);
    }
    session.emit(EventMsg::SessionClosed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use finx_tools::BashTool;
    use finx_tools::builtin_registry;

    #[test]
    fn main_sessions_share_one_registry_with_the_agent_tools() {
        let base = Arc::new(builtin_registry(BashTool::default()));
        let with = with_agent_tools(&base);
        assert!(Arc::ptr_eq(&with, &with_agent_tools(&base)));
        assert!(with.get("spawn_agent").is_some() && with.get("send_message").is_some());
        assert!(base.get("spawn_agent").is_none(), "sub-agents keep the tools without these two");
        let other = Arc::new(builtin_registry(BashTool::default()));
        assert!(!Arc::ptr_eq(&with_agent_tools(&other), &with));
    }
}
