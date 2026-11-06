import assert from "node:assert/strict";
import { it } from "node:test";
import { LocalControlCenter } from "../src/runtime/local-control-center.js";
import { LocalPersonalMemoryStore, type LocalStorage } from "../src/runtime/local-memory.js";
import { LocalVoiceSocket } from "../src/runtime/local-voice-socket.js";
import { LiveVoiceClient, type WebSocketAdapter } from "../src/runtime/live-voice-client.js";

class Storage implements LocalStorage {
  values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}
const uuid = () => "12345678-1234-4234-9234-123456789abc";
function center(fetch?: typeof globalThis.fetch, registry?: ConstructorParameters<typeof LocalControlCenter>[0]["registry"]) {
  const storage = new Storage(); const credentials = new Storage();
  const runtime = new LocalControlCenter({ storage, credentials, hubOrigin: "http://unavailable-hub.test", fetch, registry,
    crypto: { randomUUID: uuid, sha1: async () => "a".repeat(40) } });
  return { runtime, storage, credentials };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const defer = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

it("runs home control, remember, recall and forget with no Hub calls in local simulation mode", async () => {
  let calls = 0;
  const { runtime, storage } = center((async () => { calls++; throw new Error("Hub is off"); }) as typeof fetch);
  await runtime.configure({ mode: "simulation", voiceMode: "local" }, { voiceKey: "test-key" });
  const connection = await runtime.getConnection();
  assert.equal(connection.label, "离线演示"); assert.equal(connection.entities.length, 5);
  const result = await runtime.executeTool("control_home_device", { entity_id: "light.study_ceiling", service: "turn_on" }, runtime.memories.captureGeneration(), runtime.revision) as { receipt: { status: string }; instruction: string };
  assert.equal(result.receipt.status, "verified"); assert.match(result.instruction, /演示/);
  await runtime.executeTool("remember_fact", { fact: "备用钥匙在玄关抽屉", subject: "备用钥匙", location: "玄关抽屉" }, runtime.memories.captureGeneration(), runtime.revision);
  assert.equal(runtime.memories.list("钥匙").length, 1);
  const restored = new LocalPersonalMemoryStore(storage, uuid); await restored.initialize();
  assert.equal(restored.list("钥匙")[0].location, "玄关抽屉");
  await runtime.executeTool("forget_memory", { query: "备用钥匙" }, runtime.memories.captureGeneration(), runtime.revision);
  await runtime.executeTool("remember_fact", { fact: "备用钥匙在背包" }, runtime.memories.captureGeneration(), runtime.revision);
  assert.equal(runtime.memories.list()[0].location, "背包"); assert.equal(calls, 0);
});

it("rejects late writes after deletion and rolls back a write interrupted by privacy/session cancellation", async () => {
  const storage = new Storage(); let ids = 0;
  const memory = new LocalPersonalMemoryStore(storage, () => String(++ids)); await memory.initialize();
  const item = await memory.remember({ fact: "钥匙在抽屉" });
  const old = memory.captureGeneration(); await memory.forget(item.id);
  await assert.rejects(memory.remember({ fact: "钥匙在旧抽屉" }, old), /撤销/);
  const started = defer<void>(); const write = defer<void>();
  const original = storage.set.bind(storage); let blocking = true;
  storage.set = async (key, value) => { if (blocking) { blocking = false; started.resolve(); await write.promise; } await original(key, value); };
  const pending = memory.remember({ fact: "不应迟到的记忆" });
  await started.promise; memory.invalidateCaptures(); write.resolve();
  await assert.rejects(pending, /撤销/);
  assert.equal(memory.list().length, 0);
  const restored = new LocalPersonalMemoryStore(storage, uuid); await restored.initialize(); assert.equal(restored.list().length, 0);
});

it("keeps failed memory writes out of the visible ledger", async () => {
  const storage = new Storage(); storage.set = async () => { throw new Error("disk full"); };
  const memory = new LocalPersonalMemoryStore(storage, uuid); await memory.initialize();
  await assert.rejects(memory.remember({ fact: "应未保存" }), /disk full/); assert.equal(memory.list().length, 0);
});

it("fences old Hub reads and execution results when switching to local mode", async () => {
  for (const execute of [false, true]) {
    const response = defer<Response>(); const started = defer<void>();
    const { runtime } = center((async () => { started.resolve(); return response.promise; }) as typeof fetch);
    await runtime.initialize();
    const request = execute ? runtime.execute({ entity_id: "light.old", domain: "light", service: "turn_on", service_data: {} }) : runtime.getConnection();
    await started.promise;
    await runtime.configure({ mode: "simulation" });
    response.resolve(new Response(JSON.stringify(execute ? { receipt: { status: "verified" } } : { configured: true, healthy: true, entities: [], readOnlyEntities: [] })));
    await assert.rejects(request, /切换/);
    assert.equal((await runtime.getConnection()).label, "离线演示");
  }
});

it("does not use demonstration data when real configuration fails and scopes HA credentials to the chosen URL", async () => {
  let calls = 0;
  const { runtime, credentials } = center((async () => { calls++; throw new Error("offline"); }) as typeof fetch);
  await runtime.configure({ mode: "external_ha", haUrl: "http://one.test" }, { haToken: "secret-one" });
  assert.equal(credentials.values.get("external-ha-token:http://one.test"), "secret-one");
  await runtime.configure({ haUrl: "http://two.test" });
  assert.equal(calls, 1, "the first token must not be sent to another URL");
  const failed = await runtime.getConnection(); assert.equal(failed.healthy, false); assert.deepEqual(failed.entities, []);
  await runtime.configure({ mode: "direct_miot" });
  assert.deepEqual((await runtime.getConnection()).entities, []);
});

class Upstream implements WebSocketAdapter {
  readyState = 1; sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null; onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null; onclose: (() => void) | null = null;
  constructor() { queueMicrotask(() => this.onopen?.()); }
  send(raw: string) { const value = JSON.parse(raw); this.sent.push(value); if (value.type === "session.create") queueMicrotask(() => this.emit({ type: "session.created" })); }
  emit(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

it("bridges direct duplex tools, PCM pacing, deletion followed by a new remember and duplicate-call suppression without Hub", async () => {
  const { runtime } = center((async () => { throw new Error("Hub off"); }) as typeof fetch);
  await runtime.configure({ mode: "simulation", voiceMode: "local" }, { voiceKey: "secret-key" });
  let socket!: Upstream;
  const live = new LiveVoiceClient({ hubOrigin: "http://unused.test", enableNativeMic: false, enableNativePlayback: false,
    wsFactory: () => new LocalVoiceSocket(runtime, (url, key) => { assert.ok(url.startsWith("wss://openspeech.bytedance.com/")); assert.equal(key, "secret-key"); socket = new Upstream(); return socket; }) });
  await live.start();
  const call = (id: string, name: string, args: unknown) => socket.emit({ type: "response.function_call_arguments.done", call_id: id, name, arguments: JSON.stringify(args) });
  call("1", "remember_fact", { fact: "钥匙在玄关" }); await turn();
  assert.equal(runtime.memories.list().length, 1);
  call("2", "forget_memory", { query: "钥匙" }); await turn();
  assert.equal(runtime.memories.list().length, 0);
  assert.equal(live.isActive(), false);
  await live.start(); live.sendTextPrompt("重新记住钥匙在背包");
  call("3", "remember_fact", { fact: "钥匙在背包" }); await turn();
  assert.equal(runtime.memories.list()[0].location, "背包");
  call("3", "remember_fact", { fact: "钥匙在旧位置" }); await turn();
  assert.equal(runtime.memories.list()[0].location, "背包");
  live.pushFloat32MicSamples(new Float32Array(320).fill(0.2)); await new Promise((resolve) => setTimeout(resolve, 25));
  const audio = socket.sent.find((frame) => frame.type === "input_audio_buffer.append"); assert.ok(audio);
  assert.equal(Buffer.from(String(audio.audio), "base64").length, 640);
  live.bargeIn(); assert.ok(socket.sent.some((frame) => frame.type === "response.cancel"));
  await live.stop(); const count = socket.sent.length; await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(socket.sent.length, count);
});

it("suppresses queued tools and sockets after session cancellation", async () => {
  const { runtime } = center(); await runtime.configure({ mode: "simulation", voiceMode: "local" }, { voiceKey: "key" });
  let socket!: Upstream;
  const bridge = new LocalVoiceSocket(runtime, () => { socket = new Upstream(); return socket; });
  await turn();
  socket.emit({ type: "response.function_call_arguments.done", call_id: "late", name: "remember_fact", arguments: JSON.stringify({ fact: "不应保留" }) });
  bridge.close(); await turn(); assert.equal(runtime.memories.list().length, 0);
  let created = 0;
  const closed = new LocalVoiceSocket(runtime, () => { created++; return new Upstream(); }); closed.close(); await turn(); assert.equal(created, 0);
});

it("updates a note by ID and never recreates a deleted record through a concurrent correction", async () => {
  const storage = new Storage(); let ids = 0;
  const memory = new LocalPersonalMemoryStore(storage, () => String(++ids)); await memory.initialize();
  const note = await memory.remember({ fact: "备用电池" });
  await memory.correct(note.id, "抽屉"); assert.equal(memory.list().length, 1); assert.equal(memory.list()[0].id, note.id);
  const deletion = memory.forget(note.id); const correction = memory.correct(note.id, "旧位置");
  await deletion; await assert.rejects(correction, /有效/); assert.equal(memory.list().length, 0);
});

it("revokes pending OAuth exchanges during a mode switch", async () => {
  const response = defer<Response>(); const started = defer<void>();
  const { runtime, credentials } = center((async () => { started.resolve(); return response.promise; }) as typeof fetch);
  const session = await runtime.beginMiotLogin("cn");
  assert.equal(runtime.interceptMiotCallback(`${session.redirectUri}?state=${session.state}&code=old-code`).intercepted, true);
  const finish = runtime.finishMiotLogin("old-code"); await started.promise;
  await runtime.configure({ mode: "simulation" });
  response.resolve(new Response(JSON.stringify({ code: 0, result: { access_token: "late", refresh_token: "late-r", expires_in: 100 } })));
  await assert.rejects(finish, /miot_session_changed|切换/);
  assert.equal(credentials.values.size, 0); assert.equal(runtime.preferences.mode, "simulation");
});

it("does not dispatch a real control after its pre-read completes in a different mode", async () => {
  const reading = defer<Response>(); const started = defer<void>(); let writes = 0;
  const now = new Date().toISOString();
  const state = { entity_id: "light.real", state: "off", attributes: { friendly_name: "阅读灯" }, last_updated: now, last_changed: now };
  const { runtime } = center((async (input, init) => {
    if (String(input).endsWith("/api/states")) return new Response(JSON.stringify([state]));
    if (init?.method === "POST") { writes++; return new Response("[]"); }
    started.resolve(); return reading.promise;
  }) as typeof fetch, async () => new Map([["light.real", { device_id: "lamp", device_name: "灯" }]]));
  await runtime.configure({ mode: "external_ha", haUrl: "http://ha.test" }, { haToken: "token" });
  await runtime.getConnection();
  const request = runtime.execute({ entity_id: "light.real", domain: "light", service: "turn_on", service_data: {} });
  await started.promise; await runtime.configure({ mode: "simulation" });
  reading.resolve(new Response(JSON.stringify(state))); await assert.rejects(request, /切换/); assert.equal(writes, 0);
});

it("allows a mode change while the previous startup discovery is still waiting", async () => {
  const waiting = defer<Response>(); const started = defer<void>();
  const { runtime } = center((async () => { started.resolve(); return waiting.promise; }) as typeof fetch);
  await runtime.configure({ mode: "external_ha", haUrl: "http://slow.test" }, { haToken: "token" });
  await started.promise;
  await runtime.configure({ mode: "simulation" });
  assert.equal((await runtime.getConnection()).label, "离线演示");
  waiting.resolve(new Response("[]")); await turn();
  assert.equal((await runtime.getConnection()).label, "离线演示");
});

it("handles useful typed memory and explicit control completely offline without a voice key", async () => {
  let calls = 0;
  const { runtime } = center((async () => { calls++; throw new Error("network off"); }) as typeof fetch);
  await runtime.configure({ mode: "simulation", voiceMode: "local" });
  assert.match(await runtime.executeText("记住钥匙在抽屉"), /已保存/);
  assert.match(await runtime.executeText("钥匙在哪"), /钥匙在抽屉/);
  assert.match(await runtime.executeText("打开书房"), /多个匹配/);
  assert.match(await runtime.executeText("打开书房吸顶灯"), /离线演示.*回读确认/);
  assert.match(await runtime.executeText("忘记钥匙"), /删除 1 条/);
  assert.equal(runtime.memories.list().length, 0); assert.equal(calls, 0);
});

it("keeps generic power entities on hazardous or unregistered devices read-only", async () => {
  const now = new Date().toISOString();
  const snapshots = ["switch.danger", "light.danger", "switch.unknown", "switch.missing_device", "light.missing_device", "switch.safe"].map((entity_id) => ({ entity_id, state: "off", attributes: { friendly_name: "电源" }, last_updated: now, last_changed: now }));
  const { runtime } = center((async () => new Response(JSON.stringify(snapshots))) as typeof fetch, async () => new Map([
    ["switch.danger", { power_control: true, control_restricted: true }], ["light.danger", { control_restricted: true }], ["switch.missing_device", { power_control: true }], ["light.missing_device", {}], ["switch.safe", { power_control: true, device_id: "safe", device_name: "普通插座" }],
  ]));
  await runtime.configure({ mode: "external_ha", haUrl: "http://ha.test" }, { haToken: "token" });
  const entities = (await runtime.getConnection()).entities;
  for (const id of ["switch.danger", "light.danger", "switch.unknown", "switch.missing_device", "light.missing_device"]) assert.deepEqual(entities.find((entity) => entity.entity_id === id)?.supported_features, ["read"]);
  assert.deepEqual(entities.find((entity) => entity.entity_id === "switch.safe")?.supported_features, ["turn_on", "turn_off"]);
});

it("ends the old model session on deletion so late tools cannot acquire a new memory generation", async () => {
  const { runtime } = center(); await runtime.configure({ mode: "simulation", voiceMode: "local" }, { voiceKey: "key" });
  const memory = await runtime.memories.remember({ fact: "钥匙在旧抽屉" });
  let socket!: Upstream;
  const live = new LiveVoiceClient({ hubOrigin: "http://unused.test", enableNativeMic: false, enableNativePlayback: false,
    wsFactory: () => new LocalVoiceSocket(runtime, () => { socket = new Upstream(); return socket; }) });
  await live.start(); live.sendTextPrompt("记住钥匙在旧抽屉"); const oldSocket = socket;
  await runtime.memories.forget(memory.id);
  oldSocket.emit({ type: "response.function_call_arguments.done", call_id: "old", name: "remember_fact", arguments: JSON.stringify({ fact: "钥匙在旧抽屉" }) });
  await turn(); assert.equal(runtime.memories.list().length, 0); assert.equal(live.isActive(), false);
  await live.start(); live.sendTextPrompt("新的位置是背包，记住它");
  socket.emit({ type: "response.function_call_arguments.done", call_id: "new", name: "remember_fact", arguments: JSON.stringify({ fact: "钥匙在背包" }) });
  await turn(); assert.equal(runtime.memories.list()[0].location, "背包"); await live.stop();
});
