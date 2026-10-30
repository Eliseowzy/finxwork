import fs from "node:fs";
import path from "node:path";

// What git says about a folder, read from the repository's own files: no
// git binary to run (on a Mac without the developer tools, running one asks
// to install them).

/**
 * The branch checked out where `dir` lies: its name, the commit's short id
 * when HEAD is detached, or null outside a repository. A worktree's `.git`
 * is a file naming its own git directory, which holds its HEAD.
 */
export async function gitBranch(dir: string): Promise<string | null> {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const head = await headOf(path.join(d, ".git"));
    if (head !== undefined) return head;
    if (path.dirname(d) === d) return null;
  }
}

/** The HEAD of the git directory `.git` names, undefined when there is none there. */
async function headOf(dotGit: string): Promise<string | null | undefined> {
  const stat = await fs.promises.stat(dotGit).catch(() => null);
  if (!stat) return undefined;
  let gitDir = dotGit;
  if (stat.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(await fs.promises.readFile(dotGit, "utf8").catch(() => ""));
    if (!m) return undefined;
    gitDir = path.resolve(path.dirname(dotGit), m[1].trim());
  }
  const head = (await fs.promises.readFile(path.join(gitDir, "HEAD"), "utf8").catch(() => "")).trim();
  if (!head) return null;
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (ref) return ref[1];
  return /^[0-9a-f]{7,}$/.test(head) ? head.slice(0, 7) : null;
}
