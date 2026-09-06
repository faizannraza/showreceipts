#!/usr/bin/env node
// Accuracy validation (PLAN S35; ARCHITECTURE §14.3, IDEA §5.17).
//
// Two author-only modes over the compiled tree in `dist/`:
//
//   node scripts/label.mjs --real     sample claims + sentences from the local
//                                     real sessions into fixtures/labels/*.jsonl
//                                     (git-ignored; never leaves this machine).
//                                     Exits 0 "skipped" when no real roots exist,
//                                     and never overwrites a file that already
//                                     carries hand labels (delete or --force).
//   node scripts/label.mjs --render   read the hand-labelled JSONL and write
//                                     docs/accuracy.md IN FULL from the template
//                                     below (the §5.4 definition verbatim, the
//                                     precision table with n, coverage per kind,
//                                     the false-positive table, limitations and
//                                     the known-issues section S33 copies into
//                                     the CHANGELOG). Deterministic: two renders
//                                     over the same labelling files are byte-
//                                     identical. Exits 1 when the §14.3 gate
//                                     (CONTRADICTED precision ≥ 95 %) fails.
//
// Options: --seed <n> (default 35), --dir <labels dir>, --dist <dir>, --force.
//
// Labelling workflow (fixtures/labels/README.md): set `label` to
// correct|wrong|unclear per claim row (plus `paraphrase` and `fix` on wrong
// rows), and `label` to "none" or a comma-separated kind list per sentence row.
//
// Read-only over the real roots; writes only fixtures/labels/*.jsonl and
// docs/accuracy.md. No network, no git, no child processes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let mode = null;
let seed = 35;
let labelsDir = join(ROOT, 'fixtures', 'labels');
let dist = new URL('../dist/', import.meta.url);
let force = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--real' || a === '--render') mode = a.slice(2);
  else if (a === '--seed') seed = Number(args[++i]);
  else if (a === '--dir') labelsDir = args[++i];
  else if (a === '--dist') dist = pathToFileURL(`${args[++i]}/`);
  else if (a === '--force') force = true;
  else {
    process.stderr.write(`label: unknown argument ${a}\n`);
    process.exit(2);
  }
}
if (mode === null || Number.isNaN(seed)) {
  process.stderr.write('usage: node scripts/label.mjs --real|--render [--seed <n>] [--dir <labels dir>] [--dist <dir>] [--force]\n');
  process.exit(2);
}

const CLAIMS_FILE = join(labelsDir, 'real-claims.jsonl');
const SENTENCES_FILE = join(labelsDir, 'real-sentences.jsonl');
const DOC_FILE = join(ROOT, 'docs', 'accuracy.md');

/** Sampling targets per verdict (§14.3: ≥30/≥30/≥20/≥10, 100 total). */
const TARGETS = { CONTRADICTED: 30, VERIFIED: 30, UNVERIFIED: 20, NOT_SCORED: 10 };
const SAMPLE_TOTAL = 100;
const SENTENCE_SAMPLE = 50;
const GATE = 0.95;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) — the sample must be reproducible per seed. */
function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded Fisher–Yates over a copy. */
function shuffle(items, rand) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Parses one JSONL file into { meta, rows } (meta = first line with meta:1). */
function readJsonlFile(path) {
  const rows = [];
  let meta = null;
  if (!existsSync(path)) return { meta, rows };
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const rec = JSON.parse(line);
    if (rec.meta === 1) meta = rec;
    else rows.push(rec);
  }
  return { meta, rows };
}

/** True when any data row of the file carries a hand label. */
function hasLabels(path) {
  return readJsonlFile(path).rows.some((r) => r.label !== null && r.label !== undefined);
}

function writeJsonl(path, meta, rows) {
  const lines = [JSON.stringify(meta), ...rows.map((r) => JSON.stringify(r))];
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
}

const pct = (x) => `${(x * 100).toFixed(1)} %`;

