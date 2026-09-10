// Renders the §6.1 claim rule table (src/claims/rules.ts) as markdown —
// the exact text S33 pastes into docs/claims.md and the README.
//
//   node scripts/gen-claims-doc.mjs           (requires `npm run build`)
//   node scripts/gen-claims-doc.mjs --dist d  (development aid)
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
let dist = new URL('../dist/', import.meta.url);
const flag = args.indexOf('--dist');
if (flag !== -1) dist = pathToFileURL(`${args[flag + 1]}/`);

let RULES;
let RULES_VERSION;
try {
  ({ RULES, RULES_VERSION } = await import(new URL('claims/rules.js', dist).href));
} catch (err) {
  process.stderr.write(`gen-claims-doc: cannot load compiled rules — run \`npm run build\` first\n(${err instanceof Error ? err.message : String(err)})\n`);
  process.exit(1);
}

/** Claim fields each rule produces (kept beside the renderer, not the table). */
const FIELDS = {
  'test.pass': '`{count?}`',
  'test.counts': '`{count}` · short ratio ⇒ negated `{ratio}`',
  'test.gate': '`{count?}` + one check `{family}` per listed tool',
  'test.count_clean': '`{count}`',
  'test.ran': '&#8212;',
  'test.nofail': '&#8212;',
  'test.green_marker': '&#8212;',
  'test.added': '`{count?}`',
  'check.lint': '`{family: lint, tool}`',
  'check.type': '`{family: type, tool}`',
  'check.format': '`{family: format, tool}`',
  'check.build': '`{family: build, tool}`',
  'check.marker': 'test or check `{family}` by word',
  'file.verb': '`{verb, subject, fromPath?, explicitVerb, directObject?}` (one claim per PATH)',
  'file.implemented_in': '`{verb: update, subject}`',
  'file.count': '`{count}`',
  'file.new_file': '`{verb: create, subject}`',
  'command.ran': '`{subject, successPredicate?}`',
  'command.ran_bare': '`{subject}`',
  'install.pkg': '`{subject}`',
  'git.commit': '`{op: commit, sha?}`',
  'git.push': '`{op: push, branch?, remote?}`',
  'git.pr': '`{op: pr, prNumber?}`',
  'git.branch': '`{op: branch, branch}`',
  'git.tag': '`{op: tag, subject}`',
  'nochange.marker': '`{subject?}`',
  'verify.generic': '&#8212;',
  'verify.with_cmd': 'verification + command `{subject, successPredicate}`',
  'done.marker': '&#8212;',
};

/** Escapes a regex source for a markdown table cell (em dash as an entity so the raw docs stay free of U+2014). */
function code(source) {
  const escaped = source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/—/g, '&#8212;');
  return `<code>${escaped}</code>`;
}

const lines = [];
lines.push(`## Claim rules (\`${RULES_VERSION}\`)`);
lines.push('');
lines.push('Rules are tried in table order; a clause can yield several claims. Negation, hedge,');
lines.push('attribution, scoping and temporal cues (§4.7 step 5) apply to every rule.');
lines.push('');
lines.push('| id | kind | trigger | fields | notes |');
lines.push('|---|---|---|---|---|');
for (const rule of RULES) {
  const triggers = rule.triggers.map((t) => code(t.source)).join('<br>');
  const fields = FIELDS[rule.id] ?? '&#8212;';
  lines.push(`| \`${rule.id}\` | ${rule.kind} | ${triggers} | ${fields} | ${rule.notes} |`);
}
lines.push('');
process.stdout.write(`${lines.join('\n')}\n`);
