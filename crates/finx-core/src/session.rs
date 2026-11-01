//! Session state shared by the submission loop, the running task and tool executions.

use finx_llm::Context;
use finx_llm::Message;
use finx_llm::Model;
use finx_llm::ModelRegistry;
use finx_llm::ThinkingLevel;
use finx_llm::Usage;
use finx_llm::UsageTotals;
use finx_llm::UserMessage;
use finx_llm::now_ms;
use finx_protocol::ApprovalDecision;
use finx_protocol::CommandRule;
use finx_protocol::EventMsg;
use finx_protocol::PermissionMode;
use finx_protocol::SiteGrant;
use finx_protocol::SkillUse;
use finx_protocol::WarningCode;
use finx_tools::Environment;
use finx_tools::FileTracker;
use finx_tools::PathLocks;
use finx_tools::ToolRegistry;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::agents::AgentTree;
use crate::agents::Mail;
use crate::config::Config;
use crate::context;
use crate::emitter::Emitter;
use crate::history::History;
use crate::hooks::Hooks;
use crate::hooks::SessionView;
use crate::mcp::McpManager;
use crate::mcp::tools::Shown;
use crate::skills::SkillRef;
use crate::store::Entry;
use crate::store::EntryKind;
use crate::store::SessionWriter;
use crate::store::SkillText;

/// User input on its way into the history: the message as the user wrote it, and the
/// instructions of the skills it mentions, read when it arrived.
pub(crate) struct Input {
    pub(crate) message: UserMessage,
    pub(crate) skills: Vec<SkillText>,
}

pub(crate) struct ActiveTask {
    pub(crate) id: String,
    pub(crate) cancel: CancellationToken,
    pub(crate) handle: Option<JoinHandle<()>>,
}

pub(crate) struct SessionState {
    pub(crate) history: History,
    /// What is sent: `base_prompt`, then `mcp_section` when there is one.
    pub(crate) system_prompt: Arc<str>,
    /// Fixed when the session started, and kept on resume.
    pub(crate) base_prompt: Arc<str>,
    /// MCP server catalog and instructions; changes only with the MCP servers.
    pub(crate) mcp_section: Option<String>,
    /// The skills of the session, frozen with the system prompt (its catalog lists the ones
    /// the model may load). Sub-agents get the main session's.
    pub(crate) skills: Arc<[SkillRef]>,
    pub(crate) model: Arc<Model>,
    pub(crate) thinking: ThinkingLevel,
    pub(crate) permission_mode: PermissionMode,
    pub(crate) session_rules: Vec<CommandRule>,
    /// Site permissions from "approve for this session"; in memory only, like the rules.
    pub(crate) site_grants: Vec<SiteGrant>,
    pub(crate) active_task: Option<ActiveTask>,
    pub(crate) steer: VecDeque<Input>,
    pub(crate) follow_up: VecDeque<Input>,
    pub(crate) pending_approvals: HashMap<String, oneshot::Sender<ApprovalDecision>>,
    pub(crate) pending_model: Option<(Arc<Model>, ThinkingLevel)>,
    pub(crate) usage: UsageTotals,
    pub(crate) next_task_no: u32,
    /// Correction factor for token estimates, learned from reported usage.
    pub(crate) estimate_ratio: f64,
    /// Where measuring the largest turn stopped; see `budget`.
    pub(crate) turn_scan: crate::budget::TurnScan,
    /// Sub-agents' reports not yet in the history, oldest first.
    pub(crate) inbox: VecDeque<Mail>,
    /// The last task was interrupted: reports wait for new input instead of starting a task.
    pub(crate) hold: bool,
    /// `Idle` was sent and nothing has started since.
    pub(crate) idle: bool,
    /// The name given with `set_title`, and whether the session is archived.
    pub(crate) title: Option<String>,
    pub(crate) archived: bool,
}

