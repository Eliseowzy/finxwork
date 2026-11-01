// Cutting a byte stream of NDJSON into whole lines without parsing them
// (desktop-design §3.2): what arrives from finx's socket is passed on up to
// its last "\n"; the rest waits for the next chunk. Only the new chunk is
// searched, and the rest is joined once its line ends: the socket brings a
// line of megabytes (a page of screenshots) in thousands of 8 KB chunks.

export class LineCutter {
  private rest: string[] = [];

  /** The whole lines in what came so far (with their "\n"), or "" when there is none yet. */
  push(chunk: string): string {
    const end = chunk.lastIndexOf("\n");
    if (end < 0) {
      if (chunk) this.rest.push(chunk);
      return "";
    }
    this.rest.push(chunk.slice(0, end + 1));
    const text = this.rest.join("");
    this.rest = end + 1 < chunk.length ? [chunk.slice(end + 1)] : [];
    return text;
  }
}