// ---------------------------------------------------------------------------
// --real: sample claims and sentences from the local real sessions
// ---------------------------------------------------------------------------

async function loadDist() {
  try {
    const [roots, run, extract, text, reconcile, version, claimRules, reconcileRules, mask] = await Promise.all([
      import(new URL('discover/roots.js', dist).href),
      import(new URL('pipeline/run.js', dist).href),
      import(new URL('claims/extract.js', dist).href),
      import(new URL('claims/text.js', dist).href),
      import(new URL('reconcile/reconcile.js', dist).href),
      import(new URL('version.js', dist).href),
      import(new URL('claims/rules.js', dist).href),
      import(new URL('reconcile/rules.js', dist).href),
      import(new URL('util/mask.js', dist).href),
    ]);
    return { roots, run, extract, text, reconcile, version, claimRules, reconcileRules, mask };
  } catch (err) {
    process.stderr.write(`label: cannot load dist/ — run \`npm run build\` first\n(${err instanceof Error ? err.message : String(err)})\n`);
    process.exit(1);
  }
}

/** Canonical ledger paths for the extractor context (PATH cases b/d). */
function ledgerPathsOf(session) {
  const paths = new Set(session.ledger.filesChanged);
  for (const w of session.ledger.writes) paths.add(w.path);
  return [...paths];
}

