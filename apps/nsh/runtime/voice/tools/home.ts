import { createHash } from "node:crypto";
import { compile, obj, str, union, type Schema } from "@earendil-works/pi-schema";
import type { HomeEntityDefinition, HomeStateSnapshot, JsonObject } from "@super-looi/contracts";
import type { HomeRuntime } from "../../home.js";
import {
  homeDeviceCommand,
  homeOperation,
  homeOperationProperties,
  listHomeParameters,
} from "../../tools/home-tools.js";

export type VoiceHome = Pick<HomeRuntime, "list" | "control" | "controlByName">;

interface HomeReference {
  entity_id: string;
  connectionId: string;
}

type HomeListEntity = HomeEntityDefinition & {
  simulation: boolean;
  snapshot?: HomeStateSnapshot | null;
  read_error?: JsonObject;
};
type HomeChoice = { ref: string; name: string; room?: string; simulation: boolean };

/** The conversation owns this table, even across realtime tool or socket rebuilds. */
export class VoiceHomeReferences {
  private readonly refs = new Map<string, HomeReference>();
  private readonly byEntity = new Map<string, string>();
  private recentChoices: readonly HomeChoice[] = [];

  present(connectionId: string | null, devices: readonly HomeListEntity[]) {
    const results = connectionId ? devices.map(({ entity_id, device_id: _deviceId, snapshot, ...device }) => {
      const { entity_id: _snapshotId, ...state } = snapshot ?? {};
      return {
        ...device,
        ref: this.add(connectionId, entity_id),
        ...(snapshot !== undefined ? { snapshot: snapshot && state } : {}),
      };
    }) : [];
    this.recentChoices = results.map(({ ref, friendly_name, room, simulation }) => ({ ref, name: friendly_name, room, simulation }));
    return results;
  }

  lastPresented(): readonly HomeChoice[] {
    return this.recentChoices;
  }

  private add(connectionId: string, entity_id: string): string {
    const key = JSON.stringify([connectionId, entity_id]);
    const existing = this.byEntity.get(key);
    if (existing) return existing;
    const ref = `d${this.refs.size + 1}`;
    this.byEntity.set(key, ref);
    this.refs.set(ref, { entity_id, connectionId });
    return ref;
  }

  resolve(ref: string): HomeReference {
    const target = this.refs.get(ref);
    if (target) return target;
    throw Object.assign(new Error(`当前语音对话中没有设备引用 ${ref}`), {
      code: "home_reference_unknown",
      stage: "home.target_resolution",
    });
  }
}

const controlVoiceHomeParameters = obj({
  target: union([
    // Realtime's strict JSON Schema normalizes optional fields only outside an anyOf.
    obj({ name: str({ minLength: 1 }) }),
    obj({ name: str({ minLength: 1 }), room: str({ minLength: 1 }) }),
    obj({ ref: str({ minLength: 1 }) }),
  ]),
  ...homeOperationProperties,
});

const listArgs = compile(listHomeParameters);
const controlArgs = compile(controlVoiceHomeParameters);

function voiceParameters(schema: Schema) {
  return {
    type: "object" as const,
    properties: schema.properties as Record<string, Schema>,
    required: (schema.required as string[] | undefined) ?? [],
    additionalProperties: false as const,
  };
}

function invalidArguments(errors: unknown) {
  return Object.assign(new Error(JSON.stringify(errors)), {
    code: "INVALID_ARGUMENT",
  });
}

export function createVoiceHomeTools(home: VoiceHome, sessionId: string, references: VoiceHomeReferences) {
  return [
    {
      schema: {
        name: "list_home_devices",
        description: "查找家居设备并读取状态。query 可填写名称、房间或类型，offset 用于翻页。用户从结果中选设备时，使用被选项的 ref 控制。根据实际状态和 simulation 标记回答。",
        parameters: voiceParameters(listHomeParameters),
      },
      async execute(args: Record<string, unknown>) {
        if (!listArgs.check(args)) throw invalidArguments(listArgs.errors(args));
        const { connectionId, devices, ...result } = await home.list(args.query, args.offset);
        return {
          ...result,
          devices: references.present(connectionId, devices),
        };
      },
    },
    {
      schema: {
        name: "control_home_device",
        description: "按用户明确要求控制单个家居设备。直接传 target.name 和可选的 target.room，或在用户从候选中选定后传 target.ref。needs_selection 时询问用户。开启支持调光的灯可带 brightness（1–255）或 color_temp_kelvin（色温 K）。verified 表示状态已回读确认，simulation 表示离线演示。",
        parameters: voiceParameters(controlVoiceHomeParameters),
      },
      async execute(args: Record<string, unknown>, callId: string) {
        if (!controlArgs.check(args)) throw invalidArguments(controlArgs.errors(args));
        const requestId = createHash("sha256")
          .update(JSON.stringify(["voice", sessionId, callId]))
          .digest("hex");
        if ("ref" in args.target) {
          const target = references.resolve(args.target.ref);
          const { connectionId, ...result } = await home.control(
            homeDeviceCommand({ ...args, ...target }),
            { connectionId: target.connectionId, requestId },
          );
          return result;
        }
        const { connectionId, ...result } = await home.controlByName(args.target, homeOperation(args), requestId);
        if ("candidates" in result) {
          const { candidates, ...selection } = result;
          return {
            ...selection,
            candidates: references.present(connectionId, candidates),
          };
        }
        return result;
      },
    },
  ] as const;
}
