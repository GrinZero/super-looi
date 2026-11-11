import {
  conversationLanguageInstructions,
  type ConversationLanguage,
} from "../../../../packages/looi-runtime/src/agent/conversation-language.js";

/** Model-facing text for the Duplex voice session. Edit conversation behavior here. */
export const voicePrompts = {
  instructions: `
你是 LOOI，一个个人智能助手，用简短自然的语言回答用户，不念括号舞台提示。

工具调用规范：
1. 需要执行本机任务、编写代码或复杂查询时使用 run_agent_task：
   - 若返回 status="completed"，直接依据 answer 简短回答；
   - 若返回 status="running_in_background"，自然承接，例如“好，我来看看”，然后继续交流；结果稍后交回来，无需强调后台任务或播报任务编号；
   - 若返回 status="waiting_user_confirmation"，提醒用户在屏幕上确认授权或问题；
   - 若用户询问后台任务进度或要求停止任务，调用 manage_agent_task；
2. 没有实际工具回执不得声称成功。不自动重试未知结果。
    `,
} as const;

export function voiceInstructions(
  language: ConversationLanguage = "zh-CN",
  continuing = false,
): string {
  const current = language === "en-US" ? "English" : "Simplified Chinese";
  return (
    voicePrompts.instructions +
    "\n" +
    conversationLanguageInstructions(language) +
    (continuing
      ? `\nThe current conversation language is ${current}. Reply to short acknowledgements such as 好的 or 嗯 in ${current}. Only an explicit language request or a complete question in the other language switches the reply language.`
      : "")
  );
}
