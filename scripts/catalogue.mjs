#!/usr/bin/env node
// Record catalogue generator (PLAN S10, instruction 3). Walks the committed
// redacted fixtures and renders the Appendix A/B-format catalogue — record
// types, system subtypes, attachment types, tool names, `toolUseResult` key
// sets, content-block types (Claude Code) and payload names, versions, models
// (Codex) — with occurrence counts.
//
//   node scripts/catalogue.mjs            print the catalogue to stdout
//   node scripts/catalogue.mjs --write    write docs/catalogue.md (S10 owns it)
//   node scripts/catalogue.mjs --check    diff against docs/catalogue.md; exit 1 on drift
//
// Every value emitted is structural — a type name, a key name, a tool name, a
// model id or a version — never a path, session id or free text; the source is
// the redacted fixture tree only, so the file is safe to commit and to
// link-check (S33). Counts are deterministic (fixtures are frozen), so
// `--write` then `--check` is a fixed point.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COUNT_ONLY_TYPES, fileRoleOf, parseLine, readMaybeGz, splitLines } from './lib/shapes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(ROOT, 'fixtures', 'readers');
const OUT = join(ROOT, 'docs', 'catalogue.md');

function fail(msg) {
  process.stderr.write(`catalogue: ${msg}\n`);
  process.exit(1);
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

/** A counting multiset with sorted rendering. */
function tally() {
  const map = new Map();
  return {
    add(key, n = 1) {
      map.set(key, (map.get(key) ?? 0) + n);
    },
    /** Sorted by count desc, then key asc. */
    entries() {
      return [...map.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    },
    get size() {
      return map.size;
    },
  };
}

/** Collapses masked MCP tool names so no server/product name is emitted. */
function collapseTool(name) {
  return typeof name === 'string' && name.startsWith('mcp__') ? 'mcp__*' : name;
}

/** The `toolUseResult` shape signature of a Claude Code user tool-result line. */
function resultShape(result) {
  if (result === undefined) return 'absent';
  if (typeof result === 'string') return 'string';
  if (Array.isArray(result)) return 'array';
  if (result && typeof result === 'object') return `{${Object.keys(result).sort().join(',')}}`;
  return typeof result;
}

const cc = {
  recordTypes: tally(),
  subtypes: tally(),
  attachments: tally(),
  tools: tally(),
  resultShapes: tally(),
  readTypes: tally(),
  blocks: tally(),
  versions: tally(),
  models: tally(),
  files: 0,
};

const codex = {
  payloadNames: tally(),
  eventTypes: tally(),
  itemTypes: tally(),
  outputGrammar: tally(),
  versions: tally(),
  models: tally(),
  files: 0,
};

function surveyClaudeRecord(r, toolNames) {
  if (!r || typeof r !== 'object') {
    cc.recordTypes.add('(non-object)');
    return;
  }
  const type = typeof r.type === 'string' ? r.type : r.attachment ? 'attachment' : '(untyped)';
  cc.recordTypes.add(type);
  if (typeof r.version === 'string' && (type === 'user' || type === 'assistant')) cc.versions.add(r.version);
  if (type === 'system' && typeof r.subtype === 'string') cc.subtypes.add(r.subtype);
  if (type === 'attachment' && r.attachment && typeof r.attachment.type === 'string') cc.attachments.add(r.attachment.type);
  const msg = r.message;
  if (type === 'assistant' && msg && typeof msg === 'object' && typeof msg.model === 'string') cc.models.add(msg.model);
  if (msg && Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (!b || typeof b !== 'object' || typeof b.type !== 'string') continue;
      cc.blocks.add(b.type);
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        cc.tools.add(collapseTool(b.name));
        if (typeof b.id === 'string') toolNames.set(b.id, collapseTool(b.name));
      }
    }
  }
  if (type === 'user') {
    const blocks = Array.isArray(msg?.content) ? msg.content : [];
    const tr = blocks.find((b) => b && b.type === 'tool_result');
    if (tr !== undefined || r.toolUseResult !== undefined) {
      const tool = (tr && toolNames.get(tr.tool_use_id)) ?? '(unknown)';
      cc.resultShapes.add(`${tool}:${resultShape(r.toolUseResult)}`);
      const t = r.toolUseResult;
      if (tool === 'Read' && t && typeof t === 'object' && typeof t.type === 'string') cc.readTypes.add(t.type);
      if (tr && Array.isArray(tr.content)) for (const b of tr.content) if (b && typeof b.type === 'string') cc.blocks.add(`result:${b.type}`);
    }
  }
}

