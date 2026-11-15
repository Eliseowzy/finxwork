//! Task lifecycle and the agent loop.

use futures::FutureExt;
use futures::StreamExt;
use finx_llm::AssistantContent;
use finx_llm::AssistantMessage;
use finx_llm::JsonText;
use finx_llm::Context;
use finx_llm::ErrorKind;
use finx_llm::LlmError;
use finx_llm::Message;
use finx_llm::MessageAccumulator;
use finx_llm::Model;
use finx_llm::RequestOptions;
use finx_llm::StopReason;
use finx_llm::StreamEvent;
use finx_llm::ThinkingLevel;
use finx_llm::ToolCall;
use finx_llm::UsageTotals;
use finx_llm::UserContent;
use finx_llm::UserMessage;
use finx_tools::ToolOutput;
use finx_llm::now_ms;
use finx_protocol::CompactionReason;
use finx_protocol::CompletionReason;
use finx_protocol::Delta;
use finx_protocol::ErrorInfo;
use finx_protocol::EventMsg;
use finx_protocol::MailKind;
use finx_protocol::PromptMode;
use finx_protocol::Role;
use finx_protocol::TaskTrigger;
use parking_lot::Mutex;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use tokio_util::sync::CancellationToken;

use crate::agents::Mail;
use crate::bot::Owed;
use crate::commands::Command;
use crate::compaction;
use crate::compaction::CompactError;
use crate::hooks::TurnDecision;
use crate::peer::PeerError;
use crate::peer::PeerEvent;
use crate::peer::PeerImage;
use crate::peer::PeerMessage;
use crate::peer::PeerThread;
use crate::session::ActiveTask;
use crate::session::Input;
use crate::session::Resend;
use crate::session::Session;
use crate::session::SessionState;
use crate::store::EntryKind;
use crate::store::TaskStatus;
use crate::tool_exec;
use serde_json::Value;
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;

/// After this many compactions in one task, the user hears that detail may be getting lost.
const MANY_COMPACTIONS: u32 = 3;

/// The failure of a bot's task that sent nothing, even reminded.
const NO_REPLY: &str = "no_reply";

pub(crate) struct TaskCtx {
    pub(crate) id: String,
    pub(crate) cancel: CancellationToken,
    /// The running turn's token, a child of `cancel`, shared with the session's `ActiveTask`:
    /// the model's reply and the tool calls stop on it, so `steer_now` ends the turn alone.
    turn: Arc<Mutex<CancellationToken>>,
    pub(crate) usage: Mutex<UsageTotals>,
    /// A call of the running batch asked to end the task after it (`ToolOutput::ends_task`).
    end_requested: AtomicBool,
}

impl TaskCtx {
    pub(crate) fn turn(&self) -> CancellationToken {
        self.turn.lock().clone()
    }

    pub(crate) fn request_end(&self) {
        self.end_requested.store(true, Ordering::Relaxed);
    }

    fn take_end_request(&self) -> bool {
        self.end_requested.swap(false, Ordering::Relaxed)
    }

    fn next_turn(&self) {
        *self.turn.lock() = self.cancel.child_token();
    }
}

pub(crate) enum TaskOutcome {
    Completed {
        last_message: Option<String>,
        reason: CompletionReason,
    },
    Failed(ErrorInfo),
    Interrupted,
}

/// What a task does.
enum Work {
    /// The agent loop, starting with this message (none: continue the current history).
    Prompt(Option<Input>),
    /// Only a compaction (`Op::Compact`).
    Compact,
    /// Only the context report (`/context`).
    Context,
    /// An external bot's session picks up a task the other side has not ended
    /// (bot-contacts-design §5.5).
    ResumePeer,
}

pub(crate) fn on_prompt(session: &Arc<Session>, input: Vec<UserContent>, mode: PromptMode, commands: bool) {
    // A word after `/` is a word for the other side, not a command (bot-contacts-design §5.4).
    let commands = commands && session.peer.is_none();
    let mut skills = Vec::new();
    if commands {
        let known = session.state.lock().skills.clone();
        match crate::commands::resolve(&input, &known, &session.config.limits) {
            Command::Compact => return on_compact_command(session),
            Command::Context => return on_context_command(session),
            Command::Prompt { skills: loaded, warnings } => {
                for warning in warnings {
                    session.warn(warning);
                }
                skills = loaded;
            }
        }
    }
    let message = {
        let mut state = session.state.lock();
        // New input ends the hold after an interruption.
        state.hold = false;
        let message = Input {
            id: state.input_id(),
            message: UserMessage {
                content: input,
                ts: now_ms(),
            },
            skills,
        };
        if state.active_task.is_some() {
            match mode {
                PromptMode::Steer => state.steer.push_back(message),
                PromptMode::FollowUp => state.follow_up.push_back(message),
            }
            session.emit_queue(&state);
            session.input_seq.send_modify(|n| *n += 1);
            return;
        }
        message
    };
    start_task(session, Some(message));
}

