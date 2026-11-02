// Cosense のページ本文 (行の配列) とコードブロックの対応を扱う。通信はしない。
//
// コードブロックの約束 (Cosense の記法):
// - 見出し行は `<インデント>code:<ファイル名>`
// - 本文は、見出しよりインデントが深い行が続く間。インデントの浅い行 (空行を含む) で終わる
// - 本文の各行は「見出しのインデント + 1 文字」を取り除いたものがコードになる。
//   コード中の空行は、インデントだけの行として書かれる
import { createHash } from "node:crypto";

export type Line = { readonly id: string; readonly text: string };

export type CodeBlock = {
  /** 見出し行の位置 (ページ先頭から 0 始まり) */
  readonly headerIndex: number;
  /** 見出しのインデント (空白・タブの並び) */
  readonly indent: string;
  /** 本文の行。見出しの次の行から、ブロックの終わりまで */
  readonly body: readonly Line[];
  /** ブロックの次の行の ID。ブロックがページの末尾まで続くなら `_end` */
  readonly nextLineId: string;
};

const HEADER = /^([ \t]*)code:(.+)$/;

function indentLength(text: string): number {
  return /^[ \t]*/.exec(text)?.[0].length ?? 0;
}

/** `code:<file>` のブロックをすべて返す。同名が複数あれば複数返す (呼び出し側で止める) */
export function findCodeBlocks(lines: readonly Line[], file: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = HEADER.exec(lines[i].text);
    if (match === null || match[2] !== file) continue;
    const indent = match[1];
    let end = i + 1;
    while (end < lines.length && indentLength(lines[end].text) > indent.length) {
      end++;
    }
    blocks.push({
      headerIndex: i,
      indent,
      body: lines.slice(i + 1, end),
      nextLineId: end < lines.length ? lines[end].id : "_end",
    });
  }
  return blocks;
}

/** 配布するコードを LF にそろえ、末尾の改行を 1 つ落とした行の配列にする */
export function sourceLines(source: string): string[] {
  const normalized = source.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return normalized.split("\n");
}

/** コードの行をブロック本文の行にする。空行もインデントだけの行になり、ブロックが途切れない */
export function toBodyTexts(code: readonly string[], indent: string): string[] {
  return code.map((line) => `${indent} ${line}`);
}

/** ブロック本文の行からコードの行を取り出す (`toBodyTexts` の逆) */
export function fromBodyTexts(body: readonly string[], indent: string): string[] {
  return body.map((text) => text.slice(indent.length + 1));
}

/** 本文の sha256 (先頭 16 桁)。出どころの印と、手編集の検出に使う */
export function contentHash(code: readonly string[]): string {
  return createHash("sha256").update(code.join("\n")).digest("hex").slice(0, 16);
}

/**
 * 出どころの印。配布コードの 1 行目に置く JS のコメントで、Cosense の読み手が GitHub の同じ版へ辿れる。
 * sha256 は印を除いた本文から取るので、ページ上で本文が手で変えられたら一致しなくなる
 */
export type Provenance = { readonly url: string; readonly hash: string };

const PROVENANCE = /^\/\/ synced from (\S+) sha256:([0-9a-f]{16})(?: .*)?$/;

export function formatProvenance(p: Provenance): string {
  return `// synced from ${p.url} sha256:${p.hash} (編集は GitHub で。ここを直すと次の同期が止まります)`;
}

export function parseProvenance(line: string | undefined): Provenance | undefined {
  const match = line === undefined ? null : PROVENANCE.exec(line);
  return match === null ? undefined : { url: match[1], hash: match[2] };
}

/** GitHub の blob URL からリビジョンとパスを取り出す (前回配置した版との diff に使う) */
export function parseBlobUrl(url: string): { rev: string; path: string } | undefined {
  const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/([0-9a-f]{7,40})\/(.+)$/.exec(url);
  return match === null ? undefined : { rev: match[1], path: decodeURI(match[2]) };
}

/** ページ名を URL の 1 区切りにする。Cosense は空白を `_` で表す */
export function encodeTitle(title: string): string {
  return encodeURIComponent(title.replaceAll(" ", "_"));
}
