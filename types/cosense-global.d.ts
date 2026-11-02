// UserScript から見えるグローバルの型。
//
// `scrapbox` / `cosense` は Cosense 本体が置くオブジェクトで、型はコミュニティの @cosense/types
// (scrapbox-jp/types。公式の SDK ではない) に頼る。ambient の宣言を持たないパッケージなので、ここで結び付ける。
// 型だけを使い、実行時には何も import しない (配布コードはビルドしない)。
import type { Scrapbox } from "@cosense/types/userscript";

declare global {
  const scrapbox: Scrapbox;
  const cosense: Scrapbox;

  /**
   * 同じ UserScript を 1 ページで 1 度だけ動かすための台帳 (id → 誰が動かしているか)。
   * 開発用ローダーは、開発中の id を document-start で "reserved-for-dev" にしておく。
   */
  var cosenseUserScripts: Record<string, string> | undefined;

  /** 開発用ローダーが開発版を評価するときだけ "dev" になる。本番 (Cosense が読み込む) では未定義 */
  var cosenseUserScriptSource: string | undefined;
}
