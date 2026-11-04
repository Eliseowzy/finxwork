//! The spreadsheet side of the worker (spreadsheet-design §5.7): a workbook's working copy, read
//! as cells for the grid and the agent, changed by surgical writes, with a calculation engine
//! kept beside it for the impact of each edit.
//!
//! The grid shows what the working copy holds (§5.6.3): Excel's values until something changes,
//! then the results we wrote. The engine only answers "what changes if…".

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;

use finx_protocol::doc::CellChange;
use finx_protocol::doc::CellData;
use finx_protocol::doc::CellInput;
use finx_protocol::doc::CellLook;
use finx_protocol::doc::CellValue;
use finx_protocol::doc::ColumnWidth;
use finx_protocol::doc::RowHeight;
use finx_protocol::doc::Impact;
use finx_protocol::doc::SheetInfo;
use finx_protocol::doc::SheetOp;
use finx_sheet::CellEdit;
use finx_sheet::NewValue;
use finx_sheet::Options;
use finx_sheet::book::Book;
use finx_sheet::book::Value;
use finx_sheet::calc::Engine;
use finx_sheet::cellref::CellRef;
use finx_sheet::cellref::Rect;
use finx_sheet::deps::Node;
use finx_sheet::formula::display;
use finx_sheet::package::SheetKind;
use serde::Deserialize;
use serde::Serialize;

