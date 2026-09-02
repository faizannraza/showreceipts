import { describe, expect, it } from 'vitest';
import { applyCd, initialCwd, tokenize } from '../../../../src/ledger/shell/index.js';

const cwd = '/home/u/proj';
const opts = { home: '/home/u' };

describe('applyCd (§4.5.3)', () => {
  it('bare cd goes home', () => {
    const s = initialCwd(cwd, '/home/u');
    applyCd(null, true, s);
    expect(s.dir).toBe('/home/u');
  });

  it('cd - poisons the walk but keeps the best guess', () => {
    const s = initialCwd(cwd, '/home/u');
    applyCd('-', true, s);
    expect(s.resolved).toBe(false);
    expect(s.dir).toBe(cwd);
  });

  it('expands ~ with the injected home', () => {
    const s = initialCwd(cwd, '/home/u');
    applyCd('~/work', true, s);
    expect(s.dir).toBe('/home/u/work');
  });
});

describe('walking segments (§4.5.3)', () => {
  it('cd site && npm run build && cd .. && npm test tracks each segment', () => {
    const p = tokenize('cd site && npm run build && cd .. && npm test', cwd, opts);
    expect(p.segments.map((s) => s.cwd)).toEqual([cwd, `${cwd}/site`, `${cwd}/site`, cwd]);
    expect(p.cwdAfter).toBe(cwd);
    expect(p.resolved).toBe(true);
  });

  it('cd to an absolute path', () => {
    const p = tokenize('cd /tmp/scratch && ls', cwd, opts);
    expect(p.segments[1]?.cwd).toBe('/tmp/scratch');
    expect(p.cwdAfter).toBe('/tmp/scratch');
  });

  it('cd $VAR from a same-command literal assignment', () => {
    const p = tokenize('DIR=/tmp/work; cd $DIR && ls', cwd, opts);
    expect(p.cwdAfter).toBe('/tmp/work');
    expect(p.resolved).toBe(true);
  });

  it('cd $UNKNOWN poisons resolution', () => {
    const p = tokenize('cd $UNKNOWN && ls', cwd, opts);
    expect(p.resolved).toBe(false);
  });

  it('pushd/popd poison resolution', () => {
    expect(tokenize('pushd /tmp && ls', cwd, opts).resolved).toBe(false);
    expect(tokenize('popd', cwd, opts).resolved).toBe(false);
  });

  it('a subshell scopes its cd', () => {
    const p = tokenize('(cd site && npm run build) && npm test', cwd, opts);
    const build = p.segments.find((s) => s.program === 'npm-script:build');
    const test = p.segments.find((s) => s.program === 'npm-script:test');
    expect(build?.cwd).toBe(`${cwd}/site`);
    expect(test?.cwd).toBe(cwd);
    expect(p.cwdAfter).toBe(cwd);
  });

  it('cd inside $( ) is ignored for the outer walk', () => {
    const p = tokenize('echo "$(cd /tmp && pwd)" && ls', cwd, opts);
    expect(p.cwdAfter).toBe(cwd);
    expect(p.resolved).toBe(true);
  });

  it('cd inside quotes or heredocs is ignored', () => {
    const p = tokenize("cat <<'EOF'\ncd /tmp\nEOF", cwd, opts);
    expect(p.cwdAfter).toBe(cwd);
    expect(tokenize('echo "cd /tmp"', cwd, opts).cwdAfter).toBe(cwd);
  });

  it('relative cd resolves against the running directory', () => {
    const p = tokenize('cd site && cd packages && ls', cwd, opts);
    expect(p.segments[2]?.cwd).toBe(`${cwd}/site/packages`);
  });

  it('cd ~ and cd ~/dir use the injected home', () => {
    expect(tokenize('cd ~', cwd, opts).cwdAfter).toBe('/home/u');
    expect(tokenize('cd ~/work', cwd, opts).cwdAfter).toBe('/home/u/work');
  });
});
