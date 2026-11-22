import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { obj, str, opt, int } from "@earendil-works/pi-schema";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  CliReceipt,
  PluginContext,
  PluginDefinition,
  PluginFailure,
  PluginRuntime,
  PluginStorage,
  PluginTaskContext,
} from "../../../runtime/plugins/contracts.js";
import { lastLegacyCloudCliVersion, type CodexPluginCommand, type CodexPluginState } from "../contracts.js";
import { codexManifest } from "../manifest.js";
import { extractPluginFailure, PluginKernelError } from "../../../runtime/plugins/errors.js";
import { cliArchive, downloadCliArchive, latestCliVersion, versionIsNewer } from "./cli-update.js";
import { readCloudDirectory } from "./cloud-directory.js";
import { createCodexRunner, type CliHandle, type CliRunner } from "./process.js";
import type { LangfuseTracer, TraceContext } from "../../../../../packages/looi-runtime/src/telemetry/langfuse.js";

const SKILL = `---
name: codex
description: Delegate natural-language tasks to the App’s Codex agent, start Codex Cloud tasks, or inspect Cloud task status.
---
Use codex_exec for natural-language work: investigate, create or configure a cloud environment, plan steps, or continue a Codex session. Include the returned sessionId to continue; Cloud task IDs are different from session IDs.
Use codex_cloud when the goal is directly starting a remote coding task in an existing environment. It returns an accepted task ID and URL, not the completed coding result.
Use codex_cloud_status with that Cloud task ID to inspect remote progress or results read-only without launching a local write agent. Do not submit the same goal again if Codex has already submitted it.
After submitting a codex_cloud task or creating/updating a GitHub PR via codex_exec, quietly call manage_schedule (origin="agent_inferred", executionPolicy="check_only", unique dedupeKey) with a self-contained prompt carrying exact owner/repo/pullNumber or taskId; subsequent automated checks will use only github_pr_status or codex_cloud_status.
All tools use the App's own Linux CLI and Codex login. Account setup is on the Plugins page. Respect actual execution failures and include their stage and provider reason. Full CLI output is available at the receipt's outputFiles paths.
`;

const execParams = obj({
  prompt: str({ description: "Natural-language task for the Codex agent" }),
  sessionId: opt(str({ description: "Codex session ID to continue, not a Cloud task ID" })),
  cwd: opt(str({ description: "App Linux working directory" })),
});

const cloudParams = obj({
  prompt: str({ description: "Coding task to start in Codex Cloud" }),
  environment: opt(str({ description: "Cloud environment ID or unique name; defaults to plugin setting" })),
  branch: opt(str({ description: "Git branch; defaults to plugin setting" })),
  attempts: opt(int({ description: "Number of Cloud attempts, 1–4", minimum: 1, maximum: 4 })),
});

const cloudStatusParams = obj({
  taskId: str({ description: "Codex Cloud task ID (4-128 characters matching ^[a-zA-Z0-9_-]{4,128}$)" }),
});

const CLOUD_TASK_ID_RE = /^[a-zA-Z0-9_-]{4,128}$/;

const result = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: value,
  isError,
});
const plain = (text: string) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
const succeeded = (receipt: CliReceipt) => receipt.state === "exited" && receipt.exitCode === 0 && !receipt.failure;

export interface CodexPluginOptions {
  directory?: string;
  tracer?: LangfuseTracer;
  traceContext?: () => TraceContext | undefined;
  runner?: CliRunner;
  archiveDirectory?: string;
}

function readInitialCodexState(storage: PluginStorage): CodexPluginState {
  const environment = storage.get<string>("environment");
  const branch = storage.get<string>("branch");
  return {
    environment: typeof environment === "string" ? environment : "video2rig",
    branch: typeof branch === "string" ? branch : "main",
  };
}

export function codexDefinition(
  options: CodexPluginOptions = {},
): PluginDefinition<CodexPluginState, CodexPluginCommand> {
  return {
    manifest: codexManifest,
    initialState: (storage) => readInitialCodexState(storage),
    create: (context) => new CodexPlugin(context, options),
  };
}

/** One instance owns both tools, official account operations, approval guard, and CLI processes. */
export class CodexPlugin implements PluginRuntime<CodexPluginCommand, CodexPluginState> {
  private readonly runner: CliRunner;
  readonly skillPaths: string[];
  private accountQueue: Promise<unknown> = Promise.resolve();
  private login?: { id: string; handle: CliHandle; done: Promise<void>; cancelled: boolean };
  private closed = false;
  private changingAccount = false;
  private cliUpdate?: AbortController;
  private runningTools = 0;
  private stopFailure?: PluginFailure;

