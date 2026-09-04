/**
 * The complete dialect registry (S27): all nine harnesses are wired here
 * from day one — there is no "registry line added at merge" step. S28 and
 * S29 replace the stub bodies inside the individual dialect files and never
 * touch this file.
 */
import type { Harness } from '../../model/types.js';
import type { Dialect } from '../dialect.js';
import { dialect as claudeCode } from './claude-code.js';
import { dialect as codex } from './codex.js';
import { dialect as copilot } from './copilot.js';
import { dialect as cursor } from './cursor.js';
import { dialect as dsh } from './dsh.js';
import { dialect as gemini } from './gemini.js';
import { dialect as hermes } from './hermes.js';
import { dialect as openclaw } from './openclaw.js';
import { dialect as opencode } from './opencode.js';

/** Every §9 dialect, keyed by the `hook <harness>` positional. */
export const DIALECTS: Readonly<Record<Harness, Dialect>> = {
  'claude-code': claudeCode,
  codex,
  cursor,
  gemini,
  copilot,
  hermes,
  dsh,
  opencode,
  openclaw,
};
