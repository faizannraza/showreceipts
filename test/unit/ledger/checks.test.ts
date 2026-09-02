/**
 * S13 — check summaries (§4.6.5): program-keyed parsers (ruff, mypy, eslint,
 * tsc, prettier, clippy, go vet, mkdocs, biome, pyright), the tri-state
 * `green`, `autoFixed`, scope, and the never-cross-programs rule. Real tails
 * for ruff/mypy/eslint/tsc live in `fixtures/runners/`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractChecks } from '../../../src/ledger/checks.js';
import { attributeExit, tokenize } from '../../../src/ledger/shell/index.js';
import type { CheckRun, CommandFact, ToolCall } from '../../../src/model/types.js';

function fixture(name: string): string {
  return readFileSync(new URL(`../../../fixtures/runners/${name}`, import.meta.url), 'utf8');
}

let seq = 0;

function makeCall(command: string, resultText: string, exit: number | null, over: Partial<ToolCall> = {}): ToolCall {
  seq += 1;
  return {
    seq,
    id: `t${seq}`,
    tool: 'Bash',
    kind: 'shell',
    agentId: null,
    turnIndex: 0,
    cwd: '/home/u/proj',
    input: {},
    command,
    resultText,
    resultBytes: resultText.length,
    isError: false,
    exitCode: exit,
    exitCodeSource: exit === null ? 'unknown' : 'harness',
    interrupted: false,
    background: false,
    startedAt: '2026-03-01T00:00:00Z',
    endedAt: null,
    filesTouched: [],
    ...over,
  };
}

function factOf(call: ToolCall): CommandFact {
  const parse = tokenize(call.command ?? '', call.cwd, { home: '/home/u' });
  attributeExit(parse, call.exitCode, call.exitCodeSource, call.resultText);
  return {
    seq: call.seq,
    toolCallId: call.id,
    agentId: call.agentId,
    raw: call.command ?? '',
    segments: parse.segments,
    exitCode: call.exitCode,
    exitCodeSource: call.exitCodeSource,
    chained: parse.chained,
    background: call.background || parse.background,
    interrupted: call.interrupted,
  };
}

function checkOn(command: string, resultText: string, exit: number | null, over: Partial<ToolCall> = {}): CheckRun[] {
  const call = makeCall(command, resultText, exit, over);
  return extractChecks([factOf(call)], [call]);
}

describe('ruff (§4.6.5)', () => {
  it('All checks passed! is green', () => {
    const [check] = checkOn('ruff check .', fixture('ruff-green.txt'), 0);
    expect(check).toMatchObject({ family: 'lint', tool: 'ruff check', scope: 'full', green: true, summary: 'All checks passed!' });
  });

  it('Found 1 error. is red', () => {
    const [check] = checkOn('ruff check .', fixture('ruff-red.txt'), 1);
    expect(check?.green).toBe(false);
    expect(check?.summary).toBe('Found 1 error.');
  });

  it('Found 1 error (1 fixed, 0 remaining). is green and auto-fixed', () => {
    const [check] = checkOn('ruff check --fix .', fixture('ruff-fixed.txt'), 0);
    expect(check?.green).toBe(true);
    expect(check?.autoFixed).toBe(true);
  });

  it('remaining > 0 is red even with fixes', () => {
    const [check] = checkOn('ruff check --fix .', 'Found 3 errors (1 fixed, 2 remaining).\n', 1);
    expect(check?.green).toBe(false);
    expect(check?.autoFixed).toBe(true);
  });

  it('a parse warning is informational — exit decides', () => {
    const [check] = checkOn('ruff check .', 'warning: Failed to parse src/x.py:1:1\n', 0);
    expect(check?.green).toBe(true);
    expect(check?.summary).toContain('Failed to parse');
  });

  it('ruff format --check green and red', () => {
    const [ok] = checkOn('ruff format --check .', '5 files already formatted\n', 0);
    expect(ok).toMatchObject({ family: 'format', tool: 'ruff format', green: true, summary: '5 files already formatted' });
    const [red] = checkOn('ruff format --check .', 'Would reformat: src/x.py\n1 file would be reformatted\n', 1);
    expect(red?.green).toBe(false);
    expect(red?.summary).toBe('1 file would be reformatted');
  });

  it('a bare formatter write is not a check', () => {
    expect(checkOn('ruff format .', '2 files reformatted\n', 0)).toHaveLength(0);
    expect(checkOn('prettier --write .', '', 0)).toHaveLength(0);
  });
});

describe('mypy / tsc / eslint / prettier / pyright', () => {
  it('mypy success and failure summaries', () => {
    const [ok] = checkOn('mypy .', fixture('mypy-green.txt'), 0);
    expect(ok).toMatchObject({ family: 'type', tool: 'mypy', green: true, summary: 'Success: no issues found in 48 source files' });
    const [red] = checkOn('mypy .', fixture('mypy-red.txt'), 1);
    expect(red?.green).toBe(false);
    expect(red?.summary).toBe('Found 1 error in 1 file (checked 48 source files)');
  });

  it('mypy errors-prevented-further-checking is red', () => {
    const [check] = checkOn('mypy .', 'Found 1 error in 1 file (errors prevented further checking)\n', 2);
    expect(check?.green).toBe(false);
  });

  it('tsc is red iff an error TS line appears', () => {
    const [red] = checkOn('npx tsc --noEmit', fixture('tsc-red.txt'), 2);
    expect(red).toMatchObject({ family: 'type', tool: 'tsc', green: false, summary: 'Found 2 errors in 1 file.' });
    const [silent] = checkOn('npx tsc --noEmit', '', 0);
    expect(silent?.green).toBe(true);
    expect(silent?.summary).toBeUndefined();
  });

  it('tsc pretty errors without a Found line still summarise', () => {
    const [check] = checkOn('npx tsc --noEmit', 'src/x.ts:1:1 - error TS2554: boom\n', 2);
    expect(check?.green).toBe(false);
    expect(check?.summary).toBe('1 type error');
  });

  it("ruff's Found N errors. is not read by tsc (never cross programs)", () => {
    const [check] = checkOn('npx tsc --noEmit', 'Found 2 errors.\n', 0);
    expect(check?.green).toBe(true);
    expect(check?.summary).toBeUndefined();
  });

  it('eslint problems summary is red iff errors > 0', () => {
    const [red] = checkOn('npx eslint src/', fixture('eslint-red.txt'), 1);
    expect(red).toMatchObject({ family: 'lint', tool: 'eslint', scope: 'subset', green: false, summary: '✖ 2 problems (2 errors, 0 warnings)' });
    const [warnOnly] = checkOn('npx eslint .', '✖ 3 problems (0 errors, 3 warnings)\n', 0);
    expect(warnOnly?.green).toBe(true);
    const [silent] = checkOn('npx eslint .', '', 0);
    expect(silent?.green).toBe(true);
  });

  it('prettier --check green and red', () => {
    const [ok] = checkOn('prettier --check .', 'All matched files use Prettier code style!\n', 0);
    expect(ok?.green).toBe(true);
    const [red] = checkOn('prettier --check .', '[warn] src/x.ts\n[warn] Code style issues found in the above file. Run Prettier with --write to fix.\n', 1);
    expect(red?.green).toBe(false);
    expect(red?.summary).toContain('Code style issues found');
  });

  it('pyright N errors summary', () => {
    const [red] = checkOn('pyright', '1 error, 0 warnings, 0 informations\n', 1);
    expect(red).toMatchObject({ family: 'type', green: false, summary: '1 error, 0 warnings, 0 informations' });
    const [ok] = checkOn('pyright', '0 errors, 0 warnings, 0 informations\n', 0);
    expect(ok?.green).toBe(true);
  });
});

describe('exit-only programs, mkdocs and biome', () => {
  it('clippy and go vet are judged by exit alone', () => {
    const [clippy] = checkOn('cargo clippy', 'warning: unused variable\n', 0);
    expect(clippy).toMatchObject({ family: 'lint', tool: 'cargo clippy', green: true });
    const [vet] = checkOn('go vet ./...', 'suspicious call\n', 1);
    expect(vet).toMatchObject({ family: 'lint', tool: 'go vet', green: false });
  });

  it('mkdocs build summaries', () => {
    const [ok] = checkOn('mkdocs build', 'INFO    -  Documentation built in 0.52 seconds\n', 0);
    expect(ok).toMatchObject({ family: 'build', green: true });
    const [red] = checkOn('mkdocs build', 'ERROR   -  Config value site_name is required\n', 1);
    expect(red?.green).toBe(false);
    expect(red?.summary).toContain('ERROR');
  });

  it('biome lint summaries', () => {
    const [ok] = checkOn('biome lint src/', 'Checked 5 files in 2ms. No fixes applied.\n', 0);
    expect(ok).toMatchObject({ tool: 'biome lint', green: true });
    const [red] = checkOn('biome check .', 'Found 2 errors.\n', 1);
    expect(red?.green).toBe(false);
  });

  it('npm run lint is exit-only with the script tool name', () => {
    const [check] = checkOn('npm run lint', 'all clean\n', 0);
    expect(check).toMatchObject({ family: 'lint', tool: 'npm-script:lint', green: true });
  });
});

describe('tri-state and skip rules', () => {
  it('a sink-piped check with no summary is unknown', () => {
    const [check] = checkOn('npx eslint src/ | tail -3', '', 0);
    expect(check?.green).toBe('unknown');
    expect(check?.exitCode).toBeNull();
  });

  it('a green summary never survives a non-zero exit', () => {
    const [check] = checkOn('ruff check .', 'All checks passed!\n', 1);
    expect(check?.green).toBe(false);
  });

  it('background, denied and short-circuited checks produce no CheckRun', () => {
    expect(checkOn('npx eslint . &', '', null)).toHaveLength(0);
    expect(checkOn('npx eslint .', '', null, { denied: 'permission-rule' })).toHaveLength(0);
    const chained = checkOn('npx tsc --noEmit && npx eslint .', 'src/a.ts(1,1): error TS2322: bad\n', 2);
    expect(chained).toHaveLength(1); // tsc red; eslint short-circuited
    expect(chained[0]?.tool).toBe('tsc');
    expect(chained[0]?.green).toBe(false);
  });

  it('one chained command yields one CheckRun per check segment', () => {
    const text = 'All checks passed!\nSuccess: no issues found in 44 source files\n';
    const checks = checkOn('ruff check . && mypy .', text, 0);
    expect(checks.map((c) => [c.tool, c.green])).toEqual([
      ['ruff check', true],
      ['mypy', true],
    ]);
  });

  it('scope is subset with a positional path, full with flags or dot', () => {
    const [subset] = checkOn('mypy src/api.py', '', 0);
    expect(subset?.scope).toBe('subset');
    const [full] = checkOn('npx tsc -p tsconfig.json --noEmit', '', 0);
    expect(full?.scope).toBe('full');
  });

  it('long summaries are clipped to 80 characters', () => {
    const long = `ERROR   -  ${'x'.repeat(120)}\n`;
    const [check] = checkOn('mkdocs build', long, 1);
    expect(check?.summary?.length).toBe(80);
    expect(check?.summary?.endsWith('…')).toBe(true);
  });
});
