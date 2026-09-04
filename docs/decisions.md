# Decisions

Architecture ambiguities resolved during the build, folded in by the wave lead
at each wave merge (PLAN §0.3). Later steps append under their own headings;
never name a real session id, path, user or private project here.

## W0 — Foundation (S01–S03)

### S01 — CLI skeleton

- `src/cli.ts` top-level imports. The review checklist says "`node:*` only";
  the file also imports `./cli/args.js`, `./cli/context.js`, `./cli/help.js`
  and `./version.js`, because argv must be parsed before any command is
  chosen. The intent of the rule — no eager command, reader or network module,
  `--version` ≤ 80 ms — holds (≈ 60 ms median under netguard). Read the rule as
  "`node:*` and `src/cli/*` only".
- `main(argv, overrides?)` accepts `MainOptions.loaders`, a map of fake command
  modules, as a test seam; production callers never pass it.
- The `hook` path swallows asynchronous stdout failures: `main` attaches an
  `'error'` listener to stdout when the command is `hook`, so an EPIPE that
  arrives after `main` returned 0 cannot crash the process with exit 1 and a
  stack trace (§9: the hook never fails the tool). S27's runtime inherits the
  invariant. Non-hook commands still surface an EPIPE as an unhandled error;
  S23c/S26 decide the exit code of an interrupted pipe.
- `test/helpers/netguard.cjs` patches `tls`/`http`/`https`/`http2` lazily
  through a `Module._load` hook (requiring them eagerly costs more than the
  80 ms budget allows); `net.Socket.prototype.connect`, `net.connect`, `dns`
  and `fetch` are patched eagerly, so an ESM `import 'node:http'` is still
  blocked at the socket.

### S02 — model and utilities

- Display width of `✅ tests pass` is 13 and of `📦 shipped` is 10; the plan's
  12/9 is an arithmetic slip (U+2705 and U+1F4E6 are width 2 per §10.1). The
  architecture wins.
- `test/unit/deps-direction.test.ts` lets `hook/*` and `setup/*` import
  `discover/*`, `cache/*` and `model/*` in addition to the §0.5 list
  (`pipeline`, `readers`, `util`, `render/term.ts`, `render/md.ts`): the Stop
  hook resumes parsing through the cache (S27b) and locates Codex rollouts
  through discovery (S28), and every layer needs the types. `render/html*`
  stays forbidden there.
- `commands/*` may import `cli/context.ts` and `cli/args.ts` type-only (the
  `CommandContext` contract); the guard rejects any runtime import upward.
- `util/mask.ts` follows §4.9 literally for `key=value`
  (`(password|passwd|secret|token)=\S+`) with one refinement: a quote or
  backtick run that closes the surrounding literal (`curl "…?token=x"`) is kept
  after `«masked»` so the command stays balanced; a quoted value is masked
  whole. Over-masking is preferred to leaking everywhere else.
- `maskDeep` supports JSON-shaped data only: any object is walked by its own
  enumerable keys and rebuilt as a plain record. Documented rather than
  special-casing `Date`/`Map`, which never reach a write.
- `middleTruncate` cuts the directory head by display width, not on a segment
  boundary; the unit tests pin that cut, so only the JSDoc example was
  corrected to match.

### S03 — fixtures

- Forbidden-list matching is separator-tolerant: an entry is split into its
  alphanumeric runs and masked in any spelling (`-`, `_`, `.`, space, none) at
  run boundaries. The committed hash list stores `sha256` of the canonical form
  (lower-case, non-alphanumerics removed) and the privacy test canonicalises
  every run and every chain of up to five runs before hashing.
- The privacy scan covers `src/**`, `test/**`, `scripts/**/*.mjs`,
  `fixtures/manifest.json` and `fixtures/README.md`, not only the fixture
  tree: a real session id once reached a unit-test vector, which a
  fixture-only scan could not see. All test vectors are synthetic ids.
- `redact-fixture.mjs` adds real Codex rollout ids (the
  `rollout-<ts>-<uuid>.jsonl` suffix) to the forbidden list like Claude session
  ids. At the W0 merge the lead also hand-added the stem of a private project
  name to the local list and regenerated: only the Codex rollout, its review
  file and the hash list changed (`--check` and `survey --check` green).
- The author's primary project name survives in fixtures by design (the plan
  keeps repo-relative paths such as `src/<project>/…`); it is a public package.
- `reviewedBy` is still `null` in every `expected.json`: the author reads each
  `REDACTION-REVIEW.md` and runs `node scripts/redact-fixture.mjs --sign "<name>"`
  before `fixtures/` is committed (S03 acceptance criterion). S19 appends to
  this file rather than starting it.

## W1 — Readers (S04–S10)

### S10 — real-data verification (M1 review fixes)

- **Record correction.** The first S10 build report attributed the +900
  deduped-output divergence to the 2.1.235 transcript and claimed that file's
  raw output sum matches the §0.3 pin of 4,599,129. Wrong file: the 2.1.235
  transcript's raw sum is 3,458,905; the biggest-output session — the file
  both §0.3 output pins are measured on — is the frozen 2.1.214+2.1.236
  transcript (raw 4,599,129 with the byte-level splitter; `node:readline`
  mangles 16 of its lines and reads 4,598,288). The substantive conclusion
  stands: the divergence is on frozen bytes, not live-session drift.
- **The +900 (§4.2.7 pin vs reader), resolved without an S06 change.**
  §4.2.7's "4,599,129 raw → 1,734,118 deduped" pin measures the
  *top-level-usage representative-line* sum (the §0.3 survey method: per
  `message.id` group, the last line with a non-null `stop_reason`, summing
  top-level `usage.output_tokens`). The reader's `Session.usage.output` is the
  §8.3 *billed-attempt* quantity (`attempts = usage.iterations ?? [usage]`,
  billed attempts summed). They differ on exactly one message of the biggest
  transcript: an assistant message re-emitted on two lines (same `message.id`,
  distinct uuids, `stop_reason` `"tool_use"`) whose **top-level usage is
  all-zero** while its single `usage.iterations[0]` carries `output_tokens`
  900 / `input_tokens` 2 — one of §8.3's "12,461 of 12,463 single-iteration
  lines" exceptions. The same mechanism adds +1,500 on the 2.1.235 transcript
  (the two refusal-fallback records' refused attempts, 217 + 1,283 output
  tokens), which §8.3 explicitly requires to be billed. Changing the dedupe to
  reproduce 1,734,118 would unbill those attempts and break the S06 §8.3
  pins, so the reader keeps attempt billing; `verify:real` asserts **both**
  quantities, each by its own method — 1,734,118 "deduped (§0.3 method)" and
  1,735,018 "billed (§8.3 attempts)" — and both PASS on the frozen bytes.
- **`verify:real` is now a gate with per-frozen-file pins.** §0.3's aggregate
  pins that include the live session (26,590 main lines, 440 timestamp
  regressions, 4,820 `message.id` groups, 3 interrupted turns) are permanently
  unmeetable on a machine whose live session keeps growing. Per the S10
  review, expectations are pinned per frozen transcript (the six finished
  Claude Code mains and the two Codex rollouts); a frozen-file mismatch now
  FAILs with exit 1 (frozen bytes cannot drift, so a mismatch means a reader
  behaviour change); live or post-snapshot transcripts print as INFO, never
  asserted; the live-inclusive §0.3 aggregates print as INFO with their
  snapshot values. The S10 acceptance line "prints every assertion as PASS"
  is read over these assertions.
