/**
 * S23c — shared command preparation (`src/commands/common.ts`): exit codes,
 * window/harness/price resolution, the display-only `--home-dir`, render
 * options and the stderr progress line.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from '../../../src/cli/args.js';
import { createContext, type CommandContext } from '../../../src/cli/context.js';
import { main } from '../../../src/cli.js';
import {
  CommandUsageError,
  loadOptionsOf,
  prepare,
  startProgress,
  type Prepared,
} from '../../../src/commands/common.js';
import { loadPriceTable, PriceTableError } from '../../../src/cost/resolve.js';
import { RECEIPT_RULES_VERSION } from '../../../src/pipeline/receipt.js';
import { geometry } from '../../../src/render/box.js';
import { TOOL_VERSION } from '../../../src/version.js';
import { makeTempDir } from '../../helpers/tmp.js';

const NOW = new Date('2026-08-29T12:00:00.000Z');
const DAY = 86_400_000;

interface Sink extends NodeJS.WritableStream {
  text: string;
}

function sink(): Sink {
  const s = {
    text: '',
    write(chunk: unknown): boolean {
      s.text += String(chunk);
      return true;
    },
  };
  return s as unknown as Sink;
}

class MemoryStream extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += String(chunk);
    callback();
  }
}

/** Fails every write asynchronously, the way a closed pipe (EPIPE) does. */
class BrokenPipeStream extends Writable {
  override _write(_chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  }
}

/** A stable temp HOME for contexts that do not care about roots. */
const DEFAULT_HOME = makeTempDir('showreceipts-common-home-');

interface CtxOptions {
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
  columns?: number;
  cwd?: string;
  stderr?: Sink;
}

