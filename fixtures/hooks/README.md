# Hook contract fixtures (S31)

One directory per contract case: `fixtures/hooks/<harness>/<case>/` holding
`stdin.json` (the §9 event payload, real-shaped) and `expected.json` (the
contract: exact stdout JSON, exit 0, the Appendix C ledger line the event must
append, receipt files, and the wall-time budget class). `<case>` is the event
name, with `-<variant>` suffixes for failure/subagent/no-claims variants
(`expected.json.event` names the real event). Aux files (`transcript.jsonl`,
`rollout.jsonl`) are synthetic transcripts the Stop cases point at via the
`${FIXTURE_DIR}` placeholder.

**Placeholders**, substituted by `test/hooks/contract.test.ts` at run time:

- `${FIXTURE_DIR}` — the absolute path of the case directory (in `stdin.json`).
- `${SR_HOME}` — the per-case temp `SHOWRECEIPTS_HOME` (in `expected.json`
  stdout strings).

**`expected.json` shape**

```
{
  "harness": "<dialect>",            // argv positional 1
  "event": "<event>",                // argv positional 2
  "stdout": { … },                   // exact stdout JSON (deep-equal)
  "exit": 0,                         // always 0 (§9)
  "ledger": {                        // or null when the event writes no line
    "sid": "<raw sid>",              // file: <SR_HOME>/ledger/<harness>/<safeSid>.jsonl
    "lines": N,                      // total lines appended
    "last": { … }                    // subset-match on the parsed last line
  },
  "files": ["last-receipt.md", …],   // present under <SR_HOME>/last/<harness>/
  "receiptsLog": true,               // <SR_HOME>/receipts.log got a line
  "noFiles": true,                   // nothing under last/ and no receipts.log
  "classBudgetMs": 20000|1500|1000   // stop / record / session budget (§9)
}
```

Large payloads (the Cursor 5 MB `afterFileEdit`, the two 33 MiB oversize
stdins) are **generated at test time** by `gen-large.mjs` (seeded PRNG,
mulberry32/0x5eed) into `fixtures/hooks/generated/` — git-ignored, removed by
the test's `afterAll`. Hostile-sid, unparsable, empty-stdin and no-stdin
variants are built inline by `contract.test.ts`.

## Per-event stdin fields per harness (Appendix C "Source per harness", §9)

### Claude Code (`hook claude-code <event>`)

- `Stop`: `session_id, prompt_id, transcript_path, cwd, permission_mode,
  hook_event_name, stop_hook_active, last_assistant_message, agent_id?` —
  subagent Stops (`agent_id`, a `/subagents/…agent-<hex>.jsonl` path, or a
  first-record `agentId`) answer `{}` and never touch `last-receipt.*`.
- `SessionStart` (strict installs only): `session_id, source, cwd`.

### Codex CLI (`hook codex Stop`)

- `Stop`: `session_id, transcript_path|null, cwd, hook_event_name, model,
  permission_mode, turn_id, stop_hook_active, last_assistant_message` — a
  `null` transcript path triggers the `<codexHome>/sessions/**` rollout
  lookup by `-<session_id>.jsonl` suffix.

### Cursor (`hook cursor <event>`)

Common: `conversation_id (sid), generation_id (tid), model, model_id (model),
hook_event_name, cursor_version (hv), workspace_roots, transcript_path?`.
- `postToolUse`: `tool_name, tool_input (JSON string), tool_output (JSON
  string: {exitCode, stdout, …} → out.exit, exitSource 'harness'),
  tool_use_id (id), cwd, duration`.
- `postToolUseFailure`: `error_message, failure_type, duration, is_interrupt`
  → `tool-fail` (exit parsed from the message when present).
- `afterFileEdit`: `file_path, edits[{old,new}]` → `tool-post{kind:'edit'}`.
- `afterMCPExecution`: `tool_name, tool_input, mcp_server_name, result_json,
  duration` → `tool-post{kind:'mcp'}`.
