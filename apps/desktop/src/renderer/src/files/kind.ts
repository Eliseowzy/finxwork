// What a file in the panel is, by its name: one place for the extensions that decide how it
// opens (finx's document, as pdf.js or the workbook grid, or text), and how text shows.

const doc = /\.(pdf|xlsx|xlsm|xls|csv|tsv)$/i;
const markdown = /\.(md|markdown)$/i;
const svg = /\.svg$/i;
const prose = /\.(md|markdown|txt|text|log)$/i;

/** Opens as finx's document (pdf.js, or the workbook grid), not read as text. */
export const opensAsDoc = (path: string) => doc.test(path);

/** A document that shows as the grid: a workbook, a CSV. */
export const isGrid = (path: string) => opensAsDoc(path) && !/\.pdf$/i.test(path);

export const isMarkdown = (path: string) => markdown.test(path);
export const isSvg = (path: string) => svg.test(path);

/** Text that has a preview of what it looks like: Markdown, SVG. */
export const previewable = (path: string) => isMarkdown(path) || isSvg(path);

/** Text read as prose, whose lines wrap; a name without an extension too. */
export const wraps = (name: string) => prose.test(name) || !/\./.test(name);
