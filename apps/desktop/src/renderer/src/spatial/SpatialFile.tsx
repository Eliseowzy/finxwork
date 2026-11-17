import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { docAttachment } from "../composer/attachments";
import { toComposer } from "../composer/inbox";
import { FileCard, FileLoading } from "../files/FileCard";
import { partQuote, type PartInfo } from "./model";

// A model file in the file panel (spatial-design §7): its bytes read here, shown by the spatial
// view, a picked part added to the conversation as "3D · file · part · size".

const SpatialView = lazy(() => import("./SpatialView"));

export function SpatialFile({ session, path, rel, name }: { session: string; path: string; rel: string | null; name: string }) {
  const { t } = useTranslation("session");
  const [file, setFile] = useState<{ name: string; bytes: ArrayBuffer } | null | "failed">(null);
  useEffect(() => {
    let gone = false;
    setFile(null);
    void (window.finx?.readModel(path) ?? Promise.resolve(null)).then((bytes) => {
      if (gone) return;
      // The IPC's bytes may sit in a larger buffer: the loaders get exactly the file.
      setFile(bytes ? { name, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer } : "failed");
    }, () => !gone && setFile("failed"));
    return () => { gone = true; };
  }, [path, name]);
  if (file === "failed") return <FileCard path={path} rel={rel} text={t("spatial.readFailed")} gone={false} />;
  if (!file) return <FileLoading />;
  const quote = (p: PartInfo) => {
    const text = partQuote(t("spatial.quotePrefix"), name, p.name, p.size);
    toComposer(session, [docAttachment({ path, doc_id: "", text })]);
  };
  return (
    <Suspense fallback={<FileLoading />}>
      <SpatialView file={file} onQuote={quote} />
    </Suspense>
  );
}
