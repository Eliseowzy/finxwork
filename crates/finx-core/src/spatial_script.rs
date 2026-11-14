//! `spatial_script`: runs a Python script over a volume document (spatial-design §5.3, §13).
//!
//! Two steps. `uv sync` installs the skill's locked dependencies (network, no script runs);
//! then `uv run --offline` runs the script, on macOS inside `sandbox-exec`: no network, writes
//! only to the work directory. The script reads `volume.npy`, `meta.json` and `masks/*.npy`
//! through the `finx_spatial` module and writes `out/submit.jsonl`; every line is checked here
//! and the accepted ones go to [`ScriptData::apply`]. Each run is kept under
//! `$FINX_HOME/docs/<doc_id>/scripts/<n>/`.
//!
//! Trust (§5.3): a skill's own script runs without asking (the skill was trusted when it was
//! enabled); a script the model wrote is approved by the permission mode, the card showing the
//! purpose first and then the whole script.

use async_trait::async_trait;
use finx_tools::Tool;
use finx_tools::ToolCategory;
use finx_tools::ToolCtx;
use finx_tools::ToolDescription;
use finx_tools::ToolError;
use finx_tools::ToolKind;
use finx_tools::ToolOutput;
use finx_tools::Typed;
use finx_tools::TypedTool;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use std::io::Write as _;
use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::paths::FinxHome;

pub(crate) const NAME: &str = "spatial_script";

/// Where the volume and masks come from, and where accepted submissions go. Implemented by the
/// spatial document backend.
#[async_trait]
pub(crate) trait ScriptData: Send + Sync {
    /// Writes `volume.npy` (int16, shape k,j,i), `meta.json` and `masks/<id>.npy` (bool) into
    /// `dir` (§13). [`write_npy_i16`] and [`write_npy_bool`] write the arrays. `meta.json`:
    /// `{"spacing": [dk,dj,di], "origin": [..], "direction": [..9], "unit": "HU",
    ///   "image_numbers": [one per k], "k_towards_head": bool, "masks": {"<id>": "masks/<id>.npy"}}`.
    fn export(&self, doc_id: &str, dir: &Path) -> Result<(), String>;
    /// Turns checked submissions into document operations (one revision). Structure masks are
    /// already copied to the run's archive; their paths are absolute. Async because it stores the
    /// revision: it must be awaited, never blocked on (a single-threaded runtime cannot block).
    async fn apply(&self, doc_id: &str, submissions: Vec<Submission>) -> Result<Summary, String>;
}

/// What [`ScriptData::apply`] did, in a sentence or two for the model.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub(crate) struct Summary {
    pub text: String,
}

/// One accepted line of `out/submit.jsonl`. Voxel indexes are `[k, j, i]`, checked against the
/// volume's shape. `run` is the number of the run (its archive folder), set by the kernel.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum Submission {
    Candidate(Candidate),
    Marker(Marker),
    Structure(Structure),
    Finding(Finding),
    Profile(Profile),
}

/// Who a script says a marker or finding comes from. `user` cannot come from a script.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ScriptSource {
    Reference,
    Ai,
}

/// A place worth checking (a hint, not a finding). Fields the script adds beyond these
/// (mean_hu, sphericity, contact, …) are kept in `details`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct Candidate {
    pub center_voxel: [u32; 3],
    pub diameter_mm: Option<f64>,
    pub kind: Option<String>,
    pub score: Option<f64>,
    pub rank: Option<u32>,
    pub note: Option<String>,
    pub source_script: Option<String>,
    pub reference_label: Option<String>,
    pub details: Map<String, Value>,
    pub run: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct Marker {
    pub center_voxel: [u32; 3],
    pub label: String,
    pub source: ScriptSource,
    pub note: Option<String>,
    pub run: u32,
}

/// A mask the script built: `mask` is an absolute path to a bool .npy of the volume's shape.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct Structure {
    pub id: String,
    pub name: String,
    /// `#rrggbb`.
    pub color: String,
    /// 0..=1; the viewer's default when absent.
    pub opacity: Option<f64>,
    /// Kept as a mask for later scripts, with no surface shown.
    pub hidden: bool,
    /// The volume the script expects, mL `[least, most]`: outside it the structure is reported
    /// as unreliable. The kernel holds no idea of how big anything should be.
    pub expect_ml: Option<[f64; 2]>,
    /// What the script wants said about how it was built (a fallback taken, a part left out).
    pub notes: Vec<String>,
    /// The script's own reason not to trust the structure (it leaked, no seed was found).
    pub unreliable: Option<String>,
    pub mask: PathBuf,
    pub run: u32,
}

/// How the document is shown and read: the labels on the axes, the unit, named windows and the
/// line shown with AI findings. All of it is the skill's; the kernel only stores it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct Profile {
    pub orientation: Option<String>,
    pub unit: Option<String>,
    /// `[name, width, level]`, in order.
    pub windows: Vec<(String, f64, f64)>,
    pub disclaimer: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct Finding {
    pub name: String,
    pub summary: String,
    pub source: ScriptSource,
    pub center_voxel: Option<[u32; 3]>,
    pub radius_mm: Option<f64>,
    pub measures: Map<String, Value>,
    pub evidence: Vec<String>,
    pub report_item: Option<String>,
    pub run: u32,
}

/// What a session's `spatial_script` needs; inserted into the session state by the kernel.
pub(crate) struct ScriptHandle {
    pub data: Arc<dyn ScriptData>,
    pub home: FinxHome,
    /// Folders holding skills, searched in order for `<skill>/…`.
    pub skill_roots: Vec<PathBuf>,
}

