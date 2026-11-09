import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import type {
  AgentCommandEvidence,
  AgentInteractionAnswer,
  AgentRunOptions,
} from "./executor.js";
import { utf8Tail } from "./shell-output.js";
import { resolveWorkspacePath } from "./workspace-path.js";

const STREAM_TAIL_BYTES = 4096;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

export interface WorkspaceArtifact {
  path: string;
  sha256: string;
  size: number;
}

/**
 * Tracks workspace files touched or produced during a task run, verifying
 * workspace containment, symlink validity, and SHA-256 content digests.
 */
export class WorkspaceArtifactTracker {
  private readonly artifacts = new Map<string, WorkspaceArtifact>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly taskStartMs: number,
  ) {}

  record(absPath: string, onlyIfRecent = false): void {
    let entry: fs.Stats;
    try {
      entry = fs.lstatSync(absPath);
    } catch (error) {
      if (
        ["ENOENT", "ENOTDIR", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        return;
      }
      throw error;
    }
    if (entry.isSymbolicLink()) {
      try {
        (fs.realpathSync.native ?? fs.realpathSync)(absPath);
      } catch (error) {
        if (
          ["EACCES", "ENOENT", "ENOTDIR"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        ) {
          return;
        }
        throw error;
      }
    }
    const { inside, relative } = resolveWorkspacePath(
      this.workspaceRoot,
      absPath,
    );
    if (!inside) return;
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) return;
    if (onlyIfRecent && stat.mtimeMs < this.taskStartMs - 50) return;
    const buf = fs.readFileSync(absPath);
    this.artifacts.set(relative, {
      path: relative,
      sha256: createHash("sha256").update(buf).digest("hex"),
      size: buf.byteLength,
    });
  }

  scanRecentTopLevel(): void {
    try {
      for (const entry of fs.readdirSync(this.workspaceRoot)) {
        this.record(path.join(this.workspaceRoot, entry), true);
      }
    } catch {
      // ignore workspace scan errors
    }
  }

  list(): WorkspaceArtifact[] {
    return [...this.artifacts.values()];
  }
}

