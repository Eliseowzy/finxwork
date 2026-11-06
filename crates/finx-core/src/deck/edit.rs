//! `deck_edit` and `deck_save` (presentation-deck-edit §5): an agent's changes to a deck the
//! kernel holds, made as one proposal the user accepts or rejects, and saving the file.
//!
//! [`DeckOp`] is the agent's vocabulary. Each op becomes one engine `ProposalEdit`, resolved
//! against the deck as it is now: text is found by its words, not by offsets, and positions
//! are points. The batch is one proposal, or nothing when a step fails.

use std::fmt::Write as _;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use finx_docs::deck::{DeckEntry, DeckError, DeckStore};
use finx_slide::{DeckSnapshot, ShapeSnapshot, SlideSnapshot};
use finx_tools::{Environment, ToolCategory, ToolCtx, ToolDescription, ToolError, ToolKind, ToolOutput, TypedTool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{DecksHandle, GUIDELINES, file_name, pptx_path};

/// EMU in a point.
const EMU_PER_PT: f64 = 12_700.0;
/// Text shown of a shape whose words were not found.
const SHOWN: usize = 200;

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Align {
    Left,
    Center,
    Right,
    Justify,
}

impl Align {
    fn engine(self) -> &'static str {
        match self {
            Align::Left => "l",
            Align::Center => "ctr",
            Align::Right => "r",
            Align::Justify => "just",
        }
    }
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub(crate) struct Paragraph {
    pub text: String,
    /// A bulleted paragraph; default as the layout has it.
    #[serde(default)]
    pub bullet: Option<bool>,
    #[serde(default)]
    pub alignment: Option<Align>,
}

/// One change. Slides and objects are addressed by the slide_id and shape_id deck_read gives
/// (detail `objects`); positions and sizes are points from the slide's top left.
#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum DeckOp {
    /// Replace words in an object's text; `find` must occur exactly once in it, within one
    /// paragraph. The new words take the formatting of those they replace.
    ReplaceText { slide_id: String, shape_id: String, find: String, text: String },
    /// Replace all of an object's text with these paragraphs.
    SetParagraphs { slide_id: String, shape_id: String, paragraphs: Vec<Paragraph> },
    /// Format words of an object's text (`find`, once), or all of it.
    FormatText {
        slide_id: String,
        shape_id: String,
        #[serde(default)]
        find: Option<String>,
        #[serde(default)]
        bold: Option<bool>,
        #[serde(default)]
        italic: Option<bool>,
        #[serde(default)]
        underline: Option<bool>,
        #[serde(default)]
        size_pt: Option<f64>,
        /// `#RRGGBB`.
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        font: Option<String>,
    },
    /// Align the paragraphs holding `find`, or all of the object's.
    SetAlignment {
        slide_id: String,
        shape_id: String,
        #[serde(default)]
        find: Option<String>,
        alignment: Align,
    },
    /// A new text box.
    AddTextBox {
        slide_id: String,
        text: String,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        size_pt: Option<f64>,
        #[serde(default)]
        bold: Option<bool>,
        #[serde(default)]
        color: Option<String>,
    },
    RemoveShape { slide_id: String, shape_id: String },
    /// Move or resize an object.
    SetShapeRect { slide_id: String, shape_id: String, x: f64, y: f64, width: f64, height: f64 },
    /// A new, empty slide after `after_slide_id` (first when omitted), with a layout another
    /// slide of the deck uses (its name, as deck_read shows it), or the one of the slide before.
    InsertSlide {
        #[serde(default)]
        after_slide_id: Option<String>,
        #[serde(default)]
        layout: Option<String>,
    },
    /// A copy of a slide, right after it or after `after_slide_id`.
    DuplicateSlide {
        slide_id: String,
        #[serde(default)]
        after_slide_id: Option<String>,
    },
    DeleteSlide { slide_id: String },
    /// Move a slide after `after_slide_id`, or to the start when omitted.
    MoveSlide {
        slide_id: String,
        #[serde(default)]
        after_slide_id: Option<String>,
    },
    /// Give a slide the layout another slide of the deck uses (its name, as deck_read shows it).
    SetSlideLayout { slide_id: String, layout: String },
    /// Replace a slide's speaker notes.
    SetNotes { slide_id: String, text: String },
}