impl ScriptHandle {
    pub(crate) fn new(data: Arc<dyn ScriptData>, home: FinxHome) -> Self {
        let skill_roots = vec![home.system_skills_dir(), home.skills_dir()];
        Self { data, home, skill_roots }
    }
}

pub(crate) fn tool() -> Arc<dyn Tool> {
    Arc::new(Typed::new(SpatialScript))
}

const DEFAULT_SKILL: &str = "medical-imaging";
const MIRROR_INDEX: &str = "https://mirrors.aliyun.com/pypi/simple/";
const MIRROR_FILES: &str = "https://mirrors.aliyun.com/pypi/packages/";
const MIRROR_PYTHON: &str = "https://registry.npmmirror.com/-/binary/python-build-standalone";
const OFFICIAL_INDEX: &str = "https://pypi.org/simple";
const OFFICIAL_FILES: &str = "https://files.pythonhosted.org/packages/";
const STALL: Duration = Duration::from_secs(60);
const SYNC_LIMIT: Duration = Duration::from_secs(30 * 60);
const FIRST_DOWNLOAD: &str = "about 120 MB (Python 3.12 and numpy, scipy, scikit-image, SimpleITK), about 350 MB on disk";
const MAX_LINES: usize = 2000;
const MAX_TEXT: usize = 2000;
const STDOUT_HEAD: usize = 6000;
const STDERR_TAIL: usize = 3000;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct Args {
    /// The spatial document (volume) the script reads.
    pub doc_id: String,
    /// One plain sentence saying what the script does and why, shown to the user first.
    pub purpose: String,
    /// A script that comes with a skill, as `<skill>/scripts/<file>.py`,
    /// e.g. `medical-imaging/scripts/lung_nodule_candidates.py`. Runs without asking.
    #[serde(default)]
    pub skill_script: Option<String>,
    /// Python code you wrote; the user approves it. Give this or `skill_script`, not both.
    #[serde(default)]
    pub script: Option<String>,
    /// For `script`: whose Python environment it runs in (default `medical-imaging`).
    #[serde(default)]
    pub skill: Option<String>,
    /// Passed to the script as one JSON string in argv[1].
    #[serde(default)]
    pub args: Option<Value>,
    /// Seconds the script may run (default 600, at most 1800). Installing does not count.
    #[serde(default)]
    pub timeout_s: Option<u64>,
}

struct SpatialScript;

const DESCRIPTION: &str = "Run a Python script over a volume document (a CT). The script reads the volume with `from finx_spatial import load, submit` (load().hu is int16 HU shaped k,j,i; .spacing (dk,dj,di) mm; .segment(name) a bool mask; .slice_of_image(n); .k_towards_head) and submits results with submit.candidates / marker / structure / finding. It runs with no network and can write only its work folder. The first run downloads Python and the skill's packages (about 120 MB); say so to the user before. Prefer a skill's own script (`skill_script`); write `script` only when none fits. Returns stdout, what was submitted and accepted, or the end of the error.";

#[async_trait]
impl TypedTool for SpatialScript {
    type Args = Args;
    const NAME: &'static str = NAME;
    const DESCRIPTION: &'static str = DESCRIPTION;

    fn kind(&self) -> ToolKind {
        ToolKind::Mutating
    }

    fn describe(&self, args: &Value, _env: &dyn finx_tools::Environment) -> ToolDescription {
        let what = args
            .get("skill_script")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| args.get("purpose").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_else(|| NAME.into());
        ToolDescription { category: ToolCategory::Execute, title: format!("{NAME}: {what}"), locations: Vec::new() }
    }

    async fn check(&self, args: &Args, _ctx: &ToolCtx) -> Result<(), ToolError> {
        check_args(args).map_err(ToolError::InvalidArgs)
    }

    async fn run(&self, args: Args, ctx: ToolCtx) -> Result<ToolOutput, ToolError> {
        let handle = ctx
            .session_state
            .get::<ScriptHandle>()
            .ok_or_else(|| ToolError::Failed("spatial scripts are not available in this session".into()))?;
        run(&handle, args, &ctx).await
    }
}

fn check_args(args: &Args) -> Result<(), String> {
    safe_name(&args.doc_id).map_err(|e| format!("doc_id: {e}"))?;
    if args.purpose.trim().is_empty() {
        return Err("purpose: say in one sentence what the script does".into());
    }
    match (&args.skill_script, &args.script) {
        (Some(_), Some(_)) | (None, None) => return Err("give exactly one of `skill_script` and `script`".into()),
        (Some(path), None) => {
            split_skill_script(path)?;
        }
        (None, Some(code)) if code.trim().is_empty() => return Err("script is empty".into()),
        _ => {}
    }
    if let Some(skill) = &args.skill {
        safe_name(skill).map_err(|e| format!("skill: {e}"))?;
    }
    Ok(())
}

fn safe_name(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 128 || s.starts_with('.') || !s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
        return Err(format!("`{s}` is not a plain name"));
    }
    Ok(())
}

/// `<skill>/<path>` with no `..`, absolute parts or hidden folders.
fn split_skill_script(path: &str) -> Result<(String, PathBuf), String> {
    let mut parts = path.split('/');
    let skill = parts.next().unwrap_or_default().to_owned();
    safe_name(&skill).map_err(|e| format!("skill_script: {e}"))?;
    let rest: Vec<&str> = parts.collect();
    if rest.is_empty() || !path.ends_with(".py") || rest.iter().any(|p| p.is_empty() || p.starts_with('.')) {
        return Err(format!("skill_script `{path}`: want `<skill>/scripts/<file>.py`"));
    }
    Ok((skill, rest.iter().collect()))
}

