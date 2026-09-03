/**
 * Usage-row dedupe (ARCHITECTURE §4.2.7, §8.3, S18).
 *
 * Two layers, both expressed as `UsageRow.inherited` marks on the in-memory
 * sessions only — a cache entry never carries `inherited` (`trimForCache`
 * strips it, because the cross-session layer depends on the scanned set and
 * `--since`):
 *
 * 1. **Within one session** (`markSessionInherited`): a fork's copy of a
 *    main-file `message.id` is `inherited:true` and never billed. The reader
 *    marks this at parse time, but the mark does not survive the cache, so
 *    the pipeline recomputes it deterministically after every load (cold and
 *    warm alike — receipts must be byte-identical either way). The main-file
 *    row (`agentId === null`) owns the id; among subagent copies the lowest
 *    merged `seq` wins.
 *
 * 2. **Across sessions** (`dedupeUsage`): `audit` totals, `bench` and
 *    `--publish` dedupe `message.id`s across every scanned session — the
 *    earliest session by `startedAt` owns the row, later copies are
 *    `inherited:true`. Receipts stay per-session (§8.3), so `loadSessions`
 *    never applies this layer itself; the aggregate commands call it after
 *    loading, before cost.
 */
import type { Session, UsageRow } from '../model/types.js';
import { parseIso } from '../util/time.js';

/** Groups a session's usage rows by `messageId` (empty ids are never deduped). */
function groupByMessageId(rows: readonly UsageRow[]): Map<string, UsageRow[]> {
  const groups = new Map<string, UsageRow[]>();
  for (const row of rows) {
    if (row.messageId === '') continue;
    const group = groups.get(row.messageId);
    if (group === undefined) groups.set(row.messageId, [row]);
    else group.push(row);
  }
  return groups;
}

/** The owning row of one within-session duplicate group: main file first, then lowest `seq`. */
function ownerOf(rows: readonly UsageRow[]): UsageRow {
  let owner = rows[0] as UsageRow;
  for (const row of rows) {
    const ownerMain = owner.agentId === null;
    const rowMain = row.agentId === null;
    if (rowMain !== ownerMain) {
      if (rowMain) owner = row;
      continue;
    }
    if (row.seq < owner.seq) owner = row;
  }
  return owner;
}

/**
 * Recomputes the within-session `inherited` marks (§4.2.7) from scratch:
 * for every `messageId` present more than once, the main-file row (else the
 * lowest-seq row) owns it and every other copy is `inherited:true`; rows
 * whose id is unique lose any stale mark. Idempotent, and identical for a
 * freshly parsed and a cache-restored session — the cache strips the marks,
 * so this recompute is what keeps warm receipts byte-identical to cold ones.
 */
export function markSessionInherited(session: Session): void {
  for (const [, rows] of groupByMessageId(session.usageRows)) {
    if (rows.length === 1) {
      delete (rows[0] as UsageRow).inherited;
      continue;
    }
    const owner = ownerOf(rows);
    for (const row of rows) {
      if (row === owner) delete row.inherited;
      else row.inherited = true;
    }
  }
}

/** Sort key for the owning session of a cross-session duplicate: earliest `startedAt`, then `sessionId`, then `harness`. */
function earlier(a: Session, b: Session): Session {
  const aMs = parseIso(a.startedAt) ?? Number.MAX_SAFE_INTEGER;
  const bMs = parseIso(b.startedAt) ?? Number.MAX_SAFE_INTEGER;
  if (aMs !== bMs) return aMs < bMs ? a : b;
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? a : b;
  return a.harness <= b.harness ? a : b;
}

/**
 * Applies the cross-session `message.id` dedupe (§8.3 scope rule) for
 * aggregate totals: after re-establishing the within-session baseline, every
 * `messageId` that appears in more than one of `sessions` is owned by the
 * earliest session (by `startedAt`; ties broken by `sessionId`, then
 * harness) and every row of it in any other session is `inherited:true`.
 * Mutates the in-memory sessions only — nothing here ever reaches the cache
 * — and is idempotent over the same session set.
 */
export function dedupeUsage(sessions: readonly Session[]): void {
  for (const session of sessions) markSessionInherited(session);
  const owners = new Map<string, Session>();
  for (const session of sessions) {
    for (const row of session.usageRows) {
      if (row.messageId === '') continue;
      const current = owners.get(row.messageId);
      owners.set(row.messageId, current === undefined ? session : earlier(current, session));
    }
  }
  for (const session of sessions) {
    for (const row of session.usageRows) {
      if (row.messageId === '') continue;
      if (owners.get(row.messageId) !== session) row.inherited = true;
    }
  }
}