impl SessionState {
    pub(crate) fn new(
        history: History,
        system_prompt: Arc<str>,
        model: Arc<Model>,
        thinking: ThinkingLevel,
        permission_mode: PermissionMode,
    ) -> Self {
        Self {
            history,
            base_prompt: system_prompt.clone(),
            system_prompt,
            mcp_section: None,
            skills: Arc::from([]),
            model,
            thinking,
            permission_mode,
            session_rules: Vec::new(),
            site_grants: Vec::new(),
            active_task: None,
            steer: VecDeque::new(),
            follow_up: VecDeque::new(),
            pending_approvals: HashMap::new(),
            pending_model: None,
            usage: UsageTotals::default(),
            next_task_no: 0,
            estimate_ratio: 1.0,
            turn_scan: crate::budget::TurnScan::default(),
            inbox: VecDeque::new(),
            hold: false,
            idle: false,
            title: None,
            archived: false,
        }
    }

    /// A waiting report would start a task now.
    pub(crate) fn has_waking_mail(&self) -> bool {
        !self.hold && self.inbox.iter().any(|mail| mail.wake)
    }
}

/// Messages from inside the process, handled by the submission loop in order with the ops.
/// They travel boxed: a channel keeps a block of 32 slots for as long as it lives, and slots
/// sized for a mail would cost every session 4 KiB.
pub(crate) enum Internal {
    /// A sub-agent's report for this session.
    Mail(Mail),
    /// The main session's permissions changed; a sub-agent takes them over.
    Permissions {
        mode: PermissionMode,
        rules: Vec<CommandRule>,
        grants: Vec<SiteGrant>,
    },
}

pub(crate) struct Session {
    pub(crate) id: String,
    pub(crate) llm: Arc<ModelRegistry>,
    /// The tool list; replaced between requests when MCP tools in it change.
    pub(crate) tools: Mutex<Arc<ToolRegistry>>,
    /// Built-in tools, the agent tools and the MCP search tools: everything but the MCP
    /// tools that go into the list directly.
    pub(crate) base_tools: Arc<ToolRegistry>,
    /// The agent tree's MCP servers, shared with sub-agents.
    pub(crate) mcp: Option<Arc<McpManager>>,
    /// MCP generation in `tools` and the system prompt.
    pub(crate) mcp_applied: AtomicU64,
    /// The first request already waited for the MCP servers.
    pub(crate) mcp_settled: AtomicBool,
    /// What tool searches showed since the last compaction.
    pub(crate) mcp_shown: Arc<Mutex<Shown>>,
    pub(crate) env: Arc<dyn Environment>,
    pub(crate) hooks: Vec<Arc<dyn Hooks>>,
    pub(crate) config: Arc<Config>,
    pub(crate) emitter: Arc<Emitter>,
    pub(crate) writer: SessionWriter,
    /// Read lock for read-only tools, write lock for mutating ones.
    pub(crate) tool_gate: tokio::sync::RwLock<()>,
    pub(crate) tool_slots: tokio::sync::Semaphore,
    pub(crate) files: Arc<FileTracker>,
    /// Full output of cut tool results: `tool-output` in the session's data directory.
    pub(crate) output_dir: PathBuf,
    /// The data directory is temporary (no session log) and goes away with the session.
    pub(crate) temporary_data: Option<PathBuf>,
    /// Estimate of the system prompt and the tool definitions, in parts; see `budget`.
    pub(crate) fixed_tokens: Mutex<Option<crate::context_report::Fixed>>,
    /// The last context report and what it was made from; see `context_report`.
    pub(crate) context_report: Mutex<Option<(crate::context_report::ReportKey, finx_protocol::ContextReport)>>,
    /// The messages of the last request with their estimates; see `estimate_request`.
    pub(crate) request_estimates: Mutex<Vec<(finx_llm::Message, u64)>>,
    /// finx's data directory, canonical.
    pub(crate) data_dir: PathBuf,
    /// See [`SessionView::skill_roots`].
    pub(crate) skill_roots: Arc<[PathBuf]>,
    pub(crate) trusted: bool,
    pub(crate) interactive_approvals: bool,
    /// One lock per file, shared with the sub-agents: changes to a file never interleave.
    pub(crate) locks: Arc<PathLocks>,
    /// The sub-agents of a main session. `None` for a sub-agent, which cannot start any.
    pub(crate) agents: Option<Arc<AgentTree>>,
    /// A sub-agent's session: nobody can answer its approval requests.
    pub(crate) sub_agent: bool,
    /// What the kernel's tools keep for this session: its sub-agents, its browser.
    pub(crate) tool_state: Arc<finx_tools::SessionState>,
    /// Bumped whenever input is queued during a task; tools waiting for a sub-agent watch it.
    pub(crate) input_seq: watch::Sender<u64>,
    /// Never held across an await, and no I/O happens under it.
    pub(crate) state: Mutex<SessionState>,
}

