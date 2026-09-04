/**
 * The showreceipts data model (ARCHITECTURE §3, transcribed verbatim) plus the
 * additions the readers, ledger, hooks, setup and renderers share. Plain data
 * only: no classes, no `readonly`, no methods. Every time in JSON is ISO-8601
 * UTC; renderers format. `seq` is unique and strictly increasing per session.
 *
 * Naming rules that resolve earlier drafts: `Cost.unverified` (not `approx`),
 * `Turn.durationMs` (= Σ `turn_duration`; the wall clock is `endedAt −
 * startedAt`), `TestRun.green: 'unknown'` (not `null`), `Segment2`/`ShellSegment`
 * for shell segments and `Segment` for turn segments.
 */

// ---------------------------------------------------------------------------
// §3 — verbatim
// ---------------------------------------------------------------------------

export type Harness = 'claude-code' | 'codex' | 'cursor' | 'gemini' | 'copilot' | 'hermes' | 'dsh' | 'opencode' | 'openclaw';
export type ToolKind = 'shell' | 'edit' | 'write' | 'read' | 'search' | 'fetch' | 'agent' | 'mcp' | 'task' | 'other';
export type ExitSource = 'harness' | 'parsed' | 'backfilled' | 'interpreted' | 'content' | 'notification' | 'sink' | 'unknown';
export type Trigger = 'human' | 'skill' | 'notification' | 'compact' | 'local-command' | 'meta' | 'interrupt' | 'relogin';

export interface Session {
  harness: Harness;
  harnessVersion: string | null;
  harnessVersions: string[];
  sessionId: string;
  /** Per §4.1: first 8 hex of a UUIDv4, last 8 hex of a UUIDv7, sha256 prefix otherwise. */
  shortId: string;
  source: 'transcript' | 'ledger';
  transcriptPath: string | null;
  ledgerNote?: string;
  ledgerCoverage?: 'all-tools' | 'partial';
  cwd: string;
  cwds: string[];
  repoRoot: string | null;
  gitBranch: string | null;
  title: string | null;
  models: string[];
  primaryModel: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  activeMs: number | null;
  turns: Turn[];
  preamble: Segment[];
  toolCalls: ToolCall[];
  ledger: Ledger;
  usage: UsageTotals;
  cost: Cost;
  compactions: Compaction[];
  subagents: SubagentInfo[];
  prRefs: PrRef[];
  apiErrors: { error: string; status?: number }[];
  refusalFallbacks: RefusalFallback[];
  diagnostics: Diagnostics;
  // --- additions (S02) ---
  /** Every API usage row after dedupe (§4.2.7); never dollars. */
  usageRows: UsageRow[];
  /** Codex `token_count` deltas (§4.3.5). */
  tokenDeltas: TokenDelta[];
  /** Codex `session_meta.originator` (e.g. `codex_cli_rs`, `codex_vscode`). */
  originator?: string;
  /** Codex `session_meta.source` names a subagent rollout. */
  subagent?: boolean;
  /** Codex `turn_context.sandbox_policy`. */
  sandbox?: { type: string; writableRoots: string[]; networkAccess: boolean };
  /** `no-turns`: records but no assistant turns; `empty`: header-only or zero records. */
  kind: 'normal' | 'no-turns' | 'empty';
  /** Transcript records read (all types). */
  records: number;
  /** Calendar days the session spans (1 for a single day). */
  spansDays: number;
  /** `edited_text_file` attachments — the "human edited between turns" signal (§4.2.8). */
  editedFiles: { seq: number; path: string }[];
}

/** A turn segment: one contiguous run of records with a single trigger (§4.2.3). */
export interface Segment {
  trigger: Trigger;
  promptId: string | null;
  seqStart: number;
  seqEnd: number;
  text?: string;
  taskId?: string;
  toolUseId?: string;
  status?: string;
}

