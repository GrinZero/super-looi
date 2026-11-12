import type { VoiceToolContext, VoiceToolSchema } from "./types.js";

const MAX_INLINE_ANSWER_CHARS = 12_000;

function capInlineAnswer(raw: string): string {
  return raw.length > MAX_INLINE_ANSWER_CHARS
    ? `${raw.slice(0, MAX_INLINE_ANSWER_CHARS)}…`
    : raw;
}

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
      "查询或控制智能家居（台灯、房间灯、插座、空调等），或执行本机任务、编写代码与复杂查询。家居通过已配置的米家／Home Assistant 服务执行，无需连接 LOOI 底座。prompt 应包含用户指定的设备、房间和动作。可能直接返回完成结果，也可能先返回受理并稍后将结果带回对话；用户可以继续交流。工具审批方式由用户设置。",
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
    execute(item: Record<string, unknown>, callId: string): void {
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
                answer: capInlineAnswer(outcome.answer),
              };
            } else if (outcome.status === "running_in_background") {
              output = {
                status: "running_in_background",
                taskId: outcome.taskId,
                latestSummary: outcome.latestSummary,
                instruction:
                  "已接下这件事。简短自然地承接用户，让对话继续；无需播报任务编号或强调后台执行，结果稍后交回来。",
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
              answer: capInlineAnswer(await context.requestTask(args.prompt, traceContext)),
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