/// `resend`: starts again from an earlier message of the user's. Everything happens now, as one
/// step: a running task stops first, and then the conversation goes back and the new input
/// starts the next task. Until then the session is as it was.
pub(crate) fn on_resend(session: &Arc<Session>, message_id: String, input: Vec<UserContent>, commands: bool) {
    if session.peer.is_some() {
        // The other side cannot go back to a point in the conversation (bot-contacts-design §5.3).
        session.warn("an external bot's conversation does not go back");
        return;
    }
    {
        let state = session.state.lock();
        let refused = if state.bot.is_some() {
            Some("a bot's conversation does not go back")
        } else if state.pending_resend.is_some() {
            Some("another resend is waiting for the running task to stop")
        } else if !state.has_user_message(&message_id) {
            Some("that message is not in the conversation")
        } else if input.iter().all(|c| matches!(c, UserContent::Text { text } if text.trim().is_empty())) {
            Some("there is nothing to send")
        } else {
            None
        };
        if let Some(why) = refused {
            return session.reject_resend(why);
        }
    }
    let mut skills = Vec::new();
    if commands {
        let known = session.state.lock().skills.clone();
        match crate::commands::resolve(&input, &known, &session.config.limits) {
            // Not a message: sending it from there would go back and send nothing.
            Command::Compact | Command::Context => return session.reject_resend("a command is not a message"),
            Command::Prompt { skills: loaded, warnings } => {
                for warning in warnings {
                    session.warn(warning);
                }
                skills = loaded;
            }
        }
    }
    let next = {
        let mut guard = session.state.lock();
        let state = &mut *guard;
        let resend = Resend {
            target: message_id,
            input: Input {
                id: state.input_id(),
                message: UserMessage {
                    content: input,
                    ts: now_ms(),
                },
                skills,
            },
        };
        match &state.active_task {
            // This alone, not the sub-agents as a stop does: those started earlier work on.
            Some(task) => {
                task.cancel.cancel();
                state.pending_resend = Some(resend);
                None
            }
            None => Some(go_back(session, state, resend)),
        }
    };
    if let Some((task, input)) = next {
        launch(session, task, Work::Prompt(Some(input)), TaskTrigger::User);
    }
}

/// Goes back as `resend` says, and reserves the task that goes on from there. Under the state
/// lock, so that input arriving meanwhile waits for that task.
fn go_back(session: &Session, state: &mut SessionState, resend: Resend) -> (TaskCtx, Input) {
    let returned_input = hand_back(session, state);
    session.rewind(state, &resend.target, returned_input);
    (reserve(state), resend.input)
}

/// A sub-agent's report or message arrived. It joins the history at the next turn boundary, or
/// starts a task when nothing runs and it is the kind that does.
pub(crate) fn on_mail(session: &Arc<Session>, mail: Mail) {
    // From an agent a `resend` removed, it belongs to what was taken back; a sub-agent's session,
    // with no list of its own, hears only from agents at work. A routine's run is on
    // no such list, and a bot's conversation does not go back.
    let kept = mail.info.kind == MailKind::Routine || session.agents.as_ref().is_none_or(|tree| tree.has(&mail.info.from.id));
    let wake = {
        let mut state = session.state.lock();
        if kept {
            state.inbox.push_back(mail);
        }
        state.active_task.is_none() && state.has_waking_mail()
    };
    if let Some(tree) = &session.agents {
        tree.mail_received();
    }
    if wake {
        start(session, Work::Prompt(None), TaskTrigger::Mail);
    } else {
        session.check_idle();
    }
}

pub(crate) fn on_continue(session: &Arc<Session>) {
    if session.peer.is_some() {
        session.warn("nothing to continue: an external bot answers from the other side");
        return;
    }
    if session.is_busy() {
        session.warn("a task is already running");
        return;
    }
    match session.build_context().messages.last() {
        Some(Message::User(_)) | Some(Message::ToolResult(_)) => start_task(session, None),
        // A bot that ended up silent: retrying asks it again (bot-design §3.11).
        _ => match session.owed().reminder() {
            Some(reminder) => {
                session.record(reminder);
                start_task(session, None);
            }
            None => session.warn("nothing to continue: the conversation already ends with a complete reply"),
        },
    }
}

pub(crate) fn on_compact(session: &Arc<Session>) {
    if session.peer.is_some() {
        session.warn("an external bot's conversation is not compacted: it lives on the other side");
        return;
    }
    if session.is_busy() {
        session.warn("a task is running; compact after it ends");
        return;
    }
    if !compaction::can_compact(session) {
        session.warn("nothing to compact");
        return;
    }
    start(session, Work::Compact, TaskTrigger::User);
}

/// `/compact` typed as a message. Unlike `Op::Compact` it runs as a task even when there is
/// nothing to compact, so that a front end waiting for the reply (ACP, `finx exec`) gets one.
fn on_compact_command(session: &Arc<Session>) {
    if session.is_busy() {
        // The running task's end answers the front end.
        session.warn("a task is running; compact after it ends");
        return;
    }
    start(session, Work::Compact, TaskTrigger::User);
}

/// `/context` typed as a message: the report, in a task of its own so that a front end waiting
/// for the reply gets one; while a task runs, the report alone (that task's end answers).
fn on_context_command(session: &Arc<Session>) {
    if session.is_busy() {
        session.emit(EventMsg::ContextReported {
            report: session.context_report(),
        });
        return;
    }
    start(session, Work::Context, TaskTrigger::User);
}

pub(crate) fn start_task(session: &Arc<Session>, input: Option<Input>) {
    start(session, Work::Prompt(input), TaskTrigger::User);
}

fn start(session: &Arc<Session>, work: Work, trigger: TaskTrigger) {
    let task = reserve(&mut session.state.lock());
    launch(session, task, work, trigger);
}

