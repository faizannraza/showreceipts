/**
 * Text rendering of a `DoctorReport` (§12.3 shape, S20 instruction 5):
 * roots, per-harness rows, the hook table, ledger counters, price warnings,
 * cache size, then warnings and problems. Unboxed lines, each at most
 * `cols − 2` columns; problems are painted `bad`, warnings `warn`. Pure —
 * the doctor command gathers, this module only formats.
 */
import type { DoctorHarnessReport, DoctorHookReport, DoctorReport } from '../model/types.js';
import { paint } from '../util/ansi.js';
import { sanitizeForCell } from '../util/sanitize.js';
import { displayWidth, padEnd, truncateToWidth } from '../util/width.js';
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

/** One harness row: root, session count, bytes, versions seen, installed version, bad-line count. */
function harnessRow(h: DoctorHarnessReport, sep: string): string {
  const parts = [sanitizeForCell(h.root)];
  if (!h.found) {
    parts.push('not found');
  } else {
    parts.push(plural(h.sessions, 'session'), fmtBytes(h.bytes));
    if (h.versions.length > 0) parts.push(`versions ${h.versions.map(sanitizeForCell).join(', ')}`);
    if (h.installedVersion !== null) parts.push(`installed ${sanitizeForCell(h.installedVersion)}`);
    if (h.badLines > 0) parts.push(`${plural(h.badLines, 'bad line')}`);
    if (h.hooksDisabled === true) parts.push('hooks disabled');
  }
  return parts.join(sep);
}

/** One hook row: scope, config path and the installed/strict/trust facts. */
function hookRow(h: DoctorHookReport, sep: string): string {
  const parts = [`(${h.scope}) ${sanitizeForCell(h.configPath)}`, h.installed ? 'installed' : 'not installed'];
  if (h.disabled) parts.push('disabled');
  if (h.strict) parts.push('strict');
  if (h.resolvable === false) parts.push('not resolvable');
  if (h.trusted === false) parts.push('untrusted');
  if (h.otherStopHooks.length > 0) parts.push(`${plural(h.otherStopHooks.length, 'other stop hook')}`);
  return parts.join(sep);
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
  const out: string[] = [];
  const push = (line: string): void => {
    out.push(displayWidth(line) > budget ? truncateToWidth(line, budget, g.ellipsis) : line);
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
  for (const [name, path] of roots) push(`  ${padEnd(name, 13)} ${sanitizeForCell(path)}`);

  push('');
  push('harnesses');
  const labelW = Math.min(14, Math.max(...report.harnesses.map((h) => displayWidth(h.harness)), 7));
  for (const h of report.harnesses) push(`  ${padEnd(h.harness, labelW)} ${tlx(harnessRow(h, sep))}`);
  if (report.harnesses.length === 0) push('  none');

  push('');
  push('hooks');
  for (const h of report.hooks) push(`  ${padEnd(h.harness, labelW)} ${tlx(hookRow(h, sep))}`);
  if (report.hooks.length === 0) push('  none installed');

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
    push(paint('warn', truncateToWidth(`  ${g.warn} unpriced: ${report.prices.unpricedModels.map(sanitizeForCell).join(', ')}`, budget, g.ellipsis), color));
  }

  push('');
  push('cache');
  push(`  ${tlx([plural(report.cache.entries, 'entry').replace('entrys', 'entries'), fmtBytes(report.cache.bytes)].join(sep))}`);

  if (report.warnings.length > 0) {
    push('');
    push('warnings');
    for (const w of report.warnings) push(paint('warn', truncateToWidth(`  ${g.warn} ${tlx(sanitizeForCell(w))}`, budget, g.ellipsis), color));
  }
  if (report.problems.length > 0) {
    push('');
    push('problems');
    for (const p of report.problems) push(paint('bad', truncateToWidth(`  ${g.bad} ${tlx(sanitizeForCell(p))}`, budget, g.ellipsis), color));
  }
  return out;
}
