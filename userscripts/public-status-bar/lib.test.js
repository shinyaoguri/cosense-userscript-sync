import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { barStyle, claim } from "./lib.js";

describe("barStyle", () => {
  it("公開・非公開・不明で、ラベルと色が違う", () => {
    const styles = [barStyle(true), barStyle(false), barStyle(undefined)];
    assert.deepEqual(
      styles.map((style) => style.label),
      ["公開プロジェクト", "非公開プロジェクト", "公開状態が分かりません"],
    );
    assert.equal(new Set(styles.map((style) => style.background)).size, 3);
  });
});

describe("claim", () => {
  it("本番は 1 度だけ動く (2 度目の import では動かない)", () => {
    /** @type {Record<string, string>} */
    const registry = {};
    assert.equal(claim(registry, "x", "cosense"), true);
    assert.equal(claim(registry, "x", "cosense"), false);
  });

  it("開発用ローダーの予約があれば、開発版だけが動き、本番版は動かない", () => {
    /** @type {Record<string, string>} */
    const registry = { x: "reserved-for-dev" };
    assert.equal(claim(registry, "x", "cosense"), false);
    assert.equal(claim(registry, "x", "dev"), true);
    assert.equal(claim(registry, "x", "cosense"), false);
  });

  it("予約が無ければ開発版は動かない (ローダーを通さずに評価されたとき)", () => {
    assert.equal(claim({}, "x", "dev"), false);
  });

  it("id ごとに独立している", () => {
    /** @type {Record<string, string>} */
    const registry = { x: "reserved-for-dev" };
    assert.equal(claim(registry, "y", "cosense"), true);
  });
});
