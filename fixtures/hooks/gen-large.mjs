#!/usr/bin/env node
// Generates the LARGE hook-contract stdin payloads at test time (S31).
// Nothing here is committed: the output lands in fixtures/hooks/generated/
// (git-ignored) and test/hooks/contract.test.ts removes it afterwards.
//
//   node fixtures/hooks/gen-large.mjs [outDir]
//
// Deterministic: a seeded PRNG (mulberry32, seed 0x5eed) fills every body,
// so two runs produce byte-identical files.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Default output directory (git-ignored). */
export const DEFAULT_OUT_DIR = fileURLToPath(new URL('./generated/', import.meta.url));

/** The PRNG seed every generated body derives from. */
export const SEED = 0x5eed;

/** The 32 MiB stdin cap the oversize payloads must exceed (§9). */
const STDIN_CAP = 32 * 1024 * 1024;
/** Oversize payload target: 33 MiB. */
const OVERSIZE_BYTES = 33 * 1024 * 1024;
/** The Cursor `afterFileEdit` payload target: 5 MB (§9 Cursor row). */
const AFTER_FILE_EDIT_BYTES = 5 * 1000 * 1000;

/** mulberry32 — a tiny deterministic PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) | 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `n` characters of JSON-safe seeded noise (letters, digits, spaces, newlines as \n escapes are avoided). */
function noise(rand, n) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';
  const parts = new Array(n);
  for (let i = 0; i < n; i++) parts[i] = alphabet[Math.floor(rand() * alphabet.length)];
  return parts.join('');
}

/**
 * The 5 MB Cursor `afterFileEdit` stdin (§9): under the 32 MiB cap, parsed
 * normally, with far more than 32 edits so the Appendix C truncation caps
 * (`edits` ≤ 32 × 4 KiB, `editsTruncated`) are exercised.
 */
export function afterFileEditPayload() {
  const rand = mulberry32(SEED);
  const edits = [];
  let bytes = 0;
  while (bytes < AFTER_FILE_EDIT_BYTES) {
    const oldText = noise(rand, 3000);
    const newText = noise(rand, 3000);
    edits.push({ old: oldText, new: newText });
    bytes += oldText.length + newText.length;
  }
  return {
    conversation_id: 'big-edit-1',
    hook_event_name: 'afterFileEdit',
    file_path: '/w/proj/src/huge.ts',
    edits,
    workspace_roots: ['/w/proj'],
  };
}

/**
 * A 33 MiB oversize payload with a salvageable head (§9): `tool_name` and a
 * top-level `command` sit inside the first 64 KiB, so the runtime records a
 * `tool-post` with `out.truncated: true` and `exitSource: 'unknown'`.
 */
export function oversizeSalvageablePayload() {
  const rand = mulberry32(SEED + 1);
  const head =
    '{"hook_event_name":"postToolUse","conversation_id":"big-tool-1","generation_id":"g-big",' +
    '"tool_name":"Shell","command":"npm test","tool_use_id":"tc-big","tool_output":"';
  const tail = '"}';
  const body = noise(rand, OVERSIZE_BYTES - head.length - tail.length);
  return head + body + tail;
}

/**
 * A 33 MiB oversize payload with NO salvageable `tool_name` (§9): the
 * runtime records `gap{reason:'oversize', bytes}` under the salvaged sid.
 */
export function oversizeGapPayload() {
  const rand = mulberry32(SEED + 2);
  const head = '{"hook_event_name":"postToolUse","conversation_id":"big-gap-1","tool_output":"';
  const tail = '"}';
  const body = noise(rand, OVERSIZE_BYTES - head.length - tail.length);
  return head + body + tail;
}

/** File names produced by {@link generateAll}. */
export const FILES = {
  afterFileEdit: 'cursor-afterFileEdit-5mb.json',
  oversizeSalvageable: 'oversize-salvageable.json',
  oversizeGap: 'oversize-gap.json',
};

/**
 * Writes all three payloads into `outDir` (created if missing) and returns
 * their absolute paths. Byte-identical on every run (seeded).
 */
export function generateAll(outDir = DEFAULT_OUT_DIR) {
  mkdirSync(outDir, { recursive: true });
  const afterFileEdit = join(outDir, FILES.afterFileEdit);
  writeFileSync(afterFileEdit, JSON.stringify(afterFileEditPayload()));
  const oversizeSalvageable = join(outDir, FILES.oversizeSalvageable);
  writeFileSync(oversizeSalvageable, oversizeSalvageablePayload());
  const oversizeGap = join(outDir, FILES.oversizeGap);
  writeFileSync(oversizeGap, oversizeGapPayload());
  return { afterFileEdit, oversizeSalvageable, oversizeGap };
}

// CLI entry: `node fixtures/hooks/gen-large.mjs [outDir]`.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const out = generateAll(process.argv[2] ?? DEFAULT_OUT_DIR);
  for (const p of Object.values(out)) process.stdout.write(`${p}\n`);
}
