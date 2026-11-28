# Agent tool layer (main process)

The model never touches the disk. It can only *request* tool calls; `agent/tools.js` validates, confirms,
executes and redacts them inside the Electron **main process** (the renderer has no fs/shell access).

| File | Role |
|---|---|
| `workspace.js` | Path confinement: rejects absolute paths, `..`, NUL, `~`, and anything whose `realpath` leaves the workspace (symlinks, dangling symlinks, new files under escaping dirs). Writes into `.git/` are refused. |
| `tools.js` | JSON schemas + one `dispatch(call)` for `list read write edit glob grep bash webfetch`. Always returns `{ok:true,…}` or `{ok:false,error}`. |
| `bashguard.js` | Detects `rm -rf /`·`~`, fork bombs, `dd of=/dev/…`, `mkfs`, `chmod -R 777 /`, force-push to protected branches, Windows drive wipes. |
| `redact.js` | Redacts AWS/OpenAI/Anthropic/Google/GitHub/Slack/JWT/Bearer tokens, private keys, `password=…`-style values, and every value in `.env*` files. |
| `models.js` | Tool-calling adapters for OpenAI-compatible, Anthropic and Gemini. |
| `loop.js` | `runAgent`: `messages=[system,user]` → `chat()` → run tool calls → append results → repeat until plain text (step limit 40). |
| `ipc.js` | IPC: workspace picker, config, run/stop, approval round trip, JSONL log (`agent-log.jsonl` in the app data folder). |

## Modes (Agent bar in the UI; saved in `config.json`)
- **Read-only** – only `list read glob grep` are offered *and* enforced by the dispatcher.
- **Ask before changes** (default) – every `write`, `edit`, `bash`, `webfetch` shows an approval dialog.
- **Auto-approve** – skips those prompts. Dangerous shell commands **still ask**, every time.

## Tests
`npm test` (Node ≥ 20, no dependencies). Covers traversal/symlink escapes, overwrite confirmation, non-unique edits,
create/read/list/glob/grep round trip (JS and ripgrep engines), read-only mode, bash guard, env isolation, timeouts,
redaction, logging, webfetch SSRF guards, provider adapters, the agent loop, and the full IPC flow.

## Honest limits
- `bash` is **not a sandbox**. After you approve, a command runs as you and can touch anything you can; the guard is a
  heuristic that catches obvious cases only. Keep the default "Ask" mode unless you trust the task.
- Redaction is best-effort pattern matching; unusual secret formats can slip through.
- Path checks use `realpath` at call time; a process racing to swap a directory for a symlink between check and use is out of scope.
- `bash` receives only a small allow-list of environment variables (no API keys); the model can still print those few (e.g. `PATH`).
- `grep` uses `rg` if it is installed (not bundled) and falls back to a built-in JS regex search.
- Agent mode is desktop-only; the Android build hides it.
