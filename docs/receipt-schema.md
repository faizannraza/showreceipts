# `--json` shapes (`docs/receipt-schema.md`)

Every machine-readable output of showreceipts (ARCHITECTURE §12.3), as
annotated schema blocks. `test/helpers/schema.ts` parses the fenced
` ```schema <Name> ` blocks below and validates objects structurally against
them (required keys present, primitive types correct, enum choices known);
the e2e suites (S26), `setup --json` (S30) and the launcher tests (S31) run
every command's output through it. Extra keys are tolerated: a schema names
the guaranteed surface, not a closed set.

## Grammar

Each block is JSON whose **string values are type annotations**:

| Annotation | Meaning |
|---|---|
| `"string"` `"number"` `"boolean"` `"null"` `"true"` `"object"` `"any"` | primitive / literal / any object / anything |
| `"const:X"` | exactly the string `X` |
| `"enum(a\|b\|c)"` | one of the listed strings |
| `"record(T)"` | object whose every value matches `T` |
| `"A\|B"` | union (top-level `\|` only, not inside `(…)`) |
| `"Name"` (capitalised) | reference to the block named `Name` |
| `[T]` | array of `T` |
| `{ "key": T, "opt?": T }` | object; a key ending in `?` is optional |

A block whose body is a bare string (e.g. `"Receipt"`) is an alias.

## Commands

### `audit --json`

```schema audit
{
  "schema": "const:showreceipts.audit/1",
  "toolVersion": "string",
  "rulesVersion": "string",
  "pricesVersion": "string",
  "generatedAt": "string",
  "scanned": {
    "sessions": "number",
    "byHarness": "record(number)",
    "from": "string|null",
    "to": "string|null",
    "bytes": "number",
    "cacheHits": "number"
  },
  "sessions": ["SessionCard"],
  "rate": ["RateRow"],
  "latest": "Receipt|null",
  "diagnostics": "Diagnostics"
}
```

### `session --json` (also with `--timeline` / `--explain-claim`)

```schema session
"Receipt"
```

### `export --json`

```schema export
"Receipt"
```

### `report --json`

```schema report
{
  "out": "string",
  "bytes": "number",
  "bytesBySection": "record(number)",
  "sessions": "number",
  "timelinesEmbedded": "number",
  "hiddenRows": "number"
}
```

### `doctor --json`

```schema doctor
"DoctorReport"
```

### `bench --json`

```schema bench
{
  "schema": "const:showreceipts.bench/1",
  "window": { "from": "string", "to": "string" },
  "rows": ["RateRow"]
}
```

### `bench --publish` (the §13.3 file)

```schema bench-publish
{
  "schema": "const:showreceipts.bench-publish/1",
  "generator": {
    "name": "const:showreceipts",
    "version": "string",
    "rulesVersion": "string",
    "pricesVersion": "string"
  },
  "period": { "from": "string", "to": "string", "partial": "boolean" },
  "platform": { "os": "string", "node": "string" },
  "contentHash": "string",
  "rows": ["PublishRow"]
}
```

### `setup --json`

```schema setup
["SetupResult"]
```

### `demo --json`

```schema demo
["Receipt"]
```

## Named shapes

### Enums

```schema Harness
"enum(claude-code|codex|cursor|gemini|copilot|hermes|dsh|opencode|openclaw)"
```

```schema Verdict
"enum(VERIFIED|UNVERIFIED|CONTRADICTED|NOT_SCORED)"
```

```schema ReceiptVerdict
"enum(VERIFIED|UNVERIFIED|CONTRADICTED|NO_CLAIMS|NO_FINAL|NO_TURNS)"
```

```schema ReceiptKind
"enum(scored|no-claims|no-final|no-turns)"
```

```schema ClaimKind
"enum(file|file-count|test|test-added|test-ran|check|command|install|git|verification|completion|no-change)"
```

```schema Reason
"enum(ok|ok-deleted-later|no-evidence|no-test-run|last-run-red|stale-run|exit-unknown|run-in-background|count-short|check-red|no-check-run|no-write-to-path|write-failed|ambiguous-path|file-not-deleted|no-git-op|git-op-failed|sha-mismatch|commit-precedes-edits|push-precedes-commit|no-command|command-failed|no-run-after-write|writes-despite-no-change|echoed|partial|not-scored|ledger-incomplete|write-not-observable)"
```

```schema Trigger
"enum(human|skill|notification|compact|local-command|meta|interrupt|relogin)"
```

```schema ToolKind
"enum(shell|edit|write|read|search|fetch|agent|mcp|task|other)"
```

### Receipt (`showreceipts.receipt/1`, §5.2)

```schema Receipt
{
  "schema": "const:showreceipts.receipt/1",
  "toolVersion": "string",
  "rulesVersion": "string",
  "pricesVersion": "string",
  "kind": "ReceiptKind",
  "id": "string",
  "shortId": "string",
  "harness": "Harness",
  "harnessLabel": "string",
  "harnessVersion": "string|null",
  "model": "string",
  "cwd": "string",
  "branch": "string|null",
  "startedAt": "string",
  "endedAt": "string",
  "durationMs": "number",
  "source": "enum(transcript|ledger)",
  "ledgerNote?": "string",
  "ledgerCoverage?": "string",
  "turnIndex": "number",
  "finalTrigger": "Trigger|null",
  "turnsWithClaims": ["number"],
  "finalText": "string",
  "finalTextSource": "enum(transcript|stop-hook|copilot-transcript)",
  "claims": ["Claim"],
  "judgements": ["Judgement"],
  "lines": ["ReceiptLine"],
  "alsoSaid": ["string"],
  "alsoDid": [{ "text": "string", "warn?": "boolean", "refs": ["EvidenceRef"] }],
  "postFinal?": [{ "agentId": "string|null", "toolCalls": "number", "files": "number", "testRuns": "number" }],
  "stats": {
    "toolCalls": "number",
    "filesChanged": "number",
    "testRuns": "number",
    "compactions": "number",
    "subagents": "number",
    "apiCalls": "number",
    "sentencesScanned": "number"
  },
  "cost": "Cost",
  "verdict": "ReceiptVerdict",
  "counts": {
    "VERIFIED": "number",
    "UNVERIFIED": "number",
    "CONTRADICTED": "number",
    "NOT_SCORED": "number"
  },
  "incompleteAtStop?": "boolean",
  "timeline?": ["TimelineEntry"],
  "explanations?": ["Explanation"],
  "sessionSpan?": { "from": "string", "to": "string", "days": "number" },
  "turnActiveMs": "number|null",
  "claimsRecognized": "number",
  "hashPaths?": "boolean",
  "records?": "number",
  "slashCommands?": "number",
  "finalStopReason?": "string|null"
}
```

```schema Claim
{
  "id": "string",
  "kind": "ClaimKind",
  "polarity": "enum(positive|negated|deferred)",
  "attribution": "enum(agent|other)",
  "rule": "string",
  "sentence": "string",
  "clause": "string",
  "position": "number",
  "echoed": "boolean",
  "partial?": "boolean",
  "explicitVerb?": "boolean",
  "directObject?": "boolean",
  "subject?": "string",
  "fromPath?": "string",
  "verb?": "enum(create|update|delete|rename)",
  "count?": "number",
  "ratio?": ["number"],
  "family?": "enum(lint|type|build|format)",
  "tool?": "string",
  "op?": "string",
  "sha?": "string",
  "branch?": "string",
  "remote?": "string",
  "prNumber?": "number",
  "successPredicate?": "boolean"
}
```

```schema Judgement
{
  "claimId": "string",
  "verdict": "Verdict",
  "reason": "Reason",
  "evidence": ["EvidenceRef"],
  "text": "string",
  "notes": ["string"],
  "integrity?": "const:test-weakened"
}
```

```schema EvidenceRef
{
  "seq": "number",
  "toolCallId?": "string",
  "agentId?": "string|null",
  "label": "string",
  "at": "string"
}
```

```schema ReceiptLine
{
  "glyph": "enum(ok|bad|unk|said)",
  "claim": "string",
  "evidence": ["string"],
  "refs": ["EvidenceRef"]
}
```

```schema Cost
{
  "usd": "number|null",
  "apiCalls": "number",
  "input": "number",
  "cacheRead": "number",
  "cacheWrite5m": "number",
  "cacheWrite1h": "number",
  "cacheWriteOther": "number",
  "output": "number",
  "thinking?": "number",
  "cacheHitPct": "number|null",
  "unverified": "boolean",
  "unpriced": ["string"],
  "unverifiedModels?": ["string"],
  "apiEquivalent": "true",
  "pricesVersion": "string",
  "overrideHash?": "string",
  "asOf?": "string",
  "planUsagePct?": "number",
  "notes": ["string"]
}
```

```schema TimelineEntry
{
  "seq": "number",
  "at": "string",
  "tool": "string",
  "kind": "ToolKind",
  "summary": "string",
  "exit": "number|null",
  "files": ["string"],
  "usd": "number|null",
  "agentId": "string|null",
  "flags": ["string"]
}
```

```schema Explanation
{
  "claimId": "string",
  "sentence": "string",
  "clause": "string",
  "rule": "string",
  "trigger": "string",
  "cue": "string",
  "polarity": "enum(positive|negated|deferred)",
  "attribution": "enum(agent|other)",
  "row": "number",
  "factsExamined": ["string"],
  "why": "string"
}
```

### Session table and rate rows (§5.4, §12.3)

```schema SessionCard
{
  "id": "string",
  "shortId": "string",
  "harness": "Harness",
  "harnessLabel": "string",
  "harnessVersion": "string|null",
  "model": "string",
  "cwd": "string",
  "title": "string|null",
  "startedAt": "string",
  "endedAt": "string",
  "turns": "number",
  "doneTurns": "number",
  "claims": "number",
  "verdict": "enum(VERIFIED|UNVERIFIED|CONTRADICTED|NO_CLAIMS|NO_FINAL|NO_TURNS|\u2014)",
  "costUsd": "number|null",
  "unverified": "boolean",
  "kind": "ReceiptKind"
}
```

```schema CostPerDoneTurn
{ "median": "number", "mean": "number" }
```

```schema RateRow
{
  "model": "string",
  "harness": "Harness",
  "harnessVersion": "string",
  "sessions": "number",
  "turns": "number",
  "doneTurns": "number",
  "doneTurnsByTrigger": { "claims": "number", "markerOnly": "number" },
  "byTrigger": { "human": "number", "notification": "number" },
  "contradictedTurns": "number",
  "unverifiedTurns": "number",
  "cleanTurns": "number",
  "claims": {
    "total": "number",
    "verified": "number",
    "unverified": "number",
    "contradicted": "number",
    "notScored": "number",
    "byKind": "record(number)"
  },
  "testRunRate": "number|null",
  "costPerDoneTurnUsd": "CostPerDoneTurn|null",
  "contradictionReasons": "record(number)",
  "integritySignals": "number",
  "ledgerIncompleteSessions": "number",
  "cacheHitPct": "number|null"
}
```

### Diagnostics (aggregated over a load; `problems` present on `audit --json`)

```schema Diagnostics
{
  "unknownRecordTypes": "record(number)",
  "unknownSubtypes": "record(number)",
  "unknownToolShapes": "record(number)",
  "unknownContentBlocks": "record(number)",
  "unknownCodexPayloads": "record(number)",
  "badLines": "number",
  "lineSeparatorChars": "number",
  "reorderedEvents": "number",
  "duplicateUuids": "number",
  "duplicateToolResults": "number",
  "negativeDeltas": "number",
  "orphanAssistantLines": "number",
  "notificationPrompts": "number",
  "localCommandPrompts": "number",
  "incompleteMessages": "number",
  "bashWithoutToolUseResult": "number",
  "legacyShapes": "record(number)",
  "subagentFiles": { "direct": "number", "workflow": "number", "unlinked": "number", "missing": "number" },
  "notes": ["string"],
  "interimFinals": "number",
  "emptySessions": "number",
  "excludedSyntheticLines": "number",
  "unknownAttachmentTypes": "record(number)",
  "journals": "number",
  "unrecognisedFiles": "number",
  "orphanSessionDirs": "number",
  "emptyProjects": "number",
  "corruptCache": "number",
  "copilotTranscriptUnparsed": "number",
  "records": "number",
  "problems?": ["string"]
}
```

### `setup --json` entries

```schema SetupResult
{
  "harness": "Harness",
  "path": "string",
  "scope": "enum(user|project|shared)",
  "action": "enum(installed|updated|unchanged|removed|dry-run|manual)",
  "backup": "string|null",
  "launcher": "string",
  "diff": "string",
  "notes": ["string"]
}
```

### `doctor --json`

```schema Roots
{
  "userHome": "string",
  "claudeConfigDir": "string",
  "codexHome": "string",
  "showreceiptsHome": "string",
  "realpaths": "record(string|null)"
}
```

```schema DoctorHarnessReport
{
  "harness": "Harness",
  "root": "string",
  "found": "boolean",
  "sessions": "number",
  "bytes": "number",
  "versions": ["string"],
  "installedVersion": "string|null",
  "originators?": "record(number)",
  "emptySessions": "number",
  "emptyProjects": "number",
  "orphanSessionDirs": "number",
  "subagentFiles": { "direct": "number", "workflow": "number", "unlinked": "number", "missing": "number" },
  "journals": "number",
  "unrecognisedFiles": "number",
  "unknownRecordTypes": "record(number)",
  "unknownSubtypes": "record(number)",
  "unknownToolShapes": "record(number)",
  "unknownContentBlocks": "record(number)",
  "unknownCodexPayloads": "record(number)",
  "badLines": "number",
  "lineSeparatorChars": "number",
  "bashWithoutToolUseResult": "number",
  "excludedSyntheticLines": "number",
  "legacyShapes": "record(number)",
  "codexDialect?": "string",
  "hooksDisabled?": "boolean"
}
```

`resolvable` below is a **static check** of the launcher sidecar
(`~/.showreceipts/bin/launcher.json` parses, its `node`/`cli`/`launcher`
paths exist, the launcher is executable); `doctor` never spawns the launcher,
so every row carries
`resolvableNote: "static check; the harness process PATH may differ"`. The
actual `--version` run happens only in the S31 launcher test.

```schema DoctorHookReport
{
  "harness": "Harness",
  "scope": "enum(user|project|local|managed|plugin)",
  "configPath": "string",
  "installed": "boolean",
  "command": "string|null",
  "resolvable": "boolean|null",
  "resolvableNote": "string",
  "disabled": "boolean",
  "otherStopHooks": ["string"],
  "strict": "boolean",
  "trusted": "boolean|enum(unknown)",
  "trustNote?": "string",
  "configReadable?": "boolean"
}
```

```schema DoctorReport
{
  "roots": "Roots",
  "node": { "version": "string", "platform": "string" },
  "harnesses": ["DoctorHarnessReport"],
  "hooks": ["DoctorHookReport"],
  "ledgers": {
    "sessions": "number",
    "partial": "number",
    "gaps": "number",
    "stdinOverflow": "number",
    "stopBudgetExceeded": "number",
    "copilotTranscriptUnparsed": "number"
  },
  "prices": {
    "version": "string",
    "overrideHash?": "string",
    "unverifiedInUse": "boolean",
    "unpricedModels": ["string"]
  },
  "cache": { "entries": "number", "bytes": "number" },
  "problems": ["string"],
  "warnings": ["string"]
}
```

### `--publish` rows (§13.3)

```schema PublishRow
{
  "harness": "Harness",
  "harnessVersion": "string",
  "model": "string",
  "sessions": "number",
  "turns": "number",
  "doneTurns": "number",
  "contradictedTurns": "number",
  "unverifiedTurns": "number",
  "cleanTurns": "number",
  "claims": {
    "total": "number",
    "verified": "number",
    "unverified": "number",
    "contradicted": "number",
    "notScored": "number",
    "byKind": "record(number)"
  },
  "testRunRate": "number|null",
  "integritySignals": "number",
  "ledgerIncompleteSessions": "number",
  "costPerDoneTurnUsd": "number|null",
  "cacheHitPct": "number|null",
  "contradictionReasons": "record(number)"
}
```
