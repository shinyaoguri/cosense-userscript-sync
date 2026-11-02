// cosense-sync.config.json の読み込みと検査。UserScript とページ・コードブロックの対応の正本。
import { readFile } from "node:fs/promises";

export type ScriptEntry = {
  /** 置き場のプロジェクト */
  readonly project: string;
  /** 置き場のページ名 (日本語・空白を含んでよい) */
  readonly page: string;
  /** 同期するファイル。`userscripts/<id>/<file>` を、ページの `code:<file>` へ */
  readonly files: readonly string[];
};

export type Config = {
  readonly origin: string;
  /** `owner/name`。出どころの印に書く GitHub の URL を作る */
  readonly repository: string;
  readonly dev: { readonly project: string; readonly port: number };
  readonly scripts: Readonly<Record<string, ScriptEntry>>;
};

export const CONFIG_FILE = "cosense-sync.config.json";

const ID = /^[a-z0-9][a-z0-9-]*$/;
const FILE = /^[\w.-]+\.(js|mjs|css)$/;

export function parseConfig(json: unknown): Config {
  const fail = (message: string): never => {
    throw new Error(`${CONFIG_FILE}: ${message}`);
  };
  const config = json as Config;
  if (typeof config?.origin !== "string") fail("origin がありません");
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repository ?? ""))
    fail("repository は owner/name の形で書いてください");
  if (typeof config.dev?.project !== "string" || !Number.isInteger(config.dev?.port)) {
    fail("dev.project と dev.port を書いてください");
  }
  const targets = new Set<string>();
  for (const [id, entry] of Object.entries(config.scripts ?? {})) {
    if (!ID.test(id))
      fail(`scripts.${id}: id は英小文字・数字・ハイフンにしてください (ディレクトリ名になる)`);
    if (typeof entry.project !== "string" || typeof entry.page !== "string" || entry.page.trim() === "") {
      fail(`scripts.${id}: project と page を書いてください`);
    }
    if (!Array.isArray(entry.files) || entry.files.length === 0) fail(`scripts.${id}: files が空です`);
    for (const file of entry.files) {
      if (!FILE.test(file)) fail(`scripts.${id}: ファイル名 ${file} は使えません`);
    }
    const target = `${entry.project}/${entry.page}`;
    if (targets.has(target)) fail(`scripts.${id}: /${target} は別の id と同じページです`);
    targets.add(target);
  }
  return config;
}

export async function loadConfig(root: string): Promise<Config> {
  return parseConfig(JSON.parse(await readFile(`${root}/${CONFIG_FILE}`, "utf8")));
}
