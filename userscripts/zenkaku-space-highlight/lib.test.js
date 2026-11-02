import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { targetIndices } from "./lib.js";

describe("targetIndices", () => {
  it("全角スペースの位置だけを返し、半角スペースは拾わない", () => {
    assert.deepEqual(targetIndices("全角　スペース 半角"), [2]);
  });

  it("連続・先頭・末尾も 1 文字ずつ拾う", () => {
    assert.deepEqual(targetIndices("　　a　"), [0, 1, 3]);
  });

  it("無ければ空", () => {
    assert.deepEqual(targetIndices(""), []);
    assert.deepEqual(targetIndices("half width"), []);
  });
});