/// A request for more cells than this is cut short.
pub const MAX_CELLS: u64 = 10_000;
/// Cells named one by one in an impact; beyond this only the count.
const MAX_AFFECTED: usize = 5_000;
/// The prefix of a refusal (§5.3.3), so the kernel can tell it from a failure.
pub const REFUSED: &str = "refused: ";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SheetOpened {
    pub sheets: Vec<SheetInfo>,
    /// Why edits come back without their impact, when the workbook cannot be calculated here.
    pub calc_unavailable: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Cells {
    pub cells: Vec<CellData>,
    pub merges: Vec<String>,
    pub rows: Vec<RowHeight>,
}

/// Excel's column width (characters of the default font, Calibri 11) in pixels.
fn width_px(chars: f64) -> f32 {
    (chars * 7.0 + 5.0).round() as f32
}

/// Points to pixels.
fn height_px(points: f64) -> f32 {
    (points * 4.0 / 3.0).round() as f32
}

/// A cell found or traced, as the agent reads it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Found {
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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    /// What the cell reads.
    Up,
    /// What reads the cell.
    Down,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Applied {
    pub impact: Impact,
    /// What puts the cells back as they were.
    pub undo: Vec<SheetOp>,
}

struct SheetDoc {
    path: PathBuf,
    bytes: Vec<u8>,
    book: Book,
    engine: Result<Engine, String>,
}

#[derive(Default)]
pub struct Sheets {
    docs: HashMap<u64, SheetDoc>,
}

fn engine_for(bytes: &[u8]) -> Result<Engine, String> {
    let book = Book::open(bytes).map_err(|e| e.to_string())?;
    Engine::new(book).map_err(|e| e.to_string())
}

fn refusal(e: finx_sheet::Error) -> String {
    match e {
        finx_sheet::Error::Unsupported(m) | finx_sheet::Error::Formula(m) => format!("{REFUSED}{m}"),
        other => other.to_string(),
    }
}

fn protocol_value(v: &Value) -> Option<CellValue> {
    match v {
        Value::Number(n) => Some(CellValue::Number(*n)),
        Value::Text(t) => Some(CellValue::Text(t.clone())),
        Value::Bool(b) => Some(CellValue::Bool(*b)),
        Value::Error(e) => Some(CellValue::Error(e.clone())),
        Value::Empty => None,
    }
}

impl Sheets {
    pub fn open(&mut self, handle: u64, path: &Path) -> Result<SheetOpened, String> {
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        let book = Book::open(&bytes).map_err(|e| match e {
            finx_sheet::Error::Unsupported(m) => m,
            e => format!("cannot open the workbook: {e}"),
        })?;
        let sheets = book
            .sheets
            .iter()
            .zip(&book.info.sheets)
            .filter(|(s, _)| s.kind != SheetKind::Other)
            .map(|(s, entry)| {
                let ix = s.index.as_ref();
                let used = ix.and_then(|ix| {
                    let mut cells = ix.cells().filter(|c| c.v.is_some() || c.formula.is_some() || c.inline.is_some()).map(|c| c.at);
                    let first = cells.next()?;
                    Some(cells.fold(Rect::single(first), |r, c| r.union(c)).to_string())
                });
                SheetInfo {
                    name: s.name.clone(),
                    chart: s.kind == SheetKind::Chartsheet,
                    used,
                    frozen: ix.and_then(|ix| ix.frozen),
                    hidden: entry.hidden,
                    protected: ix.is_some_and(|ix| ix.protected),
                    columns: ix
                        .map(|ix| ix.cols.iter().filter(|c| c.width.is_some() || c.hidden).map(|c| ColumnWidth { first: c.min, last: c.max, width: width_px(c.width.unwrap_or(8.43)), hidden: c.hidden }).collect())
                        .unwrap_or_default(),
                    default_width: width_px(ix.and_then(|ix| ix.default_width).unwrap_or(8.43)),
                    default_height: height_px(ix.and_then(|ix| ix.default_height).unwrap_or(15.0)),
                }
            })
            .collect();
        let engine = engine_for(&bytes);
        let calc_unavailable = engine.as_ref().err().cloned();
        self.docs.insert(handle, SheetDoc { path: path.to_path_buf(), bytes, book, engine });
        Ok(SheetOpened { sheets, calc_unavailable })
    }

    pub fn close(&mut self, handle: u64) -> bool {
        self.docs.remove(&handle).is_some()
    }

    fn doc(&mut self, handle: u64) -> Result<&mut SheetDoc, String> {
        self.docs.get_mut(&handle).ok_or_else(|| "the document is not open".to_string())
    }

    pub fn cells(&mut self, handle: u64, sheet: &str, range: &str) -> Result<Cells, String> {
        let doc = self.doc(handle)?;
        let book = &doc.book;
        let s = book.sheet_index(sheet).ok_or_else(|| format!("no sheet named {sheet}"))?;
        let rect = Rect::parse(range).ok_or_else(|| format!("not a range: {range}"))?;
        let size = (rect.last.row - rect.first.row + 1) as u64 * (rect.last.col - rect.first.col + 1) as u64;
        if size > MAX_CELLS {
            return Err(format!("{range} has {size} cells; ask for at most {MAX_CELLS} at a time"));
        }
        let Some(ix) = &book.sheets[s].index else { return Ok(Cells { cells: vec![], merges: vec![], rows: vec![] }) };
        let mut cells = Vec::new();
        for row in ix.rows.iter().filter(|r| r.r >= rect.first.row && r.r <= rect.last.row) {
            for c in row.cells.iter().filter(|c| c.at.col >= rect.first.col && c.at.col <= rect.last.col) {
                let value = book.value(s, c.at);
                let style = book.style(s, c.at);
                let (text, format_color) = book.display(&value, &style);
                let look = CellLook {
                    bold: style.bold,
                    italic: style.italic,
                    color: format_color.map(str::to_string).or(style.color.clone()),
                    fill: style.fill.clone(),
                    align: style.align.clone(),
                };
                let formula = book.formula(s, c.at).map(|f| format!("={}", display(f)));
                if value == Value::Empty && formula.is_none() && look == CellLook::default() {
                    continue;
                }
                cells.push(CellData { cell: c.at.to_string(), value: protocol_value(&value), text, formula, look });
            }
        }
        let merges = ix
            .merges
            .iter()
            .filter(|m| m.first.row <= rect.last.row && m.last.row >= rect.first.row && m.first.col <= rect.last.col && m.last.col >= rect.first.col)
            .map(ToString::to_string)
            .collect();
        let rows = ix
            .rows
            .iter()
            .filter(|r| r.r >= rect.first.row && r.r <= rect.last.row && (r.height.is_some() || r.hidden))
            .map(|r| RowHeight { row: r.r, height: r.height.map(height_px).unwrap_or(0.0), hidden: r.hidden })
            .collect();
        Ok(Cells { cells, merges, rows })
    }

    pub fn apply(&mut self, handle: u64, ops: &[SheetOp], preview: bool) -> Result<Applied, String> {
        let doc = self.doc(handle)?;
        let edits = edits_of(&doc.book, ops)?;
        let undo = undo_of(&doc.book, &edits);
        let before = |doc: &SheetDoc, n: Node| doc.book.value(n.0, n.1);
        let impact = match &mut doc.engine {
            Ok(engine) => {
                let result = if preview { engine.preview(&edits) } else { engine.apply(&edits) };
                match result {
                    Ok(i) => Some(i),
                    Err(e) => {
                        // The engine may hold part of the edit: start it again from the file.
                        doc.engine = engine_for(&doc.bytes);
                        return Err(refusal(e));
                    }
                }
            }
            Err(_) => None,
        };
        if !preview {
            let writes: Vec<CellEdit> = match (&doc.engine, &impact) {
                (Ok(engine), Some(impact)) => engine.writes(&edits, impact),
                _ => edits.iter().map(|(n, v)| CellEdit { sheet: doc.book.sheets[n.0].name.clone(), cell: n.1.to_string(), value: v.clone() }).collect(),
            };
            let out = match finx_sheet::write(&doc.bytes, &writes, &Options::default()) {
                Ok(out) => out,
                Err(e) => {
                    doc.engine = engine_for(&doc.bytes);
                    return Err(refusal(e));
                }
            };
            // Beside, then renamed: the working copy is never half written.
            let partial = doc.path.with_extension("partial");
            std::fs::write(&partial, &out.bytes).and_then(|()| std::fs::rename(&partial, &doc.path)).map_err(|e| e.to_string())?;
            let book = Book::open(&out.bytes).map_err(|e| e.to_string())?;
            let edited_before: Vec<Value> = edits.iter().map(|(n, _)| before(doc, *n)).collect();
            let old_book = std::mem::replace(&mut doc.book, book);
            doc.bytes = out.bytes;
            return Ok(Applied { impact: protocol_impact(&old_book, &doc.book, &edits, edited_before, impact.as_ref(), &doc.engine), undo });
        }
        let edited_before: Vec<Value> = edits.iter().map(|(n, _)| before(doc, *n)).collect();
        Ok(Applied { impact: protocol_impact(&doc.book, &doc.book, &edits, edited_before, impact.as_ref(), &doc.engine), undo })
    }
}

impl Sheets {
    fn found(book: &Book, n: Node, depth: u32) -> Found {
        let style = book.style(n.0, n.1);
        Found {
            sheet: book.sheets[n.0].name.clone(),
            cell: n.1.to_string(),
            text: book.display(&book.value(n.0, n.1), &style).0,
            formula: book.formula(n.0, n.1).map(|f| format!("={}", display(f))),
            label: book.label(n.0, n.1),
            depth,
        }
    }

    /// Cells whose shown text, or formula, contains `query` (case folded), in sheet order.
    pub fn find(&mut self, handle: u64, query: &str, limit: usize) -> Result<Vec<Found>, String> {
        let book = &self.doc(handle)?.book;
        let q = query.to_lowercase();
        let mut out = Vec::new();
        for (s, sheet) in book.sheets.iter().enumerate() {
            let Some(ix) = &sheet.index else { continue };
            for c in ix.cells() {
                let style = book.style(s, c.at);
                let text = book.display(&book.value(s, c.at), &style).0;
                let formula = book.formula(s, c.at).unwrap_or("");
                if text.to_lowercase().contains(&q) || display(formula).to_lowercase().contains(&q) {
                    out.push(Self::found(book, (s, c.at), 0));
                    if out.len() >= limit {
                        return Ok(out);
                    }
                }
            }
        }
        Ok(out)
    }

    /// The cells a cell reads (up) or the formulas that read it (down), `depth` steps out.
    pub fn trace(&mut self, handle: u64, sheet: &str, cell: &str, direction: Direction, depth: u32) -> Result<Vec<Found>, String> {
        let doc = self.doc(handle)?;
        let engine = doc.engine.as_ref().map_err(Clone::clone)?;
        let book = &doc.book;
        let s = book.sheet_index(sheet).ok_or_else(|| format!("no sheet named {sheet}"))?;
        let start = (s, CellRef::parse(cell).ok_or_else(|| format!("not a cell: {cell}"))?);
        let mut seen = BTreeSet::from([start]);
        let mut frontier = vec![start];
        let mut out = Vec::new();
        for d in 1..=depth.clamp(1, 10) {
            let mut next = Vec::new();
            for n in frontier {
                let step: Vec<Node> = match direction {
                    Direction::Down => engine.graph.readers(n),
                    // Every cell a formula reads, inputs included, one area at a time.
                    Direction::Up => engine
                        .graph
                        .areas
                        .get(&n)
                        .into_iter()
                        .flatten()
                        .flat_map(|a| {
                            let ix = book.sheets.get(a.sheet).and_then(|s| s.index.as_ref());
                            ix.into_iter().flat_map(move |ix| {
                                ix.cells().filter(move |c| c.at.row >= a.first.row && c.at.row <= a.last.row && c.at.col >= a.first.col && c.at.col <= a.last.col).map(move |c| (a.sheet, c.at))
                            })
                        })
                        .collect(),
                };
                for m in step {
                    if seen.insert(m) {
                        out.push(Self::found(book, m, d));
                        next.push(m);
                        if out.len() >= 500 {
                            return Ok(out);
                        }
                    }
                }
            }
            frontier = next;
        }
        Ok(out)
    }

    /// What the agent reads first (spreadsheet-design §9.1): each sheet's extent and inputs, the
    /// model's outputs, values held as saved (add-ins, links), and the cycles.
    pub fn summary(&mut self, handle: u64) -> Result<String, String> {
        let doc = self.doc(handle)?;
        let book = &doc.book;
        let mut out = String::new();
        let calc = book.info.calc;
        out.push_str(&format!(
            "Iterative calculation: {}.\n",
            if calc.iterate { format!("on ({} rounds, {})", calc.iterate_count, calc.iterate_delta) } else { "off".into() }
        ));
        let names: Vec<String> = book.info.names.iter().filter(|n| !n.hidden && !n.name.starts_with("_xlnm.")).take(30).map(|n| format!("{} = {}", n.name, n.formula)).collect();
        if !names.is_empty() {
            out.push_str(&format!("Names: {}\n", names.join("; ")));
        }
        let engine = doc.engine.as_ref().ok();
        // Inputs: cells holding a number that a formula reads.
        let mut inputs: HashMap<usize, BTreeSet<CellRef>> = HashMap::new();
        if let Some(e) = engine {
            for areas in e.graph.areas.values() {
                for a in areas {
                    let Some(ix) = book.sheets.get(a.sheet).and_then(|s| s.index.as_ref()) else { continue };
                    for c in ix.cells().filter(|c| c.formula.is_none() && c.at.row >= a.first.row && c.at.row <= a.last.row && c.at.col >= a.first.col && c.at.col <= a.last.col) {
                        if matches!(book.value(a.sheet, c.at), Value::Number(_)) {
                            inputs.entry(a.sheet).or_default().insert(c.at);
                        }
                    }
                }
            }
        }
        for (s, sheet) in book.sheets.iter().enumerate() {
            match sheet.kind {
                SheetKind::Chartsheet => {
                    out.push_str(&format!("\n## {} (chart sheet)\n", sheet.name));
                    continue;
                }
                SheetKind::Other => continue,
                SheetKind::Worksheet => {}
            }
            let Some(ix) = &sheet.index else { continue };
            let mut cells = ix.cells().filter(|c| c.v.is_some() || c.formula.is_some() || c.inline.is_some()).map(|c| c.at);
            let used = cells.next().map(|f| cells.fold(Rect::single(f), |r, c| r.union(c)).to_string()).unwrap_or_else(|| "empty".into());
            out.push_str(&format!("\n## {} {used}: {} formulas", sheet.name, sheet.formulas.len()));
            if ix.protected {
                out.push_str(", protected");
            }
            out.push('\n');
            if let Some(cells) = inputs.get(&s) {
                let shown: Vec<String> = cells.iter().take(12).map(|c| {
                    let f = Self::found(book, (s, *c), 0);
                    format!("{}{} = {}", f.label.map(|l| format!("{l} ")).unwrap_or_default(), f.cell, f.text)
                }).collect();
                out.push_str(&format!("Inputs ({}): {}{}\n", cells.len(), shown.join("; "), if cells.len() > 12 { "; …" } else { "" }));
            }
        }
        if let Some(e) = engine {
            let outputs: Vec<Node> = e.graph.reads.keys().copied().filter(|n| e.graph.read_by.get(n).is_none_or(|r| r.is_empty())).collect::<BTreeSet<_>>().into_iter().collect();
            let labelled: Vec<String> = outputs.iter().map(|n| Self::found(book, *n, 0)).filter(|f| f.label.is_some()).take(15).map(|f| format!("{}!{} {} = {}", f.sheet, f.cell, f.label.unwrap(), f.text)).collect();
            if !labelled.is_empty() {
                out.push_str(&format!("\nOutputs (formulas nothing else reads, {} in all): {}\n", outputs.len(), labelled.join("; ")));
            }
            let held: Vec<String> = e.constants().iter().take(10).map(|n| Self::found(book, *n, 0)).map(|f| format!("{}!{} {}", f.sheet, f.cell, f.formula.unwrap_or_default())).collect();
            if !held.is_empty() {
                out.push_str(&format!("Held at their saved value (add-in functions or links to other files; Excel recomputes them): {}\n", held.join("; ")));
            }
            let cycles = e.graph.cycles(None);
            if !cycles.is_empty() {
                let cells: usize = cycles.iter().map(Vec::len).sum();
                let first: Vec<String> = cycles[0].iter().take(6).map(|n| format!("{}!{}", book.sheets[n.0].name, n.1)).collect();
                out.push_str(&format!("Circular references: {} cycles, {cells} cells, e.g. {}{}\n", cycles.len(), first.join(" → "), if calc.iterate { "" } else { " (iteration is off: Excel reports them as errors)" }));
            }
        } else if let Err(e) = &doc.engine {
            out.push_str(&format!("\nNo calculation here: {e}. Edits are written without their impact.\n"));
        }
        Ok(out)
    }
}

/// The ops as cell edits, checked against the workbook.
fn edits_of(book: &Book, ops: &[SheetOp]) -> Result<Vec<(Node, NewValue)>, String> {
    let sheet = |name: &str| -> Result<usize, String> {
        let s = book.sheet_index(name).ok_or_else(|| format!("no sheet named {name}"))?;
        if book.sheets[s].kind != SheetKind::Worksheet {
            return Err(format!("{REFUSED}{name} is a chart sheet"));
        }
        Ok(s)
    };
    let cell = |c: &str| CellRef::parse(c).ok_or_else(|| format!("not a cell: {c}"));
    let mut out = Vec::new();
    for op in ops {
        match op {
            SheetOp::SetValue { sheet: s, cell: c, value } => {
                let v = match value {
                    CellInput::Number(n) => NewValue::Number { value: *n },
                    CellInput::Bool(b) => NewValue::Bool { value: *b },
                    // Control characters other than tab and line feed are dropped (§5.3.2).
                    CellInput::Text(t) => NewValue::Text { value: t.chars().filter(|c| !c.is_control() || *c == '\t' || *c == '\n').collect() },
                };
                out.push(((sheet(s)?, cell(c)?), v));
            }
            SheetOp::SetFormula { sheet: s, cell: c, formula } => out.push(((sheet(s)?, cell(c)?), NewValue::Formula { text: formula.clone(), cached: None })),
            SheetOp::Clear { sheet: s, range } => {
                let s = sheet(s)?;
                let r = Rect::parse(range).ok_or_else(|| format!("not a range: {range}"))?;
                let Some(ix) = &book.sheets[s].index else { continue };
                let cells: Vec<CellRef> = ix.cells().map(|c| c.at).filter(|c| r.contains(*c)).filter(|c| book.value(s, *c) != Value::Empty || book.formula(s, *c).is_some()).collect();
                if cells.len() as u64 > MAX_CELLS {
                    return Err(format!("{range} holds {} cells; clear at most {MAX_CELLS} at a time", cells.len()));
                }
                out.extend(cells.into_iter().map(|c| ((s, c), NewValue::Empty)));
            }
        }
    }
    if out.is_empty() {
        return Err("nothing to change".into());
    }
    Ok(out)
}

/// Ops that put the edited cells back.
fn undo_of(book: &Book, edits: &[(Node, NewValue)]) -> Vec<SheetOp> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for ((s, at), _) in edits {
        if !seen.insert((*s, *at)) {
            continue;
        }
        let (sheet, cell) = (book.sheets[*s].name.clone(), at.to_string());
        out.push(match (book.formula(*s, *at), book.value(*s, *at)) {
            (Some(f), _) => SheetOp::SetFormula { sheet, cell, formula: format!("={}", display(f)) },
            (None, Value::Number(n)) => SheetOp::SetValue { sheet, cell, value: CellInput::Number(n) },
            (None, Value::Bool(b)) => SheetOp::SetValue { sheet, cell, value: CellInput::Bool(b) },
            (None, Value::Text(t)) => SheetOp::SetValue { sheet, cell, value: CellInput::Text(t) },
            (None, _) => SheetOp::Clear { sheet, range: cell },
        });
    }
    out
}

