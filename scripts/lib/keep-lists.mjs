// Keep lists for fixture redaction (PLAN S03, instruction 6). The redaction
// privacy test deliberately does NOT reuse these predicates: it pins its own
// copy of the accepted shapes and snapshots the constants below, so loosening
// this policy fails the test instead of silently passing.
//
// A sentence of a final message is kept verbatim iff it matches
// KEEP_SENTENCE_RE (the claims-rule superset). A line of tool output is kept
// iff it matches one of KEEP_LINE_RULES: `whole` keeps the entire line (after
// path/id/host scrubbing), `match` keeps only the matched prefix and stubs the
// remainder, `transform` runs a custom function. Everything else becomes a
// `<kind:Nb>` stub.

/** Sentence keep superset (case-insensitive). */
export const KEEP_SENTENCE_RE =
  /tests?|pass|passing|green|fail|lint|ruff|eslint|mypy|pyright|tsc|typecheck|build|compil|format|prettier|black|commit|push|pull request|\bPR\b|branch|tag|creat|add|updat|edit|modif|chang|remov|delet|renam|mov|wrote|written|implement|install|\bran\b|re-ran|executed|verif|confirm|double-check|validat|works|working|done|complete|finished|ready|clean|no changes|files? changed|skip|TODO|should|you can|haven't|didn't|couldn't|won't|not yet|left|❌|✅|✔|✘/i;

/** A kept sentence longer than this is stubbed anyway (privacy guard). */
export const MAX_KEPT_SENTENCE_CHARS = 300;

/**
 * Credential-shaped material: a kept sentence or output line that carries one
 * of these is stubbed whatever the keep superset says (even a placeholder such
 * as `sk-ant-...` trips secret scanners and documents env conventions).
 */
export const SECRET_SHAPE_RE = /(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9_.-]|sk_(?:live|test)_|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[bapr]-|AKIA|ASIA|AIza[A-Za-z0-9_-]|ya29\.|npm_[A-Za-z0-9]|eyJ[A-Za-z0-9_-]{8,}|Bearer\s+\S|Authorization:\s*\S)/i;

/** Hosts kept verbatim in URLs; every other host becomes `host-N.example`. */
export const HOST_ALLOWLIST = ['localhost', '127.0.0.1', 'pypi.org', 'github.com', 'api.github.com', 'registry.npmjs.org'];

/** Tokens the integrity scanner (ARCHITECTURE §4.6.7) looks for inside code lines. */
export const INTEGRITY_TOKENS = ['.skip(', '.only(', 'xit(', 'xdescribe(', '@pytest.mark.skip', '#[ignore]', 't.Skip(', 'assert', 'expect(', '@unittest.skip', 'pytest.skip('];

/** Every stub token the redactor emits. */
export const STUB_RE = /<(?:[a-z]+:\d+b|img|sig|enc|t)>/;

/** Quoted command literals longer than this become `<str:Nb>`. */
export const MAX_COMMAND_LITERAL_CHARS = 32;
/** Commands longer than this (bytes) become `<cmd:Nb>` as a whole. */
export const MAX_COMMAND_BYTES = 400;

/**
 * Output line rules, in evaluation order.
 * `re` is tested against one line (no trailing newline).
 */
