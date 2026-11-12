import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { obj, str, opt, int } from "@earendil-works/pi-schema";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CliReceipt, PluginDefinition, PluginEvent, PluginFailure, PluginRuntime, PluginSnapshot, PluginTaskContext } from "../contracts.js";
import { createCodexRunner, type CliHandle, type CliRunner } from "./process.js";
import type { LangfuseTracer, TraceContext } from "../../../../../packages/looi-runtime/src/telemetry/langfuse.js";

const SKILL = `---
name: codex
description: Delegate natural-language tasks to the bundled Codex agent or start Codex Cloud tasks directly.
---
Use codex_exec for natural-language work: investigate, create or configure a cloud environment, plan steps, or continue a Codex session. Include the returned sessionId to continue; Cloud task IDs are different from session IDs.
Use codex_cloud when the goal is directly starting a remote coding task in an existing environment. It returns an accepted task ID and URL, not the completed coding result. Use codex_exec with that task ID to inspect progress or results later. Do not submit the same goal again if Codex has already submitted it.
Both tools use the App's own Linux CLI and Codex login. Account setup is on the Plugins page. Respect actual execution failures and include their stage and provider reason. Full CLI output is available at the receipt's outputFiles paths.
`;
const execParams = obj({ prompt: str({ description: "Natural-language task for the Codex agent" }), sessionId: opt(str({ description: "Codex session ID to continue, not a Cloud task ID" })), cwd: opt(str({ description: "App Linux working directory" })) });
const cloudParams = obj({ prompt: str({ description: "Coding task to start in Codex Cloud" }), environment: opt(str({ description: "Cloud environment ID or unique name; defaults to plugin setting" })), branch: opt(str({ description: "Git branch; defaults to plugin setting" })), attempts: opt(int({ description: "Number of Cloud attempts, 1–4", minimum: 1, maximum: 4 })) });
const result = (value: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value, isError });
const plain = (text: string) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
const succeeded = (receipt: CliReceipt) => receipt.state === "exited" && receipt.exitCode === 0 && !receipt.failure;

export function codexDefinition(options: { directory?: string; tracer?: LangfuseTracer; traceContext?: () => TraceContext | undefined; runner?: CliRunner } = {}): PluginDefinition {
  return { id: "codex", create: context => new CodexPlugin({ ...context, ...options }) };
}

