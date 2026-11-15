import { createYrsSession, saveYrsDocx } from "@nimbleoffice/docx/yrs";
import fs from "node:fs/promises";
import type { DocxSerializeParams } from "@finx/protocol";

// The .docx of one of the kernel's Word documents (word-design §2): the engine's save is only
// in its JavaScript. The session is rebuilt from the source bytes, which unchanged parts are
// kept from, and the kernel's Yrs state; with the engine's peer metadata when the kernel
// gives it, which carries media, header and footer aliases and note separators.

/** The saved bytes of a document from its source .docx and Yrs state. */
export async function serializeDocx(source: Uint8Array, state: Uint8Array, metadata?: Uint8Array): Promise<Uint8Array> {
  const session = await createYrsSession();
  try {
    const host = session.openDocx(source, false);
    if (metadata) session.bootstrapPeer(state, metadata, source, host);
    else session.loadState(state);
    return (await saveYrsDocx(session)).bytes;
  } finally {
    session.destroy();
  }
}

/** `docx/serialize`: reads the inputs, writes `out_path` (whole or not at all), returns its size. */
export async function serializeFiles(p: DocxSerializeParams): Promise<number> {
  const [source, state, metadata] = await Promise.all([
    fs.readFile(p.source_path),
    fs.readFile(p.state_path),
    p.metadata_path ? fs.readFile(p.metadata_path) : undefined,
  ]);
  const bytes = await serializeDocx(source, state, metadata);
  const tmp = `${p.out_path}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, p.out_path);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  return bytes.length;
}
