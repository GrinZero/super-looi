import { randomUUID } from "node:crypto";
import type { AgentSession, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AgentInteractionAnswer } from "../executor.js";

/** Map Pi's portable dialogs to the App's existing interaction surface. */
export function createPiExtensionUi(session: AgentSession, host: {
  interact: (kind: "approval" | "question", details: Record<string, unknown>, signal?: AbortSignal) => Promise<AgentInteractionAnswer>;
  notify: (message: string, level?: "info" | "warning" | "error") => void;
}): ExtensionUIContext {
  const question = async (title: string, choices?: string[], signal?: AbortSignal) => {
    const id = randomUUID();
    const answer = await host.interact("question", {
      questions: [{
        id, question: title,
        ...(choices ? { options: choices.map(label => ({ label })) } : {}),
      }]
    }, signal);
    if (!("answers" in answer)) return undefined;
    const value = answer.answers.find(item => item.id === id);
    return value?.custom ?? value?.selected[0];
  };
  return {
    ...session.extensionRunner.createContext().ui,
    select: (title, choices, options) => question(title, choices, options?.signal),
    input: (title, placeholder, options) => question(placeholder ? `${title}\n${placeholder}` : title, undefined, options?.signal),
    editor: (title, prefill) => question(prefill ? `${title}\n${prefill}` : title),
    confirm: async (title, message, options) => {
      const answer = await host.interact("approval", { operation: "extension", title, message }, options?.signal);
      return "outcome" in answer && answer.outcome === "allowed-once";
    },
    notify: host.notify,
    setStatus: (_key, message) => { if (message) host.notify(message); },
    setWorkingMessage: (message) => { if (message) host.notify(message); },
    custom: async () => { throw new Error("Pi extension custom terminal UI is unavailable in NSH; native select, confirm and input are available."); },
  };
}