/// Makes the session busy with a new task. Under the state lock, so that input arriving
/// meanwhile waits for it instead of starting a task of its own.
fn reserve(state: &mut SessionState) -> TaskCtx {
    let cancel = CancellationToken::new();
    let turn = Arc::new(Mutex::new(cancel.child_token()));
    state.idle = false;
    state.next_task_no += 1;
    let id = format!("t{}", state.next_task_no);
    state.active_task = Some(ActiveTask {
        id: id.clone(),
        cancel: cancel.clone(),
        turn: turn.clone(),
        handle: None,
    });
    TaskCtx {
        id,
        cancel,
        turn,
        usage: Mutex::new(UsageTotals::default()),
        end_requested: AtomicBool::new(false),
    }
}

fn launch(session: &Arc<Session>, task: TaskCtx, work: Work, trigger: TaskTrigger) {
    let id = task.id.clone();
    let handle = tokio::spawn(task_main(session.clone(), task, work, trigger));
    let mut state = session.state.lock();
    if let Some(active) = state.active_task.as_mut()
        && active.id == id
    {
        active.handle = Some(handle);
    }
}

async fn task_main(session: Arc<Session>, task: TaskCtx, work: Work, trigger: TaskTrigger) {
    session.emit(EventMsg::TaskStarted {
        task_id: task.id.clone(),
        trigger,
    });
    // A report changes nothing: the log keeps no trace of it.
    let recorded = !matches!(work, Work::Context);
    if recorded {
        session.record(EntryKind::Task {
            task_id: task.id.clone(),
            status: TaskStatus::Started,
            error: None,
            reason: None,
            usage: None,
        });
    }
    let run = async {
        match work {
            // An external bot's session has no model to run: the other side answers
            // (bot-contacts-design §5.3).
            Work::Prompt(input) if session.peer.is_some() => run_peer_task(&session, &task, input).await,
            Work::ResumePeer => run_peer_task(&session, &task, None).await,
            Work::Prompt(input) => run_task(&session, &task, input).await,
            Work::Compact => run_compaction(&session, &task).await,
            Work::Context => {
                session.emit(EventMsg::ContextReported {
                    report: session.context_report(),
                });
                TaskOutcome::Completed {
                    last_message: None,
                    reason: CompletionReason::Done,
                }
            }
        }
    };
    let outcome = match AssertUnwindSafe(run).catch_unwind().await {
        Ok(outcome) => outcome,
        Err(panic) => {
            let message = panic
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            tracing::error!(task = %task.id, %message, "task panicked");
            TaskOutcome::Failed(ErrorInfo::new("internal", format!("internal error: {message}")))
        }
    };
    finish_task(&session, &task, outcome, recorded).await;
}

async fn finish_task(session: &Arc<Session>, task: &TaskCtx, outcome: TaskOutcome, recorded: bool) {
    let (status, error, reason) = match &outcome {
        TaskOutcome::Completed { reason, .. } => (TaskStatus::Completed, None, Some(*reason)),
        TaskOutcome::Failed(error) => (TaskStatus::Failed, Some(error.clone()), None),
        TaskOutcome::Interrupted => (TaskStatus::Interrupted, None, None),
    };
    let usage = task.usage.lock().clone();
    if recorded {
        session.record(EntryKind::Task {
            task_id: task.id.clone(),
            status,
            error: error.map(Box::new),
            reason,
            usage: Some(Box::new(usage.clone())),
        });
        if let Err(err) = session.writer.sync().await {
            session.warn(format!("failed to save the session log: {err}"));
        }
    }
    let next = {
        let mut guard = session.state.lock();
        let state = &mut *guard;
        if state.active_task.as_ref().is_some_and(|t| t.id == task.id) {
            state.active_task = None;
        }
        // No call is open now, and the next boundary may be a long way off.
        session.write_all_told(state);
        // A `resend` waited for this end, however it came: it takes what still waits, below.
        let resend = state.pending_resend.take();
        let going_back = resend.is_some();
        let next_input = match outcome {
            TaskOutcome::Completed { last_message, reason } => {
                session.emit(EventMsg::TaskCompleted {
                    task_id: task.id.clone(),
                    usage,
                    last_message,
                    reason,
                });
                if going_back { None } else { take_next(session, state) }
            }
            TaskOutcome::Failed(error) => {
                // A bot's silence says nothing against the model: input that came after the task's
                // last look at the queue is answered, as it is a moment later (bot-design §3.11).
                let silent = error.kind == NO_REPLY;
                let returned_input = if going_back || silent { Vec::new() } else { hand_back(session, state) };
                session.emit(EventMsg::TaskFailed {
                    task_id: task.id.clone(),
                    error,
                    usage,
                    returned_input,
                });
                if silent { take_next(session, state) } else { None }
            }
            TaskOutcome::Interrupted => {
                let returned_input = if going_back { Vec::new() } else { hand_back(session, state) };
                // Stopped on purpose: reports do not restart the work until new input arrives.
                state.hold = !going_back;
                session.emit(EventMsg::TaskInterrupted {
                    task_id: task.id.clone(),
                    returned_input,
                    usage,
                });
                None
            }
        };
        // Reports that arrived while the reply was being written start a task of their own,
        // after the reply is complete. The next task is the session's before the lock goes, so
        // input arriving meanwhile waits for it instead of starting another.
        match (resend, next_input) {
            (Some(resend), _) => {
                let (next, input) = go_back(session, state, resend);
                Some((next, Work::Prompt(Some(input)), TaskTrigger::User))
            }
            (None, Some(input)) => Some((reserve(state), Work::Prompt(Some(input)), TaskTrigger::User)),
            (None, None) if state.has_waking_mail() => Some((reserve(state), Work::Prompt(None), TaskTrigger::Mail)),
            (None, None) => None,
        }
    };
    match next {
        Some((task, work, trigger)) => launch(session, task, work, trigger),
        None => {
            crate::browser::task_ended(&session.tool_state);
            session.check_idle();
        }
    }
}

