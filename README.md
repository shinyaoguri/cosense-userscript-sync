# cosense-userscript-sync

Cosense (旧 Scrapbox) の UserScript を GitHub で開発・テストし、**UserScript ごとの Cosense ページ**の
コードブロックへ一方向に同期する。

```
ローカルで編集 → 実際の Cosense で確認 (保存でブラウザを再読み込み) → GitHub でテスト → Actions から Cosense へ配置
```

## 方針

- **1 UserScript = 1 ページ。** ページには目的・使い方・設定・制約・実例・関連リンクと、読めるコードが並ぶ。
  利用者は必要なものだけを、自分のページから 1 行ずつ import する
  ```
  import "/api/code/cosense-userscript-sync/公開状態を表示するバー/script.js";
  ```
- **正本を分ける。** コード・テスト・ビルド設定は GitHub、説明・使い方・議論は Cosense。
  同期するのは設定で指定したコードブロックの本文だけで、**説明・他のブロック・コメントは書き換えない**
- **配布コード = ソース。** JavaScript + JSDoc を TypeScript の `checkJs` で型検査し、ビルドしない
  (minify も bundle もしない)。手元のファイルが、そのまま Cosense に載って読まれる
- 1 ページの中でコードを分けるときは、ファイルごとに `code:<file>` を置き、相対 import (`./lib.js`) で読む。
  `/api/code/<project>/<page>/lib.js` として同じページから配られるので、分けた先も同じページで読める。
  ページをまたいで共有するときは、相手のページを `await import("/api/code/...")` で読む (下の「制約」)

### 構成

