// 行の差分。ページ上のブロック本文を新しい本文へ変える ops と、人が読む unified diff を作る。
import type { Line } from "./page.ts";

/** cosense CLI の previewEdit が受け取る op */
export type Op =
  | { readonly insertBefore: string; readonly text: string }
  /** 1 行の本文を置き換える。text は 1 行だけ */
  | { readonly replace: string; readonly text: string }
  | { readonly delete: string };

type Edit =
  | { readonly kind: "keep"; readonly a: number; readonly b: number }
  | { readonly kind: "del"; readonly a: number }
  | { readonly kind: "ins"; readonly b: number };

/** LCS による編集列。UserScript 1 本 (数百〜数千行) なら O(n·m) で足りる */
function editScript(a: readonly string[], b: readonly string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = a[i..] と b[j..] の最長共通部分列の長さ
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      edits.push({ kind: "keep", a: i++, b: j++ });
    } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      // 同じ長さなら削除を先に (diff の読み手に馴染む `-` → `+` の順になる)
      edits.push({ kind: "del", a: i++ });
    } else {
      edits.push({ kind: "ins", b: j++ });
    }
  }
  return edits;
}

/**
 * ブロック本文 `current` を `next` (行のテキスト) に変える ops。
 *
 * - 変わっていない行は触らない (行 ID と作者の記録が残る)
 * - 変わった区間では、先頭から行数の少ない方だけ `replace` にし、余った新しい行は `insertBefore`、
 *   余った古い行は `delete` にする
 * - 挿入の宛先は、区間の直後にある**変わらない行**か、ブロックの次の行 (`endAnchor`)。
 *   消す行を宛先にしないので、ops を順に適用しても宛先が消えていることはない
 */
export function blockOps(current: readonly Line[], next: readonly string[], endAnchor: string): Op[] {
  const edits = editScript(
    current.map((line) => line.text),
    next,
  );
  const ops: Op[] = [];
  let k = 0;
  while (k < edits.length) {
    if (edits[k].kind === "keep") {
      k++;
      continue;
    }
    const deleted: number[] = [];
    const inserted: number[] = [];
    while (k < edits.length && edits[k].kind !== "keep") {
      const edit = edits[k++];
      if (edit.kind === "del") deleted.push(edit.a);
      if (edit.kind === "ins") inserted.push(edit.b);
    }
    const following = edits[k];
    const anchor = following?.kind === "keep" ? current[following.a].id : endAnchor;
    const paired = Math.min(deleted.length, inserted.length);
    for (let p = 0; p < paired; p++) {
      ops.push({ replace: current[deleted[p]].id, text: next[inserted[p]] });
    }
    if (inserted.length > paired) {
      const text = inserted
        .slice(paired)
        .map((b) => next[b])
        .join("\n");
      ops.push({ insertBefore: anchor, text });
    }
    for (const a of deleted.slice(paired)) {
      ops.push({ delete: current[a].id });
    }
  }
  return ops;
}

/** ops を行のテキストの配列に適用する (preview の結果と突き合わせる期待値を作る) */
export function applyOps(lines: readonly Line[], ops: readonly Op[]): string[] {
  const work = lines.map((line) => ({ id: line.id as string | undefined, text: line.text }));
  const indexOf = (id: string) => {
    const index = work.findIndex((line) => line.id === id);
    if (index < 0) throw new Error(`op の宛先の行がありません: ${id}`);
    return index;
  };
  for (const op of ops) {
    if ("insertBefore" in op) {
      const at = op.insertBefore === "_end" ? work.length : indexOf(op.insertBefore);
      work.splice(at, 0, ...op.text.split("\n").map((text) => ({ id: undefined, text })));
    } else if ("replace" in op) {
      work[indexOf(op.replace)].text = op.text;
    } else {
      work.splice(indexOf(op.delete), 1);
    }
  }
  return work.map((line) => line.text);
}

/** unified diff (文脈 3 行)。人が読むためのもので、機械では読まない */
export function unifiedDiff(
  a: readonly string[],
  b: readonly string[],
  labels: { readonly a: string; readonly b: string },
): string {
  const edits = editScript(a, b);
  if (edits.every((edit) => edit.kind === "keep")) return "";
  const out = [`--- ${labels.a}`, `+++ ${labels.b}`];
  const context = 3;
  let k = 0;
  while (k < edits.length) {
    if (edits[k].kind === "keep") {
      k++;
      continue;
    }
    // 変更の塊を、間の変わらない行が context*2 以下なら 1 つの hunk にまとめる
    let start = k;
    while (start > 0 && k - start < context && edits[start - 1].kind === "keep") start--;
    let end = k;
    let gap = 0;
    while (end < edits.length) {
      if (edits[end].kind === "keep") {
        gap++;
        if (gap > context * 2) break;
      } else {
        gap = 0;
      }
      end++;
    }
    end -= Math.max(0, gap - context);
    const hunk = edits.slice(start, end);
    const aStart = firstIndex(edits, start, "a");
    const bStart = firstIndex(edits, start, "b");
    const aCount = hunk.filter((edit) => edit.kind !== "ins").length;
    const bCount = hunk.filter((edit) => edit.kind !== "del").length;
    out.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`);
    for (const edit of hunk) {
      if (edit.kind === "keep") out.push(` ${a[edit.a]}`);
      if (edit.kind === "del") out.push(`-${a[edit.a]}`);
      if (edit.kind === "ins") out.push(`+${b[edit.b]}`);
    }
    k = end;
  }
  return `${out.join("\n")}\n`;
}

/** 編集列の位置 `at` が、a (または b) の何行目から始まるか */
function firstIndex(edits: readonly Edit[], at: number, side: "a" | "b"): number {
  let count = 0;
  for (let k = 0; k < at; k++) {
    const edit = edits[k];
    if (side === "a" ? edit.kind !== "ins" : edit.kind !== "del") count++;
  }
  return count;
}
