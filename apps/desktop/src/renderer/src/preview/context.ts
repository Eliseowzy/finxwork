import { createContext, useContext } from "react";

/**
 * What opens a file for reading over the window. Only where a page offers it, and for the files it
 * says it `takes`; other files open beside the conversation.
 */
export type FilePreviewOpener = { takes: (path: string) => boolean; open: (path: string) => void };

export const FilePreviewContext = createContext<FilePreviewOpener | null>(null);

export const useFilePreview = () => useContext(FilePreviewContext);