export interface Turn {
  index: number;
  kind: 'human' | 'skill';
  promptId: string;
  userText: string | null;
  echoHashes: string[];
  segments: Segment[];
  seqStart: number;
  seqEnd: number;
  startedAt: string;
  endedAt: string;
  /** Σ `turn_duration` records; `null` when none (the wall clock is `endedAt − startedAt`). */
  durationMs: number | null;
  finalText: string | null;
  finalSeq: number | null;
  finalMessageId: string | null;
  finalTrigger: Trigger | null;
  interimFinals: number;
  harnessVersion: string | null;
  model: string | null;
  isDone: boolean;
  interrupted: boolean;
  compactions: number;
  opaqueWriteCommands: number;
  opaqueTestCommands: number;
  usage: UsageTotals;
  costUsd: number | null;
  apiCalls: number;
  // --- additions (S02) ---
  /** `stop_reason` of the message chosen as the final (`null` when the turn has none). */
  finalStopReason: string | null;
  finalTextSource?: Receipt['finalTextSource'];
}

export interface ToolCall {
  seq: number;
  id: string;
  tool: string;
  kind: ToolKind;
  agentId: string | null;
  turnIndex: number;
  cwd: string;
  cwdReset?: string;
  input: Record<string, unknown>;
  command?: string;
  description?: string;
  resultText: string;
  resultBytes: number;
  truncated?: 'persisted' | 'harness' | 'showreceipts';
  persistedBytes?: number;
  originalTokens?: number;
  isError: boolean;
  denied?: 'permission-rule' | 'user-rejected' | 'automode-blocked' | 'tool_use_error' | 'sandbox-denied';
  exitCode: number | null;
  exitCodeSource: ExitSource;
  interpretation?: string;
  terminated?: boolean;
  interrupted: boolean;
  background: boolean;
  backgroundTaskId?: string;
  timedOutAfterMs?: number;
  mayWrite?: boolean;
  mayRunTests?: boolean;
  durationMs?: number;
  startedAt: string;
  endedAt: string | null;
  filesTouched: string[];
  userModified?: boolean;
  postFinal?: boolean;
  // --- additions (S02) ---
  /** Claude Code `gitOperation` on a Bash result (§4.6.6). */
  gitOperation?: { sha: string; kind: 'committed' | 'amended' };
  /** `dangerouslyDisableSandbox` on the input (tier `cleanup`). */
  sandboxDisabled?: boolean;
  /** Patch lines only (≤ 2,000 lines total); file bodies are never kept. Dropped by the cache. */
  patch?: { added: string[]; removed: string[]; hunks: number; truncated?: boolean };
  /** The runner parse stored on the call (§4.6.4). */
  parsed?: TestRun['parsed'];
  parsedFrom?: string;
  /** Codex `write_stdin`: stays in `toolCalls` for the counts, skipped by `commands.ts`. */
  stdinWrite?: boolean;
  stdinWrites?: { seq: number; chars: number; interrupted?: boolean }[];
  /** Paths of a failed `apply_patch` (§4.3.4) — never counted as writes. */
  attempted?: string[];
  /** Write `toolUseResult.type === 'create'` (§4.6.1 `WriteFact.created`; addition S12). */
  created?: boolean;
}

export interface Ledger {
  writes: WriteFact[];
  commands: CommandFact[];
  testRuns: TestRun[];
  checks: CheckRun[];
  git: GitFact[];
  network: NetworkFact[];
  integrity: IntegritySignal[];
  danger: DangerFlag[];
  filesChanged: string[];
  lastWriteSeq: number | null;
  lastSourceWriteSeq: number | null;
  lastGreenSeq: number | null;
  // --- additions (S02) ---
  /** True when the ledger cannot see every effect (partial hook coverage, gaps, oversize events). */
  incomplete: boolean;
  incompleteReasons: string[];
  /** Opaque commands that could have run tests (`./scripts/test.sh`, heredoc scripts). */
  opaqueTestCapable: number;
  /** Per-turn counters (S14): W = last write seq, Wsrc = last source write, G = last green, R = last red. */
  perTurn: Record<
    number,
    {
      W: number | null;
      Wsrc: number | null;
      G: number | null;
      R: number | null;
      writes: number;
      testRuns: number;
      checks: number;
      commands: number;
    }
  >;
}

