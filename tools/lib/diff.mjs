/**
 * Minimal unified diff (LCS based). Good enough to review a JSON catalog edit,
 * and it keeps the tool free of dependencies.
 *
 * Shared by the curator (tools/curate) and the nightly recheck
 * (tools/recheck) so a contributor sees a staged entry and a demotion the same
 * way.
 */
export function unifiedDiff({ before, after, from = "a", to = "b", context = 3 } = {}) {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push([" ", a[i], i + 1, j + 1]);
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push(["-", a[i], i + 1, null]);
      i += 1;
    } else {
      ops.push(["+", b[j], null, j + 1]);
      j += 1;
    }
  }
  for (; i < n; i += 1) ops.push(["-", a[i], i + 1, null]);
  for (; j < m; j += 1) ops.push(["+", b[j], null, j + 1]);

  const changed = ops.map((op) => op[0] !== " ");
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op[0] === " ") return;
    for (let k = Math.max(0, idx - context); k < idx; k += 1) keep[k] = true;
    for (let k = idx; k <= Math.min(ops.length - 1, idx + context); k += 1) keep[k] = true;
  });
  if (!changed.some(Boolean)) return "";

  const lines = [`--- ${from}`, `+++ ${to}`, `@@ ${from} -> ${to} @@`];
  let skipped = false;
  ops.forEach((op, idx) => {
    if (!keep[idx]) {
      if (!skipped) {
        lines.push(" ...");
        skipped = true;
      }
      return;
    }
    skipped = false;
    const [kind, text] = op;
    lines.push(`${kind}${text}`);
  });
  return `${lines.join("\n")}\n`;
}
