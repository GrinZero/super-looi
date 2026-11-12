import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CodexPlugin, codexDefinition } from "../runtime/plugins/codex/index.js";
import { PluginHost } from "../runtime/plugins/host.js";
import { createCodexRunner, type CliHandle, type CliRequest, type CliRunner } from "../runtime/plugins/codex/process.js";
import type { CliReceipt, PluginEvent } from "../runtime/plugins/contracts.js";

const context = { taskId: "task-1", workspaceRoot: "/workspace/repo", approvalMode: "yolo" as const, commandTimeoutMs: 30_000 };
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "looi-codex-"));
  const requests: CliRequest[] = [];
  const pending = new Set<CliHandle>();
  const events: PluginEvent[] = [];
  let enabled = true, signedIn = true;
  let login: { request: CliRequest; finish: (receipt?: Partial<CliReceipt>) => void } | undefined;
  let cloud: Partial<CliReceipt> = { stdout: "https://chatgpt.com/codex/tasks/task_cloud_1\n" };
  let exec: Partial<CliReceipt> = {};
  const runner: CliRunner = {
    run(request) {
      requests.push(request);
      let finish!: (patch?: Partial<CliReceipt>) => void;
      const handle: CliHandle = { id: `call-${requests.length}`, cancel() { finish({ state: "cancelled", exitCode: null }); }, promise: new Promise(resolve => {
        finish = patch => resolve({ id: `call-${requests.length}`, stage: request.stage, args: request.args, state: "exited", exitCode: 0, stdout: "", stderr: "", ...patch });
      }) };
      pending.add(handle);
      void handle.promise.then(() => pending.delete(handle));
      queueMicrotask(() => {
        if (request.stage === "codex.version") finish({ stdout: "codex-cli 0.167.2\n" });
        else if (request.stage === "codex.account") finish(signedIn ? { stderr: "Logged in using ChatGPT\n" } : { exitCode: 1, stderr: "Not logged in\n" });
        else if (request.stage === "codex.login") login = { request, finish };
        else if (request.stage === "codex.logout") { signedIn = false; finish(); }
        else if (request.stage === "cloud.submit") finish(cloud);
        else if (request.stage === "codex.exec") {
          const output = JSON.stringify({ type: "thread.started", thread_id: "session-codex-1" }) + "\n" + JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Prepared the environment." } }) + "\n" + JSON.stringify({ type: "turn.completed" }) + "\n";
          request.onOutput?.("stdout", output.slice(0, 13)); request.onOutput?.("stdout", output.slice(13));
          finish({ stdout: output, ...exec });
        }
      });
      return handle;
    },
    async stop() { const calls = [...pending]; calls.forEach(call => call.cancel()); await Promise.all(calls.map(call => call.promise)); },
  };
  const plugin = new CodexPlugin({ directory, runner, enabled: () => enabled, configuration: {}, publish: event => events.push(event) });
  return { directory, runner, plugin, requests, events, setEnabled: (value: boolean) => { enabled = value; }, setSignedIn: (value: boolean) => { signedIn = value; }, login: () => login!, setCloud: (patch: Partial<CliReceipt>) => { cloud = patch; }, setExec: (patch: Partial<CliReceipt>) => { exec = patch; }, async close() { await plugin.stop("app_shutdown"); fs.rmSync(directory, { recursive: true, force: true }); } };
}
const payload = (value: any) => JSON.parse(value.content.find((part: any) => part.type === "text").text);

test("EXEC delegates a prompt, streams full answers and continues the explicit Codex session", async () => {
  const f = fixture();
  try {
    const tool = f.plugin.tools(context).find(tool => tool.name === "codex_exec")!;
    const outcome = payload(await tool.execute("exec-1", { prompt: "Create a cloud environment", cwd: "/workspace/setup" }));
    assert.equal(outcome.outcome, "completed"); assert.equal(outcome.sessionId, "session-codex-1"); assert.equal(outcome.answer, "Prepared the environment.");
    const request = f.requests.find(request => request.stage === "codex.exec")!;
    assert.equal(request.cwd, "/workspace/setup"); assert.ok(request.args.includes("Create a cloud environment")); assert.ok(!request.args.includes("cloud"));
    await tool.execute("exec-2", { prompt: "Continue setup", sessionId: outcome.sessionId });
    const next = f.requests.at(-1)!; assert.ok(next.args.includes("resume")); assert.ok(next.args.includes(outcome.sessionId)); assert.ok(!next.args.includes("--last"));
  } finally { await f.close(); }
});