- **Interrupted-turn counting.** The reader's `Turn.interrupted` flag (last
  assistant message `tool_use`/`null`, or an interrupt segment closing the
  turn — S06 instr. 3) counts 7 turns across the frozen transcripts alone,
  where §0.3's survey counted 3 across all files with its narrower
  interrupt-segment definition; the earlier report's "live-session drift"
  explanation for this row was therefore also wrong. The per-file pins use
  the reader's flag; the survey number remains an INFO row.

### W1 merge — integration decisions (S04–S10, lead)

Review-pass minors resolved at the wave close. Every fix below landed with a
unit test; `typecheck`, the full suite, `lint:nonet`, `deps:guard`, `size`,
`catalogue --check` and `verify:real` are green after them.

- **S04/S09 — ledger line splitting.** `src/readers/ledger/reader.ts` keeps
  its local splitter instead of consuming S04's `readJsonl`: ledger files are
  written by our own hooks (single-`appendFileSync` lines), the transcript
  reader's carry/offset/type-sniff machinery buys nothing on an in-memory
  text, and both splitters have torn-line tests. Revisit only if ledgers ever
  need incremental tail parsing.
- **S09 — coverage readings (accepted).** (1) Zero tool events ⇒
  `ledgerCoverage: 'partial'` ("no tool events recorded"): an empty ledger
  cannot attest hook coverage, so a chat-only session is deliberately never
  `'all-tools'`. (2) For gemini/copilot/hermes/dsh one recorded tool event
  attests the whole managed hook block; hand-editing single entries out of
  the managed block is out of scope for v1.
- **S09 — blank interim finals (fixed).** Empty-text `agent-response` lines
  no longer count in `interimFinals` (a blank line can never be a final).
- **S06 — result-text cap (fixed).** `capResultText` treats the 1 Mi cap as
  a UTF-16 code-unit memory bound; a multibyte-heavy string within that cap
  is kept whole. The old byte-length early-return made head and tail overlap
  and *lengthen* such a string with a duplicated middle.
- **S06 — denial kinds (fixed).** `toolDenialKind` present ⇒ denied, per
  §4.2.5 (b): `sandbox-denied` maps to itself, unknown future kinds fall
  back to `tool_use_error`. Previously only three literals were mapped.
- **S06 — interrupted streams (fixed).** A usage row whose `message.id`
  appears in a later line's `interruptedMessageId` is flagged `interrupted`
  (new optional `UsageRow.interrupted`), not `incomplete`, per §4.2.2
  "billed once and flagged `interrupted`". Billing is unchanged. The 2.1.235
  golden's `incomplete`/`incompleteMessages` moved 38 → 36 (its two
  interrupted streams); no `verify:real` pin involves those counts, and all
  pins still PASS on the frozen bytes.
- **S07 — inherited snapshot (fixed).** `mergeSubagents` now matches
  §4.2.7's inherited rule against main-file rows only (`agentId === null`),
  so a second merge (the reader's inline-then-dir double call) can no longer
  mark a row inherited for sharing an id with a previously merged subagent
  row. Main-file ids still inherit on any later merge.
- **S07 — unreadable subagent files (fixed).** An enumerated `agent-*.jsonl`
  that cannot be opened leaves `subagent file <name> unreadable` in
  `diagnostics.notes` instead of vanishing silently.
- **S07 — nested spawn ordering (test added).** A synthetic case now asserts
  every merged event of a nested agent sits after its own spawning call
  inside the parent agent's file (the 2.1.235 fixture only pinned linkage).
- **S07 — 2.1.241 journal (accepted).** The fixture ships no
  `journal.jsonl`; "counted, never parsed" stays pinned by the synthetic
  enumeration test. The fixture is not extended (S03 owns generation).
- **S08 — Codex MCP heuristic (kept + trace).** `codexToolKind` keeps the
  broad double-underscore test — Codex MCP tools are named `server__tool`,
  without Claude Code's `mcp__` prefix, so restricting to `mcp__` would
  misclassify real MCP calls — but a non-`mcp__` match now bumps
  `unknownCodexPayloads['mcp-name:<name>']` so the catalogue surfaces the
  shape.
- **S08 — step-text arithmetic slip.** The step's "352 zero-delta duplicates
  across both files" reused the per-file figure (§4.3.5's "352 of 706" in
  one rollout); the cross-file total is 359 (7 + 352). `verify:real` pins
  359.
- **S08 — stdin wording (routed).** The reader records structured facts only
  (`stdinWrites[{seq, chars, interrupted?}]`, `target.interrupted`); the
  "interactive input" / "interrupted by Ctrl-C" wording belongs to receipt
  composition/rendering — noted in the S18 step file so it is not dropped.
- **S08 — defaulted patch exit (accepted).** An exec-delivered `apply_patch`
  whose output matches no parser keeps `exitCodeSource: 'parsed'` for its
  defaulted exit 1 (the union has no 'default' member); commented at the
  site, and such a call is `isError` and never green either way.
- **S05 — cache key granularity (accepted).** `cacheKey` hashes the
  discovery-spelled path (realpath at the root only, §4.1); a transcript
  that is itself a symlink keys by its spelled path. S27b must realpath a
  hook-provided `transcript_path` before cache lookup (noted in the S27b
  step file).
- **S05 — index concurrency / beside-file manifests (accepted).**
  `index.json`'s read-modify-write is last-writer-wins: entries are never
  corrupted and a lost slot only costs one incremental-parse opportunity;
  single-writer in practice and self-healing on the next put. Beside-layout
  agent files joining every session's `subagentManifest` (so one beside-file
  change invalidates the project's sessions together) is deliberate —
  attribution needs parsing, which discovery must never do.
- **S10 — frozen-id prefixes (accepted).** The 8-character session-id
  prefixes in `scripts/verify-real.mjs` stay: the script is author-only,
  runs against local logs, and a prefix identifies nothing beyond a
  session's existence; the redaction pipeline's full-id hash list
  intentionally cannot match prefixes. Recorded here in lieu of a
  docs/privacy.md (not yet created).
- **S10 — goldens throughput.** The throughput line is written straight to
  `process.stdout` (vitest's console intercept swallows `console.log` from
  `afterAll`), and the 60 MB/s floor is asserted by a
  `SHOWRECEIPTS_PERF=1`-gated test in `test/goldens/readers.test.ts` — plain
  `npm test` runs suites in parallel, which roughly halves the measured MB/s
  and would flake the floor.

## W2 — Ledger, claims, cost (S11–S16, lead)

Review-pass minors resolved at the wave close. Fixes below landed with unit
tests; `typecheck`, the full suite, coverage thresholds, `accuracy`,
`lint:nonet`, `deps:guard` and `size` are green after them.

### S11 — shell lexing, segments, families

- **`mvn:verify|package` → family `test` (ratified).** §4.5.6's build row
  (`mvn:package|compile|verify`) conflicts with §7's maven detection
  (`mvn test|verify|package` + the surefire/failsafe tail). §7 wins: a
  `verify`/`package` that prints no surefire summary parses no counts and
  stays `green: unknown`, so nothing is over-credited; `compile` alone stays
  `build`.
