//! Three-dimensional documents (docs/desktop/spatial-design.md §3, §13): a volume (DICOM files,
//! a folder of them, or a zip of them read in place) or a mesh (STL, OBJ, PLY, GLB). The original
//! files are never changed and never copied: a volume goes to a brick cache, a mesh to its levels
//! of detail, both under `$FINX_HOME/cache/spatial/<doc_id>/`, which can be deleted any time.
//! What people and agents add (structures, markers, measures, findings, the profile) are layers,
//! kept in the document's directory with their revisions, undone like a workbook's edits.
//!
//! Cache layout: `volume/index.json` and `volume/bricks.bin` (finx-spatial's brick cache),
//! `mesh/<id>/<lod>.bin` (finx-spatial's FXMS meshes), `masks/<id>.bin` (a structure's voxels,
//! one bit each, i fastest).

use finx_protocol::doc::DocOp;
use finx_protocol::doc::FindingSource;
use finx_protocol::doc::MeshSource;
use finx_protocol::doc::SpatialFinding;
use finx_protocol::doc::SpatialInfo;
use finx_protocol::doc::SpatialKind;
use finx_protocol::doc::SpatialLayer;
use finx_protocol::doc::SpatialMarker;
use finx_protocol::doc::SpatialMeasure;
use finx_protocol::doc::SpatialMesh;
use finx_protocol::doc::SpatialProfile;
use finx_protocol::doc::SpatialSeries;
use finx_protocol::doc::SpatialStructure;
use finx_protocol::doc::SpatialVolume;
use finx_protocol::doc::StructureStats;
use finx_spatial::algo::{Grid, Mask};
use finx_spatial::brick::BrickStore;
use finx_spatial::volume::{ValueMeaning, Volume};
use parking_lot::Mutex;
use serde::Deserialize;
use serde::Serialize;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use crate::atomic;
use crate::store::DocError;

/// Zip entries looked at to tell a zip of DICOM from any other zip.
const ZIP_PROBE: usize = 8;
/// Files looked at to tell a folder of DICOM from any other folder.
const FOLDER_PROBE: usize = 64;

/// What a path holds, when it is three-dimensional.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpatialSource {
    /// STL, OBJ, PLY or GLB, by extension, checked by content.
    Mesh,
    /// One DICOM file, a folder holding some, or a zip holding some.
    Dicom,
}

/// Whether `path` is a three-dimensional document. Content decides: DICOM by its `DICM` mark,
/// a zip only when one of its first entries is DICOM (any other zip is not one).
pub fn detect(path: &Path) -> Option<SpatialSource> {
    use std::io::Read;
    let meta = std::fs::metadata(path).ok()?;
    if meta.is_dir() {
        return folder_holds_dicom(path).then_some(SpatialSource::Dicom);
    }
    let mut head = vec![0u8; 4096];
    let n = std::fs::File::open(path).and_then(|mut f| f.read(&mut head)).ok()?;
    head.truncate(n);
    if finx_spatial::source::is_dicom(&head) {
        return Some(SpatialSource::Dicom);
    }
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("stl" | "obj" | "ply" | "glb") if finx_spatial::mesh::sniff(&head).is_some() || ext.as_deref() == Some("stl") => Some(SpatialSource::Mesh),
        // Office files are zips too: never DICOM.
        Some("xlsx" | "xlsm" | "docx" | "pptx") => None,
        _ if head.starts_with(b"PK\x03\x04") && finx_spatial::zipsrc::holds_dicom(path, ZIP_PROBE) => Some(SpatialSource::Dicom),
        _ => None,
    }
}

fn folder_holds_dicom(root: &Path) -> bool {
    use std::io::Read;
    let mut seen = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = entries.flatten().map(|e| e.path()).collect();
        entries.sort();
        for p in entries {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.starts_with('.') || name == "__MACOSX" {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };
            if meta.is_dir() {
                stack.push(p);
            } else if meta.is_file() {
                let mut head = [0u8; 132];
                if std::fs::File::open(&p).and_then(|mut f| f.read_exact(&mut head)).is_ok() && finx_spatial::source::is_dicom(&head) {
                    return true;
                }
                seen += 1;
                if seen >= FOLDER_PROBE {
                    return false;
                }
            }
        }
    }
    false
}

