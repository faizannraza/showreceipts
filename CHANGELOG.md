# Changelog

All notable changes to `showreceipts`. The version here, `package.json` and
`src/version.ts` move together; `rulesVersion` (`claims/N`, `reconcile/N`) and
`pricesVersion` (a date) are stamped into every receipt and listed per release.

## 0.1.0 (2026-09-04)

Initial release: an offline, read-only, zero-runtime-dependency auditor for
coding-agent sessions. It parses the harness's own transcripts and
hook-captured tool ledgers, extracts the claims in the agent's final message,
and reconciles every claim against what the tool log actually recorded.
Versions in this release: rules `claims/2` + `reconcile/2`, prices
`2026-08-29`.

### Added

- **Readers**: Claude Code transcripts (goldens for 2.1.214, 2.1.215,
  2.1.235, 2.1.241, 2.1.243, 2.1.251 and the legacy shape; subagents;
  incremental tail re-parse on Stop) and Codex rollouts (two real redacted
  0.98.0 rollouts plus the `shell_command` variant). Unknown shapes are
  counted, never thrown on.
- **Ledger hooks**: `showreceipts hook` dialects for Claude Code, Codex,
  Cursor, Gemini CLI, Copilot CLI, Hermes and dsh, plus OpenCode/OpenClaw
  plugin templates. The hook always exits 0, caps stdin at 32 MiB, salvages
  torn input, and writes per-session `0600` ledgers under `~/.showreceipts`.
- **Claims and reconciliation**: sentence-level claim extraction reconciled
  against the ledger under the positive-evidence doctrine (absence is never
  contradiction, except the guarded `no-test-run`); a 273-entry claims corpus
  at 100 % precision/recall and 48 reconcile scenario fixtures.
- **Cost**: API-equivalent cost per turn and session computed from the
  harness's own `usage` rows against a pinned price table (`2026-08-29`),
  including cache reads/writes, tier boundaries, refusal-fallback billing and
  a user override file; `≈` marks estimates and the footer explains it once.
- **Renderers**: terminal receipt (40–200 columns, Unicode and ASCII frames,
  `NO_COLOR`/no-TTY aware), Markdown, a single-file CSP'd HTML report
  (keyboard-navigable, light/dark, hash-paths toggle, JSON export) and SVG.
- **Commands**: `audit`, `session`, `export`, `report`, `doctor`, `bench`
  (with the `--publish` privacy validator), `demo` (seeded synthetic
  scenarios, clearly labelled), `setup` (surgical config merge with backups,
  `--dry-run`, `--remove`, restore; PATH-independent launcher) and `hook`;
  `--json` output for every command per `docs/receipt-schema.md`.
- **Privacy**: nothing leaves this machine: no network code path (enforced
  by a dist lint and a test-time network guard), masking on every write,
  `0600`/`0700` modes, atomic writes, `--hash-paths`; `tool-results/`,
  `tasks/`, `auth.json` and `.env` are never opened.

### Known issues

- **The accuracy gate was met by demotion.** Both CONTRADICTED verdicts in
  the hand-labelled real-session sample were false positives under
  `claims/1+reconcile/1`: a possessive path ("removed `x.py`'s … check")
  judged as a file delete, and a hypothetical no-change marker judged against
  the turn's writes. `claims/2+reconcile/2` demotes the two offending
  reconcile rows (edited-not-deleted with a direct object; path-less
  writes-despite-no-change) to UNVERIFIED; both shapes are pinned in the
  corpus. Full numbers in `docs/accuracy.md`.
- **Extractor misfires queued as `claims/3` candidates** (observed in the
  labelled sample, all non-CONTRADICTED): `verify.generic` accepts an
  unrelated green test run as evidence for claims about external services;
  future-tense "it'll / it will" clauses, quoted install instructions,
  "How to …" headings and "To <verb>:" instructional openers are scored as
  claims; a parenthetical conditional can re-scope a completed action to
  deferred.
- **Codex ≥ 0.148 rollouts: waiver.** No *real* redacted Codex ≥ 0.148
  rollout landed for 0.1.0; the 0.148 dialect is covered only by a
  hand-written synthetic `shell_command` fixture (stamped `0.148.0`, which
  is why `docs/catalogue.md` lists that version); the reader is verified
  against the two real 0.98.0 rollouts plus that synthetic shape. Newer
  rollouts parse best-effort and unknown payloads are surfaced by `doctor`
  as counts. Capturing a real redacted ≥ 0.148 fixture with a golden is the
  first 0.1.x task.
- **The parse cache keeps the newest turn's prompt in its resume state.**
  A cache entry's `builderState` nulls every finalized turn's prompt text
  (its echo hashes are preserved, so receipts are unaffected), but the
  still-open trailing turn's prompt remains until a later Stop/audit
  re-parse finalizes it, a deliberate §4.9 exception that keeps the
  incremental Stop resume exact. `doctor --clear-cache` removes it.
- **Persisted tool outputs are never read** (`tool-results/` is a privacy
  boundary), so evidence that exists only there is invisible; affected
  claims stay UNVERIFIED rather than risking a false CONTRADICTED.
- **Interpreter writes are inferred, not observed.** Files written by a
  script the agent ran (not by an edit tool or shell redirect) leave no
  write record; file claims resolve to UNVERIFIED `write-not-observable`.
- **Windows is best-effort** (CI job is non-blocking); macOS and Linux are
  the supported platforms. Node ≥ 20.
