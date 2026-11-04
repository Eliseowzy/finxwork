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
}

impl Anchor {
    pub fn page(&self) -> u32 {
        match self {
            Anchor::Page { page } | Anchor::Region { page, .. } | Anchor::Text { page, .. } => *page,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DocFormat {
    Pdf,
    Xlsx,
    Xlsm,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DocLayout {
    Paged,
    Flow,
    /// A spreadsheet (spreadsheet-design §4.1).
    Grid,
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

/// Where a session's document column is: which document, which page. Sent with each message
/// while the column is open, so "this page" means something to the model (§7.4).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DocViewing {
    pub doc_id: String,
    pub path: String,
    pub page: u32,
}
