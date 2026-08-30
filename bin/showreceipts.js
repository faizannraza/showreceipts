#!/usr/bin/env node
// Launcher: refuse old Node with a plain message, then hand argv to the
// compiled CLI. No top-level await so the file itself parses on Node 12+.
const major = Number(process.versions.node.split('.')[0]);
if (!(major >= 20)) {
  process.stderr.write(`showreceipts needs Node 20 or newer (found v${process.versions.node})\n`);
  process.exit(1);
}
import('../dist/cli.js').then((m) => m.main(process.argv.slice(2)));
