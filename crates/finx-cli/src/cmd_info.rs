//! `finx models`, `finx sessions`, `finx status`, `finx doctor`, `finx skills`, `finx trust`:
//! local commands, each printing text or, with `--json`, one JSON document.

use finx_core::JsonlStore;
use finx_core::SessionStore;
use finx_core::instructions;
use finx_core::skills;
use finx_core::skills::SkillEntry;
use finx_core::skills::SkillState;
use finx_llm::AuthStatus;
use finx_llm::ProviderConfig;
use finx_protocol::api::CredentialState;
use finx_protocol::api::ListingSource;
use finx_protocol::api::SessionDefaults;
use serde_json::Value;
use serde_json::json;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use crate::render::Style;
use crate::render::truncate;
use crate::setup;

fn auth_text(status: &AuthStatus) -> String {
    match status {
        AuthStatus::NotRequired => "no key needed".into(),
        AuthStatus::Managed => "managed connection".into(),
        AuthStatus::Configured(source) => format!("key from {source}"),
        AuthStatus::Stored => format!(
            "key from the {}",
            finx_llm::credentials::store_name().unwrap_or("credential store")
        ),
        AuthStatus::Missing(vars) if vars.is_empty() => "no key configured".into(),
        AuthStatus::Missing(vars) => format!("missing key: set {}", vars.join(" or ")),
        AuthStatus::Command => "key from command".into(),
    }
}

fn auth_json(status: &AuthStatus) -> Value {
    match status {
        AuthStatus::NotRequired => json!({ "status": "not_required" }),
        AuthStatus::Managed => json!({ "status": "connection" }),
        AuthStatus::Configured(source) => json!({ "status": "configured", "source": source }),
        AuthStatus::Stored => {
            json!({ "status": "configured", "source": finx_llm::credentials::store_name().unwrap_or("stored") })
        }
        AuthStatus::Missing(vars) => json!({ "status": "missing", "env": vars }),
        AuthStatus::Command => json!({ "status": "command" }),
    }
}

/// The provider's key from the environment, masked for display.
fn masked_key(provider: &ProviderConfig) -> Option<String> {
    let key = provider
        .auth
        .env_vars()
        .iter()
        .find_map(|v| std::env::var(v).ok())?;
    Some(finx_llm::mask_key(&key))
}

fn print_json(value: &Value) -> anyhow::Result<()> {
    // Buffered: stdout flushes every line, and a long listing has thousands.
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    serde_json::to_writer_pretty(&mut out, value)?;
    writeln!(out)?;
    out.flush()?;
    Ok(())
}