/// The engine's edits (JSON) for `ops` on `deck`; an error names the step, from 1. Words are
/// found in the deck as it is before the batch; the engine applies the steps in order, so the
/// ranges of later steps in a text an earlier one replaced into are moved along.
pub(crate) fn engine_edits(ops: &[DeckOp], deck: &DeckSnapshot) -> Result<Vec<Value>, String> {
    let mut texts = Texts::default();
    ops.iter().enumerate().map(|(i, op)| engine_edit(op, deck, &mut texts).map_err(|e| format!("step {}: {e}", i + 1))).collect()
}

/// What earlier steps of a batch did to texts.
#[derive(Default)]
struct Texts {
    /// Per story: (start, end) replaced, by text this long, in the story before the batch.
    replaced: Vec<(String, u32, u32, u32)>,
    /// Stories set whole (set_paragraphs).
    rewritten: Vec<String>,
}

impl Texts {
    /// `start..end` of the story before the batch, where it is after the earlier steps.
    /// `whole`: the range is all of the story, and grows or shrinks with it.
    fn place(&self, story: &str, start: u32, end: u32, whole: bool) -> Result<(u32, u32), String> {
        if self.rewritten.iter().any(|s| s == story) {
            return Err("an earlier step set all of this text (OverlappingSteps): put the change in that set_paragraphs".into());
        }
        let (mut s, mut e) = (start as i64, end as i64);
        for (_, ps, pe, len) in self.replaced.iter().filter(|r| r.0 == story) {
            let delta = *len as i64 - (*pe as i64 - *ps as i64);
            if whole {
                e += delta;
            } else if *pe <= start {
                s += delta;
                e += delta;
            } else if *ps < end {
                return Err("an earlier step changes the same words (OverlappingSteps): combine the two".into());
            }
        }
        Ok((s.max(0) as u32, e.max(0) as u32))
    }
}