- **`-p` stays a subset flag for every runner (ratified).** §4.5.6 lists
  `-p` in the one subset-flag list, so `pytest -p no:cacheprovider` (a plugin
  flag) is labelled `subset` with the plugin name as target — a false
  positive in the conservative direction (subset is weaker evidence than
  full), now pinned in `families.test.ts` rather than special-cased against
  the architecture text.
- **`make`/`just`/`gradle` target folding (fixed, W2 close).** Folding now
  skips the runners' value-taking flags before picking the target
  (`make -C dir test` → `make:test`, argv keeps `-C dir`; make's `-j`
  swallows a separate value only when numeric, as make itself does),
  mirroring `gitSubcommand`.
- **Lex perf budgets (fixed, W2 close).** The coverage multiplier rose
  6x → 10x: a warmed best of ~31 ms was observed for the 5 ms case under
  coverage on a machine loaded with parallel build agents, past the old
  30 ms budget. Uninstrumented budgets stay 5/20 ms per the S11 acceptance
  line; the guarded pathologies cost seconds, so 50/200 ms stays decisive.

### S12 — fact extractors

- **Additive type changes ratified.** `DangerFlag` kind `'kill'` (§4.6.8
  lists `pkill -f` with no matching kind), `WriteFact.metadataOnly`
  (`mkdir`/`touch`/`chmod` never reach `filesChanged`), and the one-line S04
  reader change deriving `call.created` from the Write tool's
  `type: 'create'` result (§4.6.1 requires `created`). All additive and
  commented at the site.
- Whether §4.9 staleness (S17) should ignore `metadataOnly` writes (a
  `touch` bumping `W` between an edit and a test run) is S17's call; carried
  there as an open note.
- The ~100-line fixture-loader boilerplate duplicated across the five
  extractor test files is accepted for W2; hoist into a shared helper (with
  the S03 owner) only if the case format ever changes.

### S13 — runner/check parsing, integrity

- The builder report's "53 index entries" was a count slip — the file has 52
  (23 runner green/red pairs plus variants), and the 23×2 presence is
  test-asserted. No code change.
- `parseOutput` parses the final 1 KB slice first and keeps a successful
  tail parse. A summary line cut exactly at the slice boundary could in
  theory lose a leading token, but every §7 runner prints its summary within
  the final KB and a red run's non-zero exit vetoes green regardless.
  Accepted for v1.

### S14 — ledger assembly

- The S14 checklist line "per-turn `W` excludes test-file writes" is a
  wording slip: `W` counts any `ok` write (§4.8 `W_all`) and `Wsrc` is the
  excluding counter, per the S02 type doc the code follows. Code unchanged.
- W2 close: tests added for the transcript-path home fallback (home-prefix
  and config-dir forms, plus home `''` — `~` collapses to `/`, never a
  guessed user) and for a tool call whose `turnIndex` has no `Turn` (a
  `perTurn` entry still appears; no Turn counter is touched).

### S15 — claim extraction

- **Widened trigger fragments (ratified).** Several trigger regexes are
  deliberately wider than the §6.1 prose (modal/negation forms of
  `test.pass`, `-strict` suffixes for the tools rules, sentence-initial
  `check.build`, …). The generated rule table (`scripts/gen-claims-doc.mjs`,
  pasted into `docs/claims.md` by S33) is the source of truth over the §6.1
  prose; the 271-line corpus holds the widened forms at 100 %
  precision/recall (`npm run accuracy --min 1.0`).
- **Cue-list equivalences vs §4.7 step 5 (accepted).** `about to` lives in
  `HEDGE_RE` only (deferred is checked before negated, so behaviour
  matches); bare `expect(ed)` is intentionally absent (sentence-initial
  `Expect …` is imperative; `as expected` is a genuine `verify.generic`
  positive).

### S16 — pricing

- `mergeTables` versions an override as
  `sha256(stableStringify({defaults, models}))[:8]`, not raw file bytes:
  JSON-equivalent reformatting keeps the version. §8.1 says only
  "sha256(override)[:8]"; the canonical-form reading is deterministic and
  test-pinned.
- `pickWindow` assumes dated windows are contiguous and ordered as in §8.2
  (first window containing the day wins; a day before every window prices as
  the earliest window + `estimate`). The bundled table satisfies this;
  override authors must keep windows contiguous. Not validated in
  `validateTable` for v1.
- Multiplier-based `cacheRead` renders as `0.1× input` in the generated
  provenance table; S33 confirms the wording when assembling
  `docs/prices.md`.

## W3 — Reconcile, pipeline (S17–S19)

### S17 — reconciler, explanations, false-done rate

- **§4.8 staleness ignores `WriteFact.metadataOnly` writes (lead-note
  decision).** A `touch`/`mkdir`/`chmod` between an edit and a test run bumps
  neither `W` nor `W_all`: metadata operations change no content, so counting
  them would flip a legitimately VERIFIED `tests pass` to `stale-run` (and a
  fresh commit to `commit-precedes-edits`) on a no-op. Pinned by the
  "staleness boundary" block in `test/unit/reconcile/cross.test.ts`. The same
  boundary also skips docs and the S17 non-executable list
  (`.md .txt .rst .json .yml .yaml .toml .lock LICENSE*`).
- `git-op-failed` already existed in §4.8 rows 15–16 and in the S02 `Reason`
  enum, so no ARCHITECTURE.md patch was needed; positive/negative cases are
  pinned in fixtures 15/16 and `cross.test.ts`.
- Evidence strings: `EvidenceRef.label` stays time-free (§4.8 vii);
  `evidenceStrings()` in `src/reconcile/evidence.ts` appends the `(HH:MM)`
  clock from `ref.at`, merges same-label refs (`Edit ×3 (17:31, 17:32)`) and
  then appends the judgement's notes as ` · note` — which reproduces the S17
  strings (`ruff → exit 1 (23:44) · 2 errors, never re-run`) while keeping
  `Judgement` JSON free of formatted times.
- The guarded `no-test-run` uses the session-wide `ledger.opaqueTestCapable`
  counter (S17 step text) rather than the per-turn `opaqueTestCommands` in
  the §4.8 row — the more conservative reading (post-final opaque commands
  also block the contradiction).
- `file.implemented_in` caps at UNVERIFIED (`no-evidence` + note) per
  Appendix E; `verify.generic` is never contradicted; a failed write only
  contradicts with `explicitVerb` (§4.8 row 7).
- `rate.ts`: excluded ledger sessions (effects-only or `partial` coverage)
  key their `ledgerIncompleteSessions` count by the session's `primaryModel`
  × harness × `harnessVersion`; included sessions attribute per turn
  (dominant model by output tokens). `integritySignals`, `testRunRate` and
  `cacheHitPct` count each contributing session once per row.

### S19 — Milestone M2: first real receipts; receipt goldens

**Decisions.**

