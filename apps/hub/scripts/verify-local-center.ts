import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { LocalControlCenter } from "../../mobile/src/runtime/local-control-center.js";
import { LocalVoiceSocket } from "../../mobile/src/runtime/local-voice-socket.js";
import { LiveVoiceClient, type WebSocketAdapter } from "../../mobile/src/runtime/live-voice-client.js";
import { createHash, randomUUID } from "node:crypto";

try { process.loadEnvFile(new URL("../../../.env", import.meta.url)); } catch { /* An exported key also works. */ }
const key = process.env.DOUBAO_API_KEY;
if (!key) throw new Error("DOUBAO_API_KEY is required in .env");
const directory = await mkdtemp(path.join(tmpdir(), "looi-local-verification-"));
const credentials = new Map<string, string>();
let hubRequests = 0; let audioBytes = 0;
const tools = new Set<string>();
const frameTypes = new Map<string, number>();
const storage = {
  async get(name: string) { try { return await readFile(path.join(directory, createHash("sha256").update(name).digest("hex")), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } },
  async set(name: string, value: string) { await writeFile(path.join(directory, createHash("sha256").update(name).digest("hex")), value, "utf8"); },
};
function runtime() {
  return new LocalControlCenter({ hubOrigin: "http://hub-disabled.invalid", storage,
    credentials: { async get(name) { return credentials.get(name) ?? null; }, async set(name, value) { credentials.set(name, value); }, async delete(name) { credentials.delete(name); } },
    crypto: { randomUUID, async sha1(value) { return createHash("sha1").update(value).digest("hex"); } },
    fetch: (async () => { hubRequests++; throw new Error("Hub intentionally disabled"); }) as typeof fetch,
  });
}
let active: LiveVoiceClient | null = null;
async function round(center: LocalControlCenter, prompt: string, required: string[]) {
  let finalText = false;
  active = new LiveVoiceClient({ hubOrigin: "http://hub-disabled.invalid", enableNativeMic: false, enableNativePlayback: false,
    wsFactory: () => new LocalVoiceSocket(center, (url, apiKey) => {
      const socket = new WebSocket(url, { headers: { "X-Api-Key": apiKey } });
      socket.on("message", (raw) => { try { const event = JSON.parse(String(raw)); frameTypes.set(String(event.type), (frameTypes.get(String(event.type)) ?? 0) + 1); if (event.type === "response.output_audio.delta") audioBytes += Buffer.from(String(event.delta ?? ""), "base64").length; } catch {} });
      return socket as unknown as WebSocketAdapter;
    }), onAgentStatus: (status) => { if (status.phase === "tool_end") tools.add(status.tool); },
    onAssistantTranscript: (_text, final) => { if (final) finalText = true; },
  });
  await active.start();
  const aiff = path.join(directory, "query.aiff"); const wav = path.join(directory, "query.wav");
  execFileSync("say", ["-v", "Tingting", "-o", aiff, prompt]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  const bytes = await readFile(wav);
  let offset = 12; let pcm: Buffer | undefined;
  while (offset + 8 <= bytes.length) { const length = bytes.readUInt32LE(offset + 4); if (bytes.toString("ascii", offset, offset + 4) === "data") { pcm = bytes.subarray(offset + 8, offset + 8 + length); break; } offset += 8 + length + (length % 2); }
  if (!pcm) throw new Error("PCM fixture missing");
  for (let offset = 0; offset < pcm.length; offset += 640) {
    const chunk = pcm.subarray(offset, offset + 640); const samples = new Float32Array(chunk.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = chunk.readInt16LE(i * 2) / 32768;
    active.pushFloat32MicSamples(samples); await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline && !(required.every((name) => tools.has(name)) && finalText && audioBytes > 0)) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!required.every((name) => tools.has(name)) || !finalText || audioBytes === 0) { console.error(JSON.stringify({ tools: [...tools], finalText, audioBytes, frames: Object.fromEntries(frameTypes) })); throw new Error("required tools, transcript or PCM missing"); }
  await active.stop(); active = null;
}
try {
  const first = runtime(); await first.configure({ mode: "simulation", voiceMode: "local" }, { voiceKey: key });
  await round(first, "请记住，测试钥匙在蓝色抽屉。然后查询设备，打开离线演示的书房吸顶灯。只操作演示设备。", ["remember_fact", "list_home_devices", "control_home_device"]);
  const state = await first.getConnection();
  if (!first.memories.list("测试钥匙").length || state.entities.find((entity) => entity.entity_id === "light.study_ceiling")?.snapshot?.state !== "on") throw new Error("local persisted memory or control result missing");
  const restored = runtime(); await restored.initialize();
  await round(restored, "请查询本机记忆，告诉我测试钥匙在哪里。", ["recall_memory"]);
  if (hubRequests !== 0) throw new Error("unexpected Hub request");
  console.log(JSON.stringify({ status: "passed", hubRequests, tools: [...tools], persistedMemories: restored.memories.list().length, receivedPcmBytes: audioBytes, realDeviceControl: false }));
} finally {
  await active?.stop(); await rm(directory, { recursive: true, force: true });
}
