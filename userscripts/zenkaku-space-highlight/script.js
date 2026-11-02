(() => {
  "use strict";

  if (!("highlights" in CSS) || typeof Highlight === "undefined") {
    console.warn("[zenkaku] CSS Custom Highlight API 非対応のブラウザです");
    return;
  }

  const TARGET = "\u3000";
  const HL_NAME = "zenkaku-space";
  const STYLE_ID = "zenkaku-space-style";

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

  const collectRanges = (root) => {
    const ranges = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.includes(TARGET))
          return NodeFilter.FILTER_REJECT;
        // script/style/textarea などをスキップ
        const p = node.parentElement;
        if (!p || p.closest("script,style,textarea,input,select,option")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    for (let n; (n = walker.nextNode()); ) {
      const text = n.nodeValue;
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== TARGET) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 1);
        ranges.push(r);
      }
    }
    return ranges;
  };

  let rafId = 0;
  const update = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      highlight.clear();
      const root =
        document.querySelector(".page-lines, .page, #page") || document.body;
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

  if (window.scrapbox?.addListener) {
    scrapbox.addListener("page:changed", update);
    scrapbox.addListener("lines:changed", update);
  }
})();