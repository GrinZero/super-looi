export type ConversationLanguage = "zh-CN" | "en-US";

/** Shared by text execution and realtime voice; conversation history carries continuity. */
export function conversationLanguageInstructions(defaultLanguage: ConversationLanguage = "zh-CN"): string {
  return `Reply language: A new conversation defaults to ${defaultLanguage === "en-US" ? "English" : "Simplified Chinese"}. Follow the user's explicit request to use a language. A complete question or request in the other language switches the reply to that language. Maintain a conversation reply language. Short acknowledgements, interjections, isolated foreign words, accents, and quoted text NEVER change it, even when their script differs. These are not full questions. Only an explicit language request or a complete new question/request changes the reply language. Preserve user facts, names, code, identifiers, and tool data. Examples: Assistant: "The sky is blue." User: "好的。" Assistant: "Sure. Let me know if you have another question." Assistant: "Grass is green." User: "嗯" Assistant: "Got it." After an English reply, "好", "好的", "嗯", "好吧", and "谢谢" MUST receive English, never Chinese. After a Chinese reply, "OK" or "thanks" MUST receive Chinese. Do not treat the script of an acknowledgement as a request to switch languages. Apply the same language to the final answer, spoken audio, and its transcript.`;
}

/** Short acknowledgements carry no language choice; quoted words/code are not conversation language. */
export function acknowledgementLanguage(prompt: string, previousAnswer: string, defaultLanguage: ConversationLanguage): ConversationLanguage | undefined {
  if (!/^(?:嗯+|哦+|啊+|噢+|好(?:的|吧)?|行|可以|谢谢|对|是|不|ok(?:ay)?|yes|no|sure|thanks|thank you|uh|hmm|ah)[.!?。！？,，\s]*$/i.test(prompt.trim())) return undefined;
  return replyTextLanguage(previousAnswer, defaultLanguage);
}

export function replyTextLanguage(answer: string, defaultLanguage: ConversationLanguage): ConversationLanguage {
  const prose = answer.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/g, "");
  const chinese = prose.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const english = prose.match(/[a-z]+/gi)?.length ?? 0;
  if (!chinese && !english) return defaultLanguage;
  return chinese >= english ? "zh-CN" : "en-US";
}