/// The approval card for a script the model wrote: purpose first, then the whole script.
pub(crate) fn approval_summary(args: &Value) -> String {
    let get = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("");
    let isolation = if cfg!(target_os = "macos") {
        "Runs without network and can write only its work folder."
    } else {
        "Not isolated on this system: the script can use the network and write your files."
    };
    let script_args = args.get("args").map(|v| format!("\nargs: {v}")).unwrap_or_default();
    format!("{}\n{isolation}\ndoc: {}{script_args}\n\n{}", get("purpose"), get("doc_id"), get("script"))
}

/// Whether a call runs without asking: a skill's own script does.
pub(crate) fn runs_unasked(args: &Value) -> bool {
    args.get("skill_script").and_then(Value::as_str).is_some() && args.get("script").is_none()
}

async fn run(handle: &ScriptHandle, args: Args, ctx: &ToolCtx) -> Result<ToolOutput, ToolError> {
    let (skill, script_file, code) = match (&args.skill_script, &args.script) {
        (Some(path), _) => {
            let (skill, rel) = split_skill_script(path).map_err(ToolError::InvalidArgs)?;
            let dir = find_skill(handle, &skill).ok_or_else(|| ToolError::Failed(format!("no skill `{skill}`")))?;
            let file = dir.join(&rel);
            let code = std::fs::read_to_string(&file).map_err(|e| ToolError::Failed(format!("{path}: {e}")))?;
            (skill, Some(file), code)
        }
        (None, Some(code)) => (args.skill.clone().unwrap_or_else(|| DEFAULT_SKILL.into()), None, code.clone()),
        (None, None) => return Err(ToolError::InvalidArgs("give `skill_script` or `script`".into())),
    };
    let skill_dir = find_skill(handle, &skill).ok_or_else(|| ToolError::Failed(format!("no skill `{skill}`")))?;
    let tools = Tools::find().map_err(ToolError::Failed)?;

    // 1. Dependencies.
    let env = Env::new(&handle.home, &skill);
    let mut notes = Vec::new();
    match env.sync(&tools, &skill_dir, ctx).await {
        Ok(Some(note)) => notes.push(note),
        Ok(None) => {}
        Err(e) => return Ok(ToolOutput::error(format!("Installing the script's Python packages failed: {e}"))),
    }

    // 2. Data.
    let work = tempfile::Builder::new().prefix("finx-script-").tempdir()?;
    let work_dir = std::fs::canonicalize(work.path())?;
    handle.data.export(&args.doc_id, &work_dir).map_err(|e| ToolError::Failed(format!("preparing the volume: {e}")))?;
    let shape = npy_shape(&work_dir.join("volume.npy")).map_err(|e| ToolError::Failed(format!("volume.npy: {e}")))?;
    std::fs::create_dir_all(work_dir.join("out"))?;
    let script_path = match script_file {
        Some(file) => file,
        None => {
            let file = work_dir.join("script.py");
            std::fs::write(&file, &code)?;
            file
        }
    };
    let arg_json = args.args.as_ref().map(Value::to_string).unwrap_or_default();

    // 3. Run.
    let timeout = Duration::from_secs(args.timeout_s.unwrap_or(600).clamp(1, 1800));
    let outcome = env.run(&tools, &work_dir, &script_path, &arg_json, timeout, ctx).await?;

    // 4. Read back, check, archive, apply.
    let archive = archive_dir(&handle.home, &args.doc_id)?;
    let run_no: u32 = archive.file_name().and_then(|n| n.to_str()).and_then(|n| n.parse().ok()).unwrap_or(0);
    std::fs::write(archive.join("script.py"), &code)?;
    std::fs::write(archive.join("args.json"), if arg_json.is_empty() { "{}".into() } else { arg_json.clone() })?;
    std::fs::write(archive.join("stdout.txt"), &outcome.stdout)?;
    std::fs::write(archive.join("stderr.txt"), &outcome.stderr)?;
    let out_dir = work_dir.join("out");
    let raw = std::fs::read_to_string(out_dir.join("submit.jsonl")).unwrap_or_default();
    let (accepted, refused) = if outcome.ok() { check_submissions(&raw, shape, &out_dir, &archive, run_no) } else { (Vec::new(), Vec::new()) };
    if !raw.is_empty() {
        std::fs::write(archive.join("submit.jsonl"), &raw)?;
    }
    let summary = if accepted.is_empty() {
        None
    } else {
        Some(handle.data.apply(&args.doc_id, accepted.clone()).await)
    };

    let mut text = notes.join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    text.push_str(&format!("Run {run_no} ({}).\n", if cfg!(target_os = "macos") { "isolated: no network, writes only its work folder" } else { "not isolated on this system" }));
    match &outcome.end {
        End::Exited(0) => {}
        End::Exited(code) => text.push_str(&format!("The script failed (exit {code}). End of its error output:\n{}\n", tail(&outcome.stderr, STDERR_TAIL))),
        End::TimedOut => text.push_str(&format!("The script ran past {}s and was stopped.\n", timeout.as_secs())),
        End::Cancelled => return Err(ToolError::Cancelled),
    }
    if !outcome.stdout.is_empty() {
        text.push_str(&format!("stdout:\n{}\n", head(&outcome.stdout, STDOUT_HEAD)));
    }
    let counts = count(&accepted);
    if !accepted.is_empty() {
        text.push_str(&format!("Accepted: {counts}.\n"));
    }
    if !refused.is_empty() {
        text.push_str(&format!("Refused {} line(s) of out/submit.jsonl:\n{}\n", refused.len(), refused.iter().take(20).cloned().collect::<Vec<_>>().join("\n")));
    }
    let mut is_error = !outcome.ok();
    match summary {
        Some(Ok(s)) if !s.text.is_empty() => text.push_str(&format!("{}\n", s.text)),
        Some(Err(e)) => {
            is_error = true;
            text.push_str(&format!("Applying to the document failed: {e}\n"));
        }
        _ => {}
    }
    let details = json!({
        "run": run_no, "archive": archive, "exit": outcome.end.code(), "accepted": counts,
        "refused": refused, "isolated": cfg!(target_os = "macos"),
    });
    if let Ok(bytes) = serde_json::to_vec_pretty(&json!({ "purpose": args.purpose, "skill_script": args.skill_script, "details": details, "text": text })) {
        let _ = std::fs::write(archive.join("result.json"), bytes);
    }
    let out = ToolOutput::text(text.trim_end()).with_details(details);
    Ok(if is_error { ToolOutput { is_error: true, ..out } } else { out })
}

fn find_skill(handle: &ScriptHandle, skill: &str) -> Option<PathBuf> {
    handle.skill_roots.iter().map(|r| r.join(skill)).find(|d| d.join("pyproject.toml").is_file())
}

fn archive_dir(home: &FinxHome, doc_id: &str) -> std::io::Result<PathBuf> {
    let base = home.root().join("docs").join(doc_id).join("scripts");
    std::fs::create_dir_all(&base)?;
    let mut n = std::fs::read_dir(&base)?
        .filter_map(|e| e.ok()?.file_name().to_str()?.parse::<u32>().ok())
        .max()
        .unwrap_or(0);
    loop {
        n += 1;
        let dir = base.join(n.to_string());
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
}

fn count(subs: &[Submission]) -> String {
    let n = |f: fn(&Submission) -> bool| subs.iter().filter(|s| f(s)).count();
    format!(
        "{} candidate(s), {} marker(s), {} structure(s), {} finding(s)",
        n(|s| matches!(s, Submission::Candidate(_))),
        n(|s| matches!(s, Submission::Marker(_))),
        n(|s| matches!(s, Submission::Structure(_))),
        n(|s| matches!(s, Submission::Finding(_)))
    )
}

fn head(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.trim_end().to_owned();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… ({} more bytes; the whole output is in the run's stdout.txt)", &s[..end], s.len() - end)
}

fn tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.trim_end().to_owned();
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", s[start..].trim_end())
}

// ---------------------------------------------------------------------------------------------
// Checking submissions.

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawMarker {
    center_voxel: [i64; 3],
    label: String,
    #[serde(default = "ai")]
    source: ScriptSource,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawStructure {
    id: String,
    name: String,
    color: String,
    mask: String,
    #[serde(default)]
    opacity: Option<f64>,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    expect_ml: Option<[f64; 2]>,
    #[serde(default)]
    notes: Vec<String>,
    #[serde(default)]
    unreliable: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawProfile {
    #[serde(default)]
    orientation: Option<String>,
    #[serde(default)]
    unit: Option<String>,
    #[serde(default)]
    windows: Vec<(String, f64, f64)>,
    #[serde(default)]
    disclaimer: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFinding {
    name: String,
    summary: String,
    #[serde(default = "ai")]
    source: ScriptSource,
    #[serde(default)]
    center_voxel: Option<[i64; 3]>,
    #[serde(default)]
    radius_mm: Option<f64>,
    #[serde(default)]
    measures: Map<String, Value>,
    #[serde(default)]
    evidence: Vec<String>,
    #[serde(default)]
    report_item: Option<String>,
}

fn ai() -> ScriptSource {
    ScriptSource::Ai
}

/// Checks every line of `submit.jsonl`: accepted submissions, and one message per refused line.
/// Structure masks are copied into `archive/masks/`.
pub(crate) fn check_submissions(raw: &str, shape: [u64; 3], out_dir: &Path, archive: &Path, run: u32) -> (Vec<Submission>, Vec<String>) {
    let mut ok = Vec::new();
    let mut refused = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for (n, line) in raw.lines().enumerate().filter(|(_, l)| !l.trim().is_empty()) {
        let n = n + 1;
        if ok.len() + refused.len() >= MAX_LINES {
            refused.push(format!("line {n}: more than {MAX_LINES} lines; the rest were not read"));
            break;
        }
        match check_line(line, shape, out_dir, archive, run, &mut ids) {
            Ok(sub) => ok.push(sub),
            Err(e) => refused.push(format!("line {n}: {e}")),
        }
    }
    (ok, refused)
}

fn check_line(line: &str, shape: [u64; 3], out_dir: &Path, archive: &Path, run: u32, ids: &mut std::collections::HashSet<String>) -> Result<Submission, String> {
    let value: Value = serde_json::from_str(line).map_err(|e| format!("not JSON: {e}"))?;
    let Value::Object(mut obj) = value else { return Err("not a JSON object".into()) };
    let kind = match obj.remove("type") {
        Some(Value::String(s)) => s,
        _ => return Err("missing \"type\" (candidate, marker, structure, finding or profile)".into()),
    };
    let de = |obj: Map<String, Value>| Value::Object(obj);
    match kind.as_str() {
        "candidate" => {
            let voxel = obj.remove("center_voxel").ok_or("candidate: missing center_voxel")?;
            let voxel: [i64; 3] = serde_json::from_value(voxel).map_err(|e| format!("candidate.center_voxel: {e}"))?;
            let num = |obj: &mut Map<String, Value>, k: &str| -> Result<Option<f64>, String> {
                match obj.remove(k) {
                    None | Some(Value::Null) => Ok(None),
                    Some(v) => v.as_f64().filter(|x| x.is_finite()).map(Some).ok_or(format!("candidate.{k}: not a finite number")),
                }
            };
            let text = |obj: &mut Map<String, Value>, k: &str| -> Result<Option<String>, String> {
                match obj.remove(k) {
                    None | Some(Value::Null) => Ok(None),
                    Some(Value::String(s)) => short(&s, k).map(|_| Some(s)),
                    Some(_) => Err(format!("candidate.{k}: not a string")),
                }
            };
            let diameter_mm = num(&mut obj, "diameter_mm")?;
            if diameter_mm.is_some_and(|d| d < 0.0) {
                return Err("candidate.diameter_mm: negative".into());
            }
            let score = num(&mut obj, "score")?;
            let rank = num(&mut obj, "rank")?.map(|r| r as u32);
            let c = Candidate {
                center_voxel: voxel_in(voxel, shape)?,
                diameter_mm,
                kind: text(&mut obj, "kind")?,
                score,
                rank,
                note: text(&mut obj, "note")?,
                source_script: text(&mut obj, "source_script")?,
                reference_label: text(&mut obj, "reference_label")?,
                details: obj,
                run,
            };
            if serde_json::to_string(&c.details).map(|s| s.len()).unwrap_or(usize::MAX) > 16_000 {
                return Err("candidate: extra fields too large".into());
            }
            Ok(Submission::Candidate(c))
        }
        "marker" => {
            let m: RawMarker = serde_json::from_value(de(obj)).map_err(|e| format!("marker: {e}"))?;
            short(&m.label, "label")?;
            if let Some(note) = &m.note {
                short(note, "note")?;
            }
            Ok(Submission::Marker(Marker { center_voxel: voxel_in(m.center_voxel, shape)?, label: m.label, source: m.source, note: m.note, run }))
        }
        "structure" => {
            let s: RawStructure = serde_json::from_value(de(obj)).map_err(|e| format!("structure: {e}"))?;
            if s.id.is_empty() || s.id.len() > 64 || !s.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
                return Err(format!("structure.id `{}`: 1-64 of a-z 0-9 _ -", s.id));
            }
            if !ids.insert(s.id.clone()) {
                return Err(format!("structure.id `{}` submitted twice", s.id));
            }
            short(&s.name, "name")?;
            let hex = s.color.strip_prefix('#').filter(|h| h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()));
            if hex.is_none() {
                return Err(format!("structure.color `{}`: want #rrggbb", s.color));
            }
            let expected = format!("masks/{}.npy", s.id);
            if s.mask != expected {
                return Err(format!("structure.mask: want `{expected}` (use submit.structure)"));
            }
            let src = out_dir.join(&expected);
            let meta = std::fs::symlink_metadata(&src).map_err(|e| format!("structure.mask: {e}"))?;
            if !meta.is_file() {
                return Err("structure.mask: not a regular file".into());
            }
            let (descr, mshape) = npy_header(&src).map_err(|e| format!("structure.mask: {e}"))?;
            if descr != "|b1" {
                return Err(format!("structure.mask: dtype {descr}, want bool"));
            }
            if mshape != shape {
                return Err(format!("structure.mask: shape {mshape:?}, the volume is {shape:?}"));
            }
            let dest = archive.join(&expected);
            std::fs::create_dir_all(archive.join("masks")).map_err(|e| e.to_string())?;
            std::fs::copy(&src, &dest).map_err(|e| format!("structure.mask: {e}"))?;
            if s.opacity.is_some_and(|o| !(0.0..=1.0).contains(&o)) {
                return Err("structure.opacity: want 0 to 1".into());
            }
            if s.expect_ml.is_some_and(|[lo, hi]| !(lo.is_finite() && hi.is_finite() && 0.0 <= lo && lo <= hi)) {
                return Err("structure.expect_ml: want [least, most] in mL".into());
            }
            if s.notes.len() > 20 {
                return Err("structure.notes: more than 20".into());
            }
            for n in s.notes.iter().chain(&s.unreliable) {
                short(n, "notes")?;
            }
            Ok(Submission::Structure(Structure {
                id: s.id,
                name: s.name,
                color: s.color.to_ascii_lowercase(),
                opacity: s.opacity,
                hidden: s.hidden,
                expect_ml: s.expect_ml,
                notes: s.notes,
                unreliable: s.unreliable.filter(|r| !r.trim().is_empty()),
                mask: dest,
                run,
            }))
        }
        "finding" => {
            let f: RawFinding = serde_json::from_value(de(obj)).map_err(|e| format!("finding: {e}"))?;
            short(&f.name, "name")?;
            short(&f.summary, "summary")?;
            if f.name.trim().is_empty() || f.summary.trim().is_empty() {
                return Err("finding: name and summary must not be empty".into());
            }
            if f.radius_mm.is_some_and(|r| !r.is_finite() || r < 0.0) {
                return Err("finding.radius_mm: not a non-negative number".into());
            }
            if f.evidence.len() > 50 || f.evidence.iter().any(|e| e.chars().count() > MAX_TEXT) {
                return Err("finding.evidence: too long".into());
            }
            let center_voxel = f.center_voxel.map(|v| voxel_in(v, shape)).transpose()?;
            Ok(Submission::Finding(Finding {
                name: f.name,
                summary: f.summary,
                source: f.source,
                center_voxel,
                radius_mm: f.radius_mm,
                measures: f.measures,
                evidence: f.evidence,
                report_item: f.report_item,
                run,
            }))
        }
        "profile" => {
            let p: RawProfile = serde_json::from_value(de(obj)).map_err(|e| format!("profile: {e}"))?;
            if p.orientation.as_deref().is_some_and(|o| o != "patient" && o != "none") {
                return Err("profile.orientation: want \"patient\" or \"none\"".into());
            }
            if p.windows.len() > 20 {
                return Err("profile.windows: more than 20".into());
            }
            for (name, width, level) in &p.windows {
                short(name, "windows")?;
                if !(width.is_finite() && level.is_finite() && *width > 0.0) {
                    return Err(format!("profile.windows `{name}`: want [name, width > 0, level]"));
                }
            }
            for t in [&p.unit, &p.disclaimer].into_iter().flatten() {
                short(t, "profile")?;
            }
            Ok(Submission::Profile(Profile { orientation: p.orientation, unit: p.unit, windows: p.windows, disclaimer: p.disclaimer }))
        }
        other => Err(format!("unknown type `{other}` (candidate, marker, structure, finding or profile)")),
    }
}

fn short(s: &str, what: &str) -> Result<(), String> {
    if s.chars().count() > MAX_TEXT {
        return Err(format!("{what}: longer than {MAX_TEXT} characters"));
    }
    Ok(())
}

fn voxel_in(v: [i64; 3], shape: [u64; 3]) -> Result<[u32; 3], String> {
    for a in 0..3 {
        if v[a] < 0 || v[a] as u64 >= shape[a] {
            return Err(format!("center_voxel {v:?} is outside the volume {shape:?}"));
        }
    }
    Ok([v[0] as u32, v[1] as u32, v[2] as u32])
}

// ---------------------------------------------------------------------------------------------
// .npy files (format 1.0, C order).

fn npy_header_bytes(descr: &str, shape: [u64; 3]) -> Vec<u8> {
    let dict = format!("{{'descr': '{descr}', 'fortran_order': False, 'shape': ({}, {}, {}), }}", shape[0], shape[1], shape[2]);
    let unpadded = 10 + dict.len() + 1;
    let pad = (64 - unpadded % 64) % 64;
    let mut out = b"\x93NUMPY\x01\x00".to_vec();
    out.extend_from_slice(&((dict.len() + pad + 1) as u16).to_le_bytes());
    out.extend_from_slice(dict.as_bytes());
    out.extend(std::iter::repeat_n(b' ', pad));
    out.push(b'\n');
    out
}

/// Writes int16 values in k,j,i order.
pub(crate) fn write_npy_i16(path: &Path, shape: [u64; 3], data: &[i16]) -> std::io::Result<()> {
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    f.write_all(&npy_header_bytes("<i2", shape))?;
    for v in data {
        f.write_all(&v.to_le_bytes())?;
    }
    f.flush()
}

pub(crate) fn write_npy_bool(path: &Path, shape: [u64; 3], data: &[bool]) -> std::io::Result<()> {
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    f.write_all(&npy_header_bytes("|b1", shape))?;
    let bytes: Vec<u8> = data.iter().map(|&b| b as u8).collect();
    f.write_all(&bytes)?;
    f.flush()
}

fn npy_shape(path: &Path) -> Result<[u64; 3], String> {
    npy_header(path).map(|(_, s)| s)
}

/// `descr` and the 3-D shape of a C-order .npy; the file's size must match.
fn npy_header(path: &Path) -> Result<(String, [u64; 3]), String> {
    use std::io::Read as _;
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut pre = [0u8; 10];
    f.read_exact(&mut pre).map_err(|_| "too short".to_string())?;
    if &pre[..6] != b"\x93NUMPY" || pre[6] != 1 {
        return Err("not a version 1 .npy".into());
    }
    let len = u16::from_le_bytes([pre[8], pre[9]]) as usize;
    let mut dict = vec![0u8; len];
    f.read_exact(&mut dict).map_err(|_| "truncated header".to_string())?;
    let dict = String::from_utf8(dict).map_err(|_| "header not text".to_string())?;
    let field = |key: &str| -> Option<String> {
        let at = dict.find(&format!("'{key}':"))? + key.len() + 3;
        Some(dict[at..].trim_start().to_owned())
    };
    let descr = field("descr").and_then(|s| s.strip_prefix('\'').and_then(|s| s.split('\'').next()).map(str::to_owned)).ok_or("no descr")?;
    if !field("fortran_order").is_some_and(|s| s.starts_with("False")) {
        return Err("Fortran order".into());
    }
    let shape_text = field("shape").and_then(|s| s.strip_prefix('(').and_then(|s| s.split(')').next()).map(str::to_owned)).ok_or("no shape")?;
    let dims: Vec<u64> = shape_text.split(',').map(str::trim).filter(|s| !s.is_empty()).map(|s| s.parse().map_err(|_| "bad shape")).collect::<Result<_, _>>()?;
    let [a, b, c] = dims[..] else { return Err(format!("shape {dims:?}, want 3 axes")) };
    let item = match descr.as_str() {
        "|b1" | "|u1" | "|i1" => 1,
        "<i2" | "<u2" => 2,
        "<f4" | "<i4" => 4,
        _ => return Err(format!("dtype {descr}")),
    };
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    if size != 10 + len as u64 + a * b * c * item {
        return Err("size does not match the shape".into());
    }
    Ok((descr, [a, b, c]))
}

// ---------------------------------------------------------------------------------------------
// uv.

struct Tools {
    uv: PathBuf,
    /// Folder holding the `finx_spatial` package, put on PYTHONPATH.
    python_path: PathBuf,
}

impl Tools {
    /// `FINX_UV`, then `uv` beside this program (the app bundle), then `uv` on PATH.
    fn find() -> Result<Self, String> {
        let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf));
        let uv = std::env::var_os("FINX_UV")
            .map(PathBuf::from)
            .or_else(|| exe_dir.as_ref().map(|d| d.join("uv")).filter(|p| p.is_file()))
            .or_else(|| std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join("uv")).find(|p| p.is_file()))
            .ok_or("uv is not installed: the app carries it; in development put uv on PATH or set FINX_UV")?;
        let python_path = std::env::var_os("FINX_SPATIAL_PYTHON")
            .map(PathBuf::from)
            .or_else(|| exe_dir.as_ref().map(|d| d.join("../Resources/python")).filter(|p| p.join("finx_spatial").is_dir()))
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../finx-spatial/python"));
        if !python_path.join("finx_spatial/__init__.py").is_file() {
            return Err(format!("the finx_spatial module is missing from {}", python_path.display()));
        }
        Ok(Self { uv, python_path })
    }
}

