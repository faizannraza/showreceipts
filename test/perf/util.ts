/**
 * Shared plumbing of the S36 perf suites: the SHOWRECEIPTS_PERF gate, the
 * tolerance multiplier (time budgets × tolerance, rate floors ÷ tolerance;
 * ×3 under CI via scripts/perf.mjs) and the cached 60 MB synthetic tree
 * (scripts/gen-big-transcript.mjs).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionRef } from '../../src/model/types.js';

/** True when scripts/perf.mjs (or CI's perf job) is driving the run. */
export const PERF = process.env['SHOWRECEIPTS_PERF'] === '1';

/** The budget multiplier (`SHOWRECEIPTS_PERF_TOLERANCE`, default 1). */
export function tolerance(): number {
  const parsed = Number(process.env['SHOWRECEIPTS_PERF_TOLERANCE'] ?? '1');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

const GEN_SCRIPT = fileURLToPath(new URL('../../scripts/gen-big-transcript.mjs', import.meta.url));

export interface BigTree {
  /** The tree root (usable as a CLAUDE_CONFIG_DIR). */
  treeDir: string;
  /** The ~60 MB main transcript. */
  mainPath: string;
  /** Bytes of the main transcript. */
  bytes: number;
}

/** Ensures the cached 60 MB synthetic tree exists and returns its paths. */
export function ensureBigTree(): BigTree {
  const stdout = execFileSync(process.execPath, [GEN_SCRIPT, '--print-path'], { encoding: 'utf8' });
  const mainPath = stdout.trim().split('\n').pop() ?? '';
  const treeDir = dirname(dirname(dirname(mainPath)));
  return { treeDir, mainPath, bytes: statSync(mainPath).size };
}

/** The `SessionRef.subagentManifest` of a main transcript's subagent dir (sorted relative path, size, mtimeMs). */
export function subagentManifest(mainPath: string, sessionId: string): SessionRef['subagentManifest'] {
  const dir = join(dirname(mainPath), sessionId, 'subagents');
  const out: { rel: string; size: number; mtimeMs: number }[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        const s = statSync(p);
        out.push({ rel: relative(dir, p).split(sep).join('/'), size: s.size, mtimeMs: s.mtimeMs });
      }
    }
  };
  try {
    walk(dir);
  } catch {
    /* no subagents */
  }
  return out;
}
