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

/** Never expose request URLs, response bodies or credential-bearing fetch exceptions. */
export async function miotJson(url: string, init: RequestInit, options: MiotNetworkOptions): Promise<unknown> {
  const timeout = options.timeoutMs ?? 5000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("miot_invalid_timeout");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await (options.fetch ?? fetch)(url, { ...init, signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error(response.status === 401 ? "miot_unauthorized" : "miot_http_failed");
    return await response.json();
  } catch (error) {
    if (error instanceof Error && ["miot_unauthorized", "miot_http_failed"].includes(error.message)) throw error;
    throw new Error("miot_request_failed");
  } finally { clearTimeout(timer); }
}

export function unwrapMiot(value: unknown): unknown {
  if (!record(value) || value.code !== 0 || !("result" in value)) throw new Error("miot_invalid_response");
  return value.result;
}
