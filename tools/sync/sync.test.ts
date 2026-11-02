import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { CosenseError, parsePreview } from "./cosense.ts";
import { FakeCosense } from "./fake-cosense.ts";
import { contentHash, formatProvenance, parseProvenance, sourceLines } from "./page.ts";
import { type SourceFile, SyncError, type SyncOptions, syncPage } from "./sync.ts";

const PROJECT = "test-project";
const TITLE = "公開状態を表示する バー";
const target = { project: PROJECT, page: TITLE };
const URL1 = "https://github.com/o/r/blob/1111111/userscripts/x/script.js";
const URL2 = "https://github.com/o/r/blob/2222222/userscripts/x/script.js";

const source = (code: string, url = URL1, file = "script.js"): SourceFile => ({
  file,
  code: sourceLines(code),
  url,
});

/** 説明・別のブロック・後ろのコメントを持つページ。同期で変わってはいけない部分 */
const DESCRIPTION = [
  "目的: 公開状態を表示する",
  "[* 使い方]",
  "code:例.js",
  ' import "/api/code/x/y/script.js";',
  "",
];
const TRAILER = ["", "[* 議論]", " [shinyaoguri.icon] ここはコメント"];

let cosense: FakeCosense;
let logs: string[];
let sleeps: number[];
const options = (overrides: Partial<SyncOptions> = {}): SyncOptions => ({
  dryRun: false,
  preview: false,
  force: false,
  previousSource: async (url) => (url === URL1 ? sourceLines(CODE1) : undefined),
  log: (message) => logs.push(message),
  sleep: async (ms) => {
    sleeps.push(ms);
  },
  ...overrides,
});

const CODE1 = 'const a = "日本語";\n\n\tif (a) {\n  console.log(`${a}\\t`);\n\t}\n';
const CODE2 = 'const a = "日本語";\n\n\tif (a) {\n  console.log(`${a}!`);\n\t}\n// 追記\n';

function codeIn(texts: readonly string[], header = "code:script.js"): string[] {
  const start = texts.indexOf(header);
  const end = texts.indexOf("", start);
  return texts.slice(start + 1, end < 0 ? undefined : end).map((text) => text.slice(1));
}

beforeEach(() => {
  cosense = new FakeCosense();
  logs = [];
  sleeps = [];
});

describe("初回の配置", () => {
  beforeEach(() => {
    cosense.put(PROJECT, TITLE, [...DESCRIPTION, "code:script.js", ...TRAILER]);
  });

  it("空のブロックにコードと出どころの印を入れ、説明と他のブロックはそのまま", async () => {
    const result = await syncPage(cosense, target, [source(CODE1)], options());
    assert.equal(result.status, "updated");
    const texts = cosense.texts(PROJECT, TITLE);
    const code = codeIn(texts);
    assert.deepEqual(parseProvenance(code[0]), { url: URL1, hash: contentHash(sourceLines(CODE1)) });
    assert.deepEqual(code.slice(1), sourceLines(CODE1));
    assert.deepEqual(texts.slice(0, 1 + DESCRIPTION.length), [TITLE, ...DESCRIPTION]);
    assert.deepEqual(texts.slice(-TRAILER.length), TRAILER);
    assert.equal(cosense.commits, 1);
  });

  it("配信される /api/code の中身が、印 + ソースそのもの", async () => {
    await syncPage(cosense, target, [source(CODE1)], options());
    const served = await cosense.fetchCode(PROJECT, TITLE, "script.js");
    assert.equal(served.split("\n").slice(1).join("\n"), CODE1.replace(/\n$/, ""));
  });
});

