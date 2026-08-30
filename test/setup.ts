// Loaded by every vitest config (PLAN §0.4): pins TZ, colour, width, the
// clock and every home/config root to per-run temp directories so no test can
// see or touch the developer's real ~/.claude, ~/.codex or ~/.showreceipts.
import { afterAll } from 'vitest';
import { ensurePins, releasePins } from './helpers/env.js';

ensurePins();

afterAll(() => {
  releasePins();
});
