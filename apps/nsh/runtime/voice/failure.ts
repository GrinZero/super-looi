import type { VoiceAudioPort } from "./types.js";
import type { VoiceSessionFailure } from "@super-looi/runtime/telemetry";

export function describeVoiceFailure(
  stage: string,
  error: unknown,
  secret = "",
): VoiceSessionFailure {
  const details: string[] = [];
  let code: string | undefined;
  const seen = new Set<unknown>();
  for (let cause = error; cause !== undefined && !seen.has(cause); ) {
    seen.add(cause);
    if (cause && typeof cause === "object") {
      const info = cause as Record<string, unknown>;
      const fields = [
        "code",
        "errno",
        "domain",
        "status",
        "statusCode",
        "responseId",
        "turnId",
      ]
        .filter((key) => info[key] !== undefined)
        .map((key) => `${key}=${String(info[key])}`);
      if (!code && info.code !== undefined) code = String(info.code);
      const status = String(info.statusCode ?? info.status ?? "");
      if (!code && (status === "401" || status === "403")) code = status;
      const reason =
        typeof info.message === "string" ? info.message : JSON.stringify(cause);
      details.push([fields.join(" "), reason].filter(Boolean).join(": "));
      cause = info.cause;
    } else {
      details.push(String(cause));
      break;
    }
  }
  const redact = (value: string) =>
    secret ? value.replaceAll(secret, "[redacted]") : value;
  return {
    stage,
    ...(code ? { code: redact(code) } : {}),
    message: redact(
      details.length ? details.join("; caused by: ") : String(error),
    ),
  };
}

export function nativeAudioFailure(status: ReturnType<VoiceAudioPort["status"]>): Error {
  const error = new Error(status.error ||
    `Native audio state: ${status.state}; capture mode: ${status.captureMode}; wake model ready: ${status.kwsReady}`);
  return status.errorCode ? Object.assign(error, { code: status.errorCode }) : error;
}