export interface WriteFact {
  seq: number;
  toolCallId: string;
  agentId: string | null;
  /** Canonical path (§4.6.1). */
  path: string;
  /** The spelling as logged. */
  display: string;
  fromPath?: string;
  verb: 'create' | 'update' | 'delete' | 'rename';
  source: 'tool' | 'patch' | 'shell-inferred' | 'interp-inferred' | 'subagent-list';
  status: 'ok' | 'failed' | 'unknown';
  resolved: boolean;
  created?: boolean;
  reverted?: { seq: number; by: string };
  scope: 'repo' | 'worktree' | 'other-repo' | 'scratch' | 'harness-config' | 'home-dotfile' | 'system' | 'unknown';
  otherRoot?: string;
  linesAdded?: number;
  linesRemoved?: number;
  isTestFile: boolean;
  isDoc: boolean;
  userModified?: boolean;
  /** `mkdir|touch|ln -s|chmod|chown`-style writes: recorded, never in `filesChanged` (§4.6.1; addition S12). */
  metadataOnly?: boolean;
}

/** A shell segment (one simple command inside a `Bash`/`exec_command` line, §4.5). */
export interface Segment2 {
  program: string;
  argv: string[];
  raw: string;
  family?: Family;
  runner?: string;
  cwd: string;
  exitCode: number | null;
  exitCodeSource: ExitSource;
  piped: boolean;
  suppressed: boolean;
  ran: boolean | 'short-circuited' | 'background';
  // --- additions (S02) ---
  /** Redirections in order; `resolved:false` for variable/glob targets. */
  redirects: { op: string; target: string; fd?: number; resolved: boolean }[];
  heredoc?: { delimiter: string; bytes: number; interpreter?: string };
  /** `VAR=value` prefixes and same-command assignments. */
  assignments?: Record<string, string>;
  /** argv with quoted literals, heredoc bodies and `$( )` removed — the input of the scans (§4.5.1). */
  scanTokens: string[];
  /** The wrapper stripped to find the program (`timeout`, `env`, `npx`, `sudo`, …). */
  wrapper?: string;
  mayWrite?: boolean;
  mayRunTests?: boolean;
  testScope?: { scope: 'full' | 'subset' | 'unknown'; targets: string[] };
  snapshotUpdate?: boolean;
}

/** The name used in code for a shell segment. */
export type ShellSegment = Segment2;

export type Family = 'test' | 'lint' | 'type' | 'build' | 'format' | 'git' | 'install' | 'network' | 'migrate' | 'script' | 'other';

export interface CommandFact {
  seq: number;
  toolCallId: string;
  agentId: string | null;
  raw: string;
  segments: Segment2[];
  exitCode: number | null;
  exitCodeSource: ExitSource;
  chained: boolean;
  background: boolean;
  interrupted: boolean;
  durationMs?: number;
  // --- additions (S02) ---
  /** An interpreter body wrote through a sink we could not resolve to a path (§4.6.1). */
  opaqueWrite?: boolean;
  mayRunTests?: boolean;
}

export interface TestRun {
  seq: number;
  toolCallId: string;
  agentId: string | null;
  runner: string;
  command: string;
  scope: 'full' | 'subset' | 'unknown';
  targets: string[];
  kind: 'run' | 'snapshot-update';
  exitCode: number | null;
  exitCodeSource: ExitSource;
  green: boolean | 'unknown';
  conclusive: boolean;
  truncated: boolean;
  parsed?: {
    passed?: number;
    failed?: number;
    skipped?: number;
    errors?: number;
    total?: number;
    ran?: boolean;
    suites?: { passed: number; failed: number; total?: number };
  };
  parsedFrom?: string;
  note?: string;
}

export interface CheckRun {
  seq: number;
  toolCallId: string;
  family: 'lint' | 'type' | 'build' | 'format';
  tool: string;
  scope: 'full' | 'subset' | 'unknown';
  exitCode: number | null;
  green: boolean | 'unknown';
  summary?: string;
  autoFixed?: boolean;
}

export interface GitFact {
  seq: number;
  op:
    | 'commit'
    | 'push'
    | 'pr-created'
    | 'branch'
    | 'tag'
    | 'stash'
    | 'reset'
    | 'checkout'
    | 'clean'
    | 'rebase'
    | 'force-push'
    | 'merge'
    | 'amend';
  ok: boolean | null;
  sha?: string | null;
  branch?: string;
  remote?: string;
  host?: string;
  prNumber?: number;
  prUrl?: string;
  source: 'command' | 'gitOperation' | 'output';
}