| パス | 役割 |
|---|---|
| `userscripts/<id>/` | UserScript 1 本 (= ページ 1 枚)。`script.js` が入口。`*.test.js` は同期しない |
| `cosense-sync.config.json` | id → 置き場 (プロジェクト・ページ・同期するファイル)、開発用プロジェクト |
| `tools/sync/` | 同期コマンド。公式 CLI (`@helpfeel/cosense-cli`) を呼ぶ |
| `tools/dev/` | 開発用サーバーと Tampermonkey のローダー |
| `types/` | `scrapbox` グローバルの型 (コミュニティの [`@cosense/types`](https://github.com/scrapbox-jp/types)。公式の SDK ではない) |

依存はすべて `package.json` で版を固定し、`package-lock.json` で再現する。CLI も devDependency なので、
手元と CI で同じ版が動く。

## 初回セットアップ

Node.js 24 以上が要る (同期ツールは TypeScript を node が直接実行する)。

```bash
npm ci
```

```bash
npm run check
```

`check` は lint (Biome) → 型検査 (tsc) → 単体テスト (`node --test`) で、CI と同じもの。Cosense には繋がない。

Cosense への読み書きは CLI の認証を使う。手元では次のどちらか:

- `COSENSE_PAT` 環境変数で Personal Access Token を渡す (1Password などから実行時に読むなら `COSENSE_PAT=$(...) npm run sync`)
- `npx cosense login https://scrapbox.io` で `~/.cosense/settings.json` に保存する

PAT は Cosense の Settings → Personal Access Tokens で作る。**公開プロジェクトの読み取り (dry-run) は認証なしで動く。**

## ローカルでの開発・確認

保存すると、実際の Cosense の画面が再読み込みされて開発版が動く。

1. 開発用サーバーを起動する。対象の UserScript を選べる (省略するとすべて)
   ```bash
   npm run dev -- public-status-bar
   ```
2. 初回だけ、Tampermonkey に `http://127.0.0.1:5917/loader.user.js` を入れる
   (サーバーを起動した状態でこの URL を開くと、Tampermonkey がインストール画面を出す)
3. 開発用プロジェクト (`cosense-sync.config.json` の `dev.project`) のページを開く。
   コンソールに `[dev loader] public-status-bar: running:dev` が出れば開発版が動いている
4. `userscripts/<id>/` のファイルを保存すると、ブラウザが再読み込みされる

仕組みと注意:

- **再読み込みはページ全体の再読み込み**で、状態を保つ HMR ではない
- **開発版は開発用プロジェクトでだけ動く。** ページ内の移動で別のプロジェクトへ出たら、ローダーが再読み込みして開発版を外す
- **本番版との二重実行を防ぐ。** ローダーは開発する id に予約の印 (`globalThis.cosenseUserScripts[id]`) を
  document-start で付け、本番版 (Cosense が読み込む) は予約を見て何もしない。各スクリプトの冒頭の `claim()` がこれを見る。
  同じスクリプトが 2 つのハブから import されたときも 1 度だけ動く
- 開発用サーバーが止まっていたら、ローダーは予約を外して 1 度だけ再読み込みし、本番版で動く状態に戻す
- 保存の検知は `userscripts/` 全体を見て、**選んだスクリプトのバンドルの中身が変わったときだけ**知らせる
  (依存するファイルの変更も拾い、関係ないスクリプトの変更では再読み込みしない)
- scrapbox.io の CSP は localhost からの `<script>` も `fetch` も許さない。そこでローダーが `GM_xmlhttpRequest` で取り、
  ページの `eval` で評価する (CSP は `'unsafe-eval'` を許している)。eval は ES module を評価できないので、
  開発用サーバーは esbuild で相対 import をまとめ、async 関数で包んで配る (minify せず、ソースマップ付き)。
  **本番 (Cosense が ES module として読む) との違い**:
  - `script.js` は何も `export` しない (export するものは `lib.js` などへ分ける)
  - 他のページを静的 `import` すると開発版では評価できない。`await import("/api/code/...")` で書く
  - `import.meta` は使えない
- 本番のコードは Tampermonkey の API に依存しない (ローダーだけが使う)

**ローカルで確かめられること**は、単体テストと型検査まで。Cosense 全体をオフラインで再現する仕組みは持たない。
画面での動作は、上の手順で実際の Cosense で確かめる。

## 新しい UserScript の追加

1. `userscripts/<id>/script.js` を書く (id は英小文字・数字・ハイフン)。冒頭に `claim()` の判定を入れる
   (`userscripts/public-status-bar/` が手本)。画面に触れない処理は `lib.js` へ分けて `lib.test.js` でテストする
2. `cosense-sync.config.json` の `scripts` に置き場を足す
   ```json
   "my-script": { "project": "cosense-userscript-sync", "page": "見出しナビゲーション", "files": ["script.js"] }
   ```
3. コミットしてから、ページを雛形で作る (既にあるページは触らない)
   ```bash
   npm run sync -- init my-script
   ```
4. コードを入れる
   ```bash
   npm run sync -- my-script
   ```
5. Cosense のページで説明 (目的・使い方・設定・制約・実例) を書く。**説明の正本は Cosense** なので、以後は Cosense で直す

既存のページへ同期を始めるときは、ページに `code:<file>` の見出しを置く。中身が既にあるコード (出どころの印が無いもの)
は「管理外」として競合になるので、内容を確かめてから `--force` で取り込む。

## Cosense のページ側で必要な初期設定

- **置き場のページ**: 同期するファイルごとに `code:<file>` の見出しが 1 つずつあること。
  同名の見出しが 2 つ以上あると止まる (Cosense は同名のブロックを連結して配るため)。見出しは箇条書きの中 (インデントあり) でもよい
- **配布コードの 1 行目は出どころの印** (`// synced from <GitHub の URL> sha256:<16 桁>`)。
  読み手は GitHub の同じ版へ辿れる。**印とコードは Cosense で直接直さない** (直すと次の同期が競合で止まる)
- **使う人の設定**: User settings で UserScript を有効にし、使うプロジェクトの自分のページ (ユーザー名のページ) の
  `code:script.js` に import を 1 行書く。最初に読み込むとき、Cosense が「新しいUserScriptを読み込む」の承認を求める
  (自分のページの `script.js` を書き換えるたびに 1 回。import 先のページの更新では求められない)
- UserScript はそのプロジェクトのメンバーにしか動かない (ゲスト閲覧では動かない)

## PAT と GitHub Secrets の設定

**PAT にはスコープが無く、そのアカウントが見られるプロジェクトすべてを読み書きできる。** CI に置くときは:

- **配布するプロジェクトにだけ参加させた専用アカウントの PAT を使う**ことを勧める。漏れたときに届く範囲が、そのアカウントの参加先に限られる
- Service Account (プロジェクト単位の鍵。CLI では `x-service-account-access-key` で送る) はプロジェクトに絞れるが、
  ビジネスプラン限定で、PAT とは権限も発行手順も違う。このリポジトリは PAT を前提にしている
  (CLI は `COSENSE_PAT` があればそれを優先する)

登録 (リポジトリの管理者が行う):

1. GitHub の Settings → Environments で `cosense` を作る。配置のたびに人の承認を挟むなら Required reviewers を、
   main 以外から使わせないなら Deployment branches を main に絞る
2. その environment の Secrets に `COSENSE_PAT` を足す
   ```bash
   gh secret set COSENSE_PAT --env cosense -R shinyaoguri/cosense-userscript-sync
   ```
   (値は対話で貼る。コマンドラインの引数やファイルに書かない)

PAT はデプロイのワークフローの同期のステップにだけ渡り、Actions がログ上で伏せる。リポジトリ・成果物には入らない。

## dry-run と手動デプロイ

```bash
npm run sync -- public-status-bar --dry-run   # 差分と競合を見るだけ (preview もしない)
npm run sync -- public-status-bar --preview   # サーバーの preview まで行う (確定しない。認証が要る)
npm run sync -- public-status-bar             # 配置する
npm run sync                                  # 設定にあるすべて
```

書き込むときは、同期するファイルがコミット済みであること (出どころの印に HEAD のリビジョンを書くため)。
終了コードは 0 = 成功・変化なし・dry-run / 1 = 競合で止めた / 2 = エラー。

配置の手順 (1 ページ = 1 回の書き込み):

1. ページを読み、`code:<file>` をちょうど 1 つ見つける (0 個・2 個以上なら止める)
2. ページ上のコードの sha256 を出どころの印と比べる。違えば手で直されているので止める (競合)
3. 中身が手元と同じなら書き込まない (リビジョンだけ違っても印を書き換えない)
4. 行単位の差分 (LCS) で、変わった行だけを `replace` / `insertBefore` / `delete` にする。変わらない行は行 ID ごと残る
5. `previewEdit` の結果を受け取り、**ブロック外の行がすべて元のまま**で、対象のブロックが期待どおりで、
   preview のコミットが手順 1 で読んだものと同じことを確かめてから `submitEdit` する
6. ページを読み直してページ全体を照合し、配信される `/api/code/<project>/<page>/<file>` の中身が手元のソースと同じかを確かめる

**競合を検出できる範囲:**

| 期間 | 誰が検出するか |
|---|---|
| 前回の配置 → 今回の読み取り | このツール (出どころの印の sha256) |
| 今回の読み取り → preview | このツール (preview のコミット ID の比較)。違えば読み直してやり直す |
| preview → 確定 | Cosense のサーバー (`409 NotFastForward`)。読み直してやり直す |

**通信の失敗:** 確定の結果が分からない (5xx・通信断) ときは、ページを読み直して決める。期待どおりになっていれば成功、
ページが変わっていなければ待って (2・4・8 秒) preview からやり直し、別の内容に変わっていれば止める。
権限などの 4xx はやり直さない。

1 回の書き込みは ops 25KB まで (30KB 前後で通らなくなる実測がある)。超えるときは止まるので、スクリプトを分ける。

## GitHub Actions からのデプロイ

- `CI` (PR と main): `npm run check`。加えて、公開プロジェクトのページとの差分を認証なしの dry-run で見る
  (`cosense-diff`。required にしない。ページ上の手編集があると赤くなり、サマリに差分が出る)
- `Deploy to Cosense` (手動): Actions のタブから main を選んで起こす
  - `mode`: `dry-run` / `preview` / `deploy`。preview と deploy は main からだけ
  - `scripts`: id を空白区切りで (空ならすべて)
  - `force`: 競合を上書きする (先に dry-run で差分を確かめる)
  - `ref`: 配置するリビジョン (古い版へ戻すとき)
  - 結果と差分はジョブのサマリに出る。同じ配置先への実行は直列になる

```bash
gh workflow run deploy.yml -f mode=dry-run -f scripts=public-status-bar
```

```bash
gh workflow run deploy.yml -f mode=deploy -f scripts=public-status-bar
```

**自動デプロイにするとき**は、`deploy.yml` の `push` のコメントを外す。main に入った UserScript がそのまま配られる。
競合があると失敗して止まり、上書きはしない。

## 競合時の対処

`npm run sync` (または Actions) が「競合」で止まったら、出力に 2 つの差分が出る:
「前回配置した版 → ページ」(誰かが Cosense で直した内容) と「ページ → 手元」(上書きしたときの変化)。

- **ページ上の変更を取り込む**: 差分を手元のソースに反映してコミットし、`--force` で配置する
- **ページ上の変更を捨てる**: 内容を確かめてから `--force` で配置する
- **出どころの印が無い** (管理外のコード): 既存のコードを取り込むときに起きる。手元のソースと見比べてから `--force`

いずれも、ページの説明や他のブロックは変わらない。

## 過去のコードへ戻す

- **基本は main で revert して配置する。** main と Cosense の中身が一致したままになる
  ```bash
  git revert <commit>
  ```
  ```bash
  npm run sync -- <id>
  ```
- 急ぐときは、Actions の `Deploy to Cosense` に `ref` (戻したい版のコミット) を指定して配置する。
  出どころの印はその版を指すので、次に main から配置すれば main の版へ戻る
- Cosense のページの履歴 (Page History) からも戻せるが、そうするとコードと印が食い違って次の同期が競合になる。
  GitHub 側で戻す方が後の同期と噛み合う

## 自動化できない操作と制約

- **「新しいUserScriptを読み込む」の承認**: 自分のページの `code:script.js` を書き換えたとき、Cosense が各ブラウザで 1 回の手動承認を求める。
  自分のページは import の行だけにしておけば、import 先の更新では求められない
- **UserScript の有効化** (User settings) と、**Tampermonkey へのローダーのインストール**は各自が手で行う
- **PAT の発行と GitHub への登録**は人が行う (PAT はスコープが無いので、置き場と権限を人が決める)
- **配信のキャッシュ**: 公開ページの `/api/code/...` は Cloudflare のエッジで最長 2 時間キャッシュされる実測がある。
  配置直後に古い版が返ることがある (照合はクエリを付けてキャッシュを避けて行う)。ログインしたブラウザには早く届いた実測もあるが、理由は未確認
- **モジュールは 1 ドキュメントで 1 度だけ評価される**: Cosense はプロジェクトを移ってもページを読み直さないので、
  一度読み込まれた UserScript は他のプロジェクトへ移っても動き続ける。プロジェクトごとの振る舞いは、スクリプトの側で
  `project:changed` などを見て切り替える
- 非公開プロジェクトのページは、認証なしでは読めない (CI の `cosense-diff` で差分を見られない)
- Cosense の API は変わりうる。書き込みは公式 CLI の `previewEdit` / `submitEdit` だけを使い、内部 API や WebSocket は真似しない。
  CLI の版は `package.json` で固定し、上げるときは `npm run sync -- --preview` で確かめる
- previewEdit の出力 (人が読む形式) を解析して照合している。形式が変わったら照合が失敗して止まる (読めないまま確定はしない)
