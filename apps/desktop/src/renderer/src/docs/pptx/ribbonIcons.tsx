// Line icons for ribbon controls the library does not draw: group buttons and captioned tiles.
// An icon with several parts draws each as its own <path>, so ribbon.css can colour them apart.
export type RibbonIconName = "clipboard" | "slide" | "font" | "paragraph" | "insert" | "pointer" | "textBox" | "image" | "drawing" | "arrange" | "adjust" | "chevron";

const paths: Record<RibbonIconName, string | readonly string[]> = {
  clipboard: ["M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2", "M8 2h8v4H8z"],
  slide: ["M3 5h18v12H3z", "M8 21h8M12 17v4"],
  font: "M5 20 11 4h2l6 16M7.5 14h9",
  paragraph: "M4 6h16M4 10h10M4 14h16M4 18h10",
  insert: ["M4 4h16v16H4z", "M12 8v8M8 12h8"],
  pointer: "M6 3l12 9-5.5 1L16 20l-2.5 1-3-6.8L6 18z",
  textBox: ["M4 4h16v16H4z", "M8 8h8M12 8v9"],
  image: ["M3 5h18v14H3z", "M3 16l5-5 4 4 3-3 6 6", "M15.5 9.5a1.5 1.5 0 1 0 0-.01"],
  drawing: "M4 20c3 0 4-1.5 4-3.5S9.5 13 11 13l9-9-2-2-9 9c0 1.5-1 3-3 3s-2 3-2 6z",
  arrange: ["M3 3h11v11H3z", "M10 10h11v11H10z"],
  adjust: "M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6",
  chevron: "M6 9l6 6 6-6",
};

export function RibbonIcon({ name, size = 18 }: { name: RibbonIconName; size?: number }) {
  return <svg className="pptx-rb-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={name === "chevron" ? 2.2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-icon={name}>
    {[paths[name]].flat().map((d) => <path key={d} d={d} />)}
  </svg>;
}
