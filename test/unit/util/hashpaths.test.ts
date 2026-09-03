/**
 * S18 — `util/hashpaths.ts hashStrings`: the §11.2 `--hash-paths` pass.
 * Every absolute path in every string field is rewritten (inside cwd →
 * relative, outside → `p:<8 hex>/basename`), relative paths and URLs are
 * left alone, the walk copies, and the salt never leaks.
 */
import { describe, expect, it } from 'vitest';
import { hashStrings } from '../../../src/util/hashpaths.js';

const CWD = '/home/u/proj';
const SALT = 's3cret-salt';

const hash = <T>(v: T): T => hashStrings(v, SALT, CWD);

describe('absolute paths outside the cwd', () => {
  it('become p:<8 hex>/basename', () => {
    const out = hash('/home/u/other/notes.txt');
    expect(out).toMatch(/^p:[0-9a-f]{8}\/notes\.txt$/);
  });

  it('are deterministic for one salt and differ across salts', () => {
    const a = hashStrings('/etc/hosts', 'salt-a', CWD);
    const b = hashStrings('/etc/hosts', 'salt-a', CWD);
    const c = hashStrings('/etc/hosts', 'salt-b', CWD);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('rewrites ~/ paths and drive-letter paths', () => {
    expect(hash('~/secrets/id_rsa')).toMatch(/^p:[0-9a-f]{8}\/id_rsa$/);
    expect(hash('C:\\Users\\u\\x.ts')).toMatch(/^p:[0-9a-f]{8}\/x\.ts$/);
    expect(hash('C:/Users/u/x.ts')).toMatch(/^p:[0-9a-f]{8}\/x\.ts$/);
  });

  it('never leaks the salt or the original directory', () => {
    const out = hash('wrote /home/u/private/journal.md today');
    expect(out).not.toContain(SALT);
    expect(out).not.toContain('/home/u/private');
    expect(out).toContain('journal.md');
  });
});

describe('paths under the cwd', () => {
  it('become relative', () => {
    expect(hash('/home/u/proj/src/app.py')).toBe('src/app.py');
  });

  it('the cwd itself becomes .', () => {
    expect(hash('/home/u/proj')).toBe('.');
  });

  it('a sibling with the cwd as a prefix is not "under" it', () => {
    expect(hash('/home/u/proj2/x.py')).toMatch(/^p:[0-9a-f]{8}\/x\.py$/);
  });
});

describe('what is left alone', () => {
  it('relative paths', () => {
    expect(hash('src/pipeline/run.ts')).toBe('src/pipeline/run.ts');
    expect(hash('edited tests/test_x.py after the run')).toBe('edited tests/test_x.py after the run');
  });

  it('URLs, dates, ratios and $VAR paths', () => {
    expect(hash('https://example.com/a/b')).toBe('https://example.com/a/b');
    expect(hash('on 18/05 at 12:00')).toBe('on 18/05 at 12:00');
    expect(hash('41/41 tests')).toBe('41/41 tests');
    expect(hash('rm -rf $TMPDIR/scratch')).toBe('rm -rf $TMPDIR/scratch');
  });

  it('non-string values and object keys', () => {
    const input = { '/home/u/keyish': 42, n: 3, ok: true, nil: null };
    const out = hash(input);
    expect(Object.keys(out)).toContain('/home/u/keyish');
    expect(out.n).toBe(3);
    expect(out.ok).toBe(true);
    expect(out.nil).toBeNull();
  });
});

describe('embedded and structured occurrences', () => {
  it('rewrites paths inside evidence-style sentences and backticks', () => {
    const out = hash('no write to `/home/u/elsewhere/config.json` in log (src/x.ts ok)');
    expect(out).toMatch(/no write to `p:[0-9a-f]{8}\/config\.json` in log \(src\/x\.ts ok\)/);
  });

  it('walks arrays and nested objects without mutating the input', () => {
    const input = {
      lines: [{ evidence: ['Edit /home/u/proj/a.ts', 'Write /var/tmp/x.bin'] }],
      cwd: CWD,
    };
    const before = JSON.stringify(input);
    const out = hash(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(out.cwd).toBe('.');
    const evidence = out.lines[0]?.evidence as string[];
    expect(evidence[0]).toBe('Edit a.ts');
    expect(evidence[1]).toMatch(/^Write p:[0-9a-f]{8}\/x\.bin$/);
  });

  it('two mentions of one path hash identically within a run', () => {
    const out = hash(['/opt/tool/bin/x', 'ran /opt/tool/bin/x again']);
    const token = /p:[0-9a-f]{8}\/x/.exec(out[0] as string)?.[0];
    expect(token).toBeDefined();
    expect(out[1]).toContain(token as string);
  });
});

describe('extra tokens (§11.2 bare username/home tokens)', () => {
  const USER = 'casey123x';
  const HOME = `/Users/${USER}`;
  const hashU = <T>(v: T): T => hashStrings(v, SALT, CWD, [HOME, USER]);

  it('rewrites a bare username token to u:<8 hex>', () => {
    expect(hashU(`ran as ${USER} on ci`)).toMatch(/^ran as u:[0-9a-f]{8} on ci$/);
  });

  it('catches the username surviving as a hashed home basename or inside a URL', () => {
    const out = hashU(`saved to ${HOME} and file://${HOME}/x.txt`);
    expect(out).not.toContain(USER);
    expect(out).not.toContain(SALT);
  });

  it('never matches inside a longer word', () => {
    expect(hashU(`${USER}tail stays`)).toBe(`${USER}tail stays`);
    expect(hashU(`prefix${USER} stays`)).toBe(`prefix${USER} stays`);
  });

  it('is deterministic per salt and differs across salts', () => {
    const a = hashStrings(USER, 'salt-a', CWD, [USER]);
    const b = hashStrings(USER, 'salt-a', CWD, [USER]);
    const c = hashStrings(USER, 'salt-b', CWD, [USER]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^u:[0-9a-f]{8}$/);
  });

  it('an omitted or empty list keeps the 3-argument behaviour', () => {
    const s = `mixed ${USER} and /home/u/other/notes.txt`;
    expect(hashStrings(s, SALT, CWD, [])).toBe(hashStrings(s, SALT, CWD));
    expect(hashStrings(s, SALT, CWD)).toContain(USER);
  });

  it('ignores degenerate 1-character tokens', () => {
    expect(hashStrings('a u b', SALT, CWD, ['u'])).toBe('a u b');
  });
});
