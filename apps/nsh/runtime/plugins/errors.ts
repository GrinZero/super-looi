import type { PluginFailure } from "./contracts.js";

/**
 * Structured error for the Plugin Microkernel.
 * Preserves failure stage, machine-readable error code, owning plugin ID, and underlying cause.
 */
export class PluginKernelError extends Error {
  readonly stage: string;
  readonly code: string | number;
  readonly pluginId?: string;

  constructor(options: {
    stage: string;
    code: string | number;
    reason: string;
    pluginId?: string;
    cause?: unknown;
  }) {
    super(options.reason, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "PluginKernelError";
    this.stage = options.stage;
    this.code = options.code;
    this.pluginId = options.pluginId;
  }

  toFailure(): PluginFailure {
    const causeText = formatErrorCause(this.cause);
    return {
      stage: this.stage,
      code: this.code,
      reason:
        causeText && !this.message.includes(causeText)
          ? `${this.message} (cause: ${causeText})`
          : this.message,
    };
  }
}

function formatErrorCause(cause: unknown): string {
  if (cause === undefined || cause === null) return "";
  if (cause instanceof Error) return cause.message || String(cause);
  if (typeof cause === "object" && "message" in cause && typeof (cause as { message?: unknown }).message === "string") {
    return (cause as { message: string }).message;
  }
  return String(cause);
}

export function extractPluginFailure(error: unknown, defaultStage: string, defaultCode?: string): PluginFailure {
  if (error instanceof PluginKernelError) {
    return error.toFailure();
  }
  if (error && typeof error === "object") {
    const candidate = error as {
      stage?: unknown;
      code?: unknown;
      message?: unknown;
      reason?: unknown;
      cause?: unknown;
    };
    const stage = typeof candidate.stage === "string" && candidate.stage ? candidate.stage : defaultStage;
    const code =
      typeof candidate.code === "string" || typeof candidate.code === "number"
        ? candidate.code
        : defaultCode;
    const baseReason =
      typeof candidate.reason === "string" && candidate.reason
        ? candidate.reason
        : typeof candidate.message === "string" && candidate.message
          ? candidate.message
          : String(error);
    const causeText = formatErrorCause(candidate.cause);
    const reason =
      causeText && !baseReason.includes(causeText)
        ? `${baseReason} (cause: ${causeText})`
        : baseReason;
    return { stage, ...(code !== undefined ? { code } : {}), reason };
  }
  return {
    stage: defaultStage,
    ...(defaultCode !== undefined ? { code: defaultCode } : {}),
    reason: String(error),
  };
}