/// What opening found, kept as `spatial.json` in the document's directory.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Opened {
    pub kind: SpatialKind,
    pub volume: Option<SpatialVolume>,
    pub meshes: Vec<SpatialMesh>,
}

/// The layers, kept as `layers.json`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct Layers {
    pub structures: Vec<SpatialStructure>,
    pub findings: Vec<SpatialFinding>,
    pub markers: Vec<SpatialMarker>,
    pub measures: Vec<SpatialMeasure>,
    pub profile: Option<SpatialProfile>,
}

/// One revision: its ops, and those that take it back.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct SpatialRevision {
    pub ops: Vec<DocOp>,
    pub undo: Vec<DocOp>,
    pub session: String,
    pub at_ms: u128,
}

#[derive(Debug, Default)]
pub(crate) struct SpatialHistory {
    pub revisions: Vec<SpatialRevision>,
    pub applied: usize,
}

/// A three-dimensional document's state beside its `Doc`.
pub struct SpatialDoc {
    /// `$FINX_HOME/cache/spatial/<doc_id>`.
    pub cache: PathBuf,
    pub(crate) opened: Opened,
    bricks: Option<BrickStore>,
    volume: Mutex<Option<Arc<Volume>>>,
    pub(crate) layers: Mutex<Layers>,
    pub(crate) history: Mutex<SpatialHistory>,
}

impl SpatialDoc {
    pub fn kind(&self) -> SpatialKind {
        self.opened.kind
    }

    pub fn volume_info(&self) -> Option<&SpatialVolume> {
        self.opened.volume.as_ref()
    }

    /// The brick cache of a volume.
    pub fn bricks(&self) -> Option<&BrickStore> {
        self.bricks.as_ref()
    }

    /// The whole volume in memory, read from the bricks once and kept. Slow the first time:
    /// call it off the async threads.
    pub fn volume(&self) -> Result<Arc<Volume>, DocError> {
        if let Some(v) = self.volume.lock().as_ref() {
            return Ok(v.clone());
        }
        let store = self.bricks.as_ref().ok_or_else(|| DocError::NotEditable("this document has no volume, only meshes".into()))?;
        let v = Arc::new(Volume::from_store(store)?);
        *self.volume.lock() = Some(v.clone());
        Ok(v)
    }

    pub fn grid(&self) -> Option<Grid> {
        self.bricks.as_ref().map(|b| Grid::of(b.info()))
    }

    pub fn layers(&self) -> SpatialInfo {
        let l = self.layers.lock();
        let mut meshes = self.opened.meshes.clone();
        for s in l.structures.iter().filter(|s| !s.hidden) {
            let lods = self.mesh_lods(&s.id);
            if lods > 0 {
                meshes.push(SpatialMesh { id: s.id.clone(), name: s.name.clone(), color: s.color.clone(), opacity: s.opacity, source: MeshSource::Structure, lods });
            }
        }
        SpatialInfo {
            kind: self.opened.kind,
            volume: self.opened.volume.clone(),
            meshes,
            structures: l.structures.clone(),
            findings: l.findings.clone(),
            markers: l.markers.clone(),
            measures: l.measures.clone(),
            profile: l.profile.clone(),
        }
    }

    fn mesh_lods(&self, id: &str) -> u32 {
        let mut n = 0;
        while self.cache.join("mesh").join(id).join(format!("{n}.bin")).is_file() {
            n += 1;
        }
        n
    }

    /// A structure's voxels, from its mask file.
    pub fn mask(&self, id: &str) -> Option<Mask> {
        let grid = self.grid()?;
        let bytes = std::fs::read(self.cache.join("masks").join(format!("{}.bin", safe_id(id).ok()?))).ok()?;
        let n = grid.len();
        if bytes.len() != n.div_ceil(8) {
            return None;
        }
        let data = (0..n).map(|i| bytes[i / 8] & (1 << (i % 8)) != 0).collect();
        Some(Mask { grid, data })
    }

