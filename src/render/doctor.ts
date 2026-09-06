/**
 * Text rendering of a `DoctorReport` (§12.3 shape, S20 instruction 5):
 * roots, per-harness rows, the hook table, ledger counters, price warnings,
 * cache size, then warnings and problems. Unboxed lines, each at most
 * `cols − 2` columns; problems are painted `bad`, warnings `warn`. Pure —
 * the doctor command gathers, this module only formats.
 *
 * Layout discipline (Pass 3): status facts come FIRST on harness/hook rows —
 * they are what doctor exists to show — and the config/root path comes last,
 * `~`-abbreviated and middle-truncated to the remaining budget, so a long
 * path can never push `installed`/`not installed` off an 80-column screen.
 * Warnings and problems word-wrap onto indented continuation lines instead
 * of being cut mid-sentence.
 */
import type { DoctorHarnessReport, DoctorHookReport, DoctorReport } from '../model/types.js';
import { paint } from '../util/ansi.js';
import { DEFAULT_TMP_ROOTS, displayPath } from '../util/paths.js';
import { sanitizeForCell } from '../util/sanitize.js';
import { displayWidth, padEnd, truncateToWidth, wrapToWidth } from '../util/width.js';
import { middleTruncatePath } from './box.js';
import { glyphSet, transliterate } from './glyphs.js';

