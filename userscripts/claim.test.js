// 各 UserScript の lib.js に複製した claim が、同じに振る舞うことを確かめる。
// ページをまたいで静的 import できないので claim は各ページに置くが、複製がずれると二重実行の防ぎ方が揃わない
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { describe, it } from "node:test";

const dirs = (await readdir(new URL(".", import.meta.url), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

/** @type {[string, Record<string, string>, string, boolean][]} 名前・台帳・動かし手・期待 */
const cases = [
  ["本番の初回は動く", {}, "cosense", true],
  ["本番の 2 度目は動かない", { x: "running:cosense" }, "cosense", false],
  ["開発の予約があれば本番は動かない", { x: "reserved-for-dev" }, "cosense", false],
  ["開発の予約があれば開発版が動く", { x: "reserved-for-dev" }, "dev", true],
  ["予約が無ければ開発版は動かない", {}, "dev", false],
  ["別の id の印には左右されない", { y: "running:cosense" }, "cosense", true],
];

for (const dir of dirs) {
  /** @type {{ claim?: (registry: Record<string, string>, id: string, source: string) => boolean }} */
  let lib;
  try {
    lib = await import(`./${dir}/lib.js`);
  } catch {
    continue;
  }
  const { claim } = lib;
  if (claim === undefined) continue;
  describe(`${dir}/lib.js の claim`, () => {
    for (const [name, registry, source, expected] of cases) {
      it(name, () => {
        const copy = { ...registry };
        assert.equal(claim(copy, "x", source), expected);
        assert.equal(copy.x, expected ? `running:${source}` : registry.x);
      });
    }
  });
}
