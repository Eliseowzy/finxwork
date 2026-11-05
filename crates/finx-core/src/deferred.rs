//! Built-in tools kept out of the tool list: the browsers', computer use's and those for looking
//! at agents (docs/desktop/computer-use-design.md §5, bot-turn-design §5.3). Like the tools of deferred MCP servers (mcp-design
//! §7), each group takes one line of the catalog in the system prompt; `tool_search` gives the
//! definitions and the group's guidelines, and `call_tool` runs them. The tool list and the
//! prompt's prefix stay the same whether a session uses them or not.

use finx_tools::Tool;
use parking_lot::Mutex;
use std::sync::Arc;

use crate::system::SystemSettings;

/// One group: a name the model searches by, a line for the catalog, and its tools.
pub(crate) struct Group {
    pub(crate) name: &'static str,
    pub(crate) summary: String,
    pub(crate) tools: Vec<Arc<dyn Tool>>,
}

impl Group {
    /// The guidelines of its tools, once each: what the base prompt says of the other tools.
    pub(crate) fn guidelines(&self) -> Vec<&'static str> {
        let mut lines: Vec<&'static str> = Vec::new();
        for tool in &self.tools {
            for line in tool.guidelines() {
                if !lines.contains(line) {
                    lines.push(line);
                }
            }
        }
        lines
    }
}

/// A session's place among agents, which says what it can do about them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AgentRole {
    /// A main session.
    Main,
    SubAgent,
    /// Sub-agents are turned off.
    None,
}

/// A session's deferred built-in tools, as its system connectors have them now.
#[derive(Default)]
pub(crate) struct Deferred {
    pub(crate) groups: Vec<Group>,
}

/// Shared by a session and its `tool_search` and `call_tool`, replaced when the settings change.
pub(crate) type DeferredCell = Arc<Mutex<Arc<Deferred>>>;

const BROWSER: &str = "browser";
const BROWSER_SUMMARY: &str = "Open web pages, read them and act in them: local pages, files and sites";
const BUILTIN_DEFAULT: &str = "; new pages open in the built-in browser unless you name the user's own";
const YOURS_DEFAULT: &str = "; new pages open in the user's own browser, with their sign-ins, unless you name the built-in one";
const CUA: &str = "cua";
const CUA_SUMMARY: &str = "Computer use: see and operate the other apps on this computer";
const DOC: &str = "doc";
const DOC_SUMMARY: &str = "Documents and workbooks (PDF, XLSX, XLSM): open them beside the conversation; read or search pages and cell ranges, trace or calculate formulas, and edit or save workbooks";
const AGENTS: &str = "agents";
const AGENTS_SUMMARY: &str = "See how your agents stand, or stop them";
const SUB_AGENT_AGENTS_SUMMARY: &str = "See the other agents in this session";

impl Deferred {
    /// The groups `settings` turn on; `pool` says whether the process has browsers, `app`
    /// whether the desktop app is connected, `docs` whether it keeps documents, `agents` what this
    /// session is among agents.
    pub(crate) fn of(settings: &SystemSettings, pool: bool, app: bool, docs: bool, agents: AgentRole) -> Self {
        let mut groups = Vec::new();
        if settings.web_search.enabled {
            groups.push(Group {
                name: crate::web_search::GROUP,
                summary: crate::web_search::GROUP_SUMMARY.into(),
                tools: crate::web_search::tools(&settings.web_search),
            });
        }
        let builtin = settings.browser.builtin_on(app);
        let yours = settings.browser.yours_on(app);
        if pool && (builtin || yours) {
            let tools = match (builtin && yours, settings.browser.policy.script_enabled) {
                (false, false) => crate::browser::one_browser(),
                (false, true) => crate::browser::one_browser_with_scripts(),
                (true, false) => crate::browser::two_browsers(),
                (true, true) => crate::browser::two_browsers_with_scripts(),
            };
            // While both are on, the line says which one a page opens in by default.
            let default = match (builtin && yours, settings.browser.default) {
                (false, _) => "",
                (true, crate::config::DefaultBrowser::Builtin) => BUILTIN_DEFAULT,
                (true, crate::config::DefaultBrowser::Yours) => YOURS_DEFAULT,
            };
            groups.push(Group {
                name: BROWSER,
                summary: format!("{BROWSER_SUMMARY}{default}"),
                tools,
            });
        }
        if settings.desktop.on(app) {
            groups.push(Group {
                name: CUA,
                summary: CUA_SUMMARY.into(),
                tools: crate::desktop::desktop_tools(),
            });
        }
        if docs {
            groups.push(Group {
                name: DOC,
                summary: DOC_SUMMARY.into(),
                tools: crate::docs::doc_tools(),
            });
        }
        match agents {
            AgentRole::Main => groups.push(Group {
                name: AGENTS,
                summary: AGENTS_SUMMARY.into(),
                tools: crate::agents::deferred_agent_tools(),
            }),
            AgentRole::SubAgent => groups.push(Group {
                name: AGENTS,
                summary: SUB_AGENT_AGENTS_SUMMARY.into(),
                tools: crate::agents::deferred_sub_agent_tools(),
            }),
            AgentRole::None => {}
        }
        Self { groups }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.groups.is_empty()
    }

    pub(crate) fn group(&self, name: &str) -> Option<&Group> {
        self.groups.iter().find(|g| g.name == name)
    }

    /// A tool by its name, and its group.
    pub(crate) fn find(&self, name: &str) -> Option<(&Group, &Arc<dyn Tool>)> {
        self.groups
            .iter()
            .find_map(|g| g.tools.iter().find(|t| t.spec().name == name).map(|t| (g, t)))
    }
}

#[cfg(test)]
mod tests {
    use super::Deferred;
    use crate::config::Config;
    use crate::system::SystemSettings;

    #[test]
    fn document_catalog_advertises_workbook_support() {
        let deferred = Deferred::of(&SystemSettings::of(&Config::default()), false, false, true, super::AgentRole::None);
        let doc = deferred.group("doc").expect("document group");
        assert!(doc.summary.contains("XLSX"));
        assert!(doc.summary.contains("cell ranges"));
        assert!(doc.summary.contains("formulas"));
        assert!(deferred.find("doc_open").is_some());
        assert!(deferred.find("doc_read").is_some());
    }
}
