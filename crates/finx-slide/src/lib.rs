//! PowerPoint decks on BetterOffice: render slides, read them as Markdown, find and replace
//! text, and save surgically, touching only the parts an edit changed.

pub mod check;
mod fonts;
pub mod outline;
mod parts;

use std::collections::BTreeSet;
use std::sync::Mutex;

use betteroffice_pptx::fonts::{FontError, FontSource};
use betteroffice_pptx::{
    EditCtx, FindRequest, OpenOptions, PngTarget, PptxExportOptions, Presentation, RenderOptions,
    TextStyle,
};

pub use betteroffice_pptx::FindMatch;
pub use fonts::SystemFonts;

/// Language PowerPoint would edit in: East Asian text with no language of its own is Chinese.
const EAST_ASIAN_LANGUAGE: &str = "zh-CN";
/// Author of FinxWork's edits.
const AUTHOR: &str = "FinxWork";
/// One CSS pixel in EMU, the unit slide sizes come in.
const EMU_PER_PX: f32 = 9525.0;
const PRESENTATION: &str = "ppt/presentation.xml";
const CONTENT_TYPES: &str = "[Content_Types].xml";
const MEDIA_DIR: &str = "ppt/media/";
const SLIDES_DIR: &str = "ppt/slides/";

#[derive(Debug, thiserror::Error)]
pub enum SlideError {
    #[error(transparent)]
    Engine(#[from] betteroffice_pptx::Error),
    #[error("fonts: {0}")]
    Fonts(#[from] FontError),
    #[error("refused: {0}")]
    Refused(String),
    #[error("no slide {0}")]
    NoSlide(usize),
    #[error("not a package: {0}")]
    Package(#[from] zip::result::ZipError),
    #[error("saving changed parts no edit touched: {}", .0.join(", "))]
    Unexpected(Vec<String>),
}

pub type Result<T> = std::result::Result<T, SlideError>;

pub struct Deck {
    presentation: Presentation,
    source: Vec<u8>,
    /// Every part of the source package.
    source_parts: BTreeSet<String>,
    /// The source's slide ids, in deck order.
    source_slide_ids: Vec<String>,
    /// Part paths of the slides an edit has touched.
    edited: Mutex<BTreeSet<String>>,
}

impl Deck {
    pub fn open(bytes: Vec<u8>) -> Result<Self> {
        let options = OpenOptions {
            font_source: FontSource::Provider(SystemFonts::new()?),
            ..OpenOptions::default()
        };
        let presentation = Presentation::open_with_options(&bytes, &options)?;
        presentation.set_default_east_asian_language(Some(EAST_ASIAN_LANGUAGE));
        let source_parts = parts::names(&bytes)?;
        let source_slide_ids = presentation.slide_ids()?;
        Ok(Self {
            presentation,
            source: bytes,
            source_parts,
            source_slide_ids,
            edited: Mutex::default(),
        })
    }

    /// Runs the implemented deterministic checks on the current in-memory snapshot.
    pub fn check(&self) -> Result<Vec<finx_protocol::deck::DeckDiagnostic>> {
        Ok(check::check(&self.presentation.snapshot()?))
    }

    /// Every slide's title, text, notes and objects, as the agent reads them.
    pub fn outline(&self) -> Result<outline::Outline> {
        Ok(outline::outline(&self.presentation.snapshot()?))
    }

    pub fn slide_count(&self) -> usize {
        self.presentation.slides().len()
    }

    /// Slide `slide` (0-based) as PNG bytes, `width_px` wide.
    pub fn render_png(&self, slide: usize, width_px: u32) -> Result<Vec<u8>> {
        if slide >= self.slide_count() {
            return Err(SlideError::NoSlide(slide));
        }
        let width_emu = self.presentation.snapshot()?.width_emu as f32;
        let options = RenderOptions {
            scale: width_px as f32 * EMU_PER_PX / width_emu,
            ..RenderOptions::default()
        };
        Ok(self
            .presentation
            .render_png(PngTarget { slide }, &options)?
            .bytes)
    }

    pub fn markdown(&self) -> Result<String> {
        let read = self
            .presentation
            .export_markdown(&PptxExportOptions::default())?
            .map_err(|refusal| SlideError::Refused(format!("{:?}", refusal.failure)))?;
        Ok(read.content.markdown)
    }

    /// Exact, case-sensitive matches, each within one paragraph.
    pub fn find_text(&self, text: &str) -> Result<Vec<FindMatch>> {
        let request = FindRequest {
            text: text.to_owned(),
            within: None,
            limit: None,
        };
        let found = self
            .presentation
            .find_text(&request)?
            .map_err(|refusal| SlideError::Refused(format!("{:?}", refusal.failure)))?;
        Ok(found.matches)
    }

    /// Replaces every match of `find` with `with`; returns how many it replaced. The new text
    /// takes the formatting of the text it replaces.
    pub fn replace_text(&self, find: &str, with: &str) -> Result<usize> {
        let mut matches = self.find_text(find)?;
        // From the end of each story back, so earlier offsets stay where they were.
        matches.sort_by(|a, b| {
            (&a.range.story_id, b.range.start).cmp(&(&b.range.story_id, a.range.start))
        });
        let slide_parts = self.slide_parts()?;
        let context = EditCtx::local(AUTHOR);
        let inserted = with.encode_utf16().count() as u32;
        for found in &matches {
            let range = &found.range;
            // Inserting first, at the match, lets the new text inherit the match's run.
            if inserted > 0 {
                self.presentation.insert_text(
                    &context,
                    &range.story_id,
                    range.start,
                    with,
                    &TextStyle::default(),
                )?;
            }
            self.presentation.delete_text(
                &context,
                &range.story_id,
                range.start + inserted,
                range.end + inserted,
            )?;
            if let Some((_, part)) = slide_parts.iter().find(|(id, _)| *id == range.slide_id) {
                self.edited
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(part.clone());
            }
        }
        Ok(matches.len())
    }

    /// Full Yrs state for a replica joining this document.
    pub fn encode_state(&self) -> Vec<u8> {
        self.presentation.encode_state_as_update_v1()
    }

    /// State vector for computing a replica's missing changes.
    pub fn state_vector(&self) -> Vec<u8> {
        self.presentation.encode_state_vector_v1()
    }

    /// Changes the replica does not yet have.
    pub fn encode_diff(&self, state_vector: &[u8]) -> Result<Vec<u8>> {
        Ok(self.presentation.encode_diff_v1(state_vector)?)
    }

    /// Apply a replica update. Slides it changes join the edited set; structural changes
    /// (slide list, new media) are judged by the save guard against the source.
    pub fn apply_update(&self, update: &[u8]) -> Result<()> {
        // Compare the in-memory model per slide id before and after instead of serializing
        // the package twice (K1). A slide whose snapshot changed counts as edited; the save
        // guard still checks the real bytes, so a change this misses fails safe at save.
        // TODO(engine): apply_update_touched — let the engine report touched slides itself.
        let before = self.presentation.snapshot().ok();
        let after = self.presentation.apply_update_v1(update)?;
        let touched: Vec<String> = match before {
            Some(before) => after
                .slides
                .iter()
                .filter(|slide| !before.slides.iter().any(|old| old == *slide))
                .filter_map(|slide| slide.source_part_path.as_deref())
                .map(|path| path.trim_start_matches('/').to_owned())
                .collect(),
            None => self
                .slide_parts()?
                .into_iter()
                .map(|(_, path)| path)
                .collect(),
        };
        self.edited
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend(touched);
        Ok(())
    }

    /// The deck with every edit applied. Before returning, the bytes are opened again and
    /// compared with the source part by part: every changed part must be in the intended
    /// change set ([`Deck::intended`]), otherwise nothing is returned.
    pub fn save(&self) -> Result<Vec<u8>> {
        let saved = self.presentation.save()?;
        Presentation::open(&saved)?;
        let intended = self.intended(&parts::names(&saved)?);
        let unexpected: Vec<String> = parts::changed(&self.source, &saved)?
            .into_iter()
            .filter(|part| !intended.contains(part))
            .collect();
        if !unexpected.is_empty() {
            return Err(SlideError::Unexpected(unexpected));
        }
        Ok(saved)
    }

    /// Parts the edits so far may change, opened capability by capability:
    /// - editing a slide: the slide and its relationships (a new picture adds one);
    /// - inserting, duplicating, deleting or moving slides: those slides and their
    ///   relationships, `presentation.xml` with its relationships, and the content types;
    /// - inserting a picture: the new media part (never an existing one) and the content types.
    fn intended(&self, saved_parts: &BTreeSet<String>) -> BTreeSet<String> {
        let mut intended = self
            .edited
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let edited_rels: Vec<String> = intended.iter().map(|part| parts::rels_of(part)).collect();
        intended.extend(edited_rels);

        // `slide_ids` follows merged updates; the parsed slide list does not, so new and
        // removed slide parts are read from the saved package.
        if self.presentation.slide_ids().ok().as_ref() != Some(&self.source_slide_ids) {
            let is_slide = |p: &&String| p.starts_with(SLIDES_DIR) && p.ends_with(".xml");
            let added = saved_parts
                .iter()
                .filter(is_slide)
                .filter(|p| !self.source_parts.contains(*p));
            let removed = self
                .source_parts
                .iter()
                .filter(is_slide)
                .filter(|p| !saved_parts.contains(*p));
            let slides: Vec<String> = added.chain(removed).cloned().collect();
            for slide in slides {
                intended.insert(parts::rels_of(&slide));
                intended.insert(slide);
            }
            intended.insert(PRESENTATION.to_owned());
            intended.insert(parts::rels_of(PRESENTATION));
            intended.insert(CONTENT_TYPES.to_owned());
        }

        let new_media: Vec<&String> = saved_parts
            .iter()
            .filter(|p| p.starts_with(MEDIA_DIR) && !self.source_parts.contains(*p))
            .collect();
        if !new_media.is_empty() {
            intended.extend(new_media.into_iter().cloned());
            intended.insert(CONTENT_TYPES.to_owned());
        }
        intended
    }

    /// Each slide's id with its part path, in deck order.
    fn slide_parts(&self) -> Result<Vec<(String, String)>> {
        let ids = self.presentation.slide_ids()?;
        Ok(ids
            .into_iter()
            .zip(slide_paths(&self.presentation))
            .collect())
    }
}

/// Slide part paths in deck order, without the leading `/`.
fn slide_paths(presentation: &Presentation) -> Vec<String> {
    presentation
        .slides()
        .iter()
        .map(|s| s.part_path.trim_start_matches('/').to_owned())
        .collect()
}
