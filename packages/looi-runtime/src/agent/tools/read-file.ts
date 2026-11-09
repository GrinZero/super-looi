import fs from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { obj, str } from "@earendil-works/pi-schema";
import { resolveWorkspacePath } from "../workspace-path.js";
import type { WorkspaceToolsHost } from "./types.js";

const readParams = obj({
  path: str({ description: "File path relative to workspace root" }),
});

/**
 * Creates `read_file` and its `read` alias for reading UTF-8 workspace files.
 */
export function createReadFileTools(
  host: Pick<WorkspaceToolsHost, "workspaceRoot" | "artifacts">,
): [AgentTool<typeof readParams>, AgentTool<typeof readParams>] {
  const executeRead = async (_toolCallId: string, params: { path: string }) => {
    const { resolved } = resolveWorkspacePath(host.workspaceRoot, params.path);
    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${params.path}`);
    }
    const content = fs.readFileSync(resolved, "utf8");
    host.artifacts.record(resolved);
    return {
      content: [{ type: "text" as const, text: content }],
      details: { path: params.path, size: content.length },
    };
  };

  const readFileTool: AgentTool<typeof readParams> = {
    name: "read_file",
    label: "Read File",
    description: "Read UTF-8 text content of a file in the workspace.",
    parameters: readParams,
    execute: executeRead,
  };

  const readAliasTool: AgentTool<typeof readParams> = {
    name: "read",
    label: "Read File",
    description:
      "Alias of read_file: read UTF-8 text content of a file in the workspace.",
    parameters: readParams,
    execute: executeRead,
  };

  return [readFileTool, readAliasTool];
}
