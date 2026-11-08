import type { VoiceToolContext, VoiceToolSchema } from "./types.js";

export function createRunAgentTask(
  context: Pick<
    VoiceToolContext,
    | "active"
    | "requestTask"
    | "taskBridge"
    | "toolTraceContext"
    | "reply"
    | "taskFinished"
    | "fail"
  >,
) {
  let runs = 0;

  const schema: VoiceToolSchema = {
    type: "function",
    name: "run_agent_task",
    description:
      "提交本机任务由 Agent 执行（支持短任务直接返回与长耗时任务自动转后台执行）；工具审批方式由用户在设置中选择。只根据返回结果回答。",
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
          const traceContext = context.toolTraceContext?.(callId);
          if (context.taskBridge) {
            const outcome = await context.taskBridge.submit(args.prompt, traceContext);
            if (outcome.status === "completed") {
              output = {
                status: "completed",
                taskId: outcome.taskId,
                answer: outcome.answer,
              };
            } else if (outcome.status === "running_in_background") {
              output = {
                status: "running_in_background",
                taskId: outcome.taskId,
                latestSummary: outcome.latestSummary,
                instruction:
                  "任务已转入后台独立运行，请简短自然地告知用户正在后台处理、完成后会自动通知，不要声称已完成。",
              };
            } else if (outcome.status === "waiting_user_confirmation") {
              output = {
                status: "waiting_user_confirmation",
                taskId: outcome.taskId,
                interactionKind: outcome.interactionKind,
                latestSummary: outcome.latestSummary,
                instruction:
                  "任务需要用户在屏幕上确认授权或回答问题后才能继续，请简短提醒用户看一眼屏幕。",
              };
            } else if (outcome.status === "busy") {
              output = {
                status: "busy",
                taskId: outcome.taskId,
                latestSummary: outcome.latestSummary,
                instruction:
                  "已有后台任务正在执行，请告知当前进度，或按用户意愿调用 manage_agent_task 取消原任务。",
              };
            } else {
              output = { error: outcome.error };
            }
          } else if (context.requestTask) {
            output = {
              answer: await context.requestTask(args.prompt, traceContext),
            };
          } else {
            throw new Error();
          }
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