pub fn models(
    overrides: &[String],
    provider: Option<&str>,
    all: bool,
    refresh: bool,
    as_json: bool,
    action: Option<crate::ModelsAction>,
) -> anyhow::Result<u8> {
    let rt = setup::init_local(std::env::current_dir()?, overrides)?;
    if let Some(action @ (crate::ModelsAction::Login { .. } | crate::ModelsAction::Logout { .. } | crate::ModelsAction::Status { .. } | crate::ModelsAction::Forget { .. })) = &action {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        let status = runtime.block_on(async {
            let chatgpt = &rt.connections.chatgpt;
            match action {
                crate::ModelsAction::Status { .. } => Ok(chatgpt.status()?),
                crate::ModelsAction::Logout { .. } => Ok(chatgpt.logout().await?),
                crate::ModelsAction::Forget { .. } => { chatgpt.forget().await?; Ok(chatgpt.status()?) },
                _ => {
                    let started = chatgpt.start().await?;
                    if let Some(url) = &started.authorize_url {
                        // Print a URL for browser-less terminals; never launch a shell with it.
                        writeln!(std::io::stderr(), "Open this URL to connect ChatGPT API:\n{url}")?;
                    }
                    loop {
                        tokio::select! {
                            _ = tokio::signal::ctrl_c() => {
                                if let Some(id) = &started.login_id { let _ = chatgpt.cancel(id); }
                                anyhow::bail!("ChatGPT sign-in cancelled");
                            }
                            _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {}
                        }
                        let status = chatgpt.status()?;
                        match status.state {
                            finx_protocol::api::ChatGptLoginState::Pending => continue,
                            finx_protocol::api::ChatGptLoginState::Connected => break Ok(status),
                            _ => anyhow::bail!("{}", status.message.unwrap_or_else(|| "ChatGPT sign-in did not complete".into())),
                        }
                    }
                }
            }
        })?;
        print_json(&serde_json::to_value(status)?)?;
        return Ok(0);
    }
    anyhow::ensure!(
        provider.is_none_or(|wanted| rt.llm.provider(wanted).is_some()),
        "unknown provider '{}'",
        provider.unwrap_or_default()
    );
    let defaults = SessionDefaults {
        model: rt.config.model.clone(),
        thinking: rt.config.thinking,
        permission_mode: rt.config.permission_mode,
    };
    if let Some(action) = action {
        let (reference, shown) = match &action {
            crate::ModelsAction::Show { model } => (model, true),
            crate::ModelsAction::Hide { model } => (model, false),
            _ => unreachable!("connection actions handled above"),
        };
        finx_core::models::set_shown(&rt.llm, &defaults.model, reference, shown).map_err(anyhow::Error::msg)?;
        return Ok(0);
    }
    let mut problems = Vec::new();
    if refresh {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        runtime.block_on(async {
            if rt.connections.chatgpt.status().ok().is_some_and(|s| s.connection.is_some())
                && let Err(e) = rt.connections.chatgpt.refresh().await
            { problems.push(format!("ChatGPT API: {}", e.message)); }
            if let Err(e) = rt.llm.refresh_catalog(&finx_core::models::catalog_url()).await {
                problems.push(format!("public model catalog: {}", e.message));
            }
            let targets: Vec<String> = finx_core::models::refreshable(&rt.llm)
                .into_iter()
                .filter(|id| provider.is_none_or(|wanted| rt.llm.provider(wanted).is_some_and(|p| p.listing.from.as_deref().unwrap_or(wanted) == id)))
                .collect();
            let results = futures::future::join_all(targets.iter().map(|id| rt.llm.refresh_list(id, None))).await;
            for (id, result) in targets.iter().zip(results) {
                if let Err(e) = result {
                    problems.push(format!("{id}: {}", e.message));
                }
            }
        });
    }
    let mut listing = finx_core::models::list(&rt.llm, &defaults, &|_| false);
    if let Some(wanted) = provider {
        listing.providers.retain(|p| p.id == wanted);
        listing.models.retain(|m| m.provider == wanted);
    }
    if as_json {
        print_json(&serde_json::to_value(&listing)?)?;
        return Ok(0);
    }
    let style = Style::detect();
    // One write for the whole listing instead of one per line.
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    for problem in &problems {
        writeln!(out, "{}", style.dim(&format!("refresh failed: {problem}")))?;
    }
    for p in &listing.providers {
        let Some(config) = rt.llm.provider(&p.id) else { continue };
        let mut head = format!("{}  {}  [{}]", p.id, p.name, auth_text(&config.auth.status(&p.id)));
        if let Some(l) = &p.listing {
            let source = match l.source {
                ListingSource::Provider => "provider's list",
                ListingSource::Catalog => "public catalog",
                ListingSource::Unsupported => "no list",
                ListingSource::Config => "models.toml",
            };
            head.push_str(&format!("  {} of {} shown, from the {source}", l.shown, l.models));
            if let Some(at) = &l.fetched_at {
                head.push_str(&format!(", {at}"));
            }
        }
        writeln!(out, "{head}")?;
        if let Some(error) = p.listing.as_ref().and_then(|l| l.error.as_ref()) {
            writeln!(out, "    {}", style.dim(&format!("last refresh failed ({}): {}", error.kind, error.message)))?;
        }
        let rows: Vec<_> = listing.models.iter().filter(|m| m.provider == p.id && (all || m.shown)).collect();
        if rows.is_empty() && p.credential != CredentialState::Missing {
            writeln!(out, "    {}", style.dim(&format!("(no models shown; use {}/<model-id> or --all)", p.id)))?;
        }
        for m in rows {
            let mut traits = Vec::new();
            if m.reasoning {
                traits.push("reasoning");
            }
            if m.images {
                traits.push("images");
            }
            if !m.known {
                traits.push("details unknown");
            }
            if m.deprecated {
                traits.push("deprecated");
            }
            if !m.shown {
                traits.push("hidden");
            }
            if !m.available {
                traits.push("no key");
            }
            let marker = if m.id == defaults.model { " (default)" } else { "" };
            writeln!(
                out,
                "    {}{marker}  {}  context {}{}",
                m.id,
                m.name,
                m.context_window,
                if traits.is_empty() { String::new() } else { format!("  {}", traits.join(", ")) }
            )?;
        }
    }
    out.flush()?;
    Ok(0)
}