- **"Every `EvidenceRef.seq` resolves to a tool call" is read as "resolves to
  a known session event".** The §4.8 absence facts deliberately point at the
  turn's final message (`absenceRef` → `finalSeq`, fallback `seqEnd`), and
  row 17 attaches the `pr-link` record as context to an UNVERIFIED `git.pr`
  (`prRefs` still never verify or contradict). The S19 resolution rule —
  pinned in `test/goldens/receipts.test.ts` and `scripts/dev-receipt.mjs` —
  therefore accepts: a tool call matched by `toolCallId`+`seq` (or bare
  `seq`), the receipt turn's final seq, or a `Session.prRefs[].seq`. Under
  this rule every real and fixture receipt has zero unresolved refs; without
  the prRef clause exactly one real ref (a `pr-link` context ref on a
  `no-git-op` judgement) failed, which is how the clause was found.
- **`expectVerdicts` covers the fixture's done turns, not only the default
  receipt.** The golden `receipt` section pins the default (last done) turn;
  the verdict-class assertion runs over `buildTurnReceipts`, because the
  redaction windows were chosen to keep claim sentences across turns. Two
  fixtures legitimately list no classes: `2.1.243` (no-turns) and `2.1.251`
  (its finals carry no claims).
- **Golden updates run file-by-file.** `readers.test.ts` and
  `receipts.test.ts` both rewrite `expected.json` (different sections) and
  vitest runs test files in parallel, so a combined `UPDATE_GOLDENS=1` run
  over `test/goldens` could interleave the read-modify-write. Update with
  `npm run goldens:update -- test/goldens/readers.test.ts` then
  `… -- test/goldens/receipts.test.ts` (plain compare runs are read-only and
  parallel-safe).
- **`codex/shell_command` re-dated (step 0)** to `gpt-5.6-terra` and
  2026-08-15 (rollout path, timestamps, `session_index`, `expected.json`
  source; reader golden regenerated). Engine-priced pins: 0.020749 at the
  from-2026-07-30 window, 0.025936 under `--as-of 2026-07-15` — the window
  switch S24/S26 will assert end-to-end. The two real `gpt-5.2-codex`
  rollout fixtures stay February 2026 and keep 0.068394 / 7.888091.

**Author run (2026-09-02, `scripts/dev-receipt.mjs`, cache disabled, built
`dist/`, prices 2026-08-29).** Per frozen file, over all done-turn receipts —
claims recognized, verdict counts (V/U/C/NS), session cost (API-equivalent
USD), cache-hit %, and cold wall time of the whole script run:

| file | done turns | claims | V | U | C | NS | cost | hit % | cold |
|---|---|---|---|---|---|---|---|---|---|
| `488dd663` (2.1.214→2.1.236) | 114 | 310 | 218 | 43 | 1 | 48 | 314.127548 | 99.34 | 0.88 s |
| `bceb4d10` (2.1.235) | 37 | 98 | 34 | 33 | 1 | 30 | 849.872297 | 98.44 | 1.46 s |
| `db935e59` (2.1.241) | 15 | 16 | 3 | 5 | 0 | 8 | 432.388597 | 97.24 | 0.75 s |
| `019c45e8` (codex 0.98.0) | 2 | 1 | 0 | 1 | 0 | 0 | 0.068394 | 87.23 | 0.22 s |
| `019c4678` (codex 0.98.0) | 67 | 49 | 10 | 29 | 0 | 10 | 7.888091 | 96.75 | 0.32 s |

Total cold ≈ 3.6 s over 122 MB (< 6 s acceptance). Zero unresolved evidence
refs on every file under the rule above.

Representative evidence lines (top 3 per file, command text only):
`488dd663` — `git commit → <sha> (20:13)`,
`uv run pytest -q → exit ? · 20 passed (20:12)`,
`uv run mypy src/<proj>/ → exit 0 (20:12)`;
`bceb4d10` — `no git push in log (07:33)`, `npx eslint . → exit 0 (07:26)`,
`npx tsc --noEmit → exit 0 (07:26)`;
`db935e59` — `no test run in log (23:16)`, `git commit (Aug 24 01:37)`,
`uv run pytest -q → exit ? · 397 passed (Aug 24 01:35)`;
`019c45e8` — `script ran (05:09) · write not observable`;
`019c4678` — `no write to src/io/ in log (08:15)` (+2 siblings).

Sanity rules from the step, all verified on the real files: `git.commit`
claims are VERIFIED with the sha when a `gitOperation` commit fact exists
(e.g. `<sha>`, `<sha>`); a `pr-link` never verifies or contradicts
`git.pr` (the one real `git.pr` claim stays UNVERIFIED `no-git-op` with the
pr-link as a context ref, and `referenced PR #N` renders under ALSO DID);
both real CONTRADICTED lines print a contrary fact (a `writes-despite-no-change`
with the Write evidence, and a `file-not-deleted` with the edit evidence);
the header-only session parses as `kind:'no-turns'` (pinned on the 2.1.243
fixture); `019c45e8` costs exactly the §8.3 pin 0.068394.

**Observation for the S24 accuracy pass (no code change here).** The one
real `file-not-deleted` contradiction comes from a possessive delete phrase
("removed \<file\>'s \<thing\>"): the §4.8 row 9 direct-object regex treats
the PATH right after the verb as the object, and a possessive is not caught
by the `from|in` re-typing guard. Defensible from the printed evidence (the
file was edited, not deleted) but borderline as a reading of the sentence;
worth a corpus case when rules are next revised.

### W3 integration close (lead)

Wave-gate pass over S17–S19; the validation chain was green before and after
these changes. Review findings fixed rather than carried:

- **§5.2 ALSO DID order** — `pipeline/receipt.ts` now emits "N scripts may
  have written files" before failed patches, matching the §5.2 list order
  (S18 had the two swapped). No golden pins both lines in one window; a unit
  test now pins the relative order.
- **In-window PR ref** — the "referenced PR #N" line derives its EvidenceRef
  from the first *in-window* `prRef` instead of `session.prRefs[0]`, so the
  ref can never point outside the judgement window.
- **Warm/cold failed-patch parity** — the failed-patch path is parsed over
  `truncateBytes(maskSecrets(head), 512)` — the exact §4.9 cache bytes — so a
  secret-shaped token in a result head can no longer make a warm receipt
  differ from a cold one. `cache/cache.ts` exports `truncateBytes` and
  `RESULT_TEXT_CAP` for this.
- **`--hash-paths` bare tokens (§11.2)** — `util/hashpaths.ts hashStrings`
  gained an optional `extraTokens` parameter: bare username/home tokens are
  rewritten to `u:<8 hex>` after the path pass, so a username surviving as a
  hashed basename (`p:<hex>/<user>`) or inside a URL is caught. The
  receipt-level pass feeds it the home dir plus its basename when the
  basename is ≥ 6 chars (§13.4 precedent), keeping the fixtures' `/home/u`
  inert. S21/S22 import the pass and supply their own tokens; the "never
  extend" rule now reads "never extend beyond `extraTokens`".
- S19's real-session evidence excerpts above were genericised (`<sha>`,
  `src/<proj>/`) per the review checklist.

Carried unchanged (documented deviations, not defects): S17's session-wide
`opaqueTestCapable` no-test-run guard, `Explanation.row = 24` for echoed
claims, and evidence notes appended to the last evidence string (renderer
composition to be confirmed in S20).

### W4/S22 — HTML report; npm size limits raised (lead note)

