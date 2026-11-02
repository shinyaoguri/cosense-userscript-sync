import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isToggleKey } from "./lib.js";

describe("isToggleKey", () => {
  it("Ctrl+F で切り替える (Shift 付きの大文字も)", () => {
    assert.equal(isToggleKey({ ctrlKey: true, key: "f" }), true);
    assert.equal(isToggleKey({ ctrlKey: true, key: "F" }), true);
  });

  it("Ctrl なしの F や、Ctrl と別のキーでは切り替えない", () => {
    assert.equal(isToggleKey({ ctrlKey: false, key: "f" }), false);
    assert.equal(isToggleKey({ ctrlKey: true, key: "g" }), false);
  });
});
