export type ConversationLanguage = "zh-CN" | "en-US";

/** Shared by text execution and realtime voice; conversation history carries continuity. */
export function conversationLanguageInstructions(defaultLanguage: ConversationLanguage = "zh-CN"): string {
  return `Reply language: A new conversation defaults to ${defaultLanguage === "en-US" ? "English" : "Simplified Chinese"}. Follow the user's explicit request to use a language. A complete question or request in the other language switches the reply to that language. Short acknowledgements, interjections, isolated foreign words, accents, and quoted text do not switch the language: keep the most recently used conversation language. Preserve user facts, names, code, identifiers, and tool data. Examples: after an English reply, the user saying "嗯", "好吧", or "谢谢" still receives an English reply; after a Chinese reply, "OK" or "thanks" still receives Chinese. Apply the same language to the final answer, spoken audio, and its transcript.`;
}

/** Short acknowledgements carry no language choice; quoted words/code are not conversation language. */
export function acknowledgementLanguage(prompt: string, previousAnswer: string, defaultLanguage: ConversationLanguage): ConversationLanguage | undefined {
  if (!/^(?:嗯+|哦+|啊+|噢+|好(?:的|吧)?|行|可以|谢谢|对|是|不|ok(?:ay)?|yes|no|sure|thanks|thank you|uh|hmm|ah)[.!?。！？,，\s]*$/i.test(prompt.trim())) return undefined;
  const prose = previousAnswer.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/g, "");
  const chinese = prose.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const english = prose.match(/[a-z]+/gi)?.length ?? 0;
  if (!chinese && !english) return defaultLanguage;
  return chinese >= english ? "zh-CN" : "en-US";
}
