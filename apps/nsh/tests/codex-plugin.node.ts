import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CodexPlugin, codexDefinition } from "../plugins/codex/runtime/index.js";
import {
  createCodexRunner,
  type CliHandle,
  type CliRequest,
  type CliRunner,
} from "../plugins/codex/runtime/process.js";
import { PluginHost } from "../runtime/plugins/host.js";
import type { CliReceipt, PluginEvent } from "../runtime/plugins/contracts.js";

const context = {
  taskId: "task-1",
  workspaceRoot: "/workspace/repo",
  approvalMode: "yolo" as const,
  commandTimeoutMs: 30_000,
};

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "looi-codex-"));
  const database = new DatabaseSync(":memory:");
  const requests: CliRequest[] = [];
  const pending = new Set<CliHandle>();
  const events: PluginEvent[] = [];
  let signedIn = true;
  let login: { request: CliRequest; finish: (receipt?: Partial<CliReceipt>) => void } | undefined;
  let cloud: Partial<CliReceipt> = { stdout: "https://chatgpt.com/codex/tasks/task_cloud_1\n" };
  let exec: Partial<CliReceipt> = {};

  const runner: CliRunner = {
    run(request) {
      requests.push(request);
      let finish!: (patch?: Partial<CliReceipt>) => void;
      const handle: CliHandle = {
        id: `call-${requests.length}`,
        cancel() {
          finish({ state: "cancelled", exitCode: null });
        },
        promise: new Promise((resolve) => {
          finish = (patch) =>
            resolve({
              id: `call-${requests.length}`,
              stage: request.stage,
              args: request.args,
              state: "exited",
              exitCode: 0,
              stdout: "",
              stderr: "",
              ...patch,
            });
        }),
      };
      pending.add(handle);
      void handle.promise.then(() => pending.delete(handle));
      queueMicrotask(() => {
        if (request.stage === "codex.version") finish({ stdout: "codex-cli 0.167.2\n" });
        else if (request.stage === "codex.account")
          finish(
            signedIn
              ? { stderr: "Logged in using ChatGPT\n" }
              : { exitCode: 1, stderr: "Not logged in\n" },
          );
        else if (request.stage === "codex.login") login = { request, finish };
        else if (request.stage === "codex.logout") {
          signedIn = false;
          finish();
        } else if (request.operation === "read_credentials") {
          request.onOutput?.("stdout", JSON.stringify({ tokens: { access_token: "test-token", account_id: "test-account" } }));
          finish();
        } else if (request.operation === "install_cli") {
          const content = fs.readFileSync(request.args[0]!);
          finish({ stdout: `codex-cli ${request.args[2]}\n`, stderr: content.toString("hex") });
        } else if (request.stage === "cloud.submit") finish(cloud);
        else if (request.stage === "codex.exec") {
          const output =
            JSON.stringify({ type: "thread.started", thread_id: "session-codex-1" }) +
            "\n" +
            JSON.stringify({
              type: "item.completed",
              item: { type: "agent_message", text: "Prepared the environment." },
            }) +
            "\n" +
            JSON.stringify({ type: "turn.completed" }) +
            "\n";
          request.onOutput?.("stdout", output.slice(0, 13));
          request.onOutput?.("stdout", output.slice(13));
          finish({ stdout: output, ...exec });
        }
      });
      return handle;
    },
    async stop() {
      const calls = [...pending];
      calls.forEach((call) => call.cancel());
      await Promise.all(calls.map((call) => call.promise));
    },
  };

  const host = new PluginHost(database, [codexDefinition({ directory, runner, archiveDirectory: directory })]);
  host.subscribe((event) => events.push(event));
  const plugin = host.get("codex") as CodexPlugin;

  return {
    directory,
    database,
    host,
    runner,
    plugin,
    requests,
    events,
    snapshot: () => host.snapshot("codex"),
    setSignedIn: (value: boolean) => {
      signedIn = value;
    },
    login: () => login!,
    setCloud: (patch: Partial<CliReceipt>) => {
      cloud = patch;
    },
    setExec: (patch: Partial<CliReceipt>) => {
      exec = patch;
    },
    async close() {
      try {
        await host.close();
      } catch {}
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

const payload = (value: any) => JSON.parse(value.content.find((part: any) => part.type === "text").text);

test("EXEC delegates a prompt, streams full answers and continues the explicit Codex session", async () => {
  const f = fixture();
  try {
    const tool = f.plugin.tools(context).find((t) => t.name === "codex_exec")!;
    const outcome = payload(
      await tool.execute("exec-1", { prompt: "Create a cloud environment", cwd: "/workspace/setup" }),
    );
    assert.equal(outcome.outcome, "completed");
    assert.equal(outcome.sessionId, "session-codex-1");
    assert.equal(outcome.answer, "Prepared the environment.");
    assert.equal(f.snapshot().version, "1.1.0");
    assert.equal(f.snapshot().state.cliVersion, "0.167.2");
    const request = f.requests.find((r) => r.stage === "codex.exec")!;
    assert.equal(request.cwd, "/workspace/setup");
    assert.ok(request.args.includes("Create a cloud environment"));
    assert.ok(!request.args.includes("cloud"));
    await tool.execute("exec-2", { prompt: "Continue setup", sessionId: outcome.sessionId });
    const next = f.requests.at(-1)!;
    assert.ok(next.args.includes("resume"));
    assert.ok(next.args.includes(outcome.sessionId));
    assert.ok(!next.args.includes("--last"));
  } finally {
    await f.close();
  }
});

test("Cloud starts directly with defaults and returns a distinct accepted task ID", async () => {
  const f = fixture();
  try {
    const tool = f.plugin.tools(context).find((t) => t.name === "codex_cloud")!;
    const outcome = payload(await tool.execute("cloud-1", { prompt: "Fix video import" }));
    assert.equal(outcome.outcome, "accepted");
    assert.equal(outcome.task.id, "task_cloud_1");
    assert.equal(outcome.sessionId, undefined);
    assert.deepEqual(f.requests.at(-1)!.args, [
      "cloud",
      "exec",
      "--env",
      "video2rig",
      "--branch",
      "main",
      "--",
      "Fix video import",
    ]);
    assert.equal(f.requests.filter((r) => r.stage === "codex.exec").length, 0);
  } finally {
    await f.close();
  }
});

test("Codex registers its own approval guard via ctx.ai.interceptToolCall and supports typed save_cloud_defaults commands", async () => {
  const f = fixture();
  try {
    const askDecision = await f.host.ai.evaluateToolCall({
      channel: "task",
      toolName: "codex_exec",
      approvalMode: "ask",
      arguments: { prompt: "inspect repo" },
    });
    assert.deepEqual(askDecision, {
      decision: "ask",
      pluginId: "codex",
      promptPayload: { operation: "codex_exec", prompt: "inspect repo" },
    });

    const autoDecision = await f.host.ai.evaluateToolCall({
      channel: "task",
      toolName: "codex_exec",
      approvalMode: "local_auto",
      arguments: { prompt: "inspect repo" },
    });
    assert.equal(autoDecision, undefined);

    const updated = await f.host.sendCommand("codex", {
      type: "save_cloud_defaults",
      environment: "prod-env",
      branch: "release",
    });
    assert.equal((updated as { cliVersion?: string }).cliVersion, "0.167.2");
    assert.equal(f.snapshot().configuration.environment, "prod-env");
    assert.equal(f.snapshot().configuration.branch, "release");
  } finally {
    await f.close();
  }
});

test("Cloud distinguishes configuration, explicit service rejection, and lost submission receipts without retrying", async () => {
  const f = fixture();
  try {
    const tool = f.plugin.tools(context).find((t) => t.name === "codex_cloud")!;
    await f.plugin.configure({ environment: "", branch: "main" });
    const missing = payload(await tool.execute("missing", { prompt: "Fix it" }));
    assert.equal(missing.outcome, "not_submitted");
    assert.equal(missing.execution.state, "not_started");
    assert.equal(f.requests.length, 0);
    f.setCloud({
      exitCode: 1,
      stderr: "HTTP status client error (403 Forbidden) for url (https://chatgpt.com/backend-api/wham/tasks)",
      failure: { stage: "cloud.submit", code: 403, reason: "HTTP 403 Forbidden" },
    });
    const rejected = payload(await tool.execute("denied", { prompt: "Fix it", environment: "video2rig" }));
    assert.equal(rejected.outcome, "not_submitted");
    assert.equal(rejected.failure.code, 403);
    assert.equal(rejected.execution.exitCode, 1);
    f.setCloud({
      state: "timed_out",
      exitCode: null,
      failure: { stage: "cloud.submit", reason: "Request deadline elapsed" },
    });
    const unknown = payload(await tool.execute("lost", { prompt: "Fix it", environment: "video2rig" }));
    assert.equal(unknown.outcome, "submission_unconfirmed");
    assert.equal(unknown.execution.state, "timed_out");
    assert.equal(f.requests.filter((r) => r.stage === "cloud.submit").length, 2);
  } finally {
    await f.close();
  }
});

test("cancelled login re-reads credentials already committed by the CLI; logout cannot be overwritten", async () => {
  const f = fixture();
  f.setSignedIn(false);
  try {
    await f.plugin.auth.begin();
    await new Promise((resolve) => setImmediate(resolve));
    f.login().request.onOutput?.("stderr", "Open this URL:\nhttps://auth.openai.com/oauth/authorize?state=");
    assert.equal(f.events.filter((e) => e.type === "auth_challenge").length, 0);
    f.login().request.onOutput?.("stderr", "complete\n");
    assert.equal(f.events.filter((e) => e.type === "auth_challenge").length, 1);
    f.setSignedIn(true);
    await f.plugin.auth.cancel();
    assert.equal(f.snapshot().auth?.state, "signed_in");
    await f.plugin.auth.begin();
    await new Promise((resolve) => setImmediate(resolve));
    await f.plugin.auth.logout();
    assert.equal(f.snapshot().auth?.state, "signed_out");
    assert.equal(f.requests.at(-2)?.stage, "codex.logout");
  } finally {
    await f.close();
  }
});

test("plugin settings persist in v2 KV storage and disable unwinds tools, skill paths, and tool guards", async () => {
  const f = fixture();
  const database = new DatabaseSync(":memory:");
  const host = new PluginHost(database, [codexDefinition({ directory: f.directory, runner: f.runner })]);
  try {
    assert.equal(host.contribution(context).tools.length, 2);
    assert.equal(host.contribution(context).skillPaths.length, 1);
    await host.configure("codex", false, { environment: "new-environment", branch: "dev" });
    assert.deepEqual(host.contribution(context), { tools: [], skillPaths: [] });
    assert.equal(
      await host.ai.evaluateToolCall({
        channel: "task",
        toolName: "codex_exec",
        approvalMode: "ask",
        arguments: { prompt: "x" },
      }),
      undefined,
    );
    const kvRow = database
      .prepare("SELECT value FROM plugin_kv_storage WHERE plugin_id = ? AND key = ?")
      .get("codex", "environment") as { value: string };
    assert.equal(JSON.parse(kvRow.value), "new-environment");
    await host.setEnabled("codex", true);
    assert.equal(host.contribution(context).tools.length, 2);
    assert.equal(host.snapshots()[0].configuration.branch, "dev");
  } finally {
    await host.close();
    database.close();
    await f.close();
  }
});

test("default runner refuses host execution and never invokes a Mac Codex", async () => {
  const runner = createCodexRunner({ directory: path.join(os.tmpdir(), "looi-codex-unused") });
  const receipt = await runner.run({ stage: "codex.version", args: ["--version"], timeoutMs: 1000 }).promise;
  assert.equal(receipt.state, "start_failed");
  assert.equal(receipt.failure?.code, "ERR_CODEX_GUEST_REQUIRED");
});

test("Cloud treats known pre-submission CLI failures separately from a running bridge failure", async () => {
  const f = fixture();
  try {
    const tool = f.plugin.tools(context).find((t) => t.name === "codex_cloud")!;
    f.setCloud({
      exitCode: 1,
      stderr: "environment 'missing' not found; run `codex cloud` to list available environments",
      failure: { stage: "cloud.submit", code: 1, reason: "Environment not found" },
    });
    assert.equal(
      payload(await tool.execute("missing-env", { prompt: "Fix import", environment: "missing" })).outcome,
      "not_submitted",
    );
    f.setCloud({
      state: "execution_failed",
      exitCode: -1,
      stderr: "pipe read failed",
      failure: { stage: "cloud.submit", code: "EIO", reason: "pipe read failed" },
    });
    const lost = payload(await tool.execute("bridge-error", { prompt: "Fix import" }));
    assert.equal(lost.outcome, "submission_unconfirmed");
    assert.equal(lost.failure.code, "EIO");
  } finally {
    await f.close();
  }
});

test("sign-out closes admission until the official logout process finishes", async () => {
  const f = fixture();
  const originalRun = f.runner.run.bind(f.runner);
  let release!: () => void;
  f.runner.run = (request) =>
    request.stage !== "codex.logout"
      ? originalRun(request)
      : {
          id: "logout-running",
          cancel() {},
          promise: new Promise((resolve) => {
            release = () =>
              resolve({
                id: "logout-running",
                stage: request.stage,
                args: request.args,
                state: "exited",
                exitCode: 0,
                stdout: "",
                stderr: "",
              });
          }),
        };
  try {
    await f.host.startPlugin("codex");
    const logout = f.plugin.auth.logout();
    await new Promise((resolve) => setImmediate(resolve));
    const blocked = payload(
      await f.plugin
        .tools(context)
        .find((t) => t.name === "codex_cloud")!
        .execute("during-logout", { prompt: "Fix import" }),
    );
    assert.equal(blocked.outcome, "not_submitted");
    assert.equal(blocked.execution.failure.code, "account_changing");
    assert.equal(f.requests.filter((r) => r.stage === "cloud.submit").length, 0);
    f.setSignedIn(false);
    release();
    await logout;
    assert.equal(f.snapshot().auth?.state, "signed_out");
  } finally {
    await f.close();
  }
});

test("unconfirmed cleanup remains failed and prevents account mutation", async () => {
  const f = fixture();
  try {
    f.setCloud({
      state: "stop_unconfirmed",
      exitCode: null,
      failure: { stage: "cloud.submit", code: "ERR_SHELL_CLEANUP", reason: "Guest process exit unconfirmed" },
    });
    const outcome = payload(
      await f.plugin
        .tools(context)
        .find((t) => t.name === "codex_cloud")!
        .execute("stuck", { prompt: "Fix import" }),
    );
    assert.equal(outcome.outcome, "submission_unconfirmed");
    await assert.rejects(f.plugin.auth.logout(), /Guest process exit unconfirmed/);
    assert.equal(f.requests.filter((r) => r.stage === "codex.logout").length, 0);
    await assert.rejects(f.host.setEnabled("codex", false), /Guest process exit unconfirmed/);
    assert.equal(f.snapshot().lifecycle, "failed");
  } finally {
    await f.close();
  }
});

test("cancelling login suppresses authorization links from trailing process output", async () => {
  const f = fixture();
  f.setSignedIn(false);
  const originalRun = f.runner.run.bind(f.runner);
  f.runner.run = (request) => {
    const handle = originalRun(request);
    if (request.stage === "codex.login") {
      const cancel = handle.cancel;
      handle.cancel = () => {
        request.onOutput?.("stderr", "https://auth.openai.com/oauth/authorize?state=late\n");
        cancel();
      };
    }
    return handle;
  };
  try {
    await f.plugin.auth.begin();
    await new Promise((resolve) => setImmediate(resolve));
    await f.plugin.auth.cancel();
    assert.equal(f.events.filter((e) => e.type === "auth_challenge").length, 0);
    assert.equal(f.snapshot().auth?.state, "signed_out");
  } finally {
    await f.close();
  }
});

test("a login cleanup failure ends the authorization challenge and retains its actual error", async () => {
  const f = fixture();
  f.setSignedIn(false);
  try {
    await f.plugin.auth.begin();
    await new Promise((resolve) => setImmediate(resolve));
    f.login().request.onOutput?.("stderr", "https://auth.openai.com/oauth/authorize?state=expired\n");
    assert.equal(f.snapshot().auth?.state, "authorizing");
    f.login().finish({
      state: "stop_unconfirmed",
      exitCode: null,
      failure: {
        stage: "codex.login",
        code: "ERR_SHELL_CLEANUP",
        reason: "Alpine iSH process cleanup was not confirmed",
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const snapshot = f.snapshot();
    assert.equal(snapshot.lifecycle, "failed");
    assert.equal(snapshot.auth?.state, "unavailable");
    assert.equal(snapshot.auth?.url, undefined);
    assert.equal(snapshot.lastError?.code, "ERR_SHELL_CLEANUP");
    assert.equal(snapshot.lastError?.stage, "codex.login");
  } finally {
    await f.close();
  }
});

test("CLI settings install the checked stable Linux package and update the active version", async (t) => {
  const version = "0.171.0";
  const tarball = `https://registry.npmjs.org/@openai/codex/-/codex-${version}-linux-arm64.tgz`;
  const calls = t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === tarball) return new Response(new Uint8Array([1, 2, 3]));
    return Response.json(url.endsWith("/latest")
      ? { version }
      : { dist: { tarball, integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}` } });
  });
  const f = fixture();
  try {
    await f.host.sendCommand("codex", { type: "check_cli_update" });
    assert.equal(f.snapshot().state.cliVersion, "0.167.2");
    assert.equal(f.snapshot().state.latestCliVersion, version);
    assert.equal(f.snapshot().state.cliUpdateAvailable, true);
    await f.host.sendCommand("codex", { type: "install_cli_update" });
    assert.deepEqual(calls.mock.calls.map((call) => call.arguments[0].split("/").at(-1)), [
      "latest", `${version}-linux-arm64`, `codex-${version}-linux-arm64.tgz`,
    ]);
    const [destination, digest, installedVersion] = f.requests.at(-1)!.args;
    assert.equal(path.dirname(destination!), f.directory);
    assert.equal(fs.existsSync(destination!), false);
    assert.equal(digest, "01".repeat(64));
    assert.equal(installedVersion, version);
    assert.equal(f.snapshot().state.cliVersion, version);
    assert.equal(f.snapshot().state.cliUpdateAvailable, false);
  } finally {
    await f.close();
  }
});

test("Current cloud environments remain selectable when the legacy directory is unavailable", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input);
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-token");
    assert.equal(new Headers(init.headers).get("ChatGPT-Account-Id"), "test-account");
    if (url.pathname === "/backend-api/wham/environments") {
      return new Response("Legacy service unavailable", { status: 503 });
    }
    if (url.searchParams.get("scope") === "workspace") {
      return Response.json({ data: [{ id: "team~asenvcfg_2", name: "Shared" }] });
    }
    if (!url.searchParams.has("cursor")) {
      return Response.json({ data: [{ id: "asenvcfg_base", name: "Default" }], next_cursor: "a+b" });
    }
    assert.equal(url.searchParams.get("cursor"), "a+b");
    return Response.json({ data: [{ id: "team~asenvcfg_1", name: "video2rig" }] });
  });
  const f = fixture();
  try {
    await f.host.sendCommand("codex", { type: "load_cloud_environments" });
    assert.deepEqual(f.snapshot().state.cloudEnvironments, [
      { id: "team~asenvcfg_1", name: "video2rig", scope: "user" },
      { id: "team~asenvcfg_2", name: "Shared", scope: "workspace" },
    ]);
    assert.deepEqual(f.snapshot().lastError, {
      stage: "cloud.directory.legacy", code: 503, reason: "Legacy service unavailable",
    });
    assert.ok(!JSON.stringify(f.events).includes("test-token"));
    const tool = f.plugin.tools(context).find((candidate) => candidate.name === "codex_cloud")!;
    const outcome = payload(await tool.execute("current-env", { prompt: "Fix imports", environment: "team~asenvcfg_1" }));
    assert.equal(outcome.outcome, "not_submitted");
    assert.equal(outcome.failure.code, "ERR_CODEX_CLOUD_ENVIRONMENT_UNSUPPORTED");
    assert.ok(!f.requests.some((request) => request.stage === "cloud.submit"));
  } finally {
    await f.close();
  }
});
