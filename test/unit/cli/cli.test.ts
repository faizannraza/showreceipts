import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { COMMANDS, parse, UsageError } from '../../../src/cli/args.js';
import { createContext, resolveNow, type CommandContext } from '../../../src/cli/context.js';
import { commandHelp, HELP_TEXT, usageFooter } from '../../../src/cli/help.js';
import { PRIVACY_FOOTER } from '../../../src/commands/help.js';
import { main, type MainOptions } from '../../../src/cli.js';
import { TOOL_VERSION } from '../../../src/version.js';
import { makeTempDir } from '../../helpers/tmp.js';

class MemoryStream extends Writable {
  private readonly chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk));
    callback();
  }

  get text(): string {
    return this.chunks.join('');
  }
}

class ThrowingStream extends Writable {
  override write(): never {
    throw new Error('stdout exploded');
  }
}

/** Fails every write asynchronously, the way a closed pipe (EPIPE) does. */
class BrokenPipeStream extends Writable {
  override _write(_chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  }
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(argv: string[], extra: Partial<MainOptions> = {}): Promise<Run> {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const code = await main(argv, { stdout, stderr, env: {}, cwd: '/tmp', ...extra });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

describe('main: version and help', () => {
  it('--version prints TOOL_VERSION and exits 0', async () => {
    const r = await run(['--version']);
    expect(r).toEqual({ code: 0, stdout: `${TOOL_VERSION}\n`, stderr: '' });
  });

  it('--version wins over a command', async () => {
    expect((await run(['doctor', '--version'])).stdout).toBe(`${TOOL_VERSION}\n`);
  });

  it('--help prints the §12.4 text and exits 0', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(HELP_TEXT);
    expect(r.stderr).toBe('');
    expect(HELP_TEXT.startsWith('showreceipts — your coding agent said "done". Show receipts.\n')).toBe(true);
    expect(HELP_TEXT.endsWith('~/.showreceipts/.\n')).toBe(true);
  });

  it('-h is --help', async () => {
    expect((await run(['-h'])).stdout).toBe(HELP_TEXT);
  });

  it('<cmd> --help prints the per-command block for every command but hook', async () => {
    for (const command of COMMANDS) {
      if (command === 'hook') continue;
      const r = await run([command, '--help']);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(commandHelp(command));
      expect(r.stdout.startsWith(`showreceipts ${command} — `)).toBe(true);
      expect(r.stdout).toContain(`Usage: showreceipts ${command === 'audit' ? '[audit]' : command}`);
      expect(r.stdout).toContain('\nOptions\n');
      expect(r.stdout.endsWith('\n')).toBe(true);
    }
  });

  it('hook --help at an interactive stdin prints the hook help block (Pass 3)', async () => {
    const r = await run(['hook', '--help'], { stdinIsTTY: true });
    expect(r).toEqual({ code: 0, stdout: commandHelp('hook'), stderr: '' });
  });

  it('hook --help with piped stdin keeps the §9 JSON-only contract', async () => {
    const r = await run(['hook', '--help'], { stdinIsTTY: false });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('{}\n');
  });

  it('per-command help lists exactly the accepted, non-hidden flags', () => {
    const setup = commandHelp('setup');
    expect(setup).toContain('--dry-run');
    expect(setup).toContain('--project ');
    expect(setup).toContain('Write the project-level config');
    expect(setup).not.toContain('--width');
    expect(setup).not.toContain('--home-dir');
    expect(setup).not.toContain('--help');
    const audit = commandHelp('audit');
    expect(audit).toContain('--width <n>');
    expect(audit).toContain('Match session cwd substring or path');
    const report = commandHelp('report');
    expect(report).toContain('--hash-paths [=both]');
    const demo = commandHelp('demo');
    expect(demo).not.toContain('--svg');
    const hook = commandHelp('hook');
    expect(hook).toContain('--strict-reasons <list>');
    for (const command of COMMANDS) {
      for (const line of commandHelp(command).split('\n')) {
        // the one-line title and the pinned §12.4 footer stay unwrapped
        if (line === PRIVACY_FOOTER || line.startsWith('showreceipts ')) continue;
        expect(line.length, `${command}: ${line}`).toBeLessThanOrEqual(102);
      }
    }
  });

  it('usageFooter names the command', () => {
    expect(usageFooter()).toBe("Usage: showreceipts [command] [options]; try 'showreceipts --help'");
    expect(usageFooter('audit')).toBe(usageFooter());
    expect(usageFooter('session')).toContain("try 'showreceipts session --help'");
  });
});

describe('main: dispatch and exit codes', () => {
  it('bogus command exits 2 with the message and a usage line', async () => {
    const r = await run(['bogus']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(`showreceipts: unknown command 'bogus'\n${usageFooter('audit')}\n`);
  });

  it('every stub but hook exits 2 with its "not implemented yet" line', async () => {
    for (const command of COMMANDS) {
      if (command === 'hook') continue;
      if (command === 'export') continue; // implemented in S21; its own tests and the W4 e2e cover it
      if (command === 'demo') continue; // implemented in S23b; test/render/demo.test.ts covers it
      if (command === 'audit') continue; // implemented in S24; test/unit/commands/audit.test.ts covers it
      if (command === 'session') continue; // implemented in S24; test/unit/commands/session.test.ts covers it
      if (command === 'report') continue; // implemented in S25; test/unit/commands/report.test.ts covers it
      if (command === 'doctor') continue; // implemented in S25; test/unit/commands/doctor.test.ts covers it
      if (command === 'bench') continue; // implemented in S25; test/unit/commands/bench.test.ts covers it
      if (command === 'setup') continue; // implemented in S30; test/unit/setup and test/setup cover it
      const r = await run([command]);
      expect(r.code, command).toBe(2);
      expect(r.stdout, command).toBe('');
      expect(r.stderr, command).toBe(`showreceipts ${command}: not implemented yet\n`);
    }
  });

  it('the default command is audit', async () => {
    // audit is real since S24: give it an empty temp HOME so it scans nothing
    // (env {} would fall back to the developer's real home directory).
    const home = makeTempDir('showreceipts-cli-home-');
    const r = await run([], { env: { HOME: home } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no sessions found');
  });

  it('hook prints {} and exits 0', async () => {
    const r = await run(['hook', 'claude-code', 'Stop']);
    expect(r).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
  });

  it('hook bogus --whatever prints {} and exits 0', async () => {
    const r = await run(['hook', 'bogus', '--whatever', 'extra', 'more', '--strict-max=abc']);
    expect(r).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
  });

  it('hook swallows a throwing command module: {} and 0', async () => {
    const r = await run(['hook', 'codex'], {
      loaders: {
        hook: async () => ({
          run: async () => {
            throw new Error('runtime not ready');
          },
        }),
      },
    });
    expect(r).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
  });

  it('hook swallows a usage-class failure from the context (bad SHOWRECEIPTS_NOW): {} and 0', async () => {
    const r = await run(['hook', 'codex'], { env: { SHOWRECEIPTS_NOW: 'garbage' } });
    expect(r).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
  });

  it('hook survives a dead stdout', async () => {
    const stderr = new MemoryStream();
    const code = await main(['hook', 'x'], { stdout: new ThrowingStream(), stderr, env: {} });
    expect(code).toBe(0);
    expect(stderr.text).toBe('');
  });

  it('hook survives an asynchronous stdout failure (EPIPE) without an unhandled error event', async () => {
    // The write is accepted and fails later on the stream: without a listener the 'error' event would crash the process with exit 1.
    const stdout = new BrokenPipeStream();
    const stderr = new MemoryStream();
    const code = await main(['hook', 'x'], { stdout, stderr, env: {} });
    await new Promise((resolve) => setImmediate(resolve));
    expect(code).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.destroyed).toBe(true);
  });

  it('a usage error exits 2 with the message and the usage line', async () => {
    const r = await run(['audit', '--width', '30']);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(`showreceipts: --width: expected an integer between 40 and 200 (got '30')\n${usageFooter('audit')}\n`);
    const asOf = await run(['audit', '--as-of', '2026-02-30']);
    expect(asOf.code).toBe(2);
    expect(asOf.stderr).toContain('showreceipts: --as-of: expected YYYY-MM-DD\n');
  });

  it('a thrown non-usage error exits 1 with showreceipts: <message>', async () => {
    const r = await run(['doctor'], {
      loaders: {
        doctor: async () => ({
          run: async () => {
            throw new Error('disk on fire');
          },
        }),
      },
    });
    expect(r).toEqual({ code: 1, stdout: '', stderr: 'showreceipts: disk on fire\n' });
  });

  it('a non-Error throw is stringified', async () => {
    const r = await run(['demo'], { loaders: { demo: async () => ({ run: async () => Promise.reject('plain string') }) } });
    expect(r).toEqual({ code: 1, stdout: '', stderr: 'showreceipts: plain string\n' });
  });

  it('a failing stdout write surfaces as exit 1', async () => {
    const stderr = new MemoryStream();
    const code = await main(['--version'], { stdout: new ThrowingStream(), stderr, env: {} });
    expect(code).toBe(1);
    expect(stderr.text).toBe('showreceipts: stdout exploded\n');
  });

  it('returns the command module exit code and hands it the context', async () => {
    let seen: CommandContext | undefined;
    const r = await run(['bench', '--json', '--now', '2026-01-02T03:04:05Z'], {
      loaders: {
        bench: async () => ({
          run: async (ctx) => {
            seen = ctx;
            ctx.stdout.write('[]\n');
            return 7;
          },
        }),
      },
    });
    expect(r).toEqual({ code: 7, stdout: '[]\n', stderr: '' });
    expect(seen?.args.command).toBe('bench');
    expect(seen?.args.flags).toEqual({ json: true, now: '2026-01-02T03:04:05Z' });
    expect(seen?.now.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(seen?.cwd).toBe('/tmp');
    expect(seen?.isTTY).toBe(false);
    expect(seen?.columns).toBeUndefined();
  });

  it('never rejects and never touches process.exitCode in test mode', async () => {
    const before = process.exitCode;
    await run(['bogus']);
    await run(['--version']);
    expect(process.exitCode).toBe(before);
  });
});

describe('createContext', () => {
  it('resolves now from --now, then SHOWRECEIPTS_NOW, then the injected clock', () => {
    const injected = new Date('2020-01-01T00:00:00Z');
    expect(createContext(parse(['--now', '2026-01-02T03:04:05Z']), { env: { SHOWRECEIPTS_NOW: '2025-05-05T05:05:05Z' }, now: injected }).now.toISOString()).toBe(
      '2026-01-02T03:04:05.000Z',
    );
    expect(createContext(parse([]), { env: { SHOWRECEIPTS_NOW: '2025-05-05T05:05:05Z' }, now: injected }).now.toISOString()).toBe(
      '2025-05-05T05:05:05.000Z',
    );
    expect(createContext(parse([]), { env: { SHOWRECEIPTS_NOW: '' }, now: injected }).now).toBe(injected);
    expect(createContext(parse([]), { env: {}, now: injected }).now).toBe(injected);
  });

  it('falls back to the wall clock without an injected clock', () => {
    const before = Date.now();
    const ctx = createContext(parse([]), { env: {} });
    expect(ctx.now.getTime()).toBeGreaterThanOrEqual(before);
    expect(ctx.now.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('rejects a malformed SHOWRECEIPTS_NOW as a usage error naming the variable', () => {
    expect(() => resolveNow(parse(['doctor']), { SHOWRECEIPTS_NOW: 'garbage' })).toThrowError(UsageError);
    expect(() => resolveNow(parse(['doctor']), { SHOWRECEIPTS_NOW: 'garbage' })).toThrowError(
      "SHOWRECEIPTS_NOW: expected an ISO-8601 timestamp (got 'garbage')",
    );
  });

  it('honours injected tty facts and cwd', () => {
    const stdout = new MemoryStream();
    const ctx = createContext(parse([]), { stdout, stderr: stdout, env: {}, cwd: '/work', isTTY: true, columns: 120 });
    expect(ctx.isTTY).toBe(true);
    expect(ctx.columns).toBe(120);
    expect(ctx.cwd).toBe('/work');
    expect(ctx.stdout).toBe(stdout);
    const explicitUndefined = createContext(parse([]), { stdout, env: {}, columns: undefined });
    expect(explicitUndefined.columns).toBeUndefined();
  });

  it('reads the real process streams, env and cwd when nothing is injected', () => {
    const ctx = createContext(parse(['--now', '2026-08-29T12:00:00Z']));
    expect(ctx.stdout).toBe(process.stdout);
    expect(ctx.stderr).toBe(process.stderr);
    expect(ctx.env).toBe(process.env);
    expect(ctx.cwd).toBe(process.cwd());
    expect(typeof ctx.isTTY).toBe('boolean');
    expect(ctx.columns === undefined || (typeof ctx.columns === 'number' && ctx.columns > 0)).toBe(true);
    expect(ctx.now.toISOString()).toBe('2026-08-29T12:00:00.000Z');
  });
});
