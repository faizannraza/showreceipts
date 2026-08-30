/**
 * Spawns the built CLI (`dist/cli.js`) as a child process with the §0.4
 * environment pins and the runtime netguard injected through NODE_OPTIONS.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { pinnedEnv } from './env.js';

/** Absolute path of the compiled CLI. */
export const CLI_PATH = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

/** Absolute path of the runtime no-network guard. */
export const NETGUARD_PATH = fileURLToPath(new URL('./netguard.cjs', import.meta.url));

export interface RunCliOptions {
  /** Extra environment; a value of `undefined` removes the key. */
  env?: Record<string, string | undefined>;
  stdin?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  code: number;
  /** Wall time of the child in milliseconds, spawn overhead included. */
  ms: number;
}

/** Runs `node dist/cli.js <args>` synchronously and captures its output. */
export function runCli(args: readonly string[], opts: RunCliOptions = {}): RunCliResult {
  if (!existsSync(CLI_PATH)) throw new Error(`run npm run build first (missing ${CLI_PATH})`);
  const env: Record<string, string> = { ...pinnedEnv(), NODE_OPTIONS: `--require "${NETGUARD_PATH}"` };
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const started = performance.now();
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env,
    input: opts.stdin ?? '',
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = performance.now() - started;
  if (result.error) throw result.error;
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.status ?? (result.signal ? 128 : 1),
    ms,
  };
}
