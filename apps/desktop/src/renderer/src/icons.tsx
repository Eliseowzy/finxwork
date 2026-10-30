// Line icons drawn on a 16×16 grid (the baseline's set, and what the
// composer and the steps add).
import markOnDark from "../../../../../assets/brand/app/finxwork-mark-on-dark-256.png";
import markOnLight from "../../../../../assets/brand/app/finxwork-mark-on-light-256.png";
import markSolid from "../../../../../assets/brand/mark/finxwork-mark-solid.svg";

const paths: Record<string, string> = {
  grid: "<rect x=\"2.8\" y=\"2.8\" width=\"3.9\" height=\"3.9\" rx=\"1.1\"/><rect x=\"9.3\" y=\"2.8\" width=\"3.9\" height=\"3.9\" rx=\"1.1\"/><rect x=\"2.8\" y=\"9.3\" width=\"3.9\" height=\"3.9\" rx=\"1.1\"/><rect x=\"9.3\" y=\"9.3\" width=\"3.9\" height=\"3.9\" rx=\"1.1\"/>",
  search: "<circle cx=\"7\" cy=\"7\" r=\"4.4\"/><path d=\"M10.3 10.3l3.4 3.4\"/>",
  sidebar: "<rect x=\"1.8\" y=\"2.8\" width=\"12.4\" height=\"10.4\" rx=\"2.4\"/><path d=\"M6.2 2.8v10.4\"/>",
  gear: "<circle cx=\"8\" cy=\"8\" r=\"2.1\"/><path d=\"M8 1.9v1.8M8 12.3v1.8M1.9 8h1.8M12.3 8h1.8M3.7 3.7l1.3 1.3M11 11l1.3 1.3M3.7 12.3L5 11M11 5l1.3-1.3\"/>",
  plus: "<path d=\"M8 3v10M3 8h10\"/>",
  more: "<circle cx=\"3.6\" cy=\"8\" r=\"1.15\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"8\" cy=\"8\" r=\"1.15\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"12.4\" cy=\"8\" r=\"1.15\" fill=\"currentColor\" stroke=\"none\"/>",
  x: "<path d=\"M4.3 4.3l7.4 7.4M11.7 4.3l-7.4 7.4\"/>",
  check: "<path d=\"M3.4 8.4l3 3 6.2-6.8\"/>",
  caret: "<path d=\"M4.8 6.4h6.4L8 10z\" fill=\"currentColor\" stroke=\"none\"/>",
  chevD: "<path d=\"M4.5 6.3L8 9.8l3.5-3.5\"/>",
  chevR: "<path d=\"M6.3 4.5L9.8 8l-3.5 3.5\"/>",
  stop: "<rect x=\"4.3\" y=\"4.3\" width=\"7.4\" height=\"7.4\" rx=\"1.6\"/>",
  stopFill: "<rect x=\"3\" y=\"3\" width=\"10\" height=\"10\" rx=\"2.4\" fill=\"currentColor\" stroke=\"none\"/>",
  arrowUp: "<path d=\"M8 13.2V3.2M3.8 7.4L8 3.2l4.2 4.2\"/>",
  archive: "<rect x=\"2\" y=\"2.8\" width=\"12\" height=\"3.4\" rx=\"1\"/><path d=\"M3.2 6.2v6c0 .7.5 1.2 1.2 1.2h7.2c.7 0 1.2-.5 1.2-1.2v-6M6.4 9h3.2\"/>",
  // A window with a card floating at its right: the session's info card.
  infoCard: "<rect x=\"1.8\" y=\"2.8\" width=\"12.4\" height=\"10.4\" rx=\"2.4\"/><rect x=\"8.3\" y=\"5.1\" width=\"3.8\" height=\"5.8\" rx=\"1\" fill=\"currentColor\" stroke=\"none\"/>",
  info: "<circle cx=\"8\" cy=\"8\" r=\"6\"/><path d=\"M8 7.3v3.9M8 5v.1\"/>",
  laptop: "<rect x=\"3\" y=\"3.3\" width=\"10\" height=\"7\" rx=\"1.2\"/><path d=\"M1.4 12.7h13.2\"/>",
  folder: "<path d=\"M1.8 4.4c0-.7.5-1.2 1.2-1.2h3l1.4 1.5H13c.7 0 1.2.5 1.2 1.2V12c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z\"/>",
  file: "<path d=\"M9.2 1.9H4.4c-.7 0-1.2.5-1.2 1.2v9.8c0 .7.5 1.2 1.2 1.2h7.2c.7 0 1.2-.5 1.2-1.2V5.6z\"/><path d=\"M9.2 1.9v3.7h3.6\"/>",
  folderPlus: "<path d=\"M1.8 4.4c0-.7.5-1.2 1.2-1.2h3l1.4 1.5H13c.7 0 1.2.5 1.2 1.2V12c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z\"/><path d=\"M8 7.2v4M6 9.2h4\"/>",
  key: "<circle cx=\"5.6\" cy=\"10.4\" r=\"2.8\"/><path d=\"M7.6 8.4L13 3M11 5l1.6 1.6M9.4 6.6l1.3 1.3\"/>",
  person: "<circle cx=\"8\" cy=\"5.5\" r=\"2.6\"/><path d=\"M3 13.6c.6-2.5 2.6-3.8 5-3.8s4.4 1.3 5 3.8\"/>",
  terminal: "<rect x=\"1.8\" y=\"2.8\" width=\"12.4\" height=\"10.4\" rx=\"2\"/><path d=\"M4.6 6.3l2 1.7-2 1.7M8.2 10h3.2\"/>",
  copy: "<rect x=\"5.2\" y=\"5.2\" width=\"8\" height=\"8\" rx=\"1.6\"/><path d=\"M10.8 5.2V3.8c0-.6-.5-1.1-1.1-1.1H3.9c-.6 0-1.1.5-1.1 1.1v5.8c0 .6.5 1.1 1.1 1.1h1.3\"/>",
  ext: "<path d=\"M6.5 3.2H4c-.7 0-1.2.5-1.2 1.2V12c0 .7.5 1.2 1.2 1.2h7.6c.7 0 1.2-.5 1.2-1.2V9.5M9.3 2.8h3.9v3.9M13.2 2.8L7.5 8.5\"/>",
  edit: "<path d=\"M10.6 2.7l2.7 2.7-7.6 7.6-3.2.5.5-3.2z\"/>",
  clock: "<circle cx=\"8\" cy=\"8\" r=\"6\"/><path d=\"M8 4.6V8l2.3 1.5\"/>",
  shield: "<path d=\"M8 1.8l5 2v4c0 3-2.2 5.3-5 6.4-2.8-1.1-5-3.4-5-6.4v-4z\"/><path d=\"M5.8 8l1.6 1.6 2.9-3\"/>",
  lock: "<rect x=\"3.2\" y=\"7\" width=\"9.6\" height=\"6.8\" rx=\"1.6\"/><path d=\"M5.3 7V5.2a2.7 2.7 0 0 1 5.4 0V7\"/>",
  undo: "<path d=\"M5.5 4L2.8 6.7l2.7 2.7\"/><path d=\"M2.8 6.7h6.7a3.6 3.6 0 0 1 0 7.2H7\"/>",
  warn: "<path d=\"M8 2.2l6.2 11H1.8z\"/><path d=\"M8 6.4v3.2M8 11.4v.1\"/>",
  bolt: "<path d=\"M9 1.8L3.6 9h4l-1 5.2L12.4 7h-4z\"/>",
  sparkle: "<path d=\"M8 2.2l1.3 3.5 3.5 1.3-3.5 1.3L8 11.8 6.7 8.3 3.2 7l3.5-1.3z\"/><path d=\"M12.6 11.2l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z\"/>",
  bulb: "<path d=\"M6 12.2h4M6.7 14h2.6\"/><path d=\"M8 2.2a4.2 4.2 0 0 0-2.5 7.6c.4.3.7.8.7 1.3v.1h3.6v-.1c0-.5.3-1 .7-1.3A4.2 4.2 0 0 0 8 2.2z\"/>",
  paperclip: "<path d=\"M13 7.4l-5.1 5.1a3.1 3.1 0 0 1-4.4-4.4l5.5-5.5a2.1 2.1 0 0 1 3 3l-5.4 5.4a1.1 1.1 0 0 1-1.6-1.6l4.9-4.9\"/>",
  retry: "<path d=\"M13.1 8.4A5.2 5.2 0 1 1 11.6 4.4\"/><path d=\"M13.3 2.4v2.8h-2.8\"/>",
  filter: "<path d=\"M2.5 4.2h11M4.6 8h6.8M6.7 11.8h2.6\"/>",
  cube: "<path d=\"M8 1.9l5.3 3v6.2L8 14.1l-5.3-3V4.9z\"/><path d=\"M2.7 4.9L8 7.9l5.3-3M8 7.9v6.2\"/>",
  // Stacked sheets: work going on in the background.
  layers: "<path d=\"M8 2.3l5.6 2.9L8 8.1 2.4 5.2z\"/><path d=\"M2.4 8l5.6 2.9L13.6 8\"/><path d=\"M2.4 10.8l5.6 2.9 5.6-2.9\"/>",
  pause: "<path d=\"M6 4.2v7.6M10 4.2v7.6\"/>",
};

export type IconName = keyof typeof paths;

export function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <svg className={`ic ${className}`} viewBox="0 0 16 16" aria-hidden="true" dangerouslySetInnerHTML={{ __html: paths[name] ?? "" }} />;
}

/** finxwork's mark, the α of assets/brand: the data-point mark from 64 px up, the solid one below (the brand's smallest size for each). */
export function Mark({ size = 18 }: { size?: number }) {
  const style = { display: "block", flex: "none", width: size, height: size };
  if (size < 64) return <img src={markSolid} alt="" draggable={false} style={style} />;
  return (
    <picture style={{ display: "contents" }}>
      <source srcSet={markOnDark} media="(prefers-color-scheme: dark)" />
      <img src={markOnLight} alt="" draggable={false} style={style} />
    </picture>
  );
}
