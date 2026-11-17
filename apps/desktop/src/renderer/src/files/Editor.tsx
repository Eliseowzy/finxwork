import { useEffect, useLayoutEffect, useRef } from "react";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, openSearchPanel, searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, EditorSelection, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { crosshairCursor, Decoration, showTooltip, type Tooltip, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection, type DecorationSet } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { i18n } from "../../../shared/i18n";
import type { Tab } from "./state";
import { wraps } from "./kind";

// The file panel's editor (file-panel-design §5): CodeMirror 6, loaded only when a file is
// first opened. One view for the panel; each tab keeps its own state (text, undo history,
// selection) and scroll, swapped in when its tab comes forward. Edits go to the tab's document,
// which saves them; a version taken from disk comes back in as one change.

/** FinxWork's syntax colours, light and dark, as the conversation's code blocks have them (styles/files.css). */
const colours = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword], color: "var(--syn-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character], color: "var(--syn-string)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.constant(tags.name), tags.standard(tags.name)], color: "var(--syn-constant)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: "var(--syn-function)" },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName, tags.self], color: "var(--syn-type)" },
  { tag: [tags.propertyName, tags.attributeName, tags.labelName], color: "var(--syn-property)" },
  { tag: [tags.heading], color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: [tags.link, tags.url], color: "var(--syn-string)", textDecoration: "underline" },
  { tag: [tags.emphasis], fontStyle: "italic" },
  { tag: [tags.strong], fontWeight: "600" },
  { tag: [tags.invalid], color: "var(--syn-invalid)" },
]);

/** The app's own tokens for everything that is not code. */
const look = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", color: "var(--l1)", backgroundColor: "var(--win)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--l1)", paddingBlock: "8px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--l1)" },
  ".cm-gutters": { backgroundColor: "var(--win)", color: "var(--l3)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px" },
  ".cm-activeLine": { backgroundColor: "var(--fill)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--l2)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--sel)" },
  ".cm-selectionMatch": { backgroundColor: "var(--fill2)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--fill3)", outline: "none" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--l3)", cursor: "pointer" },
  ".cm-target": { backgroundColor: "var(--target)" },
  ".cm-panels": { backgroundColor: "var(--win2)", color: "var(--l1)", borderColor: "var(--sep)" },
  ".cm-panels-bottom": { borderTop: ".5px solid var(--sep)" },
  ".cm-tooltip:has(> .cm-quote)": { border: "none", backgroundColor: "transparent" },
  ".cm-quote": { font: "500 12px var(--font, system-ui)", padding: "3px 9px", borderRadius: "var(--r-xs)", border: ".5px solid var(--sep)", backgroundColor: "var(--win2)", color: "var(--l1)", boxShadow: "var(--btn-sh)", cursor: "pointer", whiteSpace: "nowrap" },
  ".cm-quote:hover": { backgroundColor: "var(--fill2)" },
  ".cm-searchMatch": { backgroundColor: "var(--target)" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--sel)" },
  ".cm-textfield": { backgroundColor: "var(--field)", border: ".5px solid var(--field-bd)", borderRadius: "var(--r-xs)", color: "var(--l1)" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--btn)", border: "none", boxShadow: "var(--btn-sh)", borderRadius: "var(--r-xs)", color: "var(--l1)" },
});

/** The search panel's words in the app's language (CodeMirror's own are English). */
const phrases = (): Extension => {
  if (!i18n.language.startsWith("zh")) return [];
  return EditorState.phrases.of({
    Find: "查找",
    Replace: "替换为",
    next: "下一个",
    previous: "上一个",
    all: "全部",
    "match case": "区分大小写",
    regexp: "正则表达式",
    "by word": "全词匹配",
    replace: "替换",
    "replace all": "全部替换",
    close: "关闭",
    "Go to line": "跳到行",
    go: "前往",
    "Folded lines": "已折叠的行",
    "Unfolded lines": "已展开的行",
    "Fold line": "折叠",
    "Unfold line": "展开",
  });
};

/** A change that comes from outside the editor (the disk's version taken), not from typing. */
const outside = Annotation.define<boolean>();

/** The lines a link or a step pointed at, marked until the next ones. */
const mark = StateEffect.define<{ from: number; to: number } | null>();
const marked = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(lines, tr) {
    lines = lines.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(mark)) continue;
      if (!e.value) {
        lines = Decoration.none;
        continue;
      }
      const ranges = [];
      for (let n = tr.state.doc.lineAt(e.value.from).number; n <= tr.state.doc.lineAt(e.value.to).number; n++) ranges.push(Decoration.line({ class: "cm-target" }).range(tr.state.doc.line(n).from));
      lines = Decoration.set(ranges);
    }
    return lines;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** What adds the selection to the conversation: the file and the lines it spans, as they read now. */
export type Quote = (from: number, to: number, text: string) => void;

/** Adds the selection, whole lines named, to the conversation; nothing when nothing is selected. */
function quoteSelection(view: EditorView, quote: Quote): boolean {
  const r = view.state.selection.main;
  if (r.empty) return false;
  const doc = view.state.doc;
  const from = doc.lineAt(r.from).number;
  // A selection ending at a line's start does not take that line in.
  const end = doc.lineAt(r.to);
  const to = end.from === r.to && end.number > from ? end.number - 1 : end.number;
  quote(from, to, view.state.sliceDoc(r.from, r.to));
  view.dispatch({ selection: EditorSelection.cursor(r.head) });
  return true;
}