async function realMode() {
  const m = await loadDist();
  const env = process.env;
  const roots = m.roots.resolveRoots(env, homedir());
  const claudeRoot = roots.realpaths.claudeConfigDir ?? roots.claudeConfigDir;
  const codexRoot = roots.realpaths.codexHome ?? roots.codexHome;
  const srHome = roots.realpaths.showreceiptsHome ?? roots.showreceiptsHome;
  const hasReal =
    existsSync(join(claudeRoot, 'projects')) ||
    existsSync(join(codexRoot, 'sessions')) ||
    existsSync(join(codexRoot, 'archived_sessions')) ||
    existsSync(join(srHome, 'ledger'));
  if (!hasReal) {
    process.stdout.write('label: skipped (no real Claude Code, Codex or ledger roots on this machine)\n');
    process.exit(0);
  }
  if (!force && (hasLabels(CLAIMS_FILE) || hasLabels(SENTENCES_FILE))) {
    process.stdout.write('label: hand-labelled files already present in fixtures/labels/ — left untouched (delete them or pass --force to resample)\n');
    process.exit(0);
  }

  const now = env.SHOWRECEIPTS_NOW !== undefined && env.SHOWRECEIPTS_NOW !== '' ? new Date(env.SHOWRECEIPTS_NOW) : new Date();
  const { sessions, diagnostics } = await m.run.loadSessions({
    roots,
    all: true,
    noCache: true, // author-only: never write cache entries from this script
    versions: { tool: m.version.TOOL_VERSION },
    now,
  });
  for (const p of diagnostics.problems) process.stderr.write(`label: skipped file: ${p}\n`);

  // --- walk every turn with a final message: claims + judgements ------------
  const candidates = [];
  const sentencePool = new Map(); // sentence text → row (deduped across turns)
  const byHarness = {};
  for (const session of sessions) {
    if (session.kind === 'empty') continue;
    byHarness[session.harness] = (byHarness[session.harness] ?? 0) + 1;
    const ledgerPaths = ledgerPathsOf(session);
    for (const turn of session.turns) {
      if (turn.finalText === null || turn.finalText === '') continue;
      const ex = m.extract.extractClaims(turn.finalText, {
        turnIndex: turn.index,
        echoHashes: turn.echoHashes,
        ledgerPaths,
        cwd: session.cwd,
      });
      const judgements = m.reconcile.reconcile(session, turn.index, ex.claims);
      const byId = new Map(judgements.map((j) => [j.claimId, j]));
      ex.claims.forEach((claim, i) => {
        const j = byId.get(claim.id) ?? judgements[i];
        if (j === undefined) return;
        candidates.push({
          claimId: claim.id,
          harness: session.harness,
          session: session.shortId,
          turn: turn.index,
          kind: claim.kind,
          rule: claim.rule,
          polarity: claim.polarity,
          attribution: claim.attribution,
          verdict: j.verdict,
          reason: j.reason,
          why: j.text,
          evidence: j.evidence.slice(0, 3).map((e) => m.mask.maskSecrets(`${e.label} @ ${e.at}`)),
          sentence: m.mask.maskSecrets(claim.sentence),
          label: null,
          note: '',
        });
      });
      for (const s of m.text.sentences(turn.finalText)) {
        if (sentencePool.has(s)) continue;
        const kinds = [...new Set(ex.claims.filter((c) => c.sentence === s).map((c) => c.kind))].sort();
        sentencePool.set(s, {
          id: `s${sentencePool.size + 1}`,
          harness: session.harness,
          session: session.shortId,
          turn: turn.index,
          sentence: m.mask.maskSecrets(s),
          recognisedKinds: kinds,
          label: null,
          note: '',
        });
      }
    }
  }

  // --- stratified, seeded claim sample --------------------------------------
  const stable = (a, b) =>
    a.harness < b.harness ? -1 : a.harness > b.harness ? 1 :
    a.session < b.session ? -1 : a.session > b.session ? 1 :
    a.turn !== b.turn ? a.turn - b.turn :
    a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0;
  candidates.sort(stable);
  const rand = mulberry32(seed);
  const byVerdict = { CONTRADICTED: [], VERIFIED: [], UNVERIFIED: [], NOT_SCORED: [] };
  for (const c of candidates) byVerdict[c.verdict]?.push(c);
  const picked = [];
  const pickedKeys = new Set();
  const keyOf = (c) => `${c.harness}:${c.session}:${c.turn}:${c.claimId}`;
  const take = (pool, n) => {
    for (const c of shuffle(pool, rand)) {
      if (picked.length >= SAMPLE_TOTAL || n <= 0) break;
      const k = keyOf(c);
      if (pickedKeys.has(k)) continue;
      pickedKeys.add(k);
      picked.push(c);
      n--;
    }
  };
  const available = Object.fromEntries(Object.entries(byVerdict).map(([v, list]) => [v, list.length]));
  for (const [verdict, target] of Object.entries(TARGETS)) take(byVerdict[verdict], target);
  take(candidates, SAMPLE_TOTAL - picked.length); // top-up across every verdict

  // --- seeded sentence sample (recognised and unrecognised halves) ----------
  const allSentences = [...sentencePool.values()];
  const recognised = allSentences.filter((s) => s.recognisedKinds.length > 0);
  const unrecognised = allSentences.filter((s) => s.recognisedKinds.length === 0);
  const sentenceSample = [];
  const sentTake = (pool, n) => {
    for (const s of shuffle(pool, rand)) {
      if (sentenceSample.length >= SENTENCE_SAMPLE || n <= 0) break;
      if (sentenceSample.includes(s)) continue;
      sentenceSample.push(s);
      n--;
    }
  };
  sentTake(recognised, Math.floor(SENTENCE_SAMPLE / 2));
  sentTake(unrecognised, SENTENCE_SAMPLE - sentenceSample.length);
  sentTake(allSentences, SENTENCE_SAMPLE - sentenceSample.length);

  // --- write the two labelling files ----------------------------------------
  mkdirSync(labelsDir, { recursive: true, mode: 0o700 });
  const rules = `${m.claimRules.RULES_VERSION}+${m.reconcileRules.RECONCILE_RULES_VERSION}`;
  const sampledAt = now.toISOString();
  writeJsonl(CLAIMS_FILE, {
    meta: 1,
    kind: 'claims',
    sampledAt,
    tool: m.version.TOOL_VERSION,
    rules,
    seed,
    sessions: sessions.length,
    byHarness,
    candidates: candidates.length,
    available,
    targets: TARGETS,
    sampled: picked.length,
  }, picked);
  writeJsonl(SENTENCES_FILE, {
    meta: 1,
    kind: 'sentences',
    sampledAt,
    tool: m.version.TOOL_VERSION,
    rules,
    seed,
    sessions: sessions.length,
    byHarness,
    candidates: allSentences.length,
    sampled: sentenceSample.length,
  }, sentenceSample);

  process.stdout.write(`label: sampled ${picked.length} claims (of ${candidates.length} candidates) and ${sentenceSample.length} sentences (of ${allSentences.length}) from ${sessions.length} real sessions\n`);
  for (const [verdict, list] of Object.entries(byVerdict)) {
    const got = picked.filter((c) => c.verdict === verdict).length;
    process.stdout.write(`  ${verdict.padEnd(12)} sampled ${String(got).padStart(3)} of ${list.length} available (target ${TARGETS[verdict]})\n`);
  }
  process.stdout.write(`label: now hand-label ${CLAIMS_FILE} and ${SENTENCES_FILE} (see fixtures/labels/README.md), then run --render\n`);
}