/** Options of {@link renderDoctor}. */
export interface DoctorOptions {
  cols: number;
  unicode: boolean;
  color?: boolean | undefined;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** `512 B`, `12.3 KB`, `4.0 MB`. */
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One harness row's status facts (path is appended last by the caller). */
function harnessStatus(h: DoctorHarnessReport): string[] {
  if (!h.found) return ['not found'];
  const parts = [plural(h.sessions, 'session'), fmtBytes(h.bytes)];
  if (h.versions.length > 0) parts.push(`versions ${h.versions.map(sanitizeForCell).join(', ')}`);
  if (h.installedVersion !== null) parts.push(`installed ${sanitizeForCell(h.installedVersion)}`);
  if (h.badLines > 0) parts.push(`${plural(h.badLines, 'bad line')}`);
  if (h.hooksDisabled === true) parts.push('hooks disabled');
  return parts;
}

/** One hook row's status facts (scope + path appended last by the caller). */
function hookStatus(h: DoctorHookReport): string[] {
  const parts = [h.installed ? 'installed' : 'not installed'];
  if (h.disabled) parts.push('disabled');
  if (h.strict) parts.push('strict');
  if (h.resolvable === false) parts.push('not resolvable');
  if (h.trusted === false) parts.push('untrusted');
  if (h.configReadable === false) parts.push('config unreadable');
  if (h.otherStopHooks.length > 0) parts.push(`${plural(h.otherStopHooks.length, 'other stop hook')}`);
  return parts;
}

/**
 * Renders the doctor report as terminal lines. Sections: node · roots ·
 * harnesses · hooks · ledgers · prices · cache · warnings · problems.
 * Every line's display width is at most `cols − 2`.
 */
export function renderDoctor(report: DoctorReport, opts: DoctorOptions): string[] {
  const g = glyphSet(opts.unicode);
  const color = opts.color === true;
  const budget = Math.max(40, Math.min(opts.cols, 200)) - 2;
  const sep = g.unicode ? ' · ' : ' - ';
  const tlx = (s: string): string => (g.unicode ? s : transliterate(s));
  const home = report.roots.userHome;
  /**
   * Home first (`~/…`), then a temp-root prefix (`(tmp)/…`), then raw. The
   * roots section used to print raw absolute paths: harmless on a laptop,
   * but a doctor screen shared with `--home-dir` masking leaked the real
   * temp-tree path on Linux (short `/tmp/…` paths survived the width
   * truncation that hid the same leak under macOS's long `/var/folders/…`).
   */
  const maskPath = (path: string): string => {
    const homed = displayPath(path, home);
    if (homed !== path) return homed;
    for (const root of DEFAULT_TMP_ROOTS) {
      if (path === root || path.startsWith(`${root}/`)) return `(tmp)${path.slice(root.length)}`;
    }
    return path;
  };
  const out: string[] = [];
  const push = (line: string): void => {
    out.push(displayWidth(line) > budget ? truncateToWidth(line, budget, g.ellipsis) : line);
  };
  /** Status facts first, then the path fitted into whatever room remains (min 16 columns). */
  const statusRow = (label: string, labelW: number, status: readonly string[], path: string): string => {
    const prefix = `  ${padEnd(label, labelW)} ${tlx(status.join(sep))}${tlx(sep)}`;
    const room = budget - displayWidth(prefix);
    const display = sanitizeForCell(maskPath(path));
    const fitted = displayWidth(display) <= room ? display : middleTruncatePath(display, Math.max(16, room), g.ellipsis);
    return `${prefix}${fitted}`;
  };
  /** Word-wrapped, glyph-prefixed note (warnings/problems); continuations indent under the text. */
  const noteLines = (glyph: string, text: string): string[] => {
    const wrapped = wrapToWidth(tlx(sanitizeForCell(text)), Math.max(20, budget - 4), 99);
    return wrapped.map((line, i) => (i === 0 ? `  ${glyph} ${line}` : `    ${line}`));
  };

  push(`node ${sanitizeForCell(report.node.version)} ${sanitizeForCell(report.node.platform)}`);

  push('');
  push('roots');
  const roots: readonly [string, string][] = [
    ['showreceipts', report.roots.showreceiptsHome],
    ['claude', report.roots.claudeConfigDir],
    ['codex', report.roots.codexHome],
    ['home', report.roots.userHome],
  ];
  for (const [name, path] of roots) push(`  ${padEnd(name, 13)} ${sanitizeForCell(maskPath(path))}`);

  push('');
  push('harnesses');
  const labelW = Math.min(14, Math.max(...report.harnesses.map((h) => displayWidth(h.harness)), 7));
  for (const h of report.harnesses) push(statusRow(h.harness, labelW, harnessStatus(h), h.root));
  if (report.harnesses.length === 0) push('  none');

  push('');
  push('hooks');
  for (const h of report.hooks) push(statusRow(h.harness, labelW, hookStatus(h), `(${h.scope}) ${maskPath(h.configPath)}`));
  if (report.hooks.length === 0) push('  none installed');
  const resolvableNote = report.hooks.find((h) => h.resolvable !== null)?.resolvableNote;
  if (resolvableNote !== undefined && resolvableNote !== '') {
    for (const line of wrapToWidth(tlx(`resolvable: ${sanitizeForCell(resolvableNote)}`), Math.max(20, budget - 2), 99)) {
      push(paint('dim', `  ${line}`, color));
    }
  }

  push('');
  push('ledgers');
  const l = report.ledgers;
  const ledgerParts = [plural(l.sessions, 'session'), `${l.partial} partial`, `${l.gaps} gaps`, `stdin overflow ${l.stdinOverflow}`, `stop budget exceeded ${l.stopBudgetExceeded}`];
  if (l.copilotTranscriptUnparsed > 0) ledgerParts.push(`copilot transcripts unparsed ${l.copilotTranscriptUnparsed}`);
  push(`  ${tlx(ledgerParts.join(sep))}`);

  push('');
  push('prices');
  const override = report.prices.overrideHash === undefined ? '' : `+u:${sanitizeForCell(report.prices.overrideHash)}`;
  push(`  version ${sanitizeForCell(report.prices.version)}${override}`);
  if (report.prices.unverifiedInUse) push(paint('warn', `  ${g.warn} unverified rates in use`, color));
  if (report.prices.unpricedModels.length > 0) {
    for (const line of noteLines(g.warn, `unpriced: ${report.prices.unpricedModels.join(', ')}`)) push(paint('warn', line, color));
  }

  push('');
  push('cache');
  push(`  ${tlx([plural(report.cache.entries, 'entry').replace('entrys', 'entries'), fmtBytes(report.cache.bytes)].join(sep))}`);

  if (report.warnings.length > 0) {
    push('');
    push('warnings');
    for (const w of report.warnings) for (const line of noteLines(g.warn, w)) push(paint('warn', line, color));
  }
  if (report.problems.length > 0) {
    push('');
    push('problems');
    for (const p of report.problems) for (const line of noteLines(g.bad, p)) push(paint('bad', line, color));
  }
  return out;
}
