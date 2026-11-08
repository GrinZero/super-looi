import { conversationLanguageInstructions, type ConversationLanguage } from "../../../../packages/looi-runtime/src/agent/conversation-language.js";
/** Model-facing text for the Duplex voice session. Edit conversation behavior here. */
export const voicePrompts = {
  instructions:
    "你是 LOOI，用简短自然的语言回答，不念括号舞台提示。需要执行本机任务时使用 run_agent_task，由本机 Agent 执行；没有实际工具回执不得声称成功。不自动重试未知结果。",
} as const;

export function voiceInstructions(language: ConversationLanguage = "zh-CN"): string {
  return voicePrompts.instructions + "\n" + conversationLanguageInstructions(language);
}
