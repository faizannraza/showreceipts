# The hook-captured ledger format

For harnesses without a readable transcript (Cursor, Gemini CLI, Copilot
CLI, Hermes, dsh), `showreceipts hook` captures a normalised event ledger:
one JSON object per line, `"v": 1`, at

```text
~/.showreceipts/ledger/<harness>/<safeSid>.jsonl     (file 0600, directory 0700)
```

`safeSid` is the session id when it matches
`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, else `'h' + sha256(sid)[:32]`; a
missing id becomes `'unknown-' + sha256(cwd + ':' + hour)[:16]`. The raw id
is kept *inside* the ledger lines; the sanitised form is only ever used to
build the path.

## Write contract

Hooks from several processes append to one file concurrently, so the format
is designed around a single atomic append:

- The whole line (JSON + `\n`) is serialised into one buffer and written with
  exactly one `appendFileSync(path, buf, {flag: 'a', mode: 0o600})` per event
  — O_APPEND means one `write(2)` at EOF. Never open+seek+write, never
  read-modify-write, never rename-replace, no lock files. (Measured: 16
  processes × 200 × 64 KiB lines → zero torn lines.)
- Hard cap **256 KiB per line** after field truncation: `agent-response`
  text ≤ 64 KiB, `out.text` ≤ 16 KiB, `in.raw` ≤ 4 KiB.
- `mkdirSync(dir, {recursive: true, mode: 0o700})` before the first append.
- Readers treat a torn trailing line — or any unparsable line mid-file — as
  `badLines` and continue. A ledger is data, never a reason to fail.

## Common fields

```json
{ "v": 1, "t": "<ISO UTC>", "h": "<harness>", "e": "<event>",
  "sid": "<raw session id>", "tid": "<turn id>", "cwd": "…",
  "hv": "<harness version>", "model": "…",
  "exitSource": "harness|parsed|unknown" }
```

`tid`, `cwd`, `hv`, `model` and `exitSource` appear when the harness provides
them. Unknown keys and unknown `e` values are ignored by readers (counted as
diagnostics), so the format can grow without breaking old readers.

## Events

| `e` | extra fields |
|---|---|
| `session-start` | `transcript?`, `source?` |
| `prompt` | `text` (≤ 16 KiB, masked) |
| `tool-post` | `id`, `tool`, `kind`, `in { command?, path?, paths?[], edits?[{old,new}] (each ≤ 4 KiB, ≤ 32 entries, editsTruncated?), url?, raw? }`, `out { text (head/tail ≤ 16 KiB, masked), bytes, exit?, error?, durationMs?, truncated? }` |
| `tool-fail` | `id`, `tool`, `in`, `error`, `failureType?` (`timeout\|error\|permission_denied`), `durationMs?`, `out { exit? }?` |
| `agent-response` | `text` (≤ 64 KiB) |
| `subagent-stop` | `agent { type?, status?, summary?, modifiedFiles?[], transcript?, text? (≤ 16 KiB) }` |
| `stop` | `status?` (`completed\|aborted\|error`), `text?`, `transcript?`, `loop?` |
| `session-end` | `reason?` |
| `gap` | `reason` (`oversize\|unparsable`), `bytes` |

`cwd` is **required** on `tool-post` lines with `kind ∈ {shell, edit, write}`
(Cursor: the event's `cwd`, else `workspace_roots[0]`, with
`ambiguousRoot: true` when several roots meet a relative path). That matters
because readers re-run shell-write inference over `in.command` with `cwd` as
the base — hook-captured sessions and transcript sessions share one code
path for "what did this command write".

A `gap` line is written when stdin exceeded the 32 MiB cap or could not be
parsed even after salvage; `doctor` surfaces the counts.

## Where each field comes from, per harness

| field | Cursor | Gemini CLI | Copilot CLI | Hermes | dsh |
|---|---|---|---|---|---|
| `model` | `model_id` (fallback `model`) | — (`unknown` bucket) | — (`unknown` bucket) | `extra.model` | — |
| `hv` | `cursor_version` | — | — | — | — |
| `tid` | `generation_id` | — | — | `extra.turn_id` | — |
| `prompt` | — | `AfterAgent.prompt` | `sessionStart.initialPrompt` | `post_llm_call.user_message` | — |
| `transcript` | `transcript_path` | `transcript_path` | `agentStop.transcriptPath` | — | `transcript_path` |
| `t` | harness timestamp when present, else the hook clock | ISO timestamp | ms → ISO | hook clock | hook clock |
| `id` | `tool_use_id` | hash of `(t, tool, in)` | hash of `(t, tool, in)` | `extra.tool_call_id` | hash of `(t, tool, in)` |
| `out.exit` | `tool_output.exitCode` (**harness**) | `/^Exit Code:\s*(-?\d+)$/m` or `exit_code`/`exitCode` keys in `llmContent` (**parsed**) | `/exit code (\d+)/i` in `textResultForLlm` (**parsed**) | `extra.status`/`error_type` (+ returncode when subscribed) (**parsed**) | `Exit code N` on failures, 0 on success (**parsed**) |

Tool-name → `kind` maps: Cursor `Shell→shell, Read→read, Write→write,
Edit→edit, MCP:*→mcp, afterFileEdit→edit`; Gemini `run_shell_command→shell,
write_file/replace→write/edit, read_file→read, glob/grep→search,
web_fetch/google_web_search→fetch`; Copilot `bash|powershell→shell,
create→write, edit→edit, view→read, glob|grep→search, web_fetch→fetch,
task→agent`; Hermes `terminal→shell, write_file→write, edit_file→edit`. An
unknown tool name maps to `other` — which is never treated as a write, so an
unrecognised tool can never fabricate write evidence.
