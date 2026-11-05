//! One task per sub-agent: consumes its session's events, keeps its status, and hands over its
//! report each time it has nothing left to do.

use finx_llm::Message;
use finx_llm::UsageTotals;
use finx_protocol::AgentStatus;
use finx_protocol::ErrorInfo;
use finx_protocol::EventMsg;
use finx_protocol::Op;
use finx_protocol::PromptMode;
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use super::AgentTree;
use super::Progress;
use super::Report;
use crate::kernel::Kernel;

/// The current round of work: from the first task after being idle until idle again.
struct Round {
    started: Option<Instant>,
    status: AgentStatus,
    reply: Option<String>,
    error: Option<ErrorInfo>,
    unprocessed: Vec<String>,
    usage: UsageTotals,
    /// Interrupted to take a new message: the next task follows at once, so this is no end.
    restarting: bool,
}

impl Round {
    fn new() -> Self {
        Self {
            started: None,
            status: AgentStatus::Completed,
            reply: None,
            error: None,
            unprocessed: Vec::new(),
            usage: UsageTotals::default(),
            restarting: false,
        }
    }

    fn finish(&mut self) -> Report {
        let round = std::mem::replace(self, Round::new());
        Report {
            status: round.status,
            reply: round.reply,
            error: round.error,
            unprocessed: round.unprocessed,
            usage: round.usage,
            elapsed: round.started.map_or(Duration::ZERO, |t| t.elapsed()),
        }
    }
}

pub(super) async fn drive(tree: Arc<AgentTree>, id: String, mut kernel: Kernel, progress: Arc<Mutex<Progress>>) {
    let mut round = Round::new();
    let mut closed = false;
    while let Some(event) = kernel.next_event().await {
        tree.forward(&id, &event);
        progress.lock().saw(&event.msg);
        match event.msg {
            EventMsg::TaskStarted { .. } => {
                round.restarting = false;
                if round.started.is_none() {
                    progress.lock().begin();
                }
                round.started.get_or_insert_with(Instant::now);
                tree.running(&id);
            }
            EventMsg::MessageCompleted {
                message: Message::Assistant(reply),
                ..
            } => {
                let text = reply.text();
                if !text.trim().is_empty() {
                    progress.lock().said(&text);
                    round.reply = Some(text);
                }
            }
            EventMsg::TaskCompleted { usage, last_message, .. } => {
                round.usage.merge(&usage);
                round.status = AgentStatus::Completed;
                round.error = None;
                if last_message.is_some() {
                    round.reply = last_message;
                }
            }
            EventMsg::TaskFailed { error, usage, .. } => {
                round.usage.merge(&usage);
                round.status = AgentStatus::Failed;
                round.error = Some(error);
            }
            EventMsg::TaskInterrupted { returned_input, usage, .. } => {
                round.usage.merge(&usage);
                round.status = AgentStatus::Interrupted;
                if tree.take_redirect(&id) {
                    // The new message and anything queued before it start the next task.
                    round.restarting = true;
                    for message in returned_input {
                        let _ = kernel
                            .submit(Op::Prompt {
                                input: message.content,
                                mode: PromptMode::Steer,
                                // Only the user's own input holds commands.
                                commands: false,
                            })
                            .await;
                    }
                } else {
                    round.unprocessed = returned_input
                        .iter()
                        .map(|m| m.text_content())
                        .filter(|t| !t.trim().is_empty())
                        .collect();
                }
            }
            EventMsg::Idle if !round.restarting => tree.settle(&id, round.finish()),
            EventMsg::SessionClosed => {
                closed = true;
                break;
            }
            _ => {}
        }
    }
    kernel.closed().await;
    tree.closed(&id, !closed);
}
