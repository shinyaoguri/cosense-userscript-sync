// 1 つの UserScript (= 1 ページ) のコードブロックを、手元のソースへ一方向に合わせる。
//
// 守ること:
// - 触るのは設定で指定したコードブロックの本文だけ。説明・他のブロック・コメントは変えない
// - ページ上のコードが前回の配置から手で変えられていたら、上書きせず競合として止める
// - 同じ内容なら書き込まない
// - 確定の前に preview の結果を、確定の後に読み直したページと配信される /api/code を照合する
import { type CosenseClient, CosenseError, type Page } from "./cosense.ts";
import { applyOps, blockOps, type Op, unifiedDiff } from "./diff.ts";
import {
  contentHash,
  findCodeBlocks,
  formatProvenance,
  fromBodyTexts,
  parseProvenance,
  toBodyTexts,
} from "./page.ts";

export type SourceFile = {
  /** コードブロックの名前 (`code:<file>`) */
  readonly file: string;
  /** コードの行 (`sourceLines` で整えたもの) */
  readonly code: readonly string[];
  /** 出どころ。GitHub の blob URL (リビジョン付き) */
  readonly url: string;
};

export type FilePlan =
  | { readonly file: string; readonly kind: "unchanged" }
  | {
      readonly file: string;
      readonly kind: "update";
      readonly ops: readonly Op[];
      /** ページ上の現状 → これから配置する版 */
      readonly diff: string;
    }
  | {
      readonly file: string;
      readonly kind: "conflict";
      readonly reason: string;
      /** 前回配置した版 → ページ上の現状 (前回の版が分かるときだけ) */
      readonly editedDiff: string | undefined;
      /** ページ上の現状 → これから配置する版 */
      readonly diff: string;
      /** --force で上書きするときの ops */
      readonly ops: readonly Op[];
    };

/** 止めるべき問題 (ブロックが無い・同名が複数ある)。--force でも越えない */
export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncError";
  }
}

export type PreviousSource = (url: string) => Promise<readonly string[] | undefined>;

/** ページの現状とソースから、ファイルごとの手順を決める。通信しない (前回の版の取得を除く) */
export async function planPage(
  page: Page,
  sources: readonly SourceFile[],
  previousSource: PreviousSource,
): Promise<FilePlan[]> {
  const plans: FilePlan[] = [];
  for (const source of sources) {
    const blocks = findCodeBlocks(page.lines, source.file);
    if (blocks.length === 0) {
      throw new SyncError(
        `code:${source.file} がページにありません。見出し行 \`code:${source.file}\` を置いてから同期してください`,
      );
    }
    if (blocks.length > 1) {
      throw new SyncError(
        `code:${source.file} がページに ${blocks.length} 個あります (Cosense は同名のブロックを連結して配る)。1 つにしてから同期してください`,
      );
    }
    const [block] = blocks;
    const remote = fromBodyTexts(
      block.body.map((line) => line.text),
      block.indent,
    );
    const hash = contentHash(source.code);
    const nextTexts = toBodyTexts(
      [formatProvenance({ url: source.url, hash }), ...source.code],
      block.indent,
    );
    const ops = blockOps(block.body, nextTexts, block.nextLineId);

    if (remote.length === 0) {
      plans.push({ file: source.file, kind: "update", ops, diff: fullDiff(remote, source) });
      continue;
    }
    const provenance = parseProvenance(remote[0]);
    if (provenance === undefined) {
      plans.push({
        file: source.file,
        kind: "conflict",
        reason: "出どころの印が無いコードがあります (手で書かれたか、このツールの管理外)",
        editedDiff: undefined,
        diff: fullDiff(remote, source),
        ops,
      });
      continue;
    }
    const content = remote.slice(1);
    if (contentHash(content) !== provenance.hash) {
      const previous = await previousSource(provenance.url);
      plans.push({
        file: source.file,
        kind: "conflict",
        reason: `前回の配置 (${provenance.url}) の後で、ページ上のコードが手で変えられています`,
        editedDiff:
          previous === undefined
            ? undefined
            : unifiedDiff(previous, content, {
                a: `前回配置した版: ${provenance.url}`,
                b: `cosense: code:${source.file}`,
              }),
        diff: fullDiff(content, source),
        ops,
      });
      continue;
    }
    if (provenance.hash === hash && content.join("\n") === source.code.join("\n")) {
      // 中身が同じなら、リビジョンが違っても印を書き換えない (不要な更新を出さない)
      plans.push({ file: source.file, kind: "unchanged" });
      continue;
    }
    plans.push({ file: source.file, kind: "update", ops, diff: fullDiff(content, source) });
  }
  return plans;
}

function fullDiff(remote: readonly string[], source: SourceFile): string {
  return unifiedDiff(remote, source.code, {
    a: `cosense: code:${source.file}`,
    b: `local: ${source.file}`,
  });
}

/** 1 回の preview に載せる ops の上限 (バイト)。30KB 前後で通らなくなる実測がある */
export const MAX_OPS_BYTES = 25_000;

/** 確定の結果が分からない・ページが途中で変わったときの待ち。preview からやり直す (previewId は 1 回限り) */
export const RETRY_WAITS_MS: readonly number[] = [2_000, 4_000, 8_000];

