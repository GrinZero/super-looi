import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createAskUserQuestionTool } from "./ask-user-question.js";
import { createBashTool } from "./bash.js";
import { createReadFileTools } from "./read-file.js";
import type { WorkspaceToolsHost } from "./types.js";
import { createWriteFileTool } from "./write-file.js";

export { WorkspaceArtifactTracker } from "./artifact-tracker.js";
export { createAskUserQuestionTool } from "./ask-user-question.js";
export { createBashTool } from "./bash.js";
export { createReadFileTools } from "./read-file.js";
export { createWriteFileTool } from "./write-file.js";
export type { WorkspaceArtifact, WorkspaceToolsHost } from "./types.js";

/**
 * Builds the built-in workspace coding and interaction tools (`read_file`, `read`,
 * `write_file`, `bash`, `ask_user_question`) plus optional host-supplied tools.
 */
export function createWorkspaceCodingTools(
  host: WorkspaceToolsHost,
): AgentTool<any>[] {
  const [readFileTool, readAliasTool] = createReadFileTools(host);
  const writeFileTool = createWriteFileTool(host);
  const bashTool = createBashTool(host);
  const askUserQuestionTool = createAskUserQuestionTool(host);

  return [
    readFileTool,
    readAliasTool,
    writeFileTool,
    bashTool,
    askUserQuestionTool,
    ...(host.additionalTools ?? []),
  ];
}
