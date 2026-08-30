// Shape signatures for transcripts and fixtures (PLAN S03, instruction 8).
//
// A signature names something a reader branches on — a record type, a system
// subtype, an attachment type, a tool name, a `toolUseResult` key set, a
// content-block type, a Codex payload kind, a hazard — never a value. The
// survey prints the set for a file or a fixture directory; `--compare` asserts
// the real window and its redacted fixture yield equal sets, and `--check`
// asserts `expected.json.shapes ⊆ found`.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** Record types the reader counts without parsing (ARCHITECTURE §4.2.1). */
export const COUNT_ONLY_TYPES = ['mode', 'permission-mode', 'ai-title', 'last-prompt', 'agent-name', 'atis-latch', 'queue-operation', 'attachment', 'file-history-snapshot', 'file-history-delta', 'bridge-session', 'frame-link'];

/** Splits a buffer on 0x0A only (one trailing 0x0D is stripped by the parser, not here). */
export function splitLines(buf) {
  const lines = [];
  let start = 0;
  let i = 0;
  while ((i = buf.indexOf(10, start)) !== -1) {
    lines.push(buf.subarray(start, i));
    start = i + 1;
  }
  if (start < buf.length) lines.push(buf.subarray(start));
  return lines;
}

/** Reads a file, gunzipping when its name ends in `.gz`. */
export function readMaybeGz(path) {
  const raw = readFileSync(path);
  return path.endsWith('.gz') ? gunzipSync(raw) : raw;
}

