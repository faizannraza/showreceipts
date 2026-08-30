import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOL_VERSION } from '../../../src/version.js';

describe('TOOL_VERSION', () => {
  it('equals package.json.version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(TOOL_VERSION).toBe(pkg.version);
  });

  it('is a plain semver string', () => {
    expect(TOOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
