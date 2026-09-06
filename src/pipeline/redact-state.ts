/**
 * §4.9 privacy at the cache-write seam: a serialized Claude Code builder
 * state (`SessionBuilder.serialize()`) carries every prompt group's raw
 * `userText`, and `cache.put` would otherwise persist it verbatim — the
 * documented invariant is that a cache entry holds *never prompt text*
 * (§4.9, §13.1). {@link redactBuilderState} nulls every finalized group's
 * text, memoising its §4.7 `echoHashes` first so a warm incremental resume
 * still reproduces the cold echo check byte for byte (`assembleTurns` seeds
 * `Turn.echoHashes` from the group; `enrichSession`/`parseRef` keep stored
 * hashes when `userText` is null). The still-open trailing group — and the
 * current group, which can differ under event reordering — keeps its text:
 * its turn is still being assembled across Stop resumes.
 *
 * This lives in the pipeline layer (not the reader) because computing the
 * hashes needs `claims/text.ts`, which the §0.5 layer order forbids readers
 * to import. Tolerant: anything that does not look like a v1 builder state
 * is returned unchanged.
 */
import { echoHashes } from '../claims/text.js';
import { isRecord } from '../util/json.js';

/** Redacts prompt text out of a serialized builder state before it is cached. */
export function redactBuilderState(state: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(state);
  } catch {
    return state;
  }
  if (!isRecord(parsed) || parsed['v'] !== 1 || !Array.isArray(parsed['groups'])) return state;
  const groups = parsed['groups'] as unknown[];
  const current = typeof parsed['currentGroup'] === 'number' ? parsed['currentGroup'] : -1;
  let changed = false;
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    if (!isRecord(group) || typeof group['userText'] !== 'string') continue;
    if (!Array.isArray(group['echoHashes'])) {
      group['echoHashes'] = echoHashes(group['userText']);
      changed = true;
    }
    if (gi === groups.length - 1 || gi === current) continue; // still-open turn: keep for Stop-resume
    group['userText'] = null;
    changed = true;
  }
  return changed ? JSON.stringify(parsed) : state;
}
