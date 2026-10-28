/*
 * diff.ts - line-based diff for Code Coach.
 *
 * Pure function, no deps. Computes a compact unified-style diff between the
 * previous saved content and the current content. Used by the extension to
 * send only what changed to the coach, not the whole file.
 */

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
}

export function computeDiff(before: string, after: string, maxLines = 200): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;

  // Guard against O(n*m) blowup on huge files. Fall back to a simple
  // "changed lines" diff when the table would be too large.
  if (n * m > 4_000_000) {
    return simpleDiff(a, b, maxLines);
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });

  return compact(out, 2, maxLines);
}

function compact(out: DiffLine[], context: number, maxLines: number): string {
  const keep = new Set<number>();
  out.forEach((l, idx) => {
    if (l.kind === "ctx") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(out.length - 1, idx + context); k++) {
      keep.add(k);
    }
  });

  const lines: string[] = [];
  let prev = -1;
  for (let idx = 0; idx < out.length; idx++) {
    if (!keep.has(idx)) continue;
    if (prev !== -1 && idx !== prev + 1) lines.push("...");
    const l = out[idx];
    lines.push(l.kind === "add" ? "+" + l.text : l.kind === "del" ? "-" + l.text : " " + l.text);
    prev = idx;
    if (lines.length >= maxLines) {
      lines.push("... (diff truncated)");
      break;
    }
  }
  return lines.join("\n");
}

function simpleDiff(a: string[], b: string[], maxLines: number): string {
  const aSet = new Set(a);
  const bSet = new Set(b);
  const lines: string[] = [];
  for (const l of a) {
    if (!bSet.has(l)) lines.push("-" + l);
    if (lines.length >= maxLines) break;
  }
  for (const l of b) {
    if (!aSet.has(l)) lines.push("+" + l);
    if (lines.length >= maxLines) break;
  }
  return lines.join("\n");
}
