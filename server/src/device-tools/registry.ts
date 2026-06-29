import type { TSchema } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../infra/tools.js";

export interface DeviceToolRegistration {
  deviceId: string;
  name: string;
  description: string;
  parameters: TSchema;
  timeoutMs?: number;
}

export interface DeviceToolCall {
  id: string;
  deviceId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  createdAt: number;
  timeoutMs: number;
}

type PendingCall = DeviceToolCall & {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const registrations = new Map<string, DeviceToolRegistration>();
const pendingByDevice = new Map<string, PendingCall[]>();
const pendingById = new Map<string, PendingCall>();

function key(deviceId: string, toolName: string): string {
  return `${deviceId}:${toolName}`;
}

export function registerDeviceTools(deviceId: string, tools: Omit<DeviceToolRegistration, "deviceId">[]): void {
  for (const tool of tools) {
    registrations.set(key(deviceId, tool.name), {
      ...tool,
      deviceId,
      timeoutMs: Math.min(tool.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    });
  }
}

export function getDeviceToolDefinitions(): ToolDefinition[] {
  return [...registrations.values()].map((registration) => ({
    name: registration.name,
    description: `${registration.description}\n设备: ${registration.deviceId}`,
    parameters: registration.parameters,
    execute: (args) => enqueueDeviceToolCall(registration, args),
  }));
}

export function listDeviceTools(): DeviceToolRegistration[] {
  return [...registrations.values()];
}

export function pollDeviceToolCalls(deviceId: string): DeviceToolCall[] {
  return (pendingByDevice.get(deviceId) ?? []).map(({ resolve: _r, reject: _j, timer: _t, ...call }) => call);
}

export function resolveDeviceToolCall(id: string, result: unknown, isError = false): boolean {
  const pending = pendingById.get(id);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingById.delete(id);
  const queue = pendingByDevice.get(pending.deviceId) ?? [];
  pendingByDevice.set(pending.deviceId, queue.filter((call) => call.id !== id));
  if (isError) {
    pending.reject(new Error(typeof result === "string" ? result : JSON.stringify(result)));
  } else {
    pending.resolve(result);
  }
  return true;
}

function enqueueDeviceToolCall(
  registration: DeviceToolRegistration,
  args: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const call: DeviceToolCall = {
      id: crypto.randomUUID(),
      deviceId: registration.deviceId,
      toolName: registration.name,
      arguments: args,
      createdAt: Date.now(),
      timeoutMs: registration.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    const timer = setTimeout(() => {
      pendingById.delete(call.id);
      const queue = pendingByDevice.get(call.deviceId) ?? [];
      pendingByDevice.set(call.deviceId, queue.filter((item) => item.id !== call.id));
      reject(new Error(`Device tool timed out: ${call.toolName}`));
    }, call.timeoutMs);
    const pending = { ...call, resolve, reject, timer };
    pendingById.set(call.id, pending);
    pendingByDevice.set(call.deviceId, [...(pendingByDevice.get(call.deviceId) ?? []), pending]);
  });
}