test("Cloud starts directly with defaults and returns a distinct accepted task ID", async () => {
  const f = fixture();
  try {
    const tool = f.plugin.tools(context).find(tool => tool.name === "codex_cloud")!;
    const outcome = payload(await tool.execute("cloud-1", { prompt: "Fix video import" }));
    assert.equal(outcome.outcome, "accepted"); assert.equal(outcome.task.id, "task_cloud_1"); assert.equal(outcome.sessionId, undefined);
    assert.deepEqual(f.requests.at(-1)!.args, ["cloud", "exec", "--env", "video2rig", "--branch", "main", "--", "Fix video import"]);
    assert.equal(f.requests.filter(request => request.stage === "codex.exec").length, 0);
  } finally { await f.close(); }
});

test("Cloud distinguishes configuration, explicit service rejection, and lost submission receipts without retrying", async () => {
  const f = fixture();
  try {
    const tool = f.plugin.tools(context).find(tool => tool.name === "codex_cloud")!;
    await f.plugin.configure({ environment: "", branch: "main" });
    const missing = payload(await tool.execute("missing", { prompt: "Fix it" }));
    assert.equal(missing.outcome, "not_submitted"); assert.equal(missing.execution.state, "not_started"); assert.equal(f.requests.length, 0);
    f.setCloud({ exitCode: 1, stderr: "HTTP status client error (403 Forbidden) for url (https://chatgpt.com/backend-api/wham/tasks)", failure: { stage: "cloud.submit", code: 403, reason: "HTTP 403 Forbidden" } });
    const rejected = payload(await tool.execute("denied", { prompt: "Fix it", environment: "video2rig" }));
    assert.equal(rejected.outcome, "not_submitted"); assert.equal(rejected.failure.code, 403); assert.equal(rejected.execution.exitCode, 1);
    f.setCloud({ state: "timed_out", exitCode: null, failure: { stage: "cloud.submit", reason: "Request deadline elapsed" } });
    const unknown = payload(await tool.execute("lost", { prompt: "Fix it", environment: "video2rig" }));
    assert.equal(unknown.outcome, "submission_unconfirmed"); assert.equal(unknown.execution.state, "timed_out");
    assert.equal(f.requests.filter(request => request.stage === "cloud.submit").length, 2);
  } finally { await f.close(); }
});

test("cancelled login re-reads credentials already committed by the CLI; logout cannot be overwritten", async () => {
  const f = fixture(); f.setSignedIn(false);
  try {
    await f.plugin.auth.begin();
    await new Promise(resolve => setImmediate(resolve));
    f.login().request.onOutput?.("stderr", "Open this URL:\nhttps://auth.openai.com/oauth/authorize?state=");
    assert.equal(f.events.filter(event => event.type === "auth_challenge").length, 0);
    f.login().request.onOutput?.("stderr", "complete\n");
    assert.equal(f.events.filter(event => event.type === "auth_challenge").length, 1);
    f.setSignedIn(true); await f.plugin.auth.cancel();
    assert.equal(f.plugin.snapshot().auth?.state, "signed_in");
    await f.plugin.auth.begin(); await new Promise(resolve => setImmediate(resolve));
    await f.plugin.auth.logout();
    assert.equal(f.plugin.snapshot().auth?.state, "signed_out");
    assert.equal(f.requests.at(-2)?.stage, "codex.logout");
  } finally { await f.close(); }
});

test("plugin settings persist and disable removes both tools and Skill from later tasks", async () => {
  const f = fixture(); const database = new DatabaseSync(":memory:");
  const host = new PluginHost(database, [codexDefinition({ directory: f.directory, runner: f.runner })]);
  try {
    assert.equal(host.contribution(context).tools.length, 2); assert.equal(host.contribution(context).skillPaths.length, 1);
    await host.configure("codex", false, { environment: "new-environment", branch: "dev" });
    assert.deepEqual(host.contribution(context), { tools: [], skillPaths: [] });
    const saved = JSON.parse(String(database.prepare("SELECT configuration FROM plugin_settings WHERE id = ?").get("codex")!.configuration));
    assert.equal(saved.environment, "new-environment");
    await host.configure("codex", true, saved); assert.equal(host.contribution(context).tools.length, 2);
    assert.equal(host.snapshots()[0].configuration.branch, "dev");
  } finally { await host.close(); database.close(); await f.close(); }
});

