import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  FLAG_SPECS,
  flagDefault,
  flagKind,
  flagsFor,
  isCalendarDate,
  parse,
  parseIsoTimestamp,
  peekCommand,
  UsageError,
  type CommandName,
} from '../../../src/cli/args.js';

function usageError(argv: string[]): UsageError {
  try {
    parse(argv);
  } catch (err) {
    if (err instanceof UsageError) return err;
    throw err;
  }
  throw new Error(`expected a UsageError for ${JSON.stringify(argv)}`);
}

describe('parse: commands and positionals', () => {
  it('defaults to audit with no argv', () => {
    expect(parse([])).toEqual({ command: 'audit', commandGiven: false, positionals: [], flags: {}, unknown: [] });
  });

  it('recognises every command name', () => {
    for (const command of COMMANDS) {
      const parsed = parse([command]);
      expect(parsed.command).toBe(command);
      expect(parsed.commandGiven).toBe(true);
      expect(parsed.positionals).toEqual([]);
    }
  });

  it('collects the session/export id and the hook harness/event as positionals', () => {
    expect(parse(['session', 'abc123']).positionals).toEqual(['abc123']);
    expect(parse(['session', 'latest', '--json']).positionals).toEqual(['latest']);
    expect(parse(['export', '/path/to/transcript.jsonl', '--md']).positionals).toEqual(['/path/to/transcript.jsonl']);
    expect(parse(['hook', 'claude-code', 'Stop']).positionals).toEqual(['claude-code', 'Stop']);
  });

  it('rejects an unknown command with exit 2', () => {
    const err = usageError(['bogus']);
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe("unknown command 'bogus'");
    expect(err.command).toBe('audit');
  });

  it("treats bare 'help' as --help (git/npm muscle memory)", () => {
    const parsed = parse(['help']);
    expect(parsed.command).toBe('audit');
    expect(parsed.flags['help']).toBe(true);
    expect(parsed.positionals).toEqual([]);
  });

  it('suggests the nearest command for a close typo (edit distance ≤ 2)', () => {
    expect(usageError(['sessions']).message).toBe("unknown command 'sessions' — did you mean 'session'?");
    expect(usageError(['doctr']).message).toBe("unknown command 'doctr' — did you mean 'doctor'?");
    expect(usageError(['benchh']).message).toBe("unknown command 'benchh' — did you mean 'bench'?");
  });

  it('rejects surplus positionals naming the command', () => {
    expect(usageError(['audit', 'extra']).message).toBe("audit: unexpected argument 'extra'");
    expect(usageError(['session', 'a', 'b']).message).toBe("session: unexpected argument 'b'");
    expect(usageError(['demo', 'x']).message).toBe("demo: unexpected argument 'x'");
  });

  it('accepts flags before the command', () => {
    const parsed = parse(['--json', '--since', '30d', 'session', 'abc']);
    expect(parsed.command).toBe('session');
    expect(parsed.positionals).toEqual(['abc']);
    expect(parsed.flags).toEqual({ json: true, since: '30d' });
  });

  it('treats a positional named like a command as an id once the command is known', () => {
    expect(parse(['session', 'session']).positionals).toEqual(['session']);
  });

  it('treats everything after -- as positional', () => {
    expect(parse(['session', '--', '--not-a-flag']).positionals).toEqual(['--not-a-flag']);
    expect(usageError(['--', 'audit']).message).toBe("unknown command 'audit' — did you mean 'audit'?");
  });

  it('treats a lone dash and an empty token as positionals', () => {
    expect(parse(['export', '-']).positionals).toEqual(['-']);
    expect(usageError(['']).message).toBe("unknown command ''");
  });

  it('rejects short options other than -h', () => {
    expect(usageError(['-x']).message).toBe("unknown option '-x'");
    expect(usageError(['-1']).message).toBe("unknown option '-1'");
  });
});