describe("2 回目以降", () => {
  beforeEach(async () => {
    cosense.put(PROJECT, TITLE, [...DESCRIPTION, "code:script.js", ...TRAILER]);
    await syncPage(cosense, target, [source(CODE1)], options());
  });

  it("同じ内容なら書き込まない (リビジョンが違っても)", async () => {
    const result = await syncPage(cosense, target, [source(CODE1, URL2)], options());
    assert.equal(result.status, "unchanged");
    assert.equal(cosense.commits, 1);
    assert.equal(cosense.previewCalls, 1);
  });

  it("変わった行と印だけを書き換え、残りの行 ID と説明を保つ", async () => {
    const before = (await cosense.readPage(PROJECT, TITLE)).lines;
    const result = await syncPage(cosense, target, [source(CODE2, URL2)], options());
    assert.equal(result.status, "updated");
    const after = (await cosense.readPage(PROJECT, TITLE)).lines;
    const keptIds = before.filter((line) => after.some((a) => a.id === line.id && a.text === line.text));
    // 変わったのは印・console.log の行・追記の 3 行だけ
    assert.equal(before.length - keptIds.length, 2);
    assert.deepEqual(codeIn(after.map((line) => line.text)).slice(1), sourceLines(CODE2));
    assert.deepEqual(
      after.slice(0, 1 + DESCRIPTION.length).map((line) => line.text),
      [TITLE, ...DESCRIPTION],
    );
  });

  it("ページ上で手で直されていたら、上書きせず競合として差分を返す", async () => {
    cosense.edit(PROJECT, TITLE, (lines) =>
      lines.map((line) =>
        line.text === "   console.log(`${a}\\t`);" ? { ...line, text: "   alert(a);" } : line,
      ),
    );
    const commits = cosense.commits;
    const result = await syncPage(cosense, target, [source(CODE2, URL2)], options());
    assert.equal(result.status, "conflict");
    assert.equal(cosense.commits, commits, "書き込んでいない");
    if (result.status !== "conflict") return;
    const [plan] = result.plans;
    assert.equal(plan.kind, "conflict");
    if (plan.kind !== "conflict") return;
    assert.match(plan.reason, /手で変えられています/);
    assert.match(plan.editedDiff ?? "", /^- {2}console\.log\(`\$\{a\}\\t`\);$/m);
    assert.match(plan.editedDiff ?? "", /^\+ {2}alert\(a\);$/m);
  });

  it("--force なら競合していても上書きする", async () => {
    cosense.edit(PROJECT, TITLE, (lines) =>
      lines.map((line) => (line.text === " " ? { ...line, text: " //" } : line)),
    );
    const result = await syncPage(cosense, target, [source(CODE2, URL2)], options({ force: true }));
    assert.equal(result.status, "updated");
    assert.deepEqual(codeIn(cosense.texts(PROJECT, TITLE)).slice(1), sourceLines(CODE2));
  });

  it("印の行が消されていたら、管理外のコードとして競合にする", async () => {
    cosense.edit(PROJECT, TITLE, (lines) => lines.filter((line) => !line.text.startsWith(" // synced from")));
    const result = await syncPage(cosense, target, [source(CODE1)], options());
    assert.equal(result.status, "conflict");
  });
});

describe("ブロックの特定", () => {
  it("ブロックが無ければ止める", async () => {
    cosense.put(PROJECT, TITLE, DESCRIPTION);
    await assert.rejects(syncPage(cosense, target, [source(CODE1)], options()), SyncError);
  });

  it("同名のブロックが 2 つあれば、--force でも止める", async () => {
    cosense.put(PROJECT, TITLE, ["code:script.js", " a", "", "code:script.js", " b"]);
    await assert.rejects(
      syncPage(cosense, target, [source(CODE1)], options({ force: true })),
      /2 個あります/,
    );
    assert.equal(cosense.commits, 0);
  });

  it("ページが無ければ止める (init を案内する)", async () => {
    await assert.rejects(syncPage(cosense, target, [source(CODE1)], options()), /init/);
  });

  it("箇条書きの中にインデントされたブロックでも、インデントを保って書く", async () => {
    cosense.put(PROJECT, TITLE, ["[* 実装]", "\tcode:script.js", "\t後ろの箇条書き"]);
    await syncPage(cosense, target, [source(CODE1)], options());
    const texts = cosense.texts(PROJECT, TITLE);
    assert.ok(texts.slice(3, 3 + sourceLines(CODE1).length).every((text) => text.startsWith("\t ")));
    assert.equal(texts.at(-1), "\t後ろの箇条書き");
    const served = await cosense.fetchCode(PROJECT, TITLE, "script.js");
    assert.equal(served.split("\n").slice(1).join("\n"), CODE1.replace(/\n$/, ""));
  });

  it("複数のファイルを 1 回の書き込みでそれぞれのブロックへ入れる", async () => {
    cosense.put(PROJECT, TITLE, ["code:script.js", "", "code:lib.js", "", "説明"]);
    await syncPage(
      cosense,
      target,
      [source(CODE1), source("export const x = 1;\n", URL1, "lib.js")],
      options(),
    );
    assert.equal(cosense.commits, 1);
    const texts = cosense.texts(PROJECT, TITLE);
    assert.deepEqual(codeIn(texts, "code:lib.js").slice(1), ["export const x = 1;"]);
    assert.equal(texts.at(-1), "説明");
  });
});

describe("dry-run と preview", () => {
  beforeEach(() => {
    cosense.put(PROJECT, TITLE, ["code:script.js"]);
  });

  it("dry-run は preview もせず、何も書かない", async () => {
    const result = await syncPage(cosense, target, [source(CODE1)], options({ dryRun: true }));
    assert.equal(result.status, "would-update");
    assert.equal(cosense.previewCalls, 0);
    assert.equal(cosense.commits, 0);
  });

  it("--preview はサーバーの preview まで行い、確定しない", async () => {
    const result = await syncPage(cosense, target, [source(CODE1)], options({ dryRun: true, preview: true }));
    assert.deepEqual(result.status === "would-update" && result.previewed, true);
    assert.equal(cosense.previewCalls, 1);
    assert.equal(cosense.commits, 0);
  });

  it("preview の結果が期待と違えば確定しない", async () => {
    cosense.tamperPreview = (lines) => lines.slice(0, -1);
    await assert.rejects(syncPage(cosense, target, [source(CODE1)], options()), /preview の結果が期待と違う/);
    assert.equal(cosense.commits, 0);
  });
});

