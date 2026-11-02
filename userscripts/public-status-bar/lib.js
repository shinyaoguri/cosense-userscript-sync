// 公開状態を表示するバーの、画面に触れない部分 (単体テストする)

/**
 * バーの見た目。
 * @typedef {{ label: string, description: string, background: string }} BarStyle
 */

/**
 * プロジェクトの公開状態から、バーの見た目を決める。
 * 調べられなかったとき (通信の失敗など) は「不明」として目立たせる。
 *
 * @param {boolean | undefined} publicVisible `/api/projects/<name>` の publicVisible
 * @returns {BarStyle}
 */
export function barStyle(publicVisible) {
  if (publicVisible === true) {
    return {
      label: "公開プロジェクト",
      description: "このプロジェクトのページは、ログインしていない人を含めて誰でも読めます",
      background: "#d1242f",
    };
  }
  if (publicVisible === false) {
    return {
      label: "非公開プロジェクト",
      description: "このプロジェクトのページは、メンバーだけが読めます",
      background: "#1a7f37",
    };
  }
  return {
    label: "公開状態が分かりません",
    description: "プロジェクトの情報を取得できませんでした",
    background: "#6e7781",
  };
}

/**
 * 同じ UserScript を 1 ページで 1 度だけ動かす。動かしてよければ台帳に印を付けて true を返す。
 *
 * - 本番 (Cosense が読み込む) は、台帳が空のときだけ動く。別々のハブから 2 度 import されても 1 度だけ
 * - 開発版 (Tampermonkey のローダー) は、ローダーが先に付けた予約の印があるときだけ動く。
 *   予約があると本番は動かないので、開発中は本番版と二重に動かない
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
