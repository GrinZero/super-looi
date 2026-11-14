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

function parseStructuredMessage(raw: string): {
  parsedStage?: string;
  parsedCode?: string;
  cleanedReason: string;
} {
  let rest = raw.trim();
  let parsedStage: string | undefined;
  let parsedCode: string | undefined;

  const bracketMatch = rest.match(/^\[stage=([^\s\]]+)(?:\s+code=([^\s\]]+))?\]\s*(.*)$/s);
  if (bracketMatch) {
    parsedStage = bracketMatch[1];
    if (bracketMatch[2]) {
      parsedCode = bracketMatch[2];
    }
    rest = bracketMatch[3]!.trim();
  }

  if (!parsedCode) {
    const codeMatch = rest.match(/^(ERR_[A-Z0-9_]+)(?::\s*|\s+)(.*)$/s);
    if (codeMatch) {
      parsedCode = codeMatch[1];
      rest = codeMatch[2]!.trim();
    } else if (/^ERR_[A-Z0-9_]+$/.test(rest)) {
      parsedCode = rest;
    }
  }

  return {
    ...(parsedStage ? { parsedStage } : {}),
    ...(parsedCode ? { parsedCode } : {}),
    cleanedReason: rest || raw,
  };
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
    const explicitStage =
      typeof candidate.stage === "string" && candidate.stage ? candidate.stage : undefined;
    const explicitCode =
      typeof candidate.code === "string" || typeof candidate.code === "number"
        ? candidate.code
        : undefined;
    const rawReason =
      typeof candidate.reason === "string" && candidate.reason
        ? candidate.reason
        : typeof candidate.message === "string" && candidate.message
          ? candidate.message
          : String(error);
    const { parsedStage, parsedCode, cleanedReason } = parseStructuredMessage(rawReason);
    const stage = explicitStage ?? parsedStage ?? defaultStage;
    const code = explicitCode ?? parsedCode ?? defaultCode;
    const causeText = formatErrorCause(candidate.cause);
    const reason =
      causeText && !cleanedReason.includes(causeText)
        ? `${cleanedReason} (cause: ${causeText})`
        : cleanedReason;
    return { stage, ...(code !== undefined ? { code } : {}), reason };
  }
  const { parsedStage, parsedCode, cleanedReason } = parseStructuredMessage(String(error));
  const code = parsedCode ?? defaultCode;
  return {
    stage: parsedStage ?? defaultStage,
    ...(code !== undefined ? { code } : {}),
    reason: cleanedReason,
  };
}