impl Session {
    pub(crate) fn emit(&self, msg: EventMsg) {
        self.emitter.emit(msg);
    }

    /// The current tool list.
    pub(crate) fn tools(&self) -> Arc<ToolRegistry> {
        self.tools.lock().clone()
    }

    pub(crate) fn warn(&self, message: impl Into<String>) {
        let message = message.into();
        tracing::warn!(session = %self.id, "{message}");
        self.emit(EventMsg::Warning { message, code: None });
    }

    /// The bypass-permissions warning, sent when the session starts, resumes or switches into it.
    pub(crate) fn warn_bypass(&self) {
        tracing::warn!(session = %self.id, "{BYPASS_WARNING}");
        self.emit(EventMsg::Warning {
            message: BYPASS_WARNING.to_string(),
            code: Some(WarningCode::BypassPermissions),
        });
    }

    pub(crate) fn allocate_id(&self) -> String {
        self.state.lock().history.new_id()
    }

    /// Adds an entry to the in-memory history and queues it for the log, in the same order.
    pub(crate) fn record(&self, kind: EntryKind) -> Entry {
        let mut state = self.state.lock();
        let id = state.history.new_id();
        let entry = state.history.append(id, kind, now_ms());
        self.writer.append(entry.clone());
        entry
    }

    pub(crate) fn record_with_id(&self, id: String, kind: EntryKind) -> Entry {
        let mut state = self.state.lock();
        let entry = state.history.append(id, kind, now_ms());
        self.writer.append(entry.clone());
        entry
    }

    pub(crate) fn record_user(&self, input: Input) {
        let message = Message::from(input.message);
        let uses = input
            .skills
            .iter()
            .map(|skill| SkillUse {
                name: skill.name.clone(),
                path: skill.path.clone(),
            })
            .collect();
        let entry = self.record(EntryKind::Message {
            message: message.clone(),
            skills: input.skills,
            skill: None,
        });
        self.emit(EventMsg::MessageCompleted {
            message_id: entry.id,
            message,
            mail: None,
            skills: uses,
        });
    }

    /// Writes the waiting reports into the history, oldest first.
    pub(crate) fn deliver_mail(&self) {
        let mails: Vec<Mail> = self.state.lock().inbox.drain(..).collect();
        for mail in mails {
            let message = Message::from(mail.message);
            let entry = self.record(EntryKind::Mail {
                mail: Box::new(mail.info.clone()),
                message: message.clone(),
            });
            self.emit(EventMsg::MessageCompleted {
                message_id: entry.id,
                message,
                mail: Some(mail.info),
                skills: Vec::new(),
            });
        }
    }

    /// Sends `Idle` once nothing is left to do: no task, no queued input, no report that
    /// would start a task, and every sub-agent idle.
    pub(crate) fn check_idle(&self) {
        {
            let state = self.state.lock();
            let quiet = state.active_task.is_none()
                && state.steer.is_empty()
                && state.follow_up.is_empty()
                && !state.has_waking_mail();
            if !quiet || state.idle {
                return;
            }
        }
        if self.agents.as_ref().is_some_and(|tree| !tree.settled()) {
            return;
        }
        let mut state = self.state.lock();
        if state.active_task.is_none() && !state.idle {
            state.idle = true;
            // Under the lock, so that it cannot overtake the start of a new task.
            self.emit(EventMsg::Idle);
        }
    }

    pub(crate) fn take_steer(&self) -> Vec<Input> {
        self.state.lock().steer.drain(..).collect()
    }

    pub(crate) fn has_steer(&self) -> bool {
        !self.state.lock().steer.is_empty()
    }

    pub(crate) fn take_follow_up(&self) -> Option<Input> {
        self.state.lock().follow_up.pop_front()
    }

    pub(crate) fn is_busy(&self) -> bool {
        self.state.lock().active_task.is_some()
    }

    pub(crate) fn current_model(&self) -> (Arc<Model>, ThinkingLevel) {
        let state = self.state.lock();
        (state.model.clone(), state.thinking)
    }

    pub(crate) fn add_usage(&self, model_ref: &str, usage: &Usage) {
        self.state.lock().usage.add(model_ref, usage);
    }

