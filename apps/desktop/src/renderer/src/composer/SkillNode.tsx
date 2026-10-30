import { createContext, useContext, type JSX } from "react";
import { DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from "lexical";
import { MENTION_PREFIX } from "@finx/client";
import type { CommandInfo } from "@finx/protocol";
import { Icon } from "../icons";

/** The commands of the session the editor writes to: the tags look up their descriptions. */
export const CommandsContext = createContext<CommandInfo[]>([]);

type SerializedSkillNode = Spread<{ name: string }, SerializedLexicalNode>;

/**
 * A skill mentioned in the composer: one unit, written `/skill:name` (what is sent, copied
 * and kept as a draft) and drawn as a tag with the skill's name. The caret steps over it;
 * Backspace and Delete take it away whole.
 */
export class SkillNode extends DecoratorNode<JSX.Element> {
  __name: string;

  static getType(): string {
    return "skill";
  }

  static clone(node: SkillNode): SkillNode {
    return new SkillNode(node.__name, node.__key);
  }

  static importJSON(json: SerializedSkillNode): SkillNode {
    return $createSkillNode(json.name);
  }

  constructor(name: string, key?: NodeKey) {
    super(key);
    this.__name = name;
  }

  exportJSON(): SerializedSkillNode {
    return { ...super.exportJSON(), name: this.__name };
  }

  createDOM(): HTMLElement {
    const host = document.createElement("span");
    host.className = "skill-tag-host";
    return host;
  }

  updateDOM(): false {
    return false;
  }

  isInline(): true {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return false;
  }

  getTextContent(): string {
    return MENTION_PREFIX + this.__name;
  }

  getName(): string {
    return this.getLatest().__name;
  }

  decorate(): JSX.Element {
    return <SkillTag name={this.__name} />;
  }
}

export function $createSkillNode(name: string): SkillNode {
  return new SkillNode(name);
}

export function $isSkillNode(node: LexicalNode | null | undefined): node is SkillNode {
  return node instanceof SkillNode;
}

/** A skill as a tag: its name, with its description on hover. Also drawn in the conversation. */
export function SkillTag({ name }: { name: string }) {
  const commands = useContext(CommandsContext);
  const description = commands.find((c) => c.name === `skill:${name}`)?.description;
  return (
    <span className="skill-tag" title={description ? `${MENTION_PREFIX}${name}\n${description}` : MENTION_PREFIX + name} contentEditable={false}>
      <Icon name="cube" className="sm" />
      {name}
    </span>
  );
}