/** One instance owns both tools, official account operations, and CLI processes. */
export class CodexPlugin implements PluginRuntime {
  private state: Omit<PluginSnapshot, "enabled">;
  private readonly runner: CliRunner;
  readonly skillPaths: string[];
  private starting?: Promise<void>;
  private accountQueue: Promise<unknown> = Promise.resolve();
  private login?: { id: string; handle: CliHandle; done: Promise<void>; cancelled: boolean };
  private closed = false;
  private changingAccount = false;
  private stopFailure?: PluginFailure;
  readonly auth = {
    begin: () => this.account(() => this.beginLogin()),
    cancel: () => this.account(() => this.endLogin()),
    logout: () => this.account(() => this.logout()),
    refresh: () => this.account(async () => { await this.start(); if (!this.login) await this.readAccount(); }),
  };
  constructor(private readonly options: { enabled: () => boolean; configuration: Record<string, string>; publish(event: PluginEvent): void; directory?: string; tracer?: LangfuseTracer; traceContext?: () => TraceContext | undefined; runner?: CliRunner }) {
    const directory = options.directory ?? "/home/agent/plugins/codex";
    fs.mkdirSync(directory, { recursive: true });
    const skillDirectory = path.join(directory, "skill");
    fs.mkdirSync(skillDirectory, { recursive: true });
    const skillPath = path.join(skillDirectory, "SKILL.md");
    fs.writeFileSync(skillPath, SKILL);
    this.skillPaths = [skillPath];
    this.state = { id: "codex", name: "Codex", description: "Codex EXEC · Codex Cloud", lifecycle: "registered", configuration: { environment: "video2rig", branch: "main", ...options.configuration }, auth: { state: "signed_out" } };
    this.runner = options.runner ?? createCodexRunner({ directory: path.join(directory, "executions"), tracer: options.tracer, traceContext: options.traceContext,
      onOutput: (callId, stream, text) => options.publish({ type: "execution_output", pluginId: "codex", callId, stream, text }),
      onFinished: receipt => { this.checkCleanup(receipt); this.update({ lastExecution: receipt }); options.publish({ type: "execution_finished", pluginId: "codex", receipt }); },
    });
  }
  snapshot(): PluginSnapshot { return structuredClone({ ...this.state, enabled: this.options.enabled() }); }
  private update(patch: Partial<typeof this.state>) { this.state = { ...this.state, ...patch }; this.options.publish({ type: "state_changed", pluginId: "codex", snapshot: this.snapshot() }); }
  private account<T>(run: () => Promise<T>): Promise<T> { const next = this.accountQueue.then(run, run); this.accountQueue = next.catch(() => {}); return next; }
  private checkCleanup(receipt: CliReceipt) {
    if (receipt.state !== "stop_unconfirmed") return;
    this.stopFailure = receipt.failure ?? { stage: receipt.stage, code: "ERR_CODEX_STOP_UNCONFIRMED", reason: "Codex process exit is unconfirmed" };
    this.update({ lifecycle: "failed", lastExecution: receipt, lastError: this.stopFailure });
  }
  private assertCleanup() { if (this.stopFailure) throw Object.assign(new Error(this.stopFailure.reason), { code: this.stopFailure.code }); }
  async configure(configuration: Record<string, string>) { this.update({ configuration: { environment: configuration.environment?.trim() ?? this.state.configuration.environment, branch: configuration.branch?.trim() ?? this.state.configuration.branch } }); }
  start(): Promise<void> {
    if (this.stopFailure) return Promise.reject(Object.assign(new Error(this.stopFailure.reason), { code: this.stopFailure.code }));
    if (this.closed) return Promise.reject(new Error("Codex plugin is closed"));
    if (!this.options.enabled()) return Promise.resolve();
    if (this.state.lifecycle === "active") return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.update({ lifecycle: "starting", lastError: undefined });
      const receipt = await this.runner.run({ stage: "codex.version", args: ["--version"], timeoutMs: 60_000 }).promise;
      this.checkCleanup(receipt);
      if (!succeeded(receipt)) { this.update({ lifecycle: "failed", lastError: receipt.failure ?? { stage: "codex.version", reason: receipt.stderr || receipt.stdout } }); return; }
      this.update({ version: plain(receipt.stdout).trim().replace(/^codex-cli\s+/, "") });
      if (this.closed || !this.options.enabled()) return;
      await this.readAccount();
      if (!this.closed && !this.stopFailure) this.update({ lifecycle: "active" });
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async readAccount() {
    if (this.closed || this.stopFailure) return;
    const receipt = await this.runner.run({ stage: "codex.account", args: ["login", "status"], timeoutMs: 60_000 }).promise;
    this.checkCleanup(receipt);
    if (this.closed) return;
    if (succeeded(receipt)) this.update({ auth: { state: "signed_in", accountLabel: plain(receipt.stderr || receipt.stdout).trim() }, lastError: undefined });
    else if (receipt.state === "exited" && receipt.exitCode === 1 && /Not logged in/i.test(receipt.stderr + receipt.stdout)) this.update({ auth: { state: "signed_out" }, lastError: undefined });
    else this.update({ auth: { state: "unavailable" }, lastError: receipt.failure ?? { stage: "codex.account", reason: receipt.stderr || receipt.stdout } });
  }
  private async beginLogin(): Promise<{ sessionId: string }> {
    if (!this.options.enabled() || this.closed) throw new Error("Codex plugin is disabled");
    if (this.login) return { sessionId: this.login.id };
    await this.start();
    if (!this.options.enabled() || this.closed) throw new Error("Codex plugin is disabled");
    if (this.state.lifecycle !== "active") throw new Error(this.state.lastError?.reason ?? "Codex could not start");
    const id = randomUUID();
    this.update({ auth: { state: "authorizing", sessionId: id }, lastError: undefined });
    let output = "";
    let publishedUrl = "";
    const handle = this.runner.run({ stage: "codex.login", args: ["login"], timeoutMs: 16 * 60_000,
      onOutput: (_stream, text) => {
        if (this.login?.id !== id || this.login.cancelled || this.closed || !this.options.enabled()) return;
        output = (output + text).slice(-32_768);
        const url = plain(output).match(/https:\/\/(?:auth\.openai\.com|chatgpt\.com)\/[^\s\u001b]+(?=\s)/)?.[0];
        if (url && url !== publishedUrl && !this.closed) {
          publishedUrl = url;
          this.update({ auth: { state: "authorizing", sessionId: id, url } });
          this.options.publish({ type: "auth_challenge", pluginId: "codex", sessionId: id, url });
        }
      },
    });
    const session = { id, handle, done: Promise.resolve(), cancelled: false };
    this.login = session;
    session.done = handle.promise.then(async receipt => {
      this.checkCleanup(receipt);
      if (this.closed || this.login !== session) return;
      await this.readAccount();
      if (this.login !== session || this.closed) return;
      this.update({ lastExecution: receipt });
      if (!succeeded(receipt) && receipt.state !== "cancelled") this.update({ lastError: receipt.failure ?? { stage: "codex.login", reason: receipt.stderr || receipt.stdout } });
      this.login = undefined;
    });
    return { sessionId: id };
  }
  private async endLogin() { const session = this.login; if (session) { session.cancelled = true; session.handle.cancel(); await session.done; } this.assertCleanup(); }
  private async logout() {
    this.changingAccount = true;
    try {
    await this.endLogin();
    await this.runner.stop();
    this.assertCleanup();
    const receipt = await this.runner.run({ stage: "codex.logout", args: ["logout"], timeoutMs: 60_000 }).promise;
    await this.readAccount();
    if (!succeeded(receipt)) this.update({ lastError: receipt.failure ?? { stage: "codex.logout", reason: receipt.stderr || receipt.stdout } });
    } finally { this.changingAccount = false; }
  }
  async stop(reason: "disabled" | "app_shutdown") {
    this.update({ lifecycle: "stopping" });
    if (reason === "app_shutdown") this.closed = true;
    try {
      await this.account(async () => { try { await this.endLogin(); } finally { await this.runner.stop(); } });
      await this.starting;
      this.assertCleanup();
      this.update({ lifecycle: "stopped" });
    } catch (error) {
      this.update({ lifecycle: "failed", lastError: this.stopFailure ?? { stage: "codex.stop", code: (error as { code?: string }).code, reason: String(error) } });
      throw error;
    }
  }
  private unavailable(stage: string, reason: string, code: string | number): CliReceipt {
    return { id: randomUUID(), stage, args: [], state: "not_started", exitCode: null, stdout: "", stderr: "", failure: { stage, code, reason } };
  }
  private async invoke(context: PluginTaskContext, stage: string, args: string[], signal?: AbortSignal, onOutput?: (stream: "stdout" | "stderr", text: string) => void, cwd?: string) {
    if (!this.options.enabled() || this.closed) return this.unavailable(stage, "Codex plugin is disabled", "plugin_disabled");
    try { await this.start(); }
    catch (error) { return this.unavailable(this.stopFailure?.stage ?? stage, this.stopFailure?.reason ?? String(error), this.stopFailure?.code ?? (error as { code?: string }).code ?? "cli_unavailable"); }
    if (!this.options.enabled() || this.closed) return this.unavailable(stage, "Codex plugin is disabled", "plugin_disabled");
    if (this.changingAccount) return this.unavailable("codex.account", "Codex is signing out", "account_changing");
    if (this.state.lifecycle !== "active") return this.unavailable(stage, this.state.lastError?.reason ?? "Codex could not start", String(this.state.lastError?.code ?? "cli_unavailable"));
    if (this.state.auth?.state === "unavailable" && this.state.lastError) return this.unavailable(this.state.lastError.stage, this.state.lastError.reason, this.state.lastError.code ?? "account_unavailable");
    if (this.state.auth?.state !== "signed_in") return this.unavailable("codex.auth", "Sign in to Codex on the Plugins page", "authorization_required");
    const handle = this.runner.run({ stage, args, signal, cwd: cwd ?? context.workspaceRoot, timeoutMs: context.commandTimeoutMs, onOutput });
    const receipt = await handle.promise; this.checkCleanup(receipt); return receipt;
  }
  tools(context: PluginTaskContext): AgentTool<any>[] {
    const defaults = `Default Cloud environment: ${this.state.configuration.environment || "unset"}; branch: ${this.state.configuration.branch || "CLI default"}.`;
    return [
      { name: "codex_exec", label: "Codex EXEC", description: `Delegate a natural-language task to the App's bundled Codex agent, including environment setup, complex work and follow-up. Return answer and Codex session ID. ${defaults}`, parameters: execParams, executionMode: "sequential",
        execute: async (_id, params, signal, onUpdate) => {
          let sessionId = params.sessionId;
          let answer = "";
          let buffer = "";
          let turnFailed: PluginFailure | undefined;
          let completed = false;
          const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", context.approvalMode === "yolo" ? "danger-full-access" : "workspace-write", "-c", 'approval_policy="never"', "-c", "sandbox_workspace_write.network_access=true"];
          if (params.sessionId) args.push("resume", params.sessionId);
          args.push("--", params.prompt);
          const receipt = await this.invoke(context, "codex.exec", args, signal, (stream, text) => {
            if (stream !== "stdout") return;
            buffer += text;
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
              let event: any; try { event = JSON.parse(line); } catch { continue; }
              if (event.type === "thread.started") sessionId = event.thread_id;
              if (event.type === "item.completed" && event.item?.type === "agent_message") { answer = event.item.text; onUpdate?.(result({ sessionId, answer, state: "working" })); }
              if (event.type === "turn.failed") turnFailed = { stage: "codex.exec.turn", code: event.error?.code, reason: event.error?.message ?? JSON.stringify(event.error) };
              if (event.type === "turn.completed") completed = true;
            }
          }, params.cwd);
          const outcome = receipt.state === "cancelled" || receipt.state === "timed_out" || receipt.state === "stop_unconfirmed" ? receipt.state : succeeded(receipt) && completed && !turnFailed ? "completed" : "failed";
          const failure = turnFailed ?? receipt.failure ?? (outcome === "failed" ? { stage: "codex.exec", reason: "Codex did not emit a completed turn", code: receipt.exitCode ?? undefined } : undefined);
          return result({ sessionId, outcome, answer, execution: receipt, failure }, outcome !== "completed");
        },
      },
      { name: "codex_cloud", label: "Codex Cloud", description: `Start a coding task directly in Codex Cloud. Returns accepted task ID and URL; remote execution continues after return. Use codex_exec to inspect that task later. ${defaults}`, parameters: cloudParams, executionMode: "sequential",
        execute: async (_id, params, signal) => {
          const environment = params.environment ?? this.state.configuration.environment;
          const branch = params.branch ?? this.state.configuration.branch;
          if (!environment?.trim()) return result({ outcome: "not_submitted", execution: this.unavailable("cloud.configuration", "Choose a Codex Cloud environment", "configuration_required") }, true);
          const args = ["cloud", "exec", "--env", environment];
          if (branch) args.push("--branch", branch);
          if (params.attempts !== undefined) args.push("--attempts", String(params.attempts));
          args.push("--", params.prompt);
          const receipt = await this.invoke(context, "cloud.submit", args, signal);
          const url = plain(receipt.stdout).match(/https:\/\/[^\s]+\/(?:tasks?|task)\/[a-zA-Z0-9_-]+/)?.[0];
          const id = url?.split("/").pop();
          const beforeSubmission = /no cloud environments are available|environment id must not be empty|environment '[^\n]+' not found|environment label '[^\n]+' is ambiguous|^error: (?:invalid value|unexpected argument|the following required arguments|a value is required)/mi.test(receipt.stderr);
          const httpCode = Number((receipt.stderr + receipt.stdout).match(/HTTP status client error \((4\d\d)\b|(?:HTTP(?:\/\S+)?|status(?: code)?)[:=\s]+(4\d\d)\b/i)?.slice(1).find(Boolean) ?? receipt.failure?.code);
          if (httpCode >= 400 && httpCode < 500 && receipt.failure) receipt.failure.code = httpCode;
          const outcome = url && id ? "accepted" : receipt.state === "not_started" || receipt.state === "start_failed" || beforeSubmission || httpCode >= 400 && httpCode < 500 ? "not_submitted" : "submission_unconfirmed";
          return result({ outcome, ...(id ? { task: { id, url } } : {}), execution: receipt, failure: receipt.failure }, outcome !== "accepted");
        },
      },
    ];
  }
}
