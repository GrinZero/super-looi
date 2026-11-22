import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspacePath } from "../agent/governance/workspace-path.js";
import type { ScheduleExecutionPolicy } from "./types.js";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Mirrors `pi-coding-agent`'s `resolveToCwd` / `normalizePath` preprocessing so
 * `@`, `~`, Unicode spaces, and `file://` URLs cannot disguise an external path.
 */
function normalizePolicyTargetPath(rawPath: string): string {
  let normalized = rawPath.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  const home = homedir();
  if (normalized === "~") {
    return home;
  }
  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return path.join(home, normalized.slice(2));
  }
  if (/^file:\/\//i.test(normalized)) {
    return fileURLToPath(normalized);
  }
  return normalized;
}

/** Exact allowlist of tools callable under `check_only` scheduled execution. */
export const CHECK_ONLY_ALLOWED_TOOLS = [
  "read",
  "read_file",
  "ls",
  "find",
  "grep",
  "sessions",
  "web_search",
  "list_home_devices",
  "github_pr_status",
  "codex_cloud_status",
  "schedule_report",
  "manage_schedule",
] as const;

const CHECK_ONLY_TOOL_SET = new Set<string>(CHECK_ONLY_ALLOWED_TOOLS);

const WORKSPACE_PATH_SCOPED_TOOLS = new Set<string>([
  "read",
  "read_file",
  "ls",
  "find",
  "grep",
]);

const NON_SIDE_EFFECT_TOOLS = new Set<string>([
  ...CHECK_ONLY_ALLOWED_TOOLS,
  "ask_user_question",
  "tool_search",
  "manage_quiet_hours",
]);

export type ScheduledToolPolicyDecision =
  | { readonly decision: "allow"; readonly sideEffect: boolean }
  | {
      readonly decision: "deny";
      readonly stage: "schedule.policy";
      readonly code: "ERR_SCHEDULE_CHECK_ONLY_TOOL_DENIED";
      readonly reason: string;
    };

export function isCheckOnlyAllowedToolName(toolName: string): boolean {
  return CHECK_ONLY_TOOL_SET.has(toolName);
}

/**
 * Returns true if executing the given tool call may mutate workspace, host,
 * external services, or schedule state. Used under `authorized_action` to
 * record `sideEffectDispatched` synchronously before execution begins.
 */
export function isSideEffectToolCall(
  toolName: string,
  args: Record<string, unknown> = {},
): boolean {
  if (toolName === "manage_schedule" || toolName === "manage_quiet_hours") {
    return args.action !== "list";
  }
  return !NON_SIDE_EFFECT_TOOLS.has(toolName);
}

function denyCheckOnly(reason: string): ScheduledToolPolicyDecision {
  return {
    decision: "deny",
    stage: "schedule.policy",
    code: "ERR_SCHEDULE_CHECK_ONLY_TOOL_DENIED",
    reason,
  };
}

/**
 * Layer 2 fail-closed `tool_call` policy gate for scheduled runs.
 * Under `check_only`, only `CHECK_ONLY_ALLOWED_TOOLS` within `workspaceRoot`
 * (and `manage_schedule` with `action === "list"`) are allowed; everything else
 * is denied without prompting the user for approval.
 */
export function evaluateScheduledToolPolicy(context: {
  policy: ScheduleExecutionPolicy;
  toolName: string;
  arguments: Record<string, unknown>;
  workspaceRoot: string;
}): ScheduledToolPolicyDecision {
  if (context.policy === "authorized_action") {
    return {
      decision: "allow",
      sideEffect: isSideEffectToolCall(context.toolName, context.arguments),
    };
  }

  if (!CHECK_ONLY_TOOL_SET.has(context.toolName)) {
    return denyCheckOnly(
      `Tool "${context.toolName}" is not allowed under check_only schedule policy`,
    );
  }

  if (context.toolName === "manage_schedule") {
    if (context.arguments?.action !== "list") {
      return denyCheckOnly(
        `manage_schedule action "${String(context.arguments?.action ?? "")}" is denied under check_only schedule policy; only "list" is permitted`,
      );
    }
    return { decision: "allow", sideEffect: false };
  }

  if (WORKSPACE_PATH_SCOPED_TOOLS.has(context.toolName)) {
    const rawPath = context.arguments?.path;
    const requiresExplicitPath =
      context.toolName === "read" || context.toolName === "read_file";
    if (rawPath === undefined) {
      if (requiresExplicitPath) {
        return denyCheckOnly(
          `${context.toolName} requires a workspace-relative path under check_only schedule policy`,
        );
      }
      return { decision: "allow", sideEffect: false };
    }
    if (typeof rawPath !== "string" || (requiresExplicitPath && !rawPath.trim())) {
      return denyCheckOnly(
        `${context.toolName} received an invalid path under check_only schedule policy`,
      );
    }
    const checkTarget = rawPath.trim() === "" ? "." : rawPath;
    try {
      const normalizedTarget = normalizePolicyTargetPath(checkTarget);
      const resolved = resolveWorkspacePath(context.workspaceRoot, normalizedTarget);
      if (!resolved.inside) {
        return denyCheckOnly(
          `Path "${rawPath}" escapes workspaceRoot under check_only schedule policy`,
        );
      }
    } catch (error) {
      return denyCheckOnly(
        `Path "${rawPath}" could not be verified inside workspaceRoot: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { decision: "allow", sideEffect: false };
}