    /// Writes a structure's mask and meshes into the cache; returns the mask's name there.
    pub fn write_structure_files(&self, id: &str, mask: &Mask, meshes: &[finx_spatial::mesh::Mesh]) -> Result<String, DocError> {
        let id = safe_id(id)?;
        let mut bits = vec![0u8; mask.data.len().div_ceil(8)];
        for (i, b) in mask.data.iter().enumerate() {
            if *b {
                bits[i / 8] |= 1 << (i % 8);
            }
        }
        let masks = self.cache.join("masks");
        std::fs::create_dir_all(&masks)?;
        atomic::write(&masks.join(format!("{id}.bin")), &bits)?;
        let dir = self.cache.join("mesh").join(id);
        let _ = std::fs::remove_dir_all(&dir);
        if !meshes.is_empty() {
            std::fs::create_dir_all(&dir)?;
            for (lod, m) in meshes.iter().enumerate() {
                atomic::write(&dir.join(format!("{lod}.bin")), &finx_spatial::mesh::encode(m, true))?;
            }
        }
        Ok(format!("masks/{id}.bin"))
    }
}

/// Ids name files in the cache: letters, digits, `-`, `_` and `.` only.
pub fn safe_id(id: &str) -> Result<&str, DocError> {
    let ok = !id.is_empty() && id.len() <= 64 && !id.starts_with('.') && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok { Ok(id) } else { Err(DocError::NotEditable(format!("\"{id}\" is not an id: letters, digits, - _ . only, at most 64"))) }
}

/// What reading the files gave, before the document exists.
pub(crate) struct Prepared {
    pub id: String,
    pub cache: PathBuf,
    pub opened: Opened,
}

fn unreadable(path: &Path, e: impl std::fmt::Display) -> DocError {
    DocError::Unreadable(path.display().to_string(), e.to_string())
}

/// Reads the files and builds the cache when it is missing (slow: run it on a blocking thread).
pub(crate) fn prepare(path: &Path, source: SpatialSource, cache_root: &Path) -> Result<Prepared, DocError> {
    match source {
        SpatialSource::Mesh => prepare_mesh(path, cache_root),
        SpatialSource::Dicom => prepare_volume(path, cache_root),
    }
}

fn prepare_mesh(path: &Path, cache_root: &Path) -> Result<Prepared, DocError> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > crate::store::MAX_FILE_BYTES {
        return Err(DocError::TooLarge(path.display().to_string()));
    }
    let bytes = std::fs::read(path)?;
    let id = finx_spatial::content_id(&bytes)[..16].to_string();
    let cache = cache_root.join(&id);
    let dir = cache.join("mesh").join("file");
    let name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "mesh".into());
    let lods = match finx_spatial::mesh::read(&bytes) {
        Ok(mesh) => {
            if !dir.join("0.bin").is_file() {
                std::fs::create_dir_all(&dir)?;
                for (lod, m) in finx_spatial::mesh::lods(&mesh).iter().enumerate() {
                    atomic::write(&dir.join(format!("{lod}.bin")), &finx_spatial::mesh::encode(m, true))?;
                }
            }
            std::fs::read_dir(&dir)?.count() as u32
        }
        // GLB is shown by the viewer as it is: no levels of detail here.
        Err(finx_spatial::mesh::MeshError::Glb) => 0,
        Err(e) => return Err(unreadable(path, e)),
    };
    let mesh = SpatialMesh { id: "file".into(), name, color: "#c8c8c8".into(), opacity: 1.0, source: MeshSource::File, lods };
    Ok(Prepared { id, cache, opened: Opened { kind: SpatialKind::Mesh, volume: None, meshes: vec![mesh] } })
}

