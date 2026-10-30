import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { LexicalTypeaheadMenuPlugin, MenuOption, type MenuTextMatch } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { mergeRegister } from "@lexical/utils";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  BLUR_COMMAND,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_LOW,
  COMMAND_PRIORITY_NORMAL,
  HISTORY_MERGE_TAG,
  KEY_ENTER_COMMAND,
  SELECTION_CHANGE_COMMAND,
  TextNode,
  type ElementNode,
  type LexicalEditor,
} from "lexical";
import { isMentionable, mentions } from "@finx/client";
import type { CommandInfo } from "@finx/protocol";
import { Icon } from "../icons";
import { $createSkillNode, $isSkillNode, CommandsContext, SkillNode } from "./SkillNode";

export type EditorHandle = { focus: () => void };

/**
 * The composer's text, on Lexical's plain text mode. It holds plain text, as the composer
 * did before; a skill mentioned as `/skill:name` shows as a tag (SkillNode). Typing `/`
 * where a mention may start opens a menu of the session's commands: at the start the
 * built-in ones and the skills, elsewhere the skills. Tags follow the text exactly as the
 * kernel reads it (docs/kernel/skill-design.md §6.3): a tag is where a skill will be loaded.
 */
export const PromptEditor = forwardRef<EditorHandle, {
  value: string;
  onChange: (text: string) => void;
  /** ↩, or ⌥↩ for a follow-up; whether anything is sent is the composer's call. */
  onEnter: (followUp: boolean) => void;
  placeholder: string;
  label: string;
  commands: CommandInfo[];
}>(function PromptEditor({ value, onChange, onEnter, placeholder, label, commands }, ref) {
  const known = useMemo(() => skillNames(commands), [commands]);
  const knownRef = useRef(known);
  knownRef.current = known;
  const initial = useMemo(
    () => ({
      namespace: "composer",
      nodes: [SkillNode],
      theme: { paragraph: "cmp-p" },
      onError: (error: Error) => console.error(error),
      // The first value only: later ones arrive through ValuePlugin.
      editorState: () => $importText(value, knownRef.current),
    }),
    [],
  );
  return (
    <CommandsContext.Provider value={commands}>
      <LexicalComposer initialConfig={initial}>
        <div className="cmp-ed">
          <PlainTextPlugin
            contentEditable={<ContentEditable className="cmp-in" aria-label={label} aria-placeholder={placeholder} placeholder={<div className="cmp-ph">{placeholder}</div>} />}
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <HistoryPlugin />
        <ValuePlugin value={value} onChange={onChange} known={knownRef} />
        <TagsPlugin known={known} />
        <KeysPlugin onEnter={onEnter} />
        <MenuPlugin commands={commands} />
        <Handle ref={ref} />
      </LexicalComposer>
    </CommandsContext.Provider>
  );
});

/** The skills of `commands`, by the name a mention writes. */
function skillNames(commands: CommandInfo[]): Set<string> {
  return new Set(commands.flatMap((c) => (c.skill && c.name.startsWith("skill:") ? [c.name.slice("skill:".length)] : [])));
}

/** The editor's text: a tag is `/skill:name`, lines are joined with `\n`. */
function $exportText(): string {
  return $getRoot()
    .getChildren()
    .map((p) => p.getTextContent())
    .join("\n");
}

/** Replaces the editor's content with `text`, mentions of known skills as tags. */
function $importText(text: string, known: Set<string>) {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  text.split("\n").forEach((line, i) => {
    if (i > 0) paragraph.append($createLineBreakNode());
    if (line !== "") paragraph.append($createTextNode(line));
  });
  root.append(paragraph);
  $reconcileTags(paragraph, known, true);
}

/**
 * Makes the tags of `paragraph` match its text: a tag for each mention of a known skill,
 * plain text everywhere else. A tag that no longer stands as a mention (a letter typed right
 * after it, say) turns back into text. Unless `force`, a mention that ends at the caret is
 * left as text while it is being typed: it becomes a tag once the caret moves on.
 */
function $reconcileTags(paragraph: ElementNode, known: Set<string>, force: boolean) {
  for (let guard = 0; guard < 1000; guard += 1) {
    const pieces: { node: ReturnType<ElementNode["getChildren"]>[number]; start: number; end: number }[] = [];
    let text = "";
    for (const node of paragraph.getChildren()) {
      const t = node.getTextContent();
      pieces.push({ node, start: text.length, end: text.length + t.length });
      text += t;
    }
    const found = mentions(text).filter((m) => known.has(m.name));
    const stale = pieces.find(({ node, start, end }) => $isSkillNode(node) && !found.some((m) => m.start === start && m.end === end && m.name === node.getName()));
    if (stale) {
      stale.node.replace($createTextNode(stale.node.getTextContent()));
      continue;
    }
    const selection = $getSelection();
    const typing = (key: string, offset: number) =>
      !force && $isRangeSelection(selection) && selection.isCollapsed() && selection.anchor.key === key && selection.anchor.offset === offset;
    const pending = found
      .map((m) => ({ m, piece: pieces.find((p) => p.start <= m.start && m.end <= p.end && $isTextNode(p.node) && p.node.isSimpleText()) }))
      .find(({ m, piece }) => piece !== undefined && !typing(piece.node.getKey(), m.end - piece.start));
    if (!pending?.piece) return;
    const { m, piece } = pending;
    const parts = (piece.node as TextNode).splitText(m.start - piece.start, m.end - piece.start);
    (m.start === piece.start ? parts[0] : parts[1]).replace($createSkillNode(m.name));
  }
}

