import type { VoiceToolContext, VoiceToolSchema } from "./types.js";

const VALID_BODY_ACTIONS = new Set([
  "head_up",
  "head_center",
  "head_down",
  "forward",
  "backward",
  "turn_left",
  "turn_right",
  "light_on",
  "light_off",
  "stop",
]);

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
      "控制 LOOI 机器人底座执行头部俯仰（head_up/head_center/head_down）、方向脉冲移动（forward/backward/turn_left/turn_right）、补光灯开关（light_on/light_off）或立即停止（stop）。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...VALID_BODY_ACTIONS],
        },
        duration_ms: {
          type: "string",
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
    execute(
      item: Record<string, unknown>,
      callId: string,
      _responseId: string,
    ): void {
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
          const parsedDuration =
            args.duration_ms !== undefined ? Number(args.duration_ms) : undefined;
          const durationMs =
            typeof parsedDuration === "number" && Number.isFinite(parsedDuration)
              ? parsedDuration
              : undefined;
          output = await context.controlBody(action, durationMs);
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