    /// System prompt, normalized history and tool specs, after the context hooks.
    pub(crate) fn build_context(&self) -> Context {
        let (system, messages) = {
            let state = self.state.lock();
            let branch = state.history.branch();
            (state.system_prompt.to_string(), context::branch_messages(&branch))
        };
        let mut ctx = Context {
            system,
            messages: context::normalize(messages),
            tools: self.tools().specs(),
        };
        for hook in &self.hooks {
            hook.transform_context(&mut ctx);
        }
        ctx
    }

    pub(crate) fn view(&self) -> SessionView {
        let state = self.state.lock();
        SessionView {
            permission_mode: state.permission_mode,
            config_rules: self.config.rules.clone(),
            session_rules: state.session_rules.clone(),
            trusted: self.trusted,
            env: self.env.clone(),
            data_dir: self.data_dir.clone(),
            skill_roots: self.skill_roots.clone(),
            site_grants: state.site_grants.clone(),
            browser: self.config.browser.policy.clone(),
            desktop: self.config.desktop.clone(),
        }
    }

    /// Stops the current task and, in a main session, the work of every sub-agent.
    pub(crate) fn interrupt(&self) {
        if let Some(task) = &self.state.lock().active_task {
            task.cancel.cancel();
        }
        if let Some(tree) = &self.agents {
            tree.interrupt_all();
        }
    }

    /// `agent_interrupt`: stops one sub-agent and nothing else.
    pub(crate) fn interrupt_agent(&self, agent: &str) {
        let stopped = self.agents.as_ref().is_some_and(|tree| tree.interrupt_one(agent));
        if !stopped {
            self.warn(format!("no sub-agent \"{agent}\" is running"));
        }
    }

    pub(crate) fn resolve_approval(&self, call_id: &str, decision: ApprovalDecision) {
        let sender = self.state.lock().pending_approvals.remove(call_id);
        match sender {
            Some(tx) => {
                let _ = tx.send(decision);
            }
            None => self.warn(format!("no approval is pending for call {call_id}")),
        }
    }

    pub(crate) fn emit_settings(&self) {
        let (model, thinking, permission_mode, context_window) = {
            let state = self.state.lock();
            (
                state.model.reference(),
                state.thinking,
                state.permission_mode,
                u64::from(state.model.context_window),
            )
        };
        self.emit(EventMsg::SettingsChanged {
            model,
            thinking,
            permission_mode,
            context_window,
        });
    }

    fn change_model(&self, model: Arc<Model>, thinking: ThinkingLevel) {
        {
            let mut state = self.state.lock();
            state.model = model.clone();
            state.thinking = thinking;
        }
        self.record(EntryKind::Settings {
            model: Some(model.reference()),
            thinking: Some(thinking),
            permission_mode: None,
        });
        self.emit_settings();
    }

    /// Takes effect immediately when idle, otherwise at the next turn boundary.
    pub(crate) fn set_model(&self, reference: &str, thinking: Option<ThinkingLevel>) {
        let resolved = match self.llm.resolve(reference) {
            Ok(resolved) => resolved,
            Err(err) => {
                self.warn(format!("cannot switch model: {err}"));
                return;
            }
        };
        if resolved.ad_hoc {
            self.warn(format!("model '{reference}' is not in the catalog; default limits apply"));
        }
        // A level chosen here is remembered for the model; a model switch keeps the session's
        // level when the new model offers it, else takes the level that model starts with
        // (docs/kernel/model-catalog-design.md §18).
        let thinking = match thinking {
            Some(level) => {
                let level = resolved.model.resolve_thinking(level);
                if let Err(err) = self.llm.directory().remember_thinking(&resolved.model.reference(), level) {
                    tracing::warn!("cannot remember the thinking level: {}", err.message);
                }
                level
            }
            None => {
                let current = self.state.lock().thinking;
                crate::models::thinking_for(&self.llm, &resolved.model, current)
            }
        };
        if self.is_busy() {
            self.state.lock().pending_model = Some((resolved.model, thinking));
        } else {
            self.change_model(resolved.model, thinking);
        }
    }

    pub(crate) fn apply_pending_model(&self) {
        let pending = self.state.lock().pending_model.take();
        if let Some((model, thinking)) = pending {
            self.change_model(model, thinking);
        }
    }

