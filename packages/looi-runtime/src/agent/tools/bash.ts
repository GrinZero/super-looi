import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { obj, str } from "@earendil-works/pi-schema";
import { utf8Tail } from "../shell-output.js";
import type { WorkspaceToolsHost } from "./types.js";

const STREAM_TAIL_BYTES = 4096;

const bashParams = obj({
  command: str({ description: "Shell command to execute in workspace" }),
});

/**
 * Creates `bash` for sequential shell execution with process-group termination,
 * bounded 4 KiB UTF-8 stdout/stderr tail capture, and artifact scanning.
 */
export function createBashTool(
  host: Pick<
    WorkspaceToolsHost,
    | "taskId"
    | "workspaceRoot"
    | "commandTimeoutMs"
    | "artifacts"
    | "executions"
    | "pendingShell"
    | "killShells"
    | "isStopped"
    | "onShellOutput"
  >,
): AgentTool<typeof bashParams> {
  return {
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
}
