/**
 * Strict-mode nudge decision (§9, S27). Pure and deterministic: given the
 * receipt, the flags and the session's nudge state, decide whether this
 * stop may nudge the agent, with which reason and which message, and what
 * the state becomes. Dialects translate the decision into their harness's
 * block/deny/followup shape; the runtime persists `newState`.
 *
 * Guards (§9, each blocks independently): strict off; effects-only session;
 * the harness's loop flag; an identical final message
 * (`lastNudgeFinalHash`); the session cap of 5; the per-turn `--strict-max`
 * cap; and an empty reason set after the `--strict-reasons` filter.
 */
import type { Judgement, Reason, Receipt } from '../model/types.js';
import { sha256 } from '../util/hash.js';
import { sanitizeForCell } from '../util/sanitize.js';
import type { HookState } from './state.js';

/** The only reasons that may nudge (§9), in priority order; every entry is part of the S17 `Reason` union. */
export const NUDGE_REASONS = ['no-test-run', 'last-run-red', 'stale-run', 'check-red', 'git-op-failed'] as const;
export type NudgeReason = (typeof NUDGE_REASONS)[number];

/** Nudges per session, whatever `--strict-max` says per turn. */
export const SESSION_NUDGE_CAP = 5;

/** How many nudged turn keys the state retains (oldest dropped first). */
const TURN_IDS_KEPT = 100;

/** One deterministic message per reason (≤ 200 chars, sanitised at decision time). */
const MESSAGES: Readonly<Record<NudgeReason, string>> = {
  'no-test-run': 'showreceipts: you said tests pass but no test command ran after your last edit — run them',
  'last-run-red': 'showreceipts: you said tests pass but the last test run before your message exited red — re-run them',
  'stale-run': 'showreceipts: the last test run predates your latest edits (or the tests were weakened) — re-run them',
  'check-red': 'showreceipts: you said a check passes but its last run exited non-zero — re-run it',
  'git-op-failed': 'showreceipts: you reported a git operation as done but it failed — check git status and retry',
};

/** Inputs of {@link decideNudge}. */
export interface NudgeInput {
  receipt: Receipt;
  /** `--strict` was passed. */
  strict: boolean;
  /** `--strict-reasons` filter; `undefined` or empty ⇒ all five (unknown entries are ignored). */
  reasons?: readonly string[];
  /** `--strict-max` (default 1): nudges allowed for this turn. */
  max: number;
  /** The harness loop flag (`stop_hook_active`, Cursor `loop_count > 0`, …). */
  loopFlag: boolean;
  state: HookState;
  /** The session has no scoreable final text (ledger effects only). */
  effectsOnly: boolean;
  /** Turn key for the per-turn cap (Codex `turn_id`); defaults to the receipt's `turnIndex`. */
  turnId?: string;
}

/** What {@link decideNudge} answers. */
export interface NudgeDecision {
  nudge: boolean;
  reason?: NudgeReason;
  /** The nudge text (`''` when `nudge` is false). */
  message: string;
  /** The state to persist (the input state, unchanged, when no nudge fired). */
  newState: HookState;
}

/** The nudge reason a judgement contributes, or `null` (`test-weakened` integrity counts as `stale-run`). */
function judgementReason(j: Judgement): NudgeReason | null {
  if (j.integrity === 'test-weakened') return 'stale-run';
  return (NUDGE_REASONS as readonly Reason[]).includes(j.reason) ? (j.reason as NudgeReason) : null;
}

/** The reasons the `--strict-reasons` filter admits (unknown entries ignored; empty filter ⇒ all). */
function allowedReasons(filter?: readonly string[]): ReadonlySet<NudgeReason> {
  if (filter === undefined || filter.length === 0) return new Set(NUDGE_REASONS);
  return new Set(NUDGE_REASONS.filter((reason) => filter.includes(reason)));
}

/**
 * Decides whether this stop nudges (§9). Never nudges when strict is off,
 * for effects-only sessions, when the loop flag is set, when the final
 * message hash equals the last nudged one, past the session cap of 5, past
 * the per-turn `--strict-max` cap, or when no judgement carries an admitted
 * reason. The reason chosen is the first match in the fixed
 * {@link NUDGE_REASONS} order and its message is a fixed template.
 */
export function decideNudge(input: NudgeInput): NudgeDecision {
  const { receipt, state } = input;
  const decline: NudgeDecision = { nudge: false, message: '', newState: state };
  if (!input.strict) return decline;
  if (input.effectsOnly) return decline;
  if (input.loopFlag) return decline;
  const finalHash = sha256(receipt.finalText);
  if (state.lastNudgeFinalHash === finalHash) return decline;
  if (state.nudges >= SESSION_NUDGE_CAP) return decline;
  const turnKey = input.turnId ?? String(receipt.turnIndex);
  const nudgedThisTurn = state.turnIds.filter((id) => id === turnKey).length;
  if (input.max <= 0 || nudgedThisTurn >= input.max) return decline;
  const allowed = allowedReasons(input.reasons);
  const found = new Set<NudgeReason>();
  for (const judgement of receipt.judgements) {
    const reason = judgementReason(judgement);
    if (reason !== null && allowed.has(reason)) found.add(reason);
  }
  const reason = NUDGE_REASONS.find((candidate) => found.has(candidate));
  if (reason === undefined) return decline;
  const newState: HookState = {
    lastNudgeFinalHash: finalHash,
    nudges: state.nudges + 1,
    turnIds: [...state.turnIds, turnKey].slice(-TURN_IDS_KEPT),
  };
  return { nudge: true, reason, message: sanitizeForCell(MESSAGES[reason]), newState };
}