struct Env {
    cache: PathBuf,
    python_dir: PathBuf,
    venv: PathBuf,
    /// Copies of the skill's pyproject.toml and uv.lock (one per index), synced from here.
    stage: PathBuf,
}

enum End {
    Exited(i32),
    TimedOut,
    Cancelled,
}

impl End {
    fn code(&self) -> Option<i32> {
        match self {
            End::Exited(c) => Some(*c),
            _ => None,
        }
    }
}

struct Outcome {
    stdout: String,
    stderr: String,
    end: End,
}

impl Outcome {
    fn ok(&self) -> bool {
        matches!(self.end, End::Exited(0))
    }
}

impl Env {
    fn new(home: &FinxHome, skill: &str) -> Self {
        let uv = home.root().join("cache").join("uv");
        Self {
            python_dir: uv.join("python"),
            venv: uv.join("envs").join(skill),
            stage: uv.join("projects").join(skill),
            cache: uv.join("cache"),
        }
    }

    fn base_command(&self, tools: &Tools) -> Command {
        let mut c = Command::new(&tools.uv);
        c.env("UV_CACHE_DIR", &self.cache)
            .env("UV_PYTHON_INSTALL_DIR", &self.python_dir)
            .env("UV_PROJECT_ENVIRONMENT", &self.venv)
            .env("UV_NO_PROGRESS", "1")
            .env_remove("UV_INDEX_URL")
            .env_remove("UV_DEFAULT_INDEX")
            .env_remove("UV_EXTRA_INDEX_URL")
            .env_remove("VIRTUAL_ENV")
            .stdin(Stdio::null())
            .kill_on_drop(true);
        c
    }

