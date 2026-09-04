/**
 * Config backups (S30; §9 "Backups and removal"): before any rewrite the
 * original bytes go to `~/.showreceipts/backups/<harness>/<basename>.<unix-ms>`
 * (mode 0600 under 0700 directories, newest three kept, never beside the
 * config). Restores happen only through an explicit `setup --restore <backup>`.
 */
import fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Harness } from '../model/types.js';
import { atomicWriteFile, ensureDir, statOrNull } from '../util/fs.js';

/** How many backups per config file survive rotation (§9). */
export const KEEP_BACKUPS = 3;

/** `<showreceiptsHome>/backups/<harness>`. */
export function backupDir(showreceiptsHome: string, harness: Harness): string {
  return join(showreceiptsHome, 'backups', harness);
}

/** Backups of one config in that directory, oldest first. */
export function listBackups(dir: string, base: string): { path: string; ms: number }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: { path: string; ms: number }[] = [];
  for (const name of names) {
    if (!name.startsWith(`${base}.`)) continue;
    const suffix = name.slice(base.length + 1);
    if (!/^\d+$/.test(suffix)) continue;
    out.push({ path: join(dir, name), ms: Number(suffix) });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

/** Deletes the oldest backups beyond `keep`. */
export function rotateBackups(dir: string, base: string, keep = KEEP_BACKUPS): void {
  const backups = listBackups(dir, base);
  while (backups.length > keep) {
    const oldest = backups.shift();
    if (oldest === undefined) return;
    try {
      fs.unlinkSync(oldest.path);
    } catch {
      // already gone
    }
  }
}

/**
 * Writes one backup (mode 0600, atomic) named `<basename>.<unix-ms>` and
 * rotates to {@link KEEP_BACKUPS}. `nowMs` comes from `ctx.now`; when a
 * backup with that timestamp already exists (the frozen test clock) the
 * millisecond is bumped until the name is free, so backups are never
 * silently overwritten. Returns the backup path.
 */
export function writeBackup(showreceiptsHome: string, harness: Harness, configPath: string, data: string | Buffer, nowMs: number): string {
  ensureDir(showreceiptsHome, 0o700);
  ensureDir(join(showreceiptsHome, 'backups'), 0o700);
  const dir = backupDir(showreceiptsHome, harness);
  ensureDir(dir, 0o700);
  const base = basename(configPath);
  let ms = Math.max(0, Math.floor(nowMs));
  let path = join(dir, `${base}.${ms}`);
  while (statOrNull(path) !== null) {
    ms += 1;
    path = join(dir, `${base}.${ms}`);
  }
  atomicWriteFile(path, data, { mode: 0o600 });
  rotateBackups(dir, base);
  return path;
}

/** Copies a backup over the target config atomically (explicit `--restore` only). */
export function restoreBackup(backupPath: string, targetPath: string): void {
  const data = fs.readFileSync(backupPath);
  fs.mkdirSync(dirname(targetPath), { recursive: true });
  atomicWriteFile(targetPath, data);
}
