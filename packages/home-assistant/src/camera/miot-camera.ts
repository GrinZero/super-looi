import {
  MiotActionRequestError,
  type MiotActionCall,
  type MiotActionResult,
  type MiotDevice,
  type MiotHttpClient,
  type MiotPropertyRef,
} from "../miot/miot-http-client.js";
import type { MiotSpec, MiotSpecAction } from "../miot/miot-spec-resolver.js";

export type MiotCameraFailure =
  | "unsupported"
  | "off"
  | "busy"
  | "auth"
  | "network"
  | "action"
  | "unavailable"
  | "cancelled";
export class MiotCameraError extends Error {
  constructor(
    readonly reason: MiotCameraFailure,
    readonly code?: number,
  ) {
    super(`miot_camera_${reason}`);
  }
}
export interface MiotCameraCapability {
  did: string;
  model: string;
  kind: "hls" | "p2p_pending" | "unsupported";
  power?: MiotPropertyRef;
  hls?: {
    start: MiotActionCall;
    stop: MiotActionCall;
    status?: MiotPropertyRef;
    configuration?: MiotActionCall;
    configurationStatusIndex?: number;
    configurationStatusPiid?: number;
    addressPiid: number;
    addressIndex: number;
  };
}
export interface MiotCameraPlayback {
  url: string;
  protocol: "hls";
}
export interface MiotCameraSession {
  ready: Promise<MiotCameraPlayback>;
  close(): Promise<void>;
}

/** Discover actions and their input/output positions from this DID's spec. */
export function discoverMiotCamera(
  device: MiotDevice,
  spec: MiotSpec,
): MiotCameraCapability | undefined {
  if (!device.model.includes(".camera.") && spec.deviceType !== "camera")
    return;
  const power = spec.services
    .find((service) => service.name === "camera-control")
    ?.properties.find(
      (property) => property.name === "on" && property.readable,
    );
  const capability: MiotCameraCapability = {
    did: device.did,
    model: device.model,
    kind: spec.services.some((service) =>
      service.actions?.some((action) => action.name === "start-p2p-stream"),
    )
      ? "p2p_pending"
      : "unsupported",
    ...(power
      ? { power: { did: device.did, siid: power.siid, piid: power.piid } }
      : {}),
  };
  for (const service of spec.services) {
    const start = service.actions?.find(
      (action) => action.name === "start-hls-stream",
    );
    const stop = service.actions?.find(
      (action) => action.name === "stop-stream",
    );
    const attribute = service.properties.find(
      (property) => property.name === "video-attribute",
    );
    const address = service.properties.find(
      (property) => property.name === "stream-address",
    );
    if (
      !start ||
      !stop ||
      !attribute ||
      !address ||
      start.in.length !== 1 ||
      start.in[0] !== attribute.piid ||
      !start.out.includes(address.piid)
    )
      continue;
    const attributeValue = attribute.valueList?.[0]?.value;
    if (attributeValue === undefined) continue;
    const status = service.properties.find(
      (property) => property.name === "stream-status",
    );
    const configuration = service.actions?.find(
      (action) => action.name === "get-stream-configuration",
    );
    const configurationStatus = status;
    const call = (action: MiotSpecAction): MiotActionCall => ({
      did: device.did,
      siid: action.siid,
      aiid: action.aiid,
      in: [],
    });
    capability.kind = "hls";
    capability.hls = {
      start: { ...call(start), in: [attributeValue] },
      stop: call(stop),
      ...(status
        ? { status: { did: device.did, siid: status.siid, piid: status.piid } }
        : {}),
      ...(configuration &&
      configurationStatus &&
      configuration.out.includes(configurationStatus.piid)
        ? {
            configuration: call(configuration),
            configurationStatusIndex: configuration.out.indexOf(
              configurationStatus.piid,
            ),
            configurationStatusPiid: configurationStatus.piid,
          }
        : {}),
      addressPiid: address.piid,
      addressIndex: start.out.indexOf(address.piid),
    };
    break;
  }
  return capability;
}

