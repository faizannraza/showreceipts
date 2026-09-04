/**
 * OpenCode dialect (§9 OpenCode row — roadmap, S29): a ledger dialect only.
 * It accepts the payload shapes the S30 plugin template forwards —
 * `tool.execute.after` (`{tool, sessionID, callID}` merged with
 * `{title, output, metadata}`) and `session.idle` — and maps them onto
 * Appendix C lines. Stdout is always `{}` (the plugin reads nothing back);
 * no receipt files are written for roadmap harnesses. The plugin template
 * itself is a setup artifact owned by S30 (`setup/writers/opencode.ts`);
 * nothing here spawns anything.
 */
import type { LedgerLine, LedgerLineCommon, LedgerToolInput, ToolKind } from '../../model/types.js';
import { isRecord } from '../../util/json.js';
import type { Dialect, EventClass, HookContext, HookEventModel, HookOutput } from '../dialect.js';
import { unknownSid } from '../paths.js';
import { fallbackToolId } from '../record.js';

type ToolPostLine = Extract<LedgerLine, { e: 'tool-post' }>;

const EVENTS: Readonly<Record<string, EventClass>> = {
  'tool.execute.after': 'record',
  'session.idle': 'stop',
};

/**
 * OpenCode built-in tool names → kind hints. The S09 reader re-derives kinds
 * at parse time (roadmap harnesses currently re-derive to `other`); unknown
 * names map to `other` here too — never a write.
 */
const KINDS: Readonly<Record<string, ToolKind>> = {
  bash: 'shell',
  write: 'write',
  edit: 'edit',
  patch: 'edit',
  read: 'read',
  glob: 'search',
  grep: 'search',
  list: 'search',
  webfetch: 'fetch',
  task: 'agent',
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Appendix C common fields for one OpenCode event. */
function common(ev: HookEventModel, ctx: HookContext): LedgerLineCommon {
  const t = ctx.now.toISOString();
  return { v: 1, t, h: 'opencode', sid: ev.sid ?? unknownSid(ctx.cwd, t) };
}

/** `tool.execute.after` → `tool-post` (§9 OpenCode row). */
function toolExecuteAfter(ev: HookEventModel, ctx: HookContext): ToolPostLine {
  const input = ev.input;
  const tool = str(input['tool']) ?? 'unknown';
  const kind = KINDS[tool] ?? 'other';
  const meta = isRecord(input['metadata']) ? input['metadata'] : {};
  const toolIn: LedgerToolInput = {};
  const command = str(meta['command']);
  if (command !== undefined) toolIn.command = command;
  const path = str(meta['filepath']) ?? str(meta['file_path']) ?? str(meta['path']);
  if (path !== undefined) toolIn.path = path;
  const url = str(meta['url']);
  if (url !== undefined) toolIn.url = url;
  // OpenCode's `title` is the command line for bash calls — use it when the metadata has none.
  const title = str(input['title']);
  if (toolIn.command === undefined && kind === 'shell' && title !== undefined) toolIn.command = title;
  const text = str(input['output']) ?? '';
  const base = common(ev, ctx);
  const line: ToolPostLine = {
    ...base,
    e: 'tool-post',
    id: str(input['callID']) ?? str(input['call_id']) ?? fallbackToolId(base.t, tool, toolIn),
    tool,
    kind,
    in: toolIn,
    out: { text, bytes: Buffer.byteLength(text, 'utf8') },
  };
  line.cwd = str(meta['cwd']) ?? ctx.cwd;
  return line;
}

export const dialect: Dialect = {
  harness: 'opencode',
  events: EVENTS,
  parse(event: string, input: unknown, ctx: HookContext): HookEventModel {
    const rec = isRecord(input) ? input : {};
    void ctx;
    return {
      event,
      eventClass: EVENTS[event] ?? 'record',
      input: rec,
      sid: str(rec['sessionID']) ?? str(rec['session_id']) ?? str(rec['sessionId']) ?? null,
    };
  },
  async handle(ev: HookEventModel, ctx: HookContext): Promise<HookOutput> {
    switch (ev.event) {
      case 'tool.execute.after':
        return { stdout: {}, ledgerLines: [toolExecuteAfter(ev, ctx)] };
      case 'session.idle':
        return { stdout: {}, ledgerLines: [{ ...common(ev, ctx), e: 'stop', status: 'completed' }] };
      default:
        return { stdout: {} };
    }
  },
};