describe("通信の失敗と同時編集", () => {
  beforeEach(() => {
    cosense.put(PROJECT, TITLE, [...DESCRIPTION, "code:script.js"]);
  });

  it("確定は届いたが応答が失われたら、読み直して成功とする (二重に書かない)", async () => {
    let failed = false;
    cosense.onSubmit = (phase) => {
      if (phase === "after" && !failed) {
        failed = true;
        throw new CosenseError("fetch failed", undefined);
      }
    };
    const result = await syncPage(cosense, target, [source(CODE1)], options());
    assert.equal(result.status, "updated");
    assert.equal(cosense.commits, 1);
    assert.deepEqual(sleeps, []);
  });

  it("確定が届かなかったら (5xx)、待って preview からやり直す", async () => {
    let failed = false;
    cosense.onSubmit = (phase) => {
      if (phase === "before" && !failed) {
        failed = true;
        throw new CosenseError("HTTP 503 Service Unavailable", 503);
      }
    };
    const result = await syncPage(cosense, target, [source(CODE1)], options());
    assert.equal(result.status, "updated");
    assert.equal(cosense.commits, 1);
    assert.deepEqual(sleeps, [2_000]);
  });

  it("preview と確定の間に他人が編集したら (409)、読み直して競合を判定し直す", async () => {
    let edited = false;
    cosense.onSubmit = (phase) => {
      if (phase === "before" && !edited) {
        edited = true;
        cosense.edit(PROJECT, TITLE, (lines) => [
          ...lines.slice(0, 2),
          { id: "x", text: "他人の追記" },
          ...lines.slice(2),
        ]);
      }
    };
    const result = await syncPage(cosense, target, [source(CODE1)], options());
    assert.equal(result.status, "updated");
    assert.ok(cosense.texts(PROJECT, TITLE).includes("他人の追記"), "他人の編集が残る");
    assert.equal(sleeps.length, 1);
  });

  it("読んだ後、preview の前に他人が編集したら、読み直して ops を作り直す", async () => {
    let edited = false;
    cosense.onPreview = () => {
      if (!edited) {
        edited = true;
        cosense.edit(PROJECT, TITLE, (lines) => [...lines, { id: "y", text: "後ろへの他人の追記" }]);
      }
    };
    const result = await syncPage(cosense, target, [source(CODE1)], options());
    assert.equal(result.status, "updated");
    assert.equal(cosense.texts(PROJECT, TITLE).at(-1), "後ろへの他人の追記");
    assert.deepEqual(sleeps, [2_000]);
  });

  it("確定できない状態が続いたら諦める", async () => {
    cosense.onSubmit = (phase) => {
      if (phase === "before") throw new CosenseError("HTTP 502", 502);
    };
    await assert.rejects(syncPage(cosense, target, [source(CODE1)], options()), /4 回試して諦めました/);
    assert.equal(cosense.commits, 0);
  });

  it("4xx (権限など) はやり直さずに止める", async () => {
    cosense.onSubmit = () => {
      throw new CosenseError("HTTP 403 Forbidden", 403);
    };
    await assert.rejects(syncPage(cosense, target, [source(CODE1)], options()), /403/);
    assert.deepEqual(sleeps, []);
  });
});

describe("parsePreview", () => {
  it("CLI の出力から、変わらない行・足した行・変えた行のテキストを取り出す", () => {
    const output = [
      "previewId: 6ae8d8fc7e5c3e4f6175ed35",
      "expireAt:  2026-11-02T18:44:56.442Z",
      "status:    update",
      "project:   p",
      "title:     t",
      "commitId:  6ae8d8fc7e5c3e4f6175ed99",
      "",
      "ops:",
      "  insertBefore 5c074a00efa18e000001ef0a: 2 line(s)",
      "",
      "page (after apply):",
      "  t",
      ">  x # be4077fafa7a8e63999a87cf",
      "> \ty # b2dcdde5d41809f0189c3e9f",
      "  ",
      '* rep "q" # 5c074a00efa18e000001ef0b',
      "   x # 0123 は ID ではない",
      "",
      "internal links in changed lines:",
      "  (none)",
    ].join("\n");
    assert.deepEqual(parsePreview(output), {
      previewId: "6ae8d8fc7e5c3e4f6175ed35",
      commitId: "6ae8d8fc7e5c3e4f6175ed99",
      lines: ["t", " x", "\ty", "", 'rep "q"', " x # 0123 は ID ではない"],
    });
  });

  it("形が読めなければ例外", () => {
    assert.throws(() => parsePreview("HTTP 500"));
  });
});

describe("formatProvenance", () => {
  it("印は 1 行で、JavaScript のコメント", () => {
    const line = formatProvenance({ url: URL1, hash: "0123456789abcdef" });
    assert.ok(line.startsWith("// ") && !line.includes("\n"));
  });
});
