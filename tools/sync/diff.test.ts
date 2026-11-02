import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyOps, blockOps, unifiedDiff } from "./diff.ts";
import type { Line } from "./page.ts";

const lines = (texts: readonly string[]): Line[] => texts.map((text, i) => ({ id: `L${i}`, text }));

/** 再現できる擬似乱数 (mulberry32) */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("blockOps", () => {
  it("ブロックの前後を変えずに、本文だけを新しい行に変える (乱択 500 通り)", () => {
    const next = random(42);
    const pick = () => ["a", "b", "c", " ", "d"][Math.floor(next() * 5)];
    for (let round = 0; round < 500; round++) {
      const before = Array.from({ length: Math.floor(next() * 8) }, pick);
      const after = Array.from({ length: Math.floor(next() * 8) }, pick);
      const page = lines(["title", "code:script.js", ...before, "後ろ"]);
      const body = page.slice(2, 2 + before.length);
      const ops = blockOps(body, after, page[page.length - 1].id);
      assert.deepEqual(
        applyOps(page, ops),
        ["title", "code:script.js", ...after, "後ろ"],
        `${before} → ${after}`,
      );
    }
  });

  it("ブロックがページの末尾にあるときは _end に挿入する", () => {
    const page = lines(["title", "code:script.js"]);
    const ops = blockOps([], [" a", " b"], "_end");
    assert.deepEqual(ops, [{ insertBefore: "_end", text: " a\n b" }]);
    assert.deepEqual(applyOps(page, ops), ["title", "code:script.js", " a", " b"]);
  });

  it("変わらない行には触れない (行 ID が残る)", () => {
    const body = lines([" a", " b", " c", " d"]);
    const ops = blockOps(body, [" a", " B", " c", " d", " e"], "_end");
    const touched = ops.flatMap((op) => ("replace" in op ? [op.replace] : "delete" in op ? [op.delete] : []));
    assert.deepEqual(touched, ["L1"]);
  });

  it("消す行を挿入の宛先にしない", () => {
    const body = lines([" a", " x", " y", " b"]);
    const ops = blockOps(body, [" a", " p", " q", " r", " b"], "_end");
    const deleted = new Set(ops.flatMap((op) => ("delete" in op ? [op.delete] : [])));
    for (const op of ops) {
      if ("insertBefore" in op) assert.ok(!deleted.has(op.insertBefore));
    }
  });

  it("同じ内容なら ops は空", () => {
    assert.deepEqual(blockOps(lines([" a", " b"]), [" a", " b"], "_end"), []);
  });
});

describe("unifiedDiff", () => {
  it("同じなら空文字列、違えば変わった行に - と + を付ける", () => {
    assert.equal(unifiedDiff(["a"], ["a"], { a: "x", b: "y" }), "");
    const diff = unifiedDiff(["a", "b", "c"], ["a", "B", "c"], { a: "x", b: "y" });
    assert.match(diff, /^--- x\n\+\+\+ y\n@@ -1,3 \+1,3 @@\n a\n-b\n\+B\n c\n$/);
  });
});