function codexOutputGrammar(s) {
  if (typeof s !== 'string') return 'non-string';
  if (s.startsWith('Chunk ID:')) return 'unified-header';
  if (s.startsWith('{')) return 'json';
  if (/^Exit code: -?\d+$/m.test(s)) return 'plain-header';
  if (/^(exec_command|write_stdin|shell_command|shell) failed:/.test(s)) return 'failure-prefix';
  return 'other';
}

function surveyCodexRecord(r) {
  if (!r || typeof r !== 'object' || typeof r.type !== 'string') return;
  const p = r.payload && typeof r.payload === 'object' ? r.payload : {};
  if (r.type === 'session_meta' && typeof p.cli_version === 'string') codex.versions.add(p.cli_version);
  if (r.type === 'turn_context' && typeof p.model === 'string') codex.models.add(p.model);
  if (r.type === 'event_msg' && typeof p.type === 'string') codex.eventTypes.add(p.type);
  if (r.type === 'response_item' && typeof p.type === 'string') {
    codex.itemTypes.add(p.type);
    if ((p.type === 'function_call' || p.type === 'custom_tool_call') && typeof p.name === 'string') codex.payloadNames.add(collapseTool(p.name));
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const s = typeof p.output === 'string' ? p.output : Array.isArray(p.output) ? p.output.map((x) => x?.text ?? '').join('') : '';
      codex.outputGrammar.add(codexOutputGrammar(s));
    }
  }
}

function surveyDir(dir, harness) {
  for (const file of walk(dir)) {
    const rel = relative(dir, file);
    const base = rel.split(sep).pop();
    if (base === 'expected.json' || base === 'REDACTION-REVIEW.md' || base.endsWith('.meta.json')) continue;
    if (base === 'session_index.jsonl' || base === 'models_cache.json' || base === 'journal.jsonl' || base === 'journal.jsonl.gz') continue;
    if (!/\.jsonl(\.gz)?$/.test(base)) continue;
    const lines = splitLines(readMaybeGz(file));
    if (harness === 'claude-code') {
      cc.files++;
      const toolNames = new Map();
      const role = fileRoleOf(rel);
      for (const buf of lines) {
        if (buf.length === 0) continue;
        // Count-only records are not parsed by the reader; count the type from a cheap sniff.
        const text = buf.toString('utf8');
        const m = /"type":"([a-z_-]+)"/.exec(text.slice(0, 256));
        if (m && COUNT_ONLY_TYPES.includes(m[1]) && m[1] !== 'ai-title') {
          cc.recordTypes.add(m[1] === undefined ? '(untyped)' : m[1]);
          if (m[1] === 'attachment') {
            const r = parseLine(buf);
            if (r && r.attachment && typeof r.attachment.type === 'string') cc.attachments.add(r.attachment.type);
          }
          continue;
        }
        const r = parseLine(buf);
        if (r === null) continue;
        surveyClaudeRecord(r, toolNames);
        void role;
      }
    } else {
      codex.files++;
      for (const buf of lines) {
        if (buf.length === 0) continue;
        const r = parseLine(buf);
        if (r !== null) surveyCodexRecord(r);
      }
    }
  }
}