// ---------------------------------------------------------------------------
// --render: docs/accuracy.md, wholly from the template below
// ---------------------------------------------------------------------------

/** ARCHITECTURE §5.4, verbatim — published with the numbers per IDEA §5.17. */
const DEFINITION_5_4 = `- **Denominator**: done turns = human/skill turns with an \`end_turn\` final containing ≥ 1 scored claim or a completion marker (\`doneTurnsByTrigger {claims, markerOnly}\`); \`byTrigger {human, notification}\` records whether the final followed a task notification. Turns without claims are \`turns\`, not \`doneTurns\`.
- **Numerators**: \`contradictedTurns\`, \`unverifiedTurns\` (none contradicted and ≥ 1 UNVERIFIED, or marker-only), \`cleanTurns\` (all scored claims VERIFIED, ≥ 1).
- **Grouping**: model (dominant model of the turn by output tokens) × harness × \`Turn.harnessVersion\` (full; HTML collapses to \`2.1.x\`). Effects-only ledger sessions and \`ledgerCoverage:'partial'\` sessions are excluded and counted in \`ledgerIncompleteSessions\`; Copilot turns with a parsed transcript final and Hermes turns with \`post_llm_call\` text are included.
- **Display**: "\`<contradicted> of <done> done turns contradicted (<pct>%)\`"; percentage hidden below 10 done turns (\`—  (3 of 4)\`); \`testRunRate\` = sessions with ≥ 1 test run / sessions; \`costPerDoneTurnUsd\` median/mean (null for ledger sessions). Definition published verbatim in \`docs/accuracy.md\`.`;

/**
 * Per-verdict labelled counts. A wrong row carrying `resolvedIn` (the mis-
 * verdict is already fixed by a rules bump) leaves the precision denominator
 * but stays in the false-positive table and the known-issues section.
 */
function tally(rows, verdict) {
  const labelled = rows.filter((r) => r.verdict === verdict);
  const count = (l) => labelled.filter((r) => r.label === l).length;
  const correct = count('correct');
  const wrongAll = count('wrong');
  const resolved = labelled.filter((r) => r.label === 'wrong' && r.resolvedIn !== undefined).length;
  const wrong = wrongAll - resolved;
  const unclear = count('unclear');
  const unlabelled = labelled.filter((r) => r.label === null || r.label === undefined).length;
  const n = correct + wrong;
  return { sampled: labelled.length, correct, wrong, resolved, unclear, unlabelled, n, precision: n > 0 ? correct / n : null };
}

/** `label` of a sentence row → Set of kinds a human called ('none' → empty). */
function humanKinds(row) {
  if (row.label === null || row.label === undefined || row.label === 'none') return new Set();
  return new Set(String(row.label).split(',').map((k) => k.trim()).filter((k) => k !== '' && k !== 'none'));
}