    /// Installs the locked packages unless this lock is already installed. `Some(note)` when
    /// something was downloaded.
    async fn sync(&self, tools: &Tools, skill_dir: &Path, ctx: &ToolCtx) -> Result<Option<String>, String> {
        let lock = std::fs::read_to_string(skill_dir.join("uv.lock")).map_err(|e| format!("the skill has no uv.lock: {e}"))?;
        let pyproject = std::fs::read_to_string(skill_dir.join("pyproject.toml")).map_err(|e| e.to_string())?;
        let stamp_text = format!("{}\n{}", digest(&lock), digest(&pyproject));
        let stamp = self.venv.join(".finx-synced");
        if std::fs::read_to_string(&stamp).ok().as_deref() == Some(stamp_text.as_str()) {
            return Ok(None);
        }
        let first = !self.venv.exists();
        if first {
            ctx.progress.emit(&format!("First use: downloading Python and the skill's packages, {FIRST_DOWNLOAD}.\n"));
        }
        let started = std::time::Instant::now();
        let mut errors = Vec::new();
        for official in [false, true] {
            let (lock_text, index) = if official {
                (lock.replace(MIRROR_INDEX, OFFICIAL_INDEX).replace(MIRROR_FILES, OFFICIAL_FILES), OFFICIAL_INDEX)
            } else {
                (lock.replace(OFFICIAL_INDEX, MIRROR_INDEX).replace(OFFICIAL_FILES, MIRROR_FILES), MIRROR_INDEX)
            };
            let dir = self.stage.join(if official { "official" } else { "mirror" });
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(dir.join("pyproject.toml"), &pyproject).map_err(|e| e.to_string())?;
            std::fs::write(dir.join("uv.lock"), &lock_text).map_err(|e| e.to_string())?;
            let mut c = self.base_command(tools);
            c.arg("sync").arg("--locked").arg("--no-install-project").arg("--project").arg(&dir).env("UV_INDEX_URL", index);
            if !official {
                c.env("UV_PYTHON_INSTALL_MIRROR", MIRROR_PYTHON);
            }
            match watch_sync(c, ctx).await {
                Ok(()) => {
                    std::fs::write(&stamp, &stamp_text).map_err(|e| e.to_string())?;
                    let source = if official { "the official index (the mirror failed)" } else { "the mirror" };
                    let what = if first { format!("Downloaded Python and the packages ({FIRST_DOWNLOAD})") } else { "Updated the packages".into() };
                    return Ok(Some(format!("{what} from {source} in {}s.", started.elapsed().as_secs())));
                }
                Err(SyncError::Cancelled) => return Err("cancelled".into()),
                Err(SyncError::Failed(e)) => {
                    ctx.progress.emit(&format!("{}: {e}\n", if official { "official index" } else { "mirror" }));
                    errors.push(e);
                }
            }
        }
        Err(errors.join("; then from the official index: "))
    }

