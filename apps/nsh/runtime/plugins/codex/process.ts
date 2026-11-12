import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { CliReceipt } from "../contracts.js";
import type { LangfuseTracer, TraceContext } from "../../../../../packages/looi-runtime/src/telemetry/langfuse.js";

export interface CliRequest { stage: string; args: string[]; cwd?: string; timeoutMs: number; signal?: AbortSignal; onOutput?: (stream: "stdout" | "stderr", text: string) => void }
export interface CliHandle { id: string; promise: Promise<CliReceipt>; cancel(): void }
export interface CliRunner { run(request: CliRequest): CliHandle; stop(): Promise<void> }

/** The executable is always reached through the App's Linux host, never a Mac CLI. */
export function createCodexRunner(options: {
  directory: string;
  tracer?: LangfuseTracer;
  traceContext?: () => TraceContext | undefined;
  onOutput?: (id: string, stream: "stdout" | "stderr", text: string) => void;
  onFinished?: (receipt: CliReceipt) => void;
}): CliRunner {
  const pending = new Set<CliHandle>();
  return {
    run(request) {
      const id = randomUUID();
      let cancel = () => {};
      const handle: CliHandle = { id, cancel: () => cancel(), promise: undefined as unknown as Promise<CliReceipt> };
      handle.promise = new Promise(resolve => {
        const receipt: CliReceipt = { id, stage: request.stage, args: request.args, state: "not_started", exitCode: null, stdout: "", stderr: "" };
        const observation = options.tracer?.start(request.stage, "tool", options.traceContext?.(), { "langfuse.observation.input": { executable: "/usr/local/bin/codex", args: request.args, cwd: request.cwd } });
        const finish = () => {
          if (receipt.state !== "stop_unconfirmed") pending.delete(handle);
          request.signal?.removeEventListener("abort", abort);
          observation?.end({ "langfuse.observation.output": receipt, ...(receipt.failure || receipt.exitCode !== 0 ? { "langfuse.observation.level": "ERROR" } : {}) });
          options.onFinished?.(receipt);
          resolve(receipt);
        };
        let aborted = false;
        let executionFailed = false;
        const abort = () => { aborted = true; cancel(); };
        try {
          if (String(process.platform) !== "nsh") throw Object.assign(new Error("Codex must run in the App Linux environment"), { code: "ERR_CODEX_GUEST_REQUIRED" });
          fs.mkdirSync(options.directory, { recursive: true });
          receipt.outputFiles = { stdout: path.join(options.directory, `${id}.stdout`), stderr: path.join(options.directory, `${id}.stderr`) };
          fs.writeFileSync(receipt.outputFiles.stdout, "");
          fs.writeFileSync(receipt.outputFiles.stderr, "");
          if (request.signal?.aborted) { receipt.state = "cancelled"; finish(); return; }
          const child = spawn("/usr/local/bin/codex", ["-c", 'cli_auth_credentials_store="file"', ...request.args], {
            cwd: request.cwd ?? "/workspace", stdio: ["ignore", "pipe", "pipe"], timeout: request.timeoutMs,
            env: { CODEX_HOME: "/root/.codex", ...(process.env.LOOI_CODEX_PROXY ? { HTTP_PROXY: process.env.LOOI_CODEX_PROXY, HTTPS_PROXY: process.env.LOOI_CODEX_PROXY, NO_PROXY: "localhost,127.0.0.1,::1" } : {}) },
          });
          const nativeChild = child as typeof child & { timedOut?: boolean; cleanupUnconfirmed?: boolean };
          cancel = () => { aborted = true; child.kill("SIGTERM"); };
          const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
          const append = (stream: "stdout" | "stderr", text: string) => {
            if (!text) return;
            receipt[stream] = (receipt[stream] + text).slice(-16_384);
            try { fs.appendFileSync(receipt.outputFiles![stream], text); }
            catch (error) { receipt.failure = { stage: `${request.stage}.output`, code: (error as NodeJS.ErrnoException).code, reason: String(error) }; }
            request.onOutput?.(stream, text);
            options.onOutput?.(id, stream, text);
          };
          child.stdout?.on("data", chunk => append("stdout", decoders.stdout.write(chunk)));
          child.stderr?.on("data", chunk => append("stderr", decoders.stderr.write(chunk)));
          child.once("error", error => { executionFailed = true; receipt.failure = { stage: request.stage, code: (error as NodeJS.ErrnoException).code, reason: error.message }; });
          child.once("close", (code, signal) => {
            append("stdout", decoders.stdout.end()); append("stderr", decoders.stderr.end());
            receipt.exitCode = code;
            if (signal) receipt.signal = signal;
            receipt.state = nativeChild.cleanupUnconfirmed ? "stop_unconfirmed" : nativeChild.timedOut ? "timed_out" : aborted ? "cancelled" : executionFailed ? "execution_failed" : "exited";
            if (receipt.state !== "exited" && !receipt.failure) receipt.failure = { stage: request.stage, reason: `Codex process ${receipt.state}` };
            if (code !== 0 && !receipt.failure && !/Not logged in/i.test(receipt.stderr)) receipt.failure = { stage: request.stage, code: code ?? undefined, reason: receipt.stderr.trim() || receipt.stdout.trim() || `Codex exited with code ${code}` };
            finish();
          });
          pending.add(handle);
          request.signal?.addEventListener("abort", abort, { once: true });
          if (request.signal?.aborted) abort();
        } catch (error) {
          receipt.state = "start_failed";
          receipt.failure = { stage: request.stage, code: (error as NodeJS.ErrnoException).code, reason: String(error) };
          finish();
        }
      });
      return handle;
    },
    async stop() {
      const current = [...pending]; current.forEach(handle => handle.cancel());
      const receipts = await Promise.all(current.map(handle => handle.promise));
      const unconfirmed = receipts.find(receipt => receipt.state === "stop_unconfirmed");
      if (unconfirmed) throw Object.assign(new Error(unconfirmed.failure?.reason ?? "Codex process exit is unconfirmed"), { code: "ERR_CODEX_STOP_UNCONFIRMED", receipt: unconfirmed });
    },
  };
}