function renderMode() {
  const claims = readJsonlFile(CLAIMS_FILE);
  const sents = readJsonlFile(SENTENCES_FILE);
  if (claims.meta === null || sents.meta === null) {
    process.stderr.write(`label: no labelling files under ${labelsDir} — run \`node scripts/label.mjs --real\` (author machine) first\n`);
    process.exit(1);
  }
  const meta = claims.meta;
  const verdicts = ['CONTRADICTED', 'VERIFIED', 'UNVERIFIED', 'NOT_SCORED'];
  const stats = Object.fromEntries(verdicts.map((v) => [v, tally(claims.rows, v)]));
  const unlabelledTotal = claims.rows.filter((r) => r.label === null || r.label === undefined).length;

  // --- coverage per kind over the labelled sentence sample ------------------
  const labelledSents = sents.rows.filter((r) => r.label !== null && r.label !== undefined);
  const kinds = new Set();
  for (const r of labelledSents) for (const k of humanKinds(r)) kinds.add(k);
  const coverage = [...kinds].sort().map((kind) => {
    const human = labelledSents.filter((r) => humanKinds(r).has(kind));
    const recognised = human.filter((r) => r.recognisedKinds.includes(kind));
    return { kind, human: human.length, recognised: recognised.length };
  });
  const humanAny = labelledSents.filter((r) => humanKinds(r).size > 0);
  const recognisedAny = humanAny.filter((r) => r.recognisedKinds.length > 0);
  const extraRecognised = labelledSents.filter((r) => humanKinds(r).size === 0 && r.recognisedKinds.length > 0);

  // --- false positives -------------------------------------------------------
  const wrongs = claims.rows.filter((r) => r.label === 'wrong');

  // --- gate ------------------------------------------------------------------
  const contra = stats.CONTRADICTED;
  const gateEvaluated = contra.n > 0 || contra.resolved > 0;
  const byDemotion = contra.n === 0 && contra.resolved > 0;
  const gatePass = !gateEvaluated || byDemotion || (contra.precision ?? 0) >= GATE;
  const resolvedVersions = [...new Set(claims.rows.filter((r) => r.resolvedIn !== undefined).map((r) => String(r.resolvedIn)))].sort();

  const harnesses = Object.entries(meta.byHarness ?? {}).map(([h, n]) => `${n} ${h}`).join(', ');
  const fmtP = (t) => (t.precision === null ? '—' : pct(t.precision));
  const verdictRows = verdicts.map((v) => {
    const t = stats[v];
    return `| ${v} | ${t.sampled} | ${t.correct} | ${t.wrong} | ${t.resolved} | ${t.unclear} | ${fmtP(t)} (n = ${t.n}) |`;
  });
  const coverageRows = coverage.map((c) => `| ${c.kind} | ${c.human} | ${c.recognised} | ${c.human > 0 ? pct(c.recognised / c.human) : '—'} |`);
  const fpRows = wrongs.map((r) =>
    `| \`${r.rule}\` | ${r.verdict} | ${r.paraphrase ?? '(paraphrase pending)'} | ${r.fix ?? '(fix pending)'} |`
  );

  const knownIssues = [];
  if (!gatePass) {
    knownIssues.push(`- **CONTRADICTED precision gate failed** (${fmtP(contra)} < 95 %): the offending reconcile row must be demoted to UNVERIFIED and \`RULES_VERSION\` bumped (§14.3) before launch.`);
  }
  if (byDemotion) {
    knownIssues.push(`- **The §14.3 gate was met by demotion.** Both sampled CONTRADICTED verdicts were false positives under \`${meta.rules}\`: a possessive path ("removed \`x.py\`'s … check") judged as a file delete, and a hypothetical no-change marker judged against the turn's writes. \`${resolvedVersions.join(', ')}\` demotes the two offending reconcile rows (row 9 edited-not-deleted with a direct object; row 21 path-less writes-despite-no-change) to UNVERIFIED, and both shapes are pinned in \`fixtures/claims/corpus.jsonl\` (tag \`fp\`). Carried into the CHANGELOG by S33.`);
  }
  for (const r of wrongs) {
    const closer = r.resolvedIn !== undefined ? ` (resolved in \`${r.resolvedIn}\`)` : '';
    knownIssues.push(`- \`${r.rule}\` produced a wrong ${r.verdict} verdict in the hand-labelled sample: ${r.paraphrase ?? '(paraphrase pending)'} — ${r.fix ?? '(fix pending)'}${closer}.`);
  }
  const unclearTotal = verdicts.reduce((s, v) => s + stats[v].unclear, 0);
  if (unclearTotal > 0) {
    knownIssues.push(`- ${unclearTotal} sampled claim${unclearTotal === 1 ? ' was' : 's were'} labelled *unclear* (the transcript alone cannot settle them); they are excluded from every precision denominator above.`);
  }
  knownIssues.push('- Coverage is intentionally partial: the extractor recognises the §6.1 grammar only, so the receipt carries the recognized-claim count (always in the JSON and Markdown surfaces) and never implies it scored everything the final message asserted (the coverage table above quantifies the gap on this sample).');
  knownIssues.push('- Persisted tool outputs and interpreter-written files are invisible to the ledger (see "Known limitations"); claims that depend on them stay UNVERIFIED rather than risking a false CONTRADICTED.');

  const doc = `# Accuracy

*How often \`showreceipts\` is right when it scores a claim — measured, not asserted.*

Every number below is computed by \`node scripts/label.mjs --render\` from a
hand-labelled sample of the author's own real sessions. The labelling files
(\`fixtures/labels/*.jsonl\`) are **git-ignored and never leave the author's
machine**; this page carries only aggregates, rule ids and short paraphrases.
Re-running \`--render\` over the same labelling files reproduces this file
byte for byte.

- Rules version: \`${meta.rules}\` at sampling time${resolvedVersions.length > 0 ? ` (current: \`${resolvedVersions.join(', ')}\` after the demotions below)` : ''} · tool \`${meta.tool}\`
- Sample: ${meta.sampled} claims (of ${meta.candidates} candidates) and ${sents.meta.sampled} sentences (of ${sents.meta.candidates}), drawn ${String(meta.sampledAt).slice(0, 10)} with seed ${meta.seed} from ${meta.sessions} local sessions (${harnesses})
- Verdicts available in the pool: ${verdicts.map((v) => `${meta.available?.[v] ?? '?'} ${v}`).join(', ')}

## The definition (ARCHITECTURE §5.4, verbatim)

The receipt's headline number is the **false-done rate**. Its exact definition:

${DEFINITION_5_4}

## Hand-labelled verdict precision

One row per verdict over the stratified sample (targets ${TARGETS.CONTRADICTED}/${TARGETS.VERIFIED}/${TARGETS.UNVERIFIED}/${TARGETS.NOT_SCORED}).
A label of *correct* means the verdict is right for the sentence given the
session's tool log; *unclear* rows are excluded from the precision denominator.

| verdict | sampled | correct | wrong | resolved | unclear | precision |
|---|---|---|---|---|---|---|
${verdictRows.join('\n')}

*wrong* counts unresolved mis-verdicts; *resolved* counts mis-verdicts already
fixed by a rules bump — they leave the precision denominator but stay in the
false-positive table below.

**Gate (§14.3): CONTRADICTED precision ≥ 95 % — ${gateEvaluated ? (byDemotion ? `PASS by demotion (${contra.resolved} sampled false positive${contra.resolved === 1 ? '' : 's'}, all demoted in \`${resolvedVersions.join(', ')}\`; no unresolved CONTRADICTED error remains)` : gatePass ? `PASS at ${fmtP(contra)}` : `FAIL at ${fmtP(contra)}`) : 'not evaluated (no labelled CONTRADICTED rows)'}.**
${unlabelledTotal > 0 ? `\n> ${unlabelledTotal} sampled claim(s) are still unlabelled and count nowhere above.\n` : ''}
## Coverage per kind (50-sentence sample)

