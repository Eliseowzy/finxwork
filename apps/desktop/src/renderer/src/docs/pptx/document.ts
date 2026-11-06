// A browser-owned presentation session. Its editor stays alive when the file panel is
// hidden; writes are serialized and always checked against the version opened from disk.
export type PresentationFile = { data: string; hash: string; writable: boolean; font_families: string[] };
export type PresentationState = "clean" | "dirty" | "saving" | "conflict" | "deleted" | "failed" | "refused";
type WriteResult = { status: "saved" | "conflict" | "refused"; hash?: string | null; message?: string | null };
export type PresentationSurface = { element: HTMLElement; dispose(): void };

export const fromBase64 = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 32768) parts.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return btoa(parts.join(""));
}

export class PresentationDoc {
  file: PresentationFile;
  bytes: Uint8Array;
  state: PresentationState = "clean";
  message: string | null = null;
  savedAt: number | null = null;
  surface: PresentationSurface | null = null;
  serialize: (() => Promise<Uint8Array>) | null = null;
  prepare: (() => Promise<void>) | null = null;
  generation = 0;
  revision = 0;
  private savedRevision = 0;
  private savedBytes: Uint8Array;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private disposed = false;
  private write: (data: string, base: string) => Promise<WriteResult>;
  private changed: () => void;

  constructor(file: PresentationFile, write: (data: string, base: string) => Promise<WriteResult>, changed: () => void) {
    this.write = write;
    this.changed = changed;
    this.file = file;
    this.bytes = fromBase64(file.data);
    this.savedBytes = this.bytes;
  }
  get dirty() { return this.revision !== this.savedRevision; }
  get stuck() { return ["conflict", "deleted", "refused"].includes(this.state); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { this.changed(); this.listeners.forEach((f) => f()); }
  edit() {
    if (this.disposed || !this.file.writable) return;
    this.revision++;
    if (!this.stuck && this.state !== "saving") this.state = "dirty";
    this.emit();
    clearTimeout(this.timer);
    if (!this.stuck) this.timer = setTimeout(() => void this.flush(), 1200);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.running) return this.running;
    if (this.disposed || this.stuck || !this.serialize) return Promise.resolve();
    this.running = this.save().finally(() => { this.running = null; });
    return this.running;
  }
  private async save() {
    try { await this.prepare?.(); }
    catch (error) {
      this.state = "failed";
      this.message = error instanceof Error ? error.message : String(error);
      this.emit();
      return;
    }
    let verify = true;
    while ((this.dirty || verify) && !this.stuck && !this.disposed && this.file.writable && this.serialize) {
      const revision = this.revision;
      this.state = "saving";
      this.message = null;
      this.emit();
      try {
        const bytes = await this.serialize();
        verify = false;
        if (bytes.length === this.savedBytes.length && bytes.every((value, index) => value === this.savedBytes[index])) {
          this.savedRevision = revision;
          this.state = this.dirty ? "dirty" : "clean";
          this.emit();
          continue;
        }
        const result = await this.write(toBase64(bytes), this.file.hash);
        if (result.status === "saved" && result.hash) {
          this.file = { ...this.file, hash: result.hash };
          this.savedRevision = revision;
          this.savedBytes = bytes;
          this.savedAt = Date.now();
          this.state = this.dirty ? "dirty" : "clean";
        } else {
          this.state = result.status === "conflict" ? (result.hash ? "conflict" : "deleted") : "refused";
          this.message = result.message ?? null;
        }
      } catch (error) {
        this.state = "failed";
        this.message = error instanceof Error ? error.message : String(error);
        this.emit();
        return;
      }
      this.emit();
    }
  }
  diskChanged(next: PresentationFile | null) {
    if (this.disposed || next?.hash === this.file.hash || this.state === "saving") return;
    if (!next) this.state = "deleted";
    else if (this.dirty) this.state = "conflict";
    else return this.takeDisk(next);
    clearTimeout(this.timer);
    this.emit();
  }
  takeDisk(next: PresentationFile) {
    if (this.running) return;
    clearTimeout(this.timer);
    this.surface?.dispose();
    this.surface = null;
    this.serialize = null;
    this.prepare = null;
    this.file = next;
    this.bytes = fromBase64(next.data);
    this.savedBytes = this.bytes;
    this.generation++;
    this.revision = this.savedRevision = 0;
    this.state = "clean";
    this.message = null;
    this.emit();
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.surface?.dispose();
    this.surface = null;
    this.serialize = null;
    this.prepare = null;
    this.listeners.clear();
  }
}
