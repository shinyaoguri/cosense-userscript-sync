// Cosense との通信。書き込みは公式 CLI (@helpfeel/cosense-cli) の previewEdit / submitEdit だけを使い、
// 内部 API や WebSocket は真似しない。テストではこのインターフェースを偽物に差し替える。
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "./diff.ts";
import { encodeTitle, type Line } from "./page.ts";

export type Page = {
  readonly id: string;
  /** 最新コミットの ID。Cosense が自動で作ったページなどでは null になる */
  readonly commitId: string | null;
  readonly persistent: boolean;
  readonly lines: readonly Line[];
};

export type Preview = {
  readonly previewId: string;
  /** preview を作った時点のページの最新コミット。新規ページでは無い */
  readonly commitId: string | undefined;
  /** 適用後のページの行 (テキストだけ) */
  readonly lines: readonly string[];
};

/** CLI が非 0 で終わったときのエラー。`status` は HTTP のステータス (読み取れたときだけ) */
export class CosenseError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status: number | undefined) {
    super(message);
    this.name = "CosenseError";
    this.status = status;
  }
}

export interface CosenseClient {
  readPage(project: string, title: string): Promise<Page>;
  previewEdit(project: string, pageId: string, ops: readonly Op[]): Promise<Preview>;
  previewNew(project: string, text: string): Promise<Preview>;
  submitEdit(project: string, previewId: string): Promise<{ commitId: string }>;
  /** `/api/code/<project>/<page>/<file>` の中身 (エッジのキャッシュを避けて取る) */
  fetchCode(project: string, title: string, file: string): Promise<string>;
}

/**
 * previewEdit の出力 (人が読む plain text) から、適用後のページを取り出す。
 * 形式は CLI の src/commands/previewEdit.ts の formatPreview: 変わらない行は `  <text>`、
 * 足した行は `> <text> # <lineId>`、変えた行は `* <text> # <lineId>`。
 * 読めない形なら例外にする (読めないまま確定させない)
 */
export function parsePreview(output: string): Preview {
  const lines = output.split("\n");
  const header = (key: string) => lines.find((line) => line.startsWith(`${key}:`))?.replace(/^[^:]+:\s*/, "");
  const previewId = header("previewId");
  const start = lines.indexOf("page (after apply):");
  if (previewId === undefined || start < 0) {
    throw new Error(`previewEdit の出力を読めません:\n${output.slice(0, 500)}`);
  }
  const page: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const marker = line.slice(0, 2);
    if (marker === "  ") {
      page.push(line.slice(2));
    } else if (marker === "> " || marker === "* ") {
      page.push(line.slice(2).replace(/ # [0-9a-f]{24}$/, ""));
    } else {
      break;
    }
  }
  return { previewId, commitId: header("commitId"), lines: page };
}

type RunResult = { stdout: string; stderr: string };

/** 公式 CLI を子プロセスで呼ぶ実装。認証は CLI に任せる (環境変数 COSENSE_PAT か ~/.cosense/settings.json) */
export class CliClient implements CosenseClient {
  readonly #bin: string;
  readonly #origin: string;

  constructor(options: { bin: string; origin: string }) {
    this.#bin = options.bin;
    this.#origin = options.origin;
  }

  async readPage(project: string, title: string): Promise<Page> {
    const { stdout } = await this.#run(["readPage", `${this.#origin}/${project}/${encodeTitle(title)}`]);
    const json = JSON.parse(stdout) as {
      id?: string;
      commitId?: string | null;
      persistent: boolean;
      lines: { id?: string; text: string }[];
    };
    return {
      id: json.id ?? "",
      commitId: json.commitId ?? null,
      persistent: json.persistent,
      lines: json.lines.map((line) => ({ id: line.id ?? "", text: line.text })),
    };
  }

  async previewEdit(project: string, pageId: string, ops: readonly Op[]): Promise<Preview> {
    return this.#withInputFile(JSON.stringify({ ops }), async (file) => {
      const { stdout } = await this.#run([
        "previewEdit",
        "--input-file",
        file,
        `${this.#origin}/${project}`,
        pageId,
      ]);
      return parsePreview(stdout);
    });
  }

  async previewNew(project: string, text: string): Promise<Preview> {
    return this.#withInputFile(text, async (file) => {
      const { stdout } = await this.#run([
        "previewEdit",
        "--new",
        "--input-file",
        file,
        `${this.#origin}/${project}`,
      ]);
      return parsePreview(stdout);
    });
  }

  async submitEdit(project: string, previewId: string): Promise<{ commitId: string }> {
    const { stdout } = await this.#run(["submitEdit", `${this.#origin}/${project}`, previewId]);
    const commitId = /^commitId:\s*(\S+)/m.exec(stdout)?.[1];
    if (commitId === undefined) throw new Error(`submitEdit の出力を読めません:\n${stdout}`);
    return { commitId };
  }

  async fetchCode(project: string, title: string, file: string): Promise<string> {
    // `?` 付きはエッジのキャッシュを通らず元の値が返る (公開ページは最長 2 時間キャッシュされる)
    const url = `${this.#origin}/api/code/${project}/${encodeTitle(title)}/${encodeURIComponent(file)}?t=${Date.now()}`;
    const pat = process.env.COSENSE_PAT;
    const response = await fetch(url, {
      headers: pat ? { "x-personal-access-token": pat } : {},
    });
    if (!response.ok) {
      throw new CosenseError(`HTTP ${response.status} ${url}`, response.status);
    }
    return response.text();
  }

  async #withInputFile<T>(content: string, use: (file: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "cosense-sync-"));
    try {
      const file = join(dir, "input");
      await writeFile(file, content);
      return await use(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  #run(args: string[]): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      execFile(this.#bin, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const message = `${stderr || stdout || error.message}`.trim();
          const status = /HTTP (\d{3})/.exec(message)?.[1];
          reject(new CosenseError(message, status === undefined ? undefined : Number(status)));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}
