use super::*;

/// The skill whose environment the tests run in.
/// A skill holding only what `finx_spatial` needs; the kernel's tests name no real skill.
const PROBE_SKILL: &str = "spatial-probe";
use finx_tools::{FileTracker, LocalEnvironment, OutputLimits, PathLocks, ProgressSink, SessionState};
use std::sync::{Mutex, OnceLock};
use tokio_util::sync::CancellationToken;

struct MemoryData {
    dims: [u64; 3],
    spacing: [f64; 3],
    hu: Vec<i16>,
    lungs: Vec<bool>,
    applied: Mutex<Vec<(String, Vec<Submission>)>>,
}

impl MemoryData {
    fn tiny() -> Self {
        let dims = [4, 4, 4];
        let n = (dims[0] * dims[1] * dims[2]) as usize;
        Self {
            dims,
            spacing: [1.0, 1.0, 1.0],
            hu: vec![-850; n],
            lungs: vec![true; n],
            applied: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait::async_trait]
impl ScriptData for MemoryData {
    fn export(&self, _doc_id: &str, dir: &Path) -> Result<(), String> {
        write_npy_i16(&dir.join("volume.npy"), self.dims, &self.hu).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(dir.join("masks")).map_err(|e| e.to_string())?;
        write_npy_bool(&dir.join("masks/lungs.npy"), self.dims, &self.lungs).map_err(|e| e.to_string())?;
        let image_numbers: Vec<u32> = (1..=self.dims[0] as u32).collect();
        let meta = json!({
            "spacing": self.spacing,
            "origin": [0.0, 0.0, 0.0],
            "direction": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            "unit": "HU",
            "image_numbers": image_numbers,
            "k_towards_head": true,
            "masks": { "lungs": "masks/lungs.npy" }
        });
        std::fs::write(dir.join("meta.json"), serde_json::to_vec(&meta).unwrap()).map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn apply(&self, doc_id: &str, submissions: Vec<Submission>) -> Result<Summary, String> {
        let text = format!("applied {} item(s)", submissions.len());
        self.applied.lock().unwrap().push((doc_id.to_owned(), submissions));
        Ok(Summary { text })
    }
}

fn tool_ctx(work_root: &Path, state: Arc<SessionState>) -> ToolCtx {
    ToolCtx {
        call_id: "call_test".into(),
        env: Arc::new(LocalEnvironment::new(work_root.to_path_buf())),
        files: Arc::new(FileTracker::new()),
        locks: Arc::new(PathLocks::new()),
        limits: OutputLimits::default(),
        progress: ProgressSink::noop(),
        cancel: CancellationToken::new(),
        model_accepts_images: false,
        output_dir: work_root.join("tool-out"),
        session_state: state,
        authorities: Arc::from([]),
    }
}

fn shared_e2e_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn shared_finx_home() -> &'static tempfile::TempDir {
    static HOME: OnceLock<tempfile::TempDir> = OnceLock::new();
    HOME.get_or_init(|| tempfile::Builder::new().prefix("finx-spatial-e2e-").tempdir().unwrap())
}

fn find_or_skip_uv() -> Option<PathBuf> {
    if std::env::var_os("FINX_UV").is_some() {
        return std::env::var_os("FINX_UV").map(PathBuf::from);
    }
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_env) {
            let p = dir.join("uv");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    let cached = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/desktop/node_modules/.cache/uv/0.13.8")
        .join(arch)
        .join("uv");
    cached.is_file().then_some(cached)
}

#[test]
fn approval_and_trust() {
    let skill_call = json!({
        "doc_id": "doc1",
        "purpose": "Find lung nodules",
        "skill_script": "some-skill/scripts/measure.py"
    });
    assert!(runs_unasked(&skill_call));

    let custom_call = json!({
        "doc_id": "doc1",
        "purpose": "Measure mean HU in box",
        "script": "import finx_spatial\nprint(1)"
    });
    assert!(!runs_unasked(&custom_call));
    let summary = approval_summary(&custom_call);
    assert!(summary.starts_with("Measure mean HU in box\n"));
    assert!(summary.contains("import finx_spatial"));
}

#[test]
fn check_submissions_rejects_bad_lines() {
    let tmp = tempfile::tempdir().unwrap();
    let out_dir = tmp.path().join("out");
    let archive = tmp.path().join("archive");
    std::fs::create_dir_all(out_dir.join("masks")).unwrap();
    std::fs::create_dir_all(&archive).unwrap();

    let shape = [4, 4, 4];
    let n = 64;
    write_npy_bool(&out_dir.join("masks/good_mask.npy"), shape, &vec![true; n]).unwrap();
    write_npy_i16(&out_dir.join("masks/wrong_dtype.npy"), shape, &vec![1i16; n]).unwrap();
    write_npy_bool(&out_dir.join("masks/wrong_shape.npy"), [2, 2, 2], &[true; 8]).unwrap();

    let lines = [
        // 1. invalid JSON
        "{not json",
        // 2. missing type
        r#"{"center_voxel":[1,1,1]}"#,
        // 3. unknown type
        r#"{"type":"bogus"}"#,
        // 4. candidate out of bounds
        r#"{"type":"candidate","center_voxel":[-1,1,1]}"#,
        r#"{"type":"candidate","center_voxel":[4,1,1]}"#,
        // 5. candidate negative diameter
        r#"{"type":"candidate","center_voxel":[1,1,1],"diameter_mm":-2.0}"#,
        // 6. marker unknown field
        r#"{"type":"marker","center_voxel":[1,1,1],"label":"x","extra":1}"#,
        // 7. structure bad id
        r##"{"type":"structure","id":"BadId!","name":"bad","color":"#112233","mask":"masks/BadId!.npy"}"##,
        // 8. structure bad color
        r#"{"type":"structure","id":"bad_color","name":"bad","color":"red","mask":"masks/bad_color.npy"}"#,
        // 9. structure wrong dtype
        r##"{"type":"structure","id":"wrong_dtype","name":"bad","color":"#112233","mask":"masks/wrong_dtype.npy"}"##,
        // 10. structure wrong shape
        r##"{"type":"structure","id":"wrong_shape","name":"bad","color":"#112233","mask":"masks/wrong_shape.npy"}"##,
        // 11. finding empty summary
        r#"{"type":"finding","name":"nodule","summary":"   "}"#,
        // 12. valid candidate
        r#"{"type":"candidate","center_voxel":[1,2,3],"diameter_mm":5.2,"score":0.9}"#,
        // 13. valid marker
        r#"{"type":"marker","center_voxel":[0,0,0],"label":"apex","source":"reference"}"#,
        // 14. valid structure
        r##"{"type":"structure","id":"good_mask","name":"Good","color":"#AABBCC","mask":"masks/good_mask.npy","opacity":0.35,"hidden":true,"expect_ml":[1,5],"notes":["how it was built"]}"##,
        // 15. valid finding
        r#"{"type":"finding","name":"Nodule","summary":"6mm GGO in RUL","center_voxel":[2,2,2],"radius_mm":3.0}"#,
        // 16. structure whose expected volume is not a range
        r##"{"type":"structure","id":"good_mask","name":"x","color":"#112233","mask":"masks/good_mask.npy","expect_ml":[9,3]}"##,
        // 17. structure opacity out of range
        r##"{"type":"structure","id":"good_mask","name":"x","color":"#112233","mask":"masks/good_mask.npy","opacity":1.5}"##,
        // 18. profile with a window of no width, and one with an unknown orientation
        r#"{"type":"profile","windows":[["lung",0,-600]]}"#,
        r#"{"type":"profile","orientation":"upside-down"}"#,
        // 19. valid profile
        r#"{"type":"profile","orientation":"patient","unit":"HU","windows":[["lung",1500,-600]],"disclaimer":"not a diagnosis"}"#,
    ]
    .join("\n");

    let (accepted, refused) = check_submissions(&lines, shape, &out_dir, &archive, 1);
    assert_eq!(refused.len(), 16, "refused: {refused:?}");
    assert_eq!(accepted.len(), 5, "accepted: {accepted:?}");
    assert!(matches!(accepted.last(), Some(Submission::Profile(p)) if p.windows == [("lung".to_string(), 1500.0, -600.0)]));
    assert!(archive.join("masks/good_mask.npy").is_file());
    let good = accepted.iter().find_map(|s| match s {
        Submission::Structure(s) => Some(s),
        _ => None,
    });
    assert!(matches!(good, Some(s) if s.hidden && s.opacity == Some(0.35) && s.expect_ml == Some([1.0, 5.0]) && s.notes == ["how it was built"]));
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn sandbox_blocks_network_and_home_writes_allows_workdir() {
    let Some(uv) = find_or_skip_uv() else {
        panic!("uv not found on PATH or in apps/desktop/node_modules/.cache/uv");
    };
    let _guard = shared_e2e_lock().lock().await;
    let home = FinxHome::new(shared_finx_home().path().to_path_buf());
    let data = Arc::new(MemoryData::tiny());
    let skill_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/spatial_script/testdata");
    let handle = Arc::new(ScriptHandle {
        data: data.clone(),
        home,
        skill_roots: vec![skill_root],
    });
    let state = Arc::new(SessionState::default());
    state.insert(handle.clone());

    let tools = Tools {
        uv,
        python_path: Path::new(env!("CARGO_MANIFEST_DIR")).join("../finx-spatial/python"),
    };
    let env = Env::new(&handle.home, PROBE_SKILL);
    let ctx = tool_ctx(shared_finx_home().path(), state.clone());
    env.sync(&tools, &handle.skill_roots[0].join(PROBE_SKILL), &ctx).await.expect("uv sync");

    let script = r#"
import json, os, urllib.request
from finx_spatial import load, submit

vol = load()
res = {"net_blocked": False, "home_write_blocked": False, "workdir_write_ok": False}

try:
    urllib.request.urlopen("https://example.com", timeout=3)
except Exception as e:
    res["net_blocked"] = True
    res["net_err"] = type(e).__name__

try:
    with open(os.path.expanduser("~/finx_sandbox_should_fail.txt"), "w") as f:
        f.write("bad")
except Exception as e:
    res["home_write_blocked"] = True
    res["home_err"] = type(e).__name__

with open(os.path.join(os.environ["FINX_SPATIAL_DIR"], "out", "probe.txt"), "w") as f:
    f.write("ok")
res["workdir_write_ok"] = True

submit.marker([1, 1, 1], "sandbox_ok")
print(json.dumps(res))
"#;

    let work = tempfile::tempdir().unwrap();
    let script_path = work.path().join("sandbox_test.py");
    std::fs::write(&script_path, script).unwrap();
    let export_dir = work.path().join("work");
    std::fs::create_dir_all(export_dir.join("out")).unwrap();
    data.export("sandbox-doc", &export_dir).unwrap();
    let export_canon = std::fs::canonicalize(&export_dir).unwrap();

    let outcome = env
        .run(&tools, &export_canon, &script_path, "", Duration::from_secs(60), &ctx)
        .await
        .expect("run sandbox test");
    assert!(outcome.ok(), "sandbox script failed: {}", outcome.stderr);
    let parsed: Value = serde_json::from_str(outcome.stdout.trim()).expect("json stdout");
    assert_eq!(parsed["net_blocked"], true, "network was not blocked: {parsed}");
    assert_eq!(parsed["home_write_blocked"], true, "home write was not blocked: {parsed}");
    assert_eq!(parsed["workdir_write_ok"], true, "workdir write failed: {parsed}");
    assert_eq!(std::fs::read_to_string(export_canon.join("out/probe.txt")).unwrap(), "ok");
}