export interface PrRef {
  seq: number;
  prNumber: number;
  prUrl: string;
  prRepository: string;
  time: string;
}

export interface NetworkFact {
  seq: number;
  host: string;
  via: 'fetch' | 'browser' | 'shell' | 'package-manager' | 'git';
  inferred: boolean;
  status: 'contacted' | 'attempted';
  exit?: number | null;
  note?: string;
}

export interface IntegritySignal {
  seq: number;
  kind:
    | 'test-file-edited-after-green'
    | 'skip-added'
    | 'only-added'
    | 'assertion-removed'
    | 'test-count-dropped'
    | 'test-file-deleted'
    | 'fixture-changed-after-green'
    | 'test-weakened';
  path?: string;
  detail: string;
}

export interface DangerFlag {
  seq: number;
  tier: 'danger' | 'cleanup';
  kind:
    | 'destructive-git'
    | 'force-push'
    | 'history-rewrite'
    | 'no-verify'
    | 'rm-rf'
    | 'write-outside-repo'
    | 'pipe-to-shell'
    | 'secret-write'
    | 'secret-commit'
    | 'sandbox-disabled'
    | 'sudo'
    | 'chmod-777'
    | 'amend-after-push'
    | 'read-secret'
    | 'kill';
  detail: string;
}

export interface RefusalFallback {
  seq: number;
  originalModel: string;
  fallbackModel: string;
  category?: string;
}

export type ClaimKind =
  | 'file'
  | 'file-count'
  | 'test'
  | 'test-added'
  | 'test-ran'
  | 'check'
  | 'command'
  | 'install'
  | 'git'
  | 'verification'
  | 'completion'
  | 'no-change';

export interface Claim {
  id: string;
  kind: ClaimKind;
  polarity: 'positive' | 'negated' | 'deferred';
  attribution: 'agent' | 'other';
  rule: string;
  sentence: string;
  clause: string;
  position: number;
  echoed: boolean;
  partial?: boolean;
  explicitVerb?: boolean;
  directObject?: boolean;
  subject?: string;
  fromPath?: string;
  verb?: 'create' | 'update' | 'delete' | 'rename';
  count?: number;
  ratio?: [number, number];
  family?: 'lint' | 'type' | 'build' | 'format';
  tool?: string;
  op?: GitFact['op'] | 'pr';
  sha?: string;
  branch?: string;
  remote?: string;
  prNumber?: number;
  successPredicate?: boolean;
}

export type Verdict = 'VERIFIED' | 'UNVERIFIED' | 'CONTRADICTED' | 'NOT_SCORED';

export type Reason =
  | 'ok'
  | 'ok-deleted-later'
  | 'no-evidence'
  | 'no-test-run'
  | 'last-run-red'
  | 'stale-run'
  | 'exit-unknown'
  | 'run-in-background'
  | 'count-short'
  | 'check-red'
  | 'no-check-run'
  | 'no-write-to-path'
  | 'write-failed'
  | 'ambiguous-path'
  | 'file-not-deleted'
  | 'no-git-op'
  | 'git-op-failed'
  | 'sha-mismatch'
  | 'commit-precedes-edits'
  | 'push-precedes-commit'
  | 'no-command'
  | 'command-failed'
  | 'no-run-after-write'
  | 'writes-despite-no-change'
  | 'echoed'
  | 'partial'
  | 'not-scored'
  | 'ledger-incomplete'
  | 'write-not-observable';

/** `at` = ISO-8601 UTC. */
export interface EvidenceRef {
  seq: number;
  toolCallId?: string;
  agentId?: string | null;
  label: string;
  at: string;
}

export interface Judgement {
  claimId: string;
  verdict: Verdict;
  reason: Reason;
  evidence: EvidenceRef[];
  text: string;
  notes: string[];
  integrity?: 'test-weakened';
}

export interface ReceiptLine {
  glyph: 'ok' | 'bad' | 'unk' | 'said';
  claim: string;
  evidence: string[];
  refs: EvidenceRef[];
}

