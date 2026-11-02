// 全角スペースを強調表示するUserScript
//
// CSS Custom Highlight API で、ページ中の全角スペースに色を付ける (DOM は書き換えない)
import { claim, TARGET, targetIndices } from "./lib.js";

const SCRIPT_ID = "zenkaku-space-highlight";
const HL_NAME = "zenkaku-space";
const STYLE_ID = "zenkaku-space-style";

/**
 * @param {Node} root
 * @returns {Range[]}
 */
function collectRanges(root) {
  const ranges = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.includes(TARGET)) return NodeFilter.FILTER_REJECT;
      // script/style/textarea などをスキップ
      const p = node.parentElement;
      if (!p || p.closest("script,style,textarea,input,select,option")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    for (const i of targetIndices(n.nodeValue ?? "")) {
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + 1);
      ranges.push(r);
    }
  }
  return ranges;
}

function start() {
  if (!("highlights" in CSS) || typeof Highlight === "undefined") {
    console.warn("[zenkaku] CSS Custom Highlight API 非対応のブラウザです");
    return;
  }

  // ハイライト用のスタイルを一度だけ注入
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      ::highlight(${HL_NAME}) {
        background-color: rgba(255, 0, 0, 0.35);
        border-radius: 2px;
      }
    `;
    document.head.appendChild(style);
  }

  const highlight = new Highlight();
  CSS.highlights.set(HL_NAME, highlight);

  let rafId = 0;
  const update = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      highlight.clear();
      const root = document.querySelector(".page-lines, .page, #page") || document.body;
      for (const r of collectRanges(root)) highlight.add(r);
    });
  };

  update();

  const obs = new MutationObserver(update);
  obs.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  if (typeof scrapbox !== "undefined" && scrapbox.addListener) {
    scrapbox.addListener("page:changed", update);
    scrapbox.addListener("lines:changed", update);
  }
}

const source = typeof cosenseUserScriptSource === "string" ? cosenseUserScriptSource : "cosense";
globalThis.cosenseUserScripts ??= {};
if (claim(globalThis.cosenseUserScripts, SCRIPT_ID, source)) {
  start();
} else {
  console.info(`[${SCRIPT_ID}] 既に動いているので、この読み込み (${source}) では何もしません`);
}
