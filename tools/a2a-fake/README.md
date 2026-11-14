# a2a-fake

A dependency-free Node.js (ESM) A2A 1.0 peer for Rust and desktop end-to-end tests.
The wire format is the one in `docs/kernel/bot-contacts-design.md` §5 and 附录 B.2.

## Run

```sh
node tools/a2a-fake/server.mjs [--port N] [--host H] [--auth] [--no-streaming] [--provider] [--icon]
```

It prints exactly one line on stdout and then never writes to stdout again:

```
listening on http://localhost:9999
```

`PUBLIC_URL` sets the advertised base (default `http://localhost:9999`). With `--port 0` the
server binds a free port and the printed URL and the card carry the real port. The JSON-RPC
endpoint is the path of `PUBLIC_URL` (default `/a2a`); `POST /` is accepted as well.

| Flag | Meaning |
|---|---|
| `--port N` / `--host H` | Listen port and bind host; the advertised URL follows them |
| `--auth` | Card advertises an API key; a valid request needs `X-API-Key: test-key` |
| `--no-streaming` | `capabilities.streaming` is false and `SendStreamingMessage` returns `UNSUPPORTED_OPERATION` |
| `--provider` / `--icon` | Add `provider` / `iconUrl` to the card (`/icon.png` serves a 1×1 PNG) |

Routes: `GET /.well-known/agent-card.json`, `POST /` and `POST /a2a`, `GET /redirect`
(302 to `http://example.com/`), `GET /card-elsewhere` (card whose interface is on another host).

Every JSON-RPC request must carry `A2A-Version: 1.0`. Errors look like 附录 B.2:

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"Task not found","data":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"TASK_NOT_FOUND","domain":"a2a-protocol.org","metadata":{}}]}}
```

`SendStreamingMessage` answers `text/event-stream`; each `data:` line is one compact JSON-RPC
response wrapping `task`, `statusUpdate`, or `artifactUpdate`. `SendMessage` returns
`{"task": …}` directly. `GetTask` and `CancelTask` return a `Task` directly.

## Scenarios

The first text part, trimmed and lowercased, picks the scenario. Anything not listed is `hello`.
Context and task state are in-process, keyed by `contextId`; ids are UUIDs and stay stable.

| Trigger | Behaviour |
|---|---|
| anything (default), `hello` | `task` SUBMITTED → WORKING → artifact text fragments → empty `lastChunk` → COMPLETED whose `status.message` repeats the reply. The reply is `hello (n)` where `n` is the number of user messages in the context. A text asking what was said before (`what did i…`, `remember`, `said before`, `之前`, `刚才`, `记得`) also gets `; you said: …`. |
| `file` | COMPLETED with a raw inline PDF (`fake.pdf`). |
| `file2` | Same, with the hostile filename `../../x`. |
| `file-url` | COMPLETED with a `url` part (`https://example.com/fake.pdf`). |
| `file-data` | COMPLETED with a `data` part (`{"hello":"world","n":1}`). |
| `file-big` | COMPLETED with a raw ~1 MiB file (`big.pdf`). |
| `ask` | WORKING → INPUT_REQUIRED with the question `What is your name?`, task left open. A follow-up with the same `taskId` streams the artifact `thanks, <answer>` and COMPLETED. |
| `empty` | COMPLETED with no artifact and no `status.message`. |
| `fail` | FAILED with `status.message` `the fake failed`. |
| `reject` | REJECTED with no message. |
| `auth-midway` | WORKING → AUTH_REQUIRED (with a message). |
| `auth` | Normal reply (same as `hello`); with `--auth` it needs a valid key like every request. |
| `drop` | WORKING and two artifact fragments, then the TCP connection is destroyed. The task stays WORKING; `SubscribeToTask` finishes it (empty `lastChunk` + COMPLETED). |
| `hang` | WORKING and then nothing, connection left open. |
| `cancel-me` | WORKING until `CancelTask`, then a CANCELED status update, stream closed. |
| `unknown` | WORKING, one `TASK_STATE_SOMETHING_NEW` status update, then a normal completed reply. |
| `nostream` (with `SendMessage`) | Terminal COMPLETED task with the whole reply split across multiple `parts` in one artifact, and the same text in `status.message`. |
| `refuse-context` | Any request whose `contextId` is `old-context` gets JSON-RPC `TASK_NOT_FOUND`. |

`GetTask` on an unknown id is `TASK_NOT_FOUND`; `CancelTask` on a finished task is
`TASK_NOT_CANCELABLE`; `SubscribeToTask` on a finished task is `UNSUPPORTED_OPERATION`.

## Self-test

```sh
node tools/a2a-fake/tests.mjs
```

It starts the server on an ephemeral port, parses every SSE event, exercises all triggers and
flags, and prints `all checks passed` (exit 0). The auth key is `test-key`.