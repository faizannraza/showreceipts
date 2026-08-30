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