Precision says the claims we score are judged correctly; coverage asks the
opposite question — of the sentences a human reader would call a claim, how
many did the extractor recognise at all? Labelled over ${labelledSents.length} sampled
sentences (${humanAny.length} human-called claims, ${recognisedAny.length} of them recognised${extraRecognised.length > 0 ? `; ${extraRecognised.length} recognised sentence(s) the human called no claim` : ''}).

| kind | human-called | recognised | coverage |
|---|---|---|---|
${coverageRows.length > 0 ? coverageRows.join('\n') : '| — | 0 | 0 | — |'}
| **any kind** | **${humanAny.length}** | **${recognisedAny.length}** | **${humanAny.length > 0 ? pct(recognisedAny.length / humanAny.length) : '—'}** |

Coverage is deliberately conservative: the receipt always carries the
recognized-claim count (JSON `claimsRecognized`; the Markdown export and the
terminal no-claims box print it) and never implies it scored every assertion.

## False positives observed

Every sampled claim labelled *wrong*, the rule that misfired, and the fix.
Sentences are paraphrased — no session text is reproduced here.

${fpRows.length > 0 ? `| rule | verdict | what the sentence said (paraphrased) | fix |\n|---|---|---|---|\n${fpRows.join('\n')}` : '_None in this sample._'}

