/**
 * The `doctor` exit-4 problem list — exactly the §12.2 items and nothing
 * else. The four per-session core shapes come from `readers/problems.ts`
 * (`coreShapeProblems`, S23c/W1); this module adds the environment items:
 * `disableAllHooks` masking installed hooks, an unresolvable launcher for an
 * installed hook, an unreadable root, corrupt cache entries and Node < 20.
 * Everything the readers merely do not understand stays a warning
 * (Appendix E).
 *
 * Pure over its inputs: `doctor/collect.ts` gathers, this module judges.
 */
import type { DoctorHookReport, Session } from '../model/types.js';
import { coreShapeProblems } from '../readers/problems.js';

/** A root that exists but cannot be listed (§12.2 "unreadable root"). */
export interface UnreadableRoot {
  path: string;
  /** The errno code or message the probe saw (`EACCES`, …). */
  message: string;
}

/** The environment facts the §12.2 non-session items are judged from. */
export interface EnvProblemInputs {
  /** `process.version` (or the injected seam) — `v26.0.0` / `18.20.0` both parse. */
  nodeVersion: string;
  hooks: readonly DoctorHookReport[];
  unreadableRoots: readonly UnreadableRoot[];
  /** Corrupt entries seen in `cache/` (static scan + load counter). */
  corruptCacheEntries: number;
}

/**
 * The per-session core-shape problems (§12.2 items 1–4) across every loaded
 * session, each prefixed with the session it came from.
 */
export function sessionProblems(sessions: readonly Session[]): string[] {
  const out: string[] = [];
  for (const session of sessions) {
    for (const problem of coreShapeProblems(session)) {
      out.push(`${session.harness} ${session.shortId}: ${problem}`);
    }
  }
  return out;
}

/** Major version of a `v26.0.0` / `18.20.0` node version string (0 when unparsable). */
export function nodeMajorOf(version: string): number {
  const m = /^v?(\d+)/.exec(version.trim());
  return m === null ? 0 : Number(m[1]);
}

/**
 * The environment problems of the §12.2 exit-4 list: hooks masked by
 * `disableAllHooks`, an unresolvable launcher behind an installed hook, an
 * unreadable root, corrupt cache entries, Node < 20. Deterministic order.
 */
export function envProblems(inputs: EnvProblemInputs): string[] {
  const out: string[] = [];
  for (const hook of inputs.hooks) {
    if (hook.disabled && hook.installed) {
      out.push(`disableAllHooks is true in ${hook.configPath} but showreceipts hooks are installed there`);
    }
  }
  const unresolvable = inputs.hooks.filter((h) => h.installed && h.resolvable === false);
  if (unresolvable.length > 0) {
    const harnesses = [...new Set(unresolvable.map((h) => h.harness))].sort();
    out.push(`launcher unresolvable for installed hooks (${harnesses.join(', ')}) — re-run showreceipts setup`);
  }
  for (const root of inputs.unreadableRoots) {
    out.push(`unreadable root: ${root.path} (${root.message})`);
  }
  if (inputs.corruptCacheEntries > 0) {
    const noun = inputs.corruptCacheEntries === 1 ? 'entry' : 'entries';
    out.push(`corrupt cache: ${inputs.corruptCacheEntries} ${noun} under cache/ (doctor --clear-cache resets it)`);
  }
  if (nodeMajorOf(inputs.nodeVersion) < 20) {
    out.push(`node ${inputs.nodeVersion} is below the supported minimum (>= 20)`);
  }
  return out;
}
