import fs from "node:fs";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { obj, str } from "@earendil-works/pi-schema";
import { resolveWorkspacePath } from "../workspace-path.js";
import type { WorkspaceToolsHost } from "./types.js";

const writeParams = obj({
  path: str({ description: "File path relative to workspace root" }),
  content: str({ description: "Full UTF-8 text content to write" }),
});

/**
 * Creates `write_file` for sequentially creating or overwriting UTF-8 workspace files.
 */
export function createWriteFileTool(
  host: Pick<WorkspaceToolsHost, "workspaceRoot" | "artifacts">,
): AgentTool<typeof writeParams> {
  return {
    name: "write_file",
    label: "Write File",
    description: "Create or overwrite a UTF-8 file in the workspace.",
    parameters: writeParams,
    executionMode: "sequential",
    execute: async (
      _toolCallId: string,
      params: { path: string; content: string },
    ) => {
      const { resolved } = resolveWorkspacePath(
        host.workspaceRoot,
        params.path,
      );
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, params.content, "utf8");
      host.artifacts.record(resolved);
      return {
        content: [
          {
            type: "text" as const,
            text: `Wrote ${Buffer.byteLength(params.content)} bytes to ${params.path}`,
          },
        ],
        details: { path: params.path },
      };
    },
  };
}
