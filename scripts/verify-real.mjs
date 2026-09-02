#!/usr/bin/env node
// Author-only real-data verification (PLAN S10, instruction 5). Parses the
// real Claude Code transcripts and Codex rollouts **in place, read-only**,
// through the built readers in `dist/`, and asserts the §0.3 verification-log
// numbers. Skips cleanly (exit 0) when the real roots are absent — the common
// case on CI and every other machine — so the Validate chain stays green.
//
//   npm run build && npm run verify:real
//
// Never writes, never invokes git, and opens only the transcript/rollout
// files themselves (never `tool-results/`, `tasks/`, `auth.json`, `.env`).
//
// Assertion policy (S10 review; see docs/decisions.md, W1/S10): the live
// Claude Code session keeps growing, so §0.3's aggregate pins that include it
// (26,590 main lines, 440 timestamp regressions, 4,820 `message.id` groups,
// 3 interrupted turns) are not assertable on a live machine. Expectations are
// therefore pinned **per frozen transcript** — the six finished Claude Code
// mains and the two Codex rollouts, whose bytes no longer change — and a
// mismatch on any of them is a FAIL with exit 1 (this script is a gate, not
// just a report). Any other transcript (the live session, or new sessions
// created after the 2026-08-29 snapshot) prints as INFO, never asserted; the
// live-inclusive §0.3 aggregates print as INFO with the snapshot value.
//
// Output tokens are asserted as **two** quantities (docs/decisions.md, W1/S10):
// - "deduped (§0.3 method)": last line with a non-null `stop_reason` per
//   `message.id` group, summing the **top-level** `usage.output_tokens` — the
//   quantity the §0.3/§4.2.7 pin 1,734,118 measures.
// - "billed (§8.3 attempts)": the reader's `Session.usage.output`, which sums
//   billed attempts from `usage.iterations` (else `[usage]`). On the biggest
//   transcript one message's top-level usage is all-zero while its single
//   iteration carries output_tokens 900, hence the pinned +900 (1,735,018);
//   on the 2.1.235 transcript the two refusal-fallback records add +1,500
//   the same way (§8.3 requires the refused attempts to be billed).
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

/**
 * Per-file pins for the six frozen Claude Code main transcripts, keyed by the
 * §0.3 session-id prefix. Values measured 2026-09-02 on the frozen bytes with
 * the byte-level splitter (`readers/jsonl.ts`) and the built reader; they are
 * mutually consistent with every frozen-derivable §0.3 aggregate (0
 * unparseable, max line 1,855,910 B, 22 duplicate uuids, biggest session
 * 4,599,129 raw → 1,734,118 deduped, 0 orphan assistant lines).
 * `interruptedTurns` uses the reader's `Turn.interrupted` flag (S06 instr. 3),
 * which is broader than the §0.3 survey's interrupt-segment count of 3.
 */
const FROZEN_CLAUDE = {
  // 2.1.215+2.1.233
  '3f05da9c': { lines: 2202, badLines: 0, maxLineBytes: 585298, regressions: 61, dupUuids: 0, groups: 302, raw: 1333130, deduped: 495617, billed: 495617, orphans: 0, interrupted: 0 },
  // 2.1.214+2.1.236 — the biggest session (§0.3 raw/deduped pins live here)
  '488dd663': { lines: 11417, badLines: 0, maxLineBytes: 980204, regressions: 180, dupUuids: 22, groups: 2511, raw: 4599129, deduped: 1734118, billed: 1735018, orphans: 0, interrupted: 2 },
  // 2.1.243 (0 assistant lines)
  '91267996': { lines: 13, badLines: 0, maxLineBytes: 702, regressions: 1, dupUuids: 0, groups: 0, raw: 0, deduped: 0, billed: 0, orphans: 0, interrupted: 0 },
  // 2.1.235 (max line 1,855,910 B; two refusal-fallback records → billed = deduped + 1,500)
  'bceb4d10': { lines: 9982, badLines: 0, maxLineBytes: 1855910, regressions: 140, dupUuids: 0, groups: 1604, raw: 3458905, deduped: 1378716, billed: 1380216, orphans: 0, interrupted: 5 },
  // 2.1.234
  'c4c346d4': { lines: 297, badLines: 0, maxLineBytes: 1855876, regressions: 5, dupUuids: 0, groups: 35, raw: 223150, deduped: 98828, billed: 98828, orphans: 0, interrupted: 0 },
  // 2.1.241
  'db935e59': { lines: 2167, badLines: 0, maxLineBytes: 1251528, regressions: 51, dupUuids: 0, groups: 330, raw: 953802, deduped: 376644, billed: 376644, orphans: 0, interrupted: 0 },
};

