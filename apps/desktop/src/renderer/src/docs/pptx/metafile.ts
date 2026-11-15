import { decodePresentationImage } from "@nimbleoffice/pptx";
import type { RpcClient } from "@finx/client";
import { toBase64 } from "./document";

/** EMF and both placeable and ordinary WMF headers. Never infer the format from a name. */
export function isMetafile(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 44 && view.getUint32(0, true) === 1 && view.getUint32(40, true) === 0x464d4520) return true;
  if (bytes.length >= 22 && view.getUint32(0, true) === 0x9ac6cdd7) return true;
  return bytes.length >= 18 && [1, 2].includes(view.getUint16(0, true)) && view.getUint16(2, true) === 9 && [0x100, 0x300].includes(view.getUint16(4, true));
}

/** Convert just the legacy asset to SVG. The editor retains the original EMF/WMF and OLE bytes. */
export function presentationImageDecoder(rpc: RpcClient, session: string, onWarning: (message: string) => void) {
  return async (bytes: Uint8Array, errorMessage: string): Promise<CanvasImageSource> => {
    if (!isMetafile(bytes)) return decodePresentationImage(bytes, errorMessage);
    try {
      const { svg, omissions } = await rpc.request("pptx/metafile", { session_id: session, data: toBase64(bytes) });
      if (omissions.length) onWarning(`metafile: ${omissions.join(", ")}`);
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      try {
        return await new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error(errorMessage));
          image.src = url;
        });
      } finally { URL.revokeObjectURL(url); }
    } catch (error) {
      onWarning(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
}
