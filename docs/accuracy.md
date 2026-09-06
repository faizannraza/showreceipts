# Accuracy

*How often `showreceipts` is right when it scores a claim — measured, not asserted.*

Every number below is computed by `node scripts/label.mjs --render` from a
hand-labelled sample of the author's own real sessions. The labelling files
(`fixtures/labels/*.jsonl`) are **git-ignored and never leave the author's
machine**; this page carries only aggregates, rule ids and short paraphrases.
Re-running `--render` over the same labelling files reproduces this file
byte for byte.

- Rules version: `claims/1+reconcile/1` at sampling time (current: `claims/2+reconcile/2` after the demotions below) · tool `0.1.0`
- Sample: 100 claims (of 548 candidates) and 50 sentences (of 4580), drawn 2026-09-04 with seed 35 from 9 local sessions (7 claude-code, 2 codex)
- Verdicts available in the pool: 2 CONTRADICTED, 298 VERIFIED, 128 UNVERIFIED, 120 NOT_SCORED

## The definition (ARCHITECTURE §5.4, verbatim)

The receipt's headline number is the **false-done rate**. Its exact definition:

- **Denominator**: done turns = human/skill turns with an `end_turn` final containing ≥ 1 scored claim or a completion marker (`doneTurnsByTrigger {claims, markerOnly}`); `byTrigger {human, notification}` records whether the final followed a task notification. Turns without claims are `turns`, not `doneTurns`.
- **Numerators**: `contradictedTurns`, `unverifiedTurns` (none contradicted and ≥ 1 UNVERIFIED, or marker-only), `cleanTurns` (all scored claims VERIFIED, ≥ 1).
- **Grouping**: model (dominant model of the turn by output tokens) × harness × `Turn.harnessVersion` (full; HTML collapses to `2.1.x`). Effects-only ledger sessions and `ledgerCoverage:'partial'` sessions are excluded and counted in `ledgerIncompleteSessions`; Copilot turns with a parsed transcript final and Hermes turns with `post_llm_call` text are included.
- **Display**: "`<contradicted> of <done> done turns contradicted (<pct>%)`"; percentage hidden below 10 done turns (`—  (3 of 4)`); `testRunRate` = sessions with ≥ 1 test run / sessions; `costPerDoneTurnUsd` median/mean (null for ledger sessions). Definition published verbatim in `docs/accuracy.md`.

## Hand-labelled verdict precision

One row per verdict over the stratified sample (targets 30/30/20/10).
A label of *correct* means the verdict is right for the sentence given the
session's tool log; *unclear* rows are excluded from the precision denominator.

| verdict | sampled | correct | wrong | resolved | unclear | precision |
|---|---|---|---|---|---|---|
| CONTRADICTED | 2 | 0 | 0 | 2 | 0 | — (n = 0) |
| VERIFIED | 49 | 45 | 1 | 0 | 3 | 97.8 % (n = 46) |
| UNVERIFIED | 28 | 24 | 4 | 0 | 0 | 85.7 % (n = 28) |
| NOT_SCORED | 21 | 20 | 1 | 0 | 0 | 95.2 % (n = 21) |

*wrong* counts unresolved mis-verdicts; *resolved* counts mis-verdicts already
fixed by a rules bump — they leave the precision denominator but stay in the
false-positive table below.

**Gate (§14.3): CONTRADICTED precision ≥ 95 % — PASS by demotion (2 sampled false positives, all demoted in `claims/2+reconcile/2`; no unresolved CONTRADICTED error remains).**

## Coverage per kind (50-sentence sample)

Precision says the claims we score are judged correctly; coverage asks the
opposite question — of the sentences a human reader would call a claim, how
many did the extractor recognise at all? Labelled over 50 sampled
sentences (19 human-called claims, 17 of them recognised; 8 recognised sentence(s) the human called no claim).

| kind | human-called | recognised | coverage |
|---|---|---|---|
| check | 4 | 4 | 100.0 % |
| file | 3 | 2 | 66.7 % |
| git | 5 | 4 | 80.0 % |
| no-change | 1 | 0 | 0.0 % |
| test | 5 | 5 | 100.0 % |
| test-added | 1 | 0 | 0.0 % |
| test-ran | 1 | 1 | 100.0 % |
| verification | 8 | 5 | 62.5 % |
| **any kind** | **19** | **17** | **89.5 %** |

Coverage is deliberately conservative: the receipt always carries the
recognized-claim count (JSON `claimsRecognized`; the Markdown export and the
terminal no-claims box print it) and never implies it scored every assertion.

## False positives observed

Every sampled claim labelled *wrong*, the rule that misfired, and the fix.
Sentences are paraphrased — no session text is reproduced here.

| rule | verdict | what the sentence said (paraphrased) | fix |
|---|---|---|---|
| `nochange.marker` | CONTRADICTED | a note that a demo speed value can be tweaked later, read as a claim that no changes were made | reconcile/2 demotes the path-less no-change contradiction to UNVERIFIED; a cue fix for hypothetical/instructional scopes is the claims/3 candidate |
| `file.verb` | CONTRADICTED | removing a redundant check inside a file ("`x.py`'s … check") parsed as deleting the file itself | reconcile/2 demotes the edited-not-deleted contradiction to UNVERIFIED; the possessive-path parse is pinned in the corpus for a claims/3 extractor fix |
| `verify.generic` | VERIFIED | confirming an external website's state, auto-verified by an unrelated green test run | verify.generic (row 19) should not accept an arbitrary green run as evidence for claims about external services |
| `git.push` | UNVERIFIED | a description of what an upcoming push will send ("it'll send …"), scored as a push claim | future-tense "it'll / it will" inside the clause should defer the claim |
| `install.pkg` | UNVERIFIED | a statement that the published package is installable, with the install command quoted, scored as an install claim | install.pkg should skip quoted installation instructions with no completed-action verb |
| `git.push` | UNVERIFIED | a "How to commit and push" heading, scored as a push claim | instructional "How to …" headings should be cue-scoped as instructions, never scored |
| `git.push` | NOT_SCORED | a completed force-push followed by a parenthetical "would have refused if …" aside, mis-classified as deferred | conditional cues inside a parenthetical must not re-scope the main clause's past-tense verb |
| `git.commit` | UNVERIFIED | instructions telling the user how to commit ("To commit: run …"), scored as a commit claim | "To <verb>:" instructional openers should defer the clause |

## Known limitations

- **Persisted tool outputs are never read.** v1 never opens
  `<sessionId>/tool-results/` (the §13.1 privacy boundary), so evidence that
  exists only in a persisted output file — a test summary too large for the
  transcript, say — is invisible. Affected claims stay UNVERIFIED; a
  `--read-persisted` opt-in is a v1.1 candidate.
- **Interpreter writes are inferred, not observed.** A file written by a
  Python/Node script the agent ran (rather than by an edit tool or a shell
  redirect) leaves no write record. The ledger flags such commands as opaque
  write-capable, and file claims resolve to UNVERIFIED
  `write-not-observable` instead of a false CONTRADICTED.
- **Absence is never contradiction.** The precision doctrine (§1) means an
  incomplete ledger degrades would-be contradictions to UNVERIFIED
  `ledger-incomplete`; hand labels below reflect that doctrine.
- **Historical audits cannot re-run anything.** Verdicts are reconciled
  against what the session actually logged; a claim true in the world but
  unexercised in the log is UNVERIFIED, not VERIFIED.

## Known issues

- **The §14.3 gate was met by demotion.** Both sampled CONTRADICTED verdicts were false positives under `claims/1+reconcile/1`: a possessive path ("removed `x.py`'s … check") judged as a file delete, and a hypothetical no-change marker judged against the turn's writes. `claims/2+reconcile/2` demotes the two offending reconcile rows (row 9 edited-not-deleted with a direct object; row 21 path-less writes-despite-no-change) to UNVERIFIED, and both shapes are pinned in `fixtures/claims/corpus.jsonl` (tag `fp`). Carried into the CHANGELOG by S33.
- `nochange.marker` produced a wrong CONTRADICTED verdict in the hand-labelled sample: a note that a demo speed value can be tweaked later, read as a claim that no changes were made — reconcile/2 demotes the path-less no-change contradiction to UNVERIFIED; a cue fix for hypothetical/instructional scopes is the claims/3 candidate (resolved in `claims/2+reconcile/2`).
- `file.verb` produced a wrong CONTRADICTED verdict in the hand-labelled sample: removing a redundant check inside a file ("`x.py`'s … check") parsed as deleting the file itself — reconcile/2 demotes the edited-not-deleted contradiction to UNVERIFIED; the possessive-path parse is pinned in the corpus for a claims/3 extractor fix (resolved in `claims/2+reconcile/2`).
- `verify.generic` produced a wrong VERIFIED verdict in the hand-labelled sample: confirming an external website's state, auto-verified by an unrelated green test run — verify.generic (row 19) should not accept an arbitrary green run as evidence for claims about external services.
- `git.push` produced a wrong UNVERIFIED verdict in the hand-labelled sample: a description of what an upcoming push will send ("it'll send …"), scored as a push claim — future-tense "it'll / it will" inside the clause should defer the claim.
- `install.pkg` produced a wrong UNVERIFIED verdict in the hand-labelled sample: a statement that the published package is installable, with the install command quoted, scored as an install claim — install.pkg should skip quoted installation instructions with no completed-action verb.
- `git.push` produced a wrong UNVERIFIED verdict in the hand-labelled sample: a "How to commit and push" heading, scored as a push claim — instructional "How to …" headings should be cue-scoped as instructions, never scored.
- `git.push` produced a wrong NOT_SCORED verdict in the hand-labelled sample: a completed force-push followed by a parenthetical "would have refused if …" aside, mis-classified as deferred — conditional cues inside a parenthetical must not re-scope the main clause's past-tense verb.
- `git.commit` produced a wrong UNVERIFIED verdict in the hand-labelled sample: instructions telling the user how to commit ("To commit: run …"), scored as a commit claim — "To <verb>:" instructional openers should defer the clause.
- 3 sampled claims were labelled *unclear* (the transcript alone cannot settle them); they are excluded from every precision denominator above.
- Coverage is intentionally partial: the extractor recognises the §6.1 grammar only, so the receipt carries the recognized-claim count (always in the JSON and Markdown surfaces) and never implies it scored everything the final message asserted (the coverage table above quantifies the gap on this sample).
- Persisted tool outputs and interpreter-written files are invisible to the ledger (see "Known limitations"); claims that depend on them stay UNVERIFIED rather than risking a false CONTRADICTED.
