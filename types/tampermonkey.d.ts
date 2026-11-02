// 開発用ローダー (tools/dev/loader.user.js) が使う Tampermonkey の API のうち、使う分だけの型。
// 本番の UserScript からは参照しない。
declare global {
  function GM_xmlhttpRequest(details: {
    method: "GET";
    url: string;
    timeout?: number;
    onload?: (response: { status: number; responseText: string }) => void;
    onerror?: () => void;
    ontimeout?: () => void;
  }): void;
  function GM_getValue(key: string): unknown;
  function GM_setValue(key: string, value: unknown): void;
  const unsafeWindow: Window & typeof globalThis;
}

export {};