function output(
  result: MiotActionResult,
  piid: number,
  index: number,
): unknown {
  const keyed = result.out?.find(
    (item) =>
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).piid === piid,
  ) as Record<string, unknown> | undefined;
  return keyed ? keyed.value : result.out?.[index];
}
function failure(error: unknown): MiotCameraError {
  if (error instanceof MiotCameraError) return error;
  if (error instanceof MiotActionRequestError)
    return new MiotCameraError("action", error.code);
  const message = error instanceof Error ? error.message : "";
  return new MiotCameraError(
    /auth|unauthorized|credential/.test(message) ? "auth" : "network",
  );
}

/** One accepted/possibly accepted start owns exactly one bounded stop. A close
 * keeps the original client alive until a late start is accounted for. */
export function createMiotCameraSession(options: {
  client: Pick<MiotHttpClient, "getProperties" | "callAction">;
  capability: MiotCameraCapability;
}): MiotCameraSession {
  let closed = false;
  let start: "unsent" | "pending" | "accepted" | "rejected" = "unsent";
  let available = false;
  let cleaning: Promise<void> | undefined;
  const { client, capability } = options;
  const hls = capability.hls;
  const cleanup = (): Promise<void> => {
    if (cleaning) return cleaning;
    if (!hls || !available || start === "unsent" || start === "rejected")
      return Promise.resolve();
    cleaning = (async () => {
      const result = await client.callAction(hls.stop);
      if (result.code !== 0) throw new MiotCameraError("action", result.code);
    })();
    return cleaning;
  };
  const ready = (async (): Promise<MiotCameraPlayback> => {
    try {
      if (capability.kind !== "hls" || !hls)
        throw new MiotCameraError("unsupported");
      let state: Awaited<ReturnType<MiotHttpClient["getProperties"]>> = [];
      try {
        state = await client.getProperties(
          [capability.power, hls.status].filter(
            (item): item is MiotPropertyRef => Boolean(item),
          ),
        );
      } catch {
        /* Configuration action can still establish availability. */
      }
      if (closed) throw new MiotCameraError("cancelled");
      const power =
        capability.power &&
        state.find(
          (item) =>
            item.siid === capability.power!.siid &&
            item.piid === capability.power!.piid,
        );
      if (power && power.code === 0 && power.value === false)
        throw new MiotCameraError("off");
      let status: unknown =
        hls.status &&
        state.find(
          (item) =>
            item.siid === hls.status!.siid &&
            item.piid === hls.status!.piid &&
            item.code === 0,
        )?.value;
      if (status !== 1 && status !== 2 && hls.configuration) {
        const config = await client.callAction(hls.configuration);
        if (config.code !== 0) throw new MiotCameraError("action", config.code);
        status = output(
          config,
          hls.configurationStatusPiid!,
          hls.configurationStatusIndex!,
        );
      }
      if (status === 2) throw new MiotCameraError("busy");
      if (status !== 1) throw new MiotCameraError("unavailable");
      available = true;
      if (closed) throw new MiotCameraError("cancelled");
      start = "pending";
      let result: MiotActionResult;
      try {
        result = await client.callAction(hls.start);
      } catch (error) {
        if (error instanceof MiotActionRequestError) start = "rejected";
        throw error;
      }
      if (result.code !== 0) {
        start = "rejected";
        throw new MiotCameraError("action", result.code);
      }
      start = "accepted";
      if (closed) throw new MiotCameraError("cancelled");
      const address = output(result, hls.addressPiid, hls.addressIndex);
      if (typeof address !== "string" || !/^https?:\/\//.test(address))
        throw new MiotCameraError("unavailable");
      return { protocol: "hls", url: address };
    } catch (error) {
      // Unknown transport outcomes after an Available start attempt get one
      // cleanup too; a definite rejection/busy state never stops another viewer.
      try {
        await cleanup();
      } catch {
        /* close() still observes the same rejected cleanup promise. */
      }
      throw failure(error);
    }
  })();
  return {
    ready,
    close() {
      closed = true;
      return ready
        .then(
          () => undefined,
          () => undefined,
        )
        .then(cleanup);
    },
  };
}
