# fixtures/labels — the hand-labelling workspace (author-only, git-ignored)

This directory holds the accuracy-validation labelling files (PLAN S35;
ARCHITECTURE §14.3; IDEA §5.17). The `*.jsonl` files here are derived from the
author's **real local sessions** and are **git-ignored** (`fixtures/labels/*.jsonl`
in `.gitignore`) — they must never be committed, copied off this machine, or
quoted verbatim anywhere. Only `docs/accuracy.md` (aggregates, rule ids and
short paraphrases) is published, rendered wholly by `scripts/label.mjs --render`.

## Workflow

```bash
npm run build
node scripts/label.mjs --real      # sample claims + sentences from real sessions
# … hand-label the two JSONL files (see below) …
node scripts/label.mjs --render    # write docs/accuracy.md; exits 1 if the gate fails
```

`--real` exits 0 with "skipped" on machines without real roots, and refuses to
overwrite files that already carry labels (delete them or pass `--force` to
resample). The sample is seeded (`--seed`, default 35) and stratified by
verdict: ≥ 30 CONTRADICTED, ≥ 30 VERIFIED, ≥ 20 UNVERIFIED, ≥ 10 NOT_SCORED,
topped up to 100 (fewer when the pool has fewer).

## Files and how to label them

### `real-claims.jsonl`

First line is a `{"meta":1,...}` provenance record (sampled-at, seed, rules
version, pool sizes) — leave it alone. Each following line is one sampled
claim:

```json
{"claimId":"…","harness":"claude-code","session":"…","turn":12,
 "kind":"test","rule":"test.pass","verdict":"VERIFIED","reason":"ok",
 "why":"conclusive green run after the last edit","evidence":["npm test → exit 0 · 34 passed @ …"],
 "sentence":"All 34 tests pass.","label":null,"note":""}
```

Set `label` on every row:

- `"correct"` — the verdict is right for this sentence given the tool log.
- `"wrong"` — the verdict is wrong. Also add `"paraphrase"` (a short,
  non-verbatim description of what the sentence said) and `"fix"` (what rule
  change would prevent it) — both are published in the `docs/accuracy.md`
  false-positive table, so keep them free of session specifics.
- `"unclear"` — the transcript alone cannot settle it. Excluded from the
  precision denominator; use sparingly and note why in `note`.

When a `wrong` row is later fixed by a rules bump (a §14.3 demotion, say),
add `"resolvedIn": "<new rules version>"` to it: `--render` then moves the
row out of the gate/precision denominator but keeps it in the published
false-positive table and known-issues section, so the finding is never
silently dropped.

`note` is free text for the author; it is never published.

### `real-sentences.jsonl`

The 50-sentence coverage sample. Each row carries the sentence and the kinds
the extractor recognised in it (`recognisedKinds`). Set `label` to:

- `"none"` — a human would NOT call this sentence a claim of fact about the
  agent's own completed work.
- a comma-separated list of claim kinds a human WOULD read in it, from:
  `file, file-count, test, test-added, test-ran, check, command, install,
  git, verification, completion, no-change` — e.g. `"test,check"`.

Coverage per kind in `docs/accuracy.md` = recognised / human-called, over the
labelled rows.

## The gate

`--render` enforces the §14.3 pre-launch gate: **CONTRADICTED precision
≥ 95 %**. On failure it exits 1; the remedy is to demote the offending
reconcile row to UNVERIFIED in `src/reconcile/rules.ts`, bump the rules
version to `claims/2`, add corpus entries for the misfire, regenerate every
staled golden (`UPDATE_GOLDENS=1`), and re-run the whole chain.

## Privacy rules (non-negotiable)

- The JSONL files never leave this machine and are never committed.
- `docs/accuracy.md` may contain aggregates, rule ids and *paraphrases* only —
  never sentences, paths, prompts or file contents from real sessions.
- Secrets are masked at sampling time (`util/mask.ts`), but treat the files as
  sensitive regardless (they are written `0600`).
