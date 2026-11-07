# End-to-end scripts

Each script drives the real app and the real kernel, each in a home of its own. Run them through `run.mjs`: it picks what a change calls for, builds once, runs them side by side and behind whatever you are doing.

```bash
node apps/desktop/e2e/run.mjs
```

| What changed | What runs |
| --- | --- |
| Docs, assets | Nothing |
| Styles, words, unit tests, the scripts' own helpers | Type check and unit tests; styles and words are listed for a look at a running page |
| Anything with behaviour | The above, then the scripts that answer for those files (`lib/manifest.mjs`) |
| Files no script answers for | The above, then the basic scripts, and it says which files |

`--list` says what would run and runs nothing. `--since origin/main` counts the branch's commits as well. `--all` is the check before a merge or a release; it sends a notification when it ends.

```bash
node apps/desktop/e2e/run.mjs --all --foreground
```

## Behind your work

`run.mjs` sets `FINXWORK_E2E_BACKGROUND=1`. The app then has no Dock icon and never becomes the active app, and its windows cannot be seen or clicked (`src/main/windows.ts`). Pages still paint, animate and take input from the script, and they are told they have the focus. While scripts run, the runner watches which app is in front, and one of its apps coming forward fails that script.

Some scripts cannot run this way, and `lib/manifest.mjs` says why for each: a real Chrome window, the system clipboard, the pointer, or checking which window really has the keyboard. These run only with `--foreground` or by name, one at a time, and take the screen.

## A new script

Add a line to `lib/manifest.mjs` with the paths it answers for, and get the debugging port from `cdpPort()` in `lib/port.mjs`, so scripts running side by side never reach each other's app. Do not write to anything shared on the Mac in a script that runs in the background.
