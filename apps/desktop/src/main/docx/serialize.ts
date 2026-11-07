import { createYrsSession, saveYrsDocx } from "@betteroffice/docx/yrs";
import fs from "node:fs/promises";
import type { DocxSerializeParams } from "@finx/protocol";

// The .docx of one of the kernel's Word documents (word-design §2): the engine's save is only
// in its JavaScript. The session is rebuilt from the source bytes, which unchanged parts are
// kept from, and the kernel's Yrs state; with the engine's peer metadata when the kernel
// gives it, which carries media, header and footer aliases and note separators.

/**
 * The kernel's engine (a fork revision of BetterOffice) is newer than the published JavaScript one
 * (@betteroffice/docx 0.5.1): its peer metadata carries `seed_identities`, which the older reader
 * refuses as an unknown field. Dropped here until the JS engine is built from the same revision.
 */
export function readablePeerMetadata(metadata: Uint8Array): Uint8Array {
  // Framed as: magic 8, version 4, shape fingerprint 32, JSON length 8, blobs length 8, JSON, blobs.
  const header = 60;
  if (metadata.length < header) return metadata;
  const view = new DataView(metadata.buffer, metadata.byteOffset, metadata.byteLength);
  const jsonLength = Number(view.getBigUint64(44, true));
  if (header + jsonLength > metadata.length) return metadata;
  let wire: Record<string, unknown>;
  try {
    wire = JSON.parse(new TextDecoder().decode(metadata.subarray(header, header + jsonLength)));
  } catch {
    return metadata;
  }
  if (!wire || typeof wire !== "object" || !("seed_identities" in wire)) return metadata;
  delete wire.seed_identities;
  const json = new TextEncoder().encode(JSON.stringify(wire));
  const out = new Uint8Array(header + json.length + metadata.length - header - jsonLength);
  out.set(metadata.subarray(0, header));
  new DataView(out.buffer).setBigUint64(44, BigInt(json.length), true);
  out.set(json, header);
  out.set(metadata.subarray(header + jsonLength), header + json.length);
  return out;
}

/** The saved bytes of a document from its source .docx and Yrs state. */
export async function serializeDocx(source: Uint8Array, state: Uint8Array, metadata?: Uint8Array): Promise<Uint8Array> {
  const session = await createYrsSession();
  try {
    const host = session.openDocx(source, false);
    if (metadata) session.bootstrapPeer(state, readablePeerMetadata(metadata), source, host);
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
