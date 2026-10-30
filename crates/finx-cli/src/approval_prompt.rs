//! Inline approval questions on the terminal.

use finx_protocol::ApprovalDecision;
use finx_protocol::CommandRule;
use finx_protocol::PermissionMode;
use std::io::Write;

use crate::render::Style;

async fn read_line() -> Option<String> {
    tokio::task::spawn_blocking(|| {
        let mut line = String::new();
        match std::io::stdin().read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(line),
        }
    })
    .await
    .ok()
    .flatten()
}

/// What the kernel asks about, from an `ApprovalRequested` event.
pub struct Question<'a> {
    pub name: &'a str,
    pub summary: &'a str,
    pub reason: Option<&'a str>,
    /// Command prefix that "always" allows for the rest of the session.
    pub rule: Option<&'a CommandRule>,
    /// Mode that "always" switches the session to.
    pub mode: Option<PermissionMode>,
}

pub async fn ask(style: &Style, question: Question<'_>) -> ApprovalDecision {
    // "always" is offered only when the kernel can remember something.
    let always = match (question.rule, question.mode) {
        (Some(rule), _) => Some(format!("always allow `{}` in this session", rule.prefix.join(" "))),
        (None, Some(PermissionMode::AcceptEdits)) => Some("allow all edits in this session".to_string()),
        (None, Some(mode)) => Some(format!("switch to {mode} for this session")),
        (None, None) => None,
    };
    eprintln!();
    eprintln!("{}", style.yellow(&format!("? Allow {}: {}", question.name, question.summary)));
    if let Some(reason) = question.reason {
        eprintln!("  {}", style.dim(&format!("reason: {reason}")));
    }
    match &always {
        Some(always) => eprintln!("  [y] yes   [a] {always}   [n] no   [q] stop the task"),
        None => eprintln!("  [y] yes   [n] no   [q] stop the task"),
    }
    loop {
        eprint!("> ");
        let _ = std::io::stderr().flush();
        let Some(line) = read_line().await else {
            return ApprovalDecision::Abort;
        };
        match line.trim().to_lowercase().as_str() {
            "y" | "yes" => return ApprovalDecision::Approve,
            "a" | "always" if always.is_some() => {
                if let Some(mode) = question.mode {
                    eprintln!("  {}", style.dim(&format!("permission mode is now {mode}")));
                }
                return ApprovalDecision::ApproveForSession;
            }
            "n" | "no" => {
                eprint!("  feedback for the model (optional): ");
                let _ = std::io::stderr().flush();
                let feedback = read_line().await.map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
                return ApprovalDecision::Deny { feedback };
            }
            "q" | "quit" => return ApprovalDecision::Abort,
            _ if always.is_some() => eprintln!("  please answer y, a, n or q"),
            _ => eprintln!("  please answer y, n or q"),
        }
    }
}
