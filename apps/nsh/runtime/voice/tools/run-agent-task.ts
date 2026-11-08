import type { VoiceToolContext, VoiceToolSchema } from "./types.js";

export function createRunAgentTask(
  context: Pick<
    VoiceToolContext,
    "active" | "requestTask" | "toolTraceContext" | "reply" | "taskFinished" | "fail"
  >,
) {
  let runs = 0;

  const schema: VoiceToolSchema = {
    type: "function",
    name: "run_agent_task",
    description:
      "提交本机任务由 Agent 执行；工具审批方式由用户在设置中选择。只根据返回结果回答。",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
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
    execute(item: Record<string, unknown>, callId: string, _responseId: string): void {
      runs++;
      void (async () => {
        let output: unknown;
        try {
          if (
            item.name !== schema.name ||
            typeof item.arguments !== "string" ||
            item.arguments.length > 8192
          ) {
            throw new Error();
          }
          const args = JSON.parse(item.arguments);
          if (
            typeof args.prompt !== "string" ||
            !args.prompt.trim() ||
            args.prompt.length > 4000
          ) {
            throw new Error();
          }
          output = {
            answer: await context.requestTask(
              args.prompt,
              context.toolTraceContext?.(callId),
            ),
          };
        } catch {
          output = { error: "任务未获确认或未完成，不得声称成功。" };
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