export type SyncOptions = {
  /** 書き込まない。`preview` も true なら、サーバーの preview (dry-run) まで行う */
  readonly dryRun: boolean;
  readonly preview: boolean;
  /** 競合しても上書きする */
  readonly force: boolean;
  readonly previousSource: PreviousSource;
  readonly log: (message: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
};

export type SyncResult =
  | { readonly status: "unchanged" }
  | { readonly status: "conflict"; readonly plans: readonly FilePlan[] }
  | { readonly status: "would-update"; readonly plans: readonly FilePlan[]; readonly previewed: boolean }
  | { readonly status: "updated"; readonly plans: readonly FilePlan[]; readonly commitId: string };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/** ページを読み、決めた手順で 1 commit だけ書き、照合する */
export async function syncPage(
  client: CosenseClient,
  target: { readonly project: string; readonly page: string },
  sources: readonly SourceFile[],
  options: SyncOptions,
): Promise<SyncResult> {
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    const retry = async (why: string) => {
      if (attempt >= RETRY_WAITS_MS.length) {
        throw new SyncError(`${why}。${attempt + 1} 回試して諦めました`);
      }
      options.log(`${why}。${RETRY_WAITS_MS[attempt] / 1000} 秒待って読み直します`);
      await sleep(RETRY_WAITS_MS[attempt]);
    };

    const page = await client.readPage(target.project, target.page);
    if (!page.persistent) {
      throw new SyncError(
        `ページ /${target.project}/${target.page} がありません。\`npm run sync -- init <id>\` で作ってください`,
      );
    }
    const plans = await planPage(page, sources, options.previousSource);
    const conflicts = plans.filter((plan) => plan.kind === "conflict");
    if (conflicts.length > 0 && !options.force) {
      return { status: "conflict", plans };
    }
    const ops = plans.flatMap((plan) => (plan.kind === "unchanged" ? [] : plan.ops));
    if (ops.length === 0) {
      return { status: "unchanged" };
    }
    if (options.dryRun && !options.preview) {
      return { status: "would-update", plans, previewed: false };
    }
    const bytes = Buffer.byteLength(JSON.stringify({ ops }));
    if (bytes > MAX_OPS_BYTES) {
      throw new SyncError(
        `ops が ${bytes} バイトあり、1 回の書き込みの上限 (${MAX_OPS_BYTES}) を超えます。スクリプトをページごとに分けてください`,
      );
    }

    const expected = applyOps(page.lines, ops);
    const preview = await client.previewEdit(target.project, page.id, ops);
    if ((preview.commitId ?? null) !== page.commitId) {
      await retry("読んだ後にページが更新されました");
      continue;
    }
    if (!sameLines(preview.lines, expected)) {
      throw new SyncError(
        `preview の結果が期待と違うので確定しません:\n${unifiedDiff(expected, preview.lines, { a: "期待", b: "preview" })}`,
      );
    }
    if (options.dryRun) {
      return { status: "would-update", plans, previewed: true };
    }

    let commitId: string;
    try {
      ({ commitId } = await client.submitEdit(target.project, preview.previewId));
    } catch (error) {
      const status = error instanceof CosenseError ? error.status : undefined;
      if (status === 409) {
        await retry("確定の前にページが更新されました (409 NotFastForward)");
        continue;
      }
      if (status !== undefined && status >= 400 && status < 500) {
        throw error;
      }
      // 5xx・通信の失敗: 書けたかどうか分からない。読み直して決める
      options.log(`確定の結果が分かりません (${(error as Error).message.split("\n")[0]})。読み直します`);
      const after = await client.readPage(target.project, target.page);
      const afterTexts = after.lines.map((line) => line.text);
      if (sameLines(afterTexts, expected)) {
        commitId = after.commitId ?? "";
      } else if (after.commitId === page.commitId) {
        await retry("確定されていませんでした");
        continue;
      } else {
        throw new SyncError(
          "確定の結果が分からず、ページも別の内容に変わっています。ページを確かめてください",
        );
      }
    }

    await verify(client, target, sources, expected);
    return { status: "updated", plans, commitId };
  }
}

/** 確定後の照合: ページ全体 (説明が残っているか) と、配信される /api/code の中身 */
async function verify(
  client: CosenseClient,
  target: { readonly project: string; readonly page: string },
  sources: readonly SourceFile[],
  expected: readonly string[],
): Promise<void> {
  const after = await client.readPage(target.project, target.page);
  const actual = after.lines.map((line) => line.text);
  if (!sameLines(actual, expected)) {
    throw new SyncError(
      `確定後のページが期待と違います:\n${unifiedDiff(expected, actual, { a: "期待", b: "ページ" })}`,
    );
  }
  for (const source of sources) {
    const blocks = findCodeBlocks(after.lines, source.file);
    const served = (await client.fetchCode(target.project, target.page, source.file)).replace(/\n$/, "");
    const code = fromBodyTexts(
      blocks[0].body.map((line) => line.text),
      blocks[0].indent,
    ).join("\n");
    if (served !== code) {
      throw new SyncError(`/api/code が配る code:${source.file} がページの本文と違います`);
    }
    if (code.split("\n").slice(1).join("\n") !== source.code.join("\n")) {
      throw new SyncError(`/api/code が配る code:${source.file} が手元のソースと違います`);
    }
  }
}
