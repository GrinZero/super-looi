import type { VoiceToolContext, VoiceToolSchema } from "./types.js";

const VALID_ACTIONS = new Set(["status", "cancel", "steer", "follow_up"]);

export function createManageAgentTask(
  context: Pick<
    VoiceToolContext,
    "active" | "taskBridge" | "reply" | "taskFinished" | "fail"
  >,
) {
  let runs = 0;

  const schema: VoiceToolSchema = {
    type: "function",
    name: "manage_agent_task",
    description:
      "查询任务进度（status）、中止任务（cancel）、向执行中的任务补充或纠正要求（steer），或安排当前执行结束后继续处理的消息（follow_up）。补充消息使用 message 字段。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "cancel", "steer", "follow_up"],
        },
        task_id: {
          type: "string",
        },
        message: { type: "string" },
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
            !context.taskBridge
          ) {
            throw new Error("任务管理请求格式不正确或任务宿主不可用。");
          }
          const args = JSON.parse(item.arguments);
          const action = typeof args.action === "string" ? args.action.trim() : "";
          if (!VALID_ACTIONS.has(action)) {
            throw new Error(`不支持的任务操作：${action}`);
          }
          const taskId =
            typeof args.task_id === "string" && args.task_id.trim()
              ? args.task_id.trim()
              : undefined;
          if (action === "status") {
            const snapshot = context.taskBridge.inspect(taskId);
            output = snapshot ?? {
              state: "none",
              message: "当前没有运行中或最近记录的后台任务。",
            };
          } else if (action === "cancel") {
            output = await context.taskBridge.cancel(taskId);
          } else {
            if (typeof args.message !== "string" || !args.message.trim()) throw new Error("补充任务要求需要非空 message。");
            if (!context.taskBridge.sendMessage) throw new Error("当前宿主未接入 Pi 消息队列。");
            output = await context.taskBridge.sendMessage(args.message.trim(), action === "steer" ? "steer" : "followUp", taskId);
          }
        } catch (error) {
          output = { error: error instanceof Error ? error.message : String(error) };
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
