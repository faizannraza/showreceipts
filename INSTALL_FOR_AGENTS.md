# Installing showreceipts (instructions for a coding agent)

You are a coding agent. Your human wants `showreceipts` installed and its
hooks active so that every session you (and other agents on this machine)
finish gets an evidence receipt. Follow these steps exactly, then prove the
install with the verify gate. **The CLI is the source of truth**: if this
document and the CLI's own `--help` or output ever disagree, trust the CLI.

## Steps

1. **Install** (prefer global — hooks outlive any single project):

   ```sh
   npm i -g showreceipts
   showreceipts --version
   ```

   If a global install is not possible, `npx showreceipts` works for every
   command below (slower per invocation).

2. **Preview what setup would change** — read the diff, change nothing yet:

   ```sh
   showreceipts setup --dry-run
   ```

   Setup edits only harness hook configs, takes a backup of every file it
   touches, and is idempotent. `--dry-run` shows the exact diff per harness.

3. **Install the hooks**:

   ```sh
   showreceipts setup
   ```

   Read the output. Two harnesses can require a manual step signalled by
   **exit code 3** (the exact snippet to apply is printed): Gemini, when its
   `settings.json` carries comments that setup refuses to rewrite, and
   Hermes, when the printed YAML block must be added by hand (plus a consent
   prompt accepted). **Codex setup exits 0** but still prints one action you
   must read from the output: trust the hook via `/hooks` inside `codex`
   (`doctor` shows the trusted state) — skip it and the hook is installed
   but inert.

4. **Verify gate** — the install is complete only when BOTH pass:

   ```sh
   showreceipts doctor    # MUST exit 0
   showreceipts demo      # MUST print receipt boxes (synthetic demo data)
   ```

   Check the exit code of `doctor` explicitly (`echo $?`). Exit 0 with
   warnings is a pass; exit 4 is a fail — it means core-shape breakage
   (unreadable root, unresolvable hook launcher, Node < 20) and the output
   names the problem. If `demo` prints framed CLAIMED/EVIDENCE receipts, the
   render pipeline works.

5. **Report to your human**: paste the `setup` summary, the `doctor` exit
   code, and — if any sessions exist on disk — the output of
   `showreceipts audit --limit 5`.

## Notes

- Everything is offline and read-only over agent logs; the tool writes only
  `.showreceipts/` in git repos and `~/.showreceipts/`. No API key, no
  telemetry, no network code path.
- Do not edit harness config files yourself to "help"; `setup` merges
  surgically and `setup --remove` uninstalls cleanly. Manual edits are how
  configs get corrupted.
- If `doctor` reports hooks installed but not resolvable, re-run
  `showreceipts setup` after `npm i -g showreceipts` (the launcher prefers a
  real global install over an `npx` cache path).
- `showreceipts --help` and `showreceipts <command> --help` document every
  flag; prefer them over guessing.