/// Input that arrived after the last turn boundary starts the next task.
fn take_next(session: &Session, state: &mut SessionState) -> Option<Input> {
    let next = state.steer.pop_front().or_else(|| state.follow_up.pop_front());
    if next.is_some() {
        session.emit_queue(state);
    }
    next
}

/// A task that ends early hands what still waits back to the front end, in the order it would
/// have joined the history.
fn hand_back(session: &Session, state: &mut SessionState) -> Vec<UserMessage> {
    if state.steer.is_empty() && state.follow_up.is_empty() {
        return Vec::new();
    }
    let returned = state
        .steer
        .drain(..)
        .chain(state.follow_up.drain(..))
        .map(|input| input.message)
        .collect();
    session.emit_queue(state);
    returned
}

/// Compaction state of one task.
#[derive(Default)]
struct Compactions {
    /// Compacted since the last successful response. Compacting again before a response could
    /// not shrink the context further, so it is not tried: no compaction loops.
    since_response: bool,
    /// Compactions in this task.
    count: u32,
}

impl Compactions {
    fn done(&mut self, session: &Session) {
        self.since_response = true;
        self.count += 1;
        if self.count == MANY_COMPACTIONS {
            session.warn(format!(
                "the context has been compacted {MANY_COMPACTIONS} times in this task; summaries lose detail \
                 each time, so consider splitting the task or a model with a larger window"
            ));
        }
    }
}

async fn run_task(session: &Arc<Session>, task: &TaskCtx, input: Option<Input>) -> TaskOutcome {
    // A new date first, then reports that arrived before this task, then the input that
    // started it.
    session.note_date();
    session.deliver_mail();
    if let Some(message) = input {
        session.record_user(message);
    }
    let max_turns = session.config.max_turns;
    let mut turn: u32 = 0;
    let mut last_message: Option<String> = None;
    let mut compactions = Compactions::default();
    let mut reminded = false;
    // The next request is a reminder's: what came meanwhile joins after it.
    let mut hold_input = false;
    loop {
        // Turn boundary: reports first, then queued steering input, so the user has the last word.
        if !hold_input {
            // A routine's report is new, as the owner's next words are.
            if session.deliver_mail() {
                reminded = false;
            }
            for message in session.take_steer() {
                session.record_user(message);
                // The owner's next words count anew.
                reminded = false;
            }
        }
        session.apply_pending_model();
        // System connectors' and MCP tools join or change only here, between requests.
        session.prepare_system();
        if let Err(error) = session.prepare_mcp(&task.cancel, turn == 0).await {
            return TaskOutcome::Failed(error);
        }
        if task.cancel.is_cancelled() {
            return TaskOutcome::Interrupted;
        }
        // Every request is checked first: each turn, each new task, after a resume.
        if let Err(outcome) = check_context(session, task, &mut compactions).await {
            return outcome;
        }
        // Past midnight, or a compaction left only the system prompt's date; the same for a
        // bot's name.
        session.note_date();
        session.note_bot_name();
        session.note_routines();
        // The turn starts: `steer_now` ends it alone. Steering input that came while the MCP
        // servers or a compaction were awaited makes this request too.
        task.next_turn();
        if !hold_input {
            for message in session.take_steer() {
                session.record_user(message);
                reminded = false;
            }
        }
        hold_input = false;
        let (model, thinking) = session.current_model();
        let ctx = session.build_context();
        let estimated = session.estimate_request(&ctx);
        session.emit(EventMsg::TurnStarted {
            task_id: task.id.clone(),
            turn,
            context: Some(session.budget().usage),
        });
        let message = stream_turn(session, task, &model, thinking, ctx).await;
        match message.stop_reason {
            StopReason::Aborted => {
                end_turn(session, task, turn, &message);
                if task.cancel.is_cancelled() {
                    return TaskOutcome::Interrupted;
                }
                // `steer_now` ended the reply: the steering input goes in at the boundary.
                turn += 1;
                continue;
            }
            StopReason::Error => {
                end_turn(session, task, turn, &message);
                let overflow = message.error.as_ref().is_some_and(|e| e.kind == ErrorKind::ContextOverflow);
                let enabled = session.config.compaction.enabled;
                if overflow && enabled && !compactions.since_response {
                    // Compact, then retry once: the guard stops a second overflow from
                    // compacting again.
                    match compaction::compact(session, task, CompactionReason::Overflow, None).await {
                        Ok(()) => {
                            compactions.done(session);
                            turn += 1;
                            continue;
                        }
                        Err(CompactError::Interrupted) => return TaskOutcome::Interrupted,
                        Err(CompactError::Failed(_)) => {}
                    }
                }
                let mut error = message
                    .error
                    .as_deref()
                    .map(ErrorInfo::from)
                    .unwrap_or_else(|| ErrorInfo::new("unknown", "the model request failed"));
                if overflow {
                    // The next request compacts first.
                    error.retryable = enabled;
                }
                return TaskOutcome::Failed(error);
            }
            StopReason::Stop | StopReason::Length | StopReason::ToolUse => {
                compactions.since_response = false;
                session.calibrate(&message.usage, estimated);
            }
        }
        let text = message.text();
        if !text.trim().is_empty() {
            last_message = Some(text);
        }
        let calls: Vec<ToolCall> = message.tool_calls().into_iter().cloned().collect();
        if !calls.is_empty() {
            let results = if message.stop_reason == StopReason::Length {
                tool_exec::reject_all(session, &calls, tool_exec::TRUNCATED_CALL)
            } else {
                tool_exec::execute_batch(session, task, calls.clone()).await
            };
            for result in results {
                session.record(EntryKind::message(Message::ToolResult(result)));
            }
        }
        // Taken now, so that it never outlives its batch.
        let last_word = task.take_end_request();
        end_turn(session, task, turn, &message);
        if task.cancel.is_cancelled() {
            return TaskOutcome::Interrupted;
        }
        match finish_turn_hooks(session, &message).await {
            TurnDecision::End => {
                return TaskOutcome::Completed {
                    last_message,
                    reason: CompletionReason::Hook,
                };
            }
            TurnDecision::Continue => {
                turn += 1;
                continue;
            }
            TurnDecision::Default => {}
        }
        // A call said this was its last word (bot-design §3.3); input that came meanwhile is
        // answered first.
        if last_word && !session.has_steer() {
            return TaskOutcome::Completed {
                last_message,
                reason: CompletionReason::Done,
            };
        }
        if max_turns > 0 && turn + 1 >= max_turns {
            session.warn(format!("stopped after {max_turns} turns (max_turns)"));
            return TaskOutcome::Completed {
                last_message,
                reason: CompletionReason::MaxTurns,
            };
        }
        if !calls.is_empty() {
            turn += 1;
            continue;
        }
        // No calls: the model means to stop. A bot that has not answered its owner's latest
        // message is reminded once, before anything that came meanwhile joins: a reply to the
        // next message would count as answering this one too (bot-design §3.11).
        let owed = if message.stop_reason == StopReason::Length { Owed::Nothing } else { session.owed() };
        let reminder = owed.reminder();
        if !reminded && let Some(reminder) = &reminder {
            reminded = true;
            hold_input = true;
            session.record(reminder.clone());
            turn += 1;
            continue;
        }
        if session.has_steer() {
            turn += 1;
            continue;
        }
        if let Some(message) = session.take_follow_up() {
            session.record_user(message);
            reminded = false;
            turn += 1;
            continue;
        }
        if session.is_group() {
            // A seat has no reply debt and no `no_reply` failure. The one exception is a batch
            // that mentioned it: then it owes the group a word, once (brief §4.5).
            if session.take_group_mentioned() && !session.group_answered() && !reminded {
                reminded = true;
                session.record(EntryKind::GroupUnanswered);
                turn += 1;
                continue;
            }
            let reason = if message.stop_reason == StopReason::Length {
                session.warn("the reply was cut off by the output token limit");
                CompletionReason::OutputLimit
            } else {
                CompletionReason::Done
            };
            return TaskOutcome::Completed { last_message, reason };
        }
        match owed {
            // Reminded and still silent, with nothing else to answer: the owner is told rather than
            // left waiting (D-321).
            Owed::Reply | Owed::RoutineReport => {
                let mut error = ErrorInfo::new(NO_REPLY, "the model ended its turn without sending a reply");
                error.retryable = true;
                return TaskOutcome::Failed(error);
            }
            // What came of its work gets one reminder too, once nothing newer is waiting; it may
            // have nothing worth telling (bot-turn-design §6).
            Owed::Delivery if !reminded => {
                reminded = true;
                session.record(EntryKind::Undelivered);
                turn += 1;
                continue;
            }
            _ => {}
        }
        let reason = if message.stop_reason == StopReason::Length {
            session.warn("the reply was cut off by the output token limit");
            CompletionReason::OutputLimit
        } else {
            CompletionReason::Done
        };
        return TaskOutcome::Completed { last_message, reason };
    }
}