describe('parse: flag forms', () => {
  it('accepts --flag value and --flag=value', () => {
    expect(parse(['--width', '80']).flags['width']).toBe(80);
    expect(parse(['--width=80']).flags['width']).toBe(80);
    expect(parse(['--since=2026-01-01']).flags['since']).toBe('2026-01-01');
  });

  it('parses the acceptance-criteria line --width=80 --harness claude-code,codex', () => {
    expect(parse(['--width=80', '--harness', 'claude-code,codex']).flags).toEqual({
      width: 80,
      harness: ['claude-code', 'codex'],
    });
  });

  it('accepts --no-color and --no-cache as plain booleans', () => {
    expect(parse(['--no-color']).flags['no-color']).toBe(true);
    expect(parse(['--no-cache', '--json']).flags).toEqual({ 'no-cache': true, json: true });
  });

  it('accepts explicit boolean values', () => {
    expect(parse(['--json=false']).flags['json']).toBe(false);
    expect(parse(['--json=0']).flags['json']).toBe(false);
    expect(parse(['--json=no']).flags['json']).toBe(false);
    expect(parse(['--json=true']).flags['json']).toBe(true);
    expect(parse(['--json=1']).flags['json']).toBe(true);
    expect(parse(['--json=yes']).flags['json']).toBe(true);
    expect(usageError(['--json=maybe']).message).toBe("--json: expected true or false (got 'maybe')");
  });

  it('merges repeated and comma-separated lists, de-duplicated, whitespace trimmed', () => {
    expect(parse(['--harness', 'claude-code', '--harness', 'codex']).flags['harness']).toEqual(['claude-code', 'codex']);
    expect(parse(['--harness', 'claude-code,codex']).flags['harness']).toEqual(['claude-code', 'codex']);
    expect(parse(['--harness', 'a, b,,c', '--harness=c,d']).flags['harness']).toEqual(['a', 'b', 'c', 'd']);
    expect(parse(['hook', 'x', '--strict-reasons', 'no-test-run,last-run-red']).flags['strict-reasons']).toEqual([
      'no-test-run',
      'last-run-red',
    ]);
  });

  it('accepts --hash-paths as a bool and --hash-paths=both', () => {
    expect(parse(['report', '--hash-paths']).flags['hash-paths']).toBe(true);
    expect(parse(['report', '--hash-paths=both']).flags['hash-paths']).toBe('both');
    expect(parse(['export', 'latest', '--hash-paths=both']).flags['hash-paths']).toBe('both');
    expect(usageError(['report', '--hash-paths=nope']).message).toBe("--hash-paths: expected true or false or both (got 'nope')");
  });

  it('accepts --publish with and without a value', () => {
    expect(parse(['bench', '--publish']).flags['publish']).toBe(true);
    expect(parse(['bench', '--publish', 'out.json']).flags['publish']).toBe('out.json');
    expect(parse(['bench', '--publish=out.json']).flags['publish']).toBe('out.json');
    const parsed = parse(['bench', '--publish', '--json']);
    expect(parsed.flags).toEqual({ publish: true, json: true });
  });

  it('types --project as a string for audit|session|report|bench and a bool for setup', () => {
    for (const command of ['audit', 'session', 'report', 'bench'] as const) {
      const argv = command === 'session' ? [command, 'latest', '--project', 'myproj'] : [command, '--project', 'myproj'];
      expect(parse(argv).flags['project']).toBe('myproj');
    }
    expect(parse(['setup', '--project']).flags['project']).toBe(true);
    expect(parse(['setup', '--project', '--strict']).flags).toEqual({ project: true, strict: true });
    expect(usageError(['setup', '--project=myproj']).message).toBe("--project: expected true or false (got 'myproj')");
    expect(usageError(['setup', '--project', 'myproj']).message).toBe("setup: unexpected argument 'myproj'");
  });

  it('parses the session and export flags', () => {
    expect(parse(['session', 'abc', '--turn', '3', '--explain-claim', '--timeline', '--json']).flags).toEqual({
      turn: 3,
      'explain-claim': true,
      timeline: true,
      json: true,
    });
    expect(parse(['export', 'latest', '--md', '--out', 'receipt.md', '--timeline', '--turn=0']).flags).toEqual({
      md: true,
      out: 'receipt.md',
      timeline: true,
      turn: 0,
    });
  });

  it('parses the report flags', () => {
    expect(parse(['report', '--out', 'r.html', '--open', '--full', '5', '--bench', '--limit', '10']).flags).toEqual({
      out: 'r.html',
      open: true,
      full: 5,
      bench: true,
      limit: 10,
    });
  });

  it('parses the setup flags', () => {
    expect(parse(['setup', '--dry-run', '--remove', '--restore', '/tmp/b.1', '--shared', '--all', '--harness', 'codex']).flags).toEqual({
      'dry-run': true,
      remove: true,
      restore: '/tmp/b.1',
      shared: true,
      all: true,
      harness: ['codex'],
    });
  });

  it('parses the hook flags', () => {
    const parsed = parse([
      'hook',
      'claude-code',
      'Stop',
      '--strict',
      '--strict-max',
      '2',
      '--strict-reasons',
      'no-test-run',
      '--force-record',
      '--verbose',
      '--debug',
    ]);
    expect(parsed.flags).toEqual({
      strict: true,
      'strict-max': 2,
      'strict-reasons': ['no-test-run'],
      'force-record': true,
      verbose: true,
      debug: true,
    });
    expect(parsed.unknown).toEqual([]);
  });

  it('parses the doctor and bench flags', () => {
    expect(parse(['doctor', '--clear-cache', '--prune-ledgers', '30', '--verbose', '--json']).flags).toEqual({
      'clear-cache': true,
      'prune-ledgers': 30,
      verbose: true,
      json: true,
    });
    expect(parse(['bench', '--month', '2026-08', '--since', '30d', '--harness', 'codex']).flags).toEqual({
      month: '2026-08',
      since: '30d',
      harness: ['codex'],
    });
  });

  it('accepts the hidden --home-dir and --svg flags', () => {
    expect(parse(['--home-dir', '/home/u']).flags['home-dir']).toBe('/home/u');
    expect(parse(['demo', '--svg', 'out.svg', '--width', '74', '--tz', 'utc', '--ascii', '--unicode']).flags).toEqual({
      svg: 'out.svg',
      width: 74,
      tz: 'utc',
      ascii: true,
      unicode: true,
    });
  });

  it('lets a repeated scalar flag win last', () => {
    expect(parse(['--width', '80', '--width', '100']).flags['width']).toBe(100);
  });

  it('accepts -h and --help, --version', () => {
    expect(parse(['-h']).flags['help']).toBe(true);
    expect(parse(['audit', '--help']).flags['help']).toBe(true);
    expect(parse(['--version']).flags['version']).toBe(true);
  });
});

