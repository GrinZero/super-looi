import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  err,
  ok,
  ExecutionError,
  type ShellExecOptions,
  type Result,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord/context";
import { spawn } from "../shims/child_process.js";
/** Reuses upstream's tested file/line contracts through our Node shims. Shell
 * ownership is native, cooperative and per-command. Output is bounded and
 * delivered after execution; native streaming is a separate host capability. */
export class NshExecutionEnv extends NodeExecutionEnv {
  override id: string;
  private jobs = new Map<ReturnType<typeof spawn>, Promise<void>>();
  constructor(options: { cwd?: string; namespace: string }) {
    super({ cwd: options.cwd ?? "/workspace" });
    this.id = `nsh:${options.namespace}`;
  }
  override async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted)
      return err(new ExecutionError("aborted", "aborted"));
    if (
      options?.timeout !== undefined &&
      (!Number.isFinite(options.timeout) || options.timeout <= 0)
    )
      return err(new ExecutionError("timeout", "Invalid shell timeout"));
    return new Promise((resolve) => {
      const argv =
        typeof command === "string" ? ["sh", "-c", command] : [...command];
      if (!argv.length) {
        resolve(err(new ExecutionError("spawn_error", "Empty command")));
        return;
      }
      let failure: ExecutionError | undefined;
      const child = spawn(argv[0], argv.slice(1), {
        cwd: options?.cwd ?? this.cwd,
        env: options?.env,
        timeout: options?.timeout ? options.timeout * 1000 : 1000,
        signal: context.abortSignal,
      });
      this.jobs.set(
        child,
        new Promise<void>((done) => child.once("close", () => done())),
      );
      const output = (stream: "stdout" | "stderr") => (data: Buffer) => {
        try {
          options?.onOutput?.(data.toString(), context, { stream });
        } catch (error) {
          failure = new ExecutionError("callback_error", String(error));
          child.kill();
        }
      };
      child.stdout.on("data", output("stdout"));
      child.stderr.on("data", output("stderr"));
      child.on("error", (error: Error) => {
        failure = new ExecutionError(
          error.message.includes("ETIMEDOUT") ? "timeout" : "spawn_error",
          error.message,
          error,
        );
      });
      child.on("close", (status: number | null, signal: string | null) => {
        this.jobs.delete(child);
        resolve(
          failure
            ? err(failure)
            : signal
              ? err(new ExecutionError("aborted", "shell cancelled"))
              : ok({ exitCode: status ?? 1 }),
        );
      });
    });
  }
  override async cleanup(context: Context) {
    const pending = [...this.jobs.values()];
    for (const job of this.jobs.keys()) job.kill();
    await Promise.all(pending);
    await super.cleanup(context);
  }
}
