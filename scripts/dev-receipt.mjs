#!/usr/bin/env node
// Dev receipt printer (PLAN S19, instruction 1). Runs the real pipeline —
// `loadSessions` (cache disabled) → `buildReceipt` — over a single transcript
// file (a real Claude Code main transcript or Codex rollout, read-only) or a
// committed fixture (`fixtures:<id>[/<session-id-prefix>]`), and prints the
// `Receipt` JSON (`--json`) or a crude text listing (claim → verdict →
// reason → evidence), since no renderer exists yet.
//
//   npm run build
//   node scripts/dev-receipt.mjs fixtures:claude-code/2.1.214
//   node scripts/dev-receipt.mjs fixtures:codex/0.98.0/019c45e8
//   node scripts/dev-receipt.mjs ~/.claude/projects/<p>/<sid>.jsonl [--turn N]
//   node scripts/dev-receipt.mjs <path> --as-of 2026-07-15 --json
//
// The input file is never modified: it is copied (fixtures: inflated) into a
// temp tree shaped like the discovery roots, which is deleted on exit. No
// network, no child processes, no git.
//
// "Evidence resolves" (S19 sanity rule): a claim-evidence `EvidenceRef`
// resolves when its `toolCallId`/`seq` names a tool call of the session; for
// the §4.8 absence facts, which deliberately point at the final message,
// when its seq is the receipt turn's `finalSeq` (fallback `seqEnd`); or when
// it names a recorded PR reference (§4.8 row 17 context on an UNVERIFIED
// `git.pr`). Anything else is counted unresolved and reported.
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const FIXTURES = join(ROOT, 'fixtures', 'readers');

