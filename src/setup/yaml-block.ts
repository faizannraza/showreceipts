/**
 * The Hermes managed YAML block (S30; §9): showreceipts owns exactly the
 * lines between `# >>> showreceipts >>>` and `# <<< showreceipts <<<` in
 * `~/.hermes/config.yaml`, appended only when the file has no top-level
 * `hooks:` key outside the block and is a single YAML document. Anything
 * else is a manual step (exit 3, snippet printed) — this module never
 * parses YAML and never rewrites foreign lines. Pure text-in/text-out;
 * the fs work lives in `writers/hermes.ts`.
 */

export const HERMES_BLOCK_BEGIN = '# >>> showreceipts >>>';
export const HERMES_BLOCK_END = '# <<< showreceipts <<<';

const TOP_LEVEL_HOOKS_RE = /^hooks\s*:/m;
const MULTI_DOC_RE = /^(---|\.\.\.)\s*$/m;

/** YAML single-quoted scalar (the command strings contain double quotes). */
function yamlSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * The managed block (§9 Hermes row): five events, the launcher referenced by
 * absolute double-quoted path inside a single-quoted YAML scalar (Hermes
 * splits commands with `shlex.split`, so paths with spaces survive). Ends
 * with a trailing newline.
 */
export function hermesBlock(launcherPath: string): string {
  const cmd = (event: string): string => yamlSingleQuote(`"${launcherPath}" hook hermes ${event}`);
  return [
    HERMES_BLOCK_BEGIN,
    'hooks:',
    '  post_tool_call:',
    '    - matcher: ".*"',
    `      command: ${cmd('post_tool_call')}`,
    '      timeout: 10',
    '  post_llm_call:',
    `    - command: ${cmd('post_llm_call')}`,
    '      timeout: 30',
    '  on_session_start:',
    `    - command: ${cmd('on_session_start')}`,
    '      timeout: 5',
    '  on_session_end:',
    `    - command: ${cmd('on_session_end')}`,
    '      timeout: 10',
    '  on_session_finalize:',
    `    - command: ${cmd('on_session_finalize')}`,
    '      timeout: 5',
    HERMES_BLOCK_END,
    '',
  ].join('\n');
}

/** Appends the block, fixing a missing trailing newline first (§9). */
function appendBlock(text: string, block: string): string {
  if (text === '') return block;
  return (text.endsWith('\n') ? text : `${text}\n`) + block;
}

/**
 * Deletes exactly the managed block lines (markers inclusive). `changed` is
 * false when no marker is present. A begin marker without an end marker
 * removes to EOF (a truncated earlier write must not survive a removal).
 */
export function removeHermesBlock(text: string): { changed: boolean; text: string } {
  const lines = text.split('\n');
  const begin = lines.findIndex((line) => line.trimEnd() === HERMES_BLOCK_BEGIN);
  if (begin === -1) return { changed: false, text };
  let end = lines.findIndex((line, i) => i > begin && line.trimEnd() === HERMES_BLOCK_END);
  if (end === -1) end = lines.length - 1;
  lines.splice(begin, end - begin + 1);
  return { changed: true, text: lines.join('\n') };
}

/** The outcome of applying the block to a config text (`null` = missing file). */
export type HermesApply =
  | { kind: 'installed' | 'updated' | 'unchanged'; text: string }
  | { kind: 'manual'; reason: string };

/**
 * Installs (or refreshes) the managed block: multi-document files and files
 * with a top-level `hooks:` outside the block are manual steps; otherwise
 * the block is appended at EOF (replacing an existing block, so a changed
 * launcher path updates in place).
 */
export function applyHermesBlock(text: string | null, block: string): HermesApply {
  const current = text ?? '';
  if (MULTI_DOC_RE.test(current)) {
    return { kind: 'manual', reason: 'multi-document YAML (a ---/... marker line): add the hooks to the right document yourself' };
  }
  const hasBlock = current.includes(HERMES_BLOCK_BEGIN);
  const remainder = hasBlock ? removeHermesBlock(current).text : current;
  if (TOP_LEVEL_HOOKS_RE.test(remainder)) {
    return { kind: 'manual', reason: 'the file already has a top-level `hooks:` key: merge the entries into it yourself' };
  }
  const next = appendBlock(remainder, block);
  if (next === current) return { kind: 'unchanged', text: current };
  return { kind: text === null ? 'installed' : 'updated', text: next };
}
