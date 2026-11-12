import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  AgentCommandEvidence,
  AgentInteractionAnswer,
  AgentRunOptions,
} from "../executor.js";
import type { WorkspaceArtifactTracker } from "./artifact-tracker.js";

export interface WorkspaceArtifact {
  path: string;
  sha256: string;
  size: number;
}

export interface WorkspaceToolsHost {
  taskId: string;
  sessionId: string;
  workspaceRoot: string;
  sessionsDirectory: string;
  commandTimeoutMs: number;
  artifacts: WorkspaceArtifactTracker;
  executions: AgentCommandEvidence[];
  pendingShell: Set<string>;
  killShells: Set<() => void>;
  isStopped: () => boolean;
  onShellOutput?: AgentRunOptions["onShellOutput"];
  askUserQuestion: (
    requestId: string,
    questions: Array<{
      id: string;
      question: string;
      options?: Array<{ label: string }>;
    }>,
    signal?: AbortSignal,
  ) => Promise<AgentInteractionAnswer>;
  additionalTools?: AgentTool<any>[];
}