/** The two frozen Codex rollouts (§0.3), by UUIDv7 prefix. */
const FROZEN_CODEX_PREFIXES = ['019c45e8', '019c4678'];

function out(msg) {
  process.stdout.write(msg + '\n');
}

async function loadReaders() {
  const roots = await import(join(DIST, 'discover', 'roots.js'));
  const cc = await import(join(DIST, 'readers', 'claude-code', 'reader.js'));
  const codex = await import(join(DIST, 'readers', 'codex', 'reader.js'));
  const jsonl = await import(join(DIST, 'readers', 'jsonl.js'));
  return { roots, cc, codex, jsonl };
}

/** Recursively lists files, depth-capped, sorted; missing dir → []. */
function walk(dir, depth = 6) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) files.push(...walk(p, depth - 1));
    } else if (e.isFile()) files.push(p);
  }
  return files;
}

/** Discovers Claude Code **main** transcripts: `projects/<p>/*.jsonl` (non-recursive per project). */
function claudeMainTranscripts(claudeRoot) {
  const projects = join(claudeRoot, 'projects');
  const out = [];
  let dirs;
  try {
    dirs = readdirSync(projects, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const pdir = join(projects, d.name);
    let files;
    try {
      files = readdirSync(pdir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.isFile() && f.name.endsWith('.jsonl') && f.name !== 'journal.jsonl' && !/^agent-/.test(f.name)) {
        out.push(join(pdir, f.name));
      }
    }
  }
  return out.sort();
}

/** Discovers Codex rollouts under `sessions/**` and `archived_sessions/**`. */
function codexRollouts(codexRoot) {
  const found = [];
  for (const base of ['sessions', 'archived_sessions']) {
    for (const p of walk(join(codexRoot, base))) {
      if (/rollout-.*\.jsonl$/.test(basename(p))) found.push(p);
    }
  }
  return found.sort();
}

/**
 * Measures one Claude Code main transcript: physical line stats over EVERY
 * record (sniff off, so count-only types — attachment/mode/… — are parsed
 * too: they carry timestamps, and §0.3 counted regressions across all of
 * them), the §0.3-method output dedupe, and the reader's parse (main-file
 * only — no subagents — matching the §4.2.7 regression pins).
 */
async function measureMainFile(jsonl, cc, path) {
  let maxLine = 0;
  let regressions = 0;
  let dupUuids = 0;
  let raw = 0;
  const messageIds = new Set();
  /** §0.3 dedupe state: key → {out, completed, maxOut}. */
  const plain = new Map();
  const uuids = new Set();
  let lastTs = null;

  const gen = jsonl.readJsonl({ kind: 'file', path }, { sniff: false });
  let step = await gen.next();
  while (!step.done) {
    const line = step.value;
    // §0.3 measured the max line by its on-disk byte size (terminator included).
    if (line.bytes > maxLine) maxLine = line.bytes;
    const r = line.json;
    if (r !== undefined && r !== null && typeof r === 'object') {
      if (typeof r.uuid === 'string') {
        if (uuids.has(r.uuid)) dupUuids++;
        else uuids.add(r.uuid);
      }
      if (typeof r.timestamp === 'string') {
        const ms = Date.parse(r.timestamp);
        if (!Number.isNaN(ms)) {
          if (lastTs !== null && ms < lastTs) regressions++;
          lastTs = ms;
        }
      }
      if (r.type === 'assistant' && r.message && typeof r.message === 'object') {
        const m = r.message;
        if (typeof m.id === 'string') messageIds.add(m.id);
        const u = m.usage;
        const synthetic = m.model === '<synthetic>' || r.isApiErrorMessage === true;
        if (u && typeof u === 'object' && typeof u.output_tokens === 'number' && !synthetic) {
          raw += u.output_tokens;
          const key = (typeof m.id === 'string' ? m.id : undefined) ?? (typeof r.requestId === 'string' ? r.requestId : undefined) ?? r.uuid;
          const stop = m.stop_reason ?? null;
          let g = plain.get(key);
          if (g === undefined) {
            g = { out: 0, completed: false, maxOut: -1 };
            plain.set(key, g);
          }
          if (stop !== null) {
            g.out = u.output_tokens;
            g.completed = true;
          } else if (!g.completed && u.output_tokens >= g.maxOut) {
            g.out = u.output_tokens;
            g.maxOut = u.output_tokens;
          }
        }
      }
    }
    step = await gen.next();
  }
  const summary = step.value;
  let deduped = 0;
  for (const g of plain.values()) deduped += g.out;

  const sessionId = basename(path, '.jsonl');
  const ref = { harness: 'claude-code', sessionId, path, size: statSync(path).size, mtimeMs: 0, subagentManifest: [] };
  const { session } = await cc.readClaudeCodeSession(ref, { home: homedir() });

  return {
    sessionPrefix: sessionId.slice(0, 8),
    lines: summary.lines + summary.badLines,
    badLines: summary.badLines,
    maxLineBytes: maxLine,
    regressions,
    dupUuids,
    groups: messageIds.size,
    raw,
    deduped,
    billed: session.usage.output,
    orphans: session.diagnostics.orphanAssistantLines,
    interrupted: session.turns.filter((t) => t.interrupted).length,
  };
}

/** One expected/observed assertion row (frozen data: must match exactly). */
function row(rows, label, expected, actual) {
  rows.push({ label, expected, actual, pass: expected === actual });
}

function printTable(title, rows) {
  out(`\n${title}`);
  const w = Math.max(...rows.map((r) => r.label.length), 4);
  for (const r of rows) {
    const status = r.pass ? 'PASS' : 'FAIL';
    out(`  ${status}  ${r.label.padEnd(w)}  expected ${String(r.expected).padStart(12)}  observed ${String(r.actual).padStart(12)}`);
  }
}

/** Informational rows: printed, never asserted (live/unknown data). */
function printInfo(title, pairs) {
  out(`\n${title}`);
  const w = Math.max(...pairs.map(([label]) => label.length), 4);
  for (const [label, value] of pairs) {
    out(`  INFO  ${label.padEnd(w)}  observed ${String(value).padStart(12)}`);
  }
}

async function main() {
  const { roots: rootsMod, cc, codex, jsonl } = await loadReaders();
  const env = process.env;
  const roots = rootsMod.resolveRoots(env, homedir());
  const claudeRoot = roots.realpaths.claudeConfigDir ?? roots.claudeConfigDir;
  const codexRoot = roots.realpaths.codexHome ?? roots.codexHome;

  const hasClaude = existsSync(join(claudeRoot, 'projects'));
  const hasCodex = existsSync(join(codexRoot, 'sessions')) || existsSync(join(codexRoot, 'archived_sessions'));
  if (!hasClaude && !hasCodex) {
    out('verify-real: skipped (no real Claude Code or Codex roots on this machine)');
    process.exit(0);
  }

  out('verify-real: parsing real transcripts read-only (§0.3 verification log).');
  out(`  Claude Code root: ${hasClaude ? claudeRoot : '(absent)'}`);
  out(`  Codex root:       ${hasCodex ? codexRoot : '(absent)'}`);

  let allPass = true;

  // ---- Claude Code -------------------------------------------------------
  if (hasClaude) {
    const files = claudeMainTranscripts(claudeRoot);
    const frozen = [];
    const live = [];
    for (const path of files) {
      const m = await measureMainFile(jsonl, cc, path);
      if (Object.prototype.hasOwnProperty.call(FROZEN_CLAUDE, m.sessionPrefix)) frozen.push(m);
      else live.push(m);
    }

    // Per-file assertions over the frozen transcripts.
    const rows = [];
    row(rows, 'frozen main transcripts found', Object.keys(FROZEN_CLAUDE).length, frozen.length);
    for (const m of frozen.sort((a, b) => (a.sessionPrefix < b.sessionPrefix ? -1 : 1))) {
      const pin = FROZEN_CLAUDE[m.sessionPrefix];
      const p = m.sessionPrefix;
      row(rows, `${p} lines`, pin.lines, m.lines);
      row(rows, `${p} unparseable lines`, pin.badLines, m.badLines);
      row(rows, `${p} max line bytes`, pin.maxLineBytes, m.maxLineBytes);
      row(rows, `${p} timestamp regressions`, pin.regressions, m.regressions);
      row(rows, `${p} duplicate uuids`, pin.dupUuids, m.dupUuids);
      row(rows, `${p} message.id groups`, pin.groups, m.groups);
      row(rows, `${p} output raw`, pin.raw, m.raw);
      row(rows, `${p} output deduped (§0.3 method)`, pin.deduped, m.deduped);
      row(rows, `${p} output billed (§8.3 attempts)`, pin.billed, m.billed);
      row(rows, `${p} orphan assistant lines`, pin.orphans, m.orphans);
      row(rows, `${p} interrupted turns (reader flag)`, pin.interrupted, m.interrupted);
    }

    // The frozen-derivable §0.3 aggregates, asserted in the log's own terms.
    const agg = (fn, init) => frozen.reduce(fn, init);
    row(rows, 'frozen unparseable lines', 0, agg((s, m) => s + m.badLines, 0));
    row(rows, 'frozen max line bytes', 1855910, agg((s, m) => Math.max(s, m.maxLineBytes), 0));
    row(rows, 'frozen duplicate uuids', 22, agg((s, m) => s + m.dupUuids, 0));
    row(rows, 'frozen orphan assistant lines', 0, agg((s, m) => s + m.orphans, 0));
    const biggest = frozen.reduce((best, m) => (best === null || m.raw > best.raw ? m : best), null);
    row(rows, 'biggest session output (raw)', 4599129, biggest === null ? -1 : biggest.raw);
    row(rows, 'biggest session output (deduped)', 1734118, biggest === null ? -1 : biggest.deduped);
    printTable(`Claude Code (${frozen.length} frozen transcripts, main-file only; per-file pins):`, rows);
    if (rows.some((r) => !r.pass)) allPass = false;

    // Live / post-snapshot transcripts: informational only.
    for (const m of live) {
      printInfo(`Claude Code ${m.sessionPrefix} (live/post-snapshot; not asserted):`, [
        ['lines', m.lines],
        ['unparseable lines', m.badLines],
        ['timestamp regressions', m.regressions],
        ['message.id groups', m.groups],
        ['output raw / deduped / billed', `${m.raw} / ${m.deduped} / ${m.billed}`],
        ['interrupted turns (reader flag)', m.interrupted],
      ]);
    }

    // §0.3 aggregates that span the live session: snapshot values for context.
    const all = [...frozen, ...live];
    printInfo('§0.3 aggregates spanning the live session (snapshot 2026-08-29; not asserted):', [
      ['main lines (snapshot 26590)', all.reduce((s, m) => s + m.lines, 0)],
      ['timestamp regressions (snapshot 440)', all.reduce((s, m) => s + m.regressions, 0)],
      ['message.id groups (snapshot 4820)', all.reduce((s, m) => s + m.groups, 0)],
      ['interrupted turns (survey counted 3; reader flag is broader)', all.reduce((s, m) => s + m.interrupted, 0)],
    ]);
  }

  // ---- Codex -------------------------------------------------------------
  if (hasCodex) {
    const found = codexRollouts(codexRoot);
    const files = [];
    let extra = 0;
    for (const p of found) {
      const id = (/-([0-9a-f-]{36})\.jsonl$/i.exec(basename(p)) ?? [])[1] ?? basename(p);
      if (FROZEN_CODEX_PREFIXES.some((prefix) => id.startsWith(prefix))) files.push(p);
      else extra++;
    }
    let tokenCountEvents = 0;
    let duplicatedTotals = 0;
    let patches = 0;
    let patchFailures = 0;

    for (const path of files) {
      const gen = jsonl.readJsonl({ kind: 'file', path }, { sniff: false });
      let step = await gen.next();
      let prev = null;
      while (!step.done) {
        const r = step.value.json;
        if (r && typeof r === 'object' && r.type === 'event_msg' && r.payload && r.payload.type === 'token_count') {
          tokenCountEvents++;
          const info = r.payload.info;
          const totals = info && typeof info === 'object' ? info.total_token_usage ?? info.last_token_usage : null;
          const key = totals ? JSON.stringify(totals) : null;
          if (key !== null && key === prev) duplicatedTotals++;
          if (key !== null) prev = key;
        }
        step = await gen.next();
      }
      const sessionId = (/-([0-9a-f-]{36})\.jsonl$/i.exec(basename(path)) ?? [])[1] ?? basename(path);
      const ref = { harness: 'codex', sessionId, path, size: statSync(path).size, mtimeMs: 0, subagentManifest: [] };
      const { session } = await codex.readCodexSession(ref, { home: homedir() });
      const applyPatches = session.toolCalls.filter((c) => c.tool === 'apply_patch');
      patches += applyPatches.length;
      patchFailures += applyPatches.filter((c) => c.isError).length;
    }

    const rows = [];
    row(rows, 'pinned rollouts found', 2, files.length);
    row(rows, 'token_count events', 722, tokenCountEvents);
    row(rows, 'duplicated last_token_usage', 359, duplicatedTotals);
    row(rows, 'apply_patch calls', 28, patches);
    row(rows, 'apply_patch failures', 1, patchFailures);
    printTable('Codex (2 frozen rollouts):', rows);
    if (rows.some((r) => !r.pass)) allPass = false;
    if (extra > 0) printInfo('Codex rollouts outside the §0.3 snapshot (not asserted):', [['rollouts', extra]]);
  }

  out('');
  out(allPass ? 'verify-real: every assertion PASS.' : 'verify-real: FAIL — a frozen transcript no longer matches its pins (frozen bytes cannot drift; suspect a reader change).');
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`verify-real: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  // A broken run must not pass silently: this script gates the frozen pins.
  process.exit(1);
});
