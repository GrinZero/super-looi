/** Test-only Fetch headers/response objects. NSH provides these natively; the
 * standalone VM uses this fixture solely to feed real SDK SSE parsers. */
export class FixtureHeaders {
  private values = new Map<string, string>();
  constructor(init?: any) {
    if (init?.[Symbol.iterator])
      for (const [key, value] of init) this.set(key, value);
    else
      for (const [key, value] of Object.entries(init ?? {}))
        this.set(key, String(value));
  }
  set(key: string, value: string) {
    this.values.set(key.toLowerCase(), String(value));
  }
  get(key: string) {
    return this.values.get(key.toLowerCase()) ?? null;
  }
  has(key: string) {
    return this.values.has(key.toLowerCase());
  }
  delete(key: string) {
    this.values.delete(key.toLowerCase());
  }
  append(key: string, value: string) {
    this.set(key, this.has(key) ? `${this.get(key)}, ${value}` : value);
  }
  entries() {
    return this.values.entries();
  }
  keys() {
    return this.values.keys();
  }
  forEach(fn: (value: string, key: string) => void) {
    this.values.forEach(fn);
  }
  [Symbol.iterator]() {
    return this.entries();
  }
}
export class FixtureResponse {
  status: number;
  statusText: string;
  headers: FixtureHeaders;
  body: ReadableStream<Uint8Array> | null;
  url = "";
  constructor(
    body: ReadableStream<Uint8Array> | string | null = null,
    init: any = {},
  ) {
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? "OK";
    this.headers = new FixtureHeaders(init.headers);
    this.body =
      typeof body === "string"
        ? new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            },
          })
        : body;
  }
  get ok() {
    return this.status >= 200 && this.status < 300;
  }
  async text() {
    if (!this.body) return "";
    const reader = this.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }
  async json() {
    return JSON.parse(await this.text());
  }
}
export function installFixtureHttp() {
  (globalThis as any).Headers ??= FixtureHeaders;
  (globalThis as any).Response ??= FixtureResponse;
  (globalThis as any).FormData ??= class FormData {};
  (globalThis as any).Request ??= class Request {};
}
export function sseResponse(events: unknown[], onPull?: () => void): Response {
  const bytes = new TextEncoder().encode(
    events
      .map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`)
      .join(""),
  );
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();
      if (offset >= bytes.length) controller.close();
      else {
        const n = Math.min(bytes.length, offset + 7);
        controller.enqueue(bytes.slice(offset, n));
        offset = n;
      }
    },
  });
  return {
    status: 200,
    ok: true,
    statusText: "OK",
    headers: new FixtureHeaders({ "content-type": "text/event-stream" }),
    body,
  } as unknown as Response;
}
