// Ctrl+FでScrapboxのページをフルスクリーンにするUserScript
// プレゼンテーションモードの時に活躍する
function toggleFullScreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else if (document.exitFullscreen) {
    document.exitFullscreen();
  }
}
document.addEventListener(
  "keydown",
  (e) => {
  	if (e.ctrlKey) {
    	if (e.key === "f" || e.key === "F") {
      	toggleFullScreen();
    	}
    }
  },
  false,
);