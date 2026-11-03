//! DocStore (design §5.2): one per service, one entry per file, shared by every session that
//! opened it. A document's directory is `<docs>/<doc_id>/`: `base.pdf` (the file as opened),
//! `current.pdf` (the working copy) and `meta.json`. Sessions only keep what they look at.
//!
//! Phase one only reads: the working copy is the file as last opened, and opening a file that
//! changed on disk takes the new contents.

use finx_protocol::doc::Anchor;
use finx_protocol::doc::Capability;
use finx_protocol::doc::DocFormat;
use finx_protocol::doc::DocInfo;
use finx_protocol::doc::DocLayout;
use finx_protocol::doc::DocViewing;
use finx_protocol::doc::Rect;
use finx_protocol::doc::TextBlock;
use parking_lot::Mutex;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use crate::engine::Opened;
use crate::engine::Rendered;
use crate::engine::Request;
use crate::layout;
use crate::layout::PageChars;
use crate::worker::Launcher;
use crate::worker::Worker;
use crate::worker::WorkerError;

/// The largest file opened (design §11).
pub const MAX_FILE_BYTES: u64 = 1 << 30;
/// Images for the agent: never more than this on the longer side.
pub const MAX_RENDER_SIDE: u32 = 2000;

#[derive(Debug, thiserror::Error)]
pub enum DocError {
    #[error("{0}: no such file")]
    NotFound(String),
    #[error("{0} is not a PDF")]
    NotPdf(String),
    #[error("{0} is larger than 1 GB")]
    TooLarge(String),
    #[error("the document is encrypted: the password is missing or wrong")]
    Password,
    #[error("{0}: cannot open it as a PDF: {1}")]
    Unreadable(String, String),
    #[error("no open document {0}: open it first")]
    NotOpen(String),
    #[error("no page {page}: the document has {pages}")]
    NoPage { page: u32, pages: u32 },
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Worker(#[from] WorkerError),
}

/// A page's text: PDFium's characters and the blocks made of them.
pub struct PageText {
    pub chars: PageChars,
    pub blocks: Vec<TextBlock>,
}

/// A hit of a search, with a little text around it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Hit {
    pub anchor: Anchor,
    pub block: Option<String>,
    pub context: String,
}

/// What a session's column shows of a document.
#[derive(Clone, Debug, Default)]
struct View {
    page: u32,
    selection: Option<Anchor>,
    token: String,
}

pub struct Doc {
    pub id: String,
    pub path: PathBuf,
    dir: PathBuf,
    handle: u64,
    /// The password it was opened with, in memory only: the pages of every session need it.
    password: Option<String>,
    info: Mutex<DocInfo>,
    pages: Mutex<HashMap<u32, Arc<PageText>>>,
    /// The sessions that have it open, and what each shows.
    views: Mutex<HashMap<String, View>>,
}

impl Doc {
    pub fn info(&self) -> DocInfo {
        self.info.lock().clone()
    }

    pub fn password(&self) -> Option<&str> {
        self.password.as_deref()
    }

    pub fn pages(&self) -> u32 {
        self.info.lock().pages.unwrap_or(0)
    }

    /// The working copy.
    pub fn current(&self) -> PathBuf {
        self.dir.join("current.pdf")
    }