function fail(msg) {
  process.stderr.write(`dev-receipt: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let target = null;
let turnIndex;
let asOf;
let json = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--json') json = true;
  else if (a === '--turn') {
    const v = Number(args[++i]);
    if (!Number.isInteger(v)) fail('--turn expects an integer');
    turnIndex = v;
  } else if (a === '--as-of') {
    asOf = args[++i];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf ?? '')) fail('--as-of expects YYYY-MM-DD');
  } else if (a.startsWith('-')) fail(`unknown option ${a}`);
  else if (target === null) target = a;
  else fail('exactly one <path|fixtures:id> expected');
}
if (target === null) {
  fail('usage: dev-receipt.mjs <path|fixtures:<id>[/<session-prefix>]> [--turn N] [--as-of YYYY-MM-DD] [--json]');
}

// ---------------------------------------------------------------------------
// Temp-tree staging
// ---------------------------------------------------------------------------

const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const META_FILES = new Set(['expected.json', 'REDACTION-REVIEW.md']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile()) out.push(p);
  }
  return out.sort();
}

/** Inflates one committed fixture into `<into>/{claude|codex}` (the S03 materialiser, script-side). */
function materializeFixture(fixtureId, into) {
  const dir = join(FIXTURES, ...fixtureId.split('/'));
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
  const harness = expected.harness === 'codex' ? 'codex' : 'claude-code';
  const root = join(into, harness === 'codex' ? 'codex' : 'claude');
  const endedAt = new Date(expected.source?.endedAt ?? '2026-08-01T00:00:00Z');
  const mtime = Number.isNaN(endedAt.getTime()) ? new Date('2026-08-01T00:00:00Z') : endedAt;
  for (const p of walk(dir)) {
    const rel = relative(dir, p);
    if (META_FILES.has(basename(rel))) continue;
    const outPath = join(root, rel.replace(/\.gz$/, ''));
    mkdirSync(dirname(outPath), { recursive: true });
    const bytes = p.endsWith('.gz') ? gunzipSync(readFileSync(p)) : readFileSync(p);
    if (existsSync(outPath) && basename(outPath) === 'session_index.jsonl') appendFileSync(outPath, bytes);
    else writeFileSync(outPath, bytes);
    utimesSync(outPath, mtime, mtime);
  }
  return harness;
}

/** Copies one real transcript (read-only source) into the temp discovery tree. */
function stageRealFile(path, into) {
  const abs = resolve(path);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return fail(`cannot read ${abs}`);
  }
  if (!stat.isFile() || !abs.endsWith('.jsonl')) fail(`${abs} is not a .jsonl transcript`);
  if (ROLLOUT_RE.test(basename(abs))) {
    const dest = join(into, 'codex', 'sessions', basename(abs));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
    return 'codex';
  }
  const sid = basename(abs, '.jsonl');
  const projName = basename(dirname(abs));
  const destDir = join(into, 'claude', 'projects', projName);
  mkdirSync(destDir, { recursive: true });
  copyFileSync(abs, join(destDir, `${sid}.jsonl`));
  const sessionDir = join(dirname(abs), sid);
  if (existsSync(sessionDir) && statSync(sessionDir).isDirectory()) {
    // Only `subagents/` is discovered; siblings (tool-results/, tasks/, …) are never copied.
    const subagents = join(sessionDir, 'subagents');
    if (existsSync(subagents)) cpSync(subagents, join(destDir, sid, 'subagents'), { recursive: true });
  }
  return 'claude-code';
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

const { resolveRoots } = await import(join(DIST, 'discover', 'roots.js'));
const { loadSessions } = await import(join(DIST, 'pipeline', 'run.js'));
const { buildReceipt, receiptToJson } = await import(join(DIST, 'pipeline', 'receipt.js'));
const { loadPriceTable } = await import(join(DIST, 'cost', 'resolve.js'));
const { TOOL_VERSION } = await import(join(DIST, 'version.js'));

const tmp = mkdtempSync(join(tmpdir(), 'showreceipts-dev-receipt-'));
let exitCode = 0;
try {
  let sessionFilter = null;
  let homeDir;
  if (target.startsWith('fixtures:')) {
    let fixtureId = target.slice('fixtures:'.length).replace(/\/+$/, '');
    if (!existsSync(join(FIXTURES, fixtureId, 'expected.json'))) {
      const slash = fixtureId.lastIndexOf('/');
      if (slash === -1) fail(`unknown fixture ${fixtureId}`);
      sessionFilter = fixtureId.slice(slash + 1).toLowerCase();
      fixtureId = fixtureId.slice(0, slash);
      if (!existsSync(join(FIXTURES, fixtureId, 'expected.json'))) fail(`unknown fixture ${fixtureId}`);
    }
    materializeFixture(fixtureId, tmp);
    homeDir = '/home/u'; // fixtures are redacted to this home
  } else {
    stageRealFile(target, tmp);
    homeDir = homedir();
  }
  for (const d of ['claude', 'codex', 'sr']) mkdirSync(join(tmp, d), { recursive: true });

  const roots = resolveRoots(
    { CLAUDE_CONFIG_DIR: join(tmp, 'claude'), CODEX_HOME: join(tmp, 'codex'), SHOWRECEIPTS_HOME: join(tmp, 'sr') },
    homeDir,
  );
  const now = new Date(process.env.SHOWRECEIPTS_NOW ?? Date.now());
  const t0 = performance.now();
  const loaded = await loadSessions({ roots, all: true, noCache: true, versions: { tool: TOOL_VERSION }, now });
  const loadMs = performance.now() - t0;
  for (const problem of loaded.diagnostics.problems) process.stderr.write(`problem: ${problem}\n`);

  let sessions = loaded.sessions;
  if (sessionFilter !== null) sessions = sessions.filter((s) => s.sessionId.toLowerCase().startsWith(sessionFilter));
  if (sessions.length === 0) fail('no session found');

  const prices = loadPriceTable();
  const t1 = performance.now();
  const receipts = sessions.map((s) => ({ session: s, receipt: buildReceipt(s, { now, prices, homeDir, turnIndex, asOf }) }));
  const receiptMs = performance.now() - t1;

  for (const { session, receipt } of receipts) {
    if (json) {
      process.stdout.write(receiptToJson(receipt) + '\n');
      continue;
    }
    printReceipt(session, receipt);
  }
  if (!json) {
    process.stdout.write(`timing: load ${loadMs.toFixed(0)} ms · receipts ${receiptMs.toFixed(0)} ms · ${sessions.length} session(s), ${loaded.scanned.bytes} bytes scanned\n`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(exitCode);

// ---------------------------------------------------------------------------
// Crude text rendering (no renderer exists yet — S20 owns the real one)
// ---------------------------------------------------------------------------

/** The judgement behind a receipt line (identity: `buildLines` passes `j.evidence` as `line.refs`). */
function judgementOf(receipt, line) {
  return receipt.judgements.find((j) => j.evidence === line.refs) ?? null;
}

/** S19 resolution rule for one claim-evidence ref (see the file header; prRef seqs are §4.8 row 17 context). */
function refResolves(ref, session, turn) {
  const byId = ref.toolCallId === undefined ? undefined : session.toolCalls.find((c) => c.id === ref.toolCallId);
  if (byId !== undefined) return byId.seq === ref.seq;
  if (session.toolCalls.some((c) => c.seq === ref.seq)) return true;
  if (session.prRefs.some((p) => p.seq === ref.seq)) return true;
  if (turn !== undefined && ref.seq === (turn.finalSeq ?? turn.seqEnd)) return true;
  return false;
}

function printReceipt(session, receipt) {
  const GLYPHS = { ok: ' OK ', bad: 'BAD ', unk: '?? ', said: '~ ' };
  const out = (s) => process.stdout.write(s + '\n');
  const turn = session.turns.find((t) => t.index === receipt.turnIndex);
  out('='.repeat(72));
  out(`${receipt.harnessLabel} ${receipt.harnessVersion ?? '?'} · ${receipt.shortId} · ${receipt.id}`);
  out(`model ${receipt.model} · cwd ${receipt.cwd} · turn ${receipt.turnIndex} (${receipt.kind}) · ${receipt.startedAt} → ${receipt.endedAt}`);
  out(
    `verdict ${receipt.verdict} · claims recognized: ${receipt.claimsRecognized} · ` +
      `V ${receipt.counts.VERIFIED} / U ${receipt.counts.UNVERIFIED} / C ${receipt.counts.CONTRADICTED} / NS ${receipt.counts.NOT_SCORED} · ` +
      `turnsWithClaims [${receipt.turnsWithClaims.join(', ')}]`,
  );
  if (receipt.kind === 'no-turns') out(`records: ${receipt.records}`);
  if (receipt.lines.length > 0) out('CLAIMED / EVIDENCE:');
  for (const line of receipt.lines) {
    const j = judgementOf(receipt, line);
    out(`  [${GLYPHS[line.glyph] ?? line.glyph}] ${line.claim}`);
    out(`         reason: ${j?.reason ?? '?'}${j !== null && j.integrity !== undefined ? ` · integrity: ${j.integrity}` : ''}`);
    for (const e of line.evidence) out(`         evidence: ${e}`);
    if (line.evidence.length === 0 && (j?.notes.length ?? 0) > 0) out(`         note: ${j.notes.join(' · ')}`);
  }
  if (receipt.alsoSaid.length > 0) {
    out('ALSO SAID (not scored):');
    for (const s of receipt.alsoSaid) out(`  ~ ${s}`);
  }
  if (receipt.alsoDid.length > 0) {
    out('ALSO DID (not mentioned):');
    for (const d of receipt.alsoDid) out(`  ${d.warn === true ? '! ' : '- '}${d.text}`);
  }
  if (receipt.postFinal !== undefined) {
    for (const p of receipt.postFinal) {
      out(
        `after this message: agent ${p.agentId ?? '(main)'} ran ${p.toolCalls} tool calls ` +
          `(${p.files} files, ${p.testRuns} test runs) — not evidence for the claims above`,
      );
    }
  }
  const st = receipt.stats;
  out(
    `stats: ${st.toolCalls} tool calls · ${st.filesChanged} files changed · ${st.testRuns} test runs · ` +
      `${st.compactions} compactions · ${st.subagents} subagents · ${st.apiCalls} api calls · ${st.sentencesScanned} sentences scanned`,
  );
  const c = receipt.cost;
  out(
    `cost: usd ${c.usd === null ? 'n/a' : c.usd.toFixed(6)}${c.unverified ? ' (≈)' : ''} · cacheHitPct ${c.cacheHitPct ?? 'n/a'} · ` +
      `apiCalls ${c.apiCalls} · prices ${c.pricesVersion}${c.asOf !== undefined ? ` as-of ${c.asOf}` : ''}${c.planUsagePct !== undefined ? ` · plan usage ${c.planUsagePct}%` : ''}`,
  );
  if (c.unpriced.length > 0) out(`cost: unpriced models: ${c.unpriced.join(', ')}`);
  for (const note of c.notes) out(`cost note: ${note}`);

  // Claim-evidence resolution (S19 sanity rule).
  let total = 0;
  let unresolved = 0;
  for (const j of receipt.judgements) {
    for (const ref of j.evidence) {
      total += 1;
      if (!refResolves(ref, session, turn)) {
        unresolved += 1;
        out(`UNRESOLVED evidence ref: seq ${ref.seq} label "${ref.label}" (claim ${j.claimId})`);
      }
    }
  }
  out(`evidence refs: ${total} on judgements, ${unresolved} unresolved`);
  if (unresolved > 0) exitCode = 1;
}