export interface Receipt {
  schema: 'showreceipts.receipt/1';
  toolVersion: string;
  rulesVersion: string;
  pricesVersion: string;
  kind: 'scored' | 'no-claims' | 'no-final' | 'no-turns';
  id: string;
  shortId: string;
  harness: Harness;
  harnessLabel: string;
  harnessVersion: string | null;
  model: string;
  cwd: string;
  branch: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  source: 'transcript' | 'ledger';
  ledgerNote?: string;
  ledgerCoverage?: string;
  turnIndex: number;
  finalTrigger: Trigger | null;
  turnsWithClaims: number[];
  finalText: string;
  finalTextSource: 'transcript' | 'stop-hook' | 'copilot-transcript';
  claims: Claim[];
  judgements: Judgement[];
  lines: ReceiptLine[];
  alsoSaid: string[];
  alsoDid: { text: string; warn?: boolean; refs: EvidenceRef[] }[];
  postFinal?: { agentId: string | null; toolCalls: number; files: number; testRuns: number }[];
  stats: {
    toolCalls: number;
    filesChanged: number;
    testRuns: number;
    compactions: number;
    subagents: number;
    apiCalls: number;
    sentencesScanned: number;
  };
  cost: Cost;
  verdict: 'VERIFIED' | 'UNVERIFIED' | 'CONTRADICTED' | 'NO_CLAIMS' | 'NO_FINAL' | 'NO_TURNS';
  counts: Record<Verdict, number>;
  incompleteAtStop?: boolean;
  timeline?: TimelineEntry[];
  explanations?: Explanation[];
  // --- additions (S02) ---
  /** Present when the session spans more than one calendar day (header " · session Jul 18 → Aug 23 (36d)"). */
  sessionSpan?: { from: string; to: string; days: number };
  /** The turn's active time (Σ `turn_duration`); `null` ⇒ the header shows the wall clock. */
  turnActiveMs: number | null;
  /** `claims.length`, NOT_SCORED included ("claims recognized: N"). */
  claimsRecognized: number;
  /** Set when `--hash-paths` rewrote the paths. */
  hashPaths?: boolean;
  /** `no-turns` receipts: "12 records, 6 slash commands" (slash commands = `Diagnostics.localCommandPrompts`). */
  records?: number;
  // --- additions (S20) ---
  /** `no-turns` receipts: the slash-command count of the "(12 records, 6 slash commands)" text (§10.1). */
  slashCommands?: number;
  /** `no-final` receipts: the chosen final's `stop_reason` for "(stop_reason: tool_use)" (§10.1). */
  finalStopReason?: string | null;
}

export interface TimelineEntry {
  seq: number;
  at: string;
  tool: string;
  kind: ToolKind;
  summary: string;
  exit: number | null;
  files: string[];
  usd: number | null;
  agentId: string | null;
  flags: string[];
}

export interface UsageAttempt {
  model: string;
  in: number;
  w5: number;
  w1: number;
  wX: number;
  wU: number;
  rd: number;
  out: number;
  billed: boolean;
}

export interface UsageRow {
  seq: number;
  agentId: string | null;
  messageId: string;
  ts: string;
  attempts: UsageAttempt[];
  speed?: string;
  serviceTier?: string;
  promptTokens: number;
  incomplete?: boolean;
  /** §4.2.2: an interrupted stream — billed once, a known interruption (never `incomplete`). */
  interrupted?: boolean;
  inherited?: boolean;
}

export interface Cost {
  usd: number | null;
  apiCalls: number;
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWriteOther: number;
  output: number;
  thinking?: number;
  cacheHitPct: number | null;
  /** The `≈` flag: a price in the table is marked unverified. */
  unverified: boolean;
  unpriced: string[];
  apiEquivalent: true;
  pricesVersion: string;
  overrideHash?: string;
  asOf?: string;
  planUsagePct?: number;
  notes: string[];
}

export interface UsageTotals {
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWriteOther: number;
  output: number;
  thinking: number;
  calls: number;
  byModel: Record<string, UsageTotals | undefined>;
}

export interface Compaction {
  seq: number;
  trigger: string;
  preTokens: number;
  postTokens: number;
  cumulativeDroppedTokens?: number;
  durationMs?: number;
}

export interface SubagentInfo {
  agentId: string;
  parentAgentId: string | null;
  spawnedBy: { tool: 'Agent' | 'Workflow' | 'inline' | 'unknown'; runId?: string; toolUseId?: string };
  agentType?: string;
  description?: string;
  spawnDepth?: number;
  isFork?: boolean;
  model?: string;
  toolCalls: number;
  startedAt: string;
  endedAt: string;
  finished: boolean;
  exitCode?: number;
}