/// Compacts before a request when the context reached the soft limit, or when one more turn
/// like the last would not fit. `Err` ends the task.
async fn check_context(session: &Arc<Session>, task: &TaskCtx, compactions: &mut Compactions) -> Result<(), TaskOutcome> {
    if !session.config.compaction.enabled {
        return Ok(());
    }
    let budget = session.budget();
    let usage = budget.usage;
    if !budget.needs_compaction() {
        return Ok(());
    }
    let too_large = |message: String| {
        let mut error = ErrorInfo::new("context_overflow", message);
        error.retryable = true;
        TaskOutcome::Failed(error)
    };
    if compactions.since_response {
        if usage.tokens >= usage.hard_limit {
            return Err(too_large(format!(
                "the context is still too large after compaction (about {} tokens, the limit is {})",
                usage.tokens, usage.hard_limit
            )));
        }
        return Ok(());
    }
    if !compaction::can_compact(session) {
        // Only the last checkpoint is left (say, a request failed right after it). A summary
        // cannot make that smaller; let the provider judge the request.
        return Ok(());
    }
    // After a switch to a smaller window, the previous model summarizes: the history fits in
    // its window and its cache is warm.
    let (current, _) = session.current_model();
    let previous = budget
        .previous_model
        .as_deref()
        .and_then(|reference| session.llm.resolve(reference).ok())
        .map(|resolved| resolved.model)
        .filter(|previous| previous.context_window > current.context_window);
    let reason = match (&previous, budget.full) {
        (Some(_), _) => CompactionReason::ModelSwitch,
        (None, true) => CompactionReason::Overflow,
        (None, false) => CompactionReason::Threshold,
    };
    match compaction::compact(session, task, reason, previous).await {
        Ok(()) => {
            compactions.done(session);
            Ok(())
        }
        Err(CompactError::Interrupted) => Err(TaskOutcome::Interrupted),
        Err(CompactError::Failed(error)) if usage.tokens >= usage.hard_limit => {
            Err(too_large(format!("the context is too large and compaction failed: {}", error.message)))
        }
        Err(CompactError::Failed(error)) => {
            session.warn(format!("compaction failed, continuing without it: {}", error.message));
            Ok(())
        }
    }
}

