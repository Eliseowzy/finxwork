//! Sub-agents: sessions that the main agent starts with `spawn_agent` and talks to with
//! `send_message`. Each is an ordinary session with its own log, which never asks for approval
//! and cannot start agents of its own. When one has nothing left to do, its report goes back to
//! the main session: as the result of a call that waits for it, or as mail that joins the main
//! session's history at its next turn boundary and wakes it when it is idle.

mod driver;
mod mail;
mod restore;
mod tools;

use finx_llm::ModelRegistry;
use finx_llm::UsageTotals;
use finx_llm::UserContent;
use finx_protocol::AgentRef;
use finx_protocol::AgentStatus;
use finx_protocol::CommandRule;
use finx_protocol::ErrorInfo;
use finx_protocol::Event;
use finx_protocol::EventMsg;
use finx_protocol::Op;
use finx_protocol::PermissionMode;
use finx_protocol::PromptMode;
use finx_tools::Environment;
use finx_tools::ToolError;
use finx_tools::ToolOutput;
use finx_tools::ToolRegistry;
use parking_lot::Mutex;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::Weak;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub(crate) use mail::Mail;
pub use restore::RestoredAgent;
pub(crate) use restore::restore;
pub(crate) use tools::agent_tools;

use crate::config::Config;
use crate::emitter::Emitter;
use crate::hooks::Hooks;
use crate::kernel;
use crate::kernel::ChildLaunch;
use crate::kernel::KernelDeps;
use crate::paths::FinxHome;
use crate::session::Internal;
use crate::session::Session;
use crate::store::AgentOrigin;
use crate::store::AgentSpawnedEntry;
use crate::store::EntryKind;
use crate::store::SessionHeader;
use crate::store::SessionStore;

/// Ends the results of calls that leave an agent working in the background. Models take ending
/// their turn for handing in the answer, so when they need the report first they wait for it with
/// `sleep`, which also holds back the user's input: input reaches a running task only between
/// turns. Saying that ending the turn is the way to wait, and is not handing in, stops this
/// (subagent-design §15).
const REPORT_LATER: &str = "To wait for its report, end your turn: that is not your final answer. The report \
    comes to you as a new message when the agent finishes, and you continue your work from there.";

/// What a sub-agent's session is built from: the main session's dependencies.
pub(crate) struct ChildDeps {
    pub(crate) llm: Arc<ModelRegistry>,
    /// The main session's tools without the agent tools.
    pub(crate) tools: Arc<ToolRegistry>,
    pub(crate) env: Arc<dyn Environment>,
    pub(crate) store: Arc<dyn SessionStore>,
    /// Extra hooks; the approval policy is added for every session.
    pub(crate) hooks: Vec<Arc<dyn Hooks>>,
    pub(crate) home: FinxHome,
    pub(crate) config: Arc<Config>,
    pub(crate) trusted: bool,
    /// The main session's MCP servers; sub-agents use the same connections.
    pub(crate) mcp: Option<Arc<crate::mcp::McpManager>>,
    /// The main session's browsers: a sub-agent has its own tabs in the same browser.
    pub(crate) browser_pool: Option<Arc<finx_browser::BrowserPool>>,
    pub(crate) docs: Option<Arc<finx_docs::DocStore>>,
}

/// The main session, once it runs. Weak: the session owns the tree, not the other way round.
struct Root {
    session: Weak<Session>,
    emitter: Arc<Emitter>,
    internal: mpsc::UnboundedSender<Box<Internal>>,
}

/// The control plane of a main session's sub-agents: who they are, what they are doing, and
/// where each report goes.
pub(crate) struct AgentTree {
    deps: ChildDeps,
    root: OnceLock<Root>,
    /// Never held across an await.
    state: Mutex<TreeState>,
}

#[derive(Default)]
struct TreeState {
    agents: Vec<Agent>,
    /// Agents of an earlier run of the session, whose sessions are not loaded: their names
    /// stay taken, and they take no messages.
    restored: Vec<(String, String)>,
    /// Reports handed over but not yet in the main session's inbox, or in a waiting call.
    in_flight: usize,
    mails: u64,
    closing: bool,
}