    pub(crate) fn set_permission_mode(&self, mode: PermissionMode) {
        let previous = std::mem::replace(&mut self.state.lock().permission_mode, mode);
        self.record(EntryKind::Settings {
            model: None,
            thinking: None,
            permission_mode: Some(mode),
        });
        self.emit_settings();
        if mode == PermissionMode::BypassPermissions && previous != mode {
            self.warn_bypass();
        }
        self.share_permissions();
    }

    /// A rule from "approve for this session".
    pub(crate) fn add_session_rule(&self, rule: CommandRule) {
        self.state.lock().session_rules.push(rule);
        self.share_permissions();
    }

    /// A site permission from "approve for this session".
    pub(crate) fn add_site_grant(&self, grant: SiteGrant) {
        {
            let mut state = self.state.lock();
            if !state.site_grants.contains(&grant) {
                state.site_grants.push(grant);
            }
        }
        self.sync_browser_grants();
        self.share_permissions();
    }

    /// "Always allow": the grant goes into the user's configuration as well (D-197). A
    /// failure to write is a warning; the grant still holds for the session.
    pub(crate) fn remember_site(&self, grant: &SiteGrant) {
        let file = self.data_dir.join("config.toml");
        if let Err(err) = crate::site_policy::remember(&file, grant) {
            self.emit(EventMsg::Warning {
                message: format!("could not save the site permission in {}: {err}", file.display()),
                code: None,
            });
        }
    }

    /// Navigations the page makes may reach the private sites the session allowed.
    fn sync_browser_grants(&self) {
        if let Some(browser) = self.tool_state.get::<crate::browser::BrowserHandle>() {
            browser.set_grants(self.state.lock().site_grants.clone());
        }
    }

    /// Sub-agents always judge tool calls by the main session's current permissions.
    fn share_permissions(&self) {
        if let Some(tree) = &self.agents {
            let (mode, rules, grants) = {
                let state = self.state.lock();
                (state.permission_mode, state.session_rules.clone(), state.site_grants.clone())
            };
            tree.share_permissions(mode, rules, grants);
        }
    }

    /// A sub-agent takes over the main session's permissions.
    pub(crate) fn apply_permissions(&self, mode: PermissionMode, rules: Vec<CommandRule>, grants: Vec<SiteGrant>) {
        let changed = {
            let mut state = self.state.lock();
            state.session_rules = rules;
            state.site_grants = grants;
            std::mem::replace(&mut state.permission_mode, mode) != mode
        };
        self.sync_browser_grants();
        if changed {
            self.record(EntryKind::Settings {
                model: None,
                thinking: None,
                permission_mode: Some(mode),
            });
            self.emit_settings();
        }
    }

    /// Names the session. Allowed while a task runs: it only adds a log entry.
    pub(crate) fn set_title(&self, title: &str) {
        let Some(title) = clean_title(title) else {
            self.warn("ignored an empty session title");
            return;
        };
        if self.state.lock().title.as_deref() == Some(title.as_str()) {
            return;
        }
        self.state.lock().title = Some(title.clone());
        self.record(EntryKind::Title { title: title.clone() });
        self.emit(EventMsg::TitleChanged { title });
    }

    pub(crate) fn set_archived(&self, archived: bool) {
        if std::mem::replace(&mut self.state.lock().archived, archived) == archived {
            return;
        }
        self.record(EntryKind::Archived { archived });
        self.emit(EventMsg::ArchivedChanged { archived });
    }
}

/// Longest session title, in characters.
pub const MAX_TITLE_CHARS: usize = 200;

/// A title as stored: one line, trimmed, at most `MAX_TITLE_CHARS`; `None` when nothing is left.
pub fn clean_title(title: &str) -> Option<String> {
    let line = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = line.chars().take(MAX_TITLE_CHARS).collect();
    (!cut.is_empty()).then_some(cut)
}

/// Shown whenever a session starts, resumes or switches into bypass-permissions.
const BYPASS_WARNING: &str = "Permission mode bypass-permissions: tools run without asking, \
    including changes to protected files such as .git and shell profiles and to files outside the \
    workspace. Only deny rules, ask rules and deleting critical paths still stop an action. Use it \
    only in an isolated environment such as a container or a throwaway checkout.";