/// `Op::Compact` and `/compact`: a task that only compacts.
async fn run_compaction(session: &Arc<Session>, task: &TaskCtx) -> TaskOutcome {
    if !compaction::can_compact(session) {
        session.warn("nothing to compact");
        return TaskOutcome::Completed {
            last_message: None,
            reason: CompletionReason::Done,
        };
    }
    match compaction::compact(session, task, CompactionReason::Manual, None).await {
        Ok(()) => TaskOutcome::Completed {
            last_message: None,
            reason: CompletionReason::Done,
        },
        Err(CompactError::Interrupted) => TaskOutcome::Interrupted,
        Err(CompactError::Failed(error)) => TaskOutcome::Failed(error),
    }
}

/// How long the other side may go without a word before the task looks again (§5.5).
const PEER_IDLE: Duration = Duration::from_secs(60);
/// How many reconnects in a row may fail before the task fails (§5.5).
const PEER_RECONNECTS: u32 = 3;
/// The largest file the other side may give: beyond this it is not kept (§5.3).
const PEER_FILE_MAX: u64 = 50 * 1024 * 1024;
/// What one task's files may add up to.
const PEER_ROUND_MAX: u64 = 200 * 1024 * 1024;
/// After these many characters the name the other side gave is cut (§5.3).
const PEER_NAME_MAX: usize = 120;

/// Opens a task the other side had not ended, after the application came back (§5.5).
pub(crate) fn resume_peer(session: &Arc<Session>) {
    start(session, Work::ResumePeer, TaskTrigger::User);
}

/// An external bot's task (bot-contacts-design §5.3): what the owner said goes to the other side,
/// and what it says is recorded exactly as a local bot's `send_to_user` call would be.
async fn run_peer_task(
    session: &Arc<Session>,
    task: &TaskCtx,
    input: Option<Input>,
) -> TaskOutcome {
    let Some(peer) = session.peer.clone() else {
        return TaskOutcome::Failed(ErrorInfo::new(
            "internal",
            "no other side for this conversation",
        ));
    };
    let host = session.peer_host();
    let mut thread = last_thread(session);
    let message = input.map(|input| {
        let message = peer_message(input.id.clone(), &input.message);
        session.record_user(input);
        // Only a task the other side is waiting on takes the next message with it (§5.4).
        if !thread.waiting {
            thread.task_id = None;
        }
        message
    });
    let mut pending = Some(match &message {
        Some(message) => {
            peer.send(message.clone(), thread.clone(), task.cancel.clone())
                .await
        }
        None => peer.resume(thread.clone(), task.cancel.clone()).await,
    });
    let mut reconnects = 0u32;
    let mut answered = false;
    let mut last_message = None;
    let mut files: Vec<IncomingFile> = Vec::new();
    let mut file_bytes = 0u64;
    loop {
        let Some(stream) = pending.take() else { break };
        let mut stream = match stream {
            Ok(stream) => stream,
            Err(error) => {
                flush_files(session, &mut files, &mut file_bytes).await;
                return peer_failed(error);
            }
        };
        loop {
            let next = tokio::select! {
                biased;
                _ = task.cancel.cancelled() => {
                    // Ask the other side to stop; it is best effort (§5.5).
                    if thread.task_id.is_some() {
                        peer.cancel(thread.clone()).await;
                    }
                    return TaskOutcome::Interrupted;
                }
                next = tokio::time::timeout(PEER_IDLE, futures::StreamExt::next(&mut stream)) => next,
            };
            let event = match next {
                // Nothing for a while: look again before giving up (§5.5).
                Err(_) | Ok(None) => break,
                Ok(Some(event)) => event,
            };
            reconnects = 0;
            match event {
                PeerEvent::Thread(new) => {
                    if new != thread {
                        thread = new;
                        session.record(EntryKind::PeerThread(thread.clone()));
                    }
                }
                PeerEvent::Working => {}
                PeerEvent::Said { text } => {
                    if text.trim().is_empty() {
                        continue;
                    }
                    answered = true;
                    last_message = Some(text.clone());
                    deliver_text(session, &host, &text);
                }
                PeerEvent::File {
                    name,
                    media_type,
                    bytes,
                } => {
                    if bytes.len() as u64 > PEER_FILE_MAX
                        || file_bytes + bytes.len() as u64 > PEER_ROUND_MAX
                    {
                        session.warn("a file from the other side was too large and was not kept");
                        continue;
                    }
                    if let Some(file) = write_incoming(session, name, media_type, &bytes).await {
                        file_bytes += file.size;
                        files.push(file);
                    }
                }
                PeerEvent::Asked { text } => {
                    flush_files(session, &mut files, &mut file_bytes).await;
                    last_message = Some(text.clone());
                    if !thread.waiting {
                        thread.waiting = true;
                        session.record(EntryKind::PeerThread(thread.clone()));
                    }
                    deliver_question(session, &host, &text);
                    return TaskOutcome::Completed {
                        last_message,
                        reason: CompletionReason::Done,
                    };
                }
                PeerEvent::Done => {
                    flush_files(session, &mut files, &mut file_bytes).await;
                    // The task is over: the next message starts a new one in the same
                    // conversation, so its identifier must not go along (§5.4, §5.5).
                    clear_task(session, &mut thread);
                    if !answered {
                        return no_reply();
                    }
                    return TaskOutcome::Completed {
                        last_message,
                        reason: CompletionReason::Done,
                    };
                }
                PeerEvent::Failed(error) => {
                    // A broken connection is picked up again, as silence is (§5.5); a task the
                    // other side reports as failed is final.
                    if error.kind == "bot_peer_lost" && error.retryable {
                        break;
                    }
                    flush_files(session, &mut files, &mut file_bytes).await;
                    if thread.waiting {
                        thread.waiting = false;
                        session.record(EntryKind::PeerThread(thread.clone()));
                    }
                    return peer_failed(error);
                }
            }
        }
        // The stream ended or went quiet: the task may still run on the other side.
        if thread.task_id.is_none() {
            return peer_failed(
                PeerError::new("bot_peer_failed", "the other side stopped answering").retryable(),
            );
        }
        if reconnects >= PEER_RECONNECTS {
            return peer_failed(
                PeerError::new("bot_peer_failed", "the other side cannot be reached").retryable(),
            );
        }
        reconnects += 1;
        pending = Some(peer.resume(thread.clone(), task.cancel.clone()).await);
    }
    peer_failed(PeerError::new("bot_peer_failed", "the other side stopped answering").retryable())
}

