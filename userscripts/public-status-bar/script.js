// 公開状態を表示するバー
//
// 今いるプロジェクトが公開か非公開かを、画面の上端に細いバーで示す。
// 公開プロジェクトに、非公開のつもりで書いてしまう事故を防ぐ。
//
// - 公開状態は `/api/projects/<プロジェクト名>` の publicVisible で調べ、プロジェクトごとに 1 度だけ問い合わせる
// - Cosense はページを移ってもこのモジュールを読み直さない。移るたびに同じバーを描き直し、増やさない
import { barStyle, claim } from "./lib.js";

const SCRIPT_ID = "public-status-bar";
const BAR_ID = "public-status-bar";

/** プロジェクト名 → 公開か。問い合わせ中のものも入れて、同時に 2 度問い合わせない */
/** @type {Map<string, Promise<boolean | undefined>>} */
const visibilityCache = new Map();

/**
 * @param {string} project
 * @returns {Promise<boolean | undefined>}
 */
async function fetchPublicVisible(project) {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(project)}`);
    if (!response.ok) return undefined;
    const json = await response.json();
    return typeof json.publicVisible === "boolean" ? json.publicVisible : undefined;
  } catch {
    return undefined;
  }
}

/**
 * バーを描く。既にあれば中身だけ差し替えるので、何度呼んでも 1 本のまま。
 *
 * @param {import("./lib.js").BarStyle} style
 */
function renderBar(style) {
  let bar = document.getElementById(BAR_ID);
  if (bar === null) {
    bar = document.createElement("div");
    bar.id = BAR_ID;
    bar.setAttribute("role", "status");
    Object.assign(bar.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      zIndex: "10000",
      height: "18px",
      font: "bold 12px/18px sans-serif",
      color: "#fff",
      textAlign: "center",
      pointerEvents: "none",
      opacity: "0.85",
    });
    document.body.append(bar);
  }
  bar.textContent = style.label;
  bar.title = style.description;
  bar.style.background = style.background;
}

async function update() {
  const project = scrapbox.Project.name;
  let visibility = visibilityCache.get(project);
  if (visibility === undefined) {
    visibility = fetchPublicVisible(project);
    visibilityCache.set(project, visibility);
  }
  const publicVisible = await visibility;
  // 問い合わせている間に別のプロジェクトへ移っていたら、古い結果で描かない
  if (project === scrapbox.Project.name) {
    renderBar(barStyle(publicVisible));
  }
}

const source = typeof cosenseUserScriptSource === "string" ? cosenseUserScriptSource : "cosense";
globalThis.cosenseUserScripts ??= {};
if (claim(globalThis.cosenseUserScripts, SCRIPT_ID, source)) {
  update();
  scrapbox.on("project:changed", update);
  scrapbox.on("layout:changed", update);
} else {
  console.info(`[${SCRIPT_ID}] 既に動いているので、この読み込み (${source}) では何もしません`);
}
