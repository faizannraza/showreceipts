# Releasing showreceipts

How a version of `showreceipts` reaches npm and GitHub Releases. The pipeline
is `.github/workflows/release.yml`, triggered by pushing a `v*` tag; it
publishes through **npm trusted publishing (OIDC)** — there is no npm token
secret in the repository, ever.

## One-time bootstrap (already-done list for 0.1.0)

npm only lets you configure a trusted publisher for a package that already
exists, so the very first publish is manual, from the author's laptop:

0. Create and push the GitHub repository `package.json` names
   (`github.com/faizannraza/showreceipts`), get `ci.yml` green on the
   matrix, and enable "Private vulnerability reporting" in the repository
   settings so `SECURITY.md`'s advisories link resolves — step 4's
   trusted-publisher registration targets this repo.
1. `npm login` with the author account (granular token + 2FA).
2. From a clean checkout of the release commit:
   `npm run test:all && node scripts/pack-smoke.mjs && npm run deps:guard`
3. `npm publish --access public --no-provenance` — the flag is required:
   npm refuses to generate provenance outside a supported CI (GitHub
   Actions / GitLab), `publishConfig.provenance` is set in `package.json`,
   and `--dry-run` never exercises that path, so a plain laptop publish
   fails only at the real attempt. Provenance starts with the first OIDC
   workflow release, which attaches it automatically.
4. Register the workflow as the trusted publisher (needs npm ≥ 11.10;
   `npm install -g npm@^11.10` first if necessary):

   ```sh
   npm trust github showreceipts --file release.yml --repo faizannraza/showreceipts
   ```

From then on every release is done by tagging; the workflow authenticates via
OIDC (`permissions: id-token: write`) and npm attaches provenance
automatically. Never add an `NPM_TOKEN` secret to the repository.

## Release checklist

Work through this in order; the workflow re-checks the mechanical parts and
refuses the tag when any of them is off.

1. **Versions.** Bump `version` in `package.json` **and** `TOOL_VERSION` in
   `src/version.ts` (they must be identical — `npm run deps:guard` asserts
   it). If any claim or reconcile rule changed since the last release, bump
   `rulesVersion` (`claims/N`) with corpus entries for the change; refresh
   `pricesVersion` to the date of the last price check if prices were
   re-verified.
2. **CHANGELOG.** Retitle the section for this version from
   `## X.Y.Z (unreleased)` to `## X.Y.Z (YYYY-MM-DD)` and make sure it is
   non-empty. The workflow refuses a heading that still says `(unreleased)`
   and uses the section body verbatim as the GitHub release notes.
3. **Generated docs.** `npm run docs:gen` and commit anything it rewrites
   (`node scripts/gen-docs.mjs --check` must be green — CI enforces it).
4. **Render assets** (produced manually on the author's machine, committed):
   - `docs/receipt.svg` — regenerate via `node scripts/screenshot.mjs`
     (`demo --svg`); keep the "demo scenario" label.
   - `docs/report.png` — screenshot of the HTML report over the demo/fixture
     data.
   - `docs/demo.gif` — 30-second GIF, `vhs demo.tape`.
   The workflow hard-fails if `docs/receipt.svg` or `docs/report.png` is
   missing; the GIF is referenced from the README but not attached to the
   release.
5. **Local gates.** All green, no exceptions:

   ```sh
   npm run test:all
   node scripts/pack-smoke.mjs
   npm run deps:guard
   npm run size -- --strict
   ```

6. **Tag.** On the release commit (pushed to `main`, CI green):

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

7. **Watch the workflow**, then spot-check: `npm view showreceipts version`,
   `npx showreceipts@X.Y.Z demo`, and the GitHub release page (notes + two
   attached assets).

## What `release.yml` does, exactly

On a `v*` tag, one `publish` job on `ubuntu-latest` with
`permissions: { id-token: write, contents: write }`:

1. Checkout; `actions/setup-node` with `node-version: 24` and
   `registry-url: https://registry.npmjs.org`; `npm install -g npm@^11.10`
   (trusted publishing needs npm ≥ 11.10).
2. **Version triple check** — the tag (minus `v`), `package.json.version`
   and `src/version.ts` `TOOL_VERSION` must all be equal.
3. **CHANGELOG gate** — a `## <version>` section must exist, must not say
   `(unreleased)`, and must be non-empty; the body is extracted to
   `$RUNNER_TEMP/release-notes.md`.
4. **Immutability gate** — `npm view showreceipts@<version> version` must
   *fail* (404). Published versions are immutable: if a release half-ran,
   fix forward with a new patch version rather than re-tagging.
5. `npm ci` → `npm run typecheck` → `npm run build` → `npm test` →
   `npm run lint:nonet` → `npm run deps:guard`.
6. **Size gate** — `node scripts/size.mjs --strict`, which runs
   `npm pack --dry-run --json` and enforces: tarball ≤ 300 KB, unpacked
   ≤ 1152 KB (raised from the original 200/600 KB for the W4 report renderer,
   to 1 MiB unpacked by S36, then to 1152 KB by the Pass-2 closing review —
   see `docs/decisions.md` and the
   history note in `scripts/size.mjs`), no `.map`/`.d.ts`/test files, only
   `bin/ dist/ README.md LICENSE package.json` in the tarball, and
   `dist/cost/prices.json` + `dist/demo/**` present.
7. **Asset gate** — `docs/receipt.svg` and `docs/report.png` must be
   committed.
8. `npm publish --access public` — authenticated by OIDC, provenance
   attached automatically. No token, no secrets.
9. `gh release create v<version>` (built-in `GITHUB_TOKEN`) with the
   CHANGELOG section as notes and `docs/receipt.svg` + `docs/report.png`
   attached.

## CI (for contrast)

`.github/workflows/ci.yml` runs on every push/PR: the full test pipeline
(typecheck, build, unit+coverage, e2e, netguard lint, size, fixture survey,
catalogue and docs `--check`, accuracy) over `node 20/22/24 ×
ubuntu/macos` (Node 26 and `windows-latest` are `continue-on-error`
best-effort), plus three guard jobs: `deps-guard` (zero runtime deps,
no install scripts, `files` = `bin dist README.md LICENSE`, version sync),
`pack-smoke` (`scripts/pack-smoke.mjs`: pack → offline global install into a
temp prefix → run `demo` / `doctor --json` / `--version` from an empty cwd
with empty `SHOWRECEIPTS_HOME`/`CLAUDE_CONFIG_DIR`/`CODEX_HOME`), and a soft
`perf` job (`SHOWRECEIPTS_PERF=1 SHOWRECEIPTS_PERF_TOLERANCE=3`, ubuntu only,
`continue-on-error` — it can never block a merge). No CI job touches the
network beyond `npm ci`; the pack-smoke install runs `--offline`.