    fn check_page(&self, page: u32) -> Result<(), DocError> {
        let pages = self.pages();
        if page == 0 || page > pages {
            return Err(DocError::NoPage { page, pages });
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
struct Meta {
    path: PathBuf,
    size: u64,
    modified_ms: u128,
}

pub struct DocStore {
    root: PathBuf,
    worker: Worker,
    docs: Mutex<HashMap<String, Arc<Doc>>>,
    /// One open at a time: two sessions opening the same file get the same entry.
    opening: tokio::sync::Mutex<()>,
}

/// A document's id: from its canonical path, the same in every session and every run.
pub fn doc_id(canonical: &Path) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, canonical.as_os_str().as_encoded_bytes());
    digest.as_ref()[..8].iter().map(|b| format!("{b:02x}")).collect()
}

impl DocStore {
    /// A store keeping its documents in `root` (`$FINX_HOME/docs`). Tokens of an earlier run are
    /// dropped: no page holds them any more.
    pub fn new(root: PathBuf, launcher: Launcher) -> Self {
        let _ = std::fs::remove_dir_all(root.join(".tokens"));
        Self { root, worker: Worker::new(launcher), docs: Mutex::default(), opening: tokio::sync::Mutex::new(()) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn get(&self, doc_id: &str) -> Result<Arc<Doc>, DocError> {
        self.docs.lock().get(doc_id).cloned().ok_or_else(|| DocError::NotOpen(doc_id.to_string()))
    }

    /// The open document of a file, if any.
    pub fn by_path(&self, path: &Path) -> Option<Arc<Doc>> {
        let canonical = std::fs::canonicalize(path).ok()?;
        self.docs.lock().get(&doc_id(&canonical)).cloned()
    }

    /// The file a document id was opened from, as its directory remembers it.
    pub fn path_of(&self, doc_id: &str) -> Result<PathBuf, DocError> {
        if !doc_id.chars().all(|c| c.is_ascii_hexdigit()) || doc_id.is_empty() {
            return Err(DocError::NotOpen(doc_id.to_string()));
        }
        if let Ok(doc) = self.get(doc_id) {
            return Ok(doc.path.clone());
        }
        let text = std::fs::read_to_string(self.root.join(doc_id).join("meta.json")).map_err(|_| DocError::NotOpen(doc_id.to_string()))?;
        let meta: Meta = serde_json::from_str(&text).map_err(|_| DocError::NotOpen(doc_id.to_string()))?;
        Ok(meta.path)
    }

    /// Opens a file for a session, or joins the entry another session opened (§6 `doc/open`).
    /// Returns the document and the session's token for its bytes.
    pub async fn open(&self, path: &Path, password: Option<String>, session: &str) -> Result<(Arc<Doc>, String), DocError> {
        let _one = self.opening.lock().await;
        let canonical = std::fs::canonicalize(path).map_err(|_| DocError::NotFound(path.display().to_string()))?;
        let meta = std::fs::metadata(&canonical)?;
        if !meta.is_file() {
            return Err(DocError::NotFound(path.display().to_string()));
        }
        if meta.len() > MAX_FILE_BYTES {
            return Err(DocError::TooLarge(path.display().to_string()));
        }
        let id = doc_id(&canonical);
        let stamp = Meta { path: canonical.clone(), size: meta.len(), modified_ms: modified_ms(&meta) };
        let existing = self.docs.lock().get(&id).cloned();
        let doc = match existing {
            Some(doc) if self.unchanged(&doc.dir, &stamp) => doc,
            stale => {
                if let Some(doc) = stale {
                    self.worker.close(doc.handle).await;
                }
                let doc = Arc::new(self.load(&canonical, &id, stamp, password).await?);
                self.docs.lock().insert(id.clone(), doc.clone());
                doc
            }
        };
        let token = self.attach(&doc, session)?;
        Ok((doc, token))
    }

    fn unchanged(&self, dir: &Path, stamp: &Meta) -> bool {
        let Ok(text) = std::fs::read_to_string(dir.join("meta.json")) else { return false };
        let Ok(meta) = serde_json::from_str::<Meta>(&text) else { return false };
        meta.size == stamp.size && meta.modified_ms == stamp.modified_ms && dir.join("current.pdf").is_file()
    }

    async fn load(&self, canonical: &Path, id: &str, stamp: Meta, password: Option<String>) -> Result<Doc, DocError> {
        let dir = self.root.join(id);
        std::fs::create_dir_all(&dir)?;
        let mut head = [0u8; 1024];
        let n = std::io::Read::read(&mut std::fs::File::open(canonical)?, &mut head)?;
        if !head[..n].windows(5).any(|w| w == b"%PDF-") {
            return Err(DocError::NotPdf(canonical.display().to_string()));
        }
        if !self.unchanged(&dir, &stamp) {
            // Written beside, then renamed: a half copy is never taken for the file.
            let partial = dir.join("current.pdf.partial");
            std::fs::copy(canonical, &partial)?;
            std::fs::copy(&partial, dir.join("base.pdf"))?;
            std::fs::rename(&partial, dir.join("current.pdf"))?;
            std::fs::write(dir.join("meta.json"), serde_json::to_vec_pretty(&stamp).map_err(std::io::Error::other)?)?;
        }
        let (handle, opened): (u64, Opened) = self.worker.open(dir.join("current.pdf"), password.clone()).await.map_err(|e| match e {
            WorkerError::Failed(m) if m.starts_with("password") => DocError::Password,
            WorkerError::Failed(m) => DocError::Unreadable(canonical.display().to_string(), m),
            e => DocError::Worker(e),
        })?;
        // A password that opened it means it is encrypted, whatever PDFium makes of its security
        // handler (it may not tell an AES-256 one's revision): pdf.js needs it to show the pages.
        let encrypted = opened.encrypted || password.is_some();
        let mut capabilities = vec![Capability::View];
        if opened.has_text {
            capabilities.extend([Capability::Text, Capability::Search]);
        }
        if !opened.outline.is_empty() {
            capabilities.push(Capability::Outline);
        }
        let read_only = std::fs::metadata(canonical).map(|m| m.permissions().readonly()).unwrap_or(true);
        let info = DocInfo {
            doc_id: id.to_string(),
            path: canonical.display().to_string(),
            format: DocFormat::Pdf,
            layout: DocLayout::Paged,
            pages: Some(opened.pages),
            outline: opened.outline,
            capabilities,
            revision: 0,
            dirty: false,
            save_in_place: !read_only,
            scanned: !opened.has_text && opened.pages > 0,
            encrypted,
        };
        Ok(Doc {
            id: id.to_string(),
            path: canonical.to_path_buf(),
            dir,
            handle,
            password: if encrypted { password } else { None },
            info: Mutex::new(info),
            pages: Mutex::default(),
            views: Mutex::default(),
        })
    }

    /// A session joins a document: its token for the bytes (`finxdoc://<token>/current.pdf`),
    /// kept as `<docs>/.tokens/<token>` holding the document's id, where the app looks it up.
    fn attach(&self, doc: &Doc, session: &str) -> Result<String, DocError> {
        if let Some(view) = doc.views.lock().get(session)
            && self.root.join(".tokens").join(&view.token).is_file()
        {
            return Ok(view.token.clone());
        }
        let token = uuid::Uuid::new_v4().simple().to_string();
        let tokens = self.root.join(".tokens");
        std::fs::create_dir_all(&tokens)?;
        std::fs::write(tokens.join(&token), &doc.id)?;
        doc.views.lock().insert(session.to_string(), View { page: 1, selection: None, token: token.clone() });
        Ok(token)
    }

    /// A session stops showing a document. Its state stays on disk; with no session left the
    /// worker lets it go.
    pub async fn close(&self, doc_id: &str, session: &str) -> Result<(), DocError> {
        let doc = self.get(doc_id)?;
        let (view, left) = {
            let mut views = doc.views.lock();
            (views.remove(session), views.len())
        };
        if let Some(view) = view {
            let _ = std::fs::remove_file(self.root.join(".tokens").join(view.token));
        }
        if left == 0 {
            self.docs.lock().remove(doc_id);
            self.worker.close(doc.handle).await;
        }
        Ok(())
    }

    /// A session is gone: it shows nothing any more.
    pub async fn forget_session(&self, session: &str) {
        let ids: Vec<String> = self.docs.lock().values().filter(|d| d.views.lock().contains_key(session)).map(|d| d.id.clone()).collect();
        for id in ids {
            let _ = self.close(&id, session).await;
        }
    }

    pub fn set_view(&self, doc_id: &str, session: &str, page: u32, selection: Option<Anchor>) -> Result<(), DocError> {
        let doc = self.get(doc_id)?;
        doc.check_page(page)?;
        let mut views = doc.views.lock();
        let view = views.get_mut(session).ok_or_else(|| DocError::NotOpen(doc_id.to_string()))?;
        view.page = page;
        view.selection = selection;
        Ok(())
    }

    /// What a session's column shows, for the context block sent with its messages (§7.4).
    pub fn viewing(&self, session: &str) -> Vec<DocViewing> {
        let mut out: Vec<DocViewing> = self
            .docs
            .lock()
            .values()
            .filter_map(|d| d.views.lock().get(session).map(|v| DocViewing { doc_id: d.id.clone(), path: d.path.display().to_string(), page: v.page }))
            .collect();
        out.sort_by(|a, b| a.path.cmp(&b.path));
        out
    }

    /// A page's text, read once and kept.
    pub async fn page(&self, doc: &Doc, page: u32) -> Result<Arc<PageText>, DocError> {
        doc.check_page(page)?;
        if let Some(text) = doc.pages.lock().get(&page) {
            return Ok(text.clone());
        }
        let chars: PageChars = self.worker.request(Request::Chars { handle: doc.handle, page }).await?;
        let blocks = layout::blocks(page, &chars);
        let text = Arc::new(PageText { chars, blocks });
        doc.pages.lock().insert(page, text.clone());
        Ok(text)
    }

    /// Up to `limit` hits of `query`, in page order.
    pub async fn find(&self, doc: &Doc, query: &str, limit: usize) -> Result<Vec<Hit>, DocError> {
        let mut hits = Vec::new();
        for page in 1..=doc.pages() {
            let text = self.page(doc, page).await?;
            for (a, b) in layout::find(&text.chars, query) {
                let block = layout::block_at(&text.blocks, &text.chars, a);
                let found: String = text.chars.chars[a..=b].iter().map(|c| c.c).collect();
                hits.push(Hit {
                    anchor: Anchor::Text { page, quads: layout::span_rects(&text.chars, a, b), text: found.trim().to_string(), block: block.map(|b| b.id.clone()) },
                    block: block.map(|b| b.id.clone()),
                    context: block.map(|b| context(&b.text, query)).unwrap_or_default(),
                });
                if hits.len() >= limit {
                    return Ok(hits);
                }
            }
        }
        Ok(hits)
    }

    /// A citation's target: `p12.b3`, a block, as a text anchor over its lines; `p12`, the page.
    pub async fn locate(&self, doc: &Doc, target: &str) -> Result<Anchor, DocError> {
        let bad = || DocError::NotOpen(format!("{} has no {target}", doc.id));
        let rest = target.trim().strip_prefix('p').ok_or_else(bad)?;
        let (page, block) = match rest.split_once('.') {
            Some((p, b)) => (p.parse::<u32>().map_err(|_| bad())?, Some(b)),
            None => (rest.parse::<u32>().map_err(|_| bad())?, None),
        };
        doc.check_page(page)?;
        let Some(_) = block else { return Ok(Anchor::Page { page }) };
        let text = self.page(doc, page).await?;
        let found = text.blocks.iter().find(|b| b.id == target.trim()).ok_or_else(bad)?;
        let taken = layout::take(&text.chars, &[found.rect]);
        Ok(Anchor::Text { page, quads: taken.lines, text: found.text.clone(), block: Some(found.id.clone()) })
    }

    /// Reads the text at a selection or in a region of a page (`doc/resolve`, §9.4.1).
    pub async fn resolve(&self, doc: &Doc, page: u32, quads: &[Rect], rect: Option<Rect>) -> Result<(Anchor, String, Vec<Rect>), DocError> {
        let text = self.page(doc, page).await?;
        let rects: Vec<Rect> = rect.into_iter().chain(quads.iter().copied()).collect();
        let taken = layout::take(&text.chars, &rects);
        let block = taken.first.and_then(|i| layout::block_at(&text.blocks, &text.chars, i)).map(|b| b.id.clone());
        let anchor = match rect {
            Some(rect) if quads.is_empty() => Anchor::Region { page, rect },
            _ => Anchor::Text { page, quads: taken.lines, text: taken.text.clone(), block },
        };
        Ok((anchor, taken.text, taken.boxes))
    }

    /// A page, or the part of it an anchor covers, as PNG.
    pub async fn render(&self, doc: &Doc, anchor: &Anchor, dpi: u32) -> Result<Rendered, DocError> {
        let page = anchor.page();
        doc.check_page(page)?;
        let clip = match anchor {
            Anchor::Page { .. } => None,
            Anchor::Region { rect, .. } => Some(*rect),
            // The lines, with a margin around them.
            Anchor::Text { quads, .. } => quads.iter().copied().reduce(|a, b| a.union(&b)).map(|r| Rect { x0: r.x0 - 24.0, y0: r.y0 - 24.0, x1: r.x1 + 24.0, y1: r.y1 + 24.0 }),
        };
        Ok(self.worker.request(Request::Render { handle: doc.handle, page, clip, dpi, max_side: MAX_RENDER_SIDE }).await?)
    }
}

fn modified_ms(meta: &std::fs::Metadata) -> u128 {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0)
}

/// About 80 characters of `text` around the first loose match of `query`.
fn context(text: &str, query: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let folded = layout::fold(chars.iter().copied().enumerate());
    let needle: Vec<char> = layout::fold(query.chars().enumerate()).into_iter().map(|(_, c)| c).collect();
    if needle.is_empty() {
        return String::new();
    }
    let at = (0..folded.len().saturating_sub(needle.len() - 1).max(1))
        .find(|&i| folded.len() >= i + needle.len() && folded[i..i + needle.len()].iter().map(|(_, c)| *c).eq(needle.iter().copied()))
        .map(|i| folded[i].0)
        .unwrap_or(0);
    let start = at.saturating_sub(40);
    let end = (at + 40 + query.chars().count()).min(chars.len());
    let mut out: String = chars[start..end].iter().collect();
    if start > 0 {
        out.insert(0, '…');
    }
    if end < chars.len() {
        out.push('…');
    }
    out
}