**Size limits.** The npm tarball stood at 198.5/200 KB before this wave's
render assets. Per the post-W3 lead note, `scripts/size.mjs` limits are
raised rather than compromising the report: tarball 200 KB → **300 KB**,
unpacked 600 KB → **900 KB** (measured after S22: 242.9 KB / 875.8 KB with
the W4 renderers in `dist/`). Keep minifying sensibly first; the limits are
still hard gates under `--strict`.

**S22 shape decisions (renderer-local, no architecture change).**
- The `#data` block is one JSON object `{mode, payload, hashed?}` so `both`
  embeds two payloads while the document keeps exactly three `<script>`s.
- `--hash-paths` over a multi-session payload hashes each card/receipt/
  timeline against its own session cwd (rate rows against none), via the
  imported S18 `hashStrings` with `extraTokens` — never extended.
- Budget stage 2 marks hidden runs with in-band positional gap rows
  (`+N hidden`, flag `gap`) so the app can band them without a payload-type
  extension; per-session totals also come back as `BudgetReport.hiddenRows`.
- A degradation stage is recorded in `BudgetReport.degraded` only when it
  actually changed the payload; `overCap` stays true when even stage 3
  cannot get under 16 MB (the renderer/CLI warns, nothing is silently cut
  beyond the three stages).

### W4/S22 — review fixes (post-review pass)

