//! Documents opened beside a conversation (docs/desktop/document-editor-design.md §4, §6): what
//! a document is, how people and agents point into it, and the `doc/*` methods.
//!
//! Coordinates are PDF user space of the page as shown (rotation applied): points, origin at the
//! bottom left, y up. Pages count from 1, as the interface shows them.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;

/// A rectangle on a page: `x0 < x1`, `y0 < y1`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Rect {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

impl Rect {
    pub fn width(&self) -> f32 {
        self.x1 - self.x0
    }

    pub fn height(&self) -> f32 {
        self.y1 - self.y0
    }

    pub fn union(&self, other: &Rect) -> Rect {
        Rect {
            x0: self.x0.min(other.x0),
            y0: self.y0.min(other.y0),
            x1: self.x1.max(other.x1),
            y1: self.y1.max(other.y1),
        }
    }

    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x0 && x <= self.x1 && y >= self.y0 && y <= self.y1
    }

    pub fn intersects(&self, other: &Rect) -> bool {
        self.x0 < other.x1 && other.x0 < self.x1 && self.y0 < other.y1 && other.y0 < self.y1
    }
}

/// A position or a range in a document, as people and agents both refer to content (§4.2).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Anchor {
    Page { page: u32 },
    /// A region drawn on a page.
    Region { page: u32, rect: Rect },
    /// Selected text: `quads` has one rectangle a line, `text` is what the kernel read there.
    Text {
        page: u32,
        quads: Vec<Rect>,
        text: String,
        /// The block the text starts in (`p3.b12`), when known.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block: Option<String>,
    },
    /// A point of a three-dimensional document (spatial-design §3, §13): a voxel or a mesh
    /// surface, LPS mm.
    SpatialPoint { position_mm: [f64; 3] },
    /// A slice, or a box drawn on it.
    SpatialSlice {
        plane: SpatialPlane,
        index: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rect: Option<SliceRect>,
    },
    /// A structure or a mesh.
    SpatialPart { id: String },
    SpatialFinding { id: String },
    /// A viewpoint: the 3D camera, the slice shown, or both.
    SpatialView {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        camera: Option<SpatialCamera>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        slice: Option<SpatialSliceAt>,
    },
}

impl Anchor {
    /// The page of a page anchor; 0 for the anchors of three-dimensional documents, which have none.
    pub fn page(&self) -> u32 {
        match self {
            Anchor::Page { page } | Anchor::Region { page, .. } | Anchor::Text { page, .. } => *page,
            _ => 0,
        }
    }

    /// A place in a three-dimensional document, not on a page.
    pub fn is_spatial(&self) -> bool {
        !matches!(self, Anchor::Page { .. } | Anchor::Region { .. } | Anchor::Text { .. })
    }
}

// ---- three-dimensional documents (spatial-design §3, §13) ----

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpatialPlane {
    Axial,
    Coronal,
    Sagittal,
}

/// A box on a slice, in voxels of the slice's two axes: `[u0, u1)`, `[v0, v1)`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SliceRect {
    pub u0: u32,
    pub v0: u32,
    pub u1: u32,
    pub v1: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SpatialSliceAt {
    pub plane: SpatialPlane,
    pub index: u32,
}

/// A 3D camera, LPS mm.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SpatialCamera {
    pub position: [f64; 3],
    pub target: [f64; 3],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub up: Option<[f64; 3]>,
}

/// Where a finding is looked at from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SpatialViewAt {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<SpatialCamera>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slice: Option<SpatialSliceAt>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpatialKind {
    Volume,
    Mesh,
}

/// A series found in the files opened.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SpatialSeries {
    pub uid: String,
    pub description: String,
    pub slices: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spacing_mm: Option<f64>,
    pub usable: bool,
    /// Why it cannot be a volume.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SpatialVolume {
    pub dims: [u32; 3],
    /// mm along i, j, k.
    pub spacing: [f64; 3],
    /// The first voxel's centre, LPS mm.
    pub origin: [f64; 3],
    /// The directions of i, j and k, LPS.
    pub direction: [[f64; 3]; 3],
    /// The values' unit when calibrated (`HU`); none for raw grey levels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    /// Levels of the brick pyramid.
    pub levels: u32,
    pub series: Vec<SpatialSeries>,
    /// The series shown: its uid.
    pub picked: String,
    /// Why that one.
    pub reason: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeshSource {
    File,
    Structure,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SpatialMesh {
    pub id: String,
    pub name: String,
    /// `#rrggbb`.
    pub color: String,
    pub opacity: f64,
    pub source: MeshSource,
    /// Levels of detail at `spatial/mesh/<id>/<lod>.bin`, 0 the finest.
    pub lods: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StructureStats {
    pub volume_mm3: f64,
    pub max_diameter_mm: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub centroid: Option<[f64; 3]>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SpatialStructure {
    pub id: String,
    pub name: String,
    pub color: String,
    pub opacity: f64,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub stats: StructureStats,
    /// Where it came from: `script:run_<n>`, `user`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// Its mask, in the cache: `masks/<id>.bin`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask: Option<String>,
}

/// Who a finding (or a marker) comes from; set when it is made, never changed (§3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FindingSource {
    /// Authoritative material the user gave (in medicine, the doctor's report).
    Reference,
    Ai,
    User,
}

/// A number a finding states, worked out by the kernel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SpatialMeasureValue {
    pub name: String,
    pub value: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SpatialFinding {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub source: FindingSource,
    /// The report's item it stands for (a reference finding's line, or one an AI finding locates).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_item: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position_mm: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius_mm: Option<f64>,
    #[serde(default)]
    pub measures: Vec<SpatialMeasureValue>,
    /// What it rests on, in words a person can check (a slice, a structure, a computed value).
    #[serde(default)]
    pub evidence: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<SpatialViewAt>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SpatialMarker {
    pub id: String,
    pub position_mm: [f64; 3],
    pub label: String,
    pub source: FindingSource,
}

/// A length between two points; `length_mm` is the kernel's.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SpatialMeasure {
    pub id: String,
    pub from_mm: [f64; 3],
    pub to_mm: [f64; 3],
    #[serde(default)]
    pub length_mm: f64,
    #[serde(default)]
    pub label: String,
    pub source: FindingSource,
}

/// A skill's display settings (spatial-design §5.2 `profile`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SpatialProfile {
    /// `patient` (L/R, A/P, S/I shown) or `none`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orientation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    /// `[name, width, level]`, in order.
    #[serde(default)]
    pub windows: Vec<(String, f64, f64)>,
    /// Shown whenever there is an `ai` finding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disclaimer: Option<String>,
}

/// A three-dimensional document's layers (`DocInfo.spatial`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SpatialInfo {
    pub kind: SpatialKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<SpatialVolume>,
    #[serde(default)]
    pub meshes: Vec<SpatialMesh>,
    #[serde(default)]
    pub structures: Vec<SpatialStructure>,
    #[serde(default)]
    pub findings: Vec<SpatialFinding>,
    #[serde(default)]
    pub markers: Vec<SpatialMarker>,
    #[serde(default)]
    pub measures: Vec<SpatialMeasure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<SpatialProfile>,
}

/// What a layer is, to remove one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpatialLayer {
    Structure,
    Marker,
    Measure,
    Finding,
}

/// One change to a three-dimensional document's layers (§13). Each adds the item, or replaces
/// the one with its id; a finding's `source` cannot change once made.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum DocOp {
    SpatialStructure { structure: SpatialStructure },
    SpatialMarker { marker: SpatialMarker },
    SpatialMeasure { measure: SpatialMeasure },
    SpatialFinding { finding: SpatialFinding },
    SpatialProfile { profile: SpatialProfile },
    SpatialRemove { layer: SpatialLayer, id: String },
}

/// `doc/ops`: a person's marks and measures in the 3D view, as one revision.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocOpsParams {
    pub session_id: String,
    pub doc_id: String,
    pub ops: Vec<DocOp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocOpsResult {
    pub revision: u64,
    pub info: DocInfo,
}

/// `spatial/view`: the agent asks the person's view to turn to something (it does not move by itself otherwise).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SpatialViewParams {
    pub session_id: String,
    pub doc_id: String,
    pub target: Anchor,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DocFormat {
    Pdf,
    Xlsx,
    Xlsm,
    /// CSV and TSV: values only (spreadsheet-design §10.1).
    Csv,
    /// Excel 97–2003, read only (§10.2).
    Xls,
    /// A volume (DICOM) or a mesh (STL, OBJ, PLY, GLB) (spatial-design §3).
    Spatial,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DocLayout {
    Paged,
    Flow,
    /// A spreadsheet (spreadsheet-design §4.1).
    Grid,
    /// A three-dimensional document (spatial-design §4.2).
    Space,
}

/// What a document supports (§4.5); toolbars and tool descriptions follow it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    View,
    Text,
    Search,
    Outline,
    /// Spreadsheets (spreadsheet-design §4.4): cells read by range.
    Cells,
    /// Edits come back with their impact; edits can be tried without keeping them.
    Calc,
    EditValues,
    EditFormulas,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct OutlineItem {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<OutlineItem>,
}

/// A document's state, which belongs to the file and is the same in every session (§4.1).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocInfo {
    /// From the file's canonical path: the same file has the same id in every session.
    pub doc_id: String,
    pub path: String,
    pub format: DocFormat,
    pub layout: DocLayout,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outline: Vec<OutlineItem>,
    pub capabilities: Vec<Capability>,
    pub revision: u64,
    /// The working copy differs from the file.
    pub dirty: bool,
    /// Whether saving can write the file back; false for read-only or repaired files.
    pub save_in_place: bool,
    /// No text could be read: probably a scan.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub scanned: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub encrypted: bool,
    /// A spreadsheet's sheets, in workbook order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sheets: Vec<SheetInfo>,
    /// A three-dimensional document's layers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spatial: Option<SpatialInfo>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SheetInfo {
    pub name: String,
    /// A chart sheet has no cells: the grid shows a placeholder.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub chart: bool,
    /// The used range, `A1:K120`; none for an empty sheet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used: Option<String>,
    /// Frozen panes: rows above and columns left of the split.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frozen: Option<(u32, u32)>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    /// Protected in Excel: no edits here.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub protected: bool,
    /// Column widths in pixels where they are not the default.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub columns: Vec<ColumnWidth>,
    /// Pixels.
    pub default_width: f32,
    pub default_height: f32,
    /// Charts drawn on the sheet, as the file anchors them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub charts: Vec<SheetChart>,
}

/// Columns `first..=last` (1-based) are `width` pixels wide, or hidden.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ColumnWidth {
    pub first: u32,
    pub last: u32,
    pub width: f32,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
}

/// A row whose height is not the default, in pixels, or hidden.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RowHeight {
    pub row: u32,
    pub height: f32,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
}

/// What a block of text is to the layout analysis (§9.2.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    Heading,
    Body,
    /// Running heads, footers, page numbers and vertical text in the margins.
    Margin,
}

/// One block of a page, with its short id (`p3.b12`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TextBlock {
    pub id: String,
    pub page: u32,
    pub kind: BlockKind,
    pub rect: Rect,
    pub text: String,
}

/// A cell's value: what it holds, or what its formula gave.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum CellValue {
    Number(f64),
    Text(String),
    Bool(bool),
    /// `#N/A`, `#REF!`…
    Error(String),
}

/// How a cell looks, beyond its text.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CellLook {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bold: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub italic: bool,
    /// Text colour, `RRGGBB`; a number format's colour (`[Red]`) wins over the font's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CellData {
    /// `B3`.
    pub cell: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<CellValue>,
    /// As Excel shows it, in the cell's number format.
    pub text: String,
    /// As typed, with `=`, without storage prefixes such as `_xlfn.`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
    #[serde(default, skip_serializing_if = "is_plain")]
    pub look: CellLook,
}

fn is_plain(l: &CellLook) -> bool {
    *l == CellLook::default()
}

/// What a person or an agent types into a cell.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum CellInput {
    Number(f64),
    Bool(bool),
    Text(String),
}

/// One change to a spreadsheet (spreadsheet-design §4.3).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum SheetOp {
    /// A value, kept as given: text stays text (`"000001"`, `"=abc"`).
    SetValue { sheet: String, cell: String, value: CellInput },
    /// `=SUM(B3:B9)`.
    SetFormula { sheet: String, cell: String, formula: String },
    /// Empties the cells of a range, keeping their format.
    Clear { sheet: String, range: String },
}

/// A cell an edit changed: before and after, as values and as shown.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CellChange {
    pub sheet: String,
    pub cell: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<CellValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<CellValue>,
    pub before_text: String,
    pub after_text: String,
    /// The nearest text to the left or above, as a person would name the cell ("企业价值").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// What an edit changed (spreadsheet-design §5.5, §7).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Impact {
    pub edited: Vec<CellChange>,
    /// Formula cells no other formula reads whose value changed: the model's outputs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_outputs: Vec<CellChange>,
    /// Every formula cell whose value changed, `Sheet!A1`, at most 5,000.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub affected: Vec<String>,
    pub affected_count: usize,
    /// Downstream cells whose new value we cannot vouch for: Excel recalculates them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub needs_excel: Vec<String>,
    /// Rounds of iterative calculation, when circular references were involved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iterations: Option<u32>,
    /// False when iteration stopped at its limit without settling.
    pub converged: bool,
    /// Why there is no impact beyond the edited cells: the workbook cannot be calculated here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calc_unavailable: Option<String>,
}

