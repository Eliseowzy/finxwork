import type { RpcClient } from "@finx/client";
import type { PptxReadProgress } from "@finx/protocol";

export type PresentationProgress = Pick<PptxReadProgress, "stage" | "completed" | "total"> & { bytes?: number };

/** Subscribe before sending; each open has its own ID even for the same path. */
export async function readPresentation(rpc: RpcClient, session: string, path: string, progress: (value: PresentationProgress) => void) {
  const progress_id = crypto.randomUUID();
  let bytes: number | undefined;
  const stop = rpc.on("pptx/readProgress", (event) => {
    if (event.session_id !== session || event.progress_id !== progress_id) return;
    if (event.stage === "reading" && event.total > 0) bytes = event.total;
    progress({ ...event, bytes });
  });
  progress({ stage: "reading", completed: 0, total: 0 });
  try {
    return await rpc.request("pptx/read", { session_id: session, path, progress_id });
  } finally {
    stop();
  }
}
