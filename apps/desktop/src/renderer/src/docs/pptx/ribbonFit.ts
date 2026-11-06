/**
 * How a ribbon group is drawn. Like PowerPoint, a narrowing ribbon first drops
 * button captions (`compact`), then folds whole groups into one labelled button
 * that opens the group as a popover (`collapsed`). Groups stay in place.
 */
export type RibbonLevel = 0 | 1 | 2;
export const FULL: RibbonLevel = 0;
export const COMPACT: RibbonLevel = 1;
export const COLLAPSED: RibbonLevel = 2;

export interface RibbonFitGroup {
  id: string;
  /** Higher stays expanded longer. */
  priority: number;
  /** False when the compact form would look the same as the full one. */
  hasCompact: boolean;
}

/**
 * The next, one-step-narrower arrangement, or null when every group is already
 * collapsed. Every group goes compact before any group collapses; within each
 * stage the lowest priority goes first, and among equals the rightmost one.
 */
export function narrower(groups: readonly RibbonFitGroup[], levels: Readonly<Record<string, RibbonLevel>>): Record<string, RibbonLevel> | null {
  const level = (id: string) => levels[id] ?? FULL;
  const pick = (eligible: (group: RibbonFitGroup) => boolean) => {
    let best: RibbonFitGroup | null = null;
    for (const group of groups) if (eligible(group) && (!best || group.priority <= best.priority)) best = group;
    return best;
  };
  const toCompact = pick((g) => g.hasCompact && level(g.id) === FULL);
  if (toCompact) return { ...levels, [toCompact.id]: COMPACT };
  const toCollapse = pick((g) => level(g.id) !== COLLAPSED);
  if (toCollapse) return { ...levels, [toCollapse.id]: COLLAPSED };
  return null;
}
