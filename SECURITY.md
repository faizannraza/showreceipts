# Security policy

showreceipts' entire value is a set of safety claims: read-only over agent
logs, no network code path, `0600` writes, masked output, aggregates-only
publishing. A bug that breaks one of those claims is a security bug even if
nothing "exploitable" follows from it.

## Reporting

Please report vulnerabilities privately through GitHub's security advisories:
<https://github.com/faizannraza/showreceipts/security/advisories/new>
(Repository → Security → "Report a vulnerability"). You'll get an
acknowledgement within a few days; a fix and a coordinated disclosure follow
as fast as the bug deserves. Please don't open a public issue for anything
you believe is sensitive.

## In scope

- Anything that makes showreceipts **write outside** `.showreceipts/` and
  `~/.showreceipts/`, or modify a harness file beyond the surgical hook
  entries `setup` documents.
- **Path traversal** from untrusted input — hook stdin session ids,
  transcript-derived paths — escaping the directories showreceipts owns.
- **Sanitisation bypass**: transcript-derived strings reaching the terminal,
  Markdown, HTML report or SVG with live ANSI escapes, control characters,
  bidi overrides, or script-capable HTML.
- **Masking/redaction bypass**: secret-shaped tokens surviving into ledgers,
  caches, receipts or reports; the fixture redaction pipeline
  (`scripts/redact-fixture.mjs`, `scripts/lib/`) letting real session
  material into the committed tree.
- **`bench --publish` leakage**: any identifying data (paths, ids, prompts,
  hostnames, day-precision dates) in the publish payload.
- **Network activity of any kind** from the published package, or a gap in
  the checks that enforce its absence.
- Hook behaviour that can block or corrupt a user's agent session (the hook
  contract is: always exit 0, never block a tool).

## Out of scope

- Agents lying about their work — detecting that is the product, not a bug.
- Secrets that an *agent* printed into its own transcript: showreceipts never
  copies tool output bodies into receipts, but the transcript itself is the
  harness's artefact, not ours.
- Vulnerabilities in the harnesses (Claude Code, Codex, Cursor, …) —
  report those upstream.
- Social engineering, or attacks requiring an already-compromised machine
  (an attacker who can read `~/.claude` doesn't need us).

## Supported versions

Only the latest published 0.x release receives security fixes.
