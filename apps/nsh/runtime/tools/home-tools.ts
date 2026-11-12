import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { HomeRuntime } from "../home.js";

export interface HomeToolsHost {
  home: HomeRuntime;
  database: DatabaseSync;
  getActiveTaskId: () => string | undefined;
}

/**
 * Creates Home Assistant / MIoT device discovery and control tools for the Pi Agent.
 */
export function createHomeTools(host: HomeToolsHost): AgentTool<any>[] {
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: { value },
  });
  return [
    {
      name: "list_home_devices",
      label: "查看家居设备",
      description:
        "Find smart-home devices (lamps, room lights, sockets, appliances) and current readbacks through the App's configured Mi Home / Home Assistant service. Independent of the LOOI robot dock and its BLE connection; no body status check is needed. Use actual entity_id and connectionId for control. Simulation is explicitly labelled and never represents real devices. Ask when multiple matches exist.",
      parameters: obj({
        query: opt(str()),
        offset: opt(int({ minimum: 0 })),
      }),
      execute: async (_, args) =>
        result(await host.home.list(args.query, args.offset)),
    },
    {
      name: "control_home_device",
      label: "控制家居设备",
      description:
        "Control one smart-home device through Mi Home / Home Assistant using the task's approval setting; no LOOI dock or BLE connection is required. Requires entity_id and connectionId from a recent list_home_devices call; connectionId identifies the home-service connection. Only a verified receipt confirms success. For failures report diagnostics.stage and the actual error/return code; claim acceptance only when diagnostics.write_acknowledged is true. Unknown must not be retried automatically. Simulation changes no real device.",
      parameters: obj({
        entity_id: str(),
        connectionId: str(),
        service: oneOf(["turn_on", "turn_off"]),
        brightness: opt(int({ minimum: 1, maximum: 255 })),
        color_temp_kelvin: opt(int()),
      }),
      execute: async (callId, args, signal) => {
        const taskId = host.getActiveTaskId();
        if (signal?.aborted || !taskId) {
          throw new Error("@looi:runtimeTaskStopped");
        }
        const service_data: Record<string, number> = {};
        if (args.brightness !== undefined) {
          service_data.brightness = args.brightness;
        }
        if (args.color_temp_kelvin !== undefined) {
          service_data.color_temp_kelvin = args.color_temp_kelvin;
        }
        const requestId = createHash("sha256")
          .update(`${taskId}:${callId}`)
          .digest("hex");
        const command = {
          entity_id: args.entity_id,
          domain: args.entity_id.split(".")[0],
          service: args.service,
          service_data,
        };
        const evidence = {
          requestId,
          connectionId: args.connectionId,
          command,
          simulation: host.home.configuration().mode === "simulation",
          recordedAt: new Date().toISOString(),
          status: "unknown",
          receipt: null as unknown,
        };
        // Commit intent before any possible side effect; a crash retains unknown.
        host.database
          .prepare(
            "INSERT INTO home_action_evidence (request_id, task_id, evidence) VALUES (?, ?, ?)",
          )
          .run(requestId, taskId, JSON.stringify(evidence));
        const outcome = await host.home.control(command, {
          connectionId: args.connectionId,
          requestId,
          signal,
        });
        evidence.status = outcome.receipt.status;
        evidence.receipt = outcome.receipt;
        host.database
          .prepare(
            "UPDATE home_action_evidence SET evidence = ? WHERE request_id = ?",
          )
          .run(JSON.stringify(evidence), requestId);
        return result(outcome);
      },
    },
  ];
}
