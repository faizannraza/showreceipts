// S36: generates the ~60 MB synthetic Claude Code transcript tree the perf
// suites parse (§4.10, §14.2). Deterministic (no Math.random, fixed
// timestamps), generated once into os.tmpdir() and reused across runs: the
// tree is keyed by GENERATION version + target size, so a change here lands
// in a fresh directory and stale trees are simply abandoned.
//
//   node scripts/gen-big-transcript.mjs                # ensure, print summary
//   node scripts/gen-big-transcript.mjs --print-path   # ensure, print ONLY the main transcript path
//
// Layout mirrors a CLAUDE_CONFIG_DIR (discover/enumerate.ts):
//   <tmp>/showreceipts-perf/big-tree-<v>-<MB>mb/
//     projects/-home-u-proj/<SID>.jsonl            ~60 MB, 400 turns
//     projects/-home-u-proj/<SID>/subagents/agent-<hex>.jsonl  × 3
import { closeSync, existsSync, mkdirSync, openSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GENERATION = 2;
const TARGET_BYTES = 60 * 1024 * 1024;
// Upper bound; generation stops once TARGET_BYTES is reached, which lands at
// ~400 turns with the ~148 KB per-turn shape below (asserted ≥ 390 by
// test/perf/parse.perf.test.ts).
const TURNS = 440;
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CWD = '/home/u/proj';
const VERSION = '2.1.251';
const MODEL = 'claude-fable-5';
const BASE_MS = Date.UTC(2026, 7, 1, 0, 0, 0); // 2026-08-01T00:00:00Z (fixture window)

const printPathOnly = process.argv.includes('--print-path');

const treeDir = join(tmpdir(), 'showreceipts-perf', `big-tree-${GENERATION}-${Math.round(TARGET_BYTES / 1048576)}mb`);
const projectDir = join(treeDir, 'projects', '-home-u-proj');
const mainPath = join(projectDir, `${SID}.jsonl`);
const subagentsDir = join(projectDir, SID, 'subagents');

/** Deterministic uuid for line `n`. */
function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Monotonic ISO timestamp, one second per line. */
function ts(n) {
  return new Date(BASE_MS + n * 1000).toISOString();
}

/**
 * ~4.6 KB of runner-flavoured stdout for tool result `n`. A tool_result line
 * carries the text twice (message content + `toolUseResult.stdout`, exactly
 * like a real Claude Code transcript), so each result line is ~9.5 KB.
 */
function bigOutput(n) {
  const row = `PASS test/unit/area-${n % 37}/case-${n % 101}.test.ts (${(n % 90) + 10} ms) — assertions held, output stable, no retries `;
  return `${row.repeat(Math.ceil(4600 / row.length))}\n34 passed, 0 failed`;
}

function usage() {
  return {
    input_tokens: 1200,
    output_tokens: 300,
    cache_read_input_tokens: 5000,
    cache_creation_input_tokens: 100,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
    service_tier: 'standard',
  };
}

/** Keys shared by every main-transcript line. */
function common(n, parent, promptId) {
  return {
    parentUuid: parent,
    isSidechain: false,
    ...(promptId === null ? {} : { promptId }),
    uuid: uuid(n),
    timestamp: ts(n),
    userType: 'external',
    cwd: CWD,
    sessionId: SID,
    version: VERSION,
    gitBranch: 'main',
  };
}

function generateMain() {
  mkdirSync(projectDir, { recursive: true });
  const fd = openSync(mainPath, 'w');
  let n = 0;
  let parent = null;
  let bytes = 0;
  const perTurnResults = 14; // × ~10 KB result lines (text embedded twice) ≈ 148 KB/turn → ~400 turns to 60 MB
  const write = (obj) => {
    const line = `${JSON.stringify(obj)}\n`;
    bytes += Buffer.byteLength(line);
    writeSync(fd, line);
    parent = typeof obj.uuid === 'string' ? obj.uuid : parent;
  };
  for (let t = 0; t < TURNS && bytes < TARGET_BYTES; t++) {
    const promptId = `p${t + 1}`;
    write({
      ...common(n++, parent, promptId),
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: `prompt ${t + 1}: run the suite and report the state of the build` }] },
    });
    for (let i = 0; i < perTurnResults; i++) {
      const toolUseId = `toolu_${String(t).padStart(4, '0')}${String(i).padStart(3, '0')}`;
      write({
        ...common(n++, parent, null),
        type: 'assistant',
        requestId: `req_${String(n).padStart(8, '0')}`,
        message: {
          id: `msg_${String(n).padStart(8, '0')}`,
          type: 'message',
          role: 'assistant',
          model: MODEL,
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: `npm test -- --run suite-${i}` } }],
          usage: usage(),
        },
      });
      const out = bigOutput(t * perTurnResults + i);
      write({
        ...common(n++, parent, promptId),
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: out }] }] },
        toolUseResult: { stdout: out, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
      });
    }
    write({
      ...common(n++, parent, null),
      type: 'assistant',
      requestId: `req_${String(n).padStart(8, '0')}`,
      message: {
        id: `msg_${String(n).padStart(8, '0')}`,
        type: 'message',
        role: 'assistant',
        model: MODEL,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: `All 34 tests pass. Updated \`src/area-${t % 37}.ts\`.` }],
        usage: usage(),
      },
    });
  }
  closeSync(fd);
  return { lines: n, bytes };
}

function generateSubagent(k) {
  const agentId = `a${String(k).repeat(16).slice(0, 16)}`;
  const path = join(subagentsDir, `agent-${agentId}.jsonl`);
  const fd = openSync(path, 'w');
  let parent = null;
  for (let i = 0; i < 100; i++) {
    const base = {
      parentUuid: parent,
      isSidechain: true,
      agentId,
      promptId: 'p1',
      uuid: `${String(k)}0000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      timestamp: ts(i),
      userType: 'external',
      cwd: CWD,
      sessionId: SID,
      version: VERSION,
      gitBranch: 'main',
    };
    const obj =
      i % 2 === 0
        ? { ...base, type: 'user', message: { role: 'user', content: [{ type: 'text', text: `subagent ${k} step ${i}` }] } }
        : {
            ...base,
            type: 'assistant',
            message: {
              id: `msg_sub_${k}_${i}`,
              type: 'message',
              role: 'assistant',
              model: MODEL,
              stop_reason: i === 99 ? 'end_turn' : null,
              content: [{ type: 'text', text: `subagent ${k} answer ${i}` }],
              usage: usage(),
            },
          };
    writeSync(fd, `${JSON.stringify(obj)}\n`);
    parent = base.uuid;
  }
  closeSync(fd);
}

let note = 'cached';
if (!existsSync(mainPath) || statSync(mainPath).size < TARGET_BYTES * 0.95) {
  const { lines, bytes } = generateMain();
  mkdirSync(subagentsDir, { recursive: true });
  for (const k of [1, 2, 3]) generateSubagent(k);
  note = `generated ${lines} lines, ${(bytes / 1048576).toFixed(1)} MB`;
}

if (printPathOnly) {
  process.stdout.write(`${mainPath}\n`);
} else {
  process.stdout.write(`gen-big-transcript: ${note}\n${treeDir}\n${mainPath}\n`);
}
