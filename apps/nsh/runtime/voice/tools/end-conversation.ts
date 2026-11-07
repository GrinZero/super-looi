import type { VoiceToolContext, VoiceToolSchema } from "./types.js";

export function createEndConversation(
  context: Pick<VoiceToolContext, "current" | "reply" | "beginFarewell" | "endSession" | "fail">,
) {
  let closing = false;
  let streamDone = false;
  let toolSent = false;
  let originResponseId = "";
  let responseStarted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schema: VoiceToolSchema = {
    type: "function",
    name: "end_conversation",
    description: "用户明确表示结束对话时调用。完成工具回执后简短自然地道别。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };

  return {
    schema,
    get closing() { return closing; },
    get complete() { return streamDone; },
    reset() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      closing = streamDone = toolSent = responseStarted = false;
      originResponseId = "";
    },
    execute(_item: Record<string, unknown>, callId: string, generation: number, responseId: string): void {
      closing = true;
      streamDone = false;
      toolSent = false;
      responseStarted = false;
      originResponseId = responseId;
      context.beginFarewell();
      timer = setTimeout(() => {
        if (context.current(generation)) context.endSession();
      }, 5000);
      void context.reply(callId, {}, generation).then(() => {
        if (context.current(generation)) toolSent = true;
      }).catch(() => {
        if (context.current(generation)) context.fail("道别回传失败");
      });
    },
    onAudioStarted(responseId: string): void {
      if (closing && toolSent && (!responseId || responseId !== originResponseId))
        responseStarted = true;
    },
    onAudioDone(): void {
      if (closing && toolSent && responseStarted) streamDone = true;
    },
    onResponseDone(responseId: string): boolean {
      if (closing && toolSent && (responseStarted || (responseId && responseId !== originResponseId))) {
        streamDone = true;
        return true;
      }
      return false;
    },
  };
}