fn peer_failed(error: PeerError) -> TaskOutcome {
    let mut info = ErrorInfo::new(&error.kind, error.message);
    info.retryable = error.retryable;
    TaskOutcome::Failed(info)
}

fn no_reply() -> TaskOutcome {
    let mut info = ErrorInfo::new(NO_REPLY, "the other side ended without saying anything");
    info.retryable = true;
    TaskOutcome::Failed(info)
}

/// A finished task leaves the conversation identifier behind, not the task's (§5.5).
fn clear_task(session: &Session, thread: &mut PeerThread) {
    if thread.task_id.take().is_some() || std::mem::take(&mut thread.waiting) {
        session.record(EntryKind::PeerThread(thread.clone()));
    }
}

/// The other side's conversation and task, from the log (§5.5): it belongs to the conversation,
/// not to the bot.
fn last_thread(session: &Session) -> PeerThread {
    let state = session.state.lock();
    state
        .history
        .branch_back()
        .find_map(|entry| match &entry.kind {
            EntryKind::PeerThread(thread) => Some(thread.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

/// What goes to the other side: the owner's words and pictures, nothing else (§5.4).
fn peer_message(id: String, message: &UserMessage) -> PeerMessage {
    let mut text = String::new();
    let mut images = Vec::new();
    for content in &message.content {
        match content {
            UserContent::Text { text: words } => {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(words);
            }
            UserContent::Image { mime_type, data } => images.push(PeerImage {
                media_type: mime_type.clone(),
                data: data.clone(),
            }),
        }
    }
    PeerMessage { id, text, images }
}

/// A file the other side gave, kept in the bot's folder (§5.3).
struct IncomingFile {
    path: PathBuf,
    size: u64,
}

/// Writes one file into the bot's `files` folder, with the name cleaned (§5.3). `None` when it
/// could not be written; the task goes on.
async fn write_incoming(
    session: &Session,
    name: String,
    media_type: Option<String>,
    bytes: &[u8],
) -> Option<IncomingFile> {
    let dir = session.env.cwd().join("files");
    if let Err(error) = tokio::fs::create_dir_all(&dir).await {
        session.warn(format!("cannot keep a file from the other side: {error}"));
        return None;
    }
    let mut name = safe_name(&name, media_type.as_deref());
    let mut path = dir.join(&name);
    let mut n = 2;
    while tokio::fs::metadata(&path).await.is_ok() {
        name = numbered(&name, n);
        path = dir.join(&name);
        n += 1;
    }
    match tokio::fs::write(&path, bytes).await {
        Ok(()) => Some(IncomingFile {
            path,
            size: bytes.len() as u64,
        }),
        Err(error) => {
            session.warn(format!("cannot keep a file from the other side: {error}"));
            None
        }
    }
}

/// The file's last path segment, without control characters, no leading dot, and short enough
/// (§5.3): the other side cannot choose where on this computer anything lands.
fn safe_name(name: &str, media_type: Option<&str>) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut cleaned: String = last.chars().filter(|c| !c.is_control()).collect();
    cleaned = cleaned.trim().to_string();
    if cleaned.starts_with('.') {
        cleaned.replace_range(0..1, "_");
    }
    if cleaned.is_empty() {
        return format!("file{}", extension_for(media_type));
    }
    cleaned.chars().take(PEER_NAME_MAX).collect()
}

fn extension_for(media_type: Option<&str>) -> &'static str {
    match media_type.unwrap_or_default() {
        "application/pdf" => ".pdf",
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "application/json" | "application/problem+json" => ".json",
        "text/plain" => ".txt",
        "text/markdown" => ".md",
        _ => "",
    }
}

/// `name-2.ext`, for a second file of the same name (§5.3).
fn numbered(name: &str, n: u32) -> String {
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => format!("{stem}-{n}.{extension}"),
        _ => format!("{name}-{n}"),
    }
}

/// Hands the files of one task to their owner as one message, as a local bot's `send_to_user`
/// with files does (§5.3).
async fn flush_files(session: &Arc<Session>, files: &mut Vec<IncomingFile>, file_bytes: &mut u64) {
    if files.is_empty() {
        return;
    }
    *file_bytes = 0;
    let mut details = Vec::new();
    for file in files.drain(..) {
        let path = file.path.to_string_lossy().to_string();
        match crate::bot::sent_file(session.env.as_ref(), &path).await {
            Ok(detail) => details.push(detail),
            Err(why) => session.warn(format!(
                "cannot hand over a file from the other side: {why}"
            )),
        }
    }
    if details.is_empty() {
        return;
    }
    let paths: Vec<Value> = details
        .iter()
        .filter_map(|detail| detail.get("path").cloned())
        .map(|path| json!({ "path": path }))
        .collect();
    let args = json!({ "type": "attachment", "files": paths });
    let output = ToolOutput::text("Sent.").with_details(json!({ "files": details }));
    deliver_call(session, &session.peer_host(), args, output);
}

/// One `send_to_user` call as a local bot's model would have made it: the message, then the call
/// as it starts and ends. Downstream code reads these three and needs to know nothing of the
/// other side (bot-contacts-design §5.3, D-704).
fn deliver_call(session: &Session, host: &str, args: Value, output: ToolOutput) -> bool {
    let call_id = session.allocate_id();
    let message_id = session.allocate_id();
    let call = finx_llm::ToolCall {
        id: call_id,
        name: crate::bot::SEND_TO_USER.to_string(),
        arguments: JsonText::from_value(&args),
        arguments_error: None,
        provider_data: None,
    };
    let assistant = Arc::new(AssistantMessage {
        content: vec![AssistantContent::ToolCall(call.clone())],
        provider: "a2a".to_string(),
        api: "a2a".to_string(),
        model: host.to_string(),
        response_id: None,
        usage: Default::default(),
        stop_reason: StopReason::ToolUse,
        error: None,
        ts: finx_llm::now_ms(),
        duration_ms: None,
    });
    let message = Message::Assistant(assistant);
    session.record_with_id(message_id.clone(), EntryKind::message(message.clone()));
    session.emit(EventMsg::MessageCompleted {
        message_id,
        message,
        mail: None,
        skills: Vec::new(),
    });
    let tool = crate::bot::send_tool(false);
    session.emit(tool_exec::started(session, &call, Some(tool.as_ref())));
    let result = tool_exec::completed(session, &call, output, None);
    session.record(EntryKind::message(Message::ToolResult(result)));
    true
}

fn deliver_text(session: &Session, host: &str, text: &str) {
    deliver_call(
        session,
        host,
        json!({ "type": "text", "text": text }),
        ToolOutput::text("Sent."),
    );
}

fn deliver_question(session: &Session, host: &str, text: &str) {
    deliver_call(
        session,
        host,
        json!({ "type": "question", "text": text }),
        ToolOutput::text("Sent."),
    );
}

fn end_turn(session: &Session, task: &TaskCtx, turn: u32, message: &AssistantMessage) {
    session.emit(EventMsg::TurnCompleted {
        task_id: task.id.clone(),
        turn,
        usage: message.usage.clone(),
    });
}

async fn finish_turn_hooks(session: &Session, message: &AssistantMessage) -> TurnDecision {
    for hook in &session.hooks {
        match hook.finish_turn(message).await {
            TurnDecision::Default => continue,
            decision => return decision,
        }
    }
    TurnDecision::Default
}

/// Streams one model response, forwarding deltas. Cancelling drops the stream and keeps the
/// text received so far.
async fn stream_turn(
    session: &Arc<Session>,
    task: &TaskCtx,
    model: &Arc<Model>,
    thinking: ThinkingLevel,
    ctx: Context,
) -> Arc<AssistantMessage> {
    let mut message_id = session.allocate_id();
    let options = RequestOptions {
        thinking,
        cache_key: Some(session.id.clone()),
        ..Default::default()
    };
    let mut stream = session.llm.stream(model.clone(), ctx, options);
    let mut acc = MessageAccumulator::for_model(model);
    let mut started = false;
    let turn = task.turn();
    let message = loop {
        tokio::select! {
            biased;
            _ = turn.cancelled() => break acc.aborted(),
            event = stream.next() => match event {
                None => break acc.fail(LlmError::new(ErrorKind::Protocol, "the model stream ended unexpectedly")),
                Some(StreamEvent::Done(message)) | Some(StreamEvent::Failed(message)) => break message,
                Some(StreamEvent::Retrying { attempt, delay, error }) => {
                    // The failed attempt's text is dropped; the next one streams a new message.
                    if started {
                        acc = MessageAccumulator::for_model(model);
                        message_id = session.allocate_id();
                        started = false;
                    }
                    session.emit(EventMsg::StreamRetry {
                        attempt,
                        delay_ms: delay.as_millis() as u64,
                        error: ErrorInfo::from(&error),
                    });
                }
                Some(event) => {
                    acc.apply(&event);
                    if !started {
                        session.emit(EventMsg::MessageStarted { message_id: message_id.clone(), role: Role::Assistant });
                        started = true;
                    }
                    if let Some(delta) = Delta::from_stream(&event) {
                        session.emit(EventMsg::MessageDelta { message_id: message_id.clone(), delta });
                    }
                }
            },
        }
    };
    drop(stream);
    if !started {
        session.emit(EventMsg::MessageStarted {
            message_id: message_id.clone(),
            role: Role::Assistant,
        });
    }
    let message = Arc::new(message);
    let record = Message::Assistant(message.clone());
    session.record_with_id(
        message_id.clone(),
        EntryKind::message(record.clone()),
    );
    session.emit(EventMsg::MessageCompleted {
        message_id,
        message: record,
        mail: None,
        skills: Vec::new(),
    });
    let reference = model.reference();
    session.add_usage(&reference, &message.usage);
    task.usage.lock().add(&reference, &message.usage);
    message
}