describe('parse: validation errors', () => {
  it('rejects unknown options naming the token', () => {
    expect(usageError(['--bogus']).message).toBe("unknown option '--bogus'");
    expect(usageError(['audit', '--bogus=1']).message).toBe("unknown option '--bogus'");
  });

  it('rejects a flag another command owns, naming this command', () => {
    expect(usageError(['audit', '--turn', '1']).message).toBe('--turn is not valid for audit');
    expect(usageError(['demo', '--since', '30d']).message).toBe('--since is not valid for demo');
    expect(usageError(['setup', '--width', '80']).message).toBe('--width is not valid for setup');
  });

  it('rejects a missing value', () => {
    expect(usageError(['--width']).message).toBe('--width: missing value');
    expect(usageError(['report', '--out', '--json']).message).toBe('--out: missing value');
    expect(usageError(['--tz']).message).toBe('--tz: missing value');
  });

  it('validates --width as an integer in 40–200 and keeps values above 102', () => {
    expect(usageError(['audit', '--width', '30']).message).toBe("--width: expected an integer between 40 and 200 (got '30')");
    expect(usageError(['--width', '201']).message).toBe("--width: expected an integer between 40 and 200 (got '201')");
    expect(usageError(['--width', 'abc']).message).toBe("--width: expected an integer between 40 and 200 (got 'abc')");
    expect(usageError(['--width', '80.5']).message).toContain('--width');
    expect(parse(['--width', '40']).flags['width']).toBe(40);
    expect(parse(['--width', '150']).flags['width']).toBe(150);
    expect(parse(['--width', '200']).flags['width']).toBe(200);
  });

  it('validates --since/--until as YYYY-MM-DD or <N>d', () => {
    expect(parse(['--since', '2026-01-01', '--until', '7d']).flags).toEqual({ since: '2026-01-01', until: '7d' });
    expect(parse(['--since', '90d']).flags['since']).toBe('90d');
    expect(usageError(['--since', 'yesterday']).message).toBe("--since: expected YYYY-MM-DD or <N>d (got 'yesterday')");
    expect(usageError(['--until', '2026-1-1']).message).toBe("--until: expected YYYY-MM-DD or <N>d (got '2026-1-1')");
    expect(usageError(['--since', 'd']).message).toContain('--since');
  });

  it('validates --as-of as a real calendar date with the §8.1 message', () => {
    expect(parse(['--as-of', '2026-02-28']).flags['as-of']).toBe('2026-02-28');
    expect(parse(['--as-of', '2024-02-29']).flags['as-of']).toBe('2024-02-29');
    expect(usageError(['audit', '--as-of', '2026-02-30']).message).toBe('--as-of: expected YYYY-MM-DD');
    expect(usageError(['--as-of', '2023-02-29']).message).toBe('--as-of: expected YYYY-MM-DD');
    expect(usageError(['--as-of', '2026-13-01']).message).toBe('--as-of: expected YYYY-MM-DD');
    expect(usageError(['--as-of', '2026-04-31']).message).toBe('--as-of: expected YYYY-MM-DD');
    expect(usageError(['--as-of', '20260101']).message).toBe('--as-of: expected YYYY-MM-DD');
    expect(usageError(['--as-of', '30d']).message).toBe('--as-of: expected YYYY-MM-DD');
  });

  it('validates --now as ISO-8601', () => {
    expect(parse(['--now', '2026-08-29T12:00:00Z']).flags['now']).toBe('2026-08-29T12:00:00Z');
    expect(parse(['--now', '2026-08-29']).flags['now']).toBe('2026-08-29');
    expect(parse(['--now', '2026-08-29T12:00:00.123+02:00']).flags['now']).toBe('2026-08-29T12:00:00.123+02:00');
    expect(usageError(['--now', 'nope']).message).toBe("--now: expected an ISO-8601 timestamp (got 'nope')");
    expect(usageError(['--now', '2026-02-30T00:00:00Z']).message).toContain('--now');
    expect(usageError(['--now', '1700000000']).message).toContain('--now');
  });

  it('validates --tz as local|utc', () => {
    expect(parse(['--tz', 'local']).flags['tz']).toBe('local');
    expect(parse(['--tz=utc']).flags['tz']).toBe('utc');
    expect(usageError(['--tz', 'pst']).message).toBe("--tz: expected one of local, utc (got 'pst')");
  });

  it('validates --month as YYYY-MM', () => {
    expect(usageError(['bench', '--month', '2026-13']).message).toBe("--month: expected YYYY-MM (got '2026-13')");
    expect(usageError(['bench', '--month', '202608']).message).toBe("--month: expected YYYY-MM (got '202608')");
    expect(parse(['bench', '--month', '2026-12']).flags['month']).toBe('2026-12');
  });

  it('validates the non-negative integer flags', () => {
    expect(parse(['--limit', '0']).flags['limit']).toBe(0);
    expect(usageError(['--limit', '-1']).message).toBe("--limit: expected a non-negative integer (got '-1')");
    expect(usageError(['--limit', '1.5']).message).toBe("--limit: expected a non-negative integer (got '1.5')");
    expect(usageError(['--limit', '99999999999999999999']).message).toContain('--limit');
    expect(usageError(['session', 'x', '--turn', 'two']).message).toBe("--turn: expected a non-negative integer (got 'two')");
    expect(usageError(['report', '--full', '-3']).message).toBe("--full: expected a non-negative integer (got '-3')");
    expect(usageError(['doctor', '--prune-ledgers', 'x']).message).toBe("--prune-ledgers: expected a non-negative integer (got 'x')");
  });

  it('never leaks a stack trace: every problem is a UsageError with exitCode 2', () => {
    for (const argv of [['bogus'], ['--width', '30'], ['--as-of', '2026-02-30'], ['--bogus'], ['audit', 'x'], ['--limit']]) {
      const err = usageError(argv);
      expect(err).toBeInstanceOf(UsageError);
      expect(err.name).toBe('UsageError');
      expect(err.exitCode).toBe(2);
    }
  });
});

