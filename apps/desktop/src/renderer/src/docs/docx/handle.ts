import type { DocxEditorRef } from "@betteroffice/docx-react";

// The open Word editors, for the in-document AI (word-design §5) to reach: the editor's ref
// (selection, paragraphs, comments, scrolling to a change) and the kernel's document it is a
// replica of. Nothing here acts on the document; it only says which editor is which.

export type WordHandle = { docxId: string; path: string; editor: DocxEditorRef };

const handles = new Map<string, WordHandle>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

/** The editor of the kernel's document `docxId` is ready; the returned function takes it back. */
export function registerWordHandle(handle: WordHandle): () => void {
  handles.set(handle.docxId, handle);
  emit();
  return () => {
    if (handles.get(handle.docxId) !== handle) return;
    handles.delete(handle.docxId);
    emit();
  };
}

/** The editor showing the kernel's document `docxId`, while one does. */
export const wordHandle = (docxId: string): WordHandle | undefined => handles.get(docxId);

/** The editor showing the file at `path`, while one does. */
export const wordHandleOf = (path: string): WordHandle | undefined => [...handles.values()].find((h) => h.path === path);

/** Told whenever an editor comes or goes. */
export function onWordHandles(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