function ctxFor(argv: string[], opts: CtxOptions = {}): CommandContext {
  const args = parse(argv);
  return createContext(args, {
    stdout: sink(),
    stderr: opts.stderr ?? sink(),
    env: opts.env ?? { HOME: DEFAULT_HOME },
    cwd: opts.cwd ?? '/tmp',
    now: NOW,
    isTTY: opts.isTTY ?? false,
    ...(opts.columns !== undefined ? { columns: opts.columns } : {}),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('prepare: window and filters', () => {
  it('defaults the window to 90d before ctx.now', () => {
    const p = prepare(ctxFor(['audit']));
    expect(p.all).toBe(false);
    expect(p.sinceMs).toBe(NOW.getTime() - 90 * DAY);
    expect(p.untilMs).toBeUndefined();
  });

  it('resolves --since dates, --all and both --until forms', () => {
    expect(prepare(ctxFor(['audit', '--since', '2026-01-01'])).sinceMs).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(prepare(ctxFor(['audit', '--all'])).sinceMs).toBeUndefined();
    expect(prepare(ctxFor(['audit', '--all'])).all).toBe(true);
    // A date names its whole day: the boundary is the following UTC midnight.
    expect(prepare(ctxFor(['audit', '--until', '2026-03-01'])).untilMs).toBe(Date.parse('2026-03-02T00:00:00Z'));
    expect(prepare(ctxFor(['audit', '--until', '30d'])).untilMs).toBe(NOW.getTime() - 30 * DAY);
  });

  it('validates the harness filter and passes a good list through', () => {
    const p = prepare(ctxFor(['audit', '--harness', 'claude-code,codex']));
    expect(p.harness).toEqual(['claude-code', 'codex']);
    expect(prepare(ctxFor(['audit'])).harness).toBeUndefined();
    let thrown: unknown;
    try {
      prepare(ctxFor(['audit', '--harness', 'claude-code,frobnicator']));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CommandUsageError);
    const usage = thrown as CommandUsageError;
    expect(usage.name).toBe('UsageError');
    expect(usage.exitCode).toBe(2);
    expect(usage.command).toBe('audit');
    expect(usage.message).toContain('frobnicator');
  });

  it('passes --project through and resolves --as-of', () => {
    const p = prepare(ctxFor(['audit', '--project', 'proj', '--as-of', '2026-05-01']));
    expect(p.project).toBe('proj');
    expect(p.asOf).toBe('2026-05-01');
    expect(prepare(ctxFor(['audit'])).asOf).toBeUndefined();
  });
});

describe('exit codes through main (§12.2)', () => {
  interface Run {
    code: number;
    stderr: string;
    prepared: Prepared | undefined;
  }

  async function run(argv: string[], env: Record<string, string | undefined> = { HOME: '/tmp' }): Promise<Run> {
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();
    let prepared: Prepared | undefined;
    const code = await main(argv, {
      stdout,
      stderr,
      env,
      cwd: '/tmp',
      now: NOW,
      loaders: {
        audit: () =>
          Promise.resolve({
            run: (ctx: CommandContext): Promise<number> => {
              prepared = prepare(ctx);
              return Promise.resolve(0);
            },
          }),
      },
    });
    return { code, stderr: stderr.text, prepared };
  }

  it('--width 39 and 201 exit 2 at the argv shell', async () => {
    expect((await run(['audit', '--width', '39'])).code).toBe(2);
    expect((await run(['audit', '--width', '201'])).code).toBe(2);
    expect((await run(['audit', '--width', '39'])).stderr).toContain('--width');
  });

  it('--width 150 caps at 102 columns, so W = 100', async () => {
    const r = await run(['audit', '--width', '150']);
    expect(r.code).toBe(0);
    expect(r.prepared?.render.cols).toBe(102);
    expect(geometry(r.prepared?.render.cols ?? 0).W).toBe(100);
  });

  it('an unknown --harness exits 2 with the usage footer', async () => {
    const r = await run(['audit', '--harness', 'frobnicator']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('showreceipts: --harness: unknown harness');
    expect(r.stderr).toContain("try 'showreceipts --help'");
  });

  it('a malformed --as-of exits 2', async () => {
    expect((await run(['audit', '--as-of', '2026-02-30'])).code).toBe(2);
    expect((await run(['audit', '--as-of', 'yesterday'])).code).toBe(2);
  });

  it('an invalid --prices file exits 1', async () => {
    const dir = makeTempDir();
    const bad = join(dir, 'prices.json');
    writeFileSync(bad, '{"models": []}');
    const r = await run(['audit', '--prices', bad]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('prices:');
    const missing = await run(['audit', '--prices', join(dir, 'nope.json')]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('cannot read file');
  });

  it('a CommandUsageError thrown by a command maps to exit 2', async () => {
    const stderr = new MemoryStream();
    const code = await main(['audit'], {
      stdout: new MemoryStream(),
      stderr,
      env: { HOME: '/tmp' },
      cwd: '/tmp',
      loaders: {
        audit: () =>
          Promise.resolve({
            run: (): Promise<number> => {
              throw new CommandUsageError('boom', 'audit');
            },
          }),
      },
    });
    expect(code).toBe(2);
    expect(stderr.text).toContain('showreceipts: boom');
    expect(stderr.text).toContain('Usage:');
  });
});

describe('prices (§8.1)', () => {
  function envWithHome(srHome: string): Record<string, string | undefined> {
    return { HOME: '/tmp/showreceipts-common-home', SHOWRECEIPTS_HOME: srHome };
  }

  it('uses the bundled table when no override exists', () => {
    const p = prepare(ctxFor(['audit'], { env: envWithHome(makeTempDir()) }));
    expect(p.prices.version).toBe(loadPriceTable().version);
    expect(p.priceNotes).toEqual([]);
  });

  it('merges a valid home override (version gains the hash suffix)', () => {
    const srHome = makeTempDir();
    writeFileSync(join(srHome, 'prices.json'), '{"models": {}}');
    const p = prepare(ctxFor(['audit'], { env: envWithHome(srHome) }));
    expect(p.prices.version).toMatch(new RegExp(`^${loadPriceTable().version.replace(/[.+]/g, '\\$&')}\\+[0-9a-f]{8}$`));
    expect(p.versions.pricesVersion).toBe(p.prices.version);
    expect(p.priceNotes).toEqual([]);
  });

  it('reports and ignores an invalid home override — never fatal', () => {
    const srHome = makeTempDir();
    writeFileSync(join(srHome, 'prices.json'), '{"models": []}');
    const p = prepare(ctxFor(['audit'], { env: envWithHome(srHome) }));
    expect(p.prices.version).toBe(loadPriceTable().version);
    expect(p.priceNotes).toHaveLength(1);
    expect(p.priceNotes[0]).toContain('override ignored');
  });

  it('an invalid --prices flag throws PriceTableError (exit 1 at the shell)', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'p.json'), 'not json');
    expect(() => prepare(ctxFor(['audit', '--prices', join(dir, 'p.json')], { env: envWithHome(makeTempDir()) }))).toThrow(PriceTableError);
  });
});

describe('--home-dir is display-only', () => {
  it('never reaches the roots or the load options', () => {
    const home = makeTempDir();
    const env = { HOME: home };
    const plain = prepare(ctxFor(['audit'], { env }));
    const displayed = prepare(ctxFor(['audit', '--home-dir', '/home/u'], { env }));
    expect(plain.homeDir).toBe(home);
    expect(displayed.homeDir).toBe('/home/u');
    expect(displayed.userHome).toBe(home);
    expect(displayed.roots).toEqual(plain.roots);
    const a = loadOptionsOf(plain);
    const b = loadOptionsOf(displayed);
    expect(b.roots).toEqual(a.roots);
    expect(b.since).toBe(a.since);
    expect(b.versions).toEqual(a.versions);
  });

  it('SHOWRECEIPTS_DISPLAY_HOME applies, and the flag wins over it', () => {
    const home = makeTempDir();
    const env = { HOME: home, SHOWRECEIPTS_DISPLAY_HOME: '/home/display' };
    expect(prepare(ctxFor(['audit'], { env })).homeDir).toBe('/home/display');
    expect(prepare(ctxFor(['audit', '--home-dir', '/home/u'], { env })).homeDir).toBe('/home/u');
    expect(prepare(ctxFor(['audit'], { env })).roots).toEqual(prepare(ctxFor(['audit'], { env: { HOME: home } })).roots);
  });
});

describe('cache, versions and render options', () => {
  it('resolves --no-cache and SHOWRECEIPTS_NO_CACHE (any non-empty value but 0)', () => {
    const home = { HOME: '/tmp' };
    expect(prepare(ctxFor(['audit'], { env: home })).noCache).toBe(false);
    expect(prepare(ctxFor(['audit', '--no-cache'], { env: home })).noCache).toBe(true);
    expect(prepare(ctxFor(['audit'], { env: { ...home, SHOWRECEIPTS_NO_CACHE: '1' } })).noCache).toBe(true);
    expect(prepare(ctxFor(['audit'], { env: { ...home, SHOWRECEIPTS_NO_CACHE: '0' } })).noCache).toBe(false);
    const opts = loadOptionsOf(prepare(ctxFor(['audit', '--no-cache'], { env: home })));
    expect(opts.noCache).toBe(true);
  });

  it('stamps the tool, rules and prices versions', () => {
    const p = prepare(ctxFor(['audit']));
    expect(p.versions).toEqual({
      toolVersion: TOOL_VERSION,
      rulesVersion: RECEIPT_RULES_VERSION,
      pricesVersion: loadPriceTable().version,
    });
    expect(loadOptionsOf(p).versions).toEqual({ tool: TOOL_VERSION });
  });

  it('resolves tz, unicode and colour through the S20 primitives', () => {
    expect(prepare(ctxFor(['audit'])).render.tz).toBe('local');
    expect(prepare(ctxFor(['audit', '--tz', 'utc'])).render.tz).toBe('utc');
    expect(prepare(ctxFor(['audit', '--ascii'])).render.unicode).toBe(false);
    const linuxTerm = { HOME: '/tmp', TERM: 'linux' };
    expect(prepare(ctxFor(['audit'], { env: linuxTerm }), { platform: 'linux' }).render.unicode).toBe(false);
    expect(prepare(ctxFor(['audit', '--unicode'], { env: linuxTerm }), { platform: 'linux' }).render.unicode).toBe(true);
    expect(prepare(ctxFor(['audit'], { env: { HOME: '/tmp', NO_COLOR: '1' }, isTTY: true })).render.color).toBe(false);
    expect(prepare(ctxFor(['audit'], { env: { HOME: '/tmp', FORCE_COLOR: '1' } })).render.color).toBe(true);
    expect(prepare(ctxFor(['audit', '--no-color'], { env: { HOME: '/tmp', FORCE_COLOR: '1' } })).render.color).toBe(false);
  });

  it('resolves columns from --width, tty columns and COLUMNS in that order', () => {
    expect(prepare(ctxFor(['audit', '--width', '80'], { columns: 120 })).render.cols).toBe(80);
    expect(prepare(ctxFor(['audit'], { columns: 96, isTTY: true })).render.cols).toBe(96);
    expect(prepare(ctxFor(['audit'], { env: { HOME: '/tmp', COLUMNS: '90' } })).render.cols).toBe(90);
    expect(prepare(ctxFor(['audit'], { env: { HOME: '/tmp', COLUMNS: '0' } })).render.cols).toBe(80);
  });
});

describe('the stderr progress line', () => {
  it('appears only on a TTY after the 500 ms tick, updates, and clears before output', () => {
    vi.useFakeTimers();
    const err = sink();
    const ctx = ctxFor(['audit'], { isTTY: true, stderr: err });
    const progress = startProgress(ctx, { json: false });
    progress.onProgress(1, 4);
    expect(err.text).toBe('');
    vi.advanceTimersByTime(499);
    expect(err.text).toBe('');
    vi.advanceTimersByTime(1);
    expect(err.text).toContain('scanning … 1/4 sessions');
    progress.onProgress(2, 4);
    expect(err.text).toContain('scanning … 2/4 sessions');
    const before = err.text;
    progress.finish();
    expect(err.text.length).toBeGreaterThan(before.length);
    expect(err.text.endsWith('\r')).toBe(true);
    // the clear pass blanks the whole line
    expect(err.text).toContain(`\r${' '.repeat('scanning … 2/4 sessions'.length)}\r`);
    const after = err.text;
    progress.finish(); // idempotent
    progress.onProgress(3, 4); // never paints after finish
    expect(err.text).toBe(after);
  });

  it('stays silent when the timer fires before any progress arrived', () => {
    vi.useFakeTimers();
    const err = sink();
    const progress = startProgress(ctxFor(['audit'], { isTTY: true, stderr: err }), { json: false });
    vi.advanceTimersByTime(1000);
    expect(err.text).toBe('');
    progress.onProgress(1, 2);
    expect(err.text).toContain('scanning … 1/2 sessions');
    progress.finish();
  });

  it('never writes on a non-TTY and never with --json', () => {
    vi.useFakeTimers();
    for (const opts of [
      { isTTY: false, json: false },
      { isTTY: true, json: true },
    ]) {
      const err = sink();
      const progress = startProgress(ctxFor(['audit'], { isTTY: opts.isTTY, stderr: err }), { json: opts.json });
      progress.onProgress(1, 4);
      vi.advanceTimersByTime(2000);
      progress.onProgress(2, 4);
      progress.finish();
      expect(err.text).toBe('');
    }
  });
});

describe('non-hook EPIPE (S23c decision)', () => {
  it('an interrupted pipe does not change the exit code', async () => {
    const stderr = new MemoryStream();
    const code = await main(['--version'], { stdout: new BrokenPipeStream(), stderr, env: { HOME: '/tmp' }, cwd: '/tmp' });
    expect(code).toBe(0);
    // the EPIPE arrives asynchronously; surviving this tick is the pin
    await new Promise((resolve) => setImmediate(resolve));
    expect(stderr.text).toBe('');
  });

  it('a synchronous stdout throw still fails normally (only EPIPE is swallowed)', async () => {
    class ThrowingStream extends Writable {
      override write(): never {
        throw new Error('stdout exploded');
      }
    }
    const stderr = new MemoryStream();
    const code = await main(['--version'], { stdout: new ThrowingStream(), stderr, env: { HOME: '/tmp' }, cwd: '/tmp' });
    expect(code).toBe(1);
    expect(stderr.text).toContain('stdout exploded');
  });
});