describe('parse: hook never throws', () => {
  it('collects unrecognised tokens in unknown and keeps going', () => {
    const parsed = parse(['hook', 'nope', '--whatever', '--strict-max', 'abc', '--strict', 'extra1', 'extra2', '-h']);
    expect(parsed.command).toBe('hook');
    expect(parsed.positionals).toEqual(['nope', 'extra1']);
    expect(parsed.flags).toEqual({ strict: true });
    expect(parsed.unknown).toEqual(['--whatever', '--strict-max=abc', 'extra2', '-h']);
  });

  it('routes --help, --version and --json to unknown for hook', () => {
    const parsed = parse(['hook', 'claude-code', '--help', '--version', '--json']);
    expect(parsed.flags).toEqual({});
    expect(parsed.unknown).toEqual(['--help', '--version', '--json']);
  });

  it('records a missing value without throwing', () => {
    const parsed = parse(['hook', 'codex', 'Stop', '--strict-max']);
    expect(parsed.unknown).toEqual(['--strict-max']);
    expect(parsed.positionals).toEqual(['codex', 'Stop']);
  });

  it('finds hook even after leading flags', () => {
    expect(parse(['--debug', 'hook', 'cursor', 'stop', '--bogus']).unknown).toEqual(['--bogus']);
  });
});

