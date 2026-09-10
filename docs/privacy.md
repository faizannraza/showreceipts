# Privacy

Nothing leaves this machine. showreceipts contains **no network code path** (
not a debug ping, not a version check, nothing) and is read-only over the
agent logs. This page lists exactly what is read, exactly what is written,
and every field of the one file (`bench --publish`) designed to be shared.

## What is read

| Source | Path | Content touched |
|---|---|---|
| Claude Code transcripts | `$CLAUDE_CONFIG_DIR` or `~/.claude/projects/*/*.jsonl`, plus `*/<sessionId>/subagents/**/agent-*.jsonl` and `agent-*.meta.json` | streamed; tool outputs parsed in full, kept truncated (≤ 8 KB) in memory, ≤ 512 B masked in the cache; `originalFile`/`content`/base64 bodies never retained |
| Codex rollouts | `$CODEX_HOME` or `~/.codex/sessions/**/rollout-*.jsonl`, `archived_sessions/**`, `session_index.jsonl` (titles only); `models_cache.json` and `config.toml` `[features] hooks` (doctor only) | never retained: `base_instructions`, `user_instructions`, developer instructions/messages, `reasoning.encrypted_content`/`summary`, user messages before the first `user_message` |
| Hook-captured ledgers | `~/.showreceipts/ledger/**/*.jsonl` | parsed like transcripts (these are showreceipts' own writes) |
| Hook stdin | per harness | recorded (truncated, masked) only for harnesses without readable transcripts, or under `--force-record` |
| Harness config files | `~/.claude/settings.json` (all scopes), `~/.codex/hooks.json`, `~/.codex/config.toml`, `~/.cursor/hooks.json`, `~/.gemini/settings.json`, `~/.copilot/hooks/*.json`, `~/.hermes/config.yaml`, `~/.hermes/shell-hooks-allowlist.json` | `setup` / `doctor` only |
| Nothing else | &#8212; | never: `tool-results/*` (persisted tool outputs), `tasks/*.out`/`.output`, `.env`, `auth.json`, git internals, `bridge-session` account ids; no `git` invocation; ledger/claims/cost code never reads `process.env` |

The `tool-results/` boundary has a visible cost: evidence that exists only in
a persisted output file is invisible, and affected claims stay UNVERIFIED
rather than risking a false CONTRADICTED. That trade is deliberate.

## What is written

| Path | Written by | Content |
|---|---|---|
| `<cwd>/.showreceipts/report.html` | `report` | the HTML report (path-hashed on request) |
| `<git root>/.showreceipts/last-receipt.{md,json}` (in git repos) or `~/.showreceipts/last/<harness>/last-receipt.{md,json}` | `hook` (Stop) | the latest receipt per repo / per harness; each Stop overwrites the previous one; `receipts.log` keeps an append-only one-line summary per receipt; `setup` prints the `.gitignore` hint |
| `<cwd>/.showreceipts/<period>-<contentHash>.json` (git repos) or `~/.showreceipts/publish/` | `bench --publish` | aggregates only (see below) |
| `~/.showreceipts/ledger/<harness>/<safeSid>.jsonl` | `hook` | hook-captured events, truncated and masked; never removed by `--clear-cache`; pruning is the explicit `doctor --prune-ledgers <days>` |
| `~/.showreceipts/cache/<sha>.json` | pipeline | parsed sessions; no file contents, no dollar amounts |
| `~/.showreceipts/state/<harness>/<safeSid>.json`, `state/setup.json` | `hook` strict / `setup` | nudge bookkeeping / `{createdHooksKey}` |
| `~/.showreceipts/bin/<version>/`, `bin/showreceipts-hook[.cmd]` | `setup` | the PATH-independent launcher and a copy of `dist/` |
| `~/.showreceipts/backups/<harness>/<basename>.<ms>` | `setup` | config backups (0600, last 3 kept) |
| `~/.showreceipts/receipts.log`, `hook.log` (`--debug` only) | `hook` | one-line summaries / traces |
| harness config files | `setup` | hook entries only, surgically merged, backed up first |

Every file and directory under `~/.showreceipts` is created `0600`/`0700`.
Writes are atomic (temp file + rename; ledger appends are a single
`appendFileSync`). Masking applies to every write: secret-shaped tokens are
replaced before anything touches disk. `report --hash-paths` replaces every
absolute path in a report with a hash so it can be shared.

## The `bench --publish` payload

`--publish` writes a local JSON file of **aggregates only** and never sends
anything. Its complete field list:

- `schema`: `showreceipts.bench-publish/1`
- `generator`: `name`, `version`, `rulesVersion`, `pricesVersion`
- `period`: `from`/`to` (calendar months, `YYYY-MM`), `partial`
- `platform`: `os`, `node` (major version only)
- `contentHash`: 16 hex chars of the row hash
- `rows[]`: per model × harness × version: `harness`, `harnessVersion`,
  `model`, `sessions`, `turns`, `doneTurns`, `contradictedTurns`,
  `unverifiedTurns`, `cleanTurns`, `claims` (`total`, `verified`,
  `unverified`, `contradicted`, `notScored`, `byKind`), `testRunRate`,
  `integritySignals`, `ledgerIncompleteSessions`, `costPerDoneTurnUsd`,
  `cacheHitPct`, `contradictionReasons`

A whitelist validator runs before the file is written: no key outside the
schema; every string matches `^[A-Za-z0-9.\-_/ ]{1,64}$`; `model` must be a
built-in price-table key or the literal `other`; `harness` and every
`byKind`/`contradictionReasons` key must come from the fixed enums; a day-precision
date scan rejects anything finer than a month (the single exception is
`generator.pricesVersion`, which must itself be a date). The serialised file
contains no home path, hostname, e-mail, session id or path separator
sequence beyond the whitelisted tokens, and two consecutive runs produce
byte-identical files.

This example was produced by running `bench --publish` over the project's own
committed test fixtures (regenerated by `scripts/gen-docs.mjs`, so it is
always the real output of the current code). Two values are shown as
`(varies by machine)`: the `platform` fields report the Node major and OS of
whatever machine ran the command, and the `contentHash` covers them; every
other byte is the command's verbatim output:

<!-- gen:publish-example -->
```json
{
  "contentHash": "(varies by machine)",
  "generator": {
    "name": "showreceipts",
    "pricesVersion": "2026-08-29",
    "rulesVersion": "claims/2",
    "version": "0.1.0"
  },
  "period": {
    "from": "2026-07",
    "partial": false,
    "to": "2026-07"
  },
  "platform": {
    "node": "(varies by machine)",
    "os": "(varies by machine)"
  },
  "rows": [
    {
      "cacheHitPct": 100,
      "claims": {
        "byKind": {
          "verification": 1
        },
        "contradicted": 0,
        "notScored": 0,
        "total": 1,
        "unverified": 0,
        "verified": 1
      },
      "cleanTurns": 1,
      "contradictedTurns": 0,
      "contradictionReasons": {},
      "costPerDoneTurnUsd": 73.74,
      "doneTurns": 1,
      "harness": "claude-code",
      "harnessVersion": "2.1.214",
      "integritySignals": 0,
      "ledgerIncompleteSessions": 0,
      "model": "claude-fable-5",
      "sessions": 1,
      "testRunRate": 1,
      "turns": 1,
      "unverifiedTurns": 0
    },
    {
      "cacheHitPct": 100,
      "claims": {
        "byKind": {
          "git": 1,
          "verification": 1
        },
        "contradicted": 0,
        "notScored": 1,
        "total": 2,
        "unverified": 1,
        "verified": 0
      },
      "cleanTurns": 0,
      "contradictedTurns": 0,
      "contradictionReasons": {},
      "costPerDoneTurnUsd": 73.74,
      "doneTurns": 1,
      "harness": "claude-code",
      "harnessVersion": "2.1.214",
      "integritySignals": 0,
      "ledgerIncompleteSessions": 0,
      "model": "claude-opus-4-8",
      "sessions": 1,
      "testRunRate": 1,
      "turns": 1,
      "unverifiedTurns": 1
    },
    {
      "cacheHitPct": 100,
      "claims": {
        "byKind": {
          "check": 15,
          "command": 1,
          "completion": 1,
          "file": 1,
          "git": 5,
          "test": 5,
          "verification": 4
        },
        "contradicted": 0,
        "notScored": 2,
        "total": 32,
        "unverified": 5,
        "verified": 25
      },
      "cleanTurns": 4,
      "contradictedTurns": 0,
      "contradictionReasons": {},
      "costPerDoneTurnUsd": 73.74,
      "doneTurns": 7,
      "harness": "claude-code",
      "harnessVersion": "2.1.214",
      "integritySignals": 0,
      "ledgerIncompleteSessions": 0,
      "model": "claude-sonnet-5",
      "sessions": 1,
      "testRunRate": 1,
      "turns": 14,
      "unverifiedTurns": 3
    }
  ],
  "schema": "showreceipts.bench-publish/1"
}
```
<!-- /gen -->

## The no-network guarantee

Two independent enforcement layers:

- **Source policy**: `scripts/check-no-network.mjs` scans every file of the
  built `dist/` for imports of `http`, `https`, `http2`, `net`, `tls`, `dns`,
  `dgram`, for `fetch`/`WebSocket`/`XMLHttpRequest`, for `createRequire` and
  for dynamic imports; CI fails on any hit. `child_process` is allowed in
  exactly one place: `report --open`, which spawns your OS's opener with an
  argv array (never a shell string).
- **Runtime guard**: every test process (and every child the tests spawn)
  runs with a guard that patches sockets, DNS and `fetch` to throw, so a
  network attempt anywhere in the pipeline fails the suite.

## Threat notes

Transcripts may contain secrets the agent printed. showreceipts never copies
tool output bodies into receipts or reports, only command text, exit codes,
paths, parsed result lines (≤ 200 chars) and masked snippets, all sanitised
(ANSI escapes, control characters and bidi overrides stripped) before
rendering. Session ids arriving on hook stdin are untrusted and sanitised
before any path is built from them. Danger flags name paths only.
`doctor --clear-cache` empties the parse cache; `doctor --prune-ledgers <days>`
removes old ledgers. Vulnerability reporting is described in
[`../SECURITY.md`](../SECURITY.md).
