# What counts as a claim

showreceipts never asks a model what the agent meant. Claim extraction is a
versioned rule grammar (`src/claims/rules.ts`, currently `claims/2`) applied
to the **final message of a turn only** — the message the agent ends on when
it says it's done. The rules are deterministic regexes over sentences; the
same final message always yields the same claims, on every machine.

Recall is intentionally limited: the receipt prints "N claims recognized" and
never implies it scored every assertion. How well the grammar covers what a
human reader would call a claim — and how often the verdicts are right — is
measured in [`accuracy.md`](accuracy.md).

## Polarity, hedges and scoping

Before any rule fires, every sentence passes through the cue pass. These cues
apply to **every** rule:

- **Negation** — "the tests *don't* pass", "I *didn't* run the linter" —
  flips or defers the claim; a negated success is never scored as a success.
- **Hedges** — "should pass", "probably works", "I believe this fixes it" —
  are not claims of fact and are never scored.
- **Deferral / instruction** — "you should run `npm test`", "To deploy: …",
  "run the migration before merging" — is advice about the future, not a
  claim about what happened. Never scored.
- **Attribution** — "the reviewer says lint is clean", "CI reports green" —
  is somebody else's claim. Recognised, marked `NOT_SCORED`.
- **Temporal scoping** — future tense and conditional clauses ("this will
  fix", "once the cache is warm") defer the claim.

## The rule table

Generated from `src/claims/rules.ts` by `scripts/gen-claims-doc.mjs`; this is
byte-for-byte the grammar the tool executes, not documentation that can
drift. Rules are tried in table order; one sentence can yield several claims.

<!-- gen:claims-table -->
## Claim rules (`claims/2`)

Rules are tried in table order; a clause can yield several claims. Negation, hedge,
attribution, scoping and temporal cues (§4.7 step 5) apply to every rule.

| id | kind | trigger | fields | notes |
|---|---|---|---|---|
| `test.pass` | test | <code>\b(?:all\s+)?(?:the\s+)?(?&lt;!\d\/)(?:\d{1,6}\s+)?(?:unit\s+&#124;integration\s+&#124;e2e\s+)?tests?\s+(?:(?:are&#124;is&#124;were&#124;was&#124;still&#124;now&#124;all&#124;already&#124;should&#124;would&#124;might&#124;may&#124;could&#124;will&#124;can&#124;do&#124;does&#124;did&#124;not&#124;never&#124;probably&#124;likely&#124;hopefully&#124;just&#124;no\s+longer)\s+){0,6}(?:pass(?:es&#124;ed&#124;ing)?&#124;green&#124;succeed(?:s&#124;ed)?&#124;ok)(?![\p{L}\p{N}_])</code><br><code>\btest\s+suite\s+(?:(?:is&#124;was&#124;were)\s+(?:now\s+&#124;already\s+&#124;not\s+)?)?(?:green&#124;passing&#124;clean)(?![\p{L}\p{N}_])</code><br><code>\btest\s+suite\s+passes</code><br><code>\b(?:everything&#124;all)\s+(?:is\s+)?(?:passing&#124;green)(?![\p{L}\p{N}_])</code> | `{count?}` | Rows 1–2; yields to test.counts when an N/M ratio is in the clause. |
| `test.counts` | test | <code>(?&lt;![\d/])(?&lt;!\bof\s)(\d{1,6})\s+(?:tests?\s+)?(?:passed&#124;passing)(?![\p{L}\p{N}_])</code><br><code>\b(\d{1,6})\/(\d{1,6})\s+tests?</code><br><code>\b(\d{1,6})\s+tests?,\s+0\s+failures?</code><br><code>(?:✅&#124;✔&#124;✓&#124;☑&#124;🟢)️?\s*(\d{1,6})\s+passed</code> | `{count}` · short ratio ⇒ negated `{ratio}` | Row 2; equal ratio ⇒ positive count, short ratio ⇒ negated. |
| `test.gate` | test | <code>\b(?:full\s+)?validation\s+gate\b[^.;]{0,140}?\b(?:passed&#124;pass(?:es)?&#124;green&#124;clean)(?![\p{L}\p{N}_])</code> | `{count?}` + one check `{family}` per listed tool | Row 1; one check claim per listed tool, count from `(N tests`. |
| `test.count_clean` | test | <code>(?&lt;![\d/])\b(\d{1,6})\s+tests?\b(?:\s*\([^)]{0,40}\))?(?=[^.;]{0,80}\b(?:clean&#124;pass(?:es&#124;ed&#124;ing)?&#124;green&#124;ok&#124;succeed(?:s&#124;ed)?&#124;successful(?:ly)?&#124;no\s+(?:errors&#124;issues&#124;warnings&#124;problems)&#124;0\s+(?:errors&#124;problems)&#124;without\s+(?:errors&#124;warnings)&#124;(?:✅&#124;✔&#124;✓&#124;☑&#124;🟢)️?)(?![\p{L}\p{N}_]))</code> | `{count}` | Rows 1–2; "345 tests, typecheck and lint clean". |
| `test.ran` | test-ran | <code>\b(?:ran&#124;run&#124;re-?ran&#124;re-?run&#124;running&#124;executed&#124;kicked\s+off)\s+(?:(?:the&#124;all&#124;full&#124;a&#124;any&#124;my&#124;our)\s+){0,2}(?:test\s+suite&#124;tests?&#124;pytest&#124;vitest&#124;jest&#124;specs?&#124;unit\s+tests)(?![\p{L}\p{N}_])</code><br><code>\btests?\s+to\s+run\b</code><br><code>\btest(?:ed)?\s+(?:it&#124;this&#124;that&#124;them&#124;anything&#124;locally&#124;here)(?![\p{L}\p{N}_])</code> | — | Row 3. |
| `test.nofail` | test | <code>\bno\s+(?:failing&#124;failed&#124;broken&#124;red)\s+tests?</code><br><code>\bzero\s+failures?</code><br><code>\b0\s+failed\b</code><br><code>\bwithout\s+(?:any\s+)?(?:test\s+)?failures?</code> | — | Row 1; consumes its own "no". |
| `test.green_marker` | test | <code>^\s*(?:(?:✅&#124;✔&#124;✓&#124;☑&#124;🟢)️?)?\s*(?:all\s+)?green\s*(?:(?:✅&#124;✔&#124;✓&#124;☑&#124;🟢)️?)?\s*[.!]?\s*$</code> | — | Row 1; "All green ✅" standalone. |
| `test.added` | test-added | <code>\b(?:added&#124;wrote&#124;created&#124;introduced&#124;implemented)\s+(?:\d{1,6}\s+)?(?:new\s+&#124;more\s+)?(?:unit\s+&#124;integration\s+&#124;e2e\s+&#124;regression\s+)?tests?(?:\s+cases?)?(?![\p{L}\p{N}_])</code> | `{count?}` | Row 4. |
| `check.lint` | check | <code>\b(ruff&#124;eslint&#124;flake8&#124;pylint&#124;clippy&#124;golangci-lint&#124;biome&#124;oxlint&#124;rubocop&#124;shellcheck&#124;lint(?:er&#124;ing)?)(?![\p{L}\p{N}_])(?:\s+(?:--?[\w-]+&#124;check&#124;run&#124;step&#124;job&#124;output&#124;is&#124;are&#124;was&#124;were&#124;all&#124;and&#124;already&#124;still&#124;now&#124;also&#124;remains?&#124;came\s+back&#124;comes\s+back&#124;→&#124;-&gt;&#124;:)){0,4}\s*(?:clean&#124;pass(?:es&#124;ed&#124;ing)?&#124;green&#124;ok&#124;succeed(?:s&#124;ed)?&#124;successful(?:ly)?&#124;no\s+(?:errors&#124;issues&#124;warnings&#124;problems)&#124;0\s+(?:errors&#124;problems)&#124;without\s+(?:errors&#124;warnings)&#124;(?:✅&#124;✔&#124;✓&#124;☑&#124;🟢)️?)(?=\s*(?:[.,;:!)\]]&#124;(?:on&#124;for&#124;in&#124;with&#124;across&#124;and&#124;again&#124;at)\b&#124;\(&#124;$))</code><br><code>\b(?:clean&#124;passing)\s+(ruff&#124;eslint&#124;flake8&#124;pylint&#124;clippy&#124;golangci-lint&#124;biome&#124;oxlint&#124;rubocop&#124;shellcheck&#124;lint(?:er&#124;ing)?)(?![\p{L}\p{N}_])</code><br><code>\b(lint&#124;ruff&#124;eslint)\s*[:：]?\s*(?:(?:✅&#124;✔&#124;✓&#124;☑&#124;🟢)️?&#124;passed&#124;ok)(?![\p{L}\p{N}_])</code> | `{family: lint, tool}` | Rows 5–6. |
| `check.type` | check | <code>\b(mypy(?:\s+--strict&#124;[-\s]strict)?&#124;pyright&#124;tsc&#124;typecheck(?:s&#124;ing)?&#124;type-?checks?)(?![\p{L}\p{N}_])(?:\s+(?:--?[\w-]+&#124;check&#124;run&#124;step&#124;job&#124;output&#124;is&#124;are&#124;was&#124;were&#124;all&#124;and&#124;already&#124;still&#124;now&#124;also&#124;remains?&#124;came\s+back&#124;comes\s+back&#124;→&#124;-&gt;&#124;:)){0,4}\s*(?:clean&#124;pass(?:es&#124;ed&#124;ing)?&#124;green&#124;ok&#124;succeed(?:s&#124;ed)?&#124;successful(?:ly)?&#124;no\s+(?:errors&#124;issues&#124;warnings&#124;problems)&#124;0\s+(?:errors&#124;problems)&#124;without\s+(?:errors&#124;warnings)&#124;(?:✅&#124;✔&#124;✓&#124;☑&#124;🟢)️?)(?=\s*(?:[.,;:!)\]]&#124;(?:on&#124;for&#124;in&#124;with&#124;across&#124;and&#124;again&#124;at)\b&#124;\(&#124;$))</code><br><code>\b(?:clean&#124;passing)\s+(mypy(?:\s+--strict&#124;[-\s]strict)?&#124;pyright&#124;tsc&#124;typecheck(?:s&#124;ing)?&#124;type-?checks?)(?![\p{L}\p{N}_])</code> | `{family: type, tool}` | Rows 5–6; `mypy --strict` keeps `--strict`. |
| `check.format` | check | <code>\b(prettier&#124;black&#124;isort&#124;ruff\s+format(?:\s+--check)?&#124;gofmt&#124;rustfmt&#124;cargo\s+fmt&#124;biome\s+format&#124;format(?:ter&#124;ting)?)(?![\p{L}\p{N}_])(?:\s+(?:--?[\w-]+&#124;check&#124;run&#124;step&#124;job&#124;output&#124;is&#124;are&#124;was&#124;were&#124;all&#124;and&#124;already&#124;still&#124;now&#124;also&#124;remains?&#124;came\s+back&#124;comes\s+back&#124;→&#124;-&gt;&#124;:)){0,4}\s*(?:clean&#124;pass(?:es&#124;ed&#124;ing)?&#124;green&#124;ok&#124;succeed(?:s&#124;ed)?&#124;successful(?:ly)?&#124;no\s+(?:errors&#124;issues&#124;warnings&#124;problems)&#124;0\s+(?:errors&#124;problems)&#124;without\s+(?:errors&#124;warnings)&#124;(?:✅&#124;✔&#124;✓&#124;☑&#124;🟢)️?)(?=\s*(?:[.,;:!)\]]&#124;(?:on&#124;for&#124;in&#124;with&#124;across&#124;and&#124;again&#124;at)\b&#124;\(&#124;$))</code><br><code>\b(?:clean&#124;passing)\s+(prettier&#124;black&#124;isort&#124;ruff\s+format(?:\s+--check)?&#124;gofmt&#124;rustfmt&#124;cargo\s+fmt&#124;biome\s+format&#124;format(?:ter&#124;ting)?)(?![\p{L}\p{N}_])</code><br><code>\b(?:code&#124;files?&#124;everything&#124;tree&#124;it)\s+(?:is&#124;are&#124;was&#124;were)\s+formatted\b</code><br><code>\bformatted\s+(?:with&#124;via&#124;using)\s+(\w+)</code><br><code>\bformat(?:ting)?\s+(?:check\s+)?(?:is\s+)?(?:clean&#124;pass(?:es&#124;ed&#124;ing)?&#124;green&#124;ok&#124;succeed(?:s&#124;ed)?&#124;successful(?:ly)?&#124;no\s+(?:errors&#124;issues&#124;warnings&#124;problems)&#124;0\s+(?:errors&#124;problems)&#124;without\s+(?:errors&#124;warnings)&#124;(?:✅&#124;✔&#124;✓&#124;☑&#124;🟢)️?)(?![\p{L}\p{N}_])</code> | `{family: format, tool}` | Row 5. |
| `check.build` | check | <code>\b((?:npm\s+run\s+&#124;yarn\s+&#124;pnpm\s+&#124;cargo\s+&#124;go\s+&#124;docker\s+&#124;mkdocs\s+&#124;docs\s+&#124;the\s+)build&#124;mkdocs(?:\s+build)?(?:\s+--strict&#124;[-\s]strict)?&#124;webpack&#124;vite\s+build&#124;tsc\s+-b)(?![\p{L}\p{N}_])(?:\s+(?:--?[\w-]+&#124;check&#124;run&#124;step&#124;job&#124;output&#124;is&#124;are&#124;was&#124;were&#124;all&#124;and&#124;already&#124;still&#124;now&#124;also&#124;remains?&#124;came\s+back&#124;comes\s+back&#124;→&#124;-&gt;&#124;:)){0,4}\s*(?:clean&#124;pass(?:es&#124;ed&#124;ing)?&#124;green&#124;ok&#124;succeed(?:s&#124;ed)?&#124;successful(?:ly)?&#124;no\s+(?:errors&#124;issues&#124;warnings&#124;problems)&#124;0\s+(?:errors&#124;problems)&#124;without\s+(?:errors&#124;warnings)&#124;(?:✅&#124;✔&#124;✓&#124;☑&#124;🟢)️?)(?=\s*(?:[.,;:!)\]]&#124;(?:on&#124;for&#124;in&#124;with&#124;across&#124;and&#124;again&#124;at)\b&#124;\(&#124;$))</code><br><code>^\s*(build)(?![\p{L}\p{N}_])(?:\s+(?:--?[\w-]+&#124;check&#124;run&#124;step&#124;job&#124;output&#124;is&#124;are&#124;was&#124;were&#124;all&#124;and&#124;already&#124;still&#124;now&#124;also&#124;remains?&#124;came\s+back&#124;comes\s+back&#124;→&#124;-&gt;&#124;:)){0,4}\s*(?:clean&#124;pass(?:es&#124;ed&#124;ing)?&#124;green&#124;ok&#124;succeed(?:s&#124;ed)?&#124;successful(?:ly)?&#124;no\s+(?:errors&#124;issues&#124;warnings&#124;problems)&#124;0\s+(?:errors&#124;problems)&#124;without\s+(?:errors&#124;warnings)&#124;(?:✅&#124;✔&#124;✓&#124;☑&#124;🟢)️?)(?=\s*(?:[.,;:!)\]]&#124;(?:on&#124;for&#124;in&#124;with&#124;across&#124;and&#124;again&#124;at)\b&#124;\(&#124;$))</code><br><code>\b(?:it&#124;code&#124;project&#124;everything&#124;tree&#124;package&#124;crate&#124;module&#124;app&#124;build)\s+compiles\b</code><br><code>\bcompiles\s+(?:cleanly&#124;fine&#124;ok&#124;without\s+(?:errors&#124;warnings)&#124;successfully&#124;again)(?![\p{L}\p{N}_])</code><br><code>\b(mkdocs&#124;docs)\s+build[^.;:]{0,20}(?:clean&#124;pass(?:es&#124;ed&#124;ing)?&#124;green&#124;ok&#124;succeed(?:s&#124;ed)?&#124;successful(?:ly)?&#124;no\s+(?:errors&#124;issues&#124;warnings&#124;problems)&#124;0\s+(?:errors&#124;problems)&#124;without\s+(?:errors&#124;warnings)&#124;(?:✅&#124;✔&#124;✓&#124;☑&#124;🟢)️?)</code> | `{family: build, tool}` | Row 5; imperative/modal "Build …" is deferred by the cue rules. |
| `check.marker` | check | <code>\b(lint&#124;typecheck&#124;types&#124;build&#124;format&#124;tests?)\b\s*[:&#124;]?\s*(?:(?:✅&#124;✔&#124;✓&#124;☑&#124;🟢)️?&#124;(?:❌&#124;✘&#124;✗&#124;✖&#124;🔴&#124;❗)️?&#124;passed&#124;ok&#124;clean)(?![\p{L}\p{N}_])</code><br><code>^\s*(?:(?:✅&#124;✔&#124;✓&#124;☑&#124;🟢)️?&#124;(?:❌&#124;✘&#124;✗&#124;✖&#124;🔴&#124;❗)️?)\s*(lint&#124;typecheck&#124;types&#124;build&#124;format&#124;tests?)(?![\p{L}\p{N}_])</code> | test or check `{family}` by word | Rows 1/5; "lint ✅, typecheck ✅"; a leading marker with a bare status word. |
| `file.verb` | file | <code>(?&lt;=^&#124;\b(?:i&#124;i've&#124;we&#124;we've&#124;and&#124;also&#124;then&#124;now&#124;just)\s&#124;[,—:]\s&#124;[,—:])(?&lt;!\b(?:a&#124;an&#124;the&#124;this&#124;that&#124;each&#124;every&#124;any&#124;some&#124;one&#124;newly&#124;previously)\s)(?&lt;!hand-)(?&lt;!\bun)(created&#124;added&#124;wrote&#124;written&#124;generated&#124;scaffolded&#124;introduced&#124;updated&#124;edited&#124;modified&#124;changed&#124;touched&#124;fixed&#124;patched&#124;refactored&#124;rewrote&#124;reworked&#124;cleaned\s+up&#124;removed&#124;deleted&#124;dropped&#124;renamed&#124;moved&#124;extracted&#124;implemented&#124;split)\b</code><br><code>\b(?:was&#124;is&#124;has\s+been&#124;have\s+been&#124;were)\s+(created&#124;added&#124;updated&#124;edited&#124;modified&#124;changed&#124;fixed&#124;removed&#124;deleted&#124;renamed&#124;moved&#124;rewritten)\b</code> | `{verb, subject, fromPath?, explicitVerb, directObject?}` — one claim per PATH | Rows 7–10; one claim per PATH; `renamed A to B` ⇒ subject B, fromPath A; excluded with "already" or a you/your/the-user subject. |
| `file.implemented_in` | file | <code>\b(?:is&#124;was&#124;are&#124;were&#124;been&#124;now&#124;i&#124;i've&#124;we&#124;we've&#124;and)\s+(?:implemented&#124;added&#124;defined)\s+in\s+</code> | `{verb: update, subject}` | Row 8; UNVERIFIED-only, requires an agent-verb clause. |
| `file.count` | file-count | <code>\b(\d{1,6})\s+files?\s+(?:changed&#124;modified&#124;updated&#124;touched&#124;edited&#124;created&#124;added)(?![\p{L}\p{N}_])</code> | `{count}` | Row 11. |
| `file.new_file` | file | <code>\bnew\s+(?:file&#124;module&#124;test\s+file&#124;component&#124;script&#124;package)\s*[:,]?\s*</code> | `{verb: create, subject}` | Row 7. |
| `command.ran` | command | <code>\b(?:ran&#124;run&#124;re-?ran&#124;re-?run&#124;running&#124;executed&#124;invoked&#124;launched&#124;kicked\s+off)\s+\x60([^\x60]{1,120})\x60</code> | `{subject, successPredicate?}` | Row 12. |
| `command.ran_bare` | command | <code>\b(?:ran&#124;run&#124;running&#124;executed)\s+(?:the\s+)?(migrations?&#124;build&#124;linter&#124;formatter&#124;script&#124;smoke\s+test&#124;benchmark&#124;command)(?![\p{L}\p{N}_])</code><br><code>\b(migrations?&#124;build&#124;linter&#124;formatter&#124;script&#124;smoke\s+test&#124;benchmark)\b[^.;:]{0,30}\bfor\s+you\s+to\s+run\b</code> | `{subject}` | Row 13. |
| `install.pkg` | install | <code>\b(installed&#124;added&#124;pulled\s+in)\s+(?:the\s+)?(?:\x60([^\x60\s]+)\x60&#124;((?:@[\w-]+\/)?[\w.-]+(?:@[\w.^~-]+)?))\s+(?:as\s+(?:a\s+)?)?(?:dev\s+&#124;peer\s+&#124;optional\s+)?(?:dependency&#124;dependencies&#124;dep&#124;deps&#124;package&#124;packages&#124;plugin&#124;library)(?![\p{L}\p{N}_])</code><br><code>\b(?:npm&#124;pnpm&#124;yarn&#124;bun&#124;pip&#124;uv&#124;cargo&#124;go&#124;gem&#124;composer&#124;brew)\s+(?:install&#124;add&#124;i)\b[^.;:\x60]{0,40}\x60(\S[^\x60]{0,80})\x60</code> | `{subject}` | Row 14; bare nouns only for "added", name@version/@scope for "installed". |
| `git.commit` | git | <code>(?&lt;!\b(?:a&#124;an&#124;the&#124;this&#124;that&#124;each&#124;every&#124;all&#124;both&#124;your&#124;my&#124;its&#124;their&#124;previously&#124;already&#124;\d+&#124;nine&#124;ten)\s)(?&lt;!hand-)(?&lt;!\bun)\bcommitted\b(?!\s+(?:evidence&#124;artifact&#124;file&#124;fixture&#124;trace&#124;scenario&#124;run&#124;snapshot&#124;recording&#124;version&#124;history&#124;data&#124;baseline&#124;set&#124;transcript&#124;screenshot)s?\b)</code><br><code>\bmade\s+(?:a&#124;the&#124;\d{1,6})\s+commits?\b</code><br><code>\bcommits?\s+(?:is&#124;are)\s+in\b</code><br><code>\bcommit\b(?!\s+(?:message&#124;history&#124;hash&#124;sha&#124;body&#124;trailer&#124;log)s?\b)</code> | `{op: commit, sha?}` | Row 15; the bare verb needs an agent/negation subject; sha from the clause. |
| `git.push` | git | <code>\b(?:pushed&#124;push)\b(?=\s*(?:to\b&#124;it\b&#124;up\b&#124;the\s+(?:commit&#124;branch&#124;tag&#124;fix&#124;change)s?\b&#124;\x60&#124;origin\b&#124;\(&#124;,&#124;\.&#124;—&#124;and\b&#124;$))(?!\s+(?:across&#124;the\s+conversation&#124;back&#124;through&#124;for&#124;on&#124;down)\b)</code><br><code>\bis\s+on\s+\x60?origin\/[\w./-]+\x60?</code> | `{op: push, branch?, remote?}` | Row 16; sentence-initial imperative "Push …" is a request, not a claim. |
| `git.pr` | git | <code>\b(?:opened&#124;created&#124;raised&#124;submitted&#124;filed)\s+(?:a\s+&#124;the\s+)?(?:pull\s+request&#124;PR)\b(?:\s*#?(\d{1,6}))?</code> | `{op: pr, prNumber?}` | Row 17; a bare "PR #N" is not a claim. |
| `git.branch` | git | <code>\b(?:created&#124;checked\s+out&#124;switched\s+to)\s+(?:a\s+)?(?:new\s+)?branch\s+\x60?([\w./-]+)\x60?</code> | `{op: branch, branch}` | Row 18. |
| `git.tag` | git | <code>(?&lt;![\w-])(?:tagged&#124;created\s+(?:the\s+)?tag&#124;cut\s+(?:a\s+&#124;the\s+)?tag&#124;pushed\s+(?:the\s+)?tag)\s+(?:the\s+)?(?:release\s+&#124;commit\s+&#124;it\s+as\s+)?\x60?(v?\d+(?:\.\d+)+[\w.-]*)\x60?</code> | `{op: tag, subject}` | Row 18. |
| `nochange.marker` | no-change | <code>\bno\s+(?:code\s+)?changes?\b(?:\s+(?:to&#124;in)\s+\S{1,60})?\s+(?:were\s+&#124;was\s+)?(?:needed&#124;required&#124;necessary&#124;made)\b</code><br><code>\bnothing\s+(?:to\s+change&#124;changed&#124;needed\s+changing)\b</code><br><code>\bleft\s+(?:the\s+)?(?:code&#124;files?)\s+(?:as\s+is&#124;untouched&#124;unchanged)\b</code> | `{subject?}` | Row 21; consumes its own "no"; PATH captured when present. |
| `verify.generic` | verification | <code>(?:^&#124;\b(?:i&#124;i've&#124;we&#124;we've&#124;and&#124;also&#124;then&#124;now&#124;everything&#124;all&#124;both&#124;each&#124;which&#124;that&#124;it&#124;this&#124;fix\s*#?\d+&#124;\w+\s+is&#124;\w+\s+are)\s+)(?:(?:was&#124;were&#124;is&#124;are&#124;has\s+been&#124;have\s+been&#124;got&#124;just&#124;also&#124;then&#124;now&#124;independently)\s+){0,6}(?:re-)?(?:verified&#124;validated&#124;confirmed&#124;double-checked&#124;sanity-checked&#124;smoke-tested)(?![\p{L}\p{N}_])(?!\s+(?:email&#124;bug&#124;findings?&#124;context&#124;numbers?&#124;claims?&#124;account&#124;commit&#124;badge&#124;token&#124;user&#124;file&#124;tour&#124;copy&#124;source&#124;data&#124;example&#124;by\s+(?:the\s+)?(?:brief&#124;docs?&#124;user&#124;reviewer&#124;provider&#124;maintainer&#124;community)))</code><br><code>\b(?:tested\s+(?:it\s+)?(?:manually&#124;locally&#124;end-to-end&#124;by\s+hand)&#124;manually\s+tested&#124;works?\s+as\s+expected&#124;working\s+(?:correctly&#124;as\s+intended&#124;end-to-end)&#124;confirmed\s+(?:live&#124;working))(?![\p{L}\p{N}_])</code><br><code>\b(?:should&#124;would&#124;might&#124;may&#124;could&#124;will)\s+(?:now\s+&#124;all\s+&#124;just\s+)?works?(?![\p{L}\p{N}_])(?!\s+(?:by&#124;like&#124;around&#124;through)\b)</code> | — | Row 19; never CONTRADICTED; modal "should work" defers via the cue rules. |
| `verify.with_cmd` | verification | <code>\b(?:verified&#124;confirmed&#124;checked)\s+(?:with&#124;via&#124;using&#124;by\s+running)\s+\x60([^\x60]+)\x60</code> | verification + command `{subject, successPredicate}` | Row 20; yields a verification and a command claim. |
| `done.marker` | completion | <code>^\s*(?:done&#124;all\s+done&#124;both\s+done&#124;completed?&#124;finished&#124;shipped&#124;that's\s+it)\b(?!\s+(?:when&#124;once&#124;if&#124;for\s+runs))</code><br><code>\b(?:it&#124;this&#124;that&#124;everything&#124;all&#124;the\s+\w+(?:\s+\w+){0,3}&#124;phase\s*\w+&#124;step\s*\w+&#124;m\d&#124;fix\s*#?\d+&#124;task\s*\w+&#124;item\s*\w+&#124;milestone\s*\w+)\s+(?:is&#124;are)\s+(?:now\s+)?(?:done&#124;complete&#124;finished&#124;in\s+place)(?![\p{L}\p{N}_])(?!\s*(?:when&#124;once&#124;if&#124;for)\b)</code><br><code>\b(?:all\s+)?(?:\d+\s+)?(?:items?&#124;tasks?&#124;steps?&#124;fixes)\s+(?:are\s+)?done\b</code><br><code>\bis\s+ready\s+to\s+(?:ship&#124;merge&#124;submit&#124;send&#124;release&#124;publish)\b</code> | — | Row 22; never matches inside backticks; "ready for review" is excluded. |

<!-- /gen -->

## Worked examples

| final-message sentence | what the extractor sees |
|---|---|
| "All 64 tests still green, ruff/mypy clean." | a test claim `{count: 64}` plus two check claims (`lint`/`ruff`, `type`/`mypy`) |
| "Created `src/routes/health.ts` and updated the router." | one file claim per explicit path; "the router" has no path and stays a weaker claim |
| "Committed as `1ffc965`." | a git commit claim `{sha}` — reconciled against the tool log's git facts |
| "I didn't run the full suite." | negated test-ran — an honest admission, never scored against the agent |
| "You should run `npm test` before merging." | deferral — not a claim, not scored |
| "CI says everything passes." | attribution — recognised, `NOT_SCORED` |

The complete example corpus (hundreds of labelled sentences, including every
false positive ever found in the wild) lives in
`fixtures/claims/corpus.jsonl`; CI asserts 100 % of it passes.

## Verdicts

Every scored claim is reconciled against the session's tool ledger:

- **VERIFIED** — positive evidence found; the receipt cites it (command, exit
  code, timestamp).
- **CONTRADICTED** — positive *contrary* evidence found: the last relevant
  run was red, the claimed file never appears in any write record, the claimed
  commit isn't in the log. Absence alone is never contradiction — the one
  guarded exception is "tests pass" in a session where no test-capable
  command ran at all.
- **UNVERIFIED** — nothing conclusive either way. This includes evidence that
  is invisible on purpose: files written by scripts the agent ran
  (`write-not-observable`), persisted tool outputs (never opened), incomplete
  ledgers (`ledger-incomplete`).
- **NOT_SCORED** — recognised but excluded by a cue (attribution, hedge,
  deferral).

The session verdict is the worst claim's verdict. Everything the agent did
but never mentioned lands in ALSO DID, separately.

## `--explain-claim`

```sh
showreceipts session latest --explain-claim
```

prints, for every sentence of the final message, which rule fired (or why
none did), the cues that applied, the extracted fields, and the evidence the
verdict rests on. When a verdict looks wrong, this is the first thing to
run — and the output is exactly what a rule contribution needs (see
[`../CONTRIBUTING.md`](../CONTRIBUTING.md): new rules require corpus entries
and a `claims/N` bump).
