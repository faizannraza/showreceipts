/**
 * Minimal line-based unified diff (S30 `setup/diff.ts`): every `SetupResult`
 * carries the exact edit `setup` made (or would make under `--dry-run`) as a
 * standard unified diff with three lines of context. Pure text-in/text-out —
 * no fs, no colour. Configs are small, so a full LCS table is fine; past
 * 4M cells the diff degrades to a whole-file replacement.
 */

interface Op {
  kind: ' ' | '-' | '+';
  line: string;
}

/** Lines of `text` without a phantom empty line for the trailing newline. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The keep/delete/insert script between two line arrays (LCS walk). */
function editScript(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] as string });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
      ops.push({ kind: '-', line: a[i] as string });
      i += 1;
    } else {
      ops.push({ kind: '+', line: b[j] as string });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: '-', line: a[i] as string });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: '+', line: b[j] as string });
    j += 1;
  }
  return ops;
}

/**
 * A unified diff between two texts (empty string when they are equal).
 * `label` names both sides: a relative label gets the git-style `a/`/`b/`
 * prefixes; an absolute label is emitted verbatim (`--- /path` /
 * `+++ /path`, plain `diff -u` style) — `a//path` would double the slash.
 * Hunks carry `context` lines of context and standard `@@ -i,n +j,m @@`
 * headers.
 */
export function unifiedDiff(oldText: string, newText: string, label: string, context = 3): string {
  if (oldText === newText) return '';
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let ops: Op[];
  if ((a.length + 1) * (b.length + 1) > 4_000_000) {
    ops = [...a.map((line): Op => ({ kind: '-', line })), ...b.map((line): Op => ({ kind: '+', line }))];
  } else {
    ops = editScript(a, b);
  }

  // Positions of each op in the old/new files (0-based, before the op).
  const aPos: number[] = new Array<number>(ops.length + 1);
  const bPos: number[] = new Array<number>(ops.length + 1);
  let ai = 0;
  let bi = 0;
  ops.forEach((op, k) => {
    aPos[k] = ai;
    bPos[k] = bi;
    if (op.kind !== '+') ai += 1;
    if (op.kind !== '-') bi += 1;
  });
  aPos[ops.length] = ai;
  bPos[ops.length] = bi;

  // Cluster changed ops; merge clusters whose gap is within 2×context.
  const clusters: { first: number; last: number }[] = [];
  ops.forEach((op, k) => {
    if (op.kind === ' ') return;
    const prev = clusters[clusters.length - 1];
    if (prev !== undefined && k - prev.last <= context * 2 + 1) prev.last = k;
    else clusters.push({ first: k, last: k });
  });

  const out: string[] = label.startsWith('/') ? [`--- ${label}`, `+++ ${label}`] : [`--- a/${label}`, `+++ b/${label}`];
  for (const cluster of clusters) {
    const start = Math.max(0, cluster.first - context);
    const end = Math.min(ops.length - 1, cluster.last + context);
    let aLen = 0;
    let bLen = 0;
    const lines: string[] = [];
    for (let k = start; k <= end; k++) {
      const op = ops[k] as Op;
      if (op.kind !== '+') aLen += 1;
      if (op.kind !== '-') bLen += 1;
      lines.push(`${op.kind}${op.line}`);
    }
    const aStart = aLen === 0 ? (aPos[start] as number) : (aPos[start] as number) + 1;
    const bStart = bLen === 0 ? (bPos[start] as number) : (bPos[start] as number) + 1;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`, ...lines);
  }
  return `${out.join('\n')}\n`;
}