pub fn sessions(all: bool, limit: usize, as_json: bool) -> anyhow::Result<u8> {
    let home = setup::home()?;
    let store = JsonlStore::new(home.sessions_dir());
    let workspace = if all {
        None
    } else {
        Some(setup::workspace(&std::env::current_dir()?))
    };
    let list = store.list(limit, workspace.as_deref())?;
    if as_json {
        let rows: Vec<Value> = list
            .iter()
            .map(|s| {
                json!({
                    "id": s.id,
                    "short_id": finx_core::short_id(&s.id),
                    "created_at": s.created_at,
                    "cwd": s.cwd,
                    "title": s.title,
                    "first_message": s.first_message,
                    "file": s.location,
                })
            })
            .collect();
        print_json(&Value::Array(rows))?;
        return Ok(0);
    }
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    if list.is_empty() {
        let none = if all {
            "no sessions yet"
        } else {
            "no sessions in this project yet (`finx sessions --all` lists every project)"
        };
        writeln!(out, "{none}")?;
    }
    for s in list {
        let short = finx_core::short_id(&s.id);
        let label = s.title.or(s.first_message).unwrap_or_default();
        writeln!(
            out,
            "{short}  {}  {}  {}",
            s.created_at,
            s.cwd.display(),
            truncate(&label, 60)
        )?;
    }
    out.flush()?;
    Ok(0)
}

fn file_entry(path: &Path) -> Value {
    json!({ "path": path, "exists": path.exists() })
}

