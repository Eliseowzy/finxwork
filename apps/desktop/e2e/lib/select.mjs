// From what changed to what to run (e2e/run.mjs). Decides only; nothing here runs anything.
import { nothing, scripts, smoke, toLookAt, unitOnly } from "./manifest.mjs";

const scriptOf = /^apps\/desktop\/e2e\/([^./][^/]*)\.mjs$/;

/**
 * files: paths from the repository's root. Returns
 * level (0 nothing to run, 1 unit tests and types, 2 also end-to-end scripts), the scripts, those of
 * them that have to be asked for (foreground, manual), the files no script answers for, and the
 * files to look at.
 */
export function plan(files) {
  const chosen = new Set();
  const unmatched = [];
  let unit = false;
  for (const file of files) {
    if (nothing.some((p) => p.test(file))) continue;
    unit = true;
    if (unitOnly.some((p) => p.test(file))) continue;
    const named = file.match(scriptOf)?.[1];
    if (named && scripts[named]) {
      chosen.add(named);
      continue;
    }
    const answering = Object.entries(scripts).filter(([, s]) => s.covers.some((path) => covered(file, path)));
    if (answering.length === 0) unmatched.push(file);
    for (const [name] of answering) chosen.add(name);
  }
  if (unmatched.length > 0) for (const name of smoke) chosen.add(name);
  return {
    level: chosen.size > 0 ? 2 : unit ? 1 : 0,
    unit,
    ...split([...chosen].sort()),
    unmatched,
    look: files.filter((file) => toLookAt.some((p) => p.test(file))),
  };
}

/** The scripts a run takes, by what they need: behind the person's work, in front of it, or left for a person to ask for. */
export function split(names) {
  return {
    background: names.filter((n) => !scripts[n].foreground && !scripts[n].manual),
    foreground: names.filter((n) => scripts[n].foreground),
    manual: names.filter((n) => scripts[n].manual),
  };
}

function covered(file, path) {
  return path.endsWith("/") ? file.startsWith(path) : file === path || file.startsWith(path);
}
