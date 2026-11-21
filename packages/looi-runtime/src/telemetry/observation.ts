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