fn change(old: &Book, new: &Book, n: Node, before: &Value, after: &Value, label: bool) -> CellChange {
    let style = new.style(n.0, n.1);
    CellChange {
        sheet: new.sheets[n.0].name.clone(),
        cell: n.1.to_string(),
        before: protocol_value(before),
        after: protocol_value(after),
        before_text: old.display(before, &old.style(n.0, n.1)).0,
        after_text: new.display(after, &style).0,
        label: if label { new.label(n.0, n.1) } else { None },
    }
}

fn protocol_impact(
    old: &Book,
    new: &Book,
    edits: &[(Node, NewValue)],
    edited_before: Vec<Value>,
    impact: Option<&finx_sheet::calc::Impact>,
    engine: &Result<Engine, String>,
) -> Impact {
    let name = |n: &Node| format!("{}!{}", new.sheets[n.0].name, n.1);
    let Some(impact) = impact else {
        // No engine: the edited cells only, as written.
        let edited = edits.iter().zip(edited_before).map(|((n, _), b)| change(old, new, *n, &b, &new.value(n.0, n.1), false)).collect();
        return Impact { edited, converged: true, calc_unavailable: engine.as_ref().err().cloned(), ..Default::default() };
    };
    let changed: HashMap<Node, &finx_sheet::calc::Change> = impact.changed.iter().map(|c| (c.node, c)).collect();
    Impact {
        edited: impact.edited.iter().map(|c| change(old, new, c.node, &c.before, &c.after, false)).collect(),
        key_outputs: impact.key_outputs.iter().filter_map(|n| changed.get(n)).map(|c| change(old, new, c.node, &c.before, &c.after, true)).collect(),
        affected: impact.changed.iter().take(MAX_AFFECTED).map(|c| name(&c.node)).collect(),
        affected_count: impact.changed.len(),
        needs_excel: impact.needs_excel.iter().take(MAX_AFFECTED).map(name).collect(),
        iterations: impact.iterations,
        converged: impact.converged,
        calc_unavailable: None,
    }
}
