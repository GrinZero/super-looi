import type { AgentTool } from "@earendil-works/pi-agent-core";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import type { WorkspaceToolsHost } from "./types.js";

const askUserParams = obj({
  questions: arr(
    obj({
      id: str({ description: "Unique question identifier" }),
      question: str({ description: "Question text for the user" }),
      options: opt(
        arr(obj({ label: str({ description: "Selectable option label" }) })),
      ),
    }),
  ),
});

/**
 * Creates `ask_user_question` for suspending the task until the user answers
 * one or more structured questions.
 */
export function createAskUserQuestionTool(
  host: Pick<WorkspaceToolsHost, "askUserQuestion">,
): AgentTool<typeof askUserParams> {
  return {
    name: "ask_user_question",
    label: "Ask User Question",
    description:
      "Ask the user one or more structured questions and wait for their answer.",
    parameters: askUserParams,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => {
      const answer = await host.askUserQuestion(
        toolCallId,
        params.questions,
        signal,
      );
      if ("cancelled" in answer && answer.cancelled) {
        throw new Error("User question was cancelled");
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(answer) }],
        details: answer,
      };
    },
  };
}