test("default runner refuses host execution and never invokes a Mac Codex", async () => {
  const runner = createCodexRunner({ directory: path.join(os.tmpdir(), "looi-codex-unused") });
  const receipt = await runner.run({ stage: "codex.version", args: ["--version"], timeoutMs: 1000 }).promise;
  assert.equal(receipt.state, "start_failed"); assert.equal(receipt.failure?.code, "ERR_CODEX_GUEST_REQUIRED");
});

test("Cloud treats known pre-submission CLI failures separately from a running bridge failure", async () => {
  const f = fixture();
  try {
    const tool = f.plugin.tools(context).find(tool => tool.name === "codex_cloud")!;
    f.setCloud({ exitCode: 1, stderr: "environment 'missing' not found; run `codex cloud` to list available environments", failure: { stage: "cloud.submit", code: 1, reason: "Environment not found" } });
    assert.equal(payload(await tool.execute("missing-env", { prompt: "Fix import", environment: "missing" })).outcome, "not_submitted");
    f.setCloud({ state: "execution_failed", exitCode: -1, stderr: "pipe read failed", failure: { stage: "cloud.submit", code: "EIO", reason: "pipe read failed" } });
    const lost = payload(await tool.execute("bridge-error", { prompt: "Fix import" }));
    assert.equal(lost.outcome, "submission_unconfirmed"); assert.equal(lost.failure.code, "EIO");
  } finally { await f.close(); }
});

test("sign-out closes admission until the official logout process finishes", async () => {
  const f = fixture(); const originalRun = f.runner.run.bind(f.runner);
  let release!: () => void;
  f.runner.run = request => request.stage !== "codex.logout" ? originalRun(request) : {
    id: "logout-running", cancel() {}, promise: new Promise(resolve => { release = () => resolve({ id: "logout-running", stage: request.stage, args: request.args, state: "exited", exitCode: 0, stdout: "", stderr: "" }); }),
  };
  try {
    await f.plugin.start();
    const logout = f.plugin.auth.logout(); await new Promise(resolve => setImmediate(resolve));
    const blocked = payload(await f.plugin.tools(context).find(tool => tool.name === "codex_cloud")!.execute("during-logout", { prompt: "Fix import" }));
    assert.equal(blocked.outcome, "not_submitted"); assert.equal(blocked.execution.failure.code, "account_changing");
    assert.equal(f.requests.filter(request => request.stage === "cloud.submit").length, 0);
    f.setSignedIn(false); release(); await logout;
    assert.equal(f.plugin.snapshot().auth?.state, "signed_out");
  } finally { await f.close(); }
});

test("unconfirmed cleanup remains failed and prevents account mutation", async () => {
  const f = fixture();
  try {
    f.setCloud({ state: "stop_unconfirmed", exitCode: null, failure: { stage: "cloud.submit", code: "ERR_SHELL_CLEANUP", reason: "Guest process exit unconfirmed" } });
    const outcome = payload(await f.plugin.tools(context).find(tool => tool.name === "codex_cloud")!.execute("stuck", { prompt: "Fix import" }));
    assert.equal(outcome.outcome, "submission_unconfirmed");
    await assert.rejects(f.plugin.auth.logout(), /Guest process exit unconfirmed/);
    assert.equal(f.requests.filter(request => request.stage === "codex.logout").length, 0);
    await assert.rejects(f.plugin.stop("disabled"), /Guest process exit unconfirmed/);
    assert.equal(f.plugin.snapshot().lifecycle, "failed");
  } finally { try { await f.plugin.stop("app_shutdown"); } catch {} fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("cancelling login suppresses authorization links from trailing process output", async () => {
  const f = fixture(); f.setSignedIn(false); const originalRun = f.runner.run.bind(f.runner);
  f.runner.run = request => {
    const handle = originalRun(request);
    if (request.stage === "codex.login") {
      const cancel = handle.cancel;
      handle.cancel = () => { request.onOutput?.("stderr", "https://auth.openai.com/oauth/authorize?state=late\n"); cancel(); };
    }
    return handle;
  };
  try {
    await f.plugin.auth.begin(); await new Promise(resolve => setImmediate(resolve));
    await f.plugin.auth.cancel();
    assert.equal(f.events.filter(event => event.type === "auth_challenge").length, 0);
    assert.equal(f.plugin.snapshot().auth?.state, "signed_out");
  } finally { await f.close(); }
});
