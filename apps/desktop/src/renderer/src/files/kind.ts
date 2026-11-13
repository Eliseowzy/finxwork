// What a file in the panel is, by its name: one place for the extensions that decide how it
// opens (finx's document, as pdf.js or the workbook grid, or text), and how text shows.

import { isPageFile } from "../../../shared/pageFile.ts";

const doc = /\.(pdf|xlsx|xlsm|xls|csv|tsv)$/i;
const markdown = /\.(md|markdown)$/i;
const svg = /\.svg$/i;
const prose = /\.(md|markdown|txt|text|log)$/i;
const spatial = /\.(stl|obj|ply|glb)$/i;
const image = /\.(png|jpe?g|gif|webp|svg|bmp|ico|heic|tiff?)$/i;

/** Opens as finx's document (pdf.js, or the workbook grid), not read as text. */
export const opensAsDoc = (path: string) => doc.test(path);

/** An object-based presentation editor, opened in the browser's own WASM session. */
export const isPresentation = (path: string) => /\.pptx$/i.test(path);

/** A Word document, opened as the kernel's document with the editor as its replica (word-design §6). */
export const isWord = (path: string) => /\.docx$/i.test(path);

/** A 3D model the spatial view shows (spatial-design §7). */
export const isSpatial = (path: string) => spatial.test(path);

/** The old binary Word format: the panel says it is not supported and offers the default app. */
export const isLegacyWord = (path: string) => /\.doc$/i.test(path);

/** A document that shows as the grid: a workbook, a CSV. */
export const isGrid = (path: string) => opensAsDoc(path) && !/\.pdf$/i.test(path);

/** Files the panel shows only as "binary": Office documents, media, archives — these open in their own app. */
export const opensInOwnApp = (path: string) =>
  /\.(docx?|xlsx?|xlsm|pptx?|key|numbers|pages|rtf|odt|ods|odp|epub|mp3|m4a|wav|aac|flac|mp4|mov|m4v|avi|mkv|webm|zip|rar|7z|tar|gz|dmg|pkg|app)$/i.test(path);

/** Whether the app shows the file itself: as a document (a workbook among them), or by reading it. */
export const showsInApp = (path: string) => opensAsDoc(path) || !opensInOwnApp(path);

/**
 * A file a conversation hands over to be looked at, rather than one being worked on: a report, a
 * picture, a PDF, a table, a page (content-actions-design §4.2, DD-161). Code and plain text are the other kind.
 */
export const readsAsResult = (path: string) => markdown.test(path) || image.test(path) || spatial.test(path) || opensAsDoc(path) || isPageFile(path);

export const isMarkdown = (path: string) => markdown.test(path);
export const isSvg = (path: string) => svg.test(path);

/** Text that has a preview of what it looks like: Markdown, SVG. */
export const previewable = (path: string) => isMarkdown(path) || isSvg(path);

/** Text read as prose, whose lines wrap; a name without an extension too. */
export const wraps = (name: string) => prose.test(name) || !/\./.test(name);