describe('peekCommand', () => {
  it('skips flag values while looking for the command', () => {
    expect(peekCommand(['--since', '30d', 'session', 'x'])).toEqual({ command: 'session', given: true });
    expect(peekCommand(['--project', 'setup'])).toEqual({ command: 'audit', given: false });
    expect(peekCommand(['--publish', 'bench'])).toEqual({ command: 'audit', given: false });
    expect(peekCommand(['--publish', '--json', 'bench'])).toEqual({ command: 'bench', given: true });
    expect(peekCommand(['--json', 'doctor'])).toEqual({ command: 'doctor', given: true });
    expect(peekCommand(['--width=80', 'demo'])).toEqual({ command: 'demo', given: true });
    expect(peekCommand(['--bogus', 'demo'])).toEqual({ command: 'demo', given: true });
    expect(peekCommand(['--since'])).toEqual({ command: 'audit', given: false });
    expect(peekCommand(['--', 'demo'])).toEqual({ command: 'audit', given: false });
    expect(peekCommand(['bogus'])).toEqual({ command: 'audit', given: false });
    expect(peekCommand([])).toEqual({ command: 'audit', given: false });
  });
});

describe('flag table', () => {
  it('has unique names and lists only known commands', () => {
    const names = FLAG_SPECS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const spec of FLAG_SPECS) {
      expect(spec.commands.length).toBeGreaterThan(0);
      for (const c of spec.commands) expect(COMMANDS).toContain(c);
    }
  });

  it('exposes per-command flag lists, kinds and defaults', () => {
    const setupFlags = flagsFor('setup').map((s) => s.name);
    expect(setupFlags).toContain('dry-run');
    expect(setupFlags).not.toContain('width');
    const project = FLAG_SPECS.find((s) => s.name === 'project');
    expect(project && flagKind(project, 'setup')).toBe('bool');
    expect(project && flagKind(project, 'audit')).toBe('string');
    expect(flagDefault('since')).toBe('90d');
    expect(flagDefault('limit')).toBe(20);
    expect(flagDefault('nope')).toBeUndefined();
  });

  it('accepts every §12.1 synopsis flag for its command', () => {
    const synopsis: Record<CommandName, string[]> = {
      audit: ['--since', '--until', '--all', '--harness', '--project', '--limit', '--all-claims', '--json', '--no-cache', '--as-of', '--prices', '--width', '--ascii', '--unicode', '--no-color', '--tz', '--now'],
      session: ['--turn', '--json', '--explain-claim', '--timeline', '--no-cache'],
      report: ['--out', '--open', '--hash-paths', '--full', '--since', '--harness', '--project', '--limit', '--json'],
      export: ['--md', '--json', '--out', '--hash-paths', '--timeline', '--turn'],
      setup: ['--harness', '--all', '--dry-run', '--remove', '--restore', '--strict', '--project', '--shared', '--json'],
      hook: ['--strict', '--strict-max', '--strict-reasons', '--force-record', '--verbose', '--debug'],
      demo: ['--json', '--width', '--ascii', '--tz'],
      bench: ['--since', '--month', '--harness', '--publish', '--json'],
      doctor: ['--json', '--clear-cache', '--prune-ledgers', '--verbose'],
    };
    for (const [command, flags] of Object.entries(synopsis) as [CommandName, string[]][]) {
      const accepted = flagsFor(command).map((s) => `--${s.name}`);
      for (const flag of flags) expect(accepted, `${command} should accept ${flag}`).toContain(flag);
    }
  });
});

describe('date helpers', () => {
  it('isCalendarDate accepts real dates only', () => {
    expect(isCalendarDate('2026-02-28')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2026-00-10')).toBe(false);
    expect(isCalendarDate('2026-1-1')).toBe(false);
  });

  it('parseIsoTimestamp returns the instant or undefined', () => {
    expect(parseIsoTimestamp('2026-08-29T12:00:00Z')?.toISOString()).toBe('2026-08-29T12:00:00.000Z');
    expect(parseIsoTimestamp('2026-08-29T12:00:00+02:00')?.toISOString()).toBe('2026-08-29T10:00:00.000Z');
    expect(parseIsoTimestamp('2026-08-29')?.toISOString()).toBe('2026-08-29T00:00:00.000Z');
    expect(parseIsoTimestamp('2026-02-30')).toBeUndefined();
    expect(parseIsoTimestamp('not a date')).toBeUndefined();
    expect(parseIsoTimestamp('2026-08-29T25:00:00Z')).toBeUndefined();
  });
});
