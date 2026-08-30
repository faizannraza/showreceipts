/** `showreceipts bench` — stub until its step lands; exits 2 with a clear message. */
import type { CommandContext } from '../cli/context.js';

/** Runs the command; returns the exit code (§12.2). */
export async function run(ctx: CommandContext): Promise<number> {
  ctx.stderr.write('showreceipts bench: not implemented yet\n');
  return 2;
}