// ---- methods ----

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocOpenParams {
    pub session_id: String,
    /// The file. Or, instead, `doc_id`: a document opened before, as a citation names it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doc_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocOpenResult {
    pub info: DocInfo,
    /// Reads the working copy: `finxdoc://<token>/current.pdf` (§7.3).
    pub token: String,
    /// An encrypted document's password, for the page to decrypt what it reads (§9.4.3). Only in
    /// memory: never written down, never logged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocIdParams {
    pub session_id: String,
    pub doc_id: String,
}

/// What a session's document column shows: the page, and what is selected.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocViewParams {
    pub session_id: String,
    pub doc_id: String,
    pub page: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<Anchor>,
}

/// A selection or a region on a page, to be read by the kernel (§9.4.1).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocResolveParams {
    pub session_id: String,
    pub doc_id: String,
    pub page: u32,
    /// The selection's rectangles; text whose middle falls in one of them is selected.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub quads: Vec<Rect>,
    /// A region drawn on the page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rect: Option<Rect>,
    /// A selection that goes on past `page`: its rectangles on each page after it, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub more: Vec<PageQuads>,
}

/// A selection's rectangles on one page.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PageQuads {
    pub page: u32,
    pub quads: Vec<Rect>,
}

/// What the kernel read on one page of a selection.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ResolvedPart {
    pub anchor: Anchor,
    pub boxes: Vec<Rect>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocResolveResult {
    pub anchor: Anchor,
    /// The text the kernel read there: a selection's, or what lies in a region.
    pub text: String,
    /// The boxes of the characters the kernel took: the interface draws the selection with them.
    pub boxes: Vec<Rect>,
    /// The pages after the first, for a selection that goes on (`more`); `text` is all of it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub more: Vec<ResolvedPart>,
    /// The block the text starts in (`p12.b3`), for a region as for a selection: what a citation of it names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block: Option<String>,
}

/// A citation's target in an open document: `p12.b3` (a block) or `p12` (a page).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocLocateParams {
    pub session_id: String,
    pub doc_id: String,
    pub target: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocLocateResult {
    /// A block's text and lines, or the page.
    pub anchor: Anchor,
}

/// A range of a sheet, as the grid shows it (spreadsheet-design §7 `doc/cells`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocCellsParams {
    pub session_id: String,
    pub doc_id: String,
    pub sheet: String,
    /// `A1:Z60`; at most 10,000 cells.
    pub range: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocCellsResult {
    /// Cells that hold something or have a look, row by row.
    pub cells: Vec<CellData>,
    /// Merged ranges that meet the range.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub merges: Vec<String>,
    /// Rows of the range whose height is their own.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rows: Vec<RowHeight>,
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocApplyParams {
    pub session_id: String,
    pub doc_id: String,
    pub ops: Vec<SheetOp>,
    /// The revision the edit was made against; behind, the edit is refused (`doc_stale`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<u64>,
    /// Only work out the impact; change nothing (`doc/calc`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub preview: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocApplyResult {
    pub revision: u64,
    pub impact: Impact,
    pub dirty: bool,
}

/// A cell found or traced, as the grid lists it and the agent reads it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FoundCell {
    pub sheet: String,
    pub cell: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// For a trace: how many steps from the cell asked about.
    #[serde(default)]
    pub depth: u32,
    /// For a trace: the cell it was reached from (`Sheet!B3`), for the grid's arrows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TraceDirection {
    /// What the cell reads (Excel's precedents).
    Up,
    /// What reads the cell (Excel's dependents).
    Down,
}

/// `doc/trace`: Excel's 追踪引用单元格 / 追踪从属单元格, `depth` steps out (1 to 10).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocTraceParams {
    pub session_id: String,
    pub doc_id: String,
    pub sheet: String,
    pub cell: String,
    pub direction: TraceDirection,
    #[serde(default = "one")]
    pub depth: u32,
}

fn one() -> u32 {
    1
}

/// `doc/find`: cells whose shown text or formula contains `query`, case folded.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocFindParams {
    pub session_id: String,
    pub doc_id: String,
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocFoundResult {
    /// At most 500 for a trace, `limit` for a search; `more` when there were others.
    pub cells: Vec<FoundCell>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub more: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FillDirection {
    /// Excel's ⌘D: the range's first row into the rows under it.
    Down,
    /// Excel's ⌘R: the range's first column into the columns to its right.
    Right,
}

/// `doc/fill`: one edit that copies the range's first row (or column) across it, formulas
/// moved as Excel moves them (relative references shift, `$` ones stay).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocFillParams {
    pub session_id: String,
    pub doc_id: String,
    pub sheet: String,
    pub range: String,
    pub direction: FillDirection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<u64>,
}

