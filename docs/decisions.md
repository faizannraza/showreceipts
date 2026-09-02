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
