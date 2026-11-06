import assert from "node:assert/strict";
import { it } from "node:test";
import { HomeAssistantRestTransport, readHomeRegistry, type HomeRegistrySocket } from "../src/index.js";

class SocketFixture implements HomeRegistrySocket {
  readonly listeners = new Map<string, Set<Function>>();
  closed = 0;
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.closed++; }
  addEventListener(type: string, listener: Function) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener); this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: Function) { this.listeners.get(type)?.delete(listener); }
  message(data: unknown) {
    for (const listener of this.listeners.get("message") ?? []) listener({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}

it("closes and removes listeners when a registry connection stalls or returns invalid data", async () => {
  for (const failure of ["timeout", "auth_invalid", "malformed", "invalid_rows", "close", "error"]) {
    const socket = new SocketFixture();
    const request = readHomeRegistry("https://ha.test/prefix", "private-token", "xiaomi_home", {
      timeoutMs: 15,
      createWebSocket: (url) => { assert.equal(url, "wss://ha.test/prefix/api/websocket"); return socket; },
    });
    if (failure === "auth_invalid") socket.message({ type: failure, message: "private-upstream-error" });
    if (failure === "malformed") socket.message("not json");
    if (failure === "invalid_rows") {
      socket.message({ type: "auth_ok" });
      socket.message({ type: "result", id: 1, success: true, result: [null] });
    }
    if (["close", "error"].includes(failure)) for (const listener of socket.listeners.get(failure) ?? []) listener();
    await assert.rejects(request, /^Error: ha_registry_unavailable$/);
    assert.equal(socket.closed, 1, failure);
    assert.equal(socket.listenerCount, 0, failure);
  }
});

it("redacts socket construction errors and rejects credential-bearing endpoints before opening a socket", async () => {
  let calls = 0;
  const createWebSocket = () => { calls++; throw new Error("private-token-in-exception"); };
  for (const url of ["ftp://ha.test", "https://user:password@ha.test", "https://ha.test/?token=private", "not a url"]) {
    await assert.rejects(readHomeRegistry(url, "token", "xiaomi_home", { createWebSocket }), /^Error: ha_registry_unavailable$/);
  }
  assert.equal(calls, 0);
  await assert.rejects(readHomeRegistry("https://ha.test", "token", "xiaomi_home", { createWebSocket }), /^Error: ha_registry_unavailable$/);
  assert.equal(calls, 1);
});

it("aborts REST fetch and response-body stalls without relying on AbortSignal.timeout", async () => {
  for (const stalledBody of [false, true]) {
    let signal: AbortSignal | undefined;
    const stalled = (_url: unknown, init?: RequestInit) => {
      signal = init?.signal as AbortSignal;
      const wait = () => new Promise<never>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("private-token")), { once: true }));
      return stalledBody ? Promise.resolve({ ok: true, json: wait } as Response) : wait();
    };
    const transport = new HomeAssistantRestTransport({ url: "https://ha.test", token: "private-token", timeoutMs: 15, fetch: stalled as typeof fetch });
    await assert.rejects(transport.listStates(), /^Error: ha_connection_failed$/);
    assert.equal(signal?.aborted, true);
    assert.equal(transport.getStatus().healthy, false);
    assert.equal(transport.getStatus().lastVerifiedAt, null);
  }
});

it("clears the REST abort timer after a successful response", async () => {
  let signal: AbortSignal | undefined;
  const transport = new HomeAssistantRestTransport({ url: "https://ha.test", token: "token", timeoutMs: 15,
    fetch: (async (_url, init) => { signal = init?.signal as AbortSignal; return new Response("[]"); }) as typeof fetch });
  assert.deepEqual(await transport.listStates(), []);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(signal?.aborted, false);
  assert.equal(transport.isHealthy(), true);
});
