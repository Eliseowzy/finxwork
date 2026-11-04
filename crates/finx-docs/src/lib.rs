//! Documents opened beside a conversation (docs/desktop/document-editor-design.md): DocStore,
//! the layout analysis, and the PDF backend on PDFium, which runs in a worker process
//! (`finx doc-worker`).

pub mod engine;
pub mod layout;
pub mod sheet;
pub mod store;
pub mod worker;

pub use engine::Rendered;
pub use store::Doc;
pub use store::DocError;
pub use store::DocStore;
pub use store::Hit;
pub use worker::Launcher;
