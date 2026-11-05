/** A file that is a web page: it opens as that page, in the session's browser (content-actions-design DD-156). */
export const isPageFile = (path: string) => /\.html?$/i.test(path);
