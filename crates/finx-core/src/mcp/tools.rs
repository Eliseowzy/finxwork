//! `tool_search` and `call_tool`: how the model reaches the tools of deferred servers. Their
//! definitions never change, so the tool list stays the same for the whole session.

use async_trait::async_trait;
use finx_llm::ToolSpec;
use finx_tools::Environment;
use finx_tools::Tool;
use finx_tools::ToolCategory;
use finx_tools::ToolCtx;
use finx_tools::ToolDescription;
use finx_tools::ToolError;
use finx_tools::ToolKind;
use finx_tools::ToolOrigin;
use finx_tools::ToolOutput;
use parking_lot::Mutex;
use serde_json::Value;
use serde_json::json;
use std::collections::HashSet;
use std::fmt::Write as _;
use std::sync::Arc;

use super::Catalog;
use super::Entry;
use super::INSTRUCTIONS_LIMIT;
use super::McpManager;
use super::cap;

pub(crate) const SEARCH_TOOL: &str = "tool_search";
pub(crate) const CALL_TOOL: &str = "call_tool";
const DEFAULT_LIMIT: usize = 5;
const MAX_LIMIT: usize = 20;
/// Above this many tools, a server listing gives the names alone.
const LIST_LIMIT: usize = 100;

/// What a session's search results have shown since its last compaction: definitions and
/// server instructions are not repeated.
#[derive(Default)]
pub(crate) struct Shown {
    tools: HashSet<String>,
    servers: HashSet<String>,
}

impl Shown {
    pub(crate) fn clear(&mut self) {
        self.tools.clear();
        self.servers.clear();
    }
}

/// The two tools for one session, sharing its `shown` record.
pub(crate) fn kernel_tools(manager: &Arc<McpManager>, shown: &Arc<Mutex<Shown>>) -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(ToolSearch {
            manager: manager.clone(),
            shown: shown.clone(),
            spec: ToolSpec {
                name: SEARCH_TOOL.into(),
                description: "Search the tools of the MCP servers listed in <mcp_servers> and return their \
                    definitions. Those tools are not in your tool list: run them with call_tool. With `server` and no \
                    `query`, lists all tools of that server."
                    .into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Keywords, or a tool's full name. Several full names load several tools." },
                        "server": { "type": "string", "description": "Only search this server." },
                        "limit": { "type": "integer", "description": "Maximum number of tools to return (default 5, at most 20)." }
                    },
                    "additionalProperties": false
                }),
            },
        }),
        Arc::new(CallTool {
            manager: manager.clone(),
            spec: ToolSpec {
                name: CALL_TOOL.into(),
                description: "Run an MCP tool found with tool_search.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "The tool's full name, e.g. mcp__github__create_issue." },
                        "arguments": { "type": "object", "description": "Arguments matching the tool's parameters." }
                    },
                    "required": ["name", "arguments"],
                    "additionalProperties": false
                }),
            },
        }),
    ]
}

struct ToolSearch {
    manager: Arc<McpManager>,
    shown: Arc<Mutex<Shown>>,
    spec: ToolSpec,
}

impl ToolSearch {
    /// Writes a server's header (its instructions, the first time it appears).
    fn server_header(&self, out: &mut String, entry: &Entry) {
        let server = entry.server.name();
        let first = self.shown.lock().servers.insert(server.to_string());
        match entry.server.instructions().filter(|_| first) {
            Some(instructions) => {
                let _ = writeln!(out, "Server {server}: {}", cap(instructions.trim(), INSTRUCTIONS_LIMIT));
            }
            None => {
                let _ = writeln!(out, "Server {server}:");
            }
        }
    }

    fn describe_entry(&self, out: &mut String, entry: &Entry) {
        let description = finx_mcp::tool::description(&entry.info);
        let first = self.shown.lock().tools.insert(entry.qualified.clone());
        if first {
            let _ = writeln!(out, "- {}: {description}", entry.qualified);
            let _ = writeln!(out, "  {}", entry.parameters);
        } else {
            let _ = writeln!(out, "- {}: {} (definition shown earlier)", entry.qualified, first_sentence(&description));
        }
    }

