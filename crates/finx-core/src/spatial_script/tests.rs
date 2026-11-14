use super::*;

/// The skill whose environment the tests run in.
const DEFAULT_SKILL: &str = "medical-imaging";
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

    /// Synthetic chest CT matching `crates/finx-spatial/tests/common/phantom.rs`
    /// (`N=256, PX=1.3, SLICES=200, GAP=1.25`, ground-glass nodule at `[-62.0, -50.0, 95.0]`).
    fn phantom() -> Self {
        const N: usize = 256;
        const SLICES: usize = 200;
        const PX: f64 = 1.3;
        const GAP: f64 = 1.25;
        const NODULE: ([f64; 3], f64, f64) = ([-62.0, -50.0, 95.0], 2.6, -520.0);
        const LUNG_R: ([f64; 3], [f64; 3]) = ([-72.0, 6.0, 125.0], [56.0, 76.0, 95.0]);
        const LUNG_L: ([f64; 3], [f64; 3]) = ([72.0, 6.0, 122.0], [50.0, 72.0, 90.0]);
        const HEART: ([f64; 3], [f64; 3]) = ([22.0, -32.0, 80.0], [58.0, 46.0, 52.0]);
        const CARINA: [f64; 3] = [0.0, -10.0, 175.0];

        let ellipsoid = |p: [f64; 3], c: [f64; 3], r: [f64; 3]| -> f64 {
            (0..3).map(|a| ((p[a] - c[a]) / r[a]).powi(2)).sum()
        };
        let seg_dist = |p: [f64; 3], a: [f64; 3], b: [f64; 3]| -> f64 {
            let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
            let denom = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
            let t = ((ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / denom).clamp(0.0, 1.0);
            ((ap[0] - t * ab[0]).powi(2) + (ap[1] - t * ab[1]).powi(2) + (ap[2] - t * ab[2]).powi(2)).sqrt()
        };
        let noise = |x: f64, y: f64, z: f64| -> f64 {
            let v = (x * 12.9898 + y * 78.233 + z * 37.719).sin() * 43758.5453;
            v - v.floor() - 0.5
        };

        let mut s: u64 = 7;
        let mut rnd = || {
            s = s * 16807 % 2147483647;
            s as f64 / 2147483647.0
        };
        let mut vessels = Vec::new();
        for side in [-1.0, 1.0] {
            let hilum = [side * 34.0, 4.0, 125.0];
            for _ in 0..10 {
                let (c, r) = if side < 0.0 { LUNG_R } else { LUNG_L };
                let t = [
                    c[0] + side * rnd() * 0.55 * r[0],
                    c[1] + (rnd() - 0.5) * 1.3 * r[1],
                    c[2] + (rnd() - 0.5) * 1.5 * r[2],
                ];
                let mid = [
                    (hilum[0] + t[0]) / 2.0 + (rnd() - 0.5) * 12.0,
                    (hilum[1] + t[1]) / 2.0 + (rnd() - 0.5) * 12.0,
                    (hilum[2] + t[2]) / 2.0,
                ];
                vessels.push((hilum, mid, 4.0));
                vessels.push((mid, t, 2.0));
            }
        }

        let half = (N as f64 - 1.0) / 2.0 * PX;
        let total = SLICES * N * N;
        let mut hu = Vec::with_capacity(total);
        let mut lungs = Vec::with_capacity(total);
        for k in 0..SLICES {
            let z = k as f64 * GAP;
            for j in 0..N {
                let y = -half + j as f64 * PX;
                for i in 0..N {
                    let x = -half + i as f64 * PX;
                    let p = [x, y, z];
                    let body = (x / 158.0).powi(2) + ((y - 8.0) / 112.0).powi(2);
                    let in_lung = (ellipsoid(p, LUNG_R.0, LUNG_R.1) < 1.0 || ellipsoid(p, LUNG_L.0, LUNG_L.1) < 1.0)
                        && ellipsoid(p, HEART.0, HEART.1) > 1.0;
                    let in_airway = seg_dist(p, [0.0, -10.0, 260.0], CARINA) < 8.0
                        || [-1.0, 1.0].iter().any(|side| seg_dist(p, CARINA, [side * 12.0, -8.0, 160.0]) < 5.0);
                    let in_nodule = ellipsoid(p, NODULE.0, [NODULE.1; 3]) < 1.0;

                    let v = if body > 1.0 || in_airway {
                        -1000.0 + noise(x, y, z) * 20.0
                    } else if in_nodule {
                        NODULE.2 + noise(x, y, z) * 40.0
                    } else if in_lung {
                        if vessels.iter().any(|(a, b, r)| seg_dist(p, *a, *b) < *r) {
                            30.0
                        } else {
                            -860.0 + noise(x, y, z) * 60.0
                        }
                    } else if (x * x + (y - 92.0).powi(2)).sqrt() < 17.0 {
                        420.0
                    } else if body > 0.7 && body < 0.8 && (z / 9.0).sin().abs() > 0.82 && y > -95.0 {
                        650.0
                    } else if body > 0.86 {
                        -90.0
                    } else {
                        40.0
                    };
                    hu.push(v.round() as i16);
                    lungs.push(in_lung && !in_airway);
                }
            }
        }
        Self {
            dims: [SLICES as u64, N as u64, N as u64],
            spacing: [GAP, PX, PX],
            hu,
            lungs,
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
        "skill_script": "medical-imaging/scripts/lung_nodule_candidates.py"
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

#[tokio::test]
async fn phantom_lung_nodule_candidates() {
    let Some(uv) = find_or_skip_uv() else {
        panic!("uv not found on PATH or in apps/desktop/node_modules/.cache/uv");
    };
    let _guard = shared_e2e_lock().lock().await;
    let home = FinxHome::new(shared_finx_home().path().to_path_buf());
    let data = Arc::new(MemoryData::phantom());
    let skill_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/skills/system");
    let handle = Arc::new(ScriptHandle {
        data: data.clone(),
        home: home.clone(),
        skill_roots: vec![skill_root],
    });
    let state = Arc::new(SessionState::default());
    state.insert(handle.clone());

    let tools = Tools {
        uv,
        python_path: Path::new(env!("CARGO_MANIFEST_DIR")).join("../finx-spatial/python"),
    };
    let env = Env::new(&handle.home, DEFAULT_SKILL);
    let ctx = tool_ctx(shared_finx_home().path(), state.clone());
    let _sync_note = env.sync(&tools, &handle.skill_roots[0].join(DEFAULT_SKILL), &ctx).await.expect("uv sync");

    let out = run(
        &handle,
        Args {
            doc_id: "phantom-ct".into(),
            purpose: "Detect lung nodule candidates in the chest phantom".into(),
            skill_script: Some("medical-imaging/scripts/lung_nodule_candidates.py".into()),
            script: None,
            skill: None,
            args: Some(json!({"min_mm": 3, "max_mm": 30, "max_candidates": 20})),
            timeout_s: Some(120),
        },
        &ctx,
    )
    .await
    .expect("run lung_nodule_candidates.py");

    assert!(!out.is_error, "script failed: {:?}", out.content);
    let applied = data.applied.lock().unwrap();
    assert_eq!(applied.len(), 1);
    let candidates: Vec<&Candidate> = applied[0]
        .1
        .iter()
        .filter_map(|s| match s {
            Submission::Candidate(c) => Some(c),
            _ => None,
        })
        .collect();
    assert!(!candidates.is_empty(), "expected at least one candidate");

    // Expected phantom nodule voxel: z=95 -> k=76, x=-62 -> i=80, y=-50 -> j=89.
    let target = [76i64, 89, 80];
    let top5_hit = candidates.iter().take(5).any(|c| {
        let dk = c.center_voxel[0] as i64 - target[0];
        let dj = c.center_voxel[1] as i64 - target[1];
        let di = c.center_voxel[2] as i64 - target[2];
        dk * dk + dj * dj + di * di <= 25
    });
    assert!(
        top5_hit,
        "phantom nodule near {target:?} was not in top 5 candidates: {:?}",
        candidates.iter().take(5).map(|c| (c.center_voxel, c.diameter_mm, c.score)).collect::<Vec<_>>()
    );

    let archive = home.root().join("docs/phantom-ct/scripts/1");
    for f in ["script.py", "args.json", "stdout.txt", "stderr.txt", "submit.jsonl", "result.json"] {
        assert!(archive.join(f).is_file(), "missing archive file {f}");
    }
}

#[cfg(target_os = "macos")]
/// The skill's chest script over the phantom: every structure comes back as a mask, the two
/// lungs on their own sides and of the phantom's sizes, with the volumes the script expects.
#[tokio::test]
async fn phantom_chest_structures() {
    let Some(uv) = find_or_skip_uv() else {
        panic!("uv not found on PATH or in apps/desktop/node_modules/.cache/uv");
    };
    let _guard = shared_e2e_lock().lock().await;
    let home = FinxHome::new(shared_finx_home().path().to_path_buf());
    let data = Arc::new(MemoryData::phantom());
    let skill_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/skills/system");
    let handle = Arc::new(ScriptHandle { data: data.clone(), home: home.clone(), skill_roots: vec![skill_root] });
    let state = Arc::new(SessionState::default());
    state.insert(handle.clone());
    let tools = Tools { uv, python_path: Path::new(env!("CARGO_MANIFEST_DIR")).join("../finx-spatial/python") };
    let env = Env::new(&handle.home, DEFAULT_SKILL);
    let ctx = tool_ctx(shared_finx_home().path(), state.clone());
    env.sync(&tools, &handle.skill_roots[0].join(DEFAULT_SKILL), &ctx).await.expect("uv sync");

    let out = run(
        &handle,
        Args {
            doc_id: "phantom-chest".into(),
            purpose: "Build the chest structures of the phantom".into(),
            skill_script: Some("medical-imaging/scripts/chest_structures.py".into()),
            script: None,
            skill: None,
            args: None,
            timeout_s: Some(300),
        },
        &ctx,
    )
    .await
    .expect("run chest_structures.py");
    assert!(!out.is_error, "script failed: {:?}", out.content);

    let applied = data.applied.lock().unwrap();
    let subs = &applied.last().unwrap().1;
    assert!(subs.iter().any(|s| matches!(s, Submission::Profile(p) if p.unit.as_deref() == Some("HU") && p.windows.len() == 3)));
    let structures: Vec<&Structure> = subs.iter().filter_map(|s| if let Submission::Structure(s) = s { Some(s) } else { None }).collect();
    let ids: Vec<&str> = structures.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["body", "airway", "lungs", "lungs_closed", "lung_right", "lung_left", "vessels", "bones"]);
    let get = |id: &str| *structures.iter().find(|s| s.id == id).unwrap();
    assert!(get("lungs").hidden && get("lungs_closed").hidden && !get("lung_left").hidden);
    assert_eq!(get("lung_left").expect_ml, Some([600.0, 4500.0]));

    // Voxels of a mask, and how many lie in the low-i half (the patient's right in this phantom).
    let voxel_ml = data.spacing.iter().product::<f64>() / 1000.0;
    let count = |id: &str| -> (f64, f64) {
        let bytes = std::fs::read(&get(id).mask).unwrap();
        let start = 10 + u16::from_le_bytes([bytes[8], bytes[9]]) as usize;
        let ni = data.dims[2] as usize;
        let (mut all, mut low) = (0u64, 0u64);
        for (n, b) in bytes[start..].iter().enumerate() {
            if *b != 0 {
                all += 1;
                low += u64::from(n % ni < ni / 2);
            }
        }
        (all as f64 * voxel_ml, low as f64 / all.max(1) as f64)
    };
    let truth = data.lungs.iter().filter(|b| **b).count() as f64 * voxel_ml;
    let (right, right_low) = count("lung_right");
    let (left, left_low) = count("lung_left");
    assert!(right_low > 0.99 && left_low < 0.01, "sides: right {right_low}, left {left_low}");
    // The phantom's right lung is the larger; together they are its lungs less the vessels in them.
    assert!(right > left && left > 1000.0, "right {right} mL, left {left} mL");
    assert!(((right + left) / truth - 1.0).abs() < 0.05, "{} mL vs the phantom's {truth} mL", right + left);
    let (airway, _) = count("airway");
    assert!((10.0..40.0).contains(&airway), "airway {airway} mL");
}

#[tokio::test]
async fn sandbox_blocks_network_and_home_writes_allows_workdir() {
    let Some(uv) = find_or_skip_uv() else {
        panic!("uv not found on PATH or in apps/desktop/node_modules/.cache/uv");
    };
    let _guard = shared_e2e_lock().lock().await;
    let home = FinxHome::new(shared_finx_home().path().to_path_buf());
    let data = Arc::new(MemoryData::tiny());
    let skill_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/skills/system");
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
    let env = Env::new(&handle.home, DEFAULT_SKILL);
    let ctx = tool_ctx(shared_finx_home().path(), state.clone());
    env.sync(&tools, &handle.skill_roots[0].join(DEFAULT_SKILL), &ctx).await.expect("uv sync");

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