pub fn status(overrides: &[String], as_json: bool) -> anyhow::Result<u8> {
    let rt = setup::init_local(std::env::current_dir()?, overrides)?;
    let project_dir = rt.project_root.clone().unwrap_or_else(|| rt.cwd.clone());
    let resolved = rt.llm.resolve(&rt.config.model);
    let provider = resolved
        .as_ref()
        .ok()
        .and_then(|r| rt.llm.provider(&r.model.provider));
    let model = match &resolved {
        Ok(r) => json!({
            "ref": r.model.reference(),
            "in_catalog": !r.ad_hoc,
            "api": r.model.api,
            "endpoint": r.model.base_url,
        }),
        Err(err) => json!({ "ref": rt.config.model, "error": err.to_string() }),
    };
    let skill_report = scan_skills(rt);
    let skills_line = if rt.config.skills.enabled {
        format!(
            "{} ({} in the catalog, about {} tokens)",
            skill_report.set.active().count(),
            skill_report.catalog.listed,
            skill_report.catalog.tokens
        )
    } else {
        "off".to_string()
    };
    let info = json!({
        "version": env!("CARGO_PKG_VERSION"),
        "model": model,
        "credentials": provider.as_ref().map(|p| {
            let mut auth = auth_json(&p.auth.status(&p.id));
            if let Some(key) = masked_key(&p) {
                auth["key"] = json!(key);
            }
            auth
        }),
        "thinking": rt.config.thinking,
        "permission_mode": rt.config.permission_mode,
        "tools": rt.config.enabled_tools,
        "mcp_servers": rt.mcp_servers.iter().filter(|s| s.is_enabled()).map(|s| s.name.as_str()).collect::<Vec<_>>(),
        "skills": {
            "enabled": rt.config.skills.enabled,
            "active": skill_report.set.active().count(),
            "listed": skill_report.catalog.listed,
            "catalog_tokens": skill_report.catalog.tokens,
            "catalog_budget": skill_report.catalog.budget,
        },
        "env_overrides": rt.env_overrides,
        "workspace": setup::workspace(&rt.cwd),
        "project_root": rt.project_root,
        "trusted": rt.trusted,
        "files": {
            "user_config": file_entry(&rt.home.config_file()),
            "project_config": file_entry(&project_dir.join(".finx").join("config.toml")),
            "models": file_entry(&rt.home.models_file()),
        },
        "data_dir": rt.home.root(),
        "sessions_dir": rt.home.sessions_dir(),
        "logs_dir": rt.home.logs_dir(),
        "warnings": rt.warnings,
    });
    if as_json {
        print_json(&info)?;
        return Ok(0);
    }
    let text = |value: &Value| match value {
        Value::Null => "-".to_string(),
        Value::Array(items) if items.is_empty() => "-".to_string(),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string))
            .collect::<Vec<_>>()
            .join(", "),
        other => other.to_string(),
    };
    let model_line = match &resolved {
        Ok(r) => format!(
            "{}{} · {} · {}",
            r.model.reference(),
            if r.ad_hoc {
                " (not in the catalog)"
            } else {
                ""
            },
            r.model.api,
            r.model.base_url
        ),
        Err(err) => format!("{} ({err})", rt.config.model),
    };
    let credentials = match provider {
        Some(p) => format!(
            "{}{}",
            auth_text(&p.auth.status(&p.id)),
            masked_key(&p)
                .map(|k| format!(" ({k})"))
                .unwrap_or_default()
        ),
        None => "-".to_string(),
    };
    let file_line = |path: &Path| {
        format!(
            "{}{}",
            path.display(),
            if path.exists() { "" } else { " (not present)" }
        )
    };
    let project = match &rt.project_root {
        Some(root) => format!(
            "{} ({})",
            root.display(),
            if rt.trusted { "trusted" } else { "not trusted" }
        ),
        None => "none (no .git found)".into(),
    };
    let rows = [
        ("version", env!("CARGO_PKG_VERSION").to_string()),
        ("model", model_line),
        ("credentials", credentials),
        ("thinking", text(&info["thinking"])),
        ("permissions", text(&info["permission_mode"])),
        ("tools", text(&info["tools"])),
        ("mcp servers", mcp_line(rt)),
        ("skills", skills_line),
        ("from environment", text(&info["env_overrides"])),
        ("project", project),
        ("user config", file_line(&rt.home.config_file())),
        (
            "project config",
            file_line(&project_dir.join(".finx").join("config.toml")),
        ),
        ("models.toml", file_line(&rt.home.models_file())),
        ("sessions", rt.home.sessions_dir().display().to_string()),
        ("logs", rt.home.logs_dir().display().to_string()),
    ];
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    for (label, value) in rows {
        writeln!(out, "{label:<17}{value}")?;
    }
    let style = Style::detect();
    for warning in &rt.warnings {
        writeln!(out, "{}", style.yellow(&format!("warning: {warning}")))?;
    }
    out.flush()?;
    Ok(0)
}

/// How many MCP servers a session here starts, and their names.
fn mcp_line(rt: &setup::Runtime) -> String {
    if !rt.config.mcp.enabled {
        return "off (mcp.enabled = false)".to_string();
    }
    let names: Vec<&str> = rt.mcp_servers.iter().filter(|s| s.is_enabled()).map(|s| s.name.as_str()).collect();
    if names.is_empty() {
        return "-".to_string();
    }
    format!("{} ({})", names.len(), names.join(", "))
}

struct Check {
    name: &'static str,
    ok: bool,
    detail: String,
}

