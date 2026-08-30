/**
 * `showreceipts hook` — stub until S27 lands. The §9 contract holds from day
 * one: a JSON object on stdout and exit 0, whatever the input.
 */
import type { CommandContext } from '../cli/context.js';

/** Runs the hook entrypoint; always resolves 0. */
export async function run(ctx: CommandContext): Promise<number> {
  ctx.stdout.write('{}\n');
  return 0;
}
