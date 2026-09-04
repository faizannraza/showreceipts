/**
 * S23c — the shared `--help` machinery (`src/commands/help.ts`): the §12.4
 * option table, the section renderer, and the drift pins against the argv
 * flag table (`cli/args.ts`) and the S01 renderer (`cli/help.ts`).
 */
import { describe, expect, it } from 'vitest';
import { FLAG_SPECS, flagsFor } from '../../../src/cli/args.js';
import { commandHelp } from '../../../src/cli/help.js';
import { main } from '../../../src/cli.js';
import {
  formatOption,
  PRIVACY_FOOTER,
  SHARED_OPTIONS,
  sharedOptions,
  usage,
  type HelpSection,
} from '../../../src/commands/help.js';

/** The §12.4 global flag list, in canonical order (the step's exact set). */
const GLOBAL_FLAGS = [
  'json',
  'width',
  'ascii',
  'unicode',
  'no-color',
  'tz',
  'since',
  'until',
  'all',
  'harness',
  'project',
  'prices',
  'as-of',
  'no-cache',
  'now',
  'debug',
  'version',
  'help',
] as const;

describe('the shared option table', () => {
  it('lists exactly the §12.4 global flags, in order', () => {
    expect(SHARED_OPTIONS.map((row) => row.flag)).toEqual([...GLOBAL_FLAGS]);
  });

  it('never names a flag the argv parser does not know', () => {
    const known = new Set(FLAG_SPECS.map((spec) => spec.name));
    for (const row of SHARED_OPTIONS) expect(known.has(row.flag), row.flag).toBe(true);
  });

  it('sharedOptions returns rows in the requested order and rejects unknown names', () => {
    const rows = sharedOptions(['since', 'json']);
    expect(rows.map((r) => r.flag)).toEqual(['since', 'json']);
    expect(() => sharedOptions(['since', 'nope'])).toThrow(/--nope/);
  });

  it('renders byte-identically to the S01 help renderer for every shared flag a command accepts', () => {
    // Drift pin: cli/help.ts owns the S01 copies; the shared table must
    // produce the very same option lines for the flags both list.
    for (const command of ['audit', 'session', 'export', 'bench', 'doctor'] as const) {
      const rendered = commandHelp(command);
      const accepted = new Set(flagsFor(command).filter((s) => !s.hidden).map((s) => s.name));
      for (const row of SHARED_OPTIONS) {
        if (!accepted.has(row.flag) || row.flag === 'help' || row.flag === 'version') continue;
        expect(rendered, `${command}: --${row.flag}`).toContain(`\n${formatOption(row)}\n`);
      }
    }
  });
});

describe('usage(command, section)', () => {
  const section: HelpSection = {
    summary: 'Test summary',
    synopsis: 'showreceipts audit [--since 90d|YYYY-MM-DD] [--until date] [--harness h[,h]] [--json] [--width N] [--no-color] [--now ISO]',
    detail:
      'A deliberately long detail paragraph that must be word-wrapped by the renderer because it runs well past the hundred column mark used by every help screen in the §12.4 style.',
    options: [...sharedOptions(['since', 'json']), { flag: 'limit', arg: '<n>', text: 'Rows in the session table (default 20)' }],
  };

  it('renders the §12.4 layout: summary, usage, detail, options, privacy footer', () => {
    const text = usage('audit', section);
    expect(text.startsWith('showreceipts audit — Test summary\n\nUsage: ')).toBe(true);
    expect(text).toContain('\n\nOptions\n');
    const sinceRow = sharedOptions(['since'])[0];
    expect(sinceRow).toBeDefined();
    expect(text).toContain(`\n${formatOption(sinceRow as { flag: string; text: string })}\n`);
    expect(text).toContain(`\n${formatOption({ flag: 'limit', arg: '<n>', text: 'Rows in the session table (default 20)' })}\n`);
    expect(text.endsWith(`\n${PRIVACY_FOOTER}\n`)).toBe(true);
  });

  it('wraps the synopsis and the detail at 100 columns', () => {
    const text = usage('audit', section);
    for (const line of text.split('\n')) {
      // option rows and the verbatim §12.4 footer may exceed, as in the S01 renderer
      if (line.startsWith('  --') || line === PRIVACY_FOOTER) continue;
      expect(line.length, line).toBeLessThanOrEqual(100);
    }
    // wrapped synopsis continuation lines are indented under "Usage: "
    const lines = text.split('\n');
    const usageIndex = lines.findIndex((l) => l.startsWith('Usage: '));
    expect(usageIndex).toBeGreaterThan(0);
    expect(lines[usageIndex + 1]?.startsWith('       ')).toBe(true);
  });

  it('formatOption pads the flag column to the S01 width and trims trailing space', () => {
    expect(formatOption({ flag: 'json', text: 'Machine-readable output' })).toBe(`  ${'--json'.padEnd(24)} Machine-readable output`);
    expect(formatOption({ flag: 'x', text: '' })).toBe('  --x');
  });
});

describe('--help never prints anything else on stdout', () => {
  it('exits 0 with only the help text', async () => {
    let stdout = '';
    let stderr = '';
    const out = { write: (c: unknown): boolean => ((stdout += String(c)), true) } as unknown as NodeJS.WritableStream;
    const err = { write: (c: unknown): boolean => ((stderr += String(c)), true) } as unknown as NodeJS.WritableStream;
    const code = await main(['audit', '--help'], { stdout: out, stderr: err, env: { HOME: '/tmp' }, cwd: '/tmp' });
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toBe(commandHelp('audit'));
  });
});
