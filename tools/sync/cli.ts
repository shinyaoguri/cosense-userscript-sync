// 同期コマンドの入口。
//
//   npm run sync -- [<id>...] [--dry-run] [--preview] [--force]
//   npm run sync -- init <id>
//
// 終了コード: 0 = 成功 (更新・変化なし・dry-run) / 1 = 競合で止めた / 2 = エラー
import { execFile as execFileCallback } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { type Config, loadConfig, type ScriptEntry } from "./config.ts";
import { CliClient, type CosenseClient } from "./cosense.ts";
import { parseBlobUrl, sourceLines } from "./page.ts";
import { type FilePlan, type SourceFile, SyncError, syncPage } from "./sync.ts";

const execFile = promisify(execFileCallback);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * 手元のソースを読む。出どころの URL には HEAD のリビジョンを書くので、書き込むときは
 * 作業ツリーのファイルが HEAD と同じでなければ止める (印の URL を開いても違うコードが出てしまう)
 */
async function readSources(
  config: Config,
  id: string,
  entry: ScriptEntry,
  allowDirty: boolean,
): Promise<SourceFile[]> {
  const rev = (await git("rev-parse", "HEAD")).trim();
  const sources: SourceFile[] = [];
  for (const file of entry.files) {
    const path = `userscripts/${id}/${file}`;
    const dirty = (await git("status", "--porcelain", "--", path)).trim() !== "";
    if (dirty && !allowDirty) {
      throw new SyncError(
        `${path} がコミットされていません。コミットしてから同期してください (dry-run なら確かめられます)`,
      );
    }
    sources.push({
      file,
      code: sourceLines(await readFile(join(ROOT, path), "utf8")),
      url: `https://github.com/${config.repository}/blob/${rev}/${encodeURI(path)}`,
    });
  }
  return sources;
}

/** 前回配置した版を git から取り出す。履歴に無ければ (浅い clone など) undefined */
async function previousSource(url: string): Promise<readonly string[] | undefined> {
  const blob = parseBlobUrl(url);
  if (blob === undefined) return undefined;
  try {
    return sourceLines(await git("show", `${blob.rev}:${blob.path}`));
  } catch {
    return undefined;
  }
}

/** 新しいページの雛形。説明は Cosense が正本なので、見出しと置き場だけを用意する */
export function pageTemplate(config: Config, id: string, entry: ScriptEntry): string {
  const importPath = `/api/code/${entry.project}/${entry.page.replaceAll(" ", "_")}/script.js`;
  const lines = [
    entry.page,
    "(このスクリプトの目的を書く)",
    "",
    "[* 使い方]",
    "自分のページ (ユーザー名のページ) の code:script.js に次の 1 行を足す",
    "code:例.js",
    ` import "${importPath}";`,
    "",
    "[* 設定]",
    "",
    "[* 制約]",
    "",
    "[* 実例]",
    "",
    "[* 関連]",
    `[GitHub https://github.com/${config.repository}/tree/main/userscripts/${id}]`,
    "",
    "[* 実装]",
    "以下のコードは GitHub から同期されます。直すときは GitHub で (ここを直接直すと、次の同期が競合で止まります)",
  ];
  // ブロックの間は空行で区切る。末尾の空行はサーバーが落とすので付けない
  lines.push(...entry.files.flatMap((file, i) => (i === 0 ? [`code:${file}`] : ["", `code:${file}`])));
  return lines.join("\n");
}

function summarize(id: string, entry: ScriptEntry, plans: readonly FilePlan[]): string {
  const parts = [`## ${id} → /${entry.project}/${entry.page}`];
  for (const plan of plans) {
    if (plan.kind === "unchanged") {
      parts.push(`- code:${plan.file}: 変化なし`);
      continue;
    }
    if (plan.kind === "conflict") {
      parts.push(`- code:${plan.file}: **競合** — ${plan.reason}`);
      if (plan.editedDiff)
        parts.push("", "ページ上での変更 (前回配置した版 → ページ):", "```diff", plan.editedDiff, "```");
      parts.push("", "--force で上書きしたときの変更 (ページ → 手元):");
    } else {
      parts.push(`- code:${plan.file}: 更新 (${plan.ops.length} ops)`);
    }
    if (plan.diff) parts.push("", "```diff", plan.diff, "```");
  }
  return parts.join("\n");
}

async function report(markdown: string): Promise<void> {
  console.log(markdown);
  // GitHub Actions では、ジョブのサマリにも出す (dry-run の差分をブラウザで読める)
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n\n`);
  }
}

async function init(client: CosenseClient, config: Config, id: string): Promise<number> {
  const entry = config.scripts[id];
  if (entry === undefined) throw new SyncError(`設定に ${id} がありません`);
  const page = await client.readPage(entry.project, entry.page);
  if (page.persistent) {
    throw new SyncError(`/${entry.project}/${entry.page} は既にあります。init は新しいページだけを作ります`);
  }
  const text = pageTemplate(config, id, entry);
  const preview = await client.previewNew(entry.project, text);
  if (preview.lines.join("\n") !== text) {
    throw new SyncError("preview の結果が雛形と違うので作りません");
  }
  await client.submitEdit(entry.project, preview.previewId);
  console.log(
    `/${entry.project}/${entry.page} を作りました。続けて npm run sync -- ${id} でコードを入れてください`,
  );
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      preview: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
  });
  const config = await loadConfig(ROOT);
  const client = new CliClient({
    // 既定は lockfile で固定した版。手元の別の cosense を使うときだけ COSENSE_CLI で差し替える
    bin: process.env.COSENSE_CLI ?? join(ROOT, "node_modules/.bin/cosense"),
    origin: config.origin,
  });

  if (positionals[0] === "init") {
    const id = positionals[1];
    if (id === undefined) throw new SyncError("init <id> の id がありません");
    return init(client, config, id);
  }

  const ids = positionals.length > 0 ? positionals : Object.keys(config.scripts);
  const dryRun = values["dry-run"] || values.preview;
  let exitCode = 0;
  for (const id of ids) {
    const entry = config.scripts[id];
    if (entry === undefined) throw new SyncError(`設定に ${id} がありません`);
    const sources = await readSources(config, id, entry, dryRun);
    const result = await syncPage(client, entry, sources, {
      dryRun,
      preview: values.preview,
      force: values.force,
      previousSource,
      log: (message) => console.error(`[${id}] ${message}`),
    });
    switch (result.status) {
      case "unchanged":
        await report(`## ${id} → /${entry.project}/${entry.page}\n- 変化なし (書き込みませんでした)`);
        break;
      case "conflict":
        await report(
          `${summarize(id, entry, result.plans)}\n\n**競合のため書き込みませんでした。** README の「競合時の対処」を見てください`,
        );
        exitCode = 1;
        break;
      case "would-update":
        await report(
          `${summarize(id, entry, result.plans)}\n\n(dry-run${result.previewed ? "。サーバーの preview で、説明と他のブロックが変わらないことを確かめました" : ""})`,
        );
        break;
      case "updated":
        await report(
          `${summarize(id, entry, result.plans)}\n\n更新しました (commit ${result.commitId})。読み直したページと /api/code の中身を照合済み`,
        );
        break;
    }
  }
  return exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
      process.exit(2);
    },
  );
}