export interface RateRow {
  model: string;
  harness: Harness;
  harnessVersion: string;
  sessions: number;
  turns: number;
  doneTurns: number;
  doneTurnsByTrigger: { claims: number; markerOnly: number };
  byTrigger: { human: number; notification: number };
  contradictedTurns: number;
  unverifiedTurns: number;
  cleanTurns: number;
  claims: {
    total: number;
    verified: number;
    unverified: number;
    contradicted: number;
    notScored: number;
    byKind: Record<ClaimKind, number>;
  };
  testRunRate: number | null;
  costPerDoneTurnUsd: { median: number; mean: number } | null;
  contradictionReasons: Partial<Record<Reason, number>>;
  integritySignals: number;
  ledgerIncompleteSessions: number;
  cacheHitPct: number | null;
}

export interface Diagnostics {
  unknownRecordTypes: Record<string, number>;
  unknownSubtypes: Record<string, number>;
  unknownToolShapes: Record<string, number>;
  unknownContentBlocks: Record<string, number>;
  unknownCodexPayloads: Record<string, number>;
  badLines: number;
  lineSeparatorChars: number;
  reorderedEvents: number;
  duplicateUuids: number;
  duplicateToolResults: number;
  negativeDeltas: number;
  orphanAssistantLines: number;
  notificationPrompts: number;
  localCommandPrompts: number;
  incompleteMessages: number;
  bashWithoutToolUseResult: number;
  legacyShapes: Record<string, number>;
  subagentFiles: { direct: number; workflow: number; unlinked: number; missing: number };
  notes: string[];
  // --- additions (S02) ---
  interimFinals: number;
  emptySessions: number;
  excludedSyntheticLines: number;
  unknownAttachmentTypes: Record<string, number>;
  journals: number;
  unrecognisedFiles: number;
  orphanSessionDirs: number;
  emptyProjects: number;
  corruptCache: number;
  copilotTranscriptUnparsed: number;
  records: number;
}

// ---------------------------------------------------------------------------
// Reader-internal shapes
// ---------------------------------------------------------------------------

/** One physical line of a JSONL transcript as the byte-level reader hands it over (§4.2.1). */
export interface RawLine {
  seq: number;
  bytes: number;
  byteOffset: number;
  /** The `type` sniffed from the first bytes without a full parse; `null` when none. */
  sniffedType: string | null;
  json?: unknown;
  /** The line failed to parse (counted in `Diagnostics.badLines`). */
  bad?: true;
  /** The line was counted but its JSON was never materialised. */
  countOnly?: true;
}

export type LineSource = { kind: 'file'; path: string } | { kind: 'text'; text: string; name: string };

/** The Anthropic usage object as logged — consumed by guards only, never stored on `Session`. */
export interface RawUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens?: number;
  cache_creation?: Record<string, number>;
  output_tokens_details?: Record<string, number>;
  service_tier?: string;
  speed?: string;
  iterations?: (RawUsage & { type?: string; model?: string })[];
}

/** One Codex `token_count` delta (§4.3.5). */
export interface TokenDelta {
  seq: number;
  ts: string;
  model: string;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  turnIndex: number;
  lastInput: number | null;
}

// ---------------------------------------------------------------------------
// Shared contracts consumed by later steps
// ---------------------------------------------------------------------------

/** One row of the `audit` table and of the HTML report's session list. */
export interface SessionCard {
  id: string;
  shortId: string;
  harness: Harness;
  harnessLabel: string;
  harnessVersion: string | null;
  model: string;
  cwd: string;
  title: string | null;
  startedAt: string;
  endedAt: string;
  turns: number;
  doneTurns: number;
  claims: number;
  verdict: Receipt['verdict'] | '—';
  costUsd: number | null;
  unverified: boolean;
  kind: Receipt['kind'];
}

/** Resolved config roots (§4.1); `realpaths` is keyed by the same names. */
export interface Roots {
  userHome: string;
  claudeConfigDir: string;
  codexHome: string;
  showreceiptsHome: string;
  realpaths: Record<string, string | null>;
}