    fn list_server(&self, catalog: &Catalog, server: &str) -> ToolOutput {
        let entries: Vec<&Entry> = catalog.entries.iter().filter(|e| e.deferred && e.server.name() == server).collect();
        let Some(first) = entries.first() else {
            return ToolOutput::error(format!(
                "No deferred MCP server named '{server}' has tools. Servers: {}.",
                self.deferred_servers(catalog).join(", ")
            ));
        };
        let mut out = String::new();
        self.server_header(&mut out, first);
        if entries.len() <= LIST_LIMIT {
            for entry in &entries {
                let description = finx_mcp::tool::description(&entry.info);
                let _ = writeln!(out, "- {}: {}", entry.qualified, first_sentence(&description));
            }
            out.push_str("Search with a tool's full name to get its parameters.\n");
            return ToolOutput::text(out);
        }
        // Every name, so none is missed, in a third of the room descriptions would take.
        let prefix = format!("mcp__{}__", finx_mcp::naming::sanitize(server));
        let names: Vec<&str> = entries
            .iter()
            .map(|e| e.qualified.strip_prefix(prefix.as_str()).unwrap_or(&e.qualified))
            .collect();
        let _ = writeln!(out, "{} tools; the full name of each is {prefix}<name>:", entries.len());
        let _ = writeln!(out, "{}", names.join(", "));
        out.push_str("Search with full names (several at once) or with `query` to get their descriptions and parameters.\n");
        ToolOutput::text(out)
    }

    fn deferred_servers(&self, _catalog: &Catalog) -> Vec<String> {
        self.manager
            .servers()
            .iter()
            .enumerate()
            .filter(|(i, _)| self.manager.is_deferred(*i))
            .map(|(_, s)| s.name().to_string())
            .collect()
    }
}

fn first_sentence(text: &str) -> &str {
    let line = text.lines().next().unwrap_or(text);
    match line.find(". ") {
        Some(end) => &line[..=end],
        None => line,
    }
}

#[async_trait]
impl Tool for ToolSearch {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    fn origin(&self) -> ToolOrigin {
        ToolOrigin::Mcp
    }

    fn describe(&self, args: &Value, _env: &dyn Environment) -> ToolDescription {
        let query = args.get("query").and_then(Value::as_str).unwrap_or_default();
        let server = args.get("server").and_then(Value::as_str);
        let title = match (query.trim(), server) {
            ("", Some(server)) => format!("list tools of {server}"),
            (query, Some(server)) => format!("search {server} for {query}"),
            (query, None) => format!("search tools for {query}"),
        };
        ToolDescription {
            category: ToolCategory::Search,
            title,
            locations: Vec::new(),
        }
    }

