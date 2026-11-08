export interface HostRequest {
  op: string;
  [key: string]: unknown;
}
declare global {
  var __nsh_compat: ((request: string) => string) | undefined;
  var __nsh_print: ((text: string) => void) | undefined;
}
export function call<T = unknown>(
  op: string,
  args: Record<string, unknown> = {},
): T {
  if (typeof globalThis.__nsh_compat !== "function")
    throw Object.assign(new Error("NSH compatibility host is not installed"), {
      code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
    });
  const result = JSON.parse(
    globalThis.__nsh_compat(JSON.stringify({ ...args, op })),
  ) as { value?: T; error?: string };
  if (result.error)
    throw Object.assign(new Error(result.error), {
      code: result.error.split(":")[0],
    });
  return result.value as T;
}
export function unsupported(feature: string): never {
  throw Object.assign(
    new Error(`${feature} is unavailable in the mobile sandbox`),
    { code: "ERR_NOT_SUPPORTED" },
  );
}
