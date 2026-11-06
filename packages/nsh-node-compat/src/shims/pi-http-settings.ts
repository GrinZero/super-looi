import { unsupported } from "../bridge.js";
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300000;
export const HTTP_IDLE_TIMEOUT_CHOICES = [
  { label: "30 sec", timeoutMs: 30000 },
  { label: "1 min", timeoutMs: 60000 },
  { label: "2 min", timeoutMs: 120000 },
  { label: "5 min", timeoutMs: 300000 },
  { label: "disabled", timeoutMs: 0 },
];
export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "string") {
    const s = value.trim();
    if (s.toLowerCase() === "disabled") return 0;
    if (!s) return undefined;
    return parseHttpIdleTimeoutMs(Number(s));
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}
export function formatHttpIdleTimeoutMs(value: number) {
  return (
    HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === value)?.label ??
    `${value / 1000} sec`
  );
}
// SDK provider requests carry timeoutMs to the native fetch transport. A global
// Node dispatcher or proxy cannot be configured in the mobile sandbox.
export function configureHttpDispatcher() {
  return unsupported(
    "Node global HTTP dispatcher; configure the NSH native fetch transport",
  );
}
export function applyHttpProxySettings(proxy?: string) {
  if (proxy?.trim())
    unsupported("Node HTTP proxy; configure the native transport");
}