fn prepare_volume(path: &Path, cache_root: &Path) -> Result<Prepared, DocError> {
    let source = finx_spatial::open_source(path, &finx_spatial::zipsrc::Limits::default()).map_err(|e| unreadable(path, e))?;
    let series = finx_spatial::dicom::scan(source.as_ref()).map_err(|e| unreadable(path, e))?;
    let listed: Vec<SpatialSeries> = series
        .iter()
        .map(|s| SpatialSeries {
            uid: s.uid.clone(),
            description: s.description.clone(),
            slices: s.slices.len() as u32,
            spacing_mm: s.spacing,
            usable: s.usable(),
            reason: s.unusable.clone(),
        })
        .collect();
    let Some((best, reason)) = finx_spatial::dicom::pick(&series) else {
        let why = listed.iter().map(|s| s.reason.clone().unwrap_or_default()).collect::<Vec<_>>().join("; ");
        return Err(unreadable(path, format!("no series here can be a volume ({} found{})", listed.len(), if why.is_empty() { String::new() } else { format!(": {why}") })));
    };
    let id = best.identity()[..16].to_string();
    let cache = cache_root.join(&id);
    let bricks = cache.join("volume");
    let store = match BrickStore::open(&bricks) {
        Ok(s) => s,
        Err(_) => {
            let _ = std::fs::remove_dir_all(&bricks);
            std::fs::create_dir_all(&cache)?;
            finx_spatial::build_cache(source.as_ref(), best, &bricks).map_err(|e| unreadable(path, e))?
        }
    };
    let info = store.info();
    let unit = match &info.value {
        ValueMeaning::Calibrated { unit } => Some(unit.clone()),
        ValueMeaning::Raw => None,
    };
    let volume = SpatialVolume {
        dims: info.dims,
        spacing: info.spacing,
        origin: info.origin,
        direction: info.direction,
        unit,
        levels: store.levels() as u32,
        series: listed,
        picked: best.uid.clone(),
        reason,
    };
    Ok(Prepared { id, cache, opened: Opened { kind: SpatialKind::Volume, volume: Some(volume), meshes: Vec::new() } })
}

