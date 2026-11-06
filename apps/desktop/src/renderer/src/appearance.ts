import type { Preferences } from "../../shared/bridge";

/** Load the palette before mounting either window; later changes apply without a reload.
 * Electron owns light/dark media queries, so system changes and embedded pages still follow it. */
export async function prepareAppearance() {
  const apply = (p: Preferences) => {
    document.documentElement.dataset.darkStyle = p.appearance === "black" ? "black" : "gray";
  };
  document.documentElement.dataset.darkStyle = "gray";
  if (!window.finx) return;
  let changed = false;
  window.finx.onPreferences((p) => {
    changed = true;
    apply(p);
  });
  try {
    const p = await window.finx.getPreferences();
    if (!changed) apply(p);
  } catch (error) {
    console.warn("Could not load appearance preferences", error);
  }
}