  readonly auth = {
    begin: () => this.account(() => this.beginLogin()),
    cancel: () => this.account(() => this.endLogin()),
    logout: () => this.account(() => this.logout()),
    refresh: () =>
      this.account(async () => {
        const wasActive = this.ctx.lifecycle() === "active";
        await this.ctx.ensureStarted();
        if (wasActive && !this.login && !this.stopFailure && this.ctx.lifecycle() === "active") {
          await this.readAccount();
        }
      }),
  };

  constructor(
    private readonly ctx: PluginContext<CodexPluginState>,
    private readonly options: CodexPluginOptions = {},
  ) {
    const directory = options.directory ?? "/home/agent/plugins/codex";
    fs.mkdirSync(directory, { recursive: true });
    const skillDirectory = path.join(directory, "skill");
    fs.mkdirSync(skillDirectory, { recursive: true });
    const skillPath = path.join(skillDirectory, "SKILL.md");
    fs.writeFileSync(skillPath, SKILL);
    this.skillPaths = [skillPath];

    if (!this.ctx.getAuth()) {
      this.ctx.setAuth({ state: "signed_out" });
    }

    this.runner =
      options.runner ??
      createCodexRunner({
        directory: path.join(directory, "executions"),
        tracer: options.tracer,
        traceContext: options.traceContext,
        onOutput: (callId, stream, text) =>
          this.ctx.publish({ type: "execution_output", pluginId: "codex", callId, stream, text }),
        onFinished: (receipt) => {
          this.checkCleanup(receipt);
          this.ctx.setLastExecution(receipt);
          this.ctx.publish({ type: "execution_finished", pluginId: "codex", receipt });
        },
      });

    // Register tools, skill paths, and approval guard into the host's Dual-Loop AI Bus.
    this.ctx.ai?.useContribution({
      taskTools: (taskContext) => this.tools(taskContext),
      skillPaths: this.skillPaths,
    });

    this.ctx.ai?.interceptToolCall(({ toolName, approvalMode, arguments: input, scheduleExecutionPolicy }) => {
      if (toolName === "codex_cloud_status") {
        return { decision: "allow" };
      }
      if (toolName === "codex_exec" || toolName === "codex_cloud") {
        if (scheduleExecutionPolicy === "check_only") {
          return {
            decision: "deny",
            stage: "codex.policy",
            code: "ERR_CODEX_CHECK_ONLY_DENIED",
            reason: `${toolName} is denied under check_only schedule policy; use codex_cloud_status instead`,
          };
        }
        if (approvalMode === "ask") {
          return {
            decision: "ask",
            promptPayload: { operation: toolName, ...input },
          };
        }
      }
      return undefined;
    });
  }

  private account<T>(run: () => Promise<T>): Promise<T> {
    const next = this.accountQueue.then(run, run);
    this.accountQueue = next.catch(() => {});
    return next;
  }

  private checkCleanup(receipt: CliReceipt): void {
    if (receipt.state !== "stop_unconfirmed") return;
    this.stopFailure = receipt.failure ?? {
      stage: receipt.stage,
      code: "ERR_CODEX_STOP_UNCONFIRMED",
      reason: "Codex process exit is unconfirmed",
    };
    this.ctx.setLastExecution(receipt);
    if (this.ctx.getAuth()?.state === "authorizing") {
      this.ctx.setAuth({ state: "unavailable" });
    }
    this.ctx.markFailed(this.stopFailure);
  }

  private assertCleanup(): void {
    if (this.stopFailure) {
      throw Object.assign(new Error(this.stopFailure.reason), {
        stage: this.stopFailure.stage,
        code: this.stopFailure.code,
      });
    }
  }

  async configure(values: Record<string, string>): Promise<void> {
    const current = this.ctx.getState();
    const environment = values.environment !== undefined ? values.environment.trim() : current.environment;
    const branch = values.branch !== undefined ? values.branch.trim() : current.branch;
    this.ctx.storage.set("environment", environment);
    this.ctx.storage.set("branch", branch);
    this.ctx.setState((prev) => ({ ...prev, environment, branch }));
  }

