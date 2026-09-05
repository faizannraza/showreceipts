/**
 * S33 — `--help` snapshots for every §12.1 command, in the §12.4 style:
 * exit 0 with the help text alone on stdout, byte-equal to the S01
 * renderer, every flag documented exactly once per screen, and the privacy
 * footer exactly once. The snapshots are the committed record of the whole
 * CLI help surface; an intentional flag change updates them with `vitest -u`.
 */
import { describe, expect, it } from 'vitest';
import { main } from '../../../src/cli.js';
import { commandHelp, HELP_TEXT } from '../../../src/cli/help.js';
import { PRIVACY_FOOTER } from '../../../src/commands/help.js';

/** The §12.1 public commands (`hook` is internal and excluded on purpose). */
const COMMANDS = ['audit', 'session', 'export', 'report', 'doctor', 'bench', 'demo', 'setup'] as const;

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(argv: string[]): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const out = { write: (c: unknown): boolean => ((stdout += String(c)), true) } as unknown as NodeJS.WritableStream;
  const err = { write: (c: unknown): boolean => ((stderr += String(c)), true) } as unknown as NodeJS.WritableStream;
  const code = await main(argv, { stdout: out, stderr: err, env: { HOME: '/tmp' }, cwd: '/tmp' });
  return { code, stdout, stderr };
}

/** The option rows of a help screen (`  --flag …`), by flag name. */
function optionFlags(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^ {2}--([a-z][a-z0-9-]*)/.exec(line);
    if (m !== null) names.push(m[1] ?? '');
  }
  return names;
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('showreceipts <cmd> --help (§12.4)', () => {
  it.each(COMMANDS)('%s: exits 0 with only the help screen, matching the renderer', async (cmd) => {
    const r = await run([cmd, '--help']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(commandHelp(cmd));
    expect(r.stdout.startsWith(`showreceipts ${cmd} — `)).toBe(true);
  });

  it.each(COMMANDS)('%s: documents every flag once and the privacy footer once', async (cmd) => {
    const r = await run([cmd, '--help']);
    const flags = optionFlags(r.stdout);
    expect(flags.length).toBeGreaterThan(0);
    expect(new Set(flags).size, `duplicate flag row in '${cmd} --help': ${flags.join(', ')}`).toBe(flags.length);
    expect(countOf(r.stdout, PRIVACY_FOOTER)).toBe(1);
  });

  it.each(COMMANDS)('%s: snapshot', async (cmd) => {
    const r = await run([cmd, '--help']);
    expect(r.stdout).toMatchSnapshot();
  });
});

describe('showreceipts --help (top level)', () => {
  it('exits 0 with the §12.4 screen verbatim', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(HELP_TEXT);
    expect(countOf(r.stdout, PRIVACY_FOOTER)).toBe(1);
    expect(r.stdout).toMatchSnapshot();
  });

  it('lists every §12.1 public command exactly once', async () => {
    const r = await run(['--help']);
    for (const cmd of COMMANDS) {
      const label = cmd === 'audit' ? '  audit (default)' : `  ${cmd} `;
      expect(countOf(r.stdout, `\n${label}`), cmd).toBe(1);
    }
  });
});
