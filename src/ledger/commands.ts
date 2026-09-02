/**
 * Command facts (§4.6.2) and the shared `LedgerContext` every S12 extractor
 * takes. Each extractor is a pure function of `(calls, ctx)` (plus the
 * already-extracted `CommandFact`s, so a command line is tokenised exactly
 * once per session): no `node:fs`/`node:os`, no `process.env`, no wall
 * clock. S14 builds the context from the `Session` and the repo-root
 * resolver the pipeline injects (`util/gitroot.ts makeRepoRootResolver()`);
 * tests pass a map-backed `repoRootOf`.
 */
import type { CommandFact, Harness, Session, ToolCall } from '../model/types.js';
import { attributeExit, tokenize } from './shell/index.js';

/** The injected environment of the S12 extractors (§4.6; owned here, built by S14). */
export interface LedgerContext {
  /** The session's primary working directory. */
  cwd: string;
  /** Every working directory seen in the session (`Session.cwds`). */
  cwds: string[];
  /** The session repository root, or `null` outside a repository. */
  repoRoot: string | null;
  /** Repo root of an arbitrary written path (injected; the ledger never walks the filesystem). */
  repoRootOf: (p: string) => string | null;
  /** The home directory `~` expands to (fixtures use `/home/u`). */
  home: string;
  /** Temp roots for the `scratch` scope (§4.6.1). */
  tmpRoots: string[];
  /** Codex `turn_context.sandbox_policy` when present (§4.6.1, §4.6.7, §4.6.8). */
  sandbox?: Session['sandbox'];
  harness: Harness;
}

/**
 * Extracts one `CommandFact` per `shell` tool call (§4.6.2): the raw line,
 * its S11 segments (tokenised with the call's own cwd and the injected home,
 * exits attributed from the harness exit and the result text), chain and
 * background flags, and the duration when the harness reports one. Codex
 * `write_stdin` calls (`stdinWrite`) are skipped — they stay in `toolCalls`
 * for the counts only. The Bash `description` stays on the call for the
 * timeline (S18 reads it there).
 */
export function extractCommands(calls: readonly ToolCall[], ctx: LedgerContext): CommandFact[] {
  const facts: CommandFact[] = [];
  for (const call of calls) {
    if (call.kind !== 'shell' || call.stdinWrite === true) continue;
    const raw = call.command ?? '';
    if (raw.trim() === '') continue;
    const parse = tokenize(raw, call.cwd !== '' ? call.cwd : ctx.cwd, { home: ctx.home });
    attributeExit(parse, call.exitCode, call.exitCodeSource, call.resultText);
    const fact: CommandFact = {
      seq: call.seq,
      toolCallId: call.id,
      agentId: call.agentId,
      raw,
      segments: parse.segments,
      exitCode: call.exitCode,
      exitCodeSource: call.exitCodeSource,
      chained: parse.chained,
      background: call.background || parse.background,
      interrupted: call.interrupted,
    };
    if (call.durationMs !== undefined) fact.durationMs = call.durationMs;
    if (call.mayRunTests === true || parse.segments.some((s) => s.mayRunTests === true)) fact.mayRunTests = true;
    facts.push(fact);
  }
  return facts;
}
