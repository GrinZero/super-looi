import type { AgentTool } from "@earendil-works/pi-agent-core";

export interface CliReceipt {
  id: string;
  stage: string;
  args: string[];
  state: "not_started" | "exited" | "start_failed" | "execution_failed" | "cancelled" | "timed_out" | "stop_unconfirmed";
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  outputFiles?: { stdout: string; stderr: string };
  failure?: PluginFailure;
}
export interface PluginFailure { stage: string; code?: string | number; reason: string }
export interface PluginSnapshot {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  lifecycle: "registered" | "starting" | "active" | "stopping" | "stopped" | "failed";
  configuration: Record<string, string>;
  version?: string;
  auth?: {
    state: "signed_out" | "authorizing" | "signed_in" | "reauth_required" | "unavailable";
    sessionId?: string;
    accountLabel?: string;
    url?: string;
  };
  lastExecution?: CliReceipt;
  lastError?: PluginFailure;
}
export type PluginEvent =
  | { type: "state_changed"; pluginId: string; snapshot: PluginSnapshot }
  | { type: "auth_challenge"; pluginId: string; sessionId: string; url: string }
  | { type: "execution_output"; pluginId: string; callId: string; stream: "stdout" | "stderr"; text: string }
  | { type: "execution_finished"; pluginId: string; receipt: CliReceipt };
export interface PluginTaskContext {
  taskId: string;
  workspaceRoot: string;
  approvalMode: "ask" | "local_auto" | "yolo";
  commandTimeoutMs: number;
}
export interface PluginRuntime {
  snapshot(): PluginSnapshot;
  start(): Promise<void>;
  stop(reason: "disabled" | "app_shutdown"): Promise<void>;
  configure(values: Record<string, string>): Promise<void>;
  tools(context: PluginTaskContext): AgentTool<any>[];
  readonly skillPaths?: readonly string[];
  readonly auth?: {
    begin(): Promise<{ sessionId: string }>;
    cancel(): Promise<void>;
    logout(): Promise<void>;
    refresh(): Promise<void>;
  };
}
export interface PluginDefinition {
  id: string;
  create(context: {
    enabled: () => boolean;
    configuration: Record<string, string>;
    publish(event: PluginEvent): void;
  }): PluginRuntime;
}
