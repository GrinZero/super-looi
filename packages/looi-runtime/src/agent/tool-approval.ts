import fs from "node:fs";
import type { AgentRunOptions } from "./executor.js";
import { resolveWorkspacePath } from "./workspace-path.js";

export interface ToolApprovalContext {
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  sessionId: string;
  workspaceRoot: string;
  approvalMode: NonNullable<AgentRunOptions["approvalMode"]>;
}

/** Return approval details, or undefined to leave only approvalRequiredTools in effect. */
export type ToolApprovalRule = (
  context: ToolApprovalContext,
) => Record<string, unknown> | undefined;

export interface ToolApprovalConfig {
  approvalRequiredTools?: readonly string[];
  requireApprovalForAllWrites?: boolean;
  /** Rules for new tools, or replacements for individual built-in rules. Bypassed in yolo mode. */
  toolApprovalRules?: Readonly<Record<string, ToolApprovalRule>>;
}

const HIGH_RISK_COMMAND = [
  /rm\s+-rf/i,
  /git\s+push\s+.*--force/i,
  /\bdd\b/i,
  /\bmkfs\b/i,
  /\bsudo\b/i,
  />\s*\/dev\//i,
];

const SAFE_SYSTEM_PREFIXES = [
  "/bin/",
  "/usr/bin/",
  "/usr/local/bin/",
  "/opt/homebrew/bin/",
  "/dev/null",
];

function commandTouchesOutsideWorkspace(
  command: string,
  workspaceRoot: string,
): boolean {
  if (/(?:^|[\/\\]|[\s"'=><;|&(`])\.\.(?:[\/\\]|$|[\s"'`;&|>)])/.test(command))
    return true;
  if (/(?:^|[\s"'=><;|&(`])~(?:\/|$|\s)/.test(command)) return true;
  if (/\$HOME\b|\$\{HOME\}/.test(command)) return true;
  if (/\bapk\s+(?:(?:--?[^\s]+)\s+)*(?:add|del|fix|upgrade|update)\b/i.test(command)) return true;
  if (/\b(?:npm|pnpm)\b[^;|&\n]*(?:--global\b|(?:^|\s)-[a-z]*g[a-z]*(?:\s|$))/i.test(command)) return true;
  const matches = command.matchAll(/(?:^|[\s"'=><;|&(`:])(\/[^\s"';|&><)`]+)/g);
  for (const match of matches) {
    const token = match[1];
    if (token === "/dev/null") continue;
    const start = match.index! + match[0].indexOf("/");
    const before = command.slice(0,start).replace(/["']$/, "");
    const executable = /(?:^|[;|&(\n])\s*$/.test(before);
    if (executable && SAFE_SYSTEM_PREFIXES.some(prefix => token.startsWith(prefix))) continue;
    if (!resolveWorkspacePath(workspaceRoot, token).inside) return true;
  }
  return false;
}

function requiresCommandApproval(
  command: string,
  workspaceRoot: string,
): boolean {
  return (
    HIGH_RISK_COMMAND.some((pattern) => pattern.test(command)) ||
    commandTouchesOutsideWorkspace(command, workspaceRoot)
  );
}

/** Build once per executor; rules receive the current task's invocation context. */
export function createToolApprovalPolicy(
  config: ToolApprovalConfig = {},
): ToolApprovalRule {
  const bash: ToolApprovalRule = ({
    arguments: args, approvalMode, workspaceRoot,
  }) => {
    const command = String(args.command ?? "");
    // Strict mode approves every shell invocation, including writes through flags or redirects.
    if (
      (approvalMode === "ask" && config.requireApprovalForAllWrites) ||
      requiresCommandApproval(command, workspaceRoot)
    ) {
      return { operation: "bash", command };
    }
    return undefined;
  };
  const write: ToolApprovalRule = ({
    arguments: args, approvalMode, workspaceRoot,
  }) => {
    const targetPath = String(args.path ?? "");
    const { inside, resolved } = resolveWorkspacePath(workspaceRoot, targetPath);
    if (!inside || (approvalMode === "ask" && config.requireApprovalForAllWrites)) {
      return {
        operation: "write",
        path: targetPath,
        content: String(args.content ?? ""),
        willOverwrite: fs.existsSync(resolved),
      };
    }
    return undefined;
  };
  const read: ToolApprovalRule = ({
    arguments: args, approvalMode, workspaceRoot,
  }) => {
    if (approvalMode !== "ask") return undefined;
    const targetPath = String(args.path ?? "");
    if (!resolveWorkspacePath(workspaceRoot, targetPath).inside) {
      return { operation: "read", path: targetPath };
    }
    return undefined;
  };
  const rules = new Map<string, ToolApprovalRule>(
    Object.entries({
      bash,
      write_file: write,
      write,
      read_file: read,
      read,
      ...config.toolApprovalRules,
    }),
  );
  const requiredTools = new Set(config.approvalRequiredTools);

  return (context) => {
    if (context.approvalMode === "yolo") return undefined;
    const required = requiredTools.has(context.toolName);
    const details = rules.get(context.toolName)?.(context);
    if (!required && !details) return undefined;
    return {
      ...(required ? { arguments: context.arguments } : {}),
      ...details,
      callId: context.callId,
      toolName: context.toolName,
      sessionId: context.sessionId,
    };
  };
}
