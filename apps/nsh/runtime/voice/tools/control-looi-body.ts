import type {
  VoiceBodyControlOptions,
  VoiceToolContext,
  VoiceToolSchema,
} from "./types.js";

const VALID_BODY_ACTIONS = new Set([
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
]);

function parseOptionalNumber(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function createControlLooiBody(
  context: Pick<
    VoiceToolContext,
    "active" | "controlBody" | "reply" | "taskFinished" | "fail"
  >,
) {
  let runs = 0;

  const schema: VoiceToolSchema = {
    type: "function",
    name: "control_looi_body",
    description:
      "仅控制 LOOI 机器人自身的蓝牙底座：头部俯仰（head_up/head_center/head_down 或 head_set 搭配 head_degrees 25..85）、方向或合成向量脉冲移动（forward/backward/turn_left/turn_right 或 move 搭配 speed/turn -127..127）、底座自带补光灯（light_on/light_off 或 light_set 搭配 brightness 0..255）、读取电量与外接供电（read_power）或立即停止（stop）。不能控制台灯、房间灯或其他家居设备；家居请求使用 run_agent_task，不依赖底座连接。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...VALID_BODY_ACTIONS],
        },
        duration_ms: {
          type: "string",
          description: "移动脉冲时长（50..1200 毫秒）",
        },
        head_degrees: {
          type: "string",
          description: "头部俯仰角度（25..85 度，配合 head_set）",
        },
        brightness: {
          type: "string",
          description: "底座自带补光灯亮度（0..255，配合 light_set 或 light_on）",
        },
        speed: {
          type: "string",
          description: "直行速度（-127..127，正数前进负数后退，配合 move）",
        },
        turn: {
          type: "string",
          description: "转向角速度（-127..127，正数左转负数右转，配合 move）",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };

  return {
    schema,
    get busy() {
      return runs > 0;
    },
    reset() {
      runs = 0;
    },
    execute(item: Record<string, unknown>, callId: string): void {
      runs++;
      void (async () => {
        let output: unknown;
        try {
          if (
            item.name !== schema.name ||
            typeof item.arguments !== "string" ||
            item.arguments.length > 4096 ||
            !context.controlBody
          ) {
            throw new Error();
          }
          const args = JSON.parse(item.arguments);
          const action = typeof args.action === "string" ? args.action.trim() : "";
          if (!VALID_BODY_ACTIONS.has(action)) {
            throw new Error();
          }
          const durationMs = parseOptionalNumber(args.duration_ms);
          const headDegrees = parseOptionalNumber(args.head_degrees);
          const brightness = parseOptionalNumber(args.brightness);
          const speed = parseOptionalNumber(args.speed);
          const turn = parseOptionalNumber(args.turn);
          const extra: VoiceBodyControlOptions = {
            ...(headDegrees !== undefined ? { headDegrees } : {}),
            ...(brightness !== undefined ? { brightness } : {}),
            ...(speed !== undefined ? { speed } : {}),
            ...(turn !== undefined ? { turn } : {}),
          };
          output =
            Object.keys(extra).length > 0
              ? await context.controlBody(action, durationMs, extra)
              : await context.controlBody(action, durationMs);
        } catch {
          output = { error: "底座动作未完成，请确认底座已连接。" };
        }
        if (!context.active()) return;
        await context.reply(callId, output);
        runs--;
        context.taskFinished();
      })().catch(() => {
        if (context.active()) context.fail("@looi:voiceTaskReplyFailed");
      });
    },
  };
}
