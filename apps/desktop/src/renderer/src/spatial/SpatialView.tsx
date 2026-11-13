import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { needsDisclaimer, sealFindings, sizeLabel, type Finding, type MeshInput, type PartInfo, type SlicePlane, type SpatialProfile } from "./model";
import type { Axis, Viewer, ViewName } from "./scene";
import "./spatial.css";

// The spatial view (spatial-design §4.2): a three.js canvas with the parts beside it. A panel
// of its own, not tied to the file panel: a file's bytes, the kernel's meshes, findings and the
// current slice all come in as props, and what is picked goes out by onQuote. What it enforces
// whoever uses it: a finding's source cannot change, and with an ai finding the disclaimer shows.

export type SpatialViewProps = {
  /** A model file (.stl, .obj, .ply, .glb) by name and bytes. */
  file?: { name: string; bytes: ArrayBuffer };
  /** Meshes in the kernel's format, each a part. */
  meshes?: MeshInput[];
  findings?: readonly Finding[];
  slice?: SlicePlane | null;
  profile?: SpatialProfile;
  /** A picked part, said as text for the conversation; no button without it. */
  onQuote?: (part: PartInfo) => void;
};

export default function SpatialView({ file, meshes, findings, slice, profile, onQuote }: SpatialViewProps) {
  const { t } = useTranslation("session");
  const host = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [parts, setParts] = useState<PartInfo[]>([]);
  const [selected, setSelected] = useState<PartInfo | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [axis, setAxis] = useState<Axis>(2);
  const [cut, setCut] = useState<number | null>(null);
  const sealed = useMemo(() => sealFindings(findings), [findings]);

  // three.js only loads when a model shows.
  useEffect(() => {
    let v: Viewer | null = null;
    let gone = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const { Viewer } = await import("./scene");
        if (gone || !host.current) return;
        v = new Viewer(host.current, { parts: setParts, select: setSelected, hover: setHover });
        if (file) await v.loadFile(file.name, file.bytes);
        if (meshes?.length) v.setMeshes(meshes);
        if (!gone) setViewer(v);
      } catch (e) {
        if (!gone) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!gone) setLoading(false);
      }
    })();
    return () => {
      gone = true;
      v?.dispose();
      setViewer(null);
      setParts([]);
      setSelected(null);
    };
  }, [file, meshes]);

  useEffect(() => viewer?.setFindings(sealed), [viewer, sealed]);
  useEffect(() => viewer?.setSlice(slice ?? null), [viewer, slice]);
  useEffect(() => viewer?.setClip(axis, cut), [viewer, axis, cut]);

  const views: [ViewName, string][] = [["front", t("spatial.front")], ["side", t("spatial.side")], ["top", t("spatial.top")], ["reset", t("spatial.reset")]];

  return (
    <div className="spv">
      <div className="spv-bar">
        {views.map(([v, label]) => (
          <button key={v} className="btn sm" disabled={!viewer} onClick={() => viewer?.view(v)}>{label}</button>
        ))}
        <span className="spv-gap" />
        <label className="spv-cut" title={t("spatial.clipHint")}>
          <input type="checkbox" checked={cut !== null} disabled={!viewer} onChange={(e) => setCut(e.target.checked ? 0.5 : null)} />
          {t("spatial.clip")}
          <select value={axis} disabled={cut === null} onChange={(e) => setAxis(Number(e.target.value) as Axis)} aria-label={t("spatial.clipAxis")}>
            <option value={0}>X</option>
            <option value={1}>Y</option>
            <option value={2}>Z</option>
          </select>
          <input type="range" min={0} max={1} step={0.005} value={cut ?? 1} disabled={cut === null} onChange={(e) => setCut(Number(e.target.value))} aria-label={t("spatial.clipAt")} />
        </label>
      </div>
      <div className="spv-body">
        {parts.length > 0 && (
          <ul className="spv-parts" aria-label={t("spatial.parts")}>
            {parts.map((p) => (
              <li key={p.id} className={`${selected?.id === p.id ? "on" : ""} ${hover === p.name ? "hover" : ""}`}>
                <input type="checkbox" checked={p.visible} onChange={(e) => viewer?.setVisible(p.id, e.target.checked)} aria-label={t("spatial.show", { name: p.name })} />
                <button className="spv-name" title={p.name} onClick={() => viewer?.select(selected?.id === p.id ? null : p.id)}>{p.name}</button>
                <input type="range" min={0} max={1} step={0.05} value={p.opacity} onChange={(e) => viewer?.setOpacity(p.id, Number(e.target.value))} aria-label={t("spatial.opacity", { name: p.name })} title={t("spatial.opacity", { name: p.name })} />
              </li>
            ))}
          </ul>
        )}
        <div className="spv-canvas" ref={host}>
          {loading && <div className="spv-msg">{t("spatial.loading")}</div>}
          {error && <div className="spv-msg bad">{t("spatial.failed", { message: error })}</div>}
          {hover && !selected && <div className="spv-hover">{hover}</div>}
          {selected && (
            <div className="spv-card" role="status">
              <strong title={selected.name}>{selected.name}</strong>
              <span>{sizeLabel(selected.size)}</span>
              <div className="spv-card-actions">
                {onQuote && <button className="btn sm" onClick={() => onQuote(selected)}>{t("spatial.addToChat")}</button>}
                <button className="btn sm" onClick={() => viewer?.select(null)}>{t("spatial.deselect")}</button>
              </div>
            </div>
          )}
        </div>
      </div>
      {needsDisclaimer(sealed) && <div className="spv-disclaimer" role="note">{profile?.disclaimer?.trim() || t("spatial.disclaimer")}</div>}
    </div>
  );
}
