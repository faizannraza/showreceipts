/**
 * Shared cap for post-final agent notes (§5.2 "after this message: …"): a
 * receipt renders at most {@link PF_NOTES_MAX} per-agent notes; the rest
 * collapse into one aggregate whose tool-call sum is exact (files are
 * omitted — they can double-count across agents). A real session with 46
 * post-final subagents rendered 92 note lines before the cap. Both
 * `render/term.ts` and `render/md.ts` draw from here so the two renderers
 * cannot drift apart again.
 */
import type { Receipt } from '../model/types.js';

/** One per-agent post-final entry as the pipeline emits it. */
export type PostFinalNote = NonNullable<Receipt['postFinal']>[number];

/** Per-agent notes rendered individually before the tail aggregates. */
export const PF_NOTES_MAX = 3;

/** The aggregate of the collapsed tail. */
export interface PostFinalRest {
  agents: number;
  toolCalls: number;
}

/**
 * Splits the post-final entries into the notes to render one by one and the
 * aggregate of the rest (`null` when everything fits under the cap).
 */
export function capPostFinal(postFinal: Receipt['postFinal']): { shown: PostFinalNote[]; rest: PostFinalRest | null } {
  const pfs = postFinal ?? [];
  if (pfs.length <= PF_NOTES_MAX) return { shown: [...pfs], rest: null };
  const rest = pfs.slice(PF_NOTES_MAX);
  return {
    shown: pfs.slice(0, PF_NOTES_MAX),
    rest: { agents: rest.length, toolCalls: rest.reduce((sum, pf) => sum + pf.toolCalls, 0) },
  };
}
