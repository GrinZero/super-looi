import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { int, obj, oneOf, opt } from "@earendil-works/pi-schema";
import type {
  BodyRuntime,
  BodyControlAction,
  BodyControlInput,
} from "../body.js";

export interface BodyToolsHost {
  body: BodyRuntime;
  database: DatabaseSync;
  getActiveTaskId: () => string | undefined;
}

/**
 * Creates LOOI physical dock status and motion/head/light control tools for the Pi Agent.
 */
export function createBodyTools(host: BodyToolsHost): AgentTool<any>[] {
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: { value },
  });
  return [
    {
      name: "get_looi_body_status",
      label: "查看底座状态",
      description:
        "Read current LOOI physical dock connection, docked status, battery/external power status, head pitch angle, fill light brightness, and active motion vector.",
      parameters: obj({}),
      execute: async () => result(host.body.status()),
    },
    {
      name: "control_looi_body",
      label: "控制底座动作",
      description:
        "Control LOOI dock head pitch (head_up 85°, head_center 55°, head_down 25°, or head_set with head_degrees 25..85 where 25=down, 55=level, 85=up), bounded wheel movement (forward/backward/turn_left/turn_right or move with signed speed +1..127 forward / -1..-127 backward and turn +1..127 turn left / -1..-127 turn right), fill light (light_on/light_off or light_set with brightness 0 off, 1..255 on), power readback (read_power), or stop. A BLE connection is required; docked status does not gate control.",
      parameters: obj({
        action: oneOf([
          "head_up",
          "head_center",
          "head_down",
          "head_set",
          "forward",
          "backward",
          "turn_left",
          "turn_right",
          "move",
          "light_on",
          "light_off",
          "light_set",
          "read_power",
          "stop",
        ]),
        duration_ms: opt(int({ minimum: 50, maximum: 1200 })),
        head_degrees: opt(int({ minimum: 25, maximum: 85 })),
        brightness: opt(int({ minimum: 0, maximum: 255 })),
        speed: opt(int({ minimum: -127, maximum: 127 })),
        turn: opt(int({ minimum: -127, maximum: 127 })),
      }),
      execute: async (callId, args, signal) => {
        const taskId = host.getActiveTaskId();
        if (signal?.aborted || !taskId) {
          throw new Error("@looi:runtimeTaskStopped");
        }
        const requestId = createHash("sha256")
          .update(`${taskId}:body:${callId}`)
          .digest("hex");
        const command: BodyControlInput = {
          action: args.action as BodyControlAction,
          ...(args.duration_ms !== undefined
            ? { durationMs: args.duration_ms }
            : {}),
          ...(args.head_degrees !== undefined
            ? { headDegrees: args.head_degrees }
            : {}),
          ...(args.brightness !== undefined
            ? { brightness: args.brightness }
            : {}),
          ...(args.speed !== undefined ? { speed: args.speed } : {}),
          ...(args.turn !== undefined ? { turn: args.turn } : {}),
        };
        const evidence = {
          requestId,
          command,
          simulation: host.body.configuration().mode === "simulation",
          recordedAt: new Date().toISOString(),
          status: "unknown",
          receipt: null as unknown,
        };
        host.database
          .prepare(
            "INSERT INTO body_action_evidence (request_id, task_id, evidence) VALUES (?, ?, ?)",
          )
          .run(requestId, taskId, JSON.stringify(evidence));
        const receipt = await host.body.control(command, "pi_agent");
        evidence.status = receipt.status;
        evidence.receipt = receipt;
        host.database
          .prepare(
            "UPDATE body_action_evidence SET evidence = ? WHERE request_id = ?",
          )
          .run(JSON.stringify(evidence), requestId);
        return result({ status: receipt.status, receipt });
      },
    },
  ];
}
