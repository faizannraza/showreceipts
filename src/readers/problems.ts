/**
 * Per-session core-shape problems (ARCHITECTURE §12.2, exit 4).
 *
 * `doctor` exits 4 only for **core-shape breakage** — evidence that a
 * transcript no longer matches the shapes every downstream verdict depends
 * on. This module implements the per-session items of that list; S25's
 * `doctor/problems.ts` reuses it and adds the environment items
 * (`disableAllHooks`, unresolvable launcher, unreadable root, corrupt cache,
 * Node < 20). Everything else the readers cannot understand — unknown record
 * types, subtypes, attachment types, tool names, content blocks, extra keys —
 * is a warning with a count, never a problem (Appendix E).
 *
 * The four per-session core shapes:
 * 1. a Bash `toolUseResult` that is neither a string nor an object with
 *    `stdout` + `stderr` (§4.2.4 row 1);
 * 2. an Edit/Write `toolUseResult` object without `filePath` (§4.2.4);
 * 3. an assistant line without `message.model`/`message.usage` (§4.2.2);
 * 4. an unparseable Codex `function_call_output` header (§4.3.3 grammar).
 *
 * All four are detected from `Session.diagnostics` counters the readers
 * maintain, so this function is pure and needs no re-parse.
 */
import type { Session } from '../model/types.js';

/** `Diagnostics.unknownRecordTypes` keys the Claude Code builder uses for broken assistant lines. */
const ASSISTANT_SHAPE_KEYS = ['assistant(no-message)', 'assistant(no-model)', 'assistant(no-usage)'] as const;

/** `Diagnostics.unknownToolShapes` keys covered by the Edit/Write `filePath` rule (`MultiEdit` maps to `Edit` before counting). */
const EDIT_WRITE_KEYS = ['Edit', 'Write'] as const;

/**
 * The core-shape problems of one parsed session (§12.2 exit 4, per-session
 * items only). Returns `[]` for every healthy session — including every
 * committed fixture — and one human-readable string per broken shape
 * otherwise. Sessions from any harness are accepted; counters that a harness
 * never populates simply stay zero.
 */
export function coreShapeProblems(session: Session): string[] {
  const problems: string[] = [];
  const d = session.diagnostics;

  const bash = d.unknownToolShapes['Bash'] ?? 0;
  if (bash > 0) {
    problems.push(`${bash} Bash toolUseResult(s) neither a string nor an object with stdout+stderr`);
  }

  let editWrite = 0;
  for (const key of EDIT_WRITE_KEYS) editWrite += d.unknownToolShapes[key] ?? 0;
  if (editWrite > 0) {
    problems.push(`${editWrite} Edit/Write toolUseResult object(s) without filePath`);
  }

  let assistant = 0;
  for (const key of ASSISTANT_SHAPE_KEYS) assistant += d.unknownRecordTypes[key] ?? 0;
  if (assistant > 0) {
    problems.push(`${assistant} assistant line(s) without message.model/message.usage`);
  }

  let headers = 0;
  const headerTools: string[] = [];
  for (const [key, count] of Object.entries(d.unknownCodexPayloads)) {
    if (key.startsWith('output:')) {
      headers += count;
      headerTools.push(key.slice('output:'.length));
    }
  }
  if (headers > 0) {
    problems.push(`${headers} unparseable Codex function_call_output header(s) (${headerTools.sort().join(', ')})`);
  }

  return problems;
}
