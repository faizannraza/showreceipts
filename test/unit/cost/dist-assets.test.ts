import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const srcUrl = new URL('../../../src/cost/prices.json', import.meta.url);
const distUrl = new URL('../../../dist/cost/prices.json', import.meta.url);

// S12b build rule: `scripts/build-assets.mjs` copies every non-.ts file under
// src/ into dist/. The Validate line for this step runs `npm run build` first.
describe('dist/cost/prices.json (S12b build rule)', () => {
  it('exists after npm run build', () => {
    expect(existsSync(distUrl)).toBe(true);
  });

  it('is byte-identical to src/cost/prices.json', () => {
    expect(readFileSync(distUrl).equals(readFileSync(srcUrl))).toBe(true);
  });
});
