// 全角スペースを強調表示する UserScript の、画面に触れない部分 (単体テストする)

/** 強調する文字 (全角スペース) */
export const TARGET = "　";

/**
 * 同じ UserScript を 1 ページで 1 度だけ動かす。動かしてよければ台帳に印を付けて true を返す。
 * (public-status-bar/lib.js の claim の複製。ページをまたいで静的 import できないので各ページに置き、
 * 複製どうしの挙動は userscripts/claim.test.js で揃える)
 *
 * @param {Record<string, string>} registry 台帳 (`globalThis.cosenseUserScripts`)
 * @param {string} id UserScript の id
 * @param {string} source 誰が動かそうとしているか ("cosense" か "dev")
 * @returns {boolean}
 */
export function claim(registry, id, source) {
  const current = registry[id];
  const allowed = source === "dev" ? current === "reserved-for-dev" : current === undefined;
  if (allowed) {
    registry[id] = `running:${source}`;
  }
  return allowed;
}

/**
 * 文字列の中の全角スペースの位置 (UTF-16 の添字) を返す。
 *
 * @param {string} text
 * @returns {number[]}
 */
export function targetIndices(text) {
  const indices = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === TARGET) indices.push(i);
  }
  return indices;
}