/** Every fixture directory (one `expected.json` each). */
function fixtureDirs() {
  if (!existsSync(FIXTURES)) return [];
  return walk(FIXTURES)
    .filter((p) => basename(p) === 'expected.json')
    .map((p) => join(p, '..'));
}

function harnessOf(dir) {
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
  return typeof expected.harness === 'string' ? expected.harness : relative(FIXTURES, dir).startsWith('codex') ? 'codex' : 'claude-code';
}

function renderTally(t) {
  return t.entries().map(([key, n]) => `\`${key}\` ${n}`).join(' · ');
}

function render() {
  for (const dir of fixtureDirs()) surveyDir(dir, harnessOf(dir));
  const lines = [];
  lines.push('# Record catalogue');
  lines.push('');
  lines.push('*Generated by `scripts/catalogue.mjs` from the committed redacted fixtures (`node scripts/catalogue.mjs --write`). Do not edit by hand. Every entry is a structural signature — a record type, system subtype, attachment type, tool name, `toolUseResult` key set, content-block type, Codex payload name, model id or harness version — with its occurrence count across the fixture tree. No path, session id or free text from any session appears here.*');
  lines.push('');
  lines.push('## Claude Code');
  lines.push('');
  lines.push(`Fixture transcripts surveyed: ${cc.files}.`);
  lines.push('');
  lines.push(`**Record types.** ${renderTally(cc.recordTypes)}`);
  lines.push('');
  lines.push(`**System subtypes.** ${renderTally(cc.subtypes)}`);
  lines.push('');
  lines.push(`**Attachment types.** ${renderTally(cc.attachments)}`);
  lines.push('');
  lines.push(`**Tool names.** ${renderTally(cc.tools)}`);
  lines.push('');
  lines.push(`**Content-block types.** ${renderTally(cc.blocks)}`);
  lines.push('');
  lines.push(`**\`toolUseResult\` key sets** (by tool). ${renderTally(cc.resultShapes)}`);
  lines.push('');
  lines.push(`**Read result types.** ${renderTally(cc.readTypes)}`);
  lines.push('');
  lines.push(`**Versions.** ${renderTally(cc.versions)}`);
  lines.push('');
  lines.push(`**Models.** ${renderTally(cc.models)}`);
  lines.push('');
  lines.push('## Codex');
  lines.push('');
  lines.push(`Fixture rollouts surveyed: ${codex.files}.`);
  lines.push('');
  lines.push(`**\`event_msg\` payload types.** ${renderTally(codex.eventTypes)}`);
  lines.push('');
  lines.push(`**\`response_item\` payload types.** ${renderTally(codex.itemTypes)}`);
  lines.push('');
  lines.push(`**Tool / patch payload names.** ${renderTally(codex.payloadNames)}`);
  lines.push('');
  lines.push(`**Output grammars.** ${renderTally(codex.outputGrammar)}`);
  lines.push('');
  lines.push(`**Versions.** ${renderTally(codex.versions)}`);
  lines.push('');
  lines.push(`**Models.** ${renderTally(codex.models)}`);
  lines.push('');
  return lines.join('\n');
}

function main(argv) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write && check) fail('pass at most one of --write / --check');
  const text = render();
  if (write) {
    writeFileSync(OUT, text);
    process.stdout.write(`catalogue: wrote ${relative(ROOT, OUT)} (${text.length} bytes)\n`);
    return;
  }
  if (check) {
    if (!existsSync(OUT)) fail(`${relative(ROOT, OUT)} is missing; run \`node scripts/catalogue.mjs --write\``);
    const committed = readFileSync(OUT, 'utf8');
    if (committed !== text) {
      fail(`${relative(ROOT, OUT)} is out of date; run \`node scripts/catalogue.mjs --write\``);
    }
    process.stdout.write(`catalogue: --check ok (${relative(ROOT, OUT)} matches ${cc.files} + ${codex.files} fixture files)\n`);
    return;
  }
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

main(process.argv.slice(2));