    async fn run(&self, tools: &Tools, work: &Path, script: &Path, arg: &str, timeout: Duration, ctx: &ToolCtx) -> Result<Outcome, ToolError> {
        let project = self.stage.join("mirror");
        let mut uv_args: Vec<std::ffi::OsString> = vec![
            tools.uv.clone().into(),
            "run".into(),
            "--offline".into(),
            "--frozen".into(),
            "--no-sync".into(),
            "--no-cache".into(),
            "--project".into(),
            project.into(),
            "python".into(),
            script.into(),
        ];
        if !arg.is_empty() {
            uv_args.push(arg.into());
        }
        let mut c = if cfg!(target_os = "macos") {
            let profile = work.join(".sandbox.sb");
            std::fs::write(&profile, sandbox_profile(work))?;
            let mut c = Command::new("/usr/bin/sandbox-exec");
            c.arg("-f").arg(&profile).args(&uv_args);
            c
        } else {
            let mut c = Command::new(&uv_args[0]);
            c.args(&uv_args[1..]);
            c
        };
        c.current_dir(work)
            .env("UV_CACHE_DIR", &self.cache)
            .env("UV_PYTHON_INSTALL_DIR", &self.python_dir)
            .env("UV_PROJECT_ENVIRONMENT", &self.venv)
            .env("UV_OFFLINE", "1")
            .env("UV_NO_PROGRESS", "1")
            .env_remove("VIRTUAL_ENV")
            .env("FINX_SPATIAL_DIR", work)
            .env("PYTHONPATH", &tools.python_path)
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("MPLCONFIGDIR", work)
            .env("TMPDIR", work)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = c.spawn()?;
        let mut so = child.stdout.take().expect("piped");
        let mut se = child.stderr.take().expect("piped");
        let read_out = async {
            let mut b = Vec::new();
            let _ = so.read_to_end(&mut b).await;
            b
        };
        let read_err = async {
            let mut b = Vec::new();
            let _ = se.read_to_end(&mut b).await;
            b
        };
        let wait = async {
            let (o, e, status) = tokio::join!(read_out, read_err, child.wait());
            (o, e, status)
        };
        let (stdout, stderr, end) = tokio::select! {
            (o, e, status) = wait => {
                let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);
                (o, e, End::Exited(code))
            }
            _ = tokio::time::sleep(timeout) => (Vec::new(), Vec::new(), End::TimedOut),
            _ = ctx.cancel.cancelled() => (Vec::new(), Vec::new(), End::Cancelled),
        };
        Ok(Outcome { stdout: String::from_utf8_lossy(&stdout).into_owned(), stderr: String::from_utf8_lossy(&stderr).into_owned(), end })
    }
}

