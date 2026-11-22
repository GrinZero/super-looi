import type { AgentTool } from "@earendil-works/pi-agent-core";
import { isCheckOnlyAllowedToolName } from "../../schedule/check-policy.js";
import { createAskUserQuestionTool } from "./ask-user-question.js";
import { createBashTool } from "./bash.js";
import { createSessionsTool } from "./sessions.js";
import type { WorkspaceToolsHost } from "./types.js";

export { WorkspaceArtifactTracker } from "./artifact-tracker.js";
export { createAskUserQuestionTool } from "./ask-user-question.js";
export { createBashTool } from "./bash.js";
export { createSessionsTool } from "./sessions.js";
export type { WorkspaceArtifact, WorkspaceToolsHost } from "./types.js";

/**
 * App tools augment Pi's standard file tools; bash binds the native Shell host.
 * Under `check_only` schedule policy, `bash`, `ask_user_question`, and any
 * non-allowlisted tools are omitted from registration.
 */
export function createWorkspaceCodingTools(
  host: WorkspaceToolsHost,
): AgentTool<any>[] {
  if (host.scheduleExecutionPolicy === "check_only") {
    return [
      createSessionsTool(host),
      ...(host.additionalTools ?? []).filter((tool) =>
        isCheckOnlyAllowedToolName(tool.name),
      ),
    ];
  }

  const bashTool = createBashTool(host);
  const askUserQuestionTool = createAskUserQuestionTool(host);

  return [
    bashTool,
    askUserQuestionTool,
    createSessionsTool(host),
    ...(host.additionalTools ?? []),
  ];
}