  async handleCommand(command: CodexPluginCommand): Promise<CodexPluginState> {
    if (command.type === "save_cloud_defaults") {
      await this.configure({ environment: command.environment, branch: command.branch });
      return this.ctx.getState();
    }

    return this.account(async () => {
      let stage = command.type === "load_cloud_environments" ? "cloud.directory" : "codex.update.registry";
      let execution: CliReceipt | undefined;
      try {
        this.assertCleanup();
        if (!this.ctx.enabled() || this.closed) {
          throw new PluginKernelError({ stage, code: "ERR_PLUGIN_DISABLED", reason: "Codex plugin is disabled" });
        }
        if (command.type === "load_cloud_environments") {
          if (this.ctx.getAuth()?.state !== "signed_in") {
            throw new PluginKernelError({ stage, code: "ERR_CODEX_CHATGPT_LOGIN_REQUIRED", reason: "Sign in to Codex to read cloud environments" });
          }
          let credentials = "";
          const receipt = await this.runner.run({
            stage: "cloud.directory.auth",
            operation: "read_credentials",
            args: [],
            timeoutMs: 10_000,
            onOutput: (stream, text) => { if (stream === "stdout") credentials += text; },
          }).promise;
          this.checkCleanup(receipt);
          if (!succeeded(receipt)) this.throwReceipt(receipt);
          const { environments, failures } = await readCloudDirectory(credentials);
          if (environments.length || !failures.length) {
            this.ctx.setState((prev) => ({ ...prev, cloudEnvironments: environments }));
          }
          this.ctx.setLastError(failures.at(-1));
          if (failures.length) {
            for (const failure of failures) this.recordOperation(stage, failure);
          } else {
            this.recordOperation(stage);
          }
          return this.ctx.getState();
        } else if (command.type === "check_cli_update") {
          const version = await latestCliVersion();
          this.ctx.setState((prev) => ({
            ...prev,
            latestCliVersion: version,
            cliUpdateAvailable: versionIsNewer(version, prev.cliVersion ?? ""),
          }));
        } else if (command.type === "install_cli_update") {
          const { cliVersion, latestCliVersion: version } = this.ctx.getState();
          if (!version || !cliVersion || !versionIsNewer(version, cliVersion)) return this.ctx.getState();
          if (this.runningTools || this.login) {
            throw new PluginKernelError({ stage: "codex.update.prepare", code: "ERR_CODEX_BUSY", reason: "Finish the running Codex task or login before updating" });
          }
          const controller = new AbortController();
          this.cliUpdate = controller;
          const destination = path.join(this.options.archiveDirectory ?? "/workspace", `.looi-codex-${randomUUID()}.tgz`);
          try {
            const archive = await cliArchive(version, controller.signal);
            if (!this.ctx.enabled() || this.closed) {
              throw new PluginKernelError({ stage: "codex.update.prepare", code: "ERR_PLUGIN_DISABLED", reason: "Codex plugin is disabled" });
            }
            stage = "codex.update.download";
            await downloadCliArchive(archive.url, destination, AbortSignal.any([
              controller.signal, AbortSignal.timeout(10 * 60_000),
            ]));
            stage = "codex.update.install";
            execution = await this.runner.run({
              stage,
              operation: "install_cli",
              args: [destination, archive.sha512, version],
              timeoutMs: 10 * 60_000,
              signal: controller.signal,
            }).promise;
            this.checkCleanup(execution);
            if (!succeeded(execution)) this.throwReceipt(execution);
            this.setCliVersion(version);
          } finally {
            this.cliUpdate = undefined;
            try {
              fs.rmSync(destination, { force: true });
            } catch (error) {
              const failure = extractPluginFailure(error, "codex.update.cleanup");
              this.recordOperation(failure.stage, failure);
            }
          }
        } else {
          throw new Error(`Unsupported Codex command: ${String((command as { type?: unknown }).type)}`);
        }

        this.ctx.setLastError(undefined);
        if (!execution) this.recordOperation(stage);
        return this.ctx.getState();
      } catch (error) {
        const failure = extractPluginFailure(error, stage);
        this.ctx.setLastError(failure);
        if (!execution) this.recordOperation(stage, failure);
        throw new PluginKernelError({ ...failure, code: failure.code ?? "ERR_CODEX_SETTINGS" });
      }
    });
  }

