import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import {
  acknowledgementLanguage,
  conversationLanguageInstructions,
  type ConversationLanguage,
} from "./conversation-language.js";

export const DEFAULT_TASK_ASSISTANT_SYSTEM_PROMPT =
  "You are LOOI’s task assistant. Use real tools to complete tasks and report failures accurately. Do not start background processes or unmanaged jobs.";

export interface AgentTurnPromptInput {
  prompt: string;
  mode?: "voice" | "text";
  defaultLanguage?: ConversationLanguage;
  restoredMessages?: AgentMessage[];
  baseSystemPrompt?: string;
  webSearchEnabled?: boolean;
}

export interface AgentTurnPrompts {
  systemPrompt: string;
  userPrompt: string;
  acknowledgement?: ConversationLanguage;
}

/**
 * Assembles the system prompt and user turn prompt for an Agent task run,
 * enforcing language continuity on short acknowledgements and brevity in voice mode.
 */
export function buildAgentTurnPrompts(
  input: AgentTurnPromptInput,
): AgentTurnPrompts {
  const defaultLanguage = input.defaultLanguage ?? "zh-CN";
  const previousAssistant = [...(input.restoredMessages ?? [])]
    .reverse()
    .find((message) => message.role === "assistant");
  const acknowledgement = acknowledgementLanguage(
    input.prompt,
    previousAssistant?.role === "assistant"
      ? contentText(previousAssistant.content)
      : "",
    defaultLanguage,
  );
  const turnLanguage = acknowledgement
    ? `\nFor this acknowledgement, reply only in ${acknowledgement === "en-US" ? "English" : "Simplified Chinese"}. This maintains the preceding conversation language.`
    : "";

  const baseSystem =
    input.baseSystemPrompt ?? DEFAULT_TASK_ASSISTANT_SYSTEM_PROMPT;
  const systemPrompt =
    baseSystem +
    (input.webSearchEnabled
      ? "\nOpenAI's built-in web_search tool is available. Use it for explicit web searches and questions needing current information. Cite the sources in your answer."
      : "") +
    "\n" +
    conversationLanguageInstructions(defaultLanguage) +
    turnLanguage +
    (input.mode === "voice" ? "\nKeep the final answer brief and natural for speech." : "");

  const modePrefix =
    input.mode === "voice"
      ? "Keep the final answer brief and natural for speech, following the conversation reply language.\n"
      : "";
  const rawUserPrompt = `${modePrefix}${input.prompt}`;
  const userPrompt = acknowledgement
    ? `${rawUserPrompt}\n\nReply in ${acknowledgement === "en-US" ? "English" : "Simplified Chinese"}, continuing the conversation’s language.`
    : rawUserPrompt;

  return {
    systemPrompt,
    userPrompt,
    acknowledgement,
  };
}
