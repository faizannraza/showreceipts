# Contributing

Thanks for looking under the hood. The bar here is unusual in a few specific
ways, so please read this before opening a PR.

## Getting started

```sh
npm ci
npm run build        # tsc + asset copy → dist/
npm test             # unit/golden/render/fuzz suites, offline, in-process
npm run test:e2e     # spawns dist/cli.js over the committed fixture tree
npm run typecheck
```

The full pre-merge gauntlet is `npm run test:all`. Everything runs offline —
a test-time guard makes any network attempt throw.

## The non-negotiables

- **Zero runtime dependencies.** `dependencies` stays empty, forever;
  `scripts/deps-guard.mjs` fails CI otherwise. devDependencies are pinned.
- **No network code path.** No `http(s)`/`net`/`tls`/`dns`/`fetch` imports
  anywhere; `scripts/check-no-network.mjs` scans the built output. The single
  `child_process` exception is `report --open`.
- **Determinism.** No `Intl`, no `Math.random` outside the seeded demo PRNG,
  no wall-clock reads outside the injected `ctx.now`, no `process.env` in
  reader/ledger/claims/reconcile/cost code. Same input, same bytes, every
  machine.
- **Line budgets.** `npm run size` enforces per-file and whole-`src/`
  ceilings. If a change needs more lines than the budget allows, the change
  is usually wrong-shaped.

## Contributing claim or reconcile rules

The claim grammar is versioned and measured; a rule change is a behaviour
change for every user's false-done rate. So every PR touching
`src/claims/rules.ts` or `src/reconcile/rules.ts` must:

1. **Add corpus entries** to `fixtures/claims/corpus.jsonl` (or a reconcile
   scenario fixture) covering the new behaviour — positive *and* negative
   cases. CI asserts 100 % of the corpus passes.
2. **Bump the version** — `claims/N` in `src/claims/rules.ts` or
   `reconcile/N` in `src/reconcile/rules.ts`. Receipts and `--publish`
   payloads carry these versions; silent behaviour changes are not a thing.
3. Respect the precision doctrine: absence of evidence is never
   contradiction. A rule that can produce a false CONTRADICTED needs to be
   demoted or guarded — see the demotion story in `docs/accuracy.md` for how
   that plays out in practice.

`showreceipts session <id> --explain-claim` output makes an excellent bug
report for extractor misfires.

## Fixture policy (security-critical)

Fixtures under `fixtures/` are derived from real sessions and are the most
sensitive artefacts in the repo:

- Never commit raw transcript material. Fixtures are produced by
  `npm run fixtures:redact` (`scripts/redact-fixture.mjs`), which maps ids,
  rewrites paths, stubs long content and masks secret-shaped tokens.
- The redaction is enforced, not trusted: `test/unit/fixtures/redaction.test.ts`
  scans every committed fixture against a **hashed forbidden list**
  (`fixtures/redaction/forbidden.sha256.json`) — real session ids, user
  names, home paths and e-mail addresses can never land in the tree, in any
  separator spelling. Do not weaken that test; treat any change to
  `scripts/redact-fixture.mjs` or `scripts/lib/` as security review.
- New fixtures need an `expected.json`, a redaction review file, and
  `node scripts/catalogue.mjs --check` green (the catalogue is generated
  from the fixtures).

## Goldens and generated docs

- Renderer/receipt goldens: `npm run goldens:update` after an intentional
  output change; review the diff — goldens are the spec.
- Generated documentation: `npm run docs:gen` rewrites the marked regions in
  `README.md` and `docs/` (claims table, prices table, coverage matrix, demo
  sample, publish example) plus `docs/catalogue.md` and `docs/receipt.svg`.
  Never edit inside a `<!-- gen:… -->` region by hand; CI runs
  `node scripts/gen-docs.mjs --check`.

## Style

TypeScript strict, ESM, small pure functions, explicit types, JSDoc on every
export, no `any` without a justifying comment. Tests live beside the area
they cover (`test/unit/<area>/`); run a targeted suite with
`npx vitest run test/unit/<area>` while iterating.
