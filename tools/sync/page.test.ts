import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  contentHash,
  encodeTitle,
  findCodeBlocks,
  formatProvenance,
  fromBodyTexts,
  type Line,
  parseBlobUrl,
  parseProvenance,
  sourceLines,
  toBodyTexts,
} from "./page.ts";

const lines = (...texts: string[]): Line[] => texts.map((text, i) => ({ id: `L${i}`, text }));

describe("findCodeBlocks", () => {
  it("見出しよりインデントの深い行が続く間をブロックとし、次の行の ID を返す", () => {
    const page = lines("title", "説明", "code:script.js", " a", "  b", " ", " c", "", "後ろの説明");
    const [block] = findCodeBlocks(page, "script.js");
    assert.equal(block.headerIndex, 2);
    assert.equal(block.indent, "");
    assert.deepEqual(
      block.body.map((line) => line.text),
      [" a", "  b", " ", " c"],
    );
    assert.equal(block.nextLineId, "L7");
  });

  it("ページの末尾まで続くブロックの次は _end", () => {
    const [block] = findCodeBlocks(lines("title", "code:script.js", " a"), "script.js");
    assert.equal(block.nextLineId, "_end");
  });

  it("インデントされた見出し (箇条書きの中) では、そのインデントより深い行だけが本文", () => {
    const page = lines("title", "\tcode:script.js", "\t a", "\t\tb", "\tつづきの箇条書き");
    const [block] = findCodeBlocks(page, "script.js");
    assert.equal(block.indent, "\t");
    assert.deepEqual(
      block.body.map((line) => line.text),
      ["\t a", "\t\tb"],
    );
    assert.equal(block.nextLineId, "L4");
  });

  it("本文の無いブロック (見出しだけ) も見つける", () => {
    const [block] = findCodeBlocks(lines("title", "code:script.js", "", "code:lib.js"), "script.js");
    assert.deepEqual(block.body, []);
    assert.equal(block.nextLineId, "L2");
  });

  it("名前が完全に一致するものだけを返し、同名は全部返す", () => {
    const page = lines("title", "code:script.json", " x", "code:script.js", " a", "code:script.js", " b");
    assert.equal(findCodeBlocks(page, "script.js").length, 2);
    assert.equal(findCodeBlocks(page, "lib.js").length, 0);
  });
});

describe("コードとブロック本文の変換", () => {
  it("空行・タブ・先頭の空白・日本語・特殊文字を往復で保つ", () => {
    const code = ["const a = 1;", "", "\tif (a) {", "  `${a}\\n` + '\"';", "全角　スペース", "}"];
    for (const indent of ["", " ", "\t", " \t"]) {
      const body = toBodyTexts(code, indent);
      assert.ok(
        body.every((text) => text.startsWith(`${indent} `)),
        "全行が 1 段深い",
      );
      assert.deepEqual(fromBodyTexts(body, indent), code);
    }
  });

  it("sourceLines は CRLF を LF にし、末尾の改行を 1 つだけ落とす", () => {
    assert.deepEqual(sourceLines("a\r\nb\r\n"), ["a", "b"]);
    assert.deepEqual(sourceLines("a\n\n"), ["a", ""]);
    assert.deepEqual(sourceLines("a"), ["a"]);
  });
});

describe("出どころの印", () => {
  it("書いて読むと同じものに戻る", () => {
    const p = {
      url: "https://github.com/o/r/blob/abc1234/userscripts/x/script.js",
      hash: "0123456789abcdef",
    };
    assert.deepEqual(parseProvenance(formatProvenance(p)), p);
  });

  it("印でない行は undefined", () => {
    assert.equal(parseProvenance("// synced from x sha256:short"), undefined);
    assert.equal(parseProvenance("const a = 1;"), undefined);
    assert.equal(parseProvenance(undefined), undefined);
  });

  it("ハッシュは内容で決まり、1 文字の違いで変わる", () => {
    assert.equal(contentHash(["a", "b"]), contentHash(["a", "b"]));
    assert.notEqual(contentHash(["a", "b"]), contentHash(["a", "b "]));
    assert.notEqual(contentHash(["a", "b"]), contentHash(["a\nb"].concat([""])));
  });

  it("blob URL からリビジョンとパスを取り出す (日本語のパスを含む)", () => {
    const url = `https://github.com/o/r/blob/0123abc/${encodeURI("userscripts/日本語/script.js")}`;
    assert.deepEqual(parseBlobUrl(url), { rev: "0123abc", path: "userscripts/日本語/script.js" });
    assert.equal(parseBlobUrl("https://example.com/x"), undefined);
  });
});

describe("encodeTitle", () => {
  it("空白を _ にしてから URL エンコードする", () => {
    assert.equal(encodeTitle("公開状態 バー"), encodeURIComponent("公開状態_バー"));
    assert.equal(encodeTitle("a/b?c"), "a%2Fb%3Fc");
  });
});