## Known limitations

- **Persisted tool outputs are never read.** v1 never opens
  \`<sessionId>/tool-results/\` (the §13.1 privacy boundary), so evidence that
  exists only in a persisted output file — a test summary too large for the
  transcript, say — is invisible. Affected claims stay UNVERIFIED; a
  \`--read-persisted\` opt-in is a v1.1 candidate.
- **Interpreter writes are inferred, not observed.** A file written by a
  Python/Node script the agent ran (rather than by an edit tool or a shell
  redirect) leaves no write record. The ledger flags such commands as opaque
  write-capable, and file claims resolve to UNVERIFIED
  \`write-not-observable\` instead of a false CONTRADICTED.
- **Absence is never contradiction.** The precision doctrine (§1) means an
  incomplete ledger degrades would-be contradictions to UNVERIFIED
  \`ledger-incomplete\`; hand labels below reflect that doctrine.
- **Historical audits cannot re-run anything.** Verdicts are reconciled
  against what the session actually logged; a claim true in the world but
  unexercised in the log is UNVERIFIED, not VERIFIED.

## Known issues

${knownIssues.join('\n')}
`;

  writeFileSync(DOC_FILE, doc);
  process.stdout.write(`label: wrote docs/accuracy.md (${doc.split('\n').length} lines)\n`);
  for (const v of verdicts) {
    const t = stats[v];
    process.stdout.write(`  ${v.padEnd(12)} sampled ${String(t.sampled).padStart(3)}  correct ${String(t.correct).padStart(3)}  wrong ${String(t.wrong).padStart(2)}  resolved ${String(t.resolved).padStart(2)}  unclear ${String(t.unclear).padStart(2)}  precision ${t.precision === null ? '  —' : pct(t.precision)}\n`);
  }
  if (!gatePass) {
    process.stderr.write(`label: GATE FAIL — CONTRADICTED precision ${fmtP(contra)} < 95 % (demote the offending row per §14.3)\n`);
    process.exit(1);
  }
  if (byDemotion) {
    process.stdout.write(`label: gate PASS by demotion — ${contra.resolved} sampled CONTRADICTED false positive(s) resolved in ${resolvedVersions.join(', ')}\n`);
  } else {
    process.stdout.write(gateEvaluated ? `label: gate PASS — CONTRADICTED precision ${fmtP(contra)} (n = ${contra.n})\n` : 'label: gate not evaluated (no labelled CONTRADICTED rows)\n');
  }
}

// ---------------------------------------------------------------------------

if (mode === 'real') {
  await realMode();
} else {
  renderMode();
}
