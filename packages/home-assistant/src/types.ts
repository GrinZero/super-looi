import type { HomeStateSnapshot } from "@super-looi/contracts";

export interface HaTransportAdapter {
  /** Quantize supported numeric targets before sending and comparing the physical readback. */
  normalizeServiceData?(entityId: string, data: Record<string, unknown>): Record<string, unknown>;
  listStates?(): Promise<HomeStateSnapshot[]>;
  callService(domain: string, service: string, serviceData: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  fetchState(entityId: string): Promise<HomeStateSnapshot | null>;
  isHealthy(): boolean;
  getLastVerifiedAt(): string | null;
}

/** Provider-independent function tool schema, usable by any voice engine. */
export interface HomeVoiceToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Minimal standard WebSocket surface shared by browsers, React Native and Node. */
export interface HomeRegistrySocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error" | "close", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "error" | "close", listener: () => void): void;
}

export interface HomeRegistryOptions {
  createWebSocket?: (url: string) => HomeRegistrySocket;
  timeoutMs?: number;
}
