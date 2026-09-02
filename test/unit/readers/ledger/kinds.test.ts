/**
 * S09: the Appendix C tool-name → kind maps. `kind` on a ledger line is a
 * hint; the reader re-derives via these maps, and unknown names are never a
 * write kind.
 */
import { describe, expect, it } from 'vitest';
import { deriveKind, lookupKind } from '../../../../src/readers/ledger/kinds.js';

describe('deriveKind', () => {
  it('maps Cursor tool names, including the MCP: prefix and afterFileEdit', () => {
    expect(deriveKind('cursor', 'Shell')).toBe('shell');
    expect(deriveKind('cursor', 'Read')).toBe('read');
    expect(deriveKind('cursor', 'Write')).toBe('write');
    expect(deriveKind('cursor', 'Edit')).toBe('edit');
    expect(deriveKind('cursor', 'afterFileEdit')).toBe('edit');
    expect(deriveKind('cursor', 'MCP:filesystem')).toBe('mcp');
    expect(deriveKind('cursor', 'MCP:github/search')).toBe('mcp');
  });

  it('maps Gemini tool names', () => {
    expect(deriveKind('gemini', 'run_shell_command')).toBe('shell');
    expect(deriveKind('gemini', 'write_file')).toBe('write');
    expect(deriveKind('gemini', 'replace')).toBe('edit');
    expect(deriveKind('gemini', 'read_file')).toBe('read');
    expect(deriveKind('gemini', 'glob')).toBe('search');
    expect(deriveKind('gemini', 'grep')).toBe('search');
    expect(deriveKind('gemini', 'web_fetch')).toBe('fetch');
    expect(deriveKind('gemini', 'google_web_search')).toBe('fetch');
  });

  it('maps Copilot tool names', () => {
    expect(deriveKind('copilot', 'bash')).toBe('shell');
    expect(deriveKind('copilot', 'powershell')).toBe('shell');
    expect(deriveKind('copilot', 'create')).toBe('write');
    expect(deriveKind('copilot', 'edit')).toBe('edit');
    expect(deriveKind('copilot', 'view')).toBe('read');
    expect(deriveKind('copilot', 'glob')).toBe('search');
    expect(deriveKind('copilot', 'grep')).toBe('search');
    expect(deriveKind('copilot', 'web_fetch')).toBe('fetch');
    expect(deriveKind('copilot', 'task')).toBe('agent');
  });

  it('maps Hermes tool names', () => {
    expect(deriveKind('hermes', 'terminal')).toBe('shell');
    expect(deriveKind('hermes', 'write_file')).toBe('write');
    expect(deriveKind('hermes', 'edit_file')).toBe('edit');
  });

  it('maps dsh (Claude Code-shaped) tool names, including the mcp__ prefix', () => {
    expect(deriveKind('dsh', 'Bash')).toBe('shell');
    expect(deriveKind('dsh', 'Edit')).toBe('edit');
    expect(deriveKind('dsh', 'MultiEdit')).toBe('edit');
    expect(deriveKind('dsh', 'NotebookEdit')).toBe('edit');
    expect(deriveKind('dsh', 'Write')).toBe('write');
    expect(deriveKind('dsh', 'Read')).toBe('read');
    expect(deriveKind('dsh', 'Grep')).toBe('search');
    expect(deriveKind('dsh', 'WebFetch')).toBe('fetch');
    expect(deriveKind('dsh', 'Agent')).toBe('agent');
    expect(deriveKind('dsh', 'SendMessage')).toBe('task');
    expect(deriveKind('dsh', 'mcp__github__search')).toBe('mcp');
  });

  it('maps every unknown name to other — never a write — and lookupKind reports it', () => {
    for (const h of ['cursor', 'gemini', 'copilot', 'hermes', 'dsh', 'opencode', 'openclaw', 'claude-code', 'nonsense']) {
      expect(deriveKind(h, 'TotallyNewTool')).toBe('other');
      expect(lookupKind(h, 'TotallyNewTool')).toBeNull();
    }
    // Write-class names from one harness never leak into another.
    expect(deriveKind('hermes', 'Write')).toBe('other');
    expect(deriveKind('cursor', 'write_file')).toBe('other');
    expect(deriveKind('gemini', 'Edit')).toBe('other');
    expect(deriveKind('copilot', 'Write')).toBe('other');
  });

  it('prefix maps are per-harness', () => {
    expect(deriveKind('gemini', 'MCP:filesystem')).toBe('other');
    expect(deriveKind('cursor', 'mcp__github__search')).toBe('other');
  });
});
