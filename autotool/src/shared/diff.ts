// Line diff (LCS) for showing the Java a write would change.

export interface DiffLine {
  op: " " | "+" | "-";
  text: string;
  a: number | null; // line in the old file
  b: number | null; // line in the new file
}

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  // trim the common head and tail first: edits are usually small
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const n = am.length;
  const m = bm.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = am[i] === bm[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  for (let k = 0; k < head; k++) out.push({ op: " ", text: a[k], a: k + 1, b: k + 1 });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      out.push({ op: " ", text: am[i], a: head + i + 1, b: head + j + 1 });
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push({ op: "+", text: bm[j], a: null, b: head + j + 1 });
      j++;
    } else {
      out.push({ op: "-", text: am[i], a: head + i + 1, b: null });
      i++;
    }
  }
  for (let k = 0; k < tail; k++) out.push({ op: " ", text: a[a.length - tail + k], a: a.length - tail + k + 1, b: b.length - tail + k + 1 });
  return out;
}

// Changed lines with `context` unchanged lines around them; "..." between hunks.
export function compactDiff(lines: DiffLine[], context = 2): (DiffLine | null)[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.op !== " ") for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | null)[] = [];
  let gap = false;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (gap && out.length) out.push(null);
      out.push(l);
      gap = false;
    } else gap = true;
  });
  return out;
}