fn engine_edit(op: &DeckOp, deck: &DeckSnapshot, texts: &mut Texts) -> Result<Value, String> {
    let emu = |pt: f64| (pt * EMU_PER_PT).round() as i64;
    let rect = |x: f64, y: f64, w: f64, h: f64| json!({ "x": emu(x), "y": emu(y), "width": emu(w), "height": emu(h) });
    Ok(match op {
        DeckOp::ReplaceText { slide_id, shape_id, find, text } => {
            let (story, start, end) = locate(shape(deck, slide_id, shape_id)?, find)?;
            let (at, to) = texts.place(&story, start, end, false)?;
            texts.replaced.push((story.clone(), start, end, utf16(text)));
            json!({ "type": "replaceText", "storyId": story, "start": at, "end": to, "text": text })
        }
        DeckOp::SetParagraphs { slide_id, shape_id, paragraphs } => {
            let story = first_story(shape(deck, slide_id, shape_id)?)?;
            let paragraphs: Vec<Value> = paragraphs
                .iter()
                .map(|p| {
                    let mut v = json!({ "alignment": p.alignment.map(Align::engine), "runs": [{ "text": p.text }] });
                    if let Some(b) = p.bullet {
                        v["bullet"] = json!(b);
                    }
                    v
                })
                .collect();
            texts.place(&story.id, 0, 0, true)?;
            texts.rewritten.push(story.id.clone());
            json!({ "type": "setStoryParagraphs", "storyId": story.id, "paragraphs": paragraphs })
        }
        DeckOp::FormatText { slide_id, shape_id, find, bold, italic, underline, size_pt, color, font } => {
            let (story, start, end) = range(shape(deck, slide_id, shape_id)?, find.as_deref())?;
            let (start, end) = texts.place(&story, start, end, find.is_none())?;
            let patch = json!({
                "bold": bold, "italic": italic, "fontSizePt": size_pt, "color": color, "fontFamily": font,
                "underline": underline.map(|u| if u { "sng" } else { "none" }),
            });
            json!({ "type": "formatText", "storyId": story, "start": start, "end": end, "patch": patch })
        }
        DeckOp::SetAlignment { slide_id, shape_id, find, alignment } => {
            let (story, start, end) = range(shape(deck, slide_id, shape_id)?, find.as_deref())?;
            let (start, end) = texts.place(&story, start, end, find.is_none())?;
            json!({ "type": "setParagraphAlignment", "storyId": story, "start": start, "end": end, "alignment": alignment.engine() })
        }
        DeckOp::AddTextBox { slide_id, text, x, y, width, height, name, size_pt, bold, color } => {
            slide(deck, slide_id)?;
            let style = json!({ "bold": bold, "italic": null, "fontSizePt": size_pt, "color": color, "fontFamily": null, "underline": null });
            let draft = json!({ "name": name.clone().unwrap_or_else(|| "Text Box".into()), "rect": rect(*x, *y, *width, *height), "text": text, "style": style });
            json!({ "type": "addTextBox", "slideId": slide_id, "draft": draft })
        }
        DeckOp::RemoveShape { slide_id, shape_id } => {
            shape(deck, slide_id, shape_id)?;
            json!({ "type": "removeShape", "slideId": slide_id, "shapeId": shape_id })
        }
        DeckOp::SetShapeRect { slide_id, shape_id, x, y, width, height } => {
            shape(deck, slide_id, shape_id)?;
            if *width <= 0.0 || *height <= 0.0 {
                return Err("width and height must be more than 0".into());
            }
            json!({ "type": "setShapeRect", "slideId": slide_id, "shapeId": shape_id, "rect": rect(*x, *y, *width, *height) })
        }
        DeckOp::InsertSlide { after_slide_id, layout } => {
            let after = after_slide_id.as_deref().map(|id| slide(deck, id)).transpose()?;
            let layout = match layout {
                Some(name) => Some(layout_path(deck, name)?),
                None => after.and_then(|s| s.layout_part_path.clone()),
            };
            let mut v = json!({ "type": "insertSlide", "afterSlideId": after_slide_id });
            if let Some(path) = layout {
                v["layoutPartPath"] = json!(path);
            }
            v
        }
        DeckOp::DuplicateSlide { slide_id, after_slide_id } => {
            slide(deck, slide_id)?;
            let mut v = json!({ "type": "duplicateSlide", "slideId": slide_id });
            if let Some(after) = after_slide_id {
                slide(deck, after)?;
                v["afterSlideId"] = json!(after);
            }
            v
        }
        DeckOp::DeleteSlide { slide_id } => {
            slide(deck, slide_id)?;
            json!({ "type": "deleteSlide", "slideId": slide_id })
        }
        DeckOp::MoveSlide { slide_id, after_slide_id } => {
            slide(deck, slide_id)?;
            if let Some(after) = after_slide_id {
                slide(deck, after)?;
            }
            json!({ "type": "moveSlide", "slideId": slide_id, "afterSlideId": after_slide_id })
        }
        DeckOp::SetSlideLayout { slide_id, layout } => {
            slide(deck, slide_id)?;
            json!({ "type": "setSlideLayout", "slideId": slide_id, "layoutPartPath": layout_path(deck, layout)? })
        }
        DeckOp::SetNotes { slide_id, text } => {
            slide(deck, slide_id)?;
            json!({ "type": "setSlideNotes", "slideId": slide_id, "text": text })
        }
    })
}

fn slide<'a>(deck: &'a DeckSnapshot, id: &str) -> Result<&'a SlideSnapshot, String> {
    deck.slides.iter().find(|s| s.id == id).ok_or_else(|| format!("no slide {id} (MissingTarget): read the deck again for its slide_ids"))
}

fn shape<'a>(deck: &'a DeckSnapshot, slide_id: &str, id: &str) -> Result<&'a ShapeSnapshot, String> {
    fn find<'a>(shapes: &'a [ShapeSnapshot], id: &str) -> Option<&'a ShapeSnapshot> {
        shapes.iter().find_map(|s| if s.id == id { Some(s) } else { find(&s.children, id) })
    }
    find(&slide(deck, slide_id)?.shapes, id).ok_or_else(|| format!("no object {id} on slide {slide_id} (MissingTarget): deck_read it with detail objects"))
}

fn first_story(shape: &ShapeSnapshot) -> Result<&finx_slide::StorySnapshot, String> {
    shape.text_stories.first().ok_or_else(|| format!("object {} holds no text (Unsupported)", shape.id))
}

