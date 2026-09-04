/**
 * `showreceipts hook <harness> [<event>]` (§9): wires the harness-agnostic
 * runtime (S27) to the complete dialect registry. The runtime owns the §9
 * contract — drain stdin, budget watchdogs, one JSON object on stdout, exit
 * code 0 whatever happens; this module only adapts the CLI context to it.
 *
 * With injected streams (in-process tests) the answer goes to the injected
 * stdout and stdin is treated as empty: the §9 fd-level contract
 * (`fs.writeSync(1, …)`, fd 0 drained to EOF) applies to the real spawned
 * process, where `ctx.stdout` is `process.stdout`.
 */
import type { CommandContext } from '../cli/context.js';
import { DIALECTS } from '../hook/dialects/index.js';
import { runHook, type HookSeams } from '../hook/runtime.js';

/** Runs the hook entrypoint; always resolves 0. */
export async function run(ctx: CommandContext): Promise<number> {
  const seams: HookSeams = {};
  if (ctx.stdout !== process.stdout) {
    seams.write = (text: string): void => {
      ctx.stdout.write(text);
    };
    seams.stdin = { json: {}, salvage: {}, bytes: 0, overflow: false };
    // An in-process caller (tests) must never have the watchdog or the
    // last-resort handlers terminate the host process; the `{}` answer is
    // already written through `seams.write` before `exit` is reached.
    seams.exit = (): void => undefined;
  }
  return runHook(
    { positionals: ctx.args.positionals, flags: ctx.args.flags },
    { env: ctx.env, cwd: ctx.cwd, now: ctx.now },
    DIALECTS,
    seams,
  );
}