/** A discovered transcript or ledger file before parsing (S05). */
export interface SessionRef {
  harness: Harness;
  sessionId: string;
  path: string;
  size: number;
  mtimeMs: number;
  projectDir?: string;
  subagentDir?: string;
  /** Sorted `(relative path, size, mtimeMs)` of every subagent file found (§4.9 cache key). */
  subagentManifest: { rel: string; size: number; mtimeMs: number }[];
  empty?: boolean;
  ledger?: boolean;
  title?: string;
}

/** Fields shared by every hook-captured ledger line (Appendix C). */
export interface LedgerLineCommon {
  v: 1;
  /** ISO UTC. */
  t: string;
  h: Harness;
  /** The raw session id (the file name uses `safeSid`). */
  sid: string;
  tid?: string;
  cwd?: string;
  hv?: string;
  model?: string;
  exitSource?: 'harness' | 'parsed' | 'unknown';
}

export interface LedgerToolInput {
  command?: string;
  path?: string;
  paths?: string[];
  edits?: { old: string; new: string }[];
  editsTruncated?: boolean;
  url?: string;
  raw?: string;
}

export interface LedgerToolOutput {
  text: string;
  bytes: number;
  exit?: number | null;
  error?: boolean;
  durationMs?: number;
  truncated?: boolean;
}

export type LedgerLine =
  | (LedgerLineCommon & { e: 'session-start'; transcript?: string; source?: string })
  | (LedgerLineCommon & { e: 'prompt'; text: string })
  | (LedgerLineCommon & {
      e: 'tool-post';
      id: string;
      tool: string;
      kind: ToolKind;
      in: LedgerToolInput;
      out: LedgerToolOutput;
      ambiguousRoot?: boolean;
    })
  | (LedgerLineCommon & {
      e: 'tool-fail';
      id: string;
      tool: string;
      in: LedgerToolInput;
      error: string;
      failureType?: 'timeout' | 'error' | 'permission_denied';
      durationMs?: number;
      out?: { exit?: number | null };
    })
  | (LedgerLineCommon & { e: 'agent-response'; text: string })
  | (LedgerLineCommon & {
      e: 'subagent-stop';
      agent: { type?: string; status?: string; summary?: string; modifiedFiles?: string[]; transcript?: string; text?: string };
    })
  | (LedgerLineCommon & { e: 'stop'; status?: 'completed' | 'aborted' | 'error'; text?: string; transcript?: string; loop?: boolean })
  | (LedgerLineCommon & { e: 'session-end'; reason?: string })
  | (LedgerLineCommon & { e: 'gap'; reason: 'oversize' | 'unparsable'; bytes: number });

export type LedgerEvent = LedgerLine['e'];

/** What a hook invocation answers: a JSON object on stdout and always exit 0 (§9). */
export interface HookResult {
  stdout: object;
  exit: 0;
}

/** Persisted at `<home>/state/counters.json`; `doctor` reads it tolerantly (missing file or key ⇒ 0). */
export interface HookCounters {
  invocations: number;
  stdinOverflow: number;
  stopBudgetExceeded: number;
  copilotTranscriptUnparsed: number;
  unknownDialect: number;
}

/** Persisted at `~/.showreceipts/bin/launcher.json` by `setup`; read by `setup/inspect.ts`. */
export interface LauncherSidecar {
  version: string;
  node: string;
  cli: string;
  launcher: string;
}

/** One entry of `setup --json` (§12.3). */
export interface SetupResult {
  harness: Harness;
  path: string;
  scope: 'user' | 'project' | 'shared';
  action: 'installed' | 'updated' | 'unchanged' | 'removed' | 'dry-run' | 'manual';
  backup: string | null;
  launcher: string;
  diff: string;
  notes: string[];
}

export interface DoctorHarnessReport {
  harness: Harness;
  root: string;
  found: boolean;
  sessions: number;
  bytes: number;
  versions: string[];
  installedVersion: string | null;
  originators?: Record<string, number>;
  emptySessions: number;
  emptyProjects: number;
  orphanSessionDirs: number;
  subagentFiles: { direct: number; workflow: number; unlinked: number; missing: number };
  journals: number;
  unrecognisedFiles: number;
  unknownRecordTypes: Record<string, number>;
  unknownSubtypes: Record<string, number>;
  unknownToolShapes: Record<string, number>;
  unknownContentBlocks: Record<string, number>;
  unknownCodexPayloads: Record<string, number>;
  badLines: number;
  lineSeparatorChars: number;
  bashWithoutToolUseResult: number;
  excludedSyntheticLines: number;
  legacyShapes: Record<string, number>;
  codexDialect?: string;
  hooksDisabled?: boolean;
}

