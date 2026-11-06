// Line icons for ribbon controls the library does not draw: group buttons and captioned tiles.
const paths = {
  slide: "M3 5h18v12H3zM8 21h8M12 17v4",
  font: "M5 20 11 4h2l6 16M7.5 14h9",
  paragraph: "M4 6h16M4 10h10M4 14h16M4 18h10",
  insert: "M4 4h16v16H4zM12 8v8M8 12h8",
  pointer: "M6 3l12 9-5.5 1L16 20l-2.5 1-3-6.8L6 18z",
  textBox: "M4 4h16v16H4zM8 8h8M12 8v9",
  image: "M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 9.5a1.5 1.5 0 1 0 0-.01",
  drawing: "M4 20c3 0 4-1.5 4-3.5S9.5 13 11 13l9-9-2-2-9 9c0 1.5-1 3-3 3s-2 3-2 6z",
  arrange: "M3 3h11v11H3zM10 10h11v11H10z",
  adjust: "M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6",
  chevron: "M6 9l6 6 6-6",
} as const;

export type RibbonIconName = keyof typeof paths;

export function RibbonIcon({ name, size = 18 }: { name: RibbonIconName; size?: number }) {
  return <svg className="pptx-rb-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={name === "chevron" ? 2.2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d={paths[name]} />
  </svg>;
}
