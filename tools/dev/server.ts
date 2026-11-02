// 開発用サーバー。選んだ UserScript を localhost から配り、保存したらブラウザを再読み込みさせる。
//
//   npm run dev -- [<id>...] [--port 5173]
//
// - 実際の Cosense の画面には、Tampermonkey のローダー (`/loader.user.js`) が届ける。scrapbox.io の CSP は
//   localhost からの script も fetch も許さないので、ローダーが GM_xmlhttpRequest で取って、ページの eval で評価する
//   (CSP は 'unsafe-eval' を許している)
// - 配るのは esbuild でまとめたもの (minify しない・ソースマップ付き)。相対 import (`./lib.js`) を 1 つにまとめ、
//   全体を async 関数で包む。eval は ES module を評価できないため。本番 (Cosense が ES module として読む) との違いは README に書いた
// - 保存の検知は userscripts/ 全体を見て、選んだスクリプトのバンドルの中身が変わったときだけ知らせる
//   (依存するファイルの変更も拾い、関係ないファイルでは再読み込みしない)
// - 「再読み込み」はブラウザのページの再読み込みで、状態を保つ HMR ではない
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as esbuild from "esbuild";
import { loadConfig } from "../sync/config.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const USERSCRIPTS = join(ROOT, "userscripts");

/** 再読み込みを待つ接続を、変化が無くても返す間隔。ローダー側のタイムアウトより短くする */
const WAIT_MS = 25_000;

type Bundle = { readonly code: string; readonly hash: string };

/**
 * ローダーが eval する形にまとめる。止めるべき形 (eval では動かない) は、ブラウザのコンソールに出るエラーにする
 */
export async function bundle(id: string): Promise<Bundle> {
  const entry = join(USERSCRIPTS, id, "script.js");
  let code: string;
  try {
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      metafile: true,
      sourcemap: "inline",
      sourcesContent: true,
      charset: "utf8",
      // Cosense の他のページ (`/api/code/...`) は手元に無いので、そのまま残す (動的 import なら動く)
      external: ["/api/*"],
      logLevel: "silent",
    });
    const [output] = Object.values(result.metafile.outputs);
    const staticExternal = output.imports.filter((i) => i.external && i.kind === "import-statement");
    if (staticExternal.length > 0) {
      throw new Error(
        `他のページの静的 import (${staticExternal.map((i) => i.path).join(", ")}) は開発用ローダーでは評価できません。` +
          "await import(...) で書いてください",
      );
    }
    if (output.exports.length > 0) {
      throw new Error("script.js は何も export しないでください (export するものは lib.js などへ分ける)");
    }
    code = [
      `(async (cosenseUserScriptSource) => {`,
      `"use strict";`,
      result.outputFiles[0].text,
      `})("dev").catch((error) => console.error("[${id}] dev", error));`,
      `//# sourceURL=cosense-dev/${id}/bundle.js`,
    ].join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${id}] ビルドに失敗: ${message}`);
    code = `console.error(${JSON.stringify(`[${id}] 開発版のビルドに失敗: ${message}`)});`;
  }
  return { code, hash: createHash("sha256").update(code).digest("hex") };
}

async function main(): Promise<void> {
  const config = await loadConfig(ROOT);
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { port: { type: "string" } },
  });
  const port = Number(values.port ?? config.dev.port);
  const ids = positionals.length > 0 ? positionals : Object.keys(config.scripts);
  for (const id of ids) {
    if (config.scripts[id] === undefined) throw new Error(`設定に ${id} がありません`);
  }

  const bundles = new Map<string, Bundle>();
  let version = 0;
  const waiting = new Set<ServerResponse>();

  const rebuild = async () => {
    let changed = false;
    for (const id of ids) {
      const next = await bundle(id);
      if (bundles.get(id)?.hash !== next.hash) changed = true;
      bundles.set(id, next);
    }
    if (changed) {
      version++;
      for (const response of waiting) sendJson(response, { version });
      waiting.clear();
    }
    return changed;
  };
  await rebuild();

  let timer: NodeJS.Timeout | undefined;
  watch(USERSCRIPTS, { recursive: true }, (_event, file) => {
    // エディタの保存は複数のイベントになるので、まとめてから作り直す
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (await rebuild())
        console.log(`${new Date().toLocaleTimeString()} ${file} → 再読み込みを知らせました`);
    }, 100);
  });

  const loader = (await readFile(join(ROOT, "tools/dev/loader.user.js"), "utf8")).replace(
    /const DEV_SERVER = ".*";/,
    `const DEV_SERVER = "http://127.0.0.1:${port}";`,
  );

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://localhost:${port}`);
    if (url.pathname === "/config") {
      sendJson(response, { project: config.dev.project, scripts: ids, version });
      return;
    }
    if (url.pathname === "/wait") {
      if (Number(url.searchParams.get("version")) !== version) {
        sendJson(response, { version });
        return;
      }
      waiting.add(response);
      const timeout = setTimeout(() => {
        waiting.delete(response);
        sendJson(response, { version });
      }, WAIT_MS);
      response.on("close", () => {
        clearTimeout(timeout);
        waiting.delete(response);
      });
      return;
    }
    const match = /^\/bundle\/([a-z0-9-]+)\.js$/.exec(url.pathname);
    const found = match === null ? undefined : bundles.get(match[1]);
    if (found !== undefined) {
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(found.code);
      return;
    }
    if (url.pathname === "/loader.user.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(loader);
      return;
    }
    response.writeHead(404).end();
  });
  // localhost だけで待つ (同じネットワークの他の機械には配らない)
  server.listen(port, "127.0.0.1", () => {
    console.log(`開発版を配っています: ${ids.join(", ")} → /${config.dev.project}`);
    console.log(`Tampermonkey のローダー: http://127.0.0.1:${port}/loader.user.js`);
  });
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(2);
  });
}