/** A button by the selection that adds it to the conversation. */
function quoteButton(quote: () => Quote | null) {
  return StateField.define<readonly Tooltip[]>({
    create: () => [],
    update(tips, tr) {
      if (!tr.docChanged && !tr.selection) return tips;
      const r = tr.state.selection.main;
      if (r.empty || !quote()) return [];
      return [{
        pos: r.head,
        above: r.head <= r.anchor,
        strictSide: false,
        arrow: false,
        create: (view) => {
          const dom = document.createElement("button");
          dom.className = "cm-quote";
          dom.textContent = i18n.t("session:doc.addToChat");
          // Not taking the focus (and the selection) from the editor.
          dom.onmousedown = (e) => e.preventDefault();
          dom.onclick = () => {
            const q = quote();
            if (q) quoteSelection(view, q);
          };
          return { dom };
        },
      }];
    },
    provide: (f) => showTooltip.computeN([f], (s) => s.field(f)),
  });
}

const language = new Compartment();
const writable = new Compartment();
const wrapping = new Compartment();


function stateOf(tab: Tab, save: () => void, editable: boolean, quote: () => Quote | null): EditorState {
  const text = tab.doc?.text ?? tab.read?.text ?? "";
  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(colours),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (save(), true) }, { key: "Mod-l", preventDefault: true, run: (v) => { const q = quote(); return !!q && quoteSelection(v, q); } }, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
    // A file of \r\n lines keeps them when it is saved.
    text.includes("\r\n") ? EditorState.lineSeparator.of("\r\n") : [],
    language.of([]),
    writable.of(EditorState.readOnly.of(!editable)),
    // Long lines wrap in prose (Markdown, plain text), not in code.
    wrapping.of(wraps(tab.name) ? EditorView.lineWrapping : []),
    marked,
    quoteButton(quote),
    look,
    phrases(),
    EditorView.updateListener.of((u) => {
      // sliceDoc joins the lines with the file's own line end (doc.toString() always uses \n).
      if (u.docChanged && !u.transactions.some((tr) => tr.annotation(outside))) tab.doc?.edit(u.state.sliceDoc());
    }),
  ];
  return EditorState.create({ doc: text, extensions });
}

/** A tab's language, found by its file's name and loaded the first time. */
function loadLanguage(view: EditorView, tab: Tab, shown: { current: Tab | null }) {
  const found = LanguageDescription.matchFilename(languages, tab.name);
  if (!found) return;
  void found.load().then((support) => {
    if (shown.current === tab) view.dispatch({ effects: language.reconfigure(support) });
    // Kept with the tab's state for the next time it comes forward.
    else if (tab.editor) tab.editor = (tab.editor as EditorState).update({ effects: language.reconfigure(support) }).state;
  });
}

/** Moves to the lines a tab was opened at, marks them, and puts the cursor at their start. */
function goTo(view: EditorView, line: number, endLine?: number) {
  const doc = view.state.doc;
  const from = doc.line(Math.min(Math.max(1, line), doc.lines));
  const to = doc.line(Math.min(Math.max(from.number, endLine ?? line), doc.lines));
  view.dispatch({
    selection: EditorSelection.cursor(from.from),
    effects: [mark.of({ from: from.from, to: to.from }), EditorView.scrollIntoView(from.from, { y: "start", yMargin: 80 })],
  });
}

/** The target each tab was last moved to. */
const went = new WeakMap<Tab, number>();

export default function Editor({ tab, editable, onSave, onQuote }: { tab: Tab; editable: boolean; onSave: (tab: Tab) => void; onQuote?: Quote }) {
  // The tabs' states outlive this view: they ask for the latest.
  const quote = useRef(onQuote);
  quote.current = onQuote;
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const shown = useRef<Tab | null>(null);
  const replaced = useRef(0);

  // One view for the panel's life; the tab in front keeps its state when it goes. Made before
  // the layout effect below puts the first tab in it.
  useLayoutEffect(() => {
    const v = new EditorView({ parent: box.current! });
    view.current = v;
    // ⌘F is the app menu's Search: while the editor has the focus, it is the editor's own (file-panel-design §5).
    const find = () => v.hasFocus && openSearchPanel(v);
    window.addEventListener("finx:find", find);
    return () => {
      const tab = shown.current;
      if (tab) {
        tab.editor = v.state;
        tab.scroll = v.scrollDOM.scrollTop;
      }
      window.removeEventListener("finx:find", find);
      v.destroy();
      view.current = null;
      shown.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const v = view.current;
    if (!v || shown.current === tab) return;
    const before = shown.current;
    if (before) {
      before.editor = v.state;
      before.scroll = v.scrollDOM.scrollTop;
    }
    v.setState((tab.editor as EditorState | null) ?? stateOf(tab, () => onSave(tab), editable, () => quote.current ?? null));
    shown.current = tab;
    replaced.current = tab.doc?.replaced ?? 0;
    v.scrollDOM.scrollTop = tab.scroll;
    loadLanguage(v, tab, shown);
  });

  // The disk's version taken: in as one change, the cursor kept where it can be.
  useEffect(() => {
    const v = view.current;
    if (!v || !tab.doc || tab.doc.replaced === replaced.current) return;
    replaced.current = tab.doc.replaced;
    const head = Math.min(v.state.selection.main.head, tab.doc.text.length);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: tab.doc.text }, selection: EditorSelection.cursor(head), annotations: [outside.of(true)] });
  });

  // The lines it was opened at, each time it is opened at some (not again when it only comes forward).
  useEffect(() => {
    const v = view.current;
    if (!v || !tab.target || went.get(tab) === tab.target.seq) return;
    went.set(tab, tab.target.seq);
    goTo(v, tab.target.line, tab.target.endLine);
  });

  // Read-only once a save is refused, or for a file not to be written back.
  useEffect(() => {
    view.current?.dispatch({ effects: writable.reconfigure(EditorState.readOnly.of(!editable)) });
  }, [editable, tab]);

  return <div className="fpn-editor" ref={box} />;
}
