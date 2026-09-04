/**
 * The scenario DSL of the demo generator (ARCHITECTURE §14.1, PLAN S23a).
 * A `Scenario` is a compact, declarative description of one synthetic
 * session; `gen.ts` lowers it to the exact record shapes of Appendix A
 * (Claude Code), Appendix B (Codex) or Appendix C (hook-captured ledger).
 * Everything is plain data — scenarios are JSON-serialisable and the
 * generator is a pure function of the scenario alone.
 */

/** Which emitter lowers the scenario. `'ledger'` uses {@link Scenario.ledgerHarness}. */
export type DemoHarness = 'claude-code' | 'codex' | 'ledger';

/** One file-editing tool call (Claude Code `Edit`/`Write`, ledger `edit`/`write`). */
export interface DemoEdit {
  /** Path relative to `cwd` (or absolute for out-of-repo/tmp writes). */
  path: string;
  /** `create` emits a `Write` (`type:'create'`); `update` an `Edit`. */
  verb: 'create' | 'update';
  /** Minute offset from `startedAt`. */
  at: number;
  /** Extra `+`-prefixed patch lines (integrity scans read these, e.g. `+ it.skip(`). */
  addedLines?: string[];
}

/** One shell command (Claude Code `Bash`, Codex `exec_command`, ledger `shell`). */
export interface DemoCommand {
  cmd: string;
  /** `null` ⇒ no exit observable (background-like); ledger lines omit `out.exit`. */
  exit: number | null;
  /** stdout tail the runner/check parsers read. */
  out: string;
  /** Minute offset from `startedAt`. */
  at: number;
  /** Claude Code only: a `gitOperation.commit` sidecar on the result (§4.6.6). */
  commitSha?: string;
}

/** One subagent (Claude Code `Agent` spawn + its own transcript file). */
export interface DemoSubagent {
  description: string;
  commands: DemoCommand[];
  edits: DemoEdit[];
}

/** Session-level usage totals; the generator spreads them over the assistant messages. */
export interface DemoUsageProfile {
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

/** Codex only: one `token_count` totals row (cumulative) plus the plan-usage percent. */
export interface DemoTokenCount {
  input: number;
  cached: number;
  output: number;
  /** `rate_limits.primary.used_percent`. */
  ratePct?: number;
}

/** A refusal-fallback message (§8.3 "fallback iterations"): two priced attempts. */
export interface DemoRefusalFallback {
  originalModel: string;
  fallbackModel: string;
  /** Usage of the refused first attempt. */
  refused: { cacheRead: number; output: number };
  /** Minute offset from `startedAt`. */
  at: number;
}

/** What the fixture-driven tests assert for the scenario (never fed to the emitters). */
export interface DemoExpectation {
  verdict: 'VERIFIED' | 'UNVERIFIED' | 'CONTRADICTED' | 'NO_CLAIMS' | 'NO_FINAL' | 'NO_TURNS';
  /** The §14.1 spec scenarios (§10.2 samples): zero NOT_SCORED claims. */
  spec?: boolean;
  /** Scored-claim count, when pinned (the 20-claim scenario). */
  scoredClaims?: number;
}

/**
 * One demo scenario (§14.1). The four §10.2 spec scenarios pin their ids so
 * short ids render as `0badf00d`, `00decaf0`, `c0dec0de` and `0cafe000`.
 */
export interface Scenario {
  /** Stable machine name (`demo --scenario <name>`, S23b). */
  name: string;
  harness: DemoHarness;
  /** The Appendix C `h` value when `harness === 'ledger'`. */
  ledgerHarness?: 'cursor' | 'gemini' | 'copilot' | 'hermes' | 'dsh';
  harnessVersion: string;
  model: string;
  /** Fixed synthetic session id (UUIDv4/v7 chosen for the §4.1 short-id rule). */
  sessionId: string;
  /** Always under the synthetic home: `/home/u/proj/<name>`. */
  cwd: string;
  branch: string | null;
  /** ISO UTC instant of the first record. */
  startedAt: string;
  /** Wall-clock span in minutes; the final lands at the end of it. */
  durationMin: number;
  /** Active time (Σ `turn_duration`), minutes; defaults to `durationMin`. */
  activeMin?: number;
  usageProfile?: DemoUsageProfile;
  /** Codex cumulative `token_count` rows (one per emitted event). */
  tokenCounts?: DemoTokenCount[];
  /** Claude Code compactions to emit (`compact_boundary` + summary line). */
  compactions?: number;
  subagents?: DemoSubagent[];
  /** API-error assistant lines (`<synthetic>` model, zero usage). */
  apiErrors?: number;
  prompt: string;
  edits: DemoEdit[];
  commands: DemoCommand[];
  /** Trailing no-op `Read` calls that pad the tool-call count to the §10.2 numbers. */
  fillerReads?: number;
  /**
   * The final assistant message (multi-paragraph markdown). `null` ⇒ the
   * turn never completes (`no-final`); ignored when `noTurns` is set.
   */
  final: string | null;
  /** Emit a turnless transcript (records but no human/assistant lines). */
  noTurns?: boolean;
  refusalFallback?: DemoRefusalFallback;
  /** What the S23a tests assert. */
  expect: DemoExpectation;
}