fn utf16(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// The one place `find` occurs in the shape's text: story, start and end. Offsets count UTF-16
/// units, each paragraph end as one.
fn locate(shape: &ShapeSnapshot, find: &str) -> Result<(String, u32, u32), String> {
    if find.is_empty() {
        return Err("find is empty".into());
    }
    let mut found = Vec::new();
    for story in &shape.text_stories {
        let mut base = 0;
        for paragraph in &story.paragraphs {
            let text: String = paragraph.runs.iter().map(|r| r.text.as_str()).collect();
            for (at, _) in text.match_indices(find) {
                let start = base + utf16(&text[..at]);
                found.push((story.id.clone(), start, start + utf16(find)));
            }
            base += utf16(&text) + 1;
        }
    }
    match found.len() {
        1 => Ok(found.remove(0)),
        0 => {
            let holds: String = shape.text_stories.iter().map(|s| s.plain_text()).collect::<Vec<_>>().join("\n").chars().take(SHOWN).collect();
            Err(format!("\"{find}\" is not in object {} (ContentMismatch); it holds: \"{holds}\"", shape.id))
        }
        n => Err(format!("\"{find}\" occurs {n} times in object {} (AmbiguousTarget): give more of the text", shape.id)),
    }
}

/// Where `find` is, or all of the shape's first story.
fn range(shape: &ShapeSnapshot, find: Option<&str>) -> Result<(String, u32, u32), String> {
    match find {
        Some(find) => locate(shape, find),
        None => {
            let story = first_story(shape)?;
            Ok((story.id.clone(), 0, utf16(&story.plain_text())))
        }
    }
}

/// The part path of a layout another slide uses, by its name or type (or the path itself).
fn layout_path(deck: &DeckSnapshot, name: &str) -> Result<String, String> {
    let wanted = name.trim().to_lowercase();
    let mut known = Vec::new();
    for s in &deck.slides {
        let Some(path) = &s.layout_part_path else { continue };
        let names = s.layout.as_ref().map(|l| [l.name.clone(), l.r#type.clone()]).unwrap_or_default();
        if path.trim_start_matches('/') == wanted.trim_start_matches('/') || names.iter().flatten().any(|n| n.to_lowercase() == wanted) {
            return Ok(path.clone());
        }
        known.extend(names.into_iter().flatten());
    }
    known.sort();
    known.dedup();
    Err(format!("no slide uses a layout \"{name}\" (Unsupported); the deck's slides use: {}", known.join(", ")))
}

fn handle(ctx: &ToolCtx) -> Result<Arc<DecksHandle>, ToolError> {
    ctx.session_state.get::<DecksHandle>().ok_or_else(|| ToolError::Failed("presentations cannot be changed in this session".into()))
}

/// The kernel's entry of the deck at `path`, held by the session: joined when the editor (or
/// another session) has it open, so the deck, and the proposals pending on it, outlive the editor
/// closing. Without this hold an accept from the conversation card finds the deck gone.
async fn entry(decks: &DecksHandle, path: &Path) -> Result<Arc<DeckEntry>, ToolError> {
    let opened = decks.store.open(path, &decks.session, false).await.map_err(|e| failed(path, e))?;
    Ok(opened.entry)
}

fn failed(path: &Path, e: DeckError) -> ToolError {
    ToolError::Failed(format!("{}: {e}", file_name(path)))
}

fn location(args: &Value, env: &dyn Environment, verb: &str) -> ToolDescription {
    let mut d = super::describe(args, env, verb);
    d.category = ToolCategory::Edit;
    d
}

// ---- deck_edit ----

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct EditArgs {
    /// Path of the presentation (.pptx).
    deck: String,
    /// The changes, proposed together as one change the user accepts or rejects. At most 256.
    edits: Vec<DeckOp>,
    /// What the changes do, in the user's words ("按 Q3 财报更新第 3 页的营收"); shown with the proposal.
    #[serde(default)]
    note: Option<String>,
}

pub(crate) struct DeckEdit;

#[async_trait]
impl TypedTool for DeckEdit {
    type Args = EditArgs;
    const NAME: &'static str = "deck_edit";
    const DESCRIPTION: &'static str = "Propose changes to a presentation (.pptx): replace or format words, set an object's \
        paragraphs or alignment, add a text box, move, resize or remove an object, insert, duplicate, delete or move slides, \
        change a slide's layout or its speaker notes. All of them become one proposal the user sees beside the deck and \
        accepts or rejects; nothing changes until they accept, and until then deck_read shows the deck as it was. When the \
        session runs edits without asking (full access or accepted edits), the change is made at once instead. If a step \
        cannot be done, nothing is proposed and the error names the step and why (MissingTarget, ContentMismatch, \
        AmbiguousTarget, Unsupported). Returns the proposal and the slides it changes, with any layout problems they would have.";

    fn guidelines(&self) -> &[&'static str] {
        GUIDELINES
    }

    fn kind(&self) -> ToolKind {
        ToolKind::Mutating
    }

    fn describe(&self, args: &Value, env: &dyn Environment) -> ToolDescription {
        let mut d = location(args, env, "edit");
        let n = args.get("edits").and_then(Value::as_array).map_or(0, Vec::len);
        d.title = format!("{} ({n} change{})", d.title, if n == 1 { "" } else { "s" });
        d
    }

    async fn run(&self, args: EditArgs, ctx: ToolCtx) -> Result<ToolOutput, ToolError> {
        if args.edits.is_empty() {
            return Err(ToolError::InvalidArgs("edits is empty".into()));
        }
        if args.edits.len() > 256 {
            return Err(ToolError::InvalidArgs("at most 256 edits in one proposal".into()));
        }
        let decks = handle(&ctx)?;
        let path = pptx_path(&args.deck, ctx.env.as_ref())?;
        let entry = entry(&decks, &path).await?;
        let store: &DeckStore = &decks.store;
        let snapshot = store.snapshot(&entry.deck_id).await.map_err(|e| failed(&path, e))?;
        let edits = engine_edits(&args.edits, &snapshot).map_err(|e| ToolError::Failed(format!("Nothing was proposed: {e}")))?;
        let agent = format!("finx:{}", decks.session);
        let proposed = match store.propose(&entry.deck_id, &agent, args.note.clone(), Value::Array(edits)).await {
            Ok(p) => p,
            // The engine counts steps from 0.
            Err(DeckError::Refused(m)) => return Err(ToolError::Failed(format!("Nothing was proposed: {}", from_one(&m)))),
            Err(e) => return Err(failed(&path, e)),
        };
        let changed: Vec<_> = proposed.strip.iter().filter(|s| s.status != "unchanged").collect();
        let diagnostics = store.check(&entry.deck_id, Some(&proposed.proposal_id)).await.unwrap_or_default();
        // Full access or accepted edits: the change is made now, as doc_edit's is; no card asks for it.
        let mut revision = proposed.changed.revision;
        let applied = if decks.applies_at_once() {
            let accepted = store.accept(&entry.deck_id, &proposed.proposal_id, false).await.map_err(|e| failed(&path, e))?;
            revision = accepted.changed.revision;
            accepted.applied
        } else {
            false
        };
        let (n, s, name) = (changed.len(), if changed.len() == 1 { "" } else { "s" }, file_name(&path));
        let mut text = if applied {
            format!("Made the change ({n} slide{s} of {name}): the session runs edits without asking, so it was applied at once. It is not in the file until deck_save writes it.\n")
        } else {
            format!("Proposed to the user as one change ({n} slide{s} of {name}); it takes effect only when they accept it, and until then the deck reads as it was.\n")
        };
        if let Some(note) = &args.note {
            let _ = writeln!(text, "Note: {note}");
        }
        for s in &changed {
            let _ = writeln!(text, "- slide {}: {}", s.index + 1, s.status);
        }
        let problems: Vec<_> = diagnostics.iter().filter(|d| changed.iter().any(|s| s.slide_id == d.slide_id)).collect();
        if !problems.is_empty() {
            let _ = writeln!(text, "{}", if applied { "Layout problems the changed slides have:" } else { "Layout problems the changed slides would have:" });
            for d in problems {
                let _ = writeln!(text, "- slide {}: {} [{}]", d.index, d.message, d.rule);
            }
        }
        let details = json!({
            "deck_id": entry.deck_id,
            "path": path,
            "proposal_id": proposed.proposal_id,
            "revision": revision,
            "applied": applied,
            "slides": changed.iter().map(|s| json!({ "index": s.index, "slide_id": s.slide_id, "status": s.status })).collect::<Vec<_>>(),
        });
        Ok(ToolOutput::text(text).with_details(details))
    }
}

/// "edit 1: …" from the engine, whose steps count from 0, as "step 2: …".
fn from_one(message: &str) -> String {
    message
        .strip_prefix("edit ")
        .and_then(|rest| rest.split_once(": "))
        .and_then(|(n, why)| n.parse::<usize>().ok().map(|n| format!("step {}: {why}", n + 1)))
        .unwrap_or_else(|| message.to_owned())
}

// ---- deck_save ----

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct SaveArgs {
    /// Path of the presentation (.pptx).
    deck: String,
    /// Save as another .pptx instead (absolute, or relative to the working directory).
    #[serde(default)]
    path: Option<String>,
    /// Write over the file although it changed on disk since it was opened. Only when the user said so.
    #[serde(default)]
    force: bool,
}

pub(crate) struct DeckSave;

#[async_trait]
impl TypedTool for DeckSave {
    type Args = SaveArgs;
    const NAME: &'static str = "deck_save";
    const DESCRIPTION: &'static str = "Write a presentation's accepted changes and the user's unsaved edits to its file (or, \
        with `path`, to another .pptx). Only the slides that changed are rewritten; the rest of the file stays byte for byte. \
        Proposals not yet accepted are not saved.";

    fn guidelines(&self) -> &[&'static str] {
        GUIDELINES
    }

    fn kind(&self) -> ToolKind {
        ToolKind::Mutating
    }

    fn describe(&self, args: &Value, env: &dyn Environment) -> ToolDescription {
        let mut d = location(args, env, "save");
        if let Some(p) = args.get("path").and_then(Value::as_str) {
            d.title = format!("{} as {p}", d.title);
            d.locations = vec![(env.resolve(p), None)];
        }
        d
    }

    async fn run(&self, args: SaveArgs, ctx: ToolCtx) -> Result<ToolOutput, ToolError> {
        let decks = handle(&ctx)?;
        let path = pptx_path(&args.deck, ctx.env.as_ref())?;
        let entry = entry(&decks, &path).await?;
        let to = args.path.as_deref().map(|p| ctx.env.resolve(p));
        let unsaved = entry.info().dirty;
        let info = decks.store.save(&entry.deck_id, to.as_deref(), args.force).await.map_err(|e| failed(&path, e))?;
        let target = to.clone().unwrap_or_else(|| info.path.clone());
        let pending = decks.store.proposals(&entry.deck_id).await.map(|r| r.proposals.iter().filter(|p| p.status == finx_protocol::deck::DeckProposalState::Pending).count()).unwrap_or(0);
        let mut text = if to.is_none() && !unsaved { format!("{} has nothing unsaved; the file is as it was.", file_name(&target)) } else { format!("Saved {}.", target.display()) };
        if pending > 0 {
            let _ = write!(text, " {pending} proposal{} not yet accepted {} not in the file.", if pending == 1 { "" } else { "s" }, if pending == 1 { "is" } else { "are" });
        }
        Ok(ToolOutput::text(text).with_details(json!({ "deck_id": info.deck_id, "path": target, "revision": info.revision, "pending_proposals": pending })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deck() -> DeckSnapshot {
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../finx-slide/tests/fixtures/editor.pptx")).unwrap();
        finx_slide::Deck::open(bytes).unwrap().snapshot().unwrap()
    }

    fn op(v: Value) -> DeckOp {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn words_are_found_once_and_offsets_count_utf16() {
        let deck = deck();
        let s = &deck.slides[0];
        let shape = s.shapes.iter().find(|x| x.text_stories.first().is_some_and(|t| t.plain_text() == "Quarterly review")).unwrap();
        let ops = [op(json!({ "op": "replace_text", "slide_id": s.id, "shape_id": shape.id, "find": "review", "text": "回顾" }))];
        let edits = engine_edits(&ops, &deck).unwrap();
        assert_eq!(edits[0]["type"], "replaceText");
        assert_eq!((edits[0]["start"].as_u64(), edits[0]["end"].as_u64()), (Some(10), Some(16)));
        let missing = [op(json!({ "op": "replace_text", "slide_id": s.id, "shape_id": shape.id, "find": "annual", "text": "x" }))];
        let e = engine_edits(&missing, &deck).unwrap_err();
        assert!(e.starts_with("step 1: ") && e.contains("ContentMismatch") && e.contains("Quarterly review"), "{e}");
        let ambiguous = [op(json!({ "op": "format_text", "slide_id": s.id, "shape_id": shape.id, "find": "r", "bold": true }))];
        assert!(engine_edits(&ambiguous, &deck).unwrap_err().contains("AmbiguousTarget"));
    }

    #[test]
    fn every_op_maps_to_an_edit_the_engine_takes() {
        let deck = deck();
        let (s, t) = (&deck.slides[0], &deck.slides[1]);
        let shape = &s.shapes.iter().find(|x| !x.text_stories.is_empty()).unwrap().id;
        let layout = s.layout.as_ref().and_then(|l| l.name.clone().or(l.r#type.clone()));
        let mut ops = vec![
            json!({ "op": "replace_text", "slide_id": s.id, "shape_id": shape, "find": "Quarterly", "text": "Annual" }),
            json!({ "op": "set_paragraphs", "slide_id": t.id, "shape_id": t.shapes.iter().find(|x| !x.text_stories.is_empty()).unwrap().id, "paragraphs": [{ "text": "One", "alignment": "center" }, { "text": "Two", "bullet": true }] }),
            json!({ "op": "format_text", "slide_id": s.id, "shape_id": shape, "bold": false, "underline": true, "size_pt": 30 }),
            json!({ "op": "set_alignment", "slide_id": s.id, "shape_id": shape, "alignment": "right" }),
            json!({ "op": "add_text_box", "slide_id": s.id, "text": "Hi", "x": 10, "y": 10, "width": 100, "height": 30 }),
            json!({ "op": "set_shape_rect", "slide_id": s.id, "shape_id": shape, "x": 20, "y": 20, "width": 300, "height": 60 }),
            json!({ "op": "set_notes", "slide_id": s.id, "text": "Say hello" }),
            json!({ "op": "insert_slide", "after_slide_id": s.id }),
            json!({ "op": "duplicate_slide", "slide_id": t.id }),
            json!({ "op": "move_slide", "slide_id": t.id }),
        ];
        if let Some(layout) = layout {
            ops.push(json!({ "op": "set_slide_layout", "slide_id": t.id, "layout": layout }));
        }
        let ops: Vec<DeckOp> = ops.into_iter().map(op).collect();
        let edits = engine_edits(&ops, &deck).unwrap();
        let engine: Vec<finx_slide::ProposalEdit> = serde_json::from_value(Value::Array(edits)).unwrap();
        let fixture = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../finx-slide/tests/fixtures/editor.pptx")).unwrap();
        let live = finx_slide::Deck::open(fixture.clone()).unwrap();
        let request = finx_slide::ProposalRequest { agent_id: "t".into(), note: None, edits: engine };
        let (proposal, _) = live.propose(request).unwrap();
        assert!(live.accept_proposal(&proposal.id, false).unwrap().applied);
        assert_eq!(live.find_text("Annual review").unwrap().len(), 1);
        if let Err(e) = live.save() { panic!("{e}") }
        // The removals, on their own (they would clash with the edits above).
        let ops = [op(json!({ "op": "remove_shape", "slide_id": s.id, "shape_id": shape })), op(json!({ "op": "delete_slide", "slide_id": t.id }))];
        let engine: Vec<finx_slide::ProposalEdit> = serde_json::from_value(Value::Array(engine_edits(&ops, &deck).unwrap())).unwrap();
        finx_slide::Deck::open(fixture).unwrap().propose(finx_slide::ProposalRequest { agent_id: "t".into(), note: None, edits: engine }).unwrap();
        assert!(engine_edits(&[op(json!({ "op": "delete_slide", "slide_id": "nope" }))], &deck).unwrap_err().contains("MissingTarget"));
    }

    #[test]
    fn engine_steps_are_told_from_one() {
        assert_eq!(from_one("edit 1: shape \"x\" was not found"), "step 2: shape \"x\" was not found");
        assert_eq!(from_one("64 proposals are already pending"), "64 proposals are already pending");
    }
}
