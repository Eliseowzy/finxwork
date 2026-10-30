//! Reports: what a sub-agent's round of work comes to, as mail for the main session or as the
//! result of a call that waited for it.

use finx_llm::UserContent;
use finx_llm::UserMessage;
use finx_protocol::AgentRef;
use finx_protocol::AgentStatus;
use finx_protocol::MailInfo;
use finx_protocol::MailKind;
use finx_tools::cap_result;
use std::time::Duration;

use super::Report;
use crate::session::Session;

const TASK_TEMPLATE: &str = include_str!("prompts/child_task.md");

/// Characters of a report shown in `agent_status`.
const SUMMARY_CHARS: usize = 200;

/// Follows the report of a stopped agent. Without it models take a stopped agent for a dead one
/// and start new agents on the same work when asked to continue.
const RESUMABLE: &str = "It keeps its work and context: send_message lets it continue where it stopped.";

/// The first message of a sub-agent: who it is, how to report, and the task.
pub(crate) fn task_message(name: &str, task: &str) -> String {
    TASK_TEMPLATE.trim_end().replace("{name}", name).replace("{task}", task)
}

/// A report waiting in a session's inbox. The text is final: rendered and cut once.
pub(crate) struct Mail {
    pub(crate) info: MailInfo,
    pub(crate) message: UserMessage,
    /// Starts a task when the session has none.
    pub(crate) wake: bool,
}

impl Mail {
    pub(crate) fn report(root: &Session, from: AgentRef, report: &Report, seq: u64) -> Mail {
        let body = cut(root, &from.name, seq, body(report));
        let mut text = format!(
            "<agent_report agent=\"{}\" status=\"{}\">\n{}\n</agent_report>",
            from.name,
            report.status.as_str(),
            body.trim_end()
        );
        if report.status == AgentStatus::Interrupted {
            text.push('\n');
            text.push_str(RESUMABLE);
        }
        Mail {
            info: MailInfo {
                id: format!("m{seq}"),
                from,
                kind: MailKind::Report,
                status: report.status,
                no_reply: no_reply(report),
            },
            message: UserMessage::text(text),
            // Work that was stopped waits until someone asks for more.
            wake: matches!(report.status, AgentStatus::Completed | AgentStatus::Failed),
        }
    }
}

/// What the report says: the agent's last reply, after the error if it failed.
pub(crate) fn body(report: &Report) -> String {
    let mut out = String::new();
    if let Some(error) = &report.error {
        out.push_str(&format!("Error: {}\n\n", error.message));
    }
    match &report.reply {
        Some(reply) => out.push_str(reply.trim()),
        None if no_reply(report) => out.push_str(match report.status {
            AgentStatus::Interrupted => "(It had not replied yet.)",
            _ => "(It finished without a reply.)",
        }),
        None => {}
    }
    if !report.unprocessed.is_empty() {
        out.push_str("\n\nMessages it had not processed:");
        for message in &report.unprocessed {
            out.push_str("\n- ");
            out.push_str(message.trim());
        }
    }
    out.trim().to_string()
}

/// The start of the report, for user interfaces; none when the agent had not replied, as the
/// report then only says so to the model.
pub(crate) fn summary(report: &Report) -> Option<String> {
    if no_reply(report) {
        return None;
    }
    let body = body(report);
    Some(match body.char_indices().nth(SUMMARY_CHARS) {
        Some((end, _)) => format!("{}…", &body[..end]),
        None => body,
    })
}

/// Whether the agent had neither replied nor failed: its report then is only a note saying so.
fn no_reply(report: &Report) -> bool {
    report.reply.is_none() && report.error.is_none()
}

/// The result of a call that waited for the agent.
pub(crate) fn waited(name: &str, report: &Report) -> String {
    let mut text = format!(
        "Agent \"{name}\" {} after {}.\n\n{}",
        report.status.as_str(),
        duration(report.elapsed),
        body(report)
    );
    if report.status == AgentStatus::Interrupted {
        text.push_str("\n\n");
        text.push_str(RESUMABLE);
    }
    text
}

/// Cuts a long report like a tool result: head and tail stay, the full text is saved.
fn cut(root: &Session, name: &str, seq: u64, body: String) -> String {
    let limits = root.tool_limits();
    let mut content = vec![UserContent::Text { text: body }];
    cap_result(
        &mut content,
        limits.max_bytes,
        Some(&root.output_dir),
        &format!("agent-{name}-{seq}"),
        limits.max_saved_bytes,
    );
    content
        .into_iter()
        .find_map(|c| match c {
            UserContent::Text { text } => Some(text),
            UserContent::Image { .. } => None,
        })
        .unwrap_or_default()
}

fn duration(elapsed: Duration) -> String {
    let secs = elapsed.as_secs();
    if secs < 60 {
        format!("{secs}s")
    } else {
        format!("{}m{:02}s", secs / 60, secs % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use finx_llm::UsageTotals;
    use finx_protocol::ErrorInfo;

    fn report(status: AgentStatus, reply: Option<&str>) -> Report {
        Report {
            status,
            reply: reply.map(str::to_string),
            error: None,
            unprocessed: Vec::new(),
            usage: UsageTotals::default(),
            elapsed: Duration::from_secs(125),
        }
    }

    #[test]
    fn the_task_message_names_the_agent_and_carries_the_task() {
        let text = task_message("explore-api", "Find the {name} handlers.");
        assert!(text.starts_with("You are a sub-agent named \"explore-api\""));
        assert!(text.ends_with("<task>\nFind the {name} handlers.\n</task>"));
    }

    #[test]
    fn report_bodies() {
        assert_eq!(body(&report(AgentStatus::Completed, Some("  done\n"))), "done");
        assert_eq!(body(&report(AgentStatus::Completed, None)), "(It finished without a reply.)");
        let mut failed = report(AgentStatus::Failed, Some("half"));
        failed.error = Some(ErrorInfo::new("rate_limited", "rate limited (429)"));
        assert_eq!(body(&failed), "Error: rate limited (429)\n\nhalf");
        let mut stopped = report(AgentStatus::Interrupted, None);
        stopped.unprocessed = vec!["also check b".into()];
        assert_eq!(
            body(&stopped),
            "(It had not replied yet.)\n\nMessages it had not processed:\n- also check b"
        );
        assert_eq!(
            waited("a", &report(AgentStatus::Completed, Some("ok"))),
            "Agent \"a\" completed after 2m05s.\n\nok"
        );
        let long = report(AgentStatus::Completed, Some(&"x".repeat(500)));
        assert_eq!(summary(&long).unwrap().chars().count(), SUMMARY_CHARS + 1);
        // No reply: the note is for the model, so user interfaces get no summary.
        assert_eq!(summary(&report(AgentStatus::Interrupted, None)), None);
        assert_eq!(summary(&failed).as_deref(), Some("Error: rate limited (429)\n\nhalf"));
    }
}
