//! Pages of saved `.docx` bytes, drawn with the machine's own fonts (finx-slide's
//! `SystemFonts`, the faces PowerPoint decks use too).

use nimbleoffice_docx::fonts::FontSource;
use nimbleoffice_docx::{Document, OpenOptions, PngTarget, RenderOptions};
use finx_slide::SystemFonts;

use crate::{Result, WordError};

/// Scale for probing whether a page exists: the layout is the same, the pixmap tiny.
const PROBE_SCALE: f32 = 0.02;

pub(crate) fn open(bytes: &[u8]) -> Result<Document> {
    let options = OpenOptions {
        font_source: FontSource::Provider(SystemFonts::new()?),
        ..OpenOptions::default()
    };
    Ok(Document::open_with_options(bytes, &options)?)
}

/// Page `page` (from 1) of `docx` as PNG bytes; `scale` 1 is one pixel per CSS pixel.
pub fn render_page(docx: &[u8], page: u32, scale: f32) -> Result<Vec<u8>> {
    let document = open(docx)?;
    if page == 0 {
        return Err(WordError::NoPage(page));
    }
    draw(&document, page - 1, scale)?.ok_or(WordError::NoPage(page))
}

/// Pages `docx` lays out to.
pub fn page_count(docx: &[u8]) -> Result<u32> {
    count(&open(docx)?)
}

/// The engine does not report a page count, so pages are probed: doubling, then halving.
// TODO(engine): a page count from the layout, instead of one layout per probe.
pub(crate) fn count(document: &Document) -> Result<u32> {
    let exists = |ordinal: u32| draw(document, ordinal, PROBE_SCALE).map(|png| png.is_some());
    if !exists(0)? {
        return Ok(0);
    }
    // Page `known` - 1 exists; page `beyond` - 1 does not.
    let (mut known, mut beyond) = (1, 2);
    while exists(beyond - 1)? {
        known = beyond;
        beyond *= 2;
    }
    while beyond - known > 1 {
        let middle = (known + beyond) / 2;
        if exists(middle - 1)? {
            known = middle
        } else {
            beyond = middle
        }
    }
    Ok(known)
}

/// `None` past the last page.
fn draw(document: &Document, ordinal: u32, scale: f32) -> Result<Option<Vec<u8>>> {
    match document.render_png(
        PngTarget {
            page: ordinal as usize,
        },
        &RenderOptions { scale },
    ) {
        Ok(page) => Ok(Some(page.bytes)),
        Err(nimbleoffice_docx::Error::Render(message)) if message.contains("out of range") => {
            Ok(None)
        }
        Err(e) => Err(e.into()),
    }
}

/// What [`export_pdf`] writes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PdfRequest {
    /// Pages from 1, inclusive; every page when `None`.
    pub pages: Option<(u32, u32)>,
    /// With tracked changes and their marks; otherwise as if they were accepted.
    pub markup: bool,
    pub title: Option<String>,
}

/// A written PDF.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PdfExported {
    pub bytes: Vec<u8>,
    pub pages: usize,
    pub total_pages: usize,
    /// Fonts drawn as outlines (not selectable text) because their license forbids embedding.
    pub outlined_fonts: Vec<String>,
}

/// `docx` as a PDF, laid out and drawn as the pages are, with the machine's own fonts.
pub fn export_pdf(docx: &[u8], request: &PdfRequest) -> Result<PdfExported> {
    let document = open(docx)?;
    let pages = match request.pages {
        Some((from, to)) if from == 0 || to < from => {
            return Err(WordError::Engine(format!("no pages {from}-{to}")));
        }
        Some((from, to)) => Some(from as usize - 1..=to as usize - 1),
        None => None,
    };
    if let Some(range) = &pages {
        let total = count(&document)? as usize;
        if *range.start() >= total {
            return Err(WordError::Engine(format!("页码超出范围：文档共 {total} 页")));
        }
    }
    let export = document
        .render_pdf(&nimbleoffice_docx::PdfExportOptions {
            pages,
            markup: request.markup,
            title: request.title.clone(),
            ..Default::default()
        })
        .map_err(|e| match e {
            nimbleoffice_docx::Error::Render(message) => WordError::Engine(message),
            other => other.into(),
        })?;
    Ok(PdfExported {
        bytes: export.bytes,
        pages: export.pages,
        total_pages: export.total_pages,
        outlined_fonts: export.outlined_fonts,
    })
}