struct Agent {
    id: String,
    name: String,
    status: AgentStatus,
    ops: mpsc::Sender<Op>,
    internal: mpsc::UnboundedSender<Box<Internal>>,
    route: Route,
    /// `send_message` with `interrupt`: the interrupted task's input starts the next one.
    redirect: bool,
    driver: Option<JoinHandle<()>>,
    /// What the kernel's tools keep for the agent's session: its browser.
    tool_state: Option<Arc<finx_tools::SessionState>>,
}

/// Where the report of the current round of work goes.
enum Route {
    Mail,
    /// A call is waiting for it.
    Waiter(oneshot::Sender<Report>),
}

/// What a round of work came to: from the first task after being idle until idle again.
pub(crate) struct Report {
    pub(crate) status: AgentStatus,
    /// The last reply.
    pub(crate) reply: Option<String>,
    pub(crate) error: Option<ErrorInfo>,
    /// Messages from the main agent that a stop left unprocessed.
    pub(crate) unprocessed: Vec<String>,
    pub(crate) usage: UsageTotals,
    pub(crate) elapsed: Duration,
}

impl AgentTree {
    pub(crate) fn new(deps: ChildDeps) -> Arc<Self> {
        Arc::new(Self {
            deps,
            root: OnceLock::new(),
            state: Mutex::new(TreeState::default()),
        })
    }

    pub(crate) fn bind_root(&self, session: &Arc<Session>, internal: mpsc::UnboundedSender<Box<Internal>>) {
        let _ = self.root.set(Root {
            session: Arc::downgrade(session),
            emitter: session.emitter.clone(),
            internal,
        });
    }

    fn root(&self) -> Result<Arc<Session>, ToolError> {
        self.root
            .get()
            .and_then(|root| root.session.upgrade())
            .ok_or_else(|| ToolError::Failed("the session is closing".into()))
    }

    fn emit(&self, msg: EventMsg) {
        if let Some(root) = self.root.get() {
            root.emitter.emit(msg);
        }
    }

    /// The agents of an earlier run of the session (by id and name).
    pub(crate) fn restore(&self, agents: &[RestoredAgent]) {
        self.state.lock().restored = agents.iter().map(|a| (a.agent_id.clone(), a.name.clone())).collect();
    }

    /// Every sub-agent is idle and no report is on its way.
    pub(crate) fn settled(&self) -> bool {
        let state = self.state.lock();
        state.in_flight == 0 && state.agents.iter().all(|a| a.status != AgentStatus::Running)
    }

    /// The main session took a report into its inbox.
    pub(crate) fn mail_received(&self) {
        let mut state = self.state.lock();
        state.in_flight = state.in_flight.saturating_sub(1);
    }

    /// Sub-agents judge tool calls by the main session's current permissions.
    pub(crate) fn share_permissions(&self, mode: PermissionMode, rules: Vec<CommandRule>, grants: Vec<finx_protocol::SiteGrant>) {
        let state = self.state.lock();
        for agent in state.agents.iter().filter(|a| a.status != AgentStatus::Closed) {
            let _ = agent.internal.send(Box::new(Internal::Permissions {
                mode,
                rules: rules.clone(),
                grants: grants.clone(),
            }));
        }
    }

    /// Stops what every sub-agent is doing. Their sessions stay; a message continues them.
    pub(crate) fn interrupt_all(&self) {
        let state = self.state.lock();
        for agent in state.agents.iter().filter(|a| a.status == AgentStatus::Running) {
            send_now(&agent.ops, Op::Interrupt);
        }
    }

    /// Stops one sub-agent's current task (`agent_interrupt`). False when no agent of that id or
    /// name is running.
    pub(crate) fn interrupt_one(&self, agent: &str) -> bool {
        let state = self.state.lock();
        let Some(agent) = state
            .agents
            .iter()
            .find(|a| (a.id == agent || a.name == agent) && a.status == AgentStatus::Running)
        else {
            return false;
        };
        send_now(&agent.ops, Op::Interrupt);
        true
    }

    /// Passes an event of agent `id`'s session on to the main session's clients (`agent_event`).
    fn forward(&self, id: &str, event: &Event) {
        if followed(&event.msg) {
            self.emit(EventMsg::AgentEvent {
                agent_id: id.to_string(),
                event: Box::new(event.clone()),
            });
        }
    }

    /// Closes every sub-agent's session and waits until their logs are closed.
    pub(crate) async fn shutdown(&self) {
        let agents: Vec<(mpsc::Sender<Op>, Option<JoinHandle<()>>)> = {
            let mut state = self.state.lock();
            state.closing = true;
            state.agents.iter_mut().map(|a| (a.ops.clone(), a.driver.take())).collect()
        };
        for (ops, _) in &agents {
            let _ = ops.send(Op::Shutdown).await;
        }
        let drivers = agents.into_iter().filter_map(|(_, driver)| driver);
        let _ = tokio::time::timeout(Duration::from_secs(5), futures::future::join_all(drivers)).await;
    }

    pub(crate) async fn spawn(
        self: &Arc<Self>,
        args: tools::SpawnArgs,
        call_id: &str,
        cancel: &CancellationToken,
    ) -> Result<ToolOutput, ToolError> {
        let task = args.task.trim();
        if task.is_empty() {
            return Err(ToolError::InvalidArgs("task must not be empty".into()));
        }
        let root = self.root()?;
        let (system_prompt, base_prompt, mcp_section, skills, model, thinking, permission_mode, session_rules, site_grants, parent_task) = {
            let state = root.state.lock();
            (
                state.system_prompt.clone(),
                state.base_prompt.clone(),
                state.mcp_section.clone(),
                state.skills.clone(),
                state.model.clone(),
                state.thinking,
                state.permission_mode,
                state.session_rules.clone(),
                state.site_grants.clone(),
                state.active_task.as_ref().map(|t| t.id.clone()).unwrap_or_default(),
            )
        };
        let name = self.unique_name(args.name.as_deref())?;
        let id = uuid::Uuid::now_v7().to_string();
        let mut header = SessionHeader::new(id.clone(), root.env.cwd().to_path_buf());
        header.agent = Some(AgentOrigin {
            root_id: root.id.clone(),
            parent_id: root.id.clone(),
            name: name.clone(),
            depth: 1,
            call_id: call_id.to_string(),
            parent_task,
        });
        let kernel = kernel::start_child(ChildLaunch {
            header,
            system_prompt,
            base_prompt,
            mcp_section,
            mcp: self.deps.mcp.clone(),
            skills,
            model,
            thinking,
            permission_mode,
            session_rules,
            site_grants,
            deps: KernelDeps {
                llm: self.deps.llm.clone(),
                tools: self.deps.tools.clone(),
                env: self.deps.env.clone(),
                store: self.deps.store.clone(),
                hooks: self.deps.hooks.clone(),
                mcp_servers: Vec::new(),
                browser_pool: self.deps.browser_pool.clone(),
                docs: self.deps.docs.clone(),
            },
            home: self.deps.home.clone(),
            config: self.deps.config.clone(),
            system: root.system.clone(),
            trusted: self.deps.trusted,
            locks: root.locks.clone(),
        })
        .map_err(|err| ToolError::Failed(format!("cannot start the agent: {err}")))?;
        let session_file: PathBuf = kernel.session_file().to_path_buf();
        let ops = kernel.op_sender();
        let (route, waiter) = route(args.wait);
        self.state.lock().agents.push(Agent {
            id: id.clone(),
            name: name.clone(),
            status: AgentStatus::Running,
            ops: ops.clone(),
            internal: kernel.internal.clone(),
            route,
            redirect: false,
            driver: None,
            tool_state: kernel.tool_state(),
        });
        let description = args.description.trim().to_string();
        root.record(EntryKind::AgentSpawned(Box::new(AgentSpawnedEntry {
            agent_id: id.clone(),
            name: name.clone(),
            description: description.clone(),
            session_file: session_file.clone(),
            call_id: call_id.to_string(),
        })));
        self.emit(EventMsg::AgentStarted {
            agent_id: id.clone(),
            name: name.clone(),
            description,
            session_file: session_file.clone(),
            call_id: call_id.to_string(),
        });
        let driver = tokio::spawn(driver::drive(self.clone(), id.clone(), kernel));
        if let Some(agent) = self.state.lock().agents.iter_mut().find(|a| a.id == id) {
            agent.driver = Some(driver);
        }
        let _ = ops
            .send(Op::Prompt {
                input: vec![UserContent::Text {
                    text: mail::task_message(&name, task),
                }],
                mode: PromptMode::Steer,
                // A task brief is not the user's input: a leading `/name` stays text.
                commands: false,
            })
            .await;
        // `background`: the report arrives later, as mail; `reported`: this result is the report.
        let details = |reported: bool| {
            json!({ "agent_id": id, "name": name, "session_file": session_file, "status": "running", "background": !reported, "reported": reported })
        };
        match waiter {
            Some(rx) => {
                let (output, reported) = self.wait(&root, &id, &name, rx, cancel).await?;
                Ok(output.with_details(details(reported)))
            }
            None => Ok(ToolOutput::text(format!(
                "Agent \"{name}\" started in the background. {REPORT_LATER}"
            ))
            .with_details(details(false))),
        }
    }

    pub(crate) async fn send(&self, args: tools::SendArgs, cancel: &CancellationToken) -> Result<ToolOutput, ToolError> {
        let message = args.message.trim();
        if message.is_empty() {
            return Err(ToolError::InvalidArgs("message must not be empty".into()));
        }
        let root = self.root()?;
        let (id, name, ops, was_running, waiter) = {
            let mut state = self.state.lock();
            let names: Vec<String> = state.restored.iter().map(|(_, name)| name.clone()).chain(state.agents.iter().map(|a| a.name.clone())).collect();
            let to = args.to.trim();
            if let Some((_, name)) = state.restored.iter().find(|(id, name)| name == to || id == to) {
                return Err(ToolError::Failed(format!("Agent \"{name}\" is closed. Start a new one with spawn_agent.")));
            }
            let Some(agent) = state.agents.iter_mut().find(|a| a.name == to || a.id == to) else {
                return Err(ToolError::Failed(if names.is_empty() {
                    format!("No agent named \"{to}\". Start one with spawn_agent.")
                } else {
                    format!("No agent named \"{to}\". Your agents: {}.", names.join(", "))
                }));
            };
            if agent.status == AgentStatus::Closed {
                return Err(ToolError::Failed(format!(
                    "Agent \"{}\" is closed. Start a new one with spawn_agent.",
                    agent.name
                )));
            }
            let waiter = if args.wait {
                if matches!(agent.route, Route::Waiter(_)) {
                    return Err(ToolError::Failed(format!("Another call is already waiting for \"{}\".", agent.name)));
                }
                let (route, waiter) = route(true);
                agent.route = route;
                waiter
            } else {
                None
            };
            let was_running = agent.status == AgentStatus::Running;
            if args.interrupt && was_running {
                agent.redirect = true;
            }
            // Busy from now on: the message starts work, so the main session is not idle.
            agent.status = AgentStatus::Running;
            (agent.id.clone(), agent.name.clone(), agent.ops.clone(), was_running, waiter)
        };
        if !was_running {
            self.emit(status_event(&id, &name, AgentStatus::Running, None));
        }
        if args.interrupt && was_running {
            let _ = ops.send(Op::Interrupt).await;
        }
        let _ = ops
            .send(Op::Prompt {
                input: vec![UserContent::Text {
                    text: message.to_string(),
                }],
                mode: PromptMode::Steer,
                commands: false,
            })
            .await;
        // As spawn_agent's: `background` when this starts a round of work that reports by mail.
        let details = |background: bool, reported: bool| {
            json!({ "agent_id": id, "name": name, "background": background, "reported": reported })
        };
        match waiter {
            Some(rx) => {
                let (output, reported) = self.wait(&root, &id, &name, rx, cancel).await?;
                Ok(output.with_details(details(!reported && !was_running, reported)))
            }
            None if was_running => Ok(ToolOutput::text(if args.interrupt {
                format!("\"{name}\" started working on your message. {REPORT_LATER}")
            } else {
                format!("Queued for \"{name}\"; it reads the message at its next step.")
            })
            .with_details(details(false, false))),
            None => Ok(ToolOutput::text(format!(
                "\"{name}\" started working on your message. {REPORT_LATER}"
            ))
            .with_details(details(true, false))),
        }
    }

