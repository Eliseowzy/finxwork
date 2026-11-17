import type { Attachment } from "./attachments";

export type Draft = { text: string; attachments: Attachment[] };

/**
 * What the owner had written in a composer and not sent yet, kept per session or bot and
 * across restarts of the app (localStorage). An empty draft is forgotten. Writes are
 * batched to the next idle moment so typing stays cheap.
 */
export class Drafts {
  private readonly map: Map<string, Draft>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly key: string;

  constructor(key: string) {
    this.key = key;
    this.map = new Map(load(key));
    window.addEventListener("beforeunload", () => this.flush());
  }

  get(id: string): Draft | undefined {
    return this.map.get(id);
  }

  set(id: string, d: Draft): void {
    if (!d.text && d.attachments.length === 0) this.map.delete(id);
    else this.map.set(id, d);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  private flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const all = [...this.map];
    try {
      localStorage.setItem(this.key, JSON.stringify(all));
    } catch {
      // Too big (pasted images): keep the words at least.
      try {
        localStorage.setItem(this.key, JSON.stringify(all.map(([id, d]) => [id, { text: d.text, attachments: [] }])));
      } catch {
        /* nothing more to do */
      }
    }
  }
}

function load(key: string): [string, Draft][] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v.filter((e) => Array.isArray(e) && typeof e[0] === "string" && typeof e[1]?.text === "string" && Array.isArray(e[1]?.attachments)) : [];
  } catch {
    return [];
  }
}
