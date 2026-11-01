//! Inline approval questions on the terminal.

use finx_protocol::ApprovalDecision;
use finx_protocol::CommandRule;
use finx_protocol::GrantAuthority;
use finx_protocol::PermissionMode;
use finx_protocol::SiteGrant;
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
    /// Site permissions to keep for the rest of the session, one of them by number.
    pub grants: &'a [SiteGrant],
}

fn grant_label(grant: &SiteGrant) -> String {
    match (grant.authority, grant.origin.as_str()) {
        (_, "*") => "allow opening any site in this session (an injected page could make the model leak data in URLs)".into(),
        (GrantAuthority::Navigate, origin) => format!("allow opening {origin} in this session"),
        (GrantAuthority::Act, origin) => format!("allow acting on {origin} in this session"),
    }
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
    for (index, grant) in question.grants.iter().enumerate() {
        eprintln!("  [{}] {}", index + 1, grant_label(grant));
    }
    // "Always": kept in ~/.finx/config.toml; never for any site (D-197, D-201).
    let keepable = question.grants.iter().any(|g| g.origin != "*");
    if keepable {
        eprintln!("  {}", style.dim("[number]! also saves it in ~/.finx/config.toml, e.g. 1!"));
    }
    let pick_grant = |answer: &str| {
        let (number, persist) = match answer.strip_suffix('!') {
            Some(number) => (number, true),
            None => (answer, false),
        };
        number
            .parse::<usize>()
            .ok()
            .filter(|n| (1..=question.grants.len()).contains(n))
            .filter(|n| !persist || question.grants[n - 1].origin != "*")
            .map(|n| (n - 1, persist))
    };
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
                return ApprovalDecision::ApproveForSession { grant: None, persist: false };
            }
            answer if let Some((grant, persist)) = pick_grant(answer) => {
                return ApprovalDecision::ApproveForSession { grant: Some(grant), persist };
            }
            "n" | "no" => {
                eprint!("  feedback for the model (optional): ");
                let _ = std::io::stderr().flush();
                let feedback = read_line().await.map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
                return ApprovalDecision::Deny { feedback };
            }
            "q" | "quit" => return ApprovalDecision::Abort,
            _ if !question.grants.is_empty() => eprintln!("  please answer y, a number, n or q"),
            _ if always.is_some() => eprintln!("  please answer y, a, n or q"),
            _ => eprintln!("  please answer y, n or q"),
        }
    }
}