- **§11.4/§11.2 completed, not deviated.** `report.js` now implements the
  full shortcut set (`o`, `/`, `t`, `h`, `[`, `]`, `e` alongside
  j/k/arrows/Enter/Esc/`?`), the §11.2 model / project / date-range /
  text-search filters (regex-validated router keys `fm`/`fp`/`d1`/`d2`/`q`;
  search covers title, cwd, model and the receipt's claim texts), the header
  scanned range + per-harness counts, and the §11.2 footer privacy note.
  The shortcuts on/off switch moved from the header into the `?` sheet per
  §11.4; a header `?` button opens the sheet by pointer, so the switch stays
  reachable with shortcuts off — and with them off, `?` no longer fires
  (only Esc still closes the open sheet, as a dialog escape rather than a
  WCAG 2.1.4 single-character shortcut).
- **Remaining §11.2 naming deviation (recorded).** Router keys are the S22
  `fh`/`fv`/`fm`/`fp`/`tf`/`q`/`d1`/`d2` set, not the `#h=…&v=…` example
  names of §11.2; "project" is the last path segment of the session cwd.
- **Export JSON (§11.2).** Now the specified
  `data:application/json;charset=utf-8` href with a per-session filename:
  `receipt-<shortId>.json` exporting the open session's receipt, or
  `receipt-all.json` exporting the whole payload from the overview. The
  (large) href is built lazily in the click handler so renders stay cheap.
- **§11.3 palette (recorded deviation).** The token vocabulary and several
  values differ from §11.3 (`ink`/`line`/`sel`/`pillInk`/`card` vs
  `fg`/`rule`/`row-hover`/`pill-bg`; bg `#f2efe9` vs `#f4f2ec`; accent
  `#0b57d0` vs `#0969da`; verdict pills are colour-filled with a
  white/near-black label instead of `--pill-bg`). The §11.3 scaffolding
  (light on bare `:root`, dark under the guarded media query AND
  `[data-theme="dark"]`) is exact, and `test/render/html-contrast.test.ts`
  now iterates the full §11.3-equivalent surface matrix —
  ink/muted/accent/ok/bad/unk over bg/card/paper/band/sel, both palettes —
  at ≥ 4.5:1 (stronger than the §11.3 floor, which allows 3:1 for
  glyph-only colours), plus the pill labels and the focus ring at ≥ 3:1.
- **`finalText` caps (§11.1).** The 16 KB `--full` cap is now inclusive of
  the appended ellipsis (truncate to 16 384 − 3 bytes, then `…`), and the
  600-char brief form carries the §11.1 trailer
  `…show full in session <shortId>`.
- **Open for the lead at the W4 gate (no unilateral change made).** Unpacked
  dist now warns just over the 900 KB cap (parallel W4 steps landed after
  the S22 measurement; this pass adds ~4 KB of report.js) — raise the cap or
  minify/trim dist before `--strict`. The pre-existing `src/` 12 000-line
  budget warning (~25k lines) also needs a ruling.

### W4/S23b — demo command, §10.2 sample reconciliation, SVG

**Reconciliation protocol.** The four §10.2 samples and the 60-column ASCII
sample are now the byte-exact output of
`demo --width 74 --tz utc --no-color --unicode` (narrow:
`--width 60 --ascii --no-color`) over the S23a scenarios, pinned in
`fixtures/render/samples-spec/*.txt`. The pins are written only under
`UPDATE_SAMPLES_SPEC=1` (one reconciliation pass), never by `UPDATE_GOLDENS`,
so renderer drift fails `test/render/demo.test.ts` even after a golden
refresh; regenerating them requires a new recorded decision here. No sample
text was hand-edited — every §10.2 change traces to a decision below.

- **(a) No ALSO SAID on the spec samples** — as planned: the four spec
  finals carry no negated, deferred, excluded or third-party clause; every
  other scenario's final has ≥ 1 negated claim (§14.1 patched).
- **(b) Stats zero items** — `0 test runs` stays alongside tool calls and
  files changed (§10.1 patched; S20 already implements it).
- **(c) Evidence clocks** — every evidence string carries `(HH:MM)` (S17)
  and wraps instead of dropping the time. At `E = 26` the long labels wrap,
  so §10.2 shows `ruff check . → exit 0` / `(23:29)` and
  `git commit → 1fc0c28` / `(23:31)` as two-line evidence cells rather than
  the plan's single-line guesses; `no git commit in log` gained `(23:52)`.
- **(d) Narrow header re-flow and ALSO DID continuation** — exactly the S20
  implementation; the 60-column sample is regenerated from it.
- **(e) Worst-first sample order** — §10.1's worst-first CLAIMED rule wins
  over the old §10.2 sample's ✓-first ordering; sample 1 now leads with
  `✗ Lint is clean.`.
- **(f) Claims render the extracted clause verbatim** — capitalised
  sentences with backticks and trailing periods
  (`✓ Updated `src/wattage/models.py`.`), not the old sample's normalised
  lower-case forms. The contradicted final was split into one sentence per
  claim (scenario tuning) so each file claim carries its own path.
- **(g) Evidence labels are the full segment text** — `ruff check . → exit 1`,
  `uv run pytest -q → exit 0`, `mypy --strict src → exit 0`; the old
  sample's short forms (`ruff`, `uv run pytest`, `mypy`) do not exist in the
  frozen S17 engine.
- **(h) Session-span token only from 2 day boundaries** — the all-VERIFIED
  overnight sample rendered ` · session Aug 23 → Aug 24 (1d)`, forcing a cwd
  shrink, though its end clock already names the day. `render/term.ts` now
  omits the token when `sessionSpan.days < 2` (§10.1 patched); the receipt
  JSON keeps `sessionSpan` unchanged.
- **(i) ALSO DID lines are the pipeline's real lines** — sample 1:
  `· 29 more files changed (src/wattage/, /tmp/demo-scratch/, tests/)` (the
  old "edited tests/test_normalize.py after last green run" bullet was
  untrue of the scenario: the test edit sits between green runs, so pytest
  stays VERIFIED); sample 2: `· 87 files changed (src/wattage/adapters/)`
  (no file claims, so nothing is "more"); sample 4 drops the `npm test`
  bullet (S18 lists unmentioned files, not unmentioned test runs).
- **(j) Codex scenario tuning** — the notebook heredoc runs detached
  (`exit: null`): with every other command inspection-free, frozen row 19
  yields `no-run-after-write`, so the receipt is `2 UNVERIFIED` as specced
  (a green heredoc would have VERIFIED "works as expected"). ALSO DID gains
  the reader's `· 1 command moved to background (exit unknown)` line. The
  §10.2 project is `~/proj/cyclone` (the S23a rename — the old name is on
  the fixtures' forbidden list), and the final's first sentence is
  `Created lea_col_drop_preview.ipynb.` so the claim fits the 36-column
  budget untruncated.
- **(k) Ruff tail tuning** — the red ruff output carries no
  `Found N errors.` summary line, so the check-red note is `never re-run`
  and the evidence fits its two lines; with the summary, line 2 truncated to
  `(23:44) Found 2 errors., …`.
- **(l) Durations tuned to the sample clocks** — codex `durationMin: 13.1`
  renders `04:56 → 05:09 · 13m`; cursor ledger `durationMin: 10` (stop event
  at −0.02 min) renders `10:02 → 10:11 · 9m`.
- **`demo` defaults (S23b).** `--tz` defaults to `utc` for `demo` (the
  global flag default stays `local`); the cache and user price overrides are
  never touched; `homeDir` is fixed at `/home/u`; render options resolve
  through S20 `resolveCols`/`decideUnicode`/`colorEnabled`; `--json` emits
  the receipts as one `stableStringify` array; hidden `--svg FILE` writes
  the first scenario's SVG. `demo` reads `process.platform` directly for the
  unicode default — the command context carries no platform seam (S23c/S24
  may rewire through `commands/common.ts`).
- **SVG (S23b).** Deterministic dark-paper document: paper `#12161c`, ink
  `#e6edf3`, ok `#3fb950`, bad `#f85149`, unk/warn `#d29922`, dim `#8b949e`;
  font-size 14 with `cw = 8.4`; one
  `<text xml:space="preserve" textLength lengthAdjust="spacingAndGlyphs">`
  per line; `<tspan fill>` runs parsed from the S20 SGR paint; only
  `svg|rect|g|text|tspan` elements, no scripts, links or external
  references (golden + hygiene tests in `test/render/svg.test.ts`).

### W4/S23c — command plumbing, hook inspection, JSON schema

- **`resolvable` is a static check, not a launcher run (§9 deviation,
  ARCHITECTURE patched).** `setup/inspect.ts` verifies the
  `~/.showreceipts/bin/launcher.json` sidecar (parses; `node`/`cli`/
  `launcher` paths exist; launcher executable) and never spawns —
  `child_process` stays confined to `commands/report.ts` (§13.4). Every
  hooks row carries `resolvableNote: 'static check; the harness process
  PATH may differ'`; the real `--version` run happens only in S31's
  launcher test. §9 and §12.3 were patched accordingly.
- **`DoctorHookReport.configReadable?`** (optional, S02 type extended): a
  config file that exists but fails strict JSON parsing is reported with
  `configReadable:false` and inspected best-effort through a comment-stripped
  parse (Gemini legitimately allows comments); it is never rewritten.
  Uninstalled harnesses still get a user-scope row (`installed:false`,
  `resolvable:null`) so `doctor` can say "not installed" per harness.
- **Usage errors below the cli layer.** §0.5 allows `commands → cli/args`
  only as a type-only import, so `commands/common.ts` cannot throw the
  argv `UsageError` class. It throws its own `CommandUsageError`
  (`name:'UsageError'`, `exitCode:2`, optional `command`), and
  `cli.ts reportFailure` now duck-types on `name === 'UsageError' &&
  exitCode === 2` (covers `render/box.ts`'s class too). Exit-2 semantics are
  unchanged for argv errors.
- **Non-hook EPIPE exit code (deferred decision resolved).** An interrupted
  pipe (`showreceipts audit | head`) is not a failure: `main` attaches an
  stdout `'error'` listener for non-hook commands that swallows EPIPE only,
  so the exit code stays whatever the command returned; any other stream
  error still surfaces. S26's e2e pins the behaviour end-to-end.
- **`--until` day semantics.** A `YYYY-MM-DD` value names its whole day: the
  boundary is the following UTC midnight (exclusive); `Nd` counts back from
  `ctx.now` with no bump. `LoadOptions` has no `until` — commands apply
  `Prepared.untilMs` after loading.
- **`SHOWRECEIPTS_NO_CACHE`**: any non-empty value except `0` disables the
  cache (the docs say `=1`; `=true` should not silently enable caching).
- **Platform seam.** `prepare(ctx, {platform})` defaults to
  `process.platform` (the context carries no platform, per the S23b note);
  it steers only the unicode default. `demo` keeps its own direct read.
- **Progress line.** `scanning … <done>/<total> sessions` on stderr, armed
  after 500 ms, repainted per session, cleared with CR + spaces before any
  output; no-op off-TTY and under `--json` (the S36 perf step reuses it).
- **Home price override is non-fatal (§8.1).** An invalid
  `~/.showreceipts/prices.json` adds one `Prepared.priceNotes` line
  ("… — override ignored"); an invalid or unreadable `--prices` file throws
  `PriceTableError` → exit 1.
- **Schema grammar.** `docs/receipt-schema.md` encodes §12.3 as
  ```schema-fenced JSON whose string values are annotations
  (`string|null`, `enum(a|b)`, `record(T)`, `const:X`, `[T]`, `Key?`,
  capitalised references). `test/helpers/schema.ts` validates structurally
  (required keys, primitive types, enum members); extra keys are tolerated
  so the schemas name the guaranteed surface. The schema self-tests live in
  `test/unit/helpers/schema.test.ts` (a file the step list did not name) and
  include validating `demo --json` receipts against the `Receipt` block.
- **`commands/help.ts` owns the shared §12.4 option table** going forward
  (the cli layer may import commands, never the reverse);
  `test/unit/commands/help.test.ts` pins its rows against `cli/args.ts`
  `FLAG_SPECS` and the S01 renderer so the copies cannot drift.
- **`fixtures/inspect/**` is fully synthetic** (every path under `/home/u`,
  `__ROOT__` placeholders for the launcher sidecar); the standing
  fixtures-privacy scan covers `src/` and `test/` by hash, and the new tree
  adds no real identifier.

### W4 integration close (lead)

Wave-gate M3 pass over S20–S26. The full chain (typecheck, build,
unit/golden/render/fuzz suite, e2e, lint:nonet, deps:guard, size) was green
before and after these changes; review findings were fixed where cheap and
safe, and recorded here where a deviation is the better engineering call.

Fixed at the gate (code):

- **Session prefix matching covers the transcript filename (§4.1).**
  `pipeline/resolve-session.ts resolveId` now also matches a prefix of the
  transcript file name (case-insensitive), and a bare `*.jsonl` selector that
  names no file on disk falls back to id/filename matching instead of failing
  as a path — so `session rollout-2026…` resolves a Codex session, as §4.1
  promises. `session`/`export` share the resolver; tests added.
- **`report.js` conforms to the §11.2/§11.4 storage keys and §4.1 short
  ids.** The localStorage keys are the architecture's `showreceipts.theme` /
  `showreceipts.keys` (were `sr-theme`/`sr-keys`, an S22 naming deviation no
  longer worth carrying), and the router's `s` regex is `{8,12}` (shortIds
  are 8 hex, widened to 12 on collision — `{8,16}` was looser than anything
  the tool emits).
- **Timeline last-green band survives flag filters.** The `· after last
  green run ·` band was silently dropped when a timeline flag filter (e.g.
  `tf=write`) hid the last green test row, because the band was appended
  inside the same callback that early-returns on filtered rows; it is now
  appended on the filtered branch too (source-pinned in
  `test/render/report-js.test.ts`).
- **`export --help` matches §12.1.** The options row read
  `--hash-paths [=both]`; `=both` (the HTML toggle) belongs to `report`
  only. The argv layer still tolerates `--hash-paths=both` for `export`
  (treated as plain `true`) so nothing written against the old help breaks.
- **Appendix D "at most one `/`" enforced literally.** `bench/validate.ts
  checkString` refused a slash only outside `schema`/`generator.rulesVersion`;
  a second slash *inside* those two paths now also refuses (unreachable via
  the compile-time constants today — hardening only). The command-level
  refusal wiring (validate → `bench --publish refused: <rule>` on stderr →
  exit 1, nothing written) gained a direct test: a home directory literally
  named `showreceipts` makes the username scan hit the payload's own
  `schema` string.
- **Demo DSL cleanup (S23a review).** The inert `Scenario.hosts` field is
  gone (the pip/gh commands already carry the hosts, with comments); the
  no-op `.replace('T', 'T')` in the Codex rollout stamp is deleted with a
  comment that the demo stamp is UTC by design; the §10.2 sample-3 test now
  pins `counts.UNVERIFIED` to exactly 2 (decision (j) restructured the
  scenario, so S23a's documented relaxation is no longer needed).
- **e2e diagnosability (S26 review).** `cache.test.ts`'s cold run is a lazy
  memo and `pack.test.ts`'s global install moved into `beforeAll`, so a
  spawn failure attributes to a named test or hook instead of file
  collection (and dependent pack tests skip instead of crashing on an unset
  `cli`); `version.test.ts`'s title now says what it asserts (the 80 ms
  median is a recorded soft budget with a ×3 pathology ceiling; the hard
  perf gates are S36's). `report.test.ts` keeps its describe-scope runs —
  same class, but a failure there is a clearly attributed collection error,
  not a crash.

Ratified as deviations / rulings (no code change):

- **The boxed receipt omits the `claims recognized: N (of which M not
  scored)` line.** §5.3/§12.3 say "always printed"; the byte-pinned §10.2
  samples show no such line, and S20 followed the samples. Ruling: the
  guarantee holds on the JSON surface (`claimsRecognized`, `notScored`,
  `sentencesScanned` are always in the Receipt) and in the `no-claims`
  kind's body text; read §5.3's "always printed" as "always present in the
  receipt data".
- **Invalid `--turn N` is exit 2 (usage error), not 5.** §12.2's exit-5 row
  covers session *resolution* only; a turn index outside the session is a
  usage error. `session` and `export` behave identically (e2e-pinned).
- **The report CSP directive list is shorter than §11.1 and strictly
  tighter.** The emitted policy is `default-src 'none'` + hashed
  `script-src`/`style-src` + `base-uri 'none'`/`form-action 'none'`;
  §11.1's `object-src 'none'` is subsumed by `default-src 'none'`, and
  `img-src data:` would *loosen* the policy for images the report never
  embeds. Deliberate; do not add them.
- **Progress-line `isTTY` means stdout.** The S23c `scanning …` line is
  suppressed whenever stdout is piped (which also protects redirected
  output); a piped-stdout/interactive-stderr run shows no progress line by
  design.
- **`bench --month` mtime prefilter.** A transcript restored with an mtime
  older than its content dates is excluded from a published month (the
  prefilter is month start − 1 day). Accepted for v1: the fixture
  materialiser guarantees mtime == endedAt and real trees satisfy it
  naturally; revisit only on a real report.
- **The S24 acceptance header count is stale; the code is right.** Over the
  fixture tree the audit header reads `Claude Code 6 · Codex 3` under
  `--since 2026-01-01` (the legacy 2025-09-01 Claude Code fixture sits
  outside the window) and `7 · 3` under `--all`; both are pinned. S37's DoD
  pass should read the S24 acceptance line accordingly.
- **Hermes `configReadable` stays `true` for unscannable YAML** (S23c
  review): the light line-scan reports "no hooks" rather than "unreadable";
  distinguishing the two is a possible W5 `doctor` refinement, not a §9
  requirement.
- **Size budgets carried to S36** (warn-only today): `src/` 28,441 lines vs
  the plan's 12,000 (§2's own ceiling is 14,000 — also exceeded; the
  mandated JSDoc/test density was priced into neither number) and unpacked
  1,023.4 KB vs 900 KB. Ruling: keep the warnings and do not raise caps
  piecemeal mid-build; S36 must minify/trim `dist/` first and re-set both
  budgets with a recorded justification before `--strict` becomes the hard
  gate.
- **Missing step files restored.** `steps/S23b.md`, `S23c.md`, `S24.md` and
  `S25.md` were re-extracted from the recovery capture
  (`scratchpad/s24-recovered.txt`) into the design steps directory so later
  waves and review passes can cite them. Step files S01–S16, S19 and most of
  W5/W6 (beyond S27b/S36) are still missing on disk — the orchestrator
  should recover them before those waves start.

### W5/S32 — live hooks on this machine (M4; author-only verification)

`scripts/verify-hooks-local.mjs` — 68 checks, all PASS (2026-09-04). It only
reads real files and writes exclusively into `mkdtemp` directories; on any
machine without the real roots or the frozen files it prints `skipped` and
exits 0, so the Validate chain stays green on CI.

- **`setup` in a temp HOME over a copy of the real Claude Code user
  settings.** Dry-run writes nothing (settings byte-identical, no backup, no
  launcher). The real run's diff adds only the `hooks` key with exactly
  `Stop` (plus `SessionStart` with `--strict` — both variants exercised in
  separate temp homes); every pre-existing key is byte-for-byte untouched;
  the backup lands under the temp `~/.showreceipts/backups/claude-code/`
  with the original bytes; a second run reports `unchanged`, writes no new
  backup and leaves the file byte-identical.
- **Simulated Claude Code `Stop` over the frozen 39.3 MB (37.5 MiB) real
  transcript**, stdin built read-only from its real last turn via the dist
  reader (`session_id`, `prompt_id`, real final text): exit 0,
  `systemMessage` stdout, `last-receipt.{md,json}` written in the temp repo,
  flush guard matched (no `incompleteAtStop`). Timings on the author's
  machine (parallel build agents running): cold ≈ 1.4–1.5 s (budget < 5 s),
  warm ≈ 1.4 s (budget < 1.5 s), warm receipt byte-identical to cold. The
  warm margin is thin because on a transcript this size loading the cached
  parse costs nearly as much as the incremental cold parse; both runs sit
  well inside the 20 s hook budget.
- **Simulated Codex `Stop` via the `session_id` suffix lookup**
  (`transcript_path: null`, real `CODEX_HOME`, rollout found under
  `sessions/**`): cold ≈ 0.34 s, warm ≈ 0.26 s, flush guard matched,
  receipts byte-identical across runs.
- **`doctor` over the real roots** with a temp `SHOWRECEIPTS_HOME`: exit 0
  for both the human and `--json` runs (≈ 7 s first scan of the real trees,
  ≈ 0.8 s from cache), `problems=0`, `warnings=4` (unverified prices, no
  hooks installed — expected). `--json` shape (keys only): top level
  `cache, harnesses, hooks, ledgers, node, prices, problems, roots,
  warnings`; per-harness rows `badLines, bashWithoutToolUseResult, bytes,
  emptyProjects, emptySessions, excludedSyntheticLines, found, harness,
  installedVersion, journals, legacyShapes, lineSeparatorChars,
  orphanSessionDirs, root, sessions, subagentFiles, unknownCodexPayloads,
  unknownContentBlocks, unknownRecordTypes, unknownSubtypes,
  unknownToolShapes, unrecognisedFiles, versions`; hook rows `command,
  configPath, disabled, harness, installed, otherStopHooks, resolvable,
  resolvableNote, scope, strict, trusted`.
- **Real-config invariant, macOS deviation.** BSD `ls` has no
  `--time-style=full-iso`, so the before/after proof is an lstat metadata
  snapshot (size + nanosecond mtime; file contents never opened, symlinks
  not followed) of both real roots — strictly stronger than the planned
  `ls -la` diff. The whole real Codex root, the real settings file and the
  frozen transcript's entire project directory are asserted unchanged;
  changes elsewhere under the real Claude root would be reported separately
  as live-session activity (a running Claude Code session writes its own
  files while the script runs), but in the recorded runs nothing at all had
  changed.
- **No git.** Temp "repos" are a bare `.git/` directory — the gitroot walk
  only stats the marker — so the script never invokes git anywhere.

### W5 integration close (lead)

Reviewer minors from S27–S32 (plus the S35 fixture-privacy notes) resolved at
the wave gate; full chain re-run green (typecheck, build, unit, lint:nonet,
deps:guard, size, e2e/hooks/setup, `verify-hooks-local`).

- **S27 runtime: exactly-once counter flush + in-process exit seam.** The
  watchdog/last-resort paths now empty the counter delta as they persist it
  (`flushCounters`), so a non-terminating injected `exit` can no longer fold
  the same delta twice via the `finally` flush; `commands/hook.ts` injects a
  no-op `exit` seam whenever streams are injected, so an in-process caller
  (vitest worker) can never be terminated by the watchdog or the last-resort
  handlers. Regression test: `test/unit/hook/runtime.test.ts` (fake clock,
  handler outliving its budget).
- **S27 `record.ts` oversize-gap semantics documented.** The final
  degradation gap's `bytes` is the serialised size of the clamped line that
  still broke the 256 KiB cap (the only size knowable there), unlike stdin
  salvage gaps whose `bytes` count the drained stdin — now stated in the
  `prepareLedgerLine` JSDoc.
- **S27 `hook.log` growth: tracked, not fixed in W5.** The debug log is
  append-only and unbounded; a size note in `doctor` or a cap is a W6 item
  (S33/S36) — deliberately out of hook-path scope (the hook must stay
  simple and never fail).
- **S29 Gemini `t` normalised to UTC.** `common()` re-renders a parseable
  event `timestamp` through its epoch (`new Date(parseIso(s)).toISOString()`)
  instead of storing the stamp verbatim, so a `±HH:MM` offset can never leak
  into a ledger `t` (Appendix C declares `t` ISO UTC). Test added.
- **S29 duplicated regex evaluation removed** in `cursor.ts` (`toolFail`
  exit-code parse) and `gemini.ts` (`Exit Code:` line): the match is bound
  once; behaviour unchanged.
- **S28 `max_tokens` tail is terminal, like `stop_sequence`.** The Claude
  Code flush guard classifies a tail assistant line with `stop_reason
  "max_tokens"` as terminal: the transcript is flushed as far as it will
  ever be for that turn, so the Stop no longer burns 3 × 150 ms re-reads or
  fabricates `incompleteAtStop` + a stale-ledger note. Like the documented
  `stop_sequence` deviation, such a final is never eligible (§4.2.3), so the
  receipt renders as the transcript stands (`no-final`). Test added beside
  the `stop_sequence` one.
- **S28 Codex `capStdout` arithmetic.** The truncation budget now subtracts
  the 3 UTF-8 bytes of the appended `…` (was 1), so the re-serialised answer
  can never exceed `CODEX_STDOUT_MAX_BYTES`; boundary tests added
  (`capStdout` exported for them).
- **S30 `--restore` scope note.** Backups are keyed by harness directory +
  config basename, and project- and user-scope configs of a harness can
  share a basename — `--restore` must be run with the same
  `--project`/`--shared` scope flags as the setup run that wrote the backup.
  Documented in `setup` help (long text + flag line) rather than changing
  the backup name format this late; a scope-stamped backup name is a
  candidate for 0.2.
- **S30 minified-JSON reformat accepted.** `detectJsonFormat` falls back to
  two-space multi-line for a single-line config; the merge remains valid,
  backed up and diff-reported, and §12 only mandates indent/newline
  detection for multi-line files. No change.
- **S31 fixture layout deviation accepted.** `fixtures/hooks/` variant cases
  use `<event>-<variant>` directory names with `${FIXTURE_DIR}`/`${SR_HOME}`
  placeholders (documented in its README; `expected.json.event` carries the
  real event name). Conformant enough; not worth a rename churn at the gate.
- **S31 off-CI budget cushion.** `test/hooks/contract.test.ts` now applies
  ×2 to the class budgets off CI (CI keeps ×3): observed spawn times sit
  5–10× under the raw budgets, and the cushion removes the flake risk on a
  loaded developer machine without weakening the CI gate.
- **S30/S31 launcher `--version` execution overlap reconciled: kept.** §9
  designates `test/hooks/launcher.test.ts` as the launcher-execution suite;
  `test/setup/launcher.test.ts` also runs `--version` once, from a
  space-containing HOME, as an S30 acceptance criterion. The two exercise
  different concerns (install-time resolution vs the four execution
  scenarios); the architecture note is amended here rather than dropping
  either test.
- **S32 cosmetics.** `verify-hooks-local.mjs` labels the `size/2^20` figure
  `MiB` (was `MB`); the thin warm-Stop margin stays flagged for the W6/S36
  perf pass; the live-session fail-zone deviation stands as documented
  above.
- **S35 fixture privacy (rule 7).** The two W5-adjacent `corpus.jsonl` fp
  pins were re-synthesised so they keep only the misfiring grammatical shape
  (possessive path + delete verb; hypothetical path-less no-change marker)
  and share no distinctive multi-word run with the real transcripts; the
  `nochange.marker` paraphrase in the labelling file dropped its quoted
  fragment, and `docs/accuracy.md` was re-rendered (`label.mjs --render`,
  only the two paraphrase lines changed). `npm run accuracy` still 100 %.
  The CONTRADICTED precision sample remains n=2 (the whole real pool);
  resampling after more real sessions accumulate stays a pre-1.0 checklist
  item.
