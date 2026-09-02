// Per-rule precision/recall of the claims extractor over the labelled corpus
// (fixtures/claims/corpus.jsonl; ARCHITECTURE §6.2). A corpus line's
// expectations are ground truth: a produced claim no expectation matches is a
// false positive; an expectation no claim matches is a false negative.
//
//   npm run accuracy            → table + `--min 1.0` gate (CI default)
//   node scripts/accuracy.mjs   → table only
//   --min <x>   fail when any rule's precision or recall is below x
//   --dist <dir> use a different compiled tree (development aid)
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
let min = null;
let dist = new URL('../dist/', import.meta.url);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--min') min = Number(args[++i]);
  else if (args[i] === '--dist') dist = pathToFileURL(`${args[++i]}/`);
}

let extractClaims;
try {
  ({ extractClaims } = await import(new URL('claims/extract.js', dist).href));
} catch (err) {
  process.stderr.write(`accuracy: cannot load ${new URL('claims/extract.js', dist).href} — run \`npm run build\` first\n(${err instanceof Error ? err.message : String(err)})\n`);
  process.exit(1);
}

const corpusPath = fileURLToPath(new URL('../fixtures/claims/corpus.jsonl', import.meta.url));
const lines = readFileSync(corpusPath, 'utf8').split('\n').filter((l) => l.trim() !== '');

/** Does this produced claim satisfy the expectation? */
function matches(claim, exp) {
  if (claim.kind !== exp.kind) return false;
  if (claim.polarity !== (exp.polarity ?? 'positive')) return false;
  if (exp.rule !== undefined && claim.rule !== exp.rule) return false;
  for (const [key, value] of Object.entries(exp.fields ?? {})) {
    if (JSON.stringify(claim[key]) !== JSON.stringify(value)) return false;
  }
  return true;
}

const perRule = new Map(); // rule → {tp, fp, fn}
const bump = (rule, key) => {
  const row = perRule.get(rule) ?? { tp: 0, fp: 0, fn: 0 };
  row[key] += 1;
  perRule.set(rule, row);
};

const failures = [];
let lineNo = 0;
for (const raw of lines) {
  lineNo++;
  const rec = JSON.parse(raw);
  const { claims } = extractClaims(rec.text, {
    turnIndex: 0,
    echoHashes: [],
    ledgerPaths: rec.ledgerPaths ?? [],
    cwd: rec.cwd ?? '/repo',
  });
  const used = new Set();
  const missing = [];
  for (const exp of rec.expect) {
    const hit = claims.findIndex((c, i) => !used.has(i) && matches(c, exp));
    if (hit === -1) {
      missing.push(exp);
      bump(exp.rule ?? `(${exp.kind})`, 'fn');
    } else {
      used.add(hit);
      bump(claims[hit].rule, 'tp');
    }
  }
  const extra = claims.filter((_, i) => !used.has(i));
  for (const c of extra) bump(c.rule, 'fp');
  if (missing.length > 0 || extra.length > 0) {
    failures.push({ lineNo, text: rec.text, missing, extra });
  }
}

for (const f of failures) {
  process.stdout.write(`line ${f.lineNo}: ${JSON.stringify(f.text.length > 90 ? `${f.text.slice(0, 90)}…` : f.text)}\n`);
  for (const m of f.missing) process.stdout.write(`  MISSING  ${JSON.stringify(m)}\n`);
  for (const c of f.extra) {
    const view = { kind: c.kind, polarity: c.polarity, rule: c.rule, subject: c.subject, count: c.count, family: c.family, op: c.op, attribution: c.attribution };
    process.stdout.write(`  EXTRA    ${JSON.stringify(view)}\n`);
  }
}

const pct = (n) => (Number.isNaN(n) ? '   —' : `${(n * 100).toFixed(1).padStart(5)}%`);
const rules = [...perRule.keys()].sort();
const width = Math.max(12, ...rules.map((r) => r.length));
process.stdout.write(`\n${'rule'.padEnd(width)}  ${'tp'.padStart(4)} ${'fp'.padStart(3)} ${'fn'.padStart(3)}  precision  recall\n`);
let total = { tp: 0, fp: 0, fn: 0 };
let belowMin = false;
for (const rule of rules) {
  const { tp, fp, fn } = perRule.get(rule);
  total = { tp: total.tp + tp, fp: total.fp + fp, fn: total.fn + fn };
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  if (min !== null && ((tp + fp > 0 && precision < min) || (tp + fn > 0 && recall < min))) belowMin = true;
  process.stdout.write(`${rule.padEnd(width)}  ${String(tp).padStart(4)} ${String(fp).padStart(3)} ${String(fn).padStart(3)}     ${pct(precision)}  ${pct(recall)}\n`);
}
const precision = total.tp / (total.tp + total.fp);
const recall = total.tp / (total.tp + total.fn);
process.stdout.write(`${'TOTAL'.padEnd(width)}  ${String(total.tp).padStart(4)} ${String(total.fp).padStart(3)} ${String(total.fn).padStart(3)}     ${pct(precision)}  ${pct(recall)}\n`);
process.stdout.write(`corpus: ${lines.length} lines, ${failures.length} failing\n`);

if (min !== null && (belowMin || failures.length > 0)) {
  process.stderr.write(`accuracy: FAIL — a rule is below ${min * 100}% or a corpus line mismatches\n`);
  process.exit(1);
}