function $reconcileAll(known: Set<string>, force: boolean) {
  for (const paragraph of $getRoot().getChildren()) {
    if ("getChildren" in paragraph) $reconcileTags(paragraph as ElementNode, known, force);
  }
}

/** Keeps the editor and the composer's text in step: edits go out, a new text (another draft, a cleared composer) comes in. */
function ValuePlugin({ value, onChange, known }: { value: string; onChange: (text: string) => void; known: RefObject<Set<string>> }) {
  const [editor] = useLexicalComposerContext();
  const sent = useRef(value);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
        const text = editorState.read($exportText);
        if (text !== sent.current) {
          sent.current = text;
          latest.current(text);
        }
      }),
    [editor],
  );
  useEffect(() => {
    if (value === sent.current) return;
    sent.current = value;
    editor.update(
      () => {
        $importText(value, known.current);
        $getRoot().selectEnd();
      },
      { tag: HISTORY_MERGE_TAG },
    );
    // A different text, not an edit of this one: nothing to undo into.
    editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
  }, [editor, value, known]);
  return null;
}

/** Turns mentions into tags as text changes, when the caret leaves one, and when the known skills arrive. */
function TagsPlugin({ known }: { known: Set<string> }) {
  const [editor] = useLexicalComposerContext();
  const latest = useRef(known);
  latest.current = known;
  useEffect(
    () =>
      mergeRegister(
        editor.registerNodeTransform(TextNode, (node) => {
          const parent = node.getParent();
          if (parent) $reconcileTags(parent, latest.current, false);
        }),
        editor.registerNodeTransform(SkillNode, (node) => {
          const parent = node.getParent();
          if (parent) $reconcileTags(parent, latest.current, false);
        }),
        editor.registerCommand(
          SELECTION_CHANGE_COMMAND,
          () => {
            $reconcileAll(latest.current, false);
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
        editor.registerCommand(
          BLUR_COMMAND,
          () => {
            editor.update(() => $reconcileAll(latest.current, true), { tag: HISTORY_MERGE_TAG });
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
      ),
    [editor],
  );
  useEffect(() => {
    editor.update(() => $reconcileAll(known, false), { tag: HISTORY_MERGE_TAG });
  }, [editor, known]);
  return null;
}

/** ↩ sends and ⌥↩ sends as a follow-up, unless an input method composes; ⇧↩ breaks the line. */
function KeysPlugin({ onEnter }: { onEnter: (followUp: boolean) => void }) {
  const [editor] = useLexicalComposerContext();
  const latest = useRef(onEnter);
  latest.current = onEnter;
  useEffect(
    () =>
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (event === null || event.shiftKey) return false;
          if (event.isComposing) return true;
          event.preventDefault();
          if (!event.metaKey && !event.ctrlKey) latest.current(event.altKey);
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
    [editor],
  );
  return null;
}

class CommandOption extends MenuOption {
  command: CommandInfo;
  constructor(command: CommandInfo) {
    super(command.name);
    this.command = command;
  }
}

/** Where a typed `/` may start a command: as a mention may, not inside a path, a date or an address. */
const TRIGGER = /(^|[^A-Za-z0-9/\\.:~_\-@#%&=?+$*])(\/((?:skill:)?[A-Za-z0-9_-]*))$/;

/** The commands for `query`: names that start with it first, then names and descriptions that contain it. Built-in commands only at the start of the input. */
function matching(commands: CommandInfo[], query: string, atStart: boolean): CommandInfo[] {
  const q = query.replace(/^skill:/, "").toLowerCase();
  const scored = commands.flatMap((c) => {
    const name = c.skill ? c.name.slice("skill:".length) : c.name;
    if (c.skill ? !isMentionable(name) : !atStart) return [];
    const n = name.toLowerCase();
    const score = n.startsWith(q) ? 0 : n.includes(q) ? 1 : c.description.toLowerCase().includes(q) ? 2 : -1;
    return score < 0 ? [] : [{ c, score }];
  });
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, 12)
    .map((x) => x.c);
}

/**
 * The `/` menu. It is open only while it has something to offer, so that otherwise the arrow
 * keys and Escape act on the text; while open, it takes ↩ and ⇥ before KeysPlugin does.
 */
function MenuPlugin({ commands }: { commands: CommandInfo[] }) {
  const { t } = useTranslation("session");
  const [editor] = useLexicalComposerContext();
  const latest = useRef(commands);
  latest.current = commands;
  // What the trigger found, for the query it reports right after.
  const found = useRef<CommandInfo[]>([]);
  const [options, setOptions] = useState<CommandOption[]>([]);
  const trigger = useCallback((text: string): MenuTextMatch | null => {
    const m = TRIGGER.exec(text);
    if (!m) return null;
    const leadOffset = m.index + m[1].length;
    found.current = matching(latest.current, m[3], $isAtStart(text.slice(0, leadOffset)));
    return found.current.length === 0 ? null : { leadOffset, matchingString: m[3], replaceableString: m[2] };
  }, []);
  const onQueryChange = useCallback((query: string | null) => {
    setOptions((shown) => (query !== null ? found.current.map((c) => new CommandOption(c)) : shown.length === 0 ? shown : []));
  }, []);
  return (
    <LexicalTypeaheadMenuPlugin<CommandOption>
      options={options}
      triggerFn={trigger}
      onQueryChange={onQueryChange}
      commandPriority={COMMAND_PRIORITY_NORMAL}
      onSelectOption={(option, node, close) => {
        $insertCommand(option.command, node);
        close();
      }}
      menuRenderFn={(anchor, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex, options: shown }) =>
        anchor.current && shown.length > 0
          ? createPortal(<CommandMenu editor={editor} options={shown} selected={selectedIndex} onPick={selectOptionAndCleanUp} onHover={setHighlightedIndex} label={t("composer.commands")} />, document.body)
          : null
      }
    />
  );
}

/** Whether only blanks come before a `/` whose text node starts with `before`: where the kernel reads a built-in command. */
function $isAtStart(before: string): boolean {
  if (before.trim() !== "") return false;
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  const node = selection.anchor.getNode();
  for (let prev = node.getPreviousSibling(); prev !== null; prev = prev.getPreviousSibling()) {
    if (prev.getTextContent().trim() !== "") return false;
  }
  const paragraph = node.getParent();
  return paragraph !== null && paragraph.getPreviousSibling() === null;
}

/** Puts the chosen command where `/query` was: a skill as a tag followed by a space, a built-in command as text. */
function $insertCommand(command: CommandInfo, node: TextNode | null) {
  if (node === null) return;
  if (!command.skill) {
    const text = $createTextNode(`/${command.name} `);
    node.replace(text);
    text.select(text.getTextContentSize(), text.getTextContentSize());
    return;
  }
  const tag = $createSkillNode(command.name.slice("skill:".length));
  const before = node.getPreviousSibling()?.getTextContent().slice(-1) ?? "";
  node.replace(tag);
  // Right after a letter or a tag, a mention would not stand on its own.
  if (/[A-Za-z0-9/\\.:~_\-@#%&=?+$*]/.test(before)) tag.insertBefore($createTextNode(" "));
  const space = $createTextNode(" ");
  tag.insertAfter(space);
  space.select(1, 1);
}

/** The menu above the caret (the composer sits at the window's bottom), keyboard driven by the editor. */
function CommandMenu({ editor, options, selected, onPick, onHover, label }: {
  editor: LexicalEditor;
  options: CommandOption[];
  selected: number | null;
  onPick: (option: CommandOption) => void;
  onHover: (index: number) => void;
  label: string;
}) {
  const caret = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0).getBoundingClientRect() : null;
  const root = editor.getRootElement()?.getBoundingClientRect();
  const left = caret && caret.left > 0 ? caret.left : (root?.left ?? 0);
  const top = caret && caret.top > 0 ? caret.top : (root?.top ?? 0);
  return (
    <div className="vmenu cmd-menu" role="listbox" aria-label={label} style={{ left: Math.max(8, Math.min(left - 12, innerWidth - 368)), bottom: innerHeight - top + 6 }}>
      {options.map((option, i) => {
        const c = option.command;
        const name = c.skill ? c.name.slice("skill:".length) : `/${c.name}`;
        return (
          <button
            key={option.key}
            id={`typeahead-item-${i}`}
            ref={option.setRefElement}
            className={`mi${selected === i ? " open" : ""}`}
            role="option"
            aria-selected={selected === i}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(option)}
          >
            <Icon name={c.skill ? "cube" : "bolt"} />
            <span className="two">
              {name}
              <span>{c.description}</span>
            </span>
            {c.hint && <span className="val">{c.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Lets the composer put the caret in the editor. */
const Handle = forwardRef<EditorHandle>(function Handle(_, ref) {
  const [editor] = useLexicalComposerContext();
  useImperativeHandle(ref, () => ({ focus: () => editor.focus() }), [editor]);
  return null;
});
