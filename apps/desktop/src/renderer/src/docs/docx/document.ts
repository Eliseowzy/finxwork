import type { WordFile, WordKernelState, WordWriteResult } from "./kernel.ts";

// A Word document in a tab: the kernel's, with the editor as its replica (word-design §6). The
// kernel writes the file; this tracks how the tab's edits stand (the unsaved dot, saving, a
// conflict to settle) as PresentationDoc does for a kernel-held deck.
export type WordState = "clean" | "dirty" | "saving" | "conflict" | "failed" | "refused";
export type WordSurface = { element: HTMLElement; dispose(): void };

export class WordDoc {
  file: WordFile;
  state: WordState = "clean";
  message: string | null = null;
  savedAt: number | null = null;
  surface: WordSurface | null = null;
  /** Typed text the editor still holds back; flushed before a save. */
  prepare: (() => Promise<void>) | null = null;
  generation = 0;
  revision = 0;
  private savedRevision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private disposed = false;
  private stopKernel: (() => void) | null = null;
  private changed: () => void;

  constructor(file: WordFile, changed: () => void) {
    this.changed = changed;
    this.file = file;
    if (file.recoveredDirty) this.revision = 1;
    if (this.dirty) this.state = "dirty";
    this.follow();
  }
  get kernel() { return this.file.kernel; }
  get dirty() { return this.revision !== this.savedRevision; }
  get stuck() { return this.state === "conflict" || this.state === "refused"; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { this.changed(); this.listeners.forEach((f) => f()); }

  private follow() {
    this.stopKernel?.();
    this.stopKernel = this.file.kernel.onState((s) => this.kernelState(s));
  }

  /** Changes the editor did not make (the agent's) show as unsaved; a save made elsewhere as saved. */
  kernelState(state: WordKernelState) {
    if (this.disposed || this.stuck || this.state === "saving" || this.running) return;
    if (state.dirty && !this.dirty) {
      this.revision = this.savedRevision + 1;
      this.state = "dirty";
      this.emit();
    } else if (!state.dirty && this.dirty && this.timer === undefined && !this.kernel.pending) {
      this.savedRevision = this.revision;
      this.savedAt = Date.now();
      this.state = "clean";
      this.emit();
    }
  }

  /** A local edit: saved a moment later. */
  edit() {
    if (this.disposed || !this.file.writable) return;
    this.revision++;
    if (!this.stuck && this.state !== "saving") this.state = "dirty";
    this.emit();
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.stuck) this.timer = setTimeout(() => void this.flush(), 1200);
  }

  /** Saves now (⌘S, the tab closing). */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) return this.running;
    if (this.disposed || this.stuck || !this.file.writable) return Promise.resolve();
    this.running = this.save({}).finally(() => { this.running = null; });
    return this.running;
  }

  /** "Overwrite": the conflict is settled in favour of these edits. */
  overwrite(): Promise<void> {
    if (this.running || this.disposed || this.state !== "conflict") return this.running ?? Promise.resolve();
    this.state = "dirty";
    this.running = this.save({ force: true }).finally(() => { this.running = null; });
    return this.running;
  }

  /** A copy elsewhere (a read-only file's only way out); this tab stays on its own file. */
  async saveAs(path: string): Promise<WordWriteResult> {
    await this.prepare?.();
    return this.kernel.save({ path });
  }

  private async save(options: { force?: boolean }) {
    let first = true;
    while ((this.dirty || first) && !this.stuck && !this.disposed) {
      first = false;
      const revision = this.revision;
      this.state = "saving";
      this.message = null;
      this.emit();
      try {
        await this.prepare?.();
        this.settle(revision, await this.kernel.save(options));
      } catch (error) {
        this.state = "failed";
        this.message = error instanceof Error ? error.message : String(error);
        this.emit();
        return;
      }
      this.emit();
    }
  }

  private settle(revision: number, result: WordWriteResult) {
    if (result.status === "saved") {
      if (result.hash) this.file = { ...this.file, hash: result.hash };
      this.savedRevision = revision;
      this.savedAt = Date.now();
      this.state = this.dirty ? "dirty" : "clean";
    } else {
      this.state = result.status;
      this.message = result.message ?? null;
    }
  }

  /** The file changed on disk: with unsaved edits, a choice; without, the caller reloads. Whether it reloads. */
  diskChanged(hash: string | null): boolean {
    if (this.disposed || hash === this.file.hash || this.state === "saving") return false;
    if (!this.dirty && hash) return true;
    clearTimeout(this.timer);
    this.state = "conflict";
    this.message = null;
    this.emit();
    return false;
  }

  /** "Reload": the editor starts again on the kernel's document as now opened. */
  takeDisk(next: WordFile) {
    if (this.running) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.surface?.dispose();
    this.surface = null;
    this.prepare = null;
    if (this.file.kernel !== next.kernel) this.file.kernel.close();
    this.file = next;
    this.generation++;
    this.revision = this.savedRevision = 0;
    if (next.recoveredDirty) this.revision = 1;
    this.state = this.dirty ? "dirty" : "clean";
    this.message = null;
    this.follow();
    this.emit();
  }

  dispose() {
    this.stopKernel?.();
    this.file.kernel.close();
    this.disposed = true;
    clearTimeout(this.timer);
    this.surface?.dispose();
    this.surface = null;
    this.prepare = null;
    this.listeners.clear();
  }
}