  private throwReceipt(receipt: CliReceipt): never {
    const failure = receipt.failure ?? { stage: receipt.stage, reason: receipt.stderr || receipt.stdout };
    throw new PluginKernelError({ ...failure, code: failure.code ?? receipt.exitCode ?? "ERR_CODEX_PROCESS" });
  }

  private setCliVersion(cliVersion: string): void {
    this.ctx.setState((prev) => ({
      ...prev,
      cliVersion,
      cliUpdateAvailable: Boolean(prev.latestCliVersion && versionIsNewer(prev.latestCliVersion, cliVersion)),
      currentCloudSubmitUnsupported: cliVersion === lastLegacyCloudCliVersion || versionIsNewer(lastLegacyCloudCliVersion, cliVersion),
    }));
  }

  private recordOperation(stage: string, failure?: PluginFailure): void {
    const receipt: CliReceipt = {
      id: randomUUID(),
      stage: failure?.stage ?? stage,
      args: [],
      state: failure ? "execution_failed" : "exited",
      exitCode: null,
      stdout: "",
      stderr: "",
      failure,
    };
    this.ctx.setLastExecution(receipt);
    this.ctx.publish({ type: "execution_finished", pluginId: "codex", receipt });
  }

  async start(): Promise<void> {
    this.assertCleanup();
    if (this.closed) throw new Error("Codex plugin is closed");
    if (!this.ctx.enabled()) return;

    this.ctx.setLastError(undefined);
    const receipt = await this.runner.run({ stage: "codex.version", args: ["--version"], timeoutMs: 60_000 }).promise;
    this.checkCleanup(receipt);
    if (!succeeded(receipt)) {
      const failure = receipt.failure ?? { stage: "codex.version", reason: receipt.stderr || receipt.stdout };
      this.ctx.markFailed(failure);
      return;
    }

    const cliVersion = plain(receipt.stdout).trim().replace(/^codex-cli\s+/, "");
    this.setCliVersion(cliVersion);
    if (this.closed || !this.ctx.enabled()) return;
    await this.readAccount();
  }

  private async readAccount(): Promise<void> {
    if (this.closed || this.stopFailure) return;
    const receipt = await this.runner.run({ stage: "codex.account", args: ["login", "status"], timeoutMs: 60_000 }).promise;
    this.checkCleanup(receipt);
    if (this.closed) return;
    if (succeeded(receipt)) {
      this.ctx.setAuth({ state: "signed_in", accountLabel: plain(receipt.stderr || receipt.stdout).trim() });
      this.ctx.setLastError(undefined);
    } else if (receipt.state === "exited" && receipt.exitCode === 1 && /Not logged in/i.test(receipt.stderr + receipt.stdout)) {
      this.ctx.setAuth({ state: "signed_out" });
      this.ctx.setState((prev) => ({ ...prev, cloudEnvironments: undefined }));
      this.ctx.setLastError(undefined);
    } else {
      this.ctx.setAuth({ state: "unavailable" });
      this.ctx.setLastError(receipt.failure ?? { stage: "codex.account", reason: receipt.stderr || receipt.stdout });
    }
  }

  private async beginLogin(): Promise<{ sessionId: string }> {
    if (!this.ctx.enabled() || this.closed) throw new Error("Codex plugin is disabled");
    if (this.login) return { sessionId: this.login.id };
    await this.ctx.ensureStarted();
    if (!this.ctx.enabled() || this.closed) throw new Error("Codex plugin is disabled");
    if (this.ctx.lifecycle() !== "active") {
      throw new Error(this.ctx.getLastError()?.reason ?? "Codex could not start");
    }

    const id = randomUUID();
    this.ctx.setAuth({ state: "authorizing", sessionId: id });
    this.ctx.setState((prev) => ({ ...prev, cloudEnvironments: undefined }));
    this.ctx.setLastError(undefined);

    let output = "";
    let publishedUrl = "";
    const handle = this.runner.run({
      stage: "codex.login",
      args: ["login"],
      timeoutMs: 16 * 60_000,
      onOutput: (_stream, text) => {
        if (this.login?.id !== id || this.login.cancelled || this.closed || !this.ctx.enabled()) return;
        output = (output + text).slice(-32_768);
        const url = plain(output).match(/https:\/\/(?:auth\.openai\.com|chatgpt\.com)\/[^\s\u001b]+(?=\s)/)?.[0];
        if (url && url !== publishedUrl && !this.closed) {
          publishedUrl = url;
          this.ctx.setAuth({ state: "authorizing", sessionId: id, url });
          this.ctx.publish({ type: "auth_challenge", pluginId: "codex", sessionId: id, url });
        }
      },
    });

    const session = { id, handle, done: Promise.resolve(), cancelled: false };
    this.login = session;
    session.done = handle.promise.then(async (receipt) => {
      this.checkCleanup(receipt);
      if (this.closed || this.login !== session) return;
      await this.readAccount();
      if (this.login !== session || this.closed) return;
      this.ctx.setLastExecution(receipt);
      if (!succeeded(receipt) && receipt.state !== "cancelled") {
        this.ctx.setLastError(receipt.failure ?? { stage: "codex.login", reason: receipt.stderr || receipt.stdout });
      }
      this.login = undefined;
    });

    return { sessionId: id };
  }

