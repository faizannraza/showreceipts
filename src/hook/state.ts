/**
 * Per-session hook state (§9, S27): `<home>/state/<harness>/<safeSid>.json`
 * holds the strict-mode nudge history — the hash of the final message last
 * nudged (an identical final is never re-nudged), the session nudge count
 * and the turn keys already nudged. Written atomically `0600` under `0700`
 * directories; read tolerantly (a missing, corrupt or wrongly-typed file is
 * a fresh state). Also the tolerant reader for `setup`'s
 * `<home>/state/setup.json` (S30 owns the writes).
 */
import { dirname, join } from 'node:path';
import type { Harness } from '../model/types.js';
import { atomicWriteFile, ensureDir, readJsonFile } from '../util/fs.js';
import { isRecord, stableStringify } from '../util/json.js';
import { statePath } from './paths.js';

/** The strict-mode nudge history of one session. */
export interface HookState {
  /** `sha256(finalText)` of the last final message that triggered a nudge. */
  lastNudgeFinalHash?: string;
  /** Nudges issued this session (capped at 5 by `strict.ts`). */
  nudges: number;
  /**
   * Turn keys already nudged, oldest first (the per-turn `--strict-max` cap;
   * doubles as the Codex `turn_id` secondary cap). Bounded by `strict.ts`.
   */
  turnIds: string[];
}

/** A fresh, empty state (new object each call — callers may mutate). */
export function freshHookState(): HookState {
  return { nudges: 0, turnIds: [] };
}

/**
 * Reads the session's state file; tolerant — a missing file, unparsable
 * JSON or wrongly-typed fields yield (or fall back to) a fresh state.
 */
export function readHookState(home: string, harness: Harness, sid: string): HookState {
  const raw = readJsonFile(statePath(home, harness, sid));
  const state = freshHookState();
  if (!isRecord(raw)) return state;
  if (typeof raw['lastNudgeFinalHash'] === 'string') state.lastNudgeFinalHash = raw['lastNudgeFinalHash'];
  const nudges = raw['nudges'];
  if (typeof nudges === 'number' && Number.isFinite(nudges) && nudges >= 0) state.nudges = Math.floor(nudges);
  const turnIds = raw['turnIds'];
  if (Array.isArray(turnIds)) state.turnIds = turnIds.filter((t): t is string => typeof t === 'string');
  return state;
}

/** Writes the session's state file atomically (`0600` file, `0700` directories). */
export function writeHookState(home: string, harness: Harness, sid: string, state: HookState): void {
  const path = statePath(home, harness, sid);
  ensureDir(dirname(path), 0o700);
  atomicWriteFile(path, `${stableStringify(state)}\n`, { mode: 0o600 });
}

/** The subset of `<home>/state/setup.json` the hook/removal paths consult (§9; S30 writes it). */
export interface SetupStateFile {
  /** Per harness: `setup` created the `hooks` key itself, so `--remove` may drop it when empty. */
  createdHooksKey?: Partial<Record<string, boolean>>;
}

/** Tolerant read of `<home>/state/setup.json`; `{}` when missing or malformed. */
export function readSetupState(home: string): SetupStateFile {
  const raw = readJsonFile(join(home, 'state', 'setup.json'));
  if (!isRecord(raw)) return {};
  const out: SetupStateFile = {};
  const created = raw['createdHooksKey'];
  if (isRecord(created)) {
    const map: Partial<Record<string, boolean>> = {};
    for (const [harness, value] of Object.entries(created)) {
      if (typeof value === 'boolean') map[harness] = value;
    }
    out.createdHooksKey = map;
  }
  return out;
}
