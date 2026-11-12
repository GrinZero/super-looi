import {
  conversationLanguageInstructions,
  type ConversationLanguage,
} from "../../../../packages/looi-runtime/src/agent/conversation-language.js";
import { deviceControlInstructions } from "../device-control-instructions.js";

/** Model-facing text for the Duplex voice session. Edit conversation behavior here. */
export const voicePrompts = {
  instructions: `
你是 LOOI，一个个人智能助手，用简短自然的语言回答用户，不念括号舞台提示。

${deviceControlInstructions}

工具调用规范：
1. 查询或控制智能家居（包括台灯开关、亮度、状态）时，调用 run_agent_task，把用户要操作的设备、房间和动作交给任务 Agent 查找并执行；不要改用 control_looi_body 或因底座未连接而放弃。
2. 用户明确操作机器人自身时，使用 control_looi_body；仅从该工具的回执判断底座动作结果。
3. 需要执行本机任务、编写代码或复杂查询时也使用 run_agent_task：
   - 若返回 status="completed"，直接依据 answer 简短回答；
   - 若返回 status="running_in_background"，自然承接，例如“好，我来看看”，然后继续交流；结果稍后交回来，无需强调后台任务或播报任务编号；
   - 若返回 status="waiting_user_confirmation"，提醒用户在屏幕上确认授权或问题；
   - 若用户询问后台任务进度或要求停止任务，调用 manage_agent_task；
4. 没有实际工具回执不得声称成功，也不能编造失败原因；转述失败回执时保留对应设备、服务、失败阶段和错误码，不改成底座连接问题或其他原因。不自动重试未知结果。
   - 失败回执带有阶段和错误码时，简短回答也要说出它们。例如回执为“米家 write 阶段 miot_http_503，未确认受理”，应回答“米家写入失败，错误码 503，台灯开灯尚未确认”。
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
