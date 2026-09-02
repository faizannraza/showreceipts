/**
 * `<task-notification>` continuation segments (ARCHITECTURE §4.2.3 step 4).
 * A task notification is agent-generated text: it becomes a continuation
 * `Segment` on the enclosing turn, its text never feeds `userText` or
 * `echoHashes`, and its parsed fields attach an exit code (source
 * `'notification'`) to the matching background tool call and a completion to
 * the matching `SubagentInfo` (S07 fills the rest of the info).
 */
import type { Segment, Session } from '../../model/types.js';

/** Parsed fields of a `<task-notification>` body. */
export interface TaskNotification {
  taskId: string | null;
  toolUseId: string | null;
  status: string | null;
  summary: string | null;
  /** From `Background command "…" completed (exit code N)`. */
  exitCode: number | null;
}

const EXIT_RE = /Background command "[^"]*" completed \(exit code (-?\d+)\)/;
const EXIT_LOOSE_RE = /\(exit code (-?\d+)\)/;

function tag(text: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  const value = m?.[1]?.trim();
  return value !== undefined && value !== '' ? value : null;
}

/**
 * Parses a `<task-notification>` body. Missing tags yield `null` fields;
 * malformed text never throws.
 */
export function parseTaskNotification(text: string): TaskNotification {
  const exit = EXIT_RE.exec(text) ?? EXIT_LOOSE_RE.exec(text);
  const exitCode = exit?.[1] !== undefined ? Number(exit[1]) : null;
  return {
    taskId: tag(text, 'task-id'),
    toolUseId: tag(text, 'tool-use-id'),
    status: tag(text, 'status'),
    summary: tag(text, 'summary'),
    exitCode: Number.isFinite(exitCode ?? NaN) ? exitCode : null,
  };
}

/** A status that means the task is still going (no completion is applied). */
const IN_PROGRESS_RE = /^(running|started|starting|in[-_ ]progress|pending|queued)$/i;

/**
 * Applies one notification segment to the session (§4.2.3 step 4): the exit
 * code goes to the tool call whose `backgroundTaskId` matches `<task-id>`
 * (source `'notification'`), and completion (`finished`, `exitCode`) to the
 * `SubagentInfo` matching by `agentId` or spawning `toolUseId`. Segments
 * whose text carries no recognisable fields are left alone.
 */
export function applyNotification(session: Session, seg: Segment): void {
  if (seg.trigger !== 'notification') return;
  const parsed = parseTaskNotification(seg.text ?? '');
  const taskId = seg.taskId ?? parsed.taskId;
  const toolUseId = seg.toolUseId ?? parsed.toolUseId;
  const status = seg.status ?? parsed.status;
  if (taskId !== null) {
    for (const call of session.toolCalls) {
      if (call.backgroundTaskId === taskId) {
        if (parsed.exitCode !== null) {
          call.exitCode = parsed.exitCode;
          call.exitCodeSource = 'notification';
        }
        break;
      }
    }
  }
  const completed = status === null || !IN_PROGRESS_RE.test(status);
  if (!completed) return;
  for (const info of session.subagents) {
    const matches = (taskId !== null && info.agentId === taskId) || (toolUseId !== null && info.spawnedBy.toolUseId === toolUseId);
    if (matches) {
      info.finished = true;
      if (parsed.exitCode !== null) info.exitCode = parsed.exitCode;
      break;
    }
  }
}
