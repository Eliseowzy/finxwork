# Privacy

**No telemetry and no crash reports.** This is every place finx goes on the network:

| Where | When | How to turn it off |
|---|---|---|
| Your model provider | Tasks; checking a key; `--refresh`; once a day under `finx serve` | Use a local model; `models.network = false` for the background refresh |
| models.dev | `finx models --refresh`; once a day under `finx serve` | `models.network = false` |
| A web search service | When the model calls `web_search`. **Without a key of yours, the search words go to Exa or Parallel** | `web_search.enabled = false` |
| MCP servers and where they sign in | If you configured them | Do not configure them |
| GitHub (the release repository) | `finx upgrade`, `finx install`; the interactive mode looks for a new release once a day | `update.check = false` |
| Google's Chrome for Testing address | `finx install browser` | Do not install it |
| What the model runs or opens | Commands and web pages, under your permission mode and site permissions | [permissions](permissions.md) |

`finx exec`, `finx serve` and `finx acp` never look for updates.

## What is kept, and where

Everything is under `~/.finx` (`FINX_HOME` moves it):

| Path | What |
|---|---|
| `config.toml`, `models.toml`, `trusted.toml` | Your settings |
| `sessions/` | Conversation logs, as JSON lines |
| `trash/sessions/` | Sessions you removed |
| `history.jsonl` | What you typed in conversations; `history.enabled = false` turns it off |
| `addons/`, `browser/`, `desktop/` | Components |
| `logs/` | Logs |

Keys are in the macOS keychain, or in a 0600 file on Linux and with `FINX_CREDENTIAL_STORE=file`. Commands the model runs do not get provider keys in their environment unless `tools.bash.pass_provider_keys` says so.

## Uninstalling

Delete the program, then `~/.finx` if you want your data gone. Keys in the macOS keychain are under the service name `finx`.
