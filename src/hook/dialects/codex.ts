/**
 * Codex dialect (§9 Codex row, S28). `Stop` only: locate the rollout
 * (`transcript_path`, else `<codexHome>/sessions/**` by `-<session_id>.jsonl`
 * suffix, `archived_sessions` included), run the §9 stop flow, and answer
 * `{"systemMessage": "…", "suppressOutput": true}` kept under ~2,500 tokens
 * (8 KiB cap). Strict mode answers a top-level
 * `{"decision": "block", "reason": "…"}` only; `stop_hook_active` means the
 * loop guard never nudges, and `turn_id` keys the per-turn nudge cap.
 */
import { join } from 'node:path';
import { isRecord } from '../../util/json.js';
import type { Dialect, EventClass, HookContext, HookEventModel, HookOutput } from '../dialect.js';
import { unknownSid } from '../paths.js';
import { truncateUtf8 } from '../record.js';
import { freshHookState, readHookState } from '../state.js';
import { buildStopReceipt, stopStdout } from '../stop.js';
import { decideNudge } from '../strict.js';

/** Stdout cap (§9 Codex row: < 2,500 tokens ≈ 8 KiB). */
export const CODEX_STDOUT_MAX_BYTES = 8 * 1024;

const EVENTS: Readonly<Record<string, EventClass>> = { Stop: 'stop' };

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Trims a `systemMessage` answer to the 8 KiB serialised cap (§9). The
 * budget drops the overshoot plus the 3 UTF-8 bytes the appended `…` adds,
 * so the re-serialised object never exceeds {@link CODEX_STDOUT_MAX_BYTES}
 * (JSON escaping can only make the removed suffix's serialised share larger
 * than its raw share, never smaller). Exported for the boundary test.
 */
export function capStdout(out: object): object {
  const rec = out as Record<string, unknown>;
  const message = rec['systemMessage'];
  if (typeof message !== 'string') return out;
  const over = Buffer.byteLength(JSON.stringify(out), 'utf8') - CODEX_STDOUT_MAX_BYTES;
  if (over <= 0) return out;
  const budget = Math.max(0, Buffer.byteLength(message, 'utf8') - over - 3);
  return { ...rec, systemMessage: `${truncateUtf8(message, budget)}…` };
}

async function handleStop(ev: HookEventModel, ctx: HookContext): Promise<HookOutput> {
  const input = ev.input;
  const loopFlag = input['stop_hook_active'] === true;
  const home = ctx.env['HOME'] ?? '';
  const codexHome = str(ctx.env['CODEX_HOME']) ?? (home === '' ? '' : join(home, '.codex'));
  const result = await buildStopReceipt({
    harness: 'codex',
    transcriptPath: str(input['transcript_path']) ?? null,
    sessionId: ev.sid,
    lastAssistantMessage: typeof input['last_assistant_message'] === 'string' ? input['last_assistant_message'] : '',
    cwd: ctx.cwd,
    home: ctx.home,
    userHome: home,
    codexHome,
    now: ctx.now,
    noCache: ctx.flags.noCache || ctx.env['SHOWRECEIPTS_NO_CACHE'] === '1',
  });
  if (result.subagent) return { stdout: {} };
  if (result.receipt === null) {
    ctx.debug('codex Stop: no rollout located — answered {}');
    return { stdout: {} };
  }
  // §9: `stop_hook_active` ⇒ never nudge; `turn_id` keys the per-turn cap.
  if (ctx.flags.strict && !loopFlag) {
    const sid = ev.sid ?? unknownSid(ctx.cwd, ctx.now.toISOString());
    const state = ctx.home === '' ? freshHookState() : readHookState(ctx.home, 'codex', sid);
    const decision = decideNudge({
      receipt: result.receipt,
      strict: true,
      reasons: ctx.flags.strictReasons,
      max: ctx.flags.strictMax,
      loopFlag,
      state,
      effectsOnly: result.effectsOnly,
      ...(ev.tid !== undefined ? { turnId: ev.tid } : {}),
    });
    if (decision.nudge) {
      // §9 Codex row: strict answers the top-level block object only.
      return { stdout: { decision: 'block', reason: decision.message }, state: decision.newState };
    }
  }
  return { stdout: capStdout(stopStdout(result.receipt, result.files, { verbose: ctx.flags.verbose, cwd: ctx.cwd })) };
}

/** The `hook codex` dialect (§9 Codex row). */
export const dialect: Dialect = {
  harness: 'codex',
  events: EVENTS,
  parse(event: string, input: unknown, ctx: HookContext): HookEventModel {
    const rec = isRecord(input) ? input : {};
    const model: HookEventModel = {
      event,
      eventClass: EVENTS[event] ?? 'record',
      input: rec,
      sid: str(rec['session_id']) ?? null,
    };
    const tid = str(rec['turn_id']);
    if (tid !== undefined) model.tid = tid;
    const cwd = str(rec['cwd']);
    if (cwd !== undefined) model.cwd = cwd;
    void ctx;
    return model;
  },
  async handle(ev: HookEventModel, ctx: HookContext): Promise<HookOutput> {
    if (ev.event === 'Stop') return handleStop(ev, ctx);
    return { stdout: {} };
  },
};
