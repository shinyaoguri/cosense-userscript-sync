// テスト用の偽の Cosense。ページを持ち、previewEdit / submitEdit を本物と同じ約束で振る舞う
// (ops を順に適用する・preview 後にページが変わっていたら 409・previewId は 1 回限り)。
// ops の適用は diff.ts の applyOps を使わずに書き直してある (テストが自分の実装をなぞらないように)。
import { type CosenseClient, CosenseError, type Page, type Preview } from "./cosense.ts";
import type { Op } from "./diff.ts";
import { findCodeBlocks, type Line } from "./page.ts";

type StoredPage = { id: string; title: string; commitId: string | null; lines: Line[] };

export class FakeCosense implements CosenseClient {
  readonly pages = new Map<string, StoredPage>();
  readonly previews = new Map<string, { project: string; key: string; base: string | null; lines: Line[] }>();
  commits = 0;
  previewCalls = 0;
  #nextId = 0;
  /** submit の前後に割り込む (通信の失敗や他人の編集を起こす) */
  onSubmit: ((phase: "before" | "after") => void) | undefined;
  /** preview の直前に割り込む (読んだ後の他人の編集を起こす) */
  onPreview: (() => void) | undefined;
  /** preview の結果を壊す (サーバーの想定外の振る舞い) */
  tamperPreview: ((lines: Line[]) => Line[]) | undefined;

  newId(): string {
    return (this.#nextId++).toString(16).padStart(24, "0");
  }

  put(project: string, title: string, texts: readonly string[], commitId: string | null = "c0"): StoredPage {
    const page = {
      id: this.newId(),
      title,
      commitId,
      lines: [title, ...texts].map((text) => ({ id: this.newId(), text })),
    };
    this.pages.set(`${project}/${title}`, page);
    return page;
  }

  texts(project: string, title: string): string[] {
    return this.#get(`${project}/${title}`).lines.map((line) => line.text);
  }

  /** 人がページを直接編集したことにする */
  edit(project: string, title: string, change: (lines: Line[]) => Line[]): void {
    const page = this.#get(`${project}/${title}`);
    page.lines = change(page.lines.map((line) => ({ ...line })));
    page.commitId = `c${++this.commits}`;
  }

  async readPage(project: string, title: string): Promise<Page> {
    const page = this.pages.get(`${project}/${title}`);
    if (page === undefined)
      return { id: "", commitId: null, persistent: false, lines: [{ id: "", text: title }] };
    return {
      id: page.id,
      commitId: page.commitId,
      persistent: true,
      lines: page.lines.map((line) => ({ ...line })),
    };
  }

  async previewEdit(project: string, pageId: string, ops: readonly Op[]): Promise<Preview> {
    this.previewCalls++;
    this.onPreview?.();
    const entry = [...this.pages.entries()].find(([, page]) => page.id === pageId);
    if (entry === undefined) throw new CosenseError("HTTP 404", 404);
    const [key, page] = entry;
    let lines = page.lines.map((line) => ({ ...line }));
    const at = (id: string) => {
      const index = lines.findIndex((line) => line.id === id);
      if (index < 0) throw new CosenseError(`HTTP 422 no line ${id}`, 422);
      return index;
    };
    for (const op of ops) {
      if ("insertBefore" in op) {
        const index = op.insertBefore === "_end" ? lines.length : at(op.insertBefore);
        const added = op.text.split(/\r?\n/).map((text) => ({ id: this.newId(), text }));
        lines.splice(index, 0, ...added);
      } else if ("replace" in op) {
        if (/\r?\n/.test(op.text)) throw new CosenseError("HTTP 422 multi-line replace", 422);
        lines[at(op.replace)] = { id: op.replace, text: op.text };
      } else {
        lines.splice(at(op.delete), 1);
      }
    }
    if (this.tamperPreview) lines = this.tamperPreview(lines);
    const previewId = this.newId();
    this.previews.set(previewId, { project, key, base: page.commitId, lines });
    return {
      previewId,
      commitId: page.commitId ?? undefined,
      lines: lines.map((line) => line.text),
    };
  }

  async previewNew(project: string, text: string): Promise<Preview> {
    const texts = text.split("\n");
    const previewId = this.newId();
    const key = `${project}/${texts[0]}`;
    this.previews.set(previewId, {
      project,
      key,
      base: null,
      lines: texts.map((t) => ({ id: this.newId(), text: t })),
    });
    return { previewId, commitId: undefined, lines: texts };
  }

  async submitEdit(project: string, previewId: string): Promise<{ commitId: string }> {
    this.onSubmit?.("before");
    const preview = this.previews.get(previewId);
    if (preview === undefined || preview.project !== project) throw new CosenseError("HTTP 404", 404);
    this.previews.delete(previewId);
    const page = this.pages.get(preview.key);
    if (page === undefined) {
      const [title] = preview.lines;
      this.pages.set(preview.key, {
        id: this.newId(),
        title: title.text,
        commitId: null,
        lines: preview.lines,
      });
    } else {
      if (page.commitId !== preview.base) throw new CosenseError('HTTP 409 {"error":"NotFastForward"}', 409);
      page.lines = preview.lines;
    }
    const commitId = `c${++this.commits}`;
    this.#get(preview.key).commitId = commitId;
    this.onSubmit?.("after");
    return { commitId };
  }

  async fetchCode(project: string, title: string, file: string): Promise<string> {
    const page = this.#get(`${project}/${title}`);
    // Cosense は同名のブロックを連結して配る
    return findCodeBlocks(page.lines, file)
      .map((block) => block.body.map((line) => line.text.slice(block.indent.length + 1)).join("\n"))
      .join("\n");
  }

  #get(key: string): StoredPage {
    const page = this.pages.get(key);
    if (page === undefined) throw new Error(`no page ${key}`);
    return page;
  }
}
