// Ctrl+FでScrapboxのページをフルスクリーンにするUserScript
// プレゼンテーションモードの時に活躍する
import { claim, isToggleKey } from "./lib.js";

const SCRIPT_ID = "fullscreen-shortcut";

function toggleFullScreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else if (document.exitFullscreen) {
    document.exitFullscreen();
  }
}

const source = typeof cosenseUserScriptSource === "string" ? cosenseUserScriptSource : "cosense";
globalThis.cosenseUserScripts ??= {};
if (claim(globalThis.cosenseUserScripts, SCRIPT_ID, source)) {
  document.addEventListener(
    "keydown",
    (e) => {
      if (isToggleKey(e)) {
        toggleFullScreen();
      }
    },
    false,
  );
} else {
  console.info(`[${SCRIPT_ID}] 既に動いているので、この読み込み (${source}) では何もしません`);
}
