// Cutting a byte stream of NDJSON into whole lines without parsing them
// (desktop-design §3.2): what arrives from finx's socket is passed on up to
// its last "\n"; the rest waits for the next chunk.

export class LineCutter {
  private rest = "";

  /** The whole lines in what came so far (with their "\n"), or "" when there is none yet. */
  push(chunk: string): string {
    const text = this.rest + chunk;
    const end = text.lastIndexOf("\n");
    if (end < 0) {
      this.rest = text;
      return "";
    }
    this.rest = text.slice(end + 1);
    return text.slice(0, end + 1);
  }
}