export const KEEP_LINE_RULES = [
  // --- runner summaries (ARCHITECTURE §7) ---
  { name: 'pytest', mode: 'whole', re: /^(?:=+ )?(?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?|rerun)(?:, )?)+ in [\d.]+s\b/ },
  { name: 'pytest-none', mode: 'whole', re: /^(?:=+ )?no tests ran in [\d.]+s\b/ },
  { name: 'unittest', mode: 'whole', re: /^Ran \d+ tests? in [\d.]+s$/ },
  { name: 'unittest-status', mode: 'whole', re: /^(?:OK|FAILED)(?: \((?:failures=\d+|errors=\d+|skipped=\d+|expected failures=\d+|unexpected successes=\d+)(?:, (?:failures=\d+|errors=\d+|skipped=\d+|expected failures=\d+|unexpected successes=\d+))*\))?$/ },
  { name: 'jest-tests', mode: 'whole', re: /^Tests:\s+(?:\d+ (?:failed|skipped|todo|passed)(?:, )?)+\d+ total$/ },
  { name: 'jest-suites', mode: 'whole', re: /^Test Suites:\s+(?:\d+ (?:failed|skipped|todo|passed)(?:, )?)+\d+ total$/ },
  { name: 'vitest-tests', mode: 'whole', re: /^(?:.{0,40}\s)?Tests\s+(?:\d+ (?:failed|passed|skipped|todo)(?: \| )?)+\s*\(\d+\)\s*$/ },
  { name: 'vitest-files', mode: 'whole', re: /^(?:.{0,40}\s)?Test Files\s+(?:\d+ (?:failed|passed|skipped)(?: \| )?)+\s*\(\d+\)\s*$/ },
  { name: 'vitest-notests', mode: 'whole', re: /^(?:.{0,40}\s)?Tests\s+no tests\b.{0,40}$/ },
  { name: 'vitest-nofiles', mode: 'whole', re: /^No test files found.{0,60}$/ },
  { name: 'mocha', mode: 'whole', re: /^\s*\d+ (?:passing(?: \([^)]*\))?|pending|failing)$/ },
  { name: 'ava', mode: 'whole', re: /^[ \t]*(?:[✔✘] )?\d+ (?:tests? (?:passed|failed)|(?:tests? )?skipped)$/ },
  { name: 'node-test', mode: 'whole', re: /^(?:#|ℹ) (?:tests|pass|fail|cancelled|skipped|todo|suites|duration_ms) [\d.]+$/ },
  { name: 'bun', mode: 'whole', re: /^\s*\d+ (?:pass|skip|todo|fail)$/ },
  { name: 'playwright', mode: 'whole', re: /^[ \t]{0,8}\d+ (?:failed|flaky|skipped|passed|did not run|interrupted)(?: \([\d.]+m?s\))?$/ },
  { name: 'cypress', mode: 'whole', re: /^\s*(?:(?:Tests|Passing|Failing|Pending|Skipped):\s+\d+|All specs passed!.*|[✖✔]?\s*\d+ of \d+ (?:failed|passed)(?: \(\d+%\))?)$/ },
  { name: 'go-test', mode: 'whole', re: /^(?:ok|FAIL|PASS)(?:\s+\S+(?:\s+\(?[\d.]+s\)?)?(?:\s+\[[\w ]+\])?)?$/ },
  { name: 'go-test-v', mode: 'whole', re: /^--- (?:PASS|FAIL|SKIP): \S+(?: \([\d.]+s\))?$/ },
  { name: 'cargo', mode: 'whole', re: /^test result: (?:ok|FAILED)\. \d+ passed; \d+ failed; \d+ ignored; \d+ measured; \d+ filtered out.*$/ },
  { name: 'nextest', mode: 'whole', re: /^\s*Summary \[[^\]]*\] \d+ tests? run: \d+ passed(?:, \d+ failed)?(?:, \d+ skipped)?.*$/ },
  { name: 'maven', mode: 'whole', re: /^(?:\[(?:INFO|WARNING|ERROR)\] )?Tests run: \d+, Failures: \d+, Errors: \d+, Skipped: \d+\s*$/ },
  { name: 'gradle', mode: 'whole', re: /^(?:\d+ tests completed, \d+ failed(?:, \d+ skipped)?|BUILD (?:SUCCESSFUL|FAILED)(?: in [\dms ]+)?)$/ },
  { name: 'dotnet', mode: 'whole', re: /^(?:(?:Passed!|Failed!)\s+-\s+Failed:\s+\d+,\s+Passed:\s+\d+,\s+Skipped:\s+\d+,\s+Total:\s+\d+.*|\s*(?:Total tests|Passed|Failed|Skipped): \d+|Test summary: total: \d+, failed: \d+, succeeded: \d+, skipped: \d+.*)$/ },
  { name: 'rspec', mode: 'whole', re: /^\d+ examples?, \d+ failures?(?:, \d+ pending)?(?:, \d+ errors? occurred outside of examples)?$/ },
  { name: 'minitest', mode: 'whole', re: /^\d+ runs, \d+ assertions, \d+ failures, \d+ errors, \d+ skips$/ },
  { name: 'phpunit', mode: 'whole', re: /^(?:OK \(\d+ tests?, \d+ assertions?\)|OK, but[^\n]*!|WARNINGS!|FAILURES!|ERRORS!|Tests: \d+, Assertions: \d+(?:, (?:Failures|Errors|Skipped|Warnings|Risky|Incomplete): \d+)*\.?|\s*Tests:\s+(?:\d+ failed, )?\d+ passed.*)$/ },
  { name: 'mix', mode: 'whole', re: /^(?:\d+ propert(?:y|ies), )?(?:\d+ doctests?, )?\d+ tests?, \d+ failures?(?:, \d+ excluded)?(?:, \d+ skipped)?$/ },
  { name: 'ctest', mode: 'whole', re: /^\d+% tests passed, \d+ tests failed out of \d+$/ },
  { name: 'deno', mode: 'whole', re: /^(?:ok|FAILED) \| \d+ passed(?: \(\d+ steps?\))? \| \d+ failed(?: \(\d+ steps?\))?(?: \| \d+ ignored)?.*$/ },
  { name: 'swift', mode: 'whole', re: /^(?:.*Executed \d+ tests?, with \d+ failures? \(\d+ unexpected\).*|\*\* TEST (?:SUCCEEDED|FAILED) \*\*)$/ },
  { name: 'flutter', mode: 'whole', re: /^\d{2}:\d{2} \+\d+(?: ~\d+)?(?: -\d+)?: (?:All tests passed!|Some tests failed\.)$/ },
  // --- checks (ARCHITECTURE §4.6.5) ---
  { name: 'ruff', mode: 'whole', re: /^(?:All checks passed!|Found \d+ errors?(?: \(\d+ fixed, \d+ remaining\))?\.|\d+ files? already formatted|\d+ files? would be reformatted(?:, \d+ files? already formatted)?)$/ },
  { name: 'ruff-reformat', mode: 'whole', re: /^Would reformat: \S+$/ },
  { name: 'mypy', mode: 'whole', re: /^(?:Success: no issues found in \d+ source files?|Found \d+ errors? in \d+ files?(?: \(checked \d+ source files?\)| \(errors prevented further checking\))?)$/ },
  { name: 'tsc-error', mode: 'match', re: /^\S+?(?:\(\d+,\d+\)|:\d+:\d+ -) error TS\d+:/ },
  { name: 'tsc-found', mode: 'whole', re: /^Found \d+ errors?(?: in \d+ files?| in the same file, starting at: \S+)?\.$/ },
  { name: 'eslint', mode: 'whole', re: /^\s*✖ \d+ problems? \(\d+ errors?, \d+ warnings?\).*$/ },
  { name: 'prettier', mode: 'whole', re: /^All matched files use Prettier code style!$/ },
  { name: 'prettier-warn', mode: 'match', re: /^\[warn\]/ },
  { name: 'mkdocs', mode: 'whole', re: /^INFO\s+-\s+Documentation built.*$/ },
  { name: 'mkdocs-error', mode: 'match', re: /^ERROR\s+-/ },
  { name: 'npm-code', mode: 'whole', re: /^npm (?:error|ERR!) code \w+$/ },
  { name: 'npm', mode: 'match', re: /^npm (?:error|ERR!|warn|WARN|notice)/ },
  // --- harness result shapes (ARCHITECTURE §4.2.4/§4.3.3) ---
  { name: 'exit-code', mode: 'match', re: /^(?:<tool_use_error>)?(?:Error: )?Exit code -?\d+/ },
  { name: 'git-commit', mode: 'match', re: /^\[[\w./-]+ (?:\(root-commit\) )?[0-9a-f]{7,}\]/ },
  { name: 'git-rejected', mode: 'match', re: /! \[rejected\]/ },
  { name: 'git-push-failed', mode: 'match', re: /^error: failed to push/ },
  { name: 'pr-url', mode: 'transform', re: /https:\/\/github\.com\/\S+\/pull\/\d+/ },
  { name: 'cwd-reset', mode: 'whole', re: /^Shell cwd was reset to \S+$/ },
  { name: 'no-matches', mode: 'whole', re: /^No matches found$/ },
  { name: 'codex-total-lines', mode: 'whole', re: /^Total output lines: \d+$/ },
  { name: 'codex-truncated', mode: 'whole', re: /^…\d+ tokens truncated…$/ },
  { name: 'codex-exit', mode: 'whole', re: /^Process exited with code -?\d+$/ },
  { name: 'codex-running', mode: 'whole', re: /^Process running with session ID \d+$/ },
  { name: 'codex-chunk', mode: 'transform', re: /^Chunk ID: [0-9a-f]+$/ },
  { name: 'codex-wall', mode: 'whole', re: /^Wall time: [\d.]+ seconds$/ },
  { name: 'codex-tokens', mode: 'whole', re: /^Original token count: \d+$/ },
  { name: 'codex-output', mode: 'whole', re: /^Output:$/ },
  { name: 'codex-exit-plain', mode: 'whole', re: /^Exit code: -?\d+$/ },
  { name: 'patch-success', mode: 'whole', re: /^Success\. Updated the following files:$/ },
  { name: 'patch-file', mode: 'whole', re: /^[AMD] \S+$/ },
  { name: 'patch-failed', mode: 'whole', re: /^apply_patch verification failed: Failed to find expected lines in \S+:?$/ },
  { name: 'codex-denied', mode: 'transform', re: /Codex\(Sandbox\(Denied/ },
  { name: 'codex-failed', mode: 'match', re: /^(?:exec_command|write_stdin|shell_command) failed:/ },
  { name: 'tool-use-error', mode: 'match', re: /^<tool_use_error>/ },
  { name: 'permission-automode', mode: 'match', re: /^(?:<tool_use_error>)?Error: Permission for this action was denied by the Claude Code auto mode classifier\.?/ },
  { name: 'permission', mode: 'match', re: /^(?:<tool_use_error>)?(?:Error: )?Permission(?: denied| for this action was denied)?/ },
  { name: 'permission-denied', mode: 'match', re: /Permission denied/ },
  { name: 'user-rejected', mode: 'match', re: /^(?:<tool_use_error>)?(?:Error: )?(?:User rejected tool use|The user rejected|The user doesn't want to proceed with this tool use)/ },
  { name: 'user-doesnt-want', mode: 'match', re: /The user doesn't want to proceed/ },
  { name: 'input-validation', mode: 'match', re: /^(?:<tool_use_error>)?InputValidationError:/ },
  { name: 'blocked', mode: 'match', re: /^(?:<tool_use_error>)?Error: Blocked:/ },
  { name: 'isolated', mode: 'match', re: /^(?:<tool_use_error>)?Error: This agent is isolated in the worktree/ },
  { name: 'edit-not-found', mode: 'match', re: /^(?:<tool_use_error>)?Error: String to replace not found in file/ },
  { name: 'edit-modified', mode: 'match', re: /^(?:<tool_use_error>)?Error: File has been modified since read/ },
  { name: 'file-missing', mode: 'match', re: /^(?:<tool_use_error>)?File does not exist\./ },
  { name: 'eisdir', mode: 'match', re: /^(?:<tool_use_error>)?EISDIR/ },
  { name: 'error-prefix', mode: 'match', re: /^(?:<tool_use_error>)?Error:/ },
  { name: 'persisted-tag', mode: 'whole', re: /^<\/?persisted-output>$/ },
  { name: 'persisted-note', mode: 'whole', re: /^Output too large \([\d.]+ ?[KMG]?B\)\. Full output saved to: \S+$/ },
  { name: 'persisted-preview', mode: 'whole', re: /^Preview \(first [\d.]+ ?[KMG]?B\):$/ },
];

/** True when a line is a kept result line (either mode; `match` lines still carry a stub). */
export function isKeptLine(line) {
  return KEEP_LINE_RULES.some((rule) => rule.re.test(line));
}

/**
 * Structural check for a command skeleton: every whitespace-separated token
 * is short, a path, or a stub, and no e-mail-shaped token is present.
 */
export function looksLikeCommandSkeleton(line) {
  if (/(?<![\w.-])(?!git@|u@example\.com)[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}(?![\w-])/.test(line)) return false;
  return line.split(/\s+/).every((tok) => {
    const bare = tok.replace(/^["']|["']$/g, '');
    return bare === '' || bare.length <= MAX_COMMAND_LITERAL_CHARS || bare.includes('/') || STUB_RE.test(bare);
  });
}

/**
 * The generator's own view of an acceptable long (> 80 chars) string value:
 * it contains a stub token, or every non-empty line is a kept result line, a
 * command skeleton, or a kept sentence line of at most
 * MAX_KEPT_SENTENCE_CHARS characters. Used by author-side tooling only; the
 * privacy test pins an independent rule.
 */
export function isAllowedLongString(s) {
  if (s.length <= 80 || STUB_RE.test(s)) return true;
  return s.split('\n').every((line) => {
    const t = line.trim();
    if (t === '') return true;
    if (isKeptLine(t)) return true;
    if (t.length <= MAX_KEPT_SENTENCE_CHARS && KEEP_SENTENCE_RE.test(t)) return true;
    return looksLikeCommandSkeleton(t);
  });
}
