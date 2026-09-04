/**
 * dsh dialect (§9 dsh row, S28): dsh bridges read the Claude Code hook
 * config verbatim, so this dialect reuses the Claude Code implementation
 * with `harness: 'dsh'` — the runtime then routes ledger and state files to
 * the dsh paths (`<home>/ledger/dsh/…`, `<home>/state/dsh/…`). `Stop`
 * stores `last_assistant_message` as the Appendix C `stop.text` and renders
 * the receipt from the dsh ledger; `PostToolUse`/`PostToolUseFailure`
 * follow the §9 recording rule (path prefix vs `--force-record`).
 */
import type { Dialect } from '../dialect.js';
import { makeClaudeCodeDialect } from './claude-code.js';

/** The `hook dsh` dialect (§9 dsh row). */
export const dialect: Dialect = makeClaudeCodeDialect('dsh');