    async fn execute(&self, args: Value, ctx: ToolCtx) -> Result<ToolOutput, ToolError> {
        let query = args.get("query").and_then(Value::as_str).unwrap_or_default().trim().to_string();
        let server = args.get("server").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .map_or(DEFAULT_LIMIT, |l| (l as usize).clamp(1, MAX_LIMIT));
        if query.is_empty() && server.is_none() {
            return Ok(ToolOutput::error("Give a `query`, or a `server` to list its tools."));
        }
        self.manager.wait_for_deferred(&ctx.cancel).await;
        if ctx.cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        let catalog = self.manager.catalog();
        if query.is_empty() {
            return Ok(self.list_server(&catalog, server.unwrap_or_default()));
        }
        let hits: Vec<&Entry> = catalog
            .index
            .search(&query, catalog.index_entries.len())
            .into_iter()
            .map(|doc| &catalog.entries[catalog.index_entries[doc]])
            .filter(|entry| server.is_none_or(|s| entry.server.name() == s))
            .take(limit)
            .collect();
        let unavailable = self.manager.unavailable();
        if hits.is_empty() {
            let mut out = format!(
                "No matching tools. Deferred servers: {}. Try other words, or set `server` to list a server's tools.",
                self.deferred_servers(&catalog).join(", ")
            );
            if !unavailable.is_empty() {
                let _ = write!(out, "\nUnavailable now: {}.", unavailable.join("; "));
            }
            return Ok(ToolOutput::text(out));
        }
        // Grouped by server, in the order the servers first appear.
        let mut order: Vec<&str> = Vec::new();
        for hit in &hits {
            if !order.contains(&hit.server.name()) {
                order.push(hit.server.name());
            }
        }
        let mut out = String::new();
        for name in order {
            let group: Vec<&&Entry> = hits.iter().filter(|e| e.server.name() == name).collect();
            self.server_header(&mut out, group[0]);
            for entry in group {
                self.describe_entry(&mut out, entry);
            }
        }
        out.push_str("Run a tool with call_tool(name, arguments).\n");
        if !unavailable.is_empty() {
            let _ = writeln!(out, "Unavailable now: {}.", unavailable.join("; "));
        }
        Ok(ToolOutput::text(out))
    }
}

struct CallTool {
    manager: Arc<McpManager>,
    spec: ToolSpec,
}

impl CallTool {
    fn target(&self, args: &Value) -> Option<(Arc<finx_mcp::McpServer>, String, bool)> {
        let name = args.get("name").and_then(Value::as_str)?;
        let catalog = self.manager.catalog();
        let entry = catalog.find(name)?;
        let parallel = entry.info.read_only || entry.server.config().parallel_tools;
        Some((entry.server.clone(), entry.info.name.clone(), parallel))
    }
}

#[async_trait]
impl Tool for CallTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    fn kind(&self) -> ToolKind {
        ToolKind::Mutating
    }

    fn kind_for(&self, args: &Value) -> ToolKind {
        match self.target(args) {
            Some((_, _, parallel)) => finx_mcp::tool::kind(parallel),
            None => ToolKind::Mutating,
        }
    }

    fn origin(&self) -> ToolOrigin {
        ToolOrigin::Mcp
    }

    fn prepare_arguments(&self, mut args: Value) -> Value {
        // The arguments sent as a JSON string.
        let parsed = match args.get("arguments") {
            Some(Value::String(text)) => serde_json::from_str::<Value>(text).ok().filter(Value::is_object),
            _ => None,
        };
        if let Some(parsed) = parsed {
            args["arguments"] = parsed;
        }
        args
    }

    fn describe(&self, args: &Value, _env: &dyn Environment) -> ToolDescription {
        match self.target(args) {
            Some((server, tool, _)) => finx_mcp::tool::describe_call(&server, &tool),
            None => ToolDescription {
                category: ToolCategory::Other,
                title: match args.get("name").and_then(Value::as_str) {
                    Some(name) => format!("call {name}"),
                    None => CALL_TOOL.to_string(),
                },
                locations: Vec::new(),
            },
        }
    }

    async fn execute(&self, args: Value, ctx: ToolCtx) -> Result<ToolOutput, ToolError> {
        let Some(name) = args.get("name").and_then(Value::as_str) else {
            return Ok(ToolOutput::error("call_tool needs `name`: the full name of a tool found with tool_search."));
        };
        let mut target = self.target(&args);
        if target.is_none() {
            // Its server may still be connecting, for example right after a resume.
            self.manager.wait_for_deferred(&ctx.cancel).await;
            if ctx.cancel.is_cancelled() {
                return Err(ToolError::Cancelled);
            }
            target = self.target(&args);
        }
        let Some((server, tool, _)) = target else {
            return Ok(ToolOutput::error(format!("Unknown MCP tool '{name}'. Use tool_search to find tools.")));
        };
        let arguments = args.get("arguments").cloned().unwrap_or(Value::Null);
        finx_mcp::tool::call(&server, &tool, arguments, ctx).await
    }
}
