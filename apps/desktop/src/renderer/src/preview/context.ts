import { createContext, useContext } from "react";

/** What opens a file for reading over the window. Only where a page offers it; elsewhere files open beside the conversation. */
export type FilePreviewOpener = { open: (path: string) => void };

export const FilePreviewContext = createContext<FilePreviewOpener | null>(null);

export const useFilePreview = () => useContext(FilePreviewContext);