/** Parses one line buffer; returns `null` on failure. */
export function parseLine(buf) {
  let text = buf.toString('utf8');
  if (text.endsWith('\r')) text = text.slice(0, -1);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Classifies a Claude Code `user` line the way the turn builder does (§4.2.3 step 3). */
export function classifyUserLine(r) {
  const c = r.message?.content;
  const blocks = Array.isArray(c) ? c : null;
  if (blocks && blocks.some((b) => b && b.type === 'tool_result')) return 'tool_result';
  const text = typeof c === 'string' ? c : blocks ? (blocks.find((b) => b && b.type === 'text')?.text ?? '') : '';
  if (blocks && blocks.length > 0 && blocks.every((b) => b && (b.type === 'image' || b.type === 'document'))) return 'attachment-only';
  if (r.interruptedMessageId || text.startsWith('[Request interrupted')) return 'interrupt';
  if (r.isCompactSummary) return 'compact';
  if (r.isMeta || r.turnCompanion) return 'meta';
  if (r.origin?.kind === 'task-notification' || text.startsWith('<task-notification>')) return 'notification';
  if (text.startsWith('<local-command-caveat>') || text.startsWith('<local-command-stdout>')) return 'local-command';
  if (text.startsWith('<command-message>') || text.startsWith('<command-name>')) return 'skill';
  if (text.startsWith('<system-reminder>')) return 'meta';
  return 'human';
}

function resultString(s) {
  if (/^(?:<tool_use_error>)?Error: Exit code/.test(s)) return 'exit-code';
  if (/Permission/.test(s)) return 'permission';
  if (/rejected|doesn't want to proceed/.test(s)) return 'rejected';
  if (/^(?:<tool_use_error>)?Error: Blocked:/.test(s)) return 'blocked';
  if (/InputValidationError/.test(s)) return 'input-validation';
  if (/^<tool_use_error>/.test(s)) return 'tool_use_error';
  if (/^(?:<tool_use_error>)?Error:/.test(s)) return 'error';
  return 'other';
}

function sniffToolFromResult(t) {
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    if ('stdout' in t) return 'Bash';
    if ('structuredPatch' in t) return 'type' in t ? 'Write' : 'Edit';
    if ('file' in t) return 'Read';
    if ('agentId' in t && 'isAsync' in t) return 'Agent';
    if ('runId' in t) return 'Workflow';
  }
  return 'unknown';
}

/**
 * Signatures of one Claude Code record.
 * @param {object} r parsed record
 * @param {{ fileRole: string, toolNames: Map<string, string>, seenUuids: Set<string> }} ctx
 */
export function claudeRecordShapes(r, ctx) {
  const out = [];
  const add = (s) => out.push(s);
  if (!r || typeof r !== 'object' || typeof r.type !== 'string') {
    add('record:invalid');
    return out;
  }
  add(`record:${r.type}`);
  if (r.type === 'system' && typeof r.subtype === 'string') add(`system:${r.subtype}`);
  if (r.type === 'attachment' && typeof r.attachment?.type === 'string') add(`attachment:${r.attachment.type}`);
  if (r.type === 'queue-operation' && typeof r.operation === 'string') add(`queue:${r.operation}`);
  if (typeof r.version === 'string' && (r.type === 'user' || r.type === 'assistant')) add(`version:${r.version}`);
  if (r.type === 'summary' && r.leafUuid) add('flag:legacy-summary');
  if (r.isSidechain === true) add('flag:sidechain');
  if (typeof r.agentId === 'string') add('flag:agentId');
  if (r.isCompactSummary) add('flag:isCompactSummary');
  if (r.isApiErrorMessage) add('flag:isApiErrorMessage');
  if (r.interruptedMessageId) add('flag:interruptedMessageId');
  if (r.toolEndsTurn) add('flag:toolEndsTurn');
  if (typeof r.toolDenialKind === 'string') add(`denial:${r.toolDenialKind}`);
  if (typeof r.logicalParentUuid === 'string') add('flag:logicalParentUuid');
  if (Array.isArray(r.retractedMessageUuids)) add('flag:retractedMessageUuids');
  if (r.type === 'user' && r.promptId === undefined) add('flag:userNoPromptId');
  if (r.type === 'user' && r.parentUuid === null) add('flag:userParentNull');
  if (r.type === 'user' && r.origin?.kind) add(`origin:${r.origin.kind}`);
  if (r.type === 'user' && typeof r.promptSource === 'string') add(`promptSource:${r.promptSource}`);
  if (typeof r.uuid === 'string') {
    if (ctx.seenUuids.has(r.uuid)) add('flag:duplicateUuid');
    ctx.seenUuids.add(r.uuid);
  }
  const msg = r.message;
  if (r.type === 'user') {
    add(`user:${classifyUserLine(r)}`);
    if (r.toolUseResult !== undefined || (Array.isArray(msg?.content) && msg.content.some((b) => b?.type === 'tool_result'))) {
      const blocks = Array.isArray(msg?.content) ? msg.content : [];
      const tr = blocks.find((b) => b?.type === 'tool_result');
      const tool = (tr && ctx.toolNames.get(tr.tool_use_id)) ?? sniffToolFromResult(r.toolUseResult);
      const t = r.toolUseResult;
      // MCP tool names carry server/product names (masked by the redactor), so they collapse like `tool:mcp__*`.
      const sig = typeof tool === 'string' && tool.startsWith('mcp__') ? 'mcp__*' : tool;
      if (t === undefined) add(`result:${sig}:absent`);
      else if (typeof t === 'string') add(`result:${sig}:string`), add(`result-string:${resultString(t)}`);
      else if (Array.isArray(t)) add(`result:${sig}:array`);
      else if (t && typeof t === 'object') add(`result:${sig}:{${Object.keys(t).sort().join(',')}}`);
      else add(`result:${sig}:${typeof t}`);
      if (tr && Array.isArray(tr.content)) for (const b of tr.content) if (b?.type) add(`block:${b.type}`);
      if (tr && tr.is_error === true) add('flag:is_error');
      if (t && typeof t === 'object' && !Array.isArray(t) && typeof t.type === 'string' && tool === 'Read') add(`read:${t.type}`);
      if (t && typeof t === 'object' && !Array.isArray(t) && t.status === 'async_launched') add('agent:async_launched');
    }
  }
  if (r.type === 'assistant' && msg && typeof msg === 'object') {
    if (typeof msg.model === 'string') add(`model:${msg.model}`);
    add(`stop:${msg.stop_reason === null ? 'null' : String(msg.stop_reason)}`);
    if (msg.usage && Array.isArray(msg.usage.iterations)) add('flag:iterations');
    if (msg.usage && msg.usage.iterations && msg.usage.iterations.length > 1) add('flag:iterations>1');
    if (msg.usage && !('cache_creation' in msg.usage)) add('usage:no-cache-breakdown');
    if (msg.usage && msg.usage.output_tokens_details) add('usage:output_tokens_details');
  }
  if (msg && Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (!b || typeof b !== 'object') continue;
      if (typeof b.type === 'string' && b.type !== 'tool_result') add(`block:${b.type}`);
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        add(`tool:${b.name.startsWith('mcp__') ? 'mcp__*' : b.name}`);
        if (typeof b.id === 'string') ctx.toolNames.set(b.id, b.name);
        if (b.input && typeof b.input === 'object') {
          if (b.input.dangerouslyDisableSandbox) add('input:Bash:dangerouslyDisableSandbox');
          if (b.input.run_in_background) add('input:Bash:run_in_background');
          if ((b.name === 'Agent' || b.name === 'Task') && ctx.fileRole !== 'main') add('flag:nestedAgentCall');
        }
      }
    }
  } else if (msg && typeof msg.content === 'string' && r.type !== 'user') {
    add('content:string');
  }
  if (r.type === 'fork-context-ref') add('flag:fork-context-ref');
  return out;
}