- `afterAgentResponse`: `text` → `agent-response`.
- `subagentStop`: `subagent_type, status, summary, modified_files,
  agent_transcript_path` → `subagent-stop`.
- `stop`: `status, loop_count` → `stop` (+ strict `followup_message` only
  when `loop_count === 0`).
- `sessionStart`: `session_id, is_background_agent, composer_mode (source)`.
- `sessionEnd`: `session_id, reason, duration_ms, final_status`.

### Gemini CLI (`hook gemini <event>`)

Common: `session_id, transcript_path, cwd, hook_event_name, timestamp (t)`.
- `AfterTool`: `tool_name, tool_input, tool_response{llmContent,
  returnDisplay, error?}` — exit from `/^Exit Code:\s*(-?\d+)$/m` in a string
  `llmContent` or `exit_code|exitCode` keys in a structured one
  (`exitSource: 'parsed'`); no tool ids → the fallback `h`+12-hex id.
- `AfterAgent`: `prompt, prompt_response (fallback sniff
  response|final_response|text|message), stop_hook_active` → `prompt` +
  `stop`. Stdout is only ever JSON: `{}`, or the strict
  `{"decision":"deny","reason":…}`.
- `SessionStart`: `transcript_path` → `session-start.transcript`.
- `SessionEnd`: `reason`.

### Copilot CLI (`hook copilot <event>`)

Camel (`sessionId, toolName, toolArgs, toolResult{resultType,
textResultForLlm}`) and Pascal/snake (`session_id, tool_name, tool_args,
tool_result.text_result_for_llm`) forms both accepted; `timestamp` is ms.
- `postToolUse` → `tool-post` (exit from `/exit code (\d+)/i` in
  `textResultForLlm`, `exitSource: 'parsed'`; fallback tool id).
- `postToolUseFailure`: `error` → `tool-fail`.
- `agentStop`: `transcriptPath (stop.transcript), stopReason,
  stop_hook_active` → `stop`.
- `sessionStart`: `source, initialPrompt?` → `session-start` + `prompt`.
- `sessionEnd`: `reason` → `session-end`.

### Hermes (`hook hermes <event>`)

Common: `{hook_event_name, tool_name, tool_input, session_id, cwd, extra}`.
- `post_tool_call.extra{tool_call_id (id), turn_id (tid), result (out.text),
  duration_ms, status, error_type, error_message}` → `tool-post` (exit 0 on
  `status:'success'`) or `tool-fail` (status ≠ success; exit parsed from
  `result`).
- `post_llm_call.extra{user_message, assistant_response, turn_id, model}` →
  `prompt` + `stop{completed}`.
- `on_session_start.extra{model, platform}` → `session-start`.
- `on_session_end.extra{completed, failed, interrupted, turn_id, model}` —
  a per-turn boundary `stop{status}`, deduped against the same `turn_id`.
- `on_session_finalize` → `session-end`.

### dsh (`hook dsh <event>`; CC-shaped)

- `Stop`: as Claude Code, but a ledger stop storing `last_assistant_message`
  as `stop.text`.
- `PostToolUse`/`PostToolUseFailure`: `tool_name, tool_input, tool_response,
  tool_use_id, transcript_path` — recorded only when `transcript_path` is
  not under `$CLAUDE_CONFIG_DIR|~/.claude/projects/` (`--force-record`
  overrides); failure exits parse `/^(?:Error: )?Exit code (-?\d+)/`.

### OpenCode (roadmap; `hook opencode <event>`)

- `tool.execute.after`: `{tool, sessionID, callID}` + `{title, output,
  metadata}` → `tool-post`.
- `session.idle` → `stop{completed}`.

### OpenClaw (roadmap; `hook openclaw <event>`)

- `after_tool_call`: `{tool_name, tool_input, result, tool_call_id, cwd}` →
  `tool-post`; `agent_end{message}` → `stop`; `session_start{model}` →
  `session-start`; `session_end{reason}` → `session-end`.