    /// Waits for the report of `id`'s current round of work. New input from the user ends the
    /// wait early; the report then arrives as mail. True with the output when it is the report.
    async fn wait(
        &self,
        root: &Session,
        id: &str,
        name: &str,
        mut rx: oneshot::Receiver<Report>,
        cancel: &CancellationToken,
    ) -> Result<(ToolOutput, bool), ToolError> {
        let mut input = root.input_seq.subscribe();
        input.borrow_and_update();
        let report = tokio::select! {
            report = &mut rx => match report {
                Ok(report) => report,
                Err(_) => return Err(ToolError::Failed(format!("Agent \"{name}\" stopped without a report."))),
            },
            _ = cancel.cancelled() => match self.stop_waiting(id, &mut rx) {
                Some(report) => report,
                None => return Err(ToolError::Cancelled),
            },
            _ = input.changed() => match self.stop_waiting(id, &mut rx) {
                Some(report) => report,
                None => return Ok((ToolOutput::text(format!(
                    "Stopped waiting because the user sent a new message. Agent \"{name}\" keeps running. {REPORT_LATER}"
                )), false)),
            },
        };
        Ok((ToolOutput::text(mail::waited(name, &report)), true))
    }

    /// A waiting call gives up. The report goes by mail instead, unless it has just arrived.
    fn stop_waiting(&self, id: &str, rx: &mut oneshot::Receiver<Report>) -> Option<Report> {
        {
            let mut state = self.state.lock();
            if let Some(agent) = state.agents.iter_mut().find(|a| a.id == id)
                && matches!(agent.route, Route::Waiter(_))
            {
                agent.route = Route::Mail;
                return None;
            }
        }
        rx.try_recv().ok()
    }

    fn unique_name(&self, requested: Option<&str>) -> Result<String, ToolError> {
        let state = self.state.lock();
        if state.closing {
            return Err(ToolError::Failed("the session is closing".into()));
        }
        let taken = |name: &str| state.agents.iter().any(|a| a.name == name) || state.restored.iter().any(|(_, n)| n == name);
        let requested = requested.map(sanitize).filter(|name| !name.is_empty());
        if let Some(name) = &requested
            && !taken(name)
        {
            return Ok(name.clone());
        }
        let (stem, first) = match requested {
            Some(name) => (name, 2),
            None => ("agent".to_string(), 1),
        };
        Ok((first..)
            .map(|n| format!("{stem}-{n}"))
            .find(|name| !taken(name))
            .unwrap_or(stem))
    }

    /// The agent started a task: busy, if it was idle.
    fn running(&self, id: &str) {
        let name = {
            let mut state = self.state.lock();
            match state.agents.iter_mut().find(|a| a.id == id) {
                Some(agent) if !matches!(agent.status, AgentStatus::Running | AgentStatus::Closed) => {
                    agent.status = AgentStatus::Running;
                    Some(agent.name.clone())
                }
                _ => None,
            }
        };
        if let Some(name) = name {
            self.emit(status_event(id, &name, AgentStatus::Running, None));
        }
    }

    fn take_redirect(&self, id: &str) -> bool {
        let mut state = self.state.lock();
        state
            .agents
            .iter_mut()
            .find(|a| a.id == id)
            .is_some_and(|a| std::mem::take(&mut a.redirect))
    }

    /// The agent has nothing left to do: its report goes to the waiting call or by mail.
    fn settle(&self, id: &str, report: Report) {
        let handover = {
            let mut state = self.state.lock();
            let closing = state.closing;
            let Some(agent) = state.agents.iter_mut().find(|a| a.id == id) else {
                return;
            };
            agent.status = report.status;
            agent.redirect = false;
            // A finished agent keeps its session for later messages, but not its tabs
            // (browser-design D-206); a later browser call starts afresh.
            if let Some(tool_state) = &agent.tool_state {
                tool_state.remove::<finx_browser::BrowserSession>();
            }
            let route = std::mem::replace(&mut agent.route, Route::Mail);
            let name = agent.name.clone();
            if closing {
                None
            } else {
                // Counted until it arrives, so that the main session cannot go idle before.
                state.in_flight += 1;
                Some((name, route))
            }
        };
        let Some((name, route)) = handover else {
            return;
        };
        let mut event = status_event(id, &name, report.status, Some(&report));
        if let EventMsg::AgentStatus { error, .. } = &mut event {
            error.clone_from(&report.error);
        }
        self.emit(event);
        self.hand_over(id, &name, route, report);
    }

    /// The agent's session ended. Unless the tree is closing, that was unexpected.
    fn closed(&self, id: &str, unexpected: bool) {
        let handover = {
            let mut state = self.state.lock();
            let closing = state.closing;
            let Some(agent) = state.agents.iter_mut().find(|a| a.id == id) else {
                return;
            };
            agent.status = AgentStatus::Closed;
            let route = std::mem::replace(&mut agent.route, Route::Mail);
            let name = agent.name.clone();
            if closing || !unexpected {
                None
            } else {
                state.in_flight += 1;
                Some((name, route))
            }
        };
        let Some((name, route)) = handover else {
            return;
        };
        self.emit(status_event(id, &name, AgentStatus::Closed, None));
        let report = Report {
            status: AgentStatus::Failed,
            reply: None,
            error: Some(ErrorInfo::new("closed", "the agent's session stopped unexpectedly")),
            unprocessed: Vec::new(),
            usage: UsageTotals::default(),
            elapsed: Duration::ZERO,
        };
        self.hand_over(id, &name, route, report);
    }

    /// Gives a report to the waiting call, or else sends it to the main session as mail.
    /// The caller counted it as in flight.
    fn hand_over(&self, id: &str, name: &str, route: Route, report: Report) {
        let report = match route {
            Route::Waiter(tx) => match tx.send(report) {
                Ok(()) => {
                    self.mail_received();
                    return;
                }
                Err(report) => report,
            },
            Route::Mail => report,
        };
        let sent = self.root.get().zip(self.root.get().and_then(|r| r.session.upgrade())).is_some_and(|(link, root)| {
            let seq = {
                let mut state = self.state.lock();
                state.mails += 1;
                state.mails
            };
            let from = AgentRef {
                id: id.to_string(),
                name: name.to_string(),
            };
            link.internal.send(Box::new(Internal::Mail(Mail::report(&root, from, &report, seq)))).is_ok()
        });
        if !sent {
            tracing::debug!(agent = %name, "the main session is gone; report dropped");
            self.mail_received();
        }
    }
}

/// `agent_status`; an idle status also carries the start of the report and its cost.
fn status_event(id: &str, name: &str, status: AgentStatus, report: Option<&Report>) -> EventMsg {
    EventMsg::AgentStatus {
        agent_id: id.to_string(),
        name: name.to_string(),
        status,
        summary: report.and_then(mail::summary),
        usage: report.map(|r| r.usage.clone()),
        error: None,
        elapsed_ms: report.map(|r| r.elapsed.as_millis() as u64),
    }
}

/// What a client following a sub-agent needs of its events: what changes its conversation.
fn followed(msg: &EventMsg) -> bool {
    matches!(
        msg,
        EventMsg::TaskStarted { .. }
            | EventMsg::TurnStarted { .. }
            | EventMsg::MessageCompleted { .. }
            | EventMsg::StreamRetry { .. }
            | EventMsg::ToolStarted { .. }
            | EventMsg::ToolRunning { .. }
            | EventMsg::ToolCompleted { .. }
            | EventMsg::CompactionStarted { .. }
            | EventMsg::CompactionCompleted { .. }
            | EventMsg::CompactionFailed { .. }
            | EventMsg::TurnCompleted { .. }
            | EventMsg::TaskCompleted { .. }
            | EventMsg::TaskFailed { .. }
            | EventMsg::TaskInterrupted { .. }
            | EventMsg::Warning { .. }
    )
}

fn route(wait: bool) -> (Route, Option<oneshot::Receiver<Report>>) {
    if wait {
        let (tx, rx) = oneshot::channel();
        (Route::Waiter(tx), Some(rx))
    } else {
        (Route::Mail, None)
    }
}

/// Sends without waiting; a full channel gets the op from a task instead.
fn send_now(ops: &mpsc::Sender<Op>, op: Op) {
    if let Err(mpsc::error::TrySendError::Full(op)) = ops.try_send(op) {
        let ops = ops.clone();
        tokio::spawn(async move {
            let _ = ops.send(op).await;
        });
    }
}

/// A name the model can type: lowercase letters, digits, '-' and '_', at most 32 characters.
fn sanitize(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() || c == '_' {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 32 {
            break;
        }
    }
    out.trim_end_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_made_typeable() {
        assert_eq!(sanitize("  Explore API  "), "explore-api");
        assert_eq!(sanitize("tests/parser!!"), "tests-parser");
        assert_eq!(sanitize("测试"), "");
        assert_eq!(sanitize(&"a".repeat(40)).len(), 32);
    }
}
