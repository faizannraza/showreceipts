# Fixtures

Committed test inputs for `showreceipts`. Everything under `readers/` is either a
**redacted copy of a real transcript** (privacy-safe, real shape) or a small
**hand-written synthetic** transcript. The real-shape fixtures are what every
reader golden, renderer snapshot, hook contract and e2e test consumes.

## Layout

```
fixtures/
  manifest.json                     which fixtures exist, their windows, caps and required shapes
  README.md
  redaction/forbidden.sha256.json   sha256(lowercase token) of every token that must never appear
  .forbidden.local                  the plaintext list (git-ignored, author machine only)
  hazards/u2028.jsonl               10 valid JSON lines with raw U+2028/U+2029/NEL, escaped  ,
                                    a 3 MB line and a CRLF line ending (line 5)
  readers/
    claude-code/<version>/          real-shape, one per harness version (2.1.214 … 2.1.251)
      expected.json                 source window, shapes, redaction metadata (+ golden sections from later steps)
      REDACTION-REVIEW.md           every verbatim-kept string, for the author's eyeball review
      projects/<dashDir>/<sid>.jsonl.gz
      projects/<dashDir>/<sid>/subagents/agent-<id>.jsonl.gz + agent-<id>.meta.json
      projects/<dashDir>/<sid>/subagents/workflows/wf_<id>/agent-<id>.jsonl.gz (+ journal.jsonl.gz)
    claude-code/legacy/             synthetic (2025-style Task tool, in-file sidechains, MultiEdit)
    codex/0.98.0/                   real-shape: both rollouts, session_index.jsonl, trimmed models_cache.json
      sessions/YYYY/MM/DD/rollout-<local ts>-<uuid>.jsonl.gz
    codex/shell_command/            synthetic (0.148 shell_command dialect, apply_patch via exec, shell[] legacy)
```

The tree mirrors the discovery roots (ARCHITECTURE §4.1), so a temporary
`CLAUDE_CONFIG_DIR` / `CODEX_HOME` can point at a materialised copy:
`test/helpers/fixtures.ts` (`materialize`, `materializeAll`, `readFixtureLines`,
`listFixtures`) gunzips a fixture into a temp tree with the real directory
layout and sets every file's mtime to the fixture's `endedAt`, so `--since`
behaves. Synthetic fixtures are plain `.jsonl` (reviewable); real ones are
gzipped (`node:zlib` in tests only).

## What was redacted, and how (`scripts/redact-fixture.mjs`)

Key-based policy (`scripts/lib/redact-policy.mjs`), never value sniffing alone:

| Content | Result |
|---|---|
| final assistant text (`stop_reason: end_turn`, Codex `agent_message`) | split into sentences (`scripts/lib/sentences.mjs`); a sentence is kept verbatim iff it matches the claims keep-superset (`keep-lists.mjs`), else `<text:Nb>`; list/table/heading/fence skeletons kept; kept sentences > 300 chars, or carrying credential-shaped material (`SECRET_SHAPE_RE`: `sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, JWT-like, …), are stubbed anyway |
| non-final text, thinking, signatures | `<text:Nb>`, `<think:Nb>`, `<sig>` |
| human prompts, compact summaries, meta lines | `<prompt:Nb>`, `<summary:Nb>`, `<meta:Nb>`; tag skeletons readers parse are kept (`<command-name>`, `<local-command-stdout>`, `<task-notification>` with mapped `<task-id>`, kept `<status>`, harness-phrase `<summary>`, `[Request interrupted by user]`) |
| code-bearing keys (`old_string`, `content`, `originalFile`, `structuredPatch[].lines`, apply_patch bodies) | one `<line:Nb>` per line, `+`/`-`/space prefixes kept, integrity tokens (`.skip(`, `assert`, `expect(`, …) appended so the integrity scanner still fires |
| commands | tokenizer skeleton (words, flags, pipes, redirections, paths); quoted literals > 32 chars → `<str:Nb>`; heredoc bodies → `<heredoc:Nb>`; credential-looking words → `<str:Nb>`; > 400 bytes → `<cmd:Nb>` |
| tool outputs | per line: runner/check/harness result shapes kept verbatim (see `KEEP_LINE_RULES`), every other line `<out:Nb>`; a line carrying credential-shaped material is never kept |
| ids | seeded sha256 maps by token shape (`scripts/lib/idmap.mjs`): UUIDs keep version + variant nibbles (v7 also the timestamp prefix), `msg_/req_/toolu_/call_…` keep prefix and length, agent ids stay 17 hex, task ids stay 9 chars; the same original maps to the same output everywhere, file names included; `ownerAccountUuid`/`ownerOrganizationUuid` are fixed |
| paths | `scripts/lib/pathmap.mjs`: home → `/home/u`, primary project → `/home/u/proj`, other project roots → `/home/u/projN`, dash-encoded dirs → `-home-u[-projN]`, scratchpad → `/tmp/claude/…`, `os.tmpdir()` → `/tmp/t/`; other home paths (absolute or `~/…`) keep structural segments and hash the rest; repo-relative paths are kept |
| hosts, e-mails | hosts outside `localhost, 127.0.0.1, pypi.org, github.com, api.github.com, registry.npmjs.org` → `host-N.example`; `github.com/<owner>/<repo>` → `github.com/u/proj`; e-mails → `u@example.com` |
| count-only records (`mode`, `ai-title`, `attachment`, `bridge-session`, …) | type skeleton with fixed placeholders (`Fixture session`, `fixture-agent`, `fixture-slug`) and strings stubbed by kind |
| hazards | a stub that replaced a string containing U+2028, U+2029, `\r`, `\t` or NUL carries those characters after the token; records that were ≥ 1 MiB are padded with `__pad` so they stay ≥ 1 MiB |
| everything else | unknown strings → `<s:Nb>`; numbers, booleans, null kept |

A final safety net replaces every token of the forbidden list (username, e-mail
parts, GitHub handle, names, every real session/agent id, real project paths,
plus hand-added identifiers of other private projects and services seen in the
transcripts) with `u`. One entry covers every separator spelling: an entry is
split into its alphanumeric runs and matched case-insensitively with any single
non-alphanumeric character (or nothing) between them, at run boundaries only —
an entry `example-corp` also masks `example_corp`, `example.corp`, `Example Corp`
and `examplecorp` (`forbiddenRegExp` in `scripts/lib/redact-policy.mjs`; never
write a real entry into a committed file, this README included). The committed hash list stores
`sha256(canonical token)` where the canonical token is lower-case with every
non-alphanumeric character removed (`canonicalToken`), and
`test/unit/fixtures/redaction.test.ts` canonicalises every run and every chain
of up to five runs one separator apart before hashing, so the scan catches a
listed token in whatever spelling it surfaces. The same scan runs over
`scripts/**/*.mjs`, `test/helpers/fixtures.ts`, `test/unit/fixtures/*.ts`,
`manifest.json` and this README, not only the fixture tree.
`REDACTION-REVIEW.md` lists everything kept verbatim so the author can sign off
(`--sign "<name>"` records `reviewedBy`).

## Regenerating (author machine only)

```
node scripts/redact-fixture.mjs --all --seed showreceipts-fixtures-1   # rebuild every real fixture
node scripts/redact-fixture.mjs --check                                   # regenerate to a temp dir and diff
node scripts/survey-fixtures.mjs --check                                  # expected.json.shapes ⊆ found; ≤ 8 MB
node scripts/survey-fixtures.mjs --compare claude-code/2.1.214            # real window vs fixture: same shapes
node scripts/survey-fixtures.mjs <transcript.jsonl[.gz] | fixture dir>    # print shape signatures
```

Sources are discovered by harness version under `~/.claude` and `~/.codex`
(read-only; the scripts never write there). Output is byte-identical on re-run
(seeded maps, gzip level 9). The one still-growing session is frozen: the
manifest's `freezeLines` caps its main file (and `source.originalLines` reports
the frozen count) and `frozenFiles` pins the line count of its workflow and
journal files by mapped path, so `--check` stays green as the source grows.
Regeneration keeps any golden sections later steps add to `expected.json`
(only `source`, `shapes` and `redaction` are rewritten).

## Size budget

`fixtures/` must stay ≤ 8 MB (`survey-fixtures.mjs --check` enforces it).