pub fn doctor(overrides: &[String], as_json: bool) -> anyhow::Result<u8> {
    let mut checks = Vec::new();
    let mut warnings = Vec::new();
    let mut check =
        |name: &'static str, ok: bool, detail: String| checks.push(Check { name, ok, detail });
    match setup::init_local(std::env::current_dir()?, overrides) {
        Err(err) => check("configuration", false, format!("{err:#}")),
        Ok(rt) => {
            check("data directory", true, rt.home.root().display().to_string());
            let config_file = rt.home.config_file();
            check(
                "user config",
                true,
                if config_file.exists() {
                    config_file.display().to_string()
                } else {
                    "not present (defaults)".into()
                },
            );
            let models_file = rt.home.models_file();
            check(
                "models.toml",
                true,
                if models_file.exists() {
                    models_file.display().to_string()
                } else {
                    "not present (built-in catalog)".into()
                },
            );
            let project = rt
                .project_root
                .as_ref()
                .map(|p| {
                    format!(
                        "{} ({})",
                        p.display(),
                        if rt.trusted { "trusted" } else { "not trusted" }
                    )
                })
                .unwrap_or_else(|| "none (no .git found)".into());
            check("project", true, project);
            match rt.llm.resolve(&rt.config.model) {
                Ok(resolved) => {
                    check("default model", true, rt.config.model.clone());
                    if let Some(provider) = rt.llm.provider(&resolved.model.provider) {
                        let status = provider.auth.status(&provider.id);
                        let missing = matches!(status, AuthStatus::Missing(_));
                        let masked = masked_key(&provider)
                            .map(|k| format!(" ({k})"))
                            .unwrap_or_default();
                        check(
                            "credentials",
                            !missing,
                            format!("{}{masked}", auth_text(&status)),
                        );
                    }
                }
                Err(err) => check("default model", false, err.to_string()),
            }
            let shell = if PathBuf::from("/bin/bash").exists() { "/bin/bash" } else { "/bin/sh" };
            check("shell", true, rt.config.bash_shell.clone().unwrap_or_else(|| shell.to_string()));
            // Broken skills are reported, but they do not make the setup fail.
            let report = scan_skills(rt);
            let active = report.set.active().count();
            let broken = report.set.entries.iter().filter(|e| e.state == SkillState::Invalid).count();
            let detail = match (rt.config.skills.enabled, broken) {
                (false, _) => "turned off".to_string(),
                (true, 0) => format!("{active} loaded"),
                (true, broken) => format!("{active} loaded, {broken} failed to load (`finx skills --all`)"),
            };
            check("skills", true, detail);
            warnings = rt.warnings.clone();
            warnings.extend(report.warnings());
        }
    }
    let ok = checks.iter().all(|c| c.ok);
    if as_json {
        let checks: Vec<Value> = checks
            .iter()
            .map(|c| json!({ "name": c.name, "ok": c.ok, "detail": c.detail }))
            .collect();
        print_json(&json!({ "ok": ok, "checks": checks, "warnings": warnings }))?;
    } else {
        let style = Style::detect();
        for c in &checks {
            let mark = if c.ok {
                style.green("✓")
            } else {
                style.red("✗")
            };
            println!("{mark} {}: {}", c.name, c.detail);
        }
        for warning in &warnings {
            println!("{} {warning}", style.yellow("!"));
        }
    }
    Ok(if ok { 0 } else { 1 })
}

/// The skills of a session that would start in `rt.cwd`, and its catalog. Without a model,
/// the budget is the largest default.
fn scan_skills(rt: &setup::Runtime) -> skills::Scan {
    let window = rt
        .llm
        .resolve(&rt.config.model)
        .map_or(u64::MAX, |resolved| u64::from(resolved.model.context_window));
    let sources = skills::Sources::new(&rt.home, &rt.cwd, rt.project_root.as_deref(), &rt.config.skills);
    skills::Scan::new(&sources, &rt.config.enabled_tools, window)
}

/// `path` relative to `cwd` when inside it, else with the home directory as `~`.
fn short_path(path: &Path, cwd: &Path, home: Option<&Path>) -> String {
    if let Ok(rel) = path.strip_prefix(cwd) {
        return rel.display().to_string();
    }
    match home.and_then(|home| path.strip_prefix(home).ok()) {
        Some(rel) => format!("~/{}", rel.display()),
        None => path.display().to_string(),
    }
}

