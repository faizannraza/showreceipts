/**
 * S06 — `records.ts` type guards (§4.2.2, §4.2.4). Every guard is total:
 * `null`, wrong types and missing keys return `false`, never throw.
 */
import { describe, expect, it } from 'vitest';
import {
  asNumber,
  asRecord,
  asString,
  isAgentAsyncResult,
  isAgentResult,
  isBashErrorString,
  isBashSuccess,
  isEditResult,
  isLegacyTaskResult,
  isMcpResult,
  isMultiEditResult,
  isNotebookEditResult,
  isRawUsage,
  isReadResult,
  isWorkflowResult,
  isWriteResult,
  resultShapeKnown,
} from '../../../../src/readers/claude-code/records.js';

describe('primitive coercions', () => {
  it('asRecord rejects arrays, null and primitives', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1, 2])).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asRecord('x')).toBeNull();
  });

  it('asString / asNumber are strict about type and finiteness', () => {
    expect(asString('x')).toBe('x');
    expect(asString(3)).toBeNull();
    expect(asNumber(3)).toBe(3);
    expect(asNumber(Number.NaN)).toBeNull();
    expect(asNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(asNumber('3')).toBeNull();
  });
});

describe('toolUseResult guards never throw', () => {
  const junk: unknown[] = [null, undefined, 0, '', [], {}, { stdout: 1 }, { filePath: 2 }, NaN];

  it('return false for every junk value', () => {
    for (const v of junk) {
      expect(() => {
        isBashSuccess(v);
        isEditResult(v);
        isWriteResult(v);
        isMultiEditResult(v);
        isNotebookEditResult(v);
        isReadResult(v);
        isAgentResult(v);
        isAgentAsyncResult(v);
        isWorkflowResult(v);
        isLegacyTaskResult(v);
        isRawUsage(v);
        isMcpResult(v);
      }).not.toThrow();
    }
  });

  it('isBashSuccess requires string stdout and stderr', () => {
    expect(isBashSuccess({ stdout: 'a', stderr: '' })).toBe(true);
    expect(isBashSuccess({ stdout: 'a' })).toBe(false);
    expect(isBashErrorString('Error: Exit code 1')).toBe(true);
    expect(isBashErrorString({})).toBe(false);
  });

  it('isEditResult / isWriteResult / isMultiEditResult', () => {
    expect(isEditResult({ filePath: '/a', oldString: 'x', newString: 'y' })).toBe(true);
    expect(isEditResult({ filePath: '/a' })).toBe(false);
    expect(isWriteResult({ type: 'create', filePath: '/a' })).toBe(true);
    expect(isWriteResult({ type: 'delete', filePath: '/a' })).toBe(false);
    expect(isMultiEditResult({ filePath: '/a', edits: [] })).toBe(true);
    expect(isNotebookEditResult({ notebook_path: '/a.ipynb' })).toBe(true);
  });

  it('isReadResult accepts the four observed types', () => {
    for (const type of ['text', 'image', 'pdf', 'parts']) expect(isReadResult({ type })).toBe(true);
    expect(isReadResult({ type: 'other' })).toBe(false);
  });

  it('isAgentAsyncResult and legacy Task result', () => {
    expect(isAgentAsyncResult({ status: 'async_launched', agentId: 'a1' })).toBe(true);
    expect(isAgentAsyncResult({ status: 'async_launched' })).toBe(false);
    expect(isAgentResult({ status: 'done' })).toBe(true);
    expect(isLegacyTaskResult({ content: [], totalToolUseCount: 1 })).toBe(true);
    expect(isLegacyTaskResult({ content: [] })).toBe(false);
  });

  it('isWorkflowResult and isMcpResult', () => {
    expect(isWorkflowResult({ runId: 'wf1' })).toBe(true);
    expect(isMcpResult([{ type: 'text', text: 'x' }])).toBe(true);
    expect(isMcpResult('plain')).toBe(true);
    expect(isMcpResult({})).toBe(false);
  });

  it('isRawUsage requires numeric input/output tokens', () => {
    expect(isRawUsage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0 })).toBe(true);
    expect(isRawUsage({ input_tokens: 1 })).toBe(false);
  });
});

describe('resultShapeKnown', () => {
  it('tolerates unshaped tools and error strings', () => {
    expect(resultShapeKnown('Glob', { matches: [] })).toBe(true);
    expect(resultShapeKnown('Bash', 'Error: Exit code 1')).toBe(true);
    expect(resultShapeKnown('WebSearch', { anything: true })).toBe(true);
  });

  it('flags an unknown shape for a shaped tool', () => {
    expect(resultShapeKnown('Bash', { unexpected: 1 })).toBe(false);
    expect(resultShapeKnown('Read', { type: 'weird' })).toBe(false);
    expect(resultShapeKnown('Bash', { stdout: 'a', stderr: 'b' })).toBe(true);
    expect(resultShapeKnown('Edit', { filePath: '/a', oldString: '', newString: '' })).toBe(true);
  });
});
