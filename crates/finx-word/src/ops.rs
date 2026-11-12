//! What the agent asks of a document: one batch of edits, and how review settles revisions.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// How a batch's text changes land.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EditMode {
    /// As tracked changes by FinxWork AI, which the user accepts or rejects in the document.
    #[default]
    Suggest,
    /// Straight into the document, with no tracked change.
    Direct,
}

/// Edits applied together or not at all.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EditBatch {
    #[serde(default)]
    pub mode: EditMode,
    /// Author of the revisions and comments the batch makes.
    pub author: String,
    /// Why, for the caller's log; the document does not keep it.
    #[serde(default)]
    pub note: String,
    pub edits: Vec<WordOp>,
}

/// Which end of a paragraph `insert_text` writes at.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Edge {
    Start,
    End,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RowPosition {
    Before,
    After,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Align {
    Left,
    Center,
    Right,
    Justify,
}

impl Align {
    /// The `w:jc` value.
    pub(crate) fn ooxml(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Center => "center",
            Self::Right => "right",
            Self::Justify => "both",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NewParagraph {
    /// The paragraph's text. Plain text, no line breaks: one entry for each paragraph.
    pub text: String,
    /// A paragraph style id of this document, as docx_read shows after "style" (e.g.
    /// `Heading2`); without one, the style of the paragraph it is inserted next to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
}

/// One edit, named by `op`. A paragraph is addressed by its id, the text in square brackets that
/// docx_read and docx_find give. Ids stay the same when the document is edited. Edits run in
/// order, each on the document as the ones before it left it. `find` is exact and case-sensitive
/// and must occur exactly once in that paragraph's text as docx_read gives it (pending insertions
/// in, pending deletions out); quote more of the text when it occurs more than once.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum WordOp {
    /// Replace words in a paragraph.
    ReplaceText {
        /// Id of the paragraph.
        paragraph: String,
        /// The words to replace, as they stand in the paragraph; exactly one occurrence.
        find: String,
        /// The words to put there. Plain text, no line breaks.
        replace: String,
    },
    /// Add words to a paragraph: right after the words `after`, or else at the edge `at`
    /// (default the end). Not both.
    InsertText {
        /// Id of the paragraph.
        paragraph: String,
        /// The words to add. Plain text; for a new paragraph use insert_paragraphs.
        text: String,
        /// Words in the paragraph (exactly one occurrence) to insert right after. This is
        /// text, not a paragraph id.
        #[serde(default)]
        after: Option<String>,
        /// `start` or `end` of the paragraph, when `after` is not given.
        #[serde(default)]
        at: Option<Edge>,
    },
    /// Delete words from a paragraph.
    DeleteText {
        /// Id of the paragraph.
        paragraph: String,
        /// The words to delete; exactly one occurrence.
        find: String,
    },
    /// Format words in a paragraph, or the whole paragraph without `find`. Give at least one
    /// of the formats; those left out stay as they are.
    FormatText {
        /// Id of the paragraph.
        paragraph: String,
        /// The words to format (exactly one occurrence); the whole paragraph when absent.
        #[serde(default)]
        find: Option<String>,
        /// true sets bold, false clears it.
        #[serde(default)]
        bold: Option<bool>,
        /// true sets italic, false clears it.
        #[serde(default)]
        italic: Option<bool>,
        /// true sets a single underline, false clears it.
        #[serde(default)]
        underline: Option<bool>,
        /// true sets strikethrough, false clears it.
        #[serde(default)]
        strike: Option<bool>,
        /// Text colour as six hex digits, e.g. `FF0000` (a leading `#` is fine).
        #[serde(default)]
        color: Option<String>,
        /// Highlight colour by Word's name: yellow, green, cyan, magenta, blue, red, darkBlue,
        /// darkCyan, darkGreen, darkMagenta, darkRed, darkYellow, darkGray, lightGray, black.
        #[serde(default)]
        highlight: Option<String>,
    },
    /// Insert new paragraphs after or before an existing one. Give exactly one of `after` and
    /// `before`. Cannot be a tracked change: it needs mode direct. The new paragraphs' ids come
    /// back in the result; address them in a later docx_edit, not in this one.
    InsertParagraphs {
        /// Id of the paragraph to insert after. This is a paragraph id, not text.
        #[serde(default)]
        after: Option<String>,
        /// Id of the paragraph to insert before.
        #[serde(default)]
        before: Option<String>,
        /// The new paragraphs, in order; at least one.
        paragraphs: Vec<NewParagraph>,
    },
    /// Delete a whole paragraph. Cannot be a tracked change: it needs mode direct. To suggest
    /// removing its words instead, use delete_text in mode suggest.
    DeleteParagraph {
        /// Id of the paragraph.
        paragraph: String,
    },
    /// Give a paragraph one of the document's paragraph styles. Applied at once in either
    /// mode: it is not a tracked change.
    SetParagraphStyle {
        /// Id of the paragraph.
        paragraph: String,
        /// A style id of this document, as docx_read shows after "style" on a paragraph that
        /// has it (e.g. `Heading1`, `Heading2`, `Title`). Take it from a paragraph that already
        /// looks the way you want.
        style: String,
    },
    /// Align a paragraph.
    SetAlignment {
        /// Id of the paragraph.
        paragraph: String,
        /// `left`, `center`, `right` or `justify`.
        align: Align,
    },
    /// Add a comment by FinxWork AI on words of a paragraph, or on the whole paragraph without
    /// `find`. Comments are added at once in either mode.
    AddComment {
        /// Id of the paragraph.
        paragraph: String,
        /// The words the comment is about (exactly one occurrence); the whole paragraph when absent.
        #[serde(default)]
        find: Option<String>,
        /// The comment. Line breaks make paragraphs.
        text: String,
    },
    /// Reply in a comment's thread.
    ReplyComment {
        /// Id of the comment, as docx_read shows after "comment" or "reply".
        comment: String,
        /// The reply.
        text: String,
    },
    /// Mark a comment's thread as resolved.
    ResolveComment {
        /// Id of the comment, as docx_read shows after "comment" or "reply".
        comment: String,
    },
    /// Insert a table row above or below an existing row.
    InsertTableRow {
        /// Id of any paragraph in a cell of the existing row (docx_read marks such paragraphs
        /// "table N row R col C").
        row_of: String,
        /// `before` (above) or `after` (below) that row.
        position: RowPosition,
        /// The new row's texts, one for each column of the row, left to right; "" for an
        /// empty cell.
        cells: Vec<String>,
    },
    /// Delete a table row. A table keeps at least one row.
    DeleteTableRow {
        /// Id of any paragraph in a cell of the row.
        row_of: String,
    },
    /// Replace everything in a table cell with one paragraph of text. A cell that holds several
    /// paragraphs needs mode direct.
    SetCellText {
        /// Id of any paragraph in the cell.
        cell_of: String,
        /// The cell's new text; "" empties it.
        text: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReviewAction {
    Accept,
    Reject,
}

/// What [`crate::Word::apply`] did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Applied {
    /// Revisions the batch made, in the order `revisions()` lists them.
    pub revision_ids_created: Vec<String>,
    /// Paragraphs the batch edited or made, in batch order, each once.
    pub paragraphs_touched: Vec<String>,
    /// The Yrs update for replicas; empty when nothing changed.
    pub update: Vec<u8>,
}