pub fn skills(overrides: &[String], dir: Option<PathBuf>, all: bool, as_json: bool) -> anyhow::Result<u8> {
    let cwd = match dir {
        Some(dir) => dir,
        None => std::env::current_dir()?,
    };
    let rt = setup::init_local(cwd, overrides)?;
    let report = scan_skills(rt);
    if as_json {
        print_json(&serde_json::to_value(report.report(all))?)?;
        return Ok(0);
    }
    let shown: Vec<&SkillEntry> = report
        .set
        .entries
        .iter()
        .filter(|e| all || e.state == SkillState::Active)
        .collect();
    let catalog = &report.catalog;
    let style = Style::detect();
    let home = rt.home.user_home();
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    if !rt.config.skills.enabled {
        writeln!(out, "skills are turned off (skills.enabled = false)")?;
    } else if report.set.entries.is_empty() {
        writeln!(
            out,
            "no skills found; add one as .agents/skills/<name>/SKILL.md in the project \
             or ~/.finx/skills/<name>/SKILL.md"
        )?;
    }
    let width = shown.iter().map(|e| e.name.chars().count()).max().unwrap_or(0);
    for entry in &shown {
        let remark = match entry.state {
            SkillState::Active if !entry.model_invocable => "only when the user invokes it".to_string(),
            SkillState::Active => String::new(),
            SkillState::Shadowed => format!(
                "shadowed by {}",
                entry.detail.as_deref().map(|p| short_path(Path::new(p), &rt.cwd, home)).unwrap_or_default()
            ),
            SkillState::Disabled if !entry.default_enabled => format!(
                "off by default; finx skills enable {} turns it on",
                short_path(entry.dir(), &rt.cwd, home)
            ),
            SkillState::Disabled => "disabled".to_string(),
            SkillState::Invalid => format!("not loaded: {}", entry.detail.as_deref().unwrap_or_default()),
        };
        let line = format!(
            "{:<8} {:<width$}  {}{}",
            entry.scope.as_str(),
            entry.name,
            short_path(&entry.path, &rt.cwd, home),
            if remark.is_empty() { String::new() } else { format!("  {remark}") },
        );
        let line = if entry.state == SkillState::Active { line } else { style.dim(&line) };
        writeln!(out, "{line}")?;
        if all {
            for note in &entry.notes {
                writeln!(out, "{}", style.dim(&format!("{:<8} {:<width$}  note: {note}", "", "")))?;
            }
        }
    }
    let hidden = report.set.entries.len() - report.set.active().count();
    if !all && hidden > 0 {
        let hint = format!("{hidden} more shadowed, disabled or broken; `finx skills --all` lists them");
        writeln!(out, "{}", style.dim(&hint))?;
    }
    if rt.config.skills.enabled && catalog.listed > 0 {
        writeln!(
            out,
            "catalog: {} skills, about {} tokens (budget {})",
            catalog.listed, catalog.tokens, catalog.budget
        )?;
    }
    if !report.set.not_read.is_empty() {
        let dirs: Vec<String> = report.set.not_read.iter().map(|d| short_path(d, &rt.cwd, home)).collect();
        let note = format!("not read: {} (skills.other_apps is off)", dirs.join(", "));
        writeln!(out, "{}", style.dim(&note))?;
    }
    for warning in report.warnings() {
        writeln!(out, "{}", style.yellow(&format!("warning: {warning}")))?;
    }
    out.flush()?;
    Ok(0)
}

/// `finx browser install` (browser-design D-194).
pub async fn browser_install() -> anyhow::Result<u8> {
    let home = setup::home()?;
    let dir = home.browser_dir();
    if let Some(found) = finx_browser::launch::find_executable() {
        eprintln!("note: {} is installed; the browser tools use it, not the one installed now", found.display());
    }
    eprintln!("installing Chrome for Testing into {}", dir.join("chromium").display());
    let shown = std::sync::atomic::AtomicU64::new(0);
    let result = finx_core::browser_install::install(&dir, |received, total| {
        // About every 5 MB.
        let mb = received >> 20;
        if mb >= shown.load(std::sync::atomic::Ordering::Relaxed) + 5 {
            shown.store(mb, std::sync::atomic::Ordering::Relaxed);
            match total {
                Some(total) => eprint!("\r  {mb} / {} MB", total >> 20),
                None => eprint!("\r  {mb} MB"),
            }
        }
    })
    .await;
    eprintln!();
    match result {
        Ok(installed) if installed.unchanged => {
            println!("Chrome for Testing {} is installed already: {}", installed.version, installed.executable.display());
            Ok(0)
        }
        Ok(installed) => {
            println!("installed Chrome for Testing {}: {}", installed.version, installed.executable.display());
            Ok(0)
        }
        Err(err) => {
            eprintln!("finx: {err}");
            Ok(1)
        }
    }
}

pub fn trust(dir: Option<PathBuf>) -> anyhow::Result<u8> {
    let home = setup::home()?;
    let dir = match dir {
        Some(dir) => dir,
        None => std::env::current_dir()?,
    };
    let dir = std::fs::canonicalize(&dir)?;
    let root = instructions::find_project_root(&dir, &[".git".to_string()]).unwrap_or(dir);
    if instructions::trust(&home, &root)? {
        println!("trusted {}", root.display());
    } else {
        println!("{} was already trusted", root.display());
    }
    Ok(0)
}