export interface WorkspaceToolsHost {
  taskId: string;
  sessionId: string;
  workspaceRoot: string;
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

/**
 * Builds the built-in workspace coding and interaction tools (`read_file`, `read`,
 * `write_file`, `bash`, `ask_user_question`) plus optional host-supplied tools.
 */
export function createWorkspaceCodingTools(
  host: WorkspaceToolsHost,
): AgentTool<any>[] {
  const readParams = obj({
    path: str({ description: "File path relative to workspace root" }),
  });

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

  const writeParams = obj({
    path: str({ description: "File path relative to workspace root" }),
    content: str({ description: "Full UTF-8 text content to write" }),
  });

  const executeWrite = async (
    _toolCallId: string,
    params: { path: string; content: string },
  ) => {
    const { resolved } = resolveWorkspacePath(host.workspaceRoot, params.path);
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
  };

  const writeFileTool: AgentTool<typeof writeParams> = {
    name: "write_file",
    label: "Write File",
    description: "Create or overwrite a UTF-8 file in the workspace.",
    parameters: writeParams,
    executionMode: "sequential",
    execute: executeWrite,
  };

  const bashParams = obj({
    command: str({ description: "Shell command to execute in workspace" }),
  });

  const bashTool: AgentTool<typeof bashParams> = {
    name: "bash",
    label: "Run Shell Command",
    description:
      "Execute a foreground command in the workspace. NSH ARM64 mobile uses Alpine Linux /bin/sh with BusyBox base commands. Additional tools can be installed with apk and persist across restarts; Git, Python, Node, pnpm, ripgrep and fd are not preinstalled. System package changes require approval. Use dedicated tools for device capabilities.",
    parameters: bashParams,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => {
      host.pendingShell.add(toolCallId);
      return new Promise((resolve, reject) => {
        const child = spawn("/bin/sh", ["-c", params.command], {
          cwd: host.workspaceRoot,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: host.commandTimeoutMs,
        });
        let stdout = "";
        let stderr = "";
        let aborted = false;
        let timedOut = false;
        const decoders = {
          stdout: new StringDecoder("utf8"),
          stderr: new StringDecoder("utf8"),
        };
        const output = (
          stream: "stdout" | "stderr" | "status",
          chunk: string,
        ) => {
          if (!chunk) return;
          if (stream === "stdout") {
            stdout = utf8Tail(stdout + chunk, STREAM_TAIL_BYTES);
          }
          if (stream === "stderr") {
            stderr = utf8Tail(stderr + chunk, STREAM_TAIL_BYTES);
          }
          host.onShellOutput?.({
            taskId: host.taskId,
            callId: toolCallId,
            command: params.command,
            stream,
            chunk,
          });
        };
        output("status", "@looi:shellCommandRunning");
        const terminateChild = () => {
          if (child.pid && process.platform !== "win32") {
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {}
          }
          child.kill("SIGTERM");
        };
        const killChild = () => {
          aborted = true;
          terminateChild();
        };
        // The NSH host owns its timeout and cleanup. Node does not expose a
        // timeout flag, so retain the corresponding deadline on desktop.
        const timeout =
          String(process.platform) === "nsh"
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                terminateChild();
              }, host.commandTimeoutMs);
        host.killShells.add(killChild);
        if (signal?.aborted || host.isStopped()) killChild();
        signal?.addEventListener("abort", killChild, { once: true });
        child.stdout?.on("data", (chunk: Buffer) =>
          output("stdout", decoders.stdout.write(chunk)),
        );
        child.stderr?.on("data", (chunk: Buffer) =>
          output("stderr", decoders.stderr.write(chunk)),
        );
        child.on("status", (chunk: string) => output("status", chunk));

        let spawnError: Error | undefined;
        child.once("error", (err) => {
          spawnError = err;
        });

        child.once("close", (code, sig) => {
          if (timeout) clearTimeout(timeout);
          output("stdout", decoders.stdout.end());
          output("stderr", decoders.stderr.end());
          timedOut =
            (child as typeof child & { timedOut?: boolean }).timedOut ??
            timedOut;
          const cleanupUnconfirmed = (
            child as typeof child & { cleanupUnconfirmed?: boolean }
          ).cleanupUnconfirmed;
          output(
            "status",
            cleanupUnconfirmed
              ? "@looi:shellCleanupUnconfirmed"
              : timedOut
                ? "@looi:shellCommandTimedOut"
                : aborted
                  ? "@looi:shellCommandCancelled"
                  : "@looi:shellCommandFinished",
          );
          signal?.removeEventListener("abort", killChild);
          host.killShells.delete(killChild);
          if (!cleanupUnconfirmed) {
            host.pendingShell.delete(toolCallId);
          }

          host.executions.push({
            callId: toolCallId,
            command: params.command,
            exitCode: code,
            signal: sig,
            timedOut,
            aborted,
            stdout,
            stderr,
          });

          host.artifacts.scanRecentTopLevel();

          child.stdout?.removeAllListeners();
          child.stderr?.removeAllListeners();
          child.stdout?.destroy();
          child.stderr?.destroy();
          if (spawnError) {
            reject(spawnError);
            return;
          }
          if (aborted) {
            reject(new Error("Command aborted"));
            return;
          }

          const payload = JSON.stringify({
            exitCode: code ?? 0,
            signal: sig,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          });

          resolve({
            content: [{ type: "text" as const, text: payload }],
            details: { exitCode: code, signal: sig, stdout, stderr },
            isError: code !== 0,
          });
        });
      });
    },
  };

  const askUserParams = obj({
    questions: arr(
      obj({
        id: str({ description: "Unique question identifier" }),
        question: str({ description: "Question text for the user" }),
        options: opt(
          arr(
            obj({ label: str({ description: "Selectable option label" }) }),
          ),
        ),
      }),
    ),
  });

  const askUserQuestionTool: AgentTool<typeof askUserParams> = {
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

  return [
    readFileTool,
    readAliasTool,
    writeFileTool,
    bashTool,
    askUserQuestionTool,
    ...(host.additionalTools ?? []),
  ];
}