  private async endLogin(): Promise<void> {
    const session = this.login;
    if (session) {
      session.cancelled = true;
      session.handle.cancel();
      await session.done;
    }
    this.assertCleanup();
  }

  private async logout(): Promise<void> {
    this.changingAccount = true;
    this.ctx.setState((prev) => ({ ...prev, cloudEnvironments: undefined }));
    try {
      await this.endLogin();
      await this.runner.stop();
      this.assertCleanup();
      const receipt = await this.runner.run({ stage: "codex.logout", args: ["logout"], timeoutMs: 60_000 }).promise;
      await this.readAccount();
      if (!succeeded(receipt)) {
        this.ctx.setLastError(receipt.failure ?? { stage: "codex.logout", reason: receipt.stderr || receipt.stdout });
      }
    } finally {
      this.changingAccount = false;
    }
  }

  async stop(reason: "disabled" | "dependency_lost" | "app_shutdown"): Promise<void> {
    if (reason === "app_shutdown") this.closed = true;
    this.cliUpdate?.abort();
    try {
      await this.account(async () => {
        try {
          await this.endLogin();
        } finally {
          await this.runner.stop();
        }
      });
      this.assertCleanup();
    } catch (error) {
      const failure = this.stopFailure ?? {
        stage: "codex.stop",
        code: (error as { code?: string }).code,
        reason: String(error),
      };
      this.ctx.markFailed(failure);
      throw error;
    }
  }

  private unavailable(stage: string, reason: string, code: string | number): CliReceipt {
    return {
      id: randomUUID(),
      stage,
      args: [],
      state: "not_started",
      exitCode: null,
      stdout: "",
      stderr: "",
      failure: { stage, code, reason },
    };
  }

  private async invoke(
    context: PluginTaskContext,
    stage: string,
    args: string[],
    signal?: AbortSignal,
    onOutput?: (stream: "stdout" | "stderr", text: string) => void,
    cwd?: string,
  ): Promise<CliReceipt> {
    if (!this.ctx.enabled() || this.closed) {
      return this.unavailable(stage, "Codex plugin is disabled", "plugin_disabled");
    }
    try {
      await this.ctx.ensureStarted();
    } catch (error) {
      return this.unavailable(
        this.stopFailure?.stage ?? stage,
        this.stopFailure?.reason ?? String(error),
        this.stopFailure?.code ?? (error as { code?: string }).code ?? "cli_unavailable",
      );
    }
    if (!this.ctx.enabled() || this.closed) {
      return this.unavailable(stage, "Codex plugin is disabled", "plugin_disabled");
    }
    if (this.changingAccount) {
      return this.unavailable("codex.account", "Codex is signing out", "account_changing");
    }
    const lastError = this.ctx.getLastError();
    if (this.ctx.lifecycle() !== "active") {
      return this.unavailable(stage, lastError?.reason ?? "Codex could not start", String(lastError?.code ?? "cli_unavailable"));
    }
    const auth = this.ctx.getAuth();
    if (auth?.state === "unavailable" && lastError) {
      return this.unavailable(lastError.stage, lastError.reason, lastError.code ?? "account_unavailable");
    }
    if (auth?.state !== "signed_in") {
      return this.unavailable("codex.auth", "Sign in to Codex on the Plugins page", "authorization_required");
    }
    if (this.cliUpdate) {
      return this.unavailable("codex.update.install", "Codex CLI is updating", "cli_updating");
    }
    this.runningTools += 1;
    try {
      const receipt = await this.runner.run({ stage, args, signal, cwd: cwd ?? context.workspaceRoot, timeoutMs: context.commandTimeoutMs, onOutput }).promise;
      this.checkCleanup(receipt);
      return receipt;
    } finally {
      this.runningTools -= 1;
    }
  }