export interface DoctorHookReport {
  harness: Harness;
  scope: 'user' | 'project' | 'local' | 'managed' | 'plugin';
  configPath: string;
  installed: boolean;
  command: string | null;
  resolvable: boolean | null;
  resolvableNote: string;
  disabled: boolean;
  otherStopHooks: string[];
  strict: boolean;
  trusted: true | false | 'unknown';
  trustNote?: string;
  /** False when the config file exists but fails strict JSON parsing (comment-bearing or broken) — S23c `setup/inspect.ts`. */
  configReadable?: boolean;
}

/** `doctor --json` (§12.3). */
export interface DoctorReport {
  roots: Roots;
  node: { version: string; platform: string };
  harnesses: DoctorHarnessReport[];
  hooks: DoctorHookReport[];
  ledgers: {
    sessions: number;
    partial: number;
    gaps: number;
    stdinOverflow: number;
    stopBudgetExceeded: number;
    copilotTranscriptUnparsed: number;
  };
  prices: { version: string; overrideHash?: string; unverifiedInUse: boolean; unpricedModels: string[] };
  cache: { entries: number; bytes: number };
  problems: string[];
  warnings: string[];
}

/** One row of the `--publish` payload (§13.3): `costPerDoneTurnUsd` is a single 2-decimal number here. */
export interface PublishRow {
  harness: Harness;
  harnessVersion: string;
  model: string;
  sessions: number;
  turns: number;
  doneTurns: number;
  contradictedTurns: number;
  unverifiedTurns: number;
  cleanTurns: number;
  claims: {
    total: number;
    verified: number;
    unverified: number;
    contradicted: number;
    notScored: number;
    byKind: Partial<Record<ClaimKind, number>>;
  };
  testRunRate: number | null;
  integritySignals: number;
  ledgerIncompleteSessions: number;
  costPerDoneTurnUsd: number | null;
  cacheHitPct: number | null;
  contradictionReasons: Partial<Record<Reason, number>>;
}

/** The `bench --publish` file (§13.3, exact). */
export interface PublishPayload {
  schema: 'showreceipts.bench-publish/1';
  generator: { name: 'showreceipts'; version: string; rulesVersion: string; pricesVersion: string };
  period: { from: string; to: string; partial: boolean };
  platform: { os: string; node: string };
  contentHash: string;
  rows: PublishRow[];
}

/** The HTML report's embedded data block (§11.1), keyed by `harness:sessionId`. */
export interface ReportPayload {
  meta: { toolVersion: string; rulesVersion: string; pricesVersion: string; generatedAt: string; hashPaths: boolean };
  rows: RateRow[];
  sessions: SessionCard[];
  receipts: Record<string, Receipt>;
  timelines: Record<string, { cols: string[]; rows: unknown[][] }>;
}

/** `--explain-claim` output (§5.1, S17): why a sentence became (or did not become) a scored claim. */
export interface Explanation {
  claimId: string;
  sentence: string;
  clause: string;
  rule: string;
  /** The rule's trigger phrase that matched. */
  trigger: string;
  /** The cue word/phrase inside the clause. */
  cue: string;
  polarity: Claim['polarity'];
  attribution: Claim['attribution'];
  /** The §4.8 reconcile-rule row that judged the claim. */
  row: number;
  factsExamined: string[];
  why: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Every harness in the fixed enum order used by tables and `--publish`. */
export const HARNESSES: readonly Harness[] = [
  'claude-code',
  'codex',
  'cursor',
  'gemini',
  'copilot',
  'hermes',
  'dsh',
  'opencode',
  'openclaw',
];

/** Display labels (receipt header, `audit` table, HTML). */
export const HARNESS_LABELS: Readonly<Record<Harness, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  copilot: 'Copilot CLI',
  hermes: 'Hermes',
  dsh: 'dsh',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
};
