import { Platform } from "react-native";
import { cameraPerceiver } from "../perceivers/camera-perceiver";
import { moveLooi, setLooiHead, setLooiLight } from "./looi-robot";
import type { DeviceToolDefinition, DeviceToolExecutor } from "./types";

const DEVICE_ID = `${Platform.OS}-looi-device`;
const executors = new Map<string, DeviceToolExecutor>();
let polling = false;

export function registerLocalDeviceTool(definition: DeviceToolDefinition, executor: DeviceToolExecutor): DeviceToolDefinition {
  executors.set(definition.name, executor);
  return definition;
}

export const builtinDeviceTools: DeviceToolDefinition[] = [
  registerLocalDeviceTool({
    name: "device_take_photo",
    description: "使用设备前/后摄像头拍照。当前实现优先返回相机感知器最近一帧。",
    parameters: { type: "object", properties: { facing: { type: "string", enum: ["front", "back"] } } },
    timeoutMs: 15_000,
  }, async () => {
    const imageBase64 = cameraPerceiver.getLatestFrame();
    if (!imageBase64) return { ok: false, error: "camera frame unavailable" };
    return { ok: true, imageBase64, source: "latest_camera_frame" };
  }),
  registerLocalDeviceTool({
    name: "device_record_audio",
    description: "录制 n 秒音频并返回本地文件 URI（占位实现会在接入录音 UI/权限后启用）。",
    parameters: { type: "object", properties: { seconds: { type: "number", minimum: 1, maximum: 30 } }, required: ["seconds"] },
    timeoutMs: 45_000,
  }, async ({ seconds }) => ({ ok: false, error: `audio recording executor not wired yet (${seconds}s requested)` })),
  registerLocalDeviceTool({
    name: "device_record_video",
    description: "录制 n 秒视频并返回本地文件 URI（占位实现会在接入 CameraView recordAsync 后启用）。",
    parameters: { type: "object", properties: { seconds: { type: "number", minimum: 1, maximum: 30 }, facing: { type: "string", enum: ["front", "back"] } }, required: ["seconds"] },
    timeoutMs: 45_000,
  }, async ({ seconds }) => ({ ok: false, error: `video recording executor not wired yet (${seconds}s requested)` })),
  registerLocalDeviceTool({
    name: "device_get_orientation",
    description: "识别设备朝向。当前返回平台和待接入状态。",
    parameters: { type: "object", properties: {} },
  }, async () => ({ ok: true, platform: Platform.OS, orientation: "unknown" })),
  registerLocalDeviceTool({
    name: "looi_move",
    description: "控制 LOOI 机器人移动。direction 可为 forward/backward/left/right/stop。",
    parameters: { type: "object", properties: { direction: { type: "string", enum: ["forward", "backward", "left", "right", "stop"] }, durationMs: { type: "number" }, speed: { type: "number" } }, required: ["direction"] },
    timeoutMs: 20_000,
  }, async ({ direction, durationMs, speed }) => moveLooi(String(direction), Number(durationMs ?? 800), Number(speed ?? 50))),
  registerLocalDeviceTool({
    name: "looi_set_light",
    description: "打开/关闭 LOOI 灯光，可选颜色。",
    parameters: { type: "object", properties: { enabled: { type: "boolean" }, color: { type: "string" } }, required: ["enabled"] },
    timeoutMs: 20_000,
  }, async ({ enabled }) => setLooiLight(Boolean(enabled))),
  registerLocalDeviceTool({
    name: "looi_set_head",
    description: "控制 LOOI 头部方向。direction 可为 up/center/down，或 SDK 支持的数值/hex。",
    parameters: { type: "object", properties: { direction: { type: "string" } }, required: ["direction"] },
    timeoutMs: 20_000,
  }, async ({ direction }) => setLooiHead(String(direction))),
];

export async function registerAndPollDeviceTools(serverUrl: string): Promise<void> {
  await postJson(`${serverUrl}/api/device-tools/register`, { deviceId: DEVICE_ID, tools: builtinDeviceTools });
  if (polling) return;
  polling = true;
  void pollLoop(serverUrl);
}

async function pollLoop(serverUrl: string): Promise<void> {
  while (polling) {
    try {
      const response = await fetch(`${serverUrl}/api/device-tools/poll?deviceId=${encodeURIComponent(DEVICE_ID)}`);
      const payload = await response.json() as { calls?: Array<{ id: string; toolName: string; arguments: Record<string, unknown> }> };
      for (const call of payload.calls ?? []) {
        void executeAndReport(serverUrl, call);
      }
    } catch (error) {
      console.warn("[DeviceTools] Poll failed", error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function executeAndReport(serverUrl: string, call: { id: string; toolName: string; arguments: Record<string, unknown> }) {
  try {
    const executor = executors.get(call.toolName);
    if (!executor) throw new Error(`No executor for ${call.toolName}`);
    const result = await executor(call.arguments ?? {});
    await postJson(`${serverUrl}/api/device-tools/result`, { callId: call.id, result });
  } catch (error: any) {
    await postJson(`${serverUrl}/api/device-tools/result`, { callId: call.id, error: error?.message ?? String(error) });
  }
}

async function postJson(url: string, body: unknown) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
