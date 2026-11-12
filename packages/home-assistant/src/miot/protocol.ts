import { HomeTransportError, transportErrorDetails } from "../transport-error.js";

export const MIOT_CLIENT_ID = "2882303761520251711";
export type MiotRegion = "cn" | "de" | "i2" | "ru" | "sg" | "us";

export function miotHost(region: MiotRegion): string {
  if (!["cn", "de", "i2", "ru", "sg", "us"].includes(region)) throw new Error("miot_invalid_region");
  return `https://${region === "cn" ? "" : `${region}.`}ha.api.io.mi.com`;
}

export function validateClientId(value: string): void {
  if (!/^[1-9][0-9]{0,31}$/.test(value)) throw new Error("miot_invalid_client_id");
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface MiotNetworkOptions { fetch?: typeof fetch; timeoutMs?: number }

/** Preserve protocol failures and network causes without publishing request credentials. */
export async function miotJson(url: string, init: RequestInit, options: MiotNetworkOptions): Promise<unknown> {
  const timeout = options.timeoutMs ?? 5000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("miot_invalid_timeout");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = init.headers;
  const authorization = !headers ? "" : Array.isArray(headers)
    ? headers.find(([name]) => name.toLowerCase() === "authorization")?.[1] ?? ""
    : "get" in headers && typeof headers.get === "function" ? headers.get("Authorization") ?? ""
    : Object.entries(headers).find(([name]) => name.toLowerCase() === "authorization")?.[1] ?? "";
  const secrets = [authorization, authorization.replace(/^Bearer\s*/i, "")];
  try {
    const response = await (options.fetch ?? fetch)(url, { ...init, signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new HomeTransportError(response.status === 401 ? "miot_unauthorized" : "miot_http_failed", { http_status: response.status });
    try { return await response.json(); }
    catch (error) {
      if (controller.signal.aborted) throw error;
      throw new HomeTransportError("miot_invalid_json", { cause: transportErrorDetails(error, "miot_invalid_json", secrets).cause! });
    }
  } catch (error) {
    if (error instanceof HomeTransportError) throw error;
    const code = controller.signal.aborted ? "miot_request_timeout" : "miot_request_failed";
    throw new HomeTransportError(code, {
      ...transportErrorDetails(error, code, secrets),
      ...(controller.signal.aborted ? { timeout_ms: timeout } : {}),
    });
  } finally { clearTimeout(timer); }
}

export function unwrapMiot(value: unknown): unknown {
  if (record(value) && typeof value.code === "number" && value.code !== 0) {
    throw new HomeTransportError("miot_api_rejected", { upstream_code: value.code,
      ...(typeof value.message === "string" ? { upstream_message: value.message } : {}) });
  }
  if (!record(value) || value.code !== 0 || !("result" in value)) throw new HomeTransportError("miot_invalid_response");
  return value.result;
}