function codexOutputGrammar(s) {
  if (typeof s !== 'string') return 'non-string';
  if (s.startsWith('Chunk ID:')) return 'chunk';
  if (s.startsWith('{')) return 'json';
  if (/^Exit code: -?\d+$/m.test(s)) return 'plain-exit';
  if (/^(exec_command|write_stdin|shell_command) failed:/.test(s)) return 'failed:' + s.split(' ')[0];
  return 'other';
}

/** Signatures of one Codex rollout record. */
export function codexRecordShapes(r) {
  const out = [];
  const add = (s) => out.push(s);
  if (!r || typeof r !== 'object' || typeof r.type !== 'string') {
    add('codex:invalid');
    return out;
  }
  add(`codex:${r.type}`);
  const p = r.payload && typeof r.payload === 'object' ? r.payload : {};
  if (r.type === 'session_meta') {
    add(`codex:source:${typeof p.source}`);
    if (p.base_instructions) add('codex:base_instructions');
  }
  if (r.type === 'turn_context') {
    if (p.sandbox_policy?.type) add(`codex:sandbox:${p.sandbox_policy.type}`);
    if (p.collaboration_mode) add('codex:collaboration_mode');
    if (typeof p.git_branch === 'string') add('codex:git_branch');
  }
  if (typeof p.type === 'string') {
    add(`codex:${r.type}:${p.type}`);
    if (p.type === 'message' && typeof p.role === 'string') add(`codex:message:${p.role}`);
    if (p.type === 'message' && typeof p.phase === 'string') add(`codex:phase:${p.phase}`);
    if ((p.type === 'function_call' || p.type === 'custom_tool_call') && typeof p.name === 'string') {
      add(`codex:call:${p.name}`);
      if (typeof p.arguments === 'string') {
        try {
          const a = JSON.parse(p.arguments);
          if (a && typeof a === 'object') {
            add(`codex:args:${p.name}:{${Object.keys(a).sort().join(',')}}`);
            const cmd = a.cmd ?? a.command;
            if (Array.isArray(cmd)) add('codex:command:array');
            if (typeof a.chars === 'string' && a.chars.includes('')) add('codex:write_stdin:interrupt');
          }
        } catch {
          add(`codex:args:${p.name}:unparsable`);
        }
      }
      if (p.name === 'apply_patch' && typeof p.input === 'string') {
        for (const m of p.input.matchAll(/^\*\*\* (Add File|Update File|Delete File|Move to):/gm)) add(`codex:apply_patch:${m[1].split(' ')[0]}`);
      }
    }
    if (p.type === 'function_call_output') {
      const s = typeof p.output === 'string' ? p.output : Array.isArray(p.output) ? p.output.map((x) => x?.text ?? '').join('') : '';
      if (Array.isArray(p.output)) add('codex:output:array');
      add(`codex:output:${codexOutputGrammar(s)}`);
      const exit = /^Process exited with code (-?\d+)$/m.exec(s) ?? /^Exit code: (-?\d+)$/m.exec(s);
      if (exit) add(`codex:exit:${exit[1] === '0' ? '0' : exit[1] === '-1' ? '-1' : 'nonzero'}`);
      if (/^Process running with session ID \d+$/m.test(s)) add('codex:running');
      if (/^Total output lines: \d+$/m.test(s) || /…\d+ tokens truncated…/.test(s)) add('codex:truncated');
      if (/Codex\(Sandbox\(Denied/.test(s)) add('codex:sandbox-denied');
      if (s.startsWith('{')) {
        try {
          const j = JSON.parse(s);
          if (j && typeof j === 'object') add(`codex:output-json:{${Object.keys(j).sort().join(',')}}`);
        } catch {
          add('codex:output-json:unparsable');
        }
      }
    }
    if (p.type === 'custom_tool_call_output' && typeof p.output === 'string') {
      add(`codex:apply_patch_output:${p.output.startsWith('{') ? 'json' : 'plain'}`);
    }
    if (p.type === 'token_count') {
      add(`codex:token_count:${p.info === null ? 'nullinfo' : 'info'}`);
      if (p.rate_limits !== null && p.rate_limits !== undefined) add('codex:rate_limits');
    }
    if (p.type === 'user_message' && typeof p.message === 'string' && p.message.startsWith('# Context from my IDE setup:')) add('codex:user_message:ide-prefix');
    if (p.type === 'reasoning' && typeof p.encrypted_content === 'string') add('codex:reasoning:encrypted');
  }
  return out;
}

/** Hazard/size signatures of one raw line buffer. */
export function lineHazards(buf, text) {
  const out = [];
  if (buf.length >= 1048576) out.push('hazard:line>=1MiB');
  if (text.includes(' ')) out.push('hazard:u2028');
  if (text.includes(' ')) out.push('hazard:u2029');
  if (text.includes('')) out.push('hazard:nel');
  if (text.endsWith('\r')) out.push('hazard:crlf');
  return out;
}

/** Creates an empty survey state. */
export function createSurvey() {
  return {
    sigs: new Set(),
    lines: 0,
    badLines: 0,
    maxLineBytes: 0,
    files: 0,
    toolNames: new Map(),
    seenUuids: new Set(),
  };
}

/**
 * Surveys the lines of one transcript into `state`.
 * @param {Buffer[]} lines
 * @param {'claude-code'|'codex'} harness
 * @param {'main'|'subagent'|'workflow'} fileRole
 */
export function surveyLines(lines, harness, fileRole, state) {
  state.files++;
  state.sigs.add(`file:${harness}:${fileRole}`);
  const ctx = { fileRole, toolNames: state.toolNames, seenUuids: state.seenUuids };
  for (const buf of lines) {
    if (buf.length === 0) continue;
    state.lines++;
    if (buf.length > state.maxLineBytes) state.maxLineBytes = buf.length;
    const text = buf.toString('utf8');
    for (const h of lineHazards(buf, text)) state.sigs.add(h);
    const r = parseLine(buf);
    if (r === null) {
      state.badLines++;
      state.sigs.add('hazard:badLine');
      continue;
    }
    const sigs = harness === 'codex' ? codexRecordShapes(r) : claudeRecordShapes(r, ctx);
    for (const s of sigs) state.sigs.add(s);
    if (fileRole !== 'main' && harness === 'claude-code') {
      for (const s of sigs) if (s.startsWith('record:') || s.startsWith('tool:')) state.sigs.add(`${fileRole}-${s}`);
    }
  }
}

/** Surveys a `.meta.json` sidecar. */
export function surveyMeta(obj, state) {
  state.files++;
  state.sigs.add('file:claude-code:meta');
  if (obj && typeof obj === 'object') {
    if (typeof obj.agentType === 'string') state.sigs.add(`meta:agentType:${obj.agentType}`);
    for (const k of Object.keys(obj)) state.sigs.add(`meta:key:${k}`);
  }
}

/** Surveys a `journal.jsonl` file. */
export function surveyJournal(lines, state) {
  state.files++;
  state.sigs.add('file:claude-code:journal');
  for (const buf of lines) {
    const r = parseLine(buf);
    if (r && typeof r.type === 'string') state.sigs.add(`journal:${r.type}`);
  }
}

/** Role of a transcript file from its relative path. */
export function fileRoleOf(rel) {
  const p = rel.split(sep).join('/');
  if (/\/subagents\/workflows\//.test(p)) return 'workflow';
  if (/\/subagents\//.test(p) || /(^|\/)agent-[0-9a-f]+\.jsonl(\.gz)?$/.test(p)) return 'subagent';
  return 'main';
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile()) out.push(p);
  }
  return out.sort();
}

/**
 * Surveys every transcript-like file under a fixture directory.
 * @param {string} dir
 * @param {'claude-code'|'codex'} harness
 */
export function surveyFixtureDir(dir, harness) {
  const state = createSurvey();
  state.bytes = 0;
  for (const file of walk(dir)) {
    const rel = relative(dir, file);
    const base = rel.split(sep).pop();
    state.bytes += statSync(file).size;
    if (base === 'expected.json' || base === 'REDACTION-REVIEW.md') continue;
    if (base.endsWith('.meta.json')) {
      surveyMeta(JSON.parse(readMaybeGz(file).toString('utf8')), state);
      continue;
    }
    if (base === 'journal.jsonl' || base === 'journal.jsonl.gz') {
      surveyJournal(splitLines(readMaybeGz(file)), state);
      continue;
    }
    if (base === 'session_index.jsonl') {
      state.files++;
      state.sigs.add('file:codex:session_index');
      continue;
    }
    if (base === 'models_cache.json') {
      state.files++;
      state.sigs.add('file:codex:models_cache');
      continue;
    }
    if (!/\.jsonl(\.gz)?$/.test(base)) continue;
    const lines = splitLines(readMaybeGz(file));
    surveyLines(lines, harness, harness === 'codex' ? 'main' : fileRoleOf(rel), state);
  }
  return state;
}

/** Sorted array of a survey's signatures. */
export function sortedSigs(state) {
  return [...state.sigs].sort();
}
