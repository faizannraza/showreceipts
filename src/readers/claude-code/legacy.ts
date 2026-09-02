/**
 * Legacy transcript shapes (ARCHITECTURE §4.2.9; synthetic
 * `claude-code/legacy` fixture, unverified against real data): `Task` →
 * `Agent`, `MultiEdit` → `Edit` (`edits[]`), `type: 'summary'` lines with
 * `leafUuid`, usage without a `cache_creation` breakdown (the `wU` path in
 * usage.ts), and in-file `isSidechain: true` chains that merge like subagent
 * files. Every case is counted in `Diagnostics.legacyShapes` and is never a
 * doctor problem.
 */
import type { LineSource } from '../../model/types.js';
import { asString } from './records.js';
import type { SubagentSource } from './subagents.js';

/** `Task` → `Agent`, `MultiEdit` → `Edit` (§4.2.5); the legacy shape key is counted when set. */
export function legacyToolName(tool: string): { tool: string; legacyShape: string | null } {
  if (tool === 'Task') return { tool: 'Agent', legacyShape: 'Task' };
  if (tool === 'MultiEdit') return { tool: 'Edit', legacyShape: 'MultiEdit' };
  return { tool, legacyShape: null };
}

/** Serialisable state of a {@link SidechainCollector}. */
export interface SidechainState {
  /** uuid → chain root uuid, for lines seen so far. */
  rootOf: Record<string, string>;
  /** agent key → raw JSON lines (insertion order preserved by key order). */
  buffers: Record<string, string[]>;
  /** agent key per chain, in first-seen order. */
  order: string[];
}

/**
 * Collects in-file `isSidechain: true` chains in a main transcript
 * (§4.2.9). Chains are grouped by their `parentUuid: null` root;
 * `agentId = agentId ?? root uuid`. The collected lines are re-serialised
 * and handed to `mergeSubagents` as an in-memory `SubagentSource` — they
 * never start turns or supply finals in the main parse.
 */
export class SidechainCollector {
  private readonly rootOf: Map<string, string>;
  private readonly buffers: Map<string, string[]>;

  constructor(state?: SidechainState) {
    this.rootOf = new Map(Object.entries(state?.rootOf ?? {}));
    this.buffers = new Map();
    for (const key of state?.order ?? []) {
      const lines = state?.buffers[key];
      if (lines !== undefined) this.buffers.set(key, [...lines]);
    }
  }

  /** Number of distinct chains collected (the `inline-sidechain` legacy count). */
  chainCount(): number {
    return this.buffers.size;
  }

  /** Diverts one sidechain record. Returns the chain's agent key. */
  feed(record: Record<string, unknown>): string {
    const uuid = asString(record['uuid']);
    const parentUuid = asString(record['parentUuid']);
    let root: string;
    if (parentUuid === null) root = uuid ?? `chain-${this.buffers.size}`;
    else root = this.rootOf.get(parentUuid) ?? parentUuid;
    if (uuid !== null) this.rootOf.set(uuid, root);
    const agentKey = asString(record['agentId']) ?? root;
    let buffer = this.buffers.get(agentKey);
    if (buffer === undefined) {
      buffer = [];
      this.buffers.set(agentKey, buffer);
    }
    buffer.push(JSON.stringify(record));
    return agentKey;
  }

  /** The collected chains as an in-memory `SubagentSource`, or `null` when none were seen. */
  source(): SubagentSource | null {
    if (this.buffers.size === 0) return null;
    const files = new Map<string, LineSource>();
    for (const [agentKey, lines] of this.buffers) {
      const name = `agent-${agentKey}.jsonl`;
      files.set(name, { kind: 'text', text: lines.join('\n') + '\n', name });
    }
    return { kind: 'memory', files };
  }

  /** Serialisable snapshot (builder resume state). */
  state(): SidechainState {
    const buffers: Record<string, string[]> = {};
    const order: string[] = [];
    for (const [key, lines] of this.buffers) {
      order.push(key);
      buffers[key] = [...lines];
    }
    return { rootOf: Object.fromEntries(this.rootOf), buffers, order };
  }
}
