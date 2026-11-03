//! System prompt assembly. The prompt is built once per session and then frozen.

use finx_tools::Environment;
use finx_tools::ToolRegistry;
use std::io;
use std::path::Path;

use crate::config::Config;
use crate::instructions::InstructionFile;

pub const BASE_PROMPT: &str = include_str!("prompts/base.md");

pub struct PromptInputs<'a> {
    pub config: &'a Config,
    pub tools: &'a ToolRegistry,
    pub env: &'a dyn Environment,
    pub instructions: &'a [InstructionFile],
    /// The `<available_skills>` section, or empty.
    pub skills: &'a str,
    pub project_root: Option<&'a Path>,
    pub git_branch: Option<String>,
    /// As [`date_text`] gives it.
    pub date: String,
}

/// A date as the model is given it, with its weekday: `2026-11-03 (Tuesday)`. Models often
/// get the weekday of a date wrong, and work is planned by weekdays.
pub fn date_text(date: chrono::NaiveDate) -> String {
    date.format("%Y-%m-%d (%A)").to_string()
}

/// The date in a system prompt's `<environment>` section.
pub fn prompt_date(prompt: &str) -> Option<chrono::NaiveDate> {
    const FIELD: &str = "\ndate: ";
    let environment = &prompt[prompt.rfind("<environment>")?..];
    let start = environment.find(FIELD)? + FIELD.len();
    chrono::NaiveDate::parse_from_str(environment.get(start..start + 10)?, "%Y-%m-%d").ok()
}

pub fn build_system_prompt(inputs: &PromptInputs<'_>) -> io::Result<String> {
    let base = match &inputs.config.system_prompt_file {
        Some(path) => std::fs::read_to_string(path)?,
        None => BASE_PROMPT.to_string(),
    };
    let mut prompt = base.trim_end().to_string();

    let guidelines = inputs.tools.guidelines();
    if !guidelines.is_empty() {
        prompt.push_str("\n\n<tool_guidelines>\n");
        for line in guidelines {
            prompt.push_str("- ");
            prompt.push_str(line);
            prompt.push('\n');
        }
        prompt.push_str("</tool_guidelines>");
    }

    for file in inputs.instructions {
        let tag = if file.global { "user_instructions" } else { "project_instructions" };
        prompt.push_str(&format!(
            "\n\n<{tag} path=\"{}\">\n{}\n</{tag}>",
            file.path.display(),
            file.content.trim_end()
        ));
    }
    if !inputs.config.instructions_extra.trim().is_empty() {
        prompt.push_str(&format!(
            "\n\n<extra_instructions>\n{}\n</extra_instructions>",
            inputs.config.instructions_extra.trim_end()
        ));
    }
    // Before the environment, which changes most often (date, branch): sessions of a project
    // share the longest prefix.
    if !inputs.skills.is_empty() {
        prompt.push_str("\n\n");
        prompt.push_str(inputs.skills);
    }

    let os = inputs.env.os();
    let roots: Vec<String> = inputs
        .env
        .workspace_roots()
        .iter()
        .map(|p| p.display().to_string())
        .collect();
    let git = match (inputs.project_root, &inputs.git_branch) {
        (Some(_), Some(branch)) => format!("yes (branch {branch})"),
        (Some(root), None) if root.join(".git").exists() => "yes".to_string(),
        _ => "no".to_string(),
    };
    prompt.push_str(&format!(
        "\n\n<environment>\ncwd: {}\nworkspace_roots: {}\nos: {} ({})\nshell: {}\ndate: {}\ngit: {}\n</environment>\n",
        inputs.env.cwd().display(),
        roots.join(", "),
        os.name,
        os.arch,
        os.shell,
        inputs.date,
        git
    ));
    Ok(prompt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use finx_tools::BashTool;
    use finx_tools::LocalEnvironment;
    use finx_tools::builtin_registry;
    use std::path::PathBuf;

    #[test]
    fn assembles_sections_in_order() {
        let env = LocalEnvironment::new(PathBuf::from("/work/demo"));
        let tools = builtin_registry(BashTool::default());
        let config = Config {
            instructions_extra: "Prefer Rust.".into(),
            ..Config::default()
        };
        let instructions = vec![InstructionFile {
            path: PathBuf::from("/work/demo/AGENTS.md"),
            global: false,
            content: "Run cargo test before finishing.".into(),
        }];
        let prompt = build_system_prompt(&PromptInputs {
            config: &config,
            tools: &tools,
            env: &env,
            instructions: &instructions,
            skills: "<available_skills>\n…\n</available_skills>",
            project_root: None,
            git_branch: None,
            date: "2026-10-28".into(),
        })
        .unwrap();
        assert!(prompt.starts_with("You are FinxWork"));
        let order = [
            "<tool_guidelines>",
            "<project_instructions path=\"/work/demo/AGENTS.md\">",
            "<extra_instructions>",
            "<available_skills>",
            // The section, not the base prompt's mention of its tag.
            "\n<environment>\n",
        ];
        let positions: Vec<usize> = order.iter().map(|tag| prompt.find(tag).unwrap()).collect();
        assert!(positions.windows(2).all(|w| w[0] < w[1]));
        assert!(prompt.contains("cwd: /work/demo"));
        assert!(prompt.contains("date: 2026-10-28"));
        assert!(prompt.contains("- Use read to view files"));
    }

    #[test]
    fn the_environment_date_has_its_weekday_and_reads_back() {
        let day = chrono::NaiveDate::from_ymd_opt(2026, 11, 3).unwrap();
        assert_eq!(date_text(day), "2026-11-03 (Tuesday)");
        let prompt = format!("You are FinxWork.\n\n<environment>\ncwd: /w\ndate: {}\ngit: no\n</environment>\n", date_text(day));
        assert_eq!(prompt_date(&prompt), Some(day));
        // Logs written before the weekday was added.
        assert_eq!(prompt_date("<environment>\ndate: 2026-10-28\n</environment>"), chrono::NaiveDate::from_ymd_opt(2026, 10, 28));
        assert_eq!(prompt_date("You are FinxWork. date: 2026-10-28"), None);
    }

    #[test]
    fn base_prompt_says_not_to_work_around_refusals() {
        let text = BASE_PROMPT.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(text.contains(
            "When a tool call is denied or not approved, do not retry it or get the same effect another way, \
             such as a different command, a script or another tool."
        ));
    }
}