  tools(context: PluginTaskContext): AgentTool<any>[] {
    const state = this.ctx.getState();
    const defaults = `Default Cloud environment: ${state.environment || "unset"}; branch: ${state.branch || "CLI default"}.`;

    const cloudStatusTool: AgentTool<typeof cloudStatusParams> = {
      name: "codex_cloud_status",
      label: "Codex Cloud Status",
      description:
        "Read-only status lookup for an existing Codex Cloud task ID via the App's Codex CLI (`codex cloud status`). Does not modify files or start a local agent.",
      parameters: cloudStatusParams,
      executionMode: "sequential",
      execute: async (_id, params, signal) => {
        const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
        if (!CLOUD_TASK_ID_RE.test(taskId)) {
          return result(
            {
              taskId: params.taskId,
              outcome: "failed",
              failure: {
                stage: "codex.cloud_status.validate",
                code: "ERR_INVALID_ARGUMENT",
                reason: "taskId must match ^[a-zA-Z0-9_-]{4,128}$",
              },
            },
            true,
          );
        }
        const receipt = await this.invoke(
          context,
          "cloud.status",
          ["cloud", "status", "--", taskId],
          signal,
        );
        if (succeeded(receipt)) {
          return result(
            {
              taskId,
              outcome: "ok",
              statusText: plain(receipt.stdout).trim(),
              execution: receipt,
            },
            false,
          );
        }
        const combinedOutput = receipt.stderr + receipt.stdout;
        const httpMatch = combinedOutput.match(
          /HTTP status (?:client|server) error \((4\d\d|5\d\d)\b|(?:HTTP(?:\/\S+)?|status(?: code)?)[:=\s]+(4\d\d|5\d\d)\b/i,
        );
        const httpCode = httpMatch ? Number(httpMatch.slice(1).find(Boolean)) : NaN;
        const baseFailure: PluginFailure = receipt.failure
          ? { ...receipt.failure }
          : {
              stage: receipt.stage || "cloud.status",
              code: receipt.exitCode ?? "ERR_CODEX_CLOUD_STATUS",
              reason:
                plain(receipt.stderr || receipt.stdout).trim() ||
                `Codex cloud status exited (${receipt.state})`,
            };
        if (Number.isFinite(httpCode) && httpCode >= 400) {
          baseFailure.code = httpCode;
        }
        const outcome =
          receipt.state === "cancelled" ||
          receipt.state === "timed_out" ||
          receipt.state === "stop_unconfirmed"
            ? receipt.state
            : "failed";
        return result(
          {
            taskId,
            outcome,
            execution: receipt,
            failure: baseFailure,
          },
          true,
        );
      },
    };

    if (context.scheduleExecutionPolicy === "check_only") {
      return [cloudStatusTool];
    }

    return [
      {
        name: "codex_exec",
        label: "Codex EXEC",
        description: `Delegate a natural-language task to the App's Codex agent, including environment setup, complex work and follow-up. Return answer and Codex session ID. ${defaults}`,
        parameters: execParams,
        executionMode: "sequential",
        execute: async (_id, params, signal, onUpdate) => {
          let sessionId = params.sessionId;
          let answer = "";
          let buffer = "";
          let turnFailed: PluginFailure | undefined;
          let completed = false;
          const args = [
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--sandbox",
            context.approvalMode === "yolo" ? "danger-full-access" : "workspace-write",
            "-c",
            'approval_policy="never"',
            "-c",
            "sandbox_workspace_write.network_access=true",
          ];
          if (params.sessionId) args.push("resume", params.sessionId);
          args.push("--", params.prompt);
          const receipt = await this.invoke(
            context,
            "codex.exec",
            args,
            signal,
            (stream, text) => {
              if (stream !== "stdout") return;
              buffer += text;
              let newline: number;
              while ((newline = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                let event: any;
                try {
                  event = JSON.parse(line);
                } catch {
                  continue;
                }
                if (event.type === "thread.started") sessionId = event.thread_id;
                if (event.type === "item.completed" && event.item?.type === "agent_message") {
                  answer = event.item.text;
                  onUpdate?.(result({ sessionId, answer, state: "working" }));
                }
                if (event.type === "turn.failed") {
                  turnFailed = {
                    stage: "codex.exec.turn",
                    code: event.error?.code,
                    reason: event.error?.message ?? JSON.stringify(event.error),
                  };
                }
                if (event.type === "turn.completed") completed = true;
              }
            },
            params.cwd,
          );
          const outcome =
            receipt.state === "cancelled" || receipt.state === "timed_out" || receipt.state === "stop_unconfirmed"
              ? receipt.state
              : succeeded(receipt) && completed && !turnFailed
                ? "completed"
                : "failed";
          const failure =
            turnFailed ??
            receipt.failure ??
            (outcome === "failed"
              ? { stage: "codex.exec", reason: "Codex did not emit a completed turn", code: receipt.exitCode ?? undefined }
              : undefined);
          return result({ sessionId, outcome, answer, execution: receipt, failure }, outcome !== "completed");
        },
      },
      {
        name: "codex_cloud",
        label: "Codex Cloud",
        description: `Start a coding task directly in Codex Cloud. Returns accepted task ID and URL; remote execution continues after return. Use codex_cloud_status to inspect that task later. ${defaults}`,
        parameters: cloudParams,
        executionMode: "sequential",
        execute: async (_id, params, signal) => {
          const latestState = this.ctx.getState();
          const environment = params.environment ?? latestState.environment;
          const branch = params.branch ?? latestState.branch;
          if (!environment?.trim()) {
            return result(
              {
                outcome: "not_submitted",
                execution: this.unavailable("cloud.configuration", "Choose a Codex Cloud environment", "configuration_required"),
              },
              true,
            );
          }
          const entries = latestState.cloudEnvironments ?? [];
          const matching = entries.filter((entry) => entry.name === environment);
          const selected = entries.find((entry) => entry.id === environment) ?? (matching.length === 1 ? matching[0] : undefined);
          const currentCloud = Boolean(selected && selected.scope !== "legacy") || /(?:^|~)asenvcfg_/.test(environment);
          if (this.ctx.getAuth()?.state === "signed_in" && latestState.currentCloudSubmitUnsupported && currentCloud) {
            const outcome = "not_submitted";
            const execution = this.unavailable(
              "cloud.submit.compatibility",
              "The installed CLI only submits to legacy environments. This environment uses the current Codex Cloud.",
              "ERR_CODEX_CLOUD_ENVIRONMENT_UNSUPPORTED",
            );
            this.ctx.setLastExecution(execution);
            this.ctx.publish({ type: "execution_finished", pluginId: "codex", receipt: execution });
            return result({ outcome, execution, failure: execution.failure }, true);
          }
          const args = ["cloud", "exec", "--env", environment];
          if (branch) args.push("--branch", branch);
          if (params.attempts !== undefined) args.push("--attempts", String(params.attempts));
          args.push("--", params.prompt);
          const receipt = await this.invoke(context, "cloud.submit", args, signal);
          const url = plain(receipt.stdout).match(/https:\/\/[^\s]+\/(?:tasks?|task)\/[a-zA-Z0-9_-]+/)?.[0];
          const id = url?.split("/").pop();
          const beforeSubmission =
            /no cloud environments are available|environment id must not be empty|environment '[^\n]+' not found|environment label '[^\n]+' is ambiguous|^error: (?:invalid value|unexpected argument|the following required arguments|a value is required)/im.test(
              receipt.stderr,
            );
          const httpCode = Number(
            (receipt.stderr + receipt.stdout)
              .match(/HTTP status client error \((4\d\d)\b|(?:HTTP(?:\/\S+)?|status(?: code)?)[:=\s]+(4\d\d)\b/i)
              ?.slice(1)
              .find(Boolean) ?? receipt.failure?.code,
          );
          if (httpCode >= 400 && httpCode < 500 && receipt.failure) receipt.failure.code = httpCode;
          const outcome =
            url && id
              ? "accepted"
              : receipt.state === "not_started" ||
                  receipt.state === "start_failed" ||
                  beforeSubmission ||
                  (httpCode >= 400 && httpCode < 500)
                ? "not_submitted"
                : "submission_unconfirmed";
          return result({ outcome, ...(id ? { task: { id, url } } : {}), execution: receipt, failure: receipt.failure }, outcome !== "accepted");
        },
      },
      cloudStatusTool,
    ];
  }
}