/// Opens the document's state from its directory (layers and revisions kept from before).
pub(crate) fn load(dir: &Path, prepared: Prepared) -> Result<SpatialDoc, DocError> {
    let bricks = if prepared.opened.kind == SpatialKind::Volume { Some(BrickStore::open(&prepared.cache.join("volume"))?) } else { None };
    let layers: Layers = std::fs::read_to_string(dir.join("layers.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let mut history = SpatialHistory::default();
    if let Ok(text) = std::fs::read_to_string(dir.join("revisions.jsonl")) {
        history.revisions = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
        history.applied = history.revisions.len();
    }
    atomic::write(&dir.join("spatial.json"), &serde_json::to_vec_pretty(&prepared.opened).map_err(std::io::Error::other)?)?;
    Ok(SpatialDoc { cache: prepared.cache, opened: prepared.opened, bricks, volume: Mutex::new(None), layers: Mutex::new(layers), history: Mutex::new(history) })
}

pub(crate) fn length(a: [f64; 3], b: [f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

fn upsert<T: Clone>(list: &mut Vec<T>, item: T, id: impl Fn(&T) -> &str) -> Option<T> {
    let key = id(&item).to_string();
    match list.iter_mut().find(|x| id(x) == key) {
        Some(slot) => Some(std::mem::replace(slot, item)),
        None => {
            list.push(item);
            None
        }
    }
}

fn remove<T>(list: &mut Vec<T>, key: &str, id: impl Fn(&T) -> &str) -> Option<T> {
    list.iter().position(|x| id(x) == key).map(|i| list.remove(i))
}

fn put_back(layer: SpatialLayer, id: &str, before: Option<DocOp>) -> DocOp {
    before.unwrap_or_else(|| DocOp::SpatialRemove { layer, id: id.to_string() })
}

impl Layers {
    /// Applies one op; returns the op that takes it back. `undoing` lets a finding come back as
    /// it was (its source unchanged) and go when its creation is undone.
    pub(crate) fn apply(&mut self, op: DocOp) -> Result<DocOp, DocError> {
        Ok(match op {
            DocOp::SpatialStructure { structure } => {
                safe_id(&structure.id)?;
                let id = structure.id.clone();
                let before = upsert(&mut self.structures, structure, |s| &s.id);
                put_back(SpatialLayer::Structure, &id, before.map(|structure| DocOp::SpatialStructure { structure }))
            }
            DocOp::SpatialMarker { marker } => {
                safe_id(&marker.id)?;
                let id = marker.id.clone();
                let before = upsert(&mut self.markers, marker, |s| &s.id);
                put_back(SpatialLayer::Marker, &id, before.map(|marker| DocOp::SpatialMarker { marker }))
            }
            DocOp::SpatialMeasure { mut measure } => {
                safe_id(&measure.id)?;
                // The number is the kernel's, whatever was sent.
                measure.length_mm = length(measure.from_mm, measure.to_mm);
                let id = measure.id.clone();
                let before = upsert(&mut self.measures, measure, |s| &s.id);
                put_back(SpatialLayer::Measure, &id, before.map(|measure| DocOp::SpatialMeasure { measure }))
            }
            DocOp::SpatialFinding { finding } => {
                safe_id(&finding.id)?;
                if let Some(old) = self.findings.iter().find(|f| f.id == finding.id)
                    && old.source != finding.source
                {
                    return Err(DocError::Refused(format!(
                        "finding {} is from {}: a finding's source is set when it is made and never changes",
                        finding.id,
                        source_name(old.source)
                    )));
                }
                let id = finding.id.clone();
                let before = upsert(&mut self.findings, finding, |s| &s.id);
                put_back(SpatialLayer::Finding, &id, before.map(|finding| DocOp::SpatialFinding { finding }))
            }
            DocOp::SpatialProfile { profile } => {
                let before = self.profile.replace(profile);
                DocOp::SpatialProfile { profile: before.unwrap_or_default() }
            }
            DocOp::SpatialRemove { layer, id } => {
                let missing = || DocError::NotEditable(format!("no {layer:?} {id}").to_lowercase());
                match layer {
                    SpatialLayer::Structure => DocOp::SpatialStructure { structure: remove(&mut self.structures, &id, |s| &s.id).ok_or_else(missing)? },
                    SpatialLayer::Marker => DocOp::SpatialMarker { marker: remove(&mut self.markers, &id, |s| &s.id).ok_or_else(missing)? },
                    SpatialLayer::Measure => DocOp::SpatialMeasure { measure: remove(&mut self.measures, &id, |s| &s.id).ok_or_else(missing)? },
                    SpatialLayer::Finding => DocOp::SpatialFinding { finding: remove(&mut self.findings, &id, |s| &s.id).ok_or_else(missing)? },
                }
            }
        })
    }

    /// Applies ops all or none; returns their undo, last first.
    pub(crate) fn apply_all(&mut self, ops: &[DocOp]) -> Result<Vec<DocOp>, DocError> {
        let saved = self.clone();
        let mut undo = Vec::new();
        for op in ops {
            match self.apply(op.clone()) {
                Ok(u) => undo.push(u),
                Err(e) => {
                    *self = saved;
                    return Err(e);
                }
            }
        }
        undo.reverse();
        Ok(undo)
    }
}

pub fn source_name(s: FindingSource) -> &'static str {
    match s {
        FindingSource::Reference => "reference",
        FindingSource::Ai => "ai",
        FindingSource::User => "user",
    }
}

/// Stats of a structure, as the layers keep them.
pub fn structure_stats(s: &finx_spatial::algo::Stats) -> StructureStats {
    StructureStats { volume_mm3: s.volume_mm3, max_diameter_mm: s.max_diameter_mm, centroid: s.centroid }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(id: &str, source: FindingSource) -> SpatialFinding {
        SpatialFinding { id: id.into(), name: "n".into(), summary: "s".into(), source, report_item: None, position_mm: None, radius_mm: None, measures: vec![], evidence: vec![], view: None }
    }

    #[test]
    fn a_findings_source_cannot_change_and_undo_takes_it_back() {
        let mut l = Layers::default();
        let undo = l.apply_all(&[DocOp::SpatialFinding { finding: finding("f1", FindingSource::Ai) }]).unwrap();
        assert!(matches!(l.apply(DocOp::SpatialFinding { finding: finding("f1", FindingSource::User) }), Err(DocError::Refused(_))));
        assert_eq!(l.findings[0].source, FindingSource::Ai);
        l.apply_all(&undo).unwrap();
        assert!(l.findings.is_empty());
    }

    #[test]
    fn the_kernel_measures() {
        let mut l = Layers::default();
        let m = SpatialMeasure { id: "m".into(), from_mm: [0.0; 3], to_mm: [3.0, 4.0, 0.0], length_mm: 99.0, label: String::new(), source: FindingSource::User };
        l.apply(DocOp::SpatialMeasure { measure: m }).unwrap();
        assert_eq!(l.measures[0].length_mm, 5.0);
        assert!(safe_id("../x").is_err());
    }
}
