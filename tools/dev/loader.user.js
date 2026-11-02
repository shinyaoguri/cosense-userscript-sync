// ==UserScript==
// @name         cosense-userscript-sync dev loader
// @namespace    https://github.com/shinyaoguri/cosense-userscript-sync
// @version      1.0.1
// @description  開発中の UserScript を localhost から実際の Cosense に読み込み、保存したら再読み込みする
// @match        https://scrapbox.io/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      127.0.0.1
// @updateURL    http://127.0.0.1:5917/loader.user.js
// @downloadURL  http://127.0.0.1:5917/loader.user.js
// ==/UserScript==

// 開発のときだけ入れる。本番の UserScript はこのローダーにも Tampermonkey にも依存しない。
//
// - 開発用サーバー (`npm run dev`) の設定にある開発用プロジェクトでだけ動く。ページ内の移動で別のプロジェクトへ
//   出入りしたら再読み込みし、開発版を他のプロジェクトへ持ち出さない
// - 本番版との二重実行を防ぐ: document-start で、開発する id に予約の印を付ける (`globalThis.cosenseUserScripts`)。
//   本番版は予約を見て何もしない。予約は前回の設定を覚えておいて同期的に付ける (サーバーへの問い合わせを
//   待つ間に本番版が先に動かないように)
// - サーバーが止まっていたら予約を外して 1 度だけ再読み込みし、本番版が動く状態に戻す

// サーバーが配るときに、実際のポートに書き換える
const DEV_SERVER = "http://127.0.0.1:5917";
const CACHE_KEY = "devConfig";

/**
 * @typedef {{ project: string, scripts: string[], version: number }} DevConfig
 */

/**
 * @param {string} path
 * @param {number} timeout
 * @returns {Promise<string>}
 */
function request(path, timeout) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: "GET",
      url: `${DEV_SERVER}${path}`,
      timeout,
      onload: (response) =>
        response.status === 200
          ? resolve(response.responseText)
          : reject(new Error(`HTTP ${response.status}`)),
      onerror: () => reject(new Error("開発用サーバーに繋がりません")),
      ontimeout: () => reject(new Error("timeout")),
    });
  });
}

/** ページの側 (Cosense と同じ realm) で評価する。scrapbox.io の CSP は 'unsafe-eval' を許している */
const pageEval = (/** @type {string} */ code) => unsafeWindow.eval(code);

const currentProject = () => decodeURIComponent(location.pathname.split("/")[1] ?? "");

/** @param {string[]} ids */
function reserve(ids) {
  pageEval(`globalThis.cosenseUserScripts ??= {};
for (const id of ${JSON.stringify(ids)}) globalThis.cosenseUserScripts[id] ??= "reserved-for-dev";`);
}

/** @param {() => boolean} ready */
async function waitFor(ready) {
  for (let i = 0; i < 300 && !ready(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function main() {
  const cached = /** @type {DevConfig | undefined} */ (GM_getValue(CACHE_KEY));
  const reserved = cached !== undefined && cached.project === currentProject();
  if (reserved) reserve(cached.scripts);

  /** @type {DevConfig} */
  let config;
  try {
    config = JSON.parse(await request("/config", 3000));
  } catch {
    if (reserved) {
      console.warn("[dev loader] 開発用サーバーが止まっているので、本番版で読み直します");
      GM_setValue(CACHE_KEY, undefined);
      location.reload();
    }
    return;
  }
  GM_setValue(CACHE_KEY, config);
  const active = config.project === currentProject();
  const sameScripts = reserved && JSON.stringify(cached.scripts) === JSON.stringify(config.scripts);
  if (active !== reserved || (active && !sameScripts)) {
    // 予約と今の設定が食い違う (開発する id を変えた・初めて使う): 予約を付け直すために読み直す
    location.reload();
    return;
  }

  // ページ内の移動で、開発用プロジェクトに入った・出たら読み直す
  setInterval(() => {
    if ((currentProject() === config.project) !== active) location.reload();
  }, 1000);
  if (!active) return;

  // Cosense の準備ができる前は、scrapbox.Project.name の getter が例外を投げる (中の値がまだ null)
  await waitFor(() =>
    pageEval("(() => { try { return Boolean(scrapbox.Project.name); } catch { return false; } })()"),
  );
  for (const id of config.scripts) {
    pageEval(await request(`/bundle/${id}.js`, 10_000));
    // 開発版が台帳を取れたか (本番版が先に動いていたら取れない)
    const state = pageEval(`globalThis.cosenseUserScripts?.[${JSON.stringify(id)}]`);
    console.info(`[dev loader] ${id}: ${state}`);
    if (state !== "running:dev") {
      console.warn(`[dev loader] ${id} は開発版で動いていません (${state})。ページを再読み込みしてください`);
    }
  }

  // 保存を待つ。サーバーは変化があるか 25 秒たったら返す
  let version = config.version;
  for (;;) {
    try {
      const next = JSON.parse(await request(`/wait?version=${version}`, 35_000)).version;
      if (next !== version) {
        location.reload();
        return;
      }
      version = next;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

main().catch((error) => console.error("[dev loader]", error));