/// What `doc/structure` does: Excel's 插入 / 删除 of whole rows or columns.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StructureKind {
    InsertRows,
    DeleteRows,
    InsertColumns,
    DeleteColumns,
}

/// Rows (or columns) inserted before `at`, or deleted from `at` on; 1-based (column B is 2).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SheetStructure {
    pub sheet: String,
    pub kind: StructureKind,
    pub at: u32,
    pub count: u32,
}

/// `doc/structure`: inserts or deletes whole rows or columns as one edit. Every reference to
/// the cells that move moves with them, in every sheet, as Excel moves it; one into deleted
/// cells becomes `#REF!`; comments move with their cells. Refused where it cannot be done
/// faithfully here (Excel tables, pivot tables, form controls…): the reason says so.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocStructureParams {
    pub session_id: String,
    pub doc_id: String,
    #[serde(flatten)]
    pub change: SheetStructure,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<u64>,
}

/// `doc/sort`: the rows of `range` sorted by the values of one of its columns, as one edit;
/// as Excel sorts, numbers come before text before TRUE/FALSE before errors, blanks last
/// either way, ties keep their order, and a formula moves with its row (relative references
/// shift). Formats stay where they are.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocSortParams {
    pub session_id: String,
    pub doc_id: String,
    pub sheet: String,
    pub range: String,
    /// The column sorted by, its letters (`C`); within the range.
    pub by: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub descending: bool,
    /// The range's first row is a header and stays where it is.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub header: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<u64>,
}

/// `doc/autofill`: Excel's fill handle dragged from `source` to `target` (the source with the
/// rows or columns the drag added on one side), as one edit. Numbers, dates, text ending in a
/// number and the built-in lists (周一, 一月, Jan…) carry on as a series; anything else, and
/// formulas moved as Excel moves them, repeats.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocAutofillParams {
    pub session_id: String,
    pub doc_id: String,
    pub sheet: String,
    pub source: String,
    pub target: String,
    /// The key Excel holds to switch (⌥ on a Mac, Ctrl elsewhere): a single number counts up,
    /// a series is copied instead.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub switch: bool,
    /// Only work it out, for what the drag shows as it goes: nothing is written.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub preview: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocRecalcParams {
    pub session_id: String,
    pub doc_id: String,
    /// Restart circular references at zero; otherwise recalculate everything.
    #[serde(default)]
    pub circular_only: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocSaveParams {
    pub session_id: String,
    pub doc_id: String,
    /// Save as: another file. Without it, the file the document came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Write over the file even though it changed on disk since it was opened.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub force: bool,
}

/// `doc/changed`: what the document is now.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocChangedParams {
    pub info: DocInfo,
}

/// Where a session's document column is: which document, which page. Sent with each message
/// while the column is open, so "this page" means something to the model (§7.4).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocViewing {
    pub doc_id: String,
    pub path: String,
    pub page: u32,
}

/// What a chart drawn on a worksheet is (spreadsheet-design §4.1: shown, not edited).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SheetChartKind {
    Bar,
    Line,
    Area,
    Pie,
    Doughnut,
    Scatter,
    Radar,
}

/// How a bar or area chart's series sit together.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SheetChartGrouping {
    #[default]
    Clustered,
    Stacked,
    Percent,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SheetChartSeries {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `RRGGBB`, when the file names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// One per category; none for a gap.
    pub values: Vec<Option<f64>>,
    /// A scatter's x values.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub x: Vec<Option<f64>>,
}

/// A place on the grid: a cell (1-based) and the offset into it, in pixels.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SheetChartCorner {
    pub col: u32,
    pub row: u32,
    pub dx: f32,
    pub dy: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SheetChart {
    pub kind: SheetChartKind,
    /// Bars run sideways.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub horizontal: bool,
    #[serde(default)]
    pub grouping: SheetChartGrouping,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// `b`, `t`, `l`, `r`; none when there is no legend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legend: Option<String>,
    /// Values written on the marks.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub labels: bool,
    pub categories: Vec<String>,
    pub series: Vec<SheetChartSeries>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    pub from: SheetChartCorner,
    /// The far corner of a two-cell anchor; else the size below applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<SheetChartCorner>,
    /// Pixels.
    pub width: f32,
    pub height: f32,
}
