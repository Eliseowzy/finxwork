// The SHA-256 of a catalog skill's files, the way finx computes it when it installs a skill
// (crates/finx-core/src/skills/install.rs, copy_into): each file in path order, its relative
// path, a zero byte, its bytes, a zero byte. The build checks it against src/shared/catalog.ts;
// run this file to print the values to put there.
//
//   node scripts/catalog-hash.mjs

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const catalogSkillsDir = path.resolve(import.meta.dirname, "../resources/catalog/skills");

/** Relative paths of the files under `dir`, ordered as finx orders paths: component by component. */
function files(dir, rel = []) {
  return fs.readdirSync(path.join(dir, ...rel), { withFileTypes: true }).flatMap((e) => {
    if (e.name === ".finx-source.json" || e.name === ".DS_Store") return [];
    return e.isDirectory() ? files(dir, [...rel, e.name]) : e.isFile() ? [[...rel, e.name]] : [];
  });
}

function compare(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = Buffer.from(a[i]);
    const y = Buffer.from(b[i]);
    const c = Buffer.compare(x, y);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** `{ sha256, files }` of the skill in `dir`. */
export function skillHash(dir) {
  const list = files(dir).sort(compare);
  const h = crypto.createHash("sha256");
  for (const parts of list) {
    h.update(parts.join("/"));
    h.update(Buffer.from([0]));
    h.update(fs.readFileSync(path.join(dir, ...parts)));
    h.update(Buffer.from([0]));
  }
  return { sha256: h.digest("hex"), files: list.length };
}

/** The skill folders in the catalog; none, and no folder, while the catalog has no skills. */
function skillFolders() {
  if (!fs.existsSync(catalogSkillsDir)) return [];
  return fs.readdirSync(catalogSkillsDir).filter((n) => fs.statSync(path.join(catalogSkillsDir, n)).isDirectory());
}

/** Each catalog entry whose files differ from what catalog.ts says, as messages. */
export function catalogProblems(entries) {
  const problems = [];
  const found = new Set(skillFolders());
  for (const e of entries) {
    if (!found.delete(e.id)) {
      problems.push(`${e.id}: no folder resources/catalog/skills/${e.id}`);
      continue;
    }
    const { sha256, files } = skillHash(path.join(catalogSkillsDir, e.id));
    if (sha256 !== e.sha256 || files !== e.files) problems.push(`${e.id}: files are sha256 ${sha256} (${files} files); catalog.ts says ${e.sha256} (${e.files})`);
  }
  for (const extra of found) problems.push(`${extra}: a folder that catalog.ts does not list`);
  return problems;
}

if (import.meta.main) {
  for (const id of skillFolders().sort()) console.log(id, JSON.stringify(skillHash(path.join(catalogSkillsDir, id))));
}