/// No network; writes only to `work` and the standard streams.
fn sandbox_profile(work: &Path) -> String {
    let w = work.display().to_string().replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        "(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)\n(allow file-write* (subpath \"{w}\") (literal \"/dev/null\") (literal \"/dev/stdout\") (literal \"/dev/stderr\") (literal \"/dev/tty\") (regex #\"^/dev/fd/\"))\n"
    )
}

enum SyncError {
    Failed(String),
    Cancelled,
}

/// Runs `uv sync`, forwarding its lines as progress; stops it after [`STALL`] without output.
async fn watch_sync(mut c: Command, ctx: &ToolCtx) -> Result<(), SyncError> {
    c.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| SyncError::Failed(e.to_string()))?;
    let out = child.stdout.take().expect("piped");
    let err = child.stderr.take().expect("piped");
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    for reader in [Box::new(out) as Box<dyn tokio::io::AsyncRead + Unpin + Send>, Box::new(err)] {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx.send(line);
            }
        });
    }
    drop(tx);
    let deadline = tokio::time::Instant::now() + SYNC_LIMIT;
    let mut last = String::new();
    loop {
        tokio::select! {
            line = rx.recv() => match line {
                Some(line) => {
                    ctx.progress.emit(&format!("{line}\n"));
                    if !line.trim().is_empty() { last = line; }
                }
                None => break,
            },
            _ = tokio::time::sleep(STALL) => {
                let _ = child.kill().await;
                return Err(SyncError::Failed(format!("no progress for {}s", STALL.as_secs())));
            }
            _ = tokio::time::sleep_until(deadline) => {
                let _ = child.kill().await;
                return Err(SyncError::Failed("took too long".into()));
            }
            _ = ctx.cancel.cancelled() => {
                let _ = child.kill().await;
                return Err(SyncError::Cancelled);
            }
        }
    }
    let status = child.wait().await.map_err(|e| SyncError::Failed(e.to_string()))?;
    if status.success() { Ok(()) } else { Err(SyncError::Failed(format!("uv sync failed: {last}"))) }
}

fn digest(s: &str) -> String {
    let d = ring::digest::digest(&ring::digest::SHA256, s.as_bytes());
    d.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests;
