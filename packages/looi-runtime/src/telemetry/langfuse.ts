import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

export interface TraceContext {
  traceId: string;
  parentSpanId?: string;
  traceName: string;
  sessionId?: string;
}
export type ObservationAttributes = Record<string, unknown>;
/** The same observation used by the local inspector and the remote exporter. */
export interface TraceObservation {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  type: "span" | "agent" | "generation" | "tool";
  startedAt: number;
  endedAt?: number;
  attributes: ObservationAttributes;
}
export interface Observation {
  readonly context: TraceContext;
  readonly spanId: string;
  end(attributes?: ObservationAttributes, endTimeMs?: number): void;
}
export interface LangfuseTracer {
  readonly enabled: boolean;
  start(name: string, type: "span" | "agent" | "generation" | "tool", context?: TraceContext, attributes?: ObservationAttributes, startTimeMs?: number): Observation;
  registerSecret(value: string): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const hex = (length: number) => randomUUID().replaceAll("-", "").slice(0, length);
const complexKeys = new Set([
  "langfuse.observation.input", "langfuse.observation.output",
  "langfuse.observation.usage_details", "langfuse.observation.cost_details",
  "langfuse.observation.model.parameters",
]);
function otlpValue(key: string, value: unknown): Record<string, unknown> {
  if (complexKeys.has(key)) return { stringValue: typeof value === "string" ? value : JSON.stringify(value) };
  if (key === "langfuse.observation.completion_start_time") return { stringValue: typeof value === "number" ? new Date(value).toISOString() : String(value) };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: typeof value === "string" ? value : JSON.stringify(value) };
}
const attributes = (values: ObservationAttributes) => Object.entries(values)
  .filter(([, value]) => value !== undefined && value !== null)
  .map(([key, value]) => ({ key, value: otlpValue(key, value) }));
const noopObservation: Observation = { context: { traceId: "", traceName: "" }, spanId: "", end() {} };
export const NOOP_TRACER: LangfuseTracer = {
  enabled: false,
  start: () => noopObservation,
  registerSecret: () => {},
  flush: async () => {},
  shutdown: async () => {},
};

export function createLangfuseTracer(config?: {
  baseUrl?: string;
  publicKey?: string;
  secretKey?: string;
  fetch?: typeof fetch;
  flushIntervalMs?: number;
  onObservation?: (observation: TraceObservation) => void;
}): LangfuseTracer {
  const remote = Boolean(config?.baseUrl && config.publicKey && config.secretKey);
  if (!remote && !config?.onObservation) return NOOP_TRACER;
  const queue: Record<string, unknown>[] = [];
  const secrets = new Set<string>(config?.secretKey ? [config.secretKey] : []);
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") {
      let result = value;
      for (const secret of secrets) if (secret.length >= 4) result = result.replaceAll(secret, "[redacted]");
      return result;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
    return value;
  };
  let flushing: Promise<void> | undefined;
  let closed = false;
  const send = config?.fetch || fetch;
  const url = `${config?.baseUrl?.replace(/\/$/, "")}/api/public/otel/v1/traces`;
  const authorization = `Basic ${Buffer.from(`${config?.publicKey}:${config?.secretKey}`).toString("base64")}`;
  let exportFailureReported = false;
  const flush = async (): Promise<void> => {
    if (flushing) return flushing;
    if (!queue.length) return;
    const batch = queue.splice(0, queue.length);
    flushing = (async () => {
      try {
        const response = await send(url, {
          method: "POST",
          headers: { Authorization: authorization, "Content-Type": "application/json", "x-langfuse-ingestion-version": "4" },
          body: JSON.stringify({ resourceSpans: [{ resource: { attributes: attributes({ "service.name": "super-looi" }) }, scopeSpans: [{ scope: { name: "super-looi" }, spans: batch }] }] }),
        });
        if (!response.ok) throw new Error(`Langfuse ingestion returned ${response.status}`);
        exportFailureReported = false;
      } catch (error) {
        if (!exportFailureReported) console.error("Langfuse OTLP export failed:", error);
        exportFailureReported = true;
        queue.unshift(...batch.slice(0, Math.max(0, 500 - queue.length)));
      } finally {
        flushing = undefined;
      }
    })();
    await flushing;
  };
  const timer = remote ? setInterval(() => { void flush(); }, config?.flushIntervalMs ?? 5000) : undefined;
  timer?.unref?.();
  return {
    enabled: true,
    registerSecret(value) { if (value.length >= 4) secrets.add(value); },
    start(name, type, parent, initial = {}, startTimeMs) {
      const spanId = hex(16);
      const context: TraceContext = {
        traceId: parent?.traceId || hex(32), parentSpanId: spanId,
        traceName: parent?.traceName || name,
        ...(parent?.sessionId ? { sessionId: parent.sessionId } : {}),
      };
      const started = startTimeMs ?? Date.now();
      const initialAttributes = scrub(initial) as ObservationAttributes;
      const record: TraceObservation = {
        traceId: context.traceId, spanId,
        ...(parent?.parentSpanId ? { parentSpanId: parent.parentSpanId } : {}),
        name, type, startedAt: started,
        attributes: { "langfuse.trace.name": context.traceName,
          ...(context.sessionId ? { "session.id": context.sessionId } : {}), ...initialAttributes },
      };
      config?.onObservation?.(structuredClone(record));
      let ended = false;
      return {
        context, spanId,
        end(final = {}, endTimeMs) {
          if (ended) return;
          ended = true;
          const endedAt = endTimeMs ?? Date.now();
          const finalAttributes = scrub(final) as ObservationAttributes;
          record.endedAt = endedAt;
          record.attributes = { ...record.attributes, ...finalAttributes };
          config?.onObservation?.(structuredClone(record));
          if (!remote) return;
          if (queue.length >= 500) queue.shift();
          queue.push({
            traceId: context.traceId, spanId,
            ...(parent?.parentSpanId ? { parentSpanId: parent.parentSpanId } : {}),
            name, startTimeUnixNano: String(BigInt(started) * 1_000_000n), endTimeUnixNano: String(BigInt(Math.max(started + 1, endedAt)) * 1_000_000n),
            attributes: attributes(scrub({
              "langfuse.observation.type": type,
              "langfuse.trace.name": context.traceName,
              ...(context.sessionId ? { "session.id": context.sessionId, "langfuse.session.id": context.sessionId } : {}),
              ...initialAttributes, ...finalAttributes,
            }) as ObservationAttributes),
          });
        },
      };
    },
    flush,
    async shutdown() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      if (flushing) await flushing;
      await flush();
    },
  };
}

export function createLangfuseTracerFromEnv(env: Record<string, string | undefined> = process.env): LangfuseTracer {
  return createLangfuseTracer({
    baseUrl: env.LANGFUSE_BASE_URL,
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
  });
}
