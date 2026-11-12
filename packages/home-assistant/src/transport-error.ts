import type { JsonObject, JsonValue } from "@super-looi/contracts";

/** A transport failure whose diagnostic fields can travel through tools and persistence. */
export class HomeTransportError extends Error {
  constructor(code: string, readonly details: JsonObject = {}) { super(code); }
}

function redact(text: string, secrets: readonly string[]): string {
  for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
  return text.replace(/https?:\/\/[^\s"<>]+/g, (value) => {
    try {
      const url = new URL(value);
      url.username = ""; url.password = "";
      url.searchParams.forEach((_value, key) => {
        if (/token|password|secret|authorization|signature|^(?:code|auth)$/i.test(key)) url.searchParams.set(key, "[redacted]");
      });
      if (/token|password|secret|authorization/i.test(url.hash)) url.hash = "[redacted]";
      return url.href;
    } catch { return "[redacted URL]"; }
  }).replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]");
}

function redactDetails(value: JsonValue, secrets: readonly string[]): JsonValue {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactDetails(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDetails(item, secrets)]));
  return value;
}

function errorCause(error: unknown, secrets: readonly string[]): JsonObject {
  if (!(error instanceof Error)) return { message: redact(String(error), secrets) };
  const cause: JsonObject = { name: error.name, message: redact(error.message, secrets) };
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "number" || typeof code === "string") cause.code = typeof code === "string" ? redact(code, secrets) : code;
  if (error.cause !== undefined) cause.cause = errorCause(error.cause, secrets);
  return cause;
}

export function transportErrorDetails(error: unknown, code = "home_transport_failed", secrets: readonly string[] = []): JsonObject {
  return error instanceof HomeTransportError
    ? redactDetails({ ...error.details, code: error.message }, secrets) as JsonObject
    : { code: error instanceof Error && /^(?:miot|ha|home)_[a-z0-9_:]+$/.test(error.message) ? error.message : code, cause: errorCause(error, secrets) };
}
