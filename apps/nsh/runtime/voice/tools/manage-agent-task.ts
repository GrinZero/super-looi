import type { VoiceToolContext, VoiceToolSchema } from "./types.js";

const VALID_ACTIONS = new Set(["status", "cancel"]);

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
      "查询本机后台任务的最新进度与结果（action=status），或中止正在运行的后台任务（action=cancel）。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "cancel"],
        },
        task_id: {
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
            throw new Error();
          }
          const args = JSON.parse(item.arguments);
          const action = typeof args.action === "string" ? args.action.trim() : "";
          if (!VALID_ACTIONS.has(action)) {
            throw new Error();
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
          } else {
            output = await context.taskBridge.cancel(taskId);
          }
        } catch {
          output = { error: "无法读取或操作后台任务状态。" };
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
