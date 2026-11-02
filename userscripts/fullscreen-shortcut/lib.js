// Ctrl+F でページをフルスクリーンにする UserScript の、画面に触れない部分 (単体テストする)

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
 * フルスクリーンを切り替えるキー操作か。Ctrl+F (Shift の有無は問わない) だけを拾う。
 *
 * @param {{ ctrlKey: boolean, key: string }} event
 * @returns {boolean}
 */
export function isToggleKey(event) {
  return event.ctrlKey && (event.key === "f" || event.key === "F");
}
