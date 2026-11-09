import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { PiAgentExecutor } from "../src/agent/pi-executor.js";
import { utf8Tail } from "../src/agent/shell-output.js";

function fixture(command: string, config: { commandTimeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "looi-shell-"));
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", {command}), {stopReason:"toolUse"}),
    fauxAssistantMessage("Finished"),
  ]);
  const executor = new PiAgentExecutor({
    stateDirectory:join(root,"state"), workspaceRoot:join(root,"workspace"),
    modelSpec:faux.getModel(), streamFn:models.streamSimple.bind(models), ...config,
  });
  return {executor, async close() { await executor.close(); rmSync(root,{recursive:true,force:true}); }};
}

test("shell streams before completion and preserves UTF-8 output tails", async () => {
  const f = fixture("printf '中文'; sleep 0.04; printf 'tail'; printf 'stderr-tail' >&2");
  const chunks: string[] = [];
  let finished = false, streamedBeforeCompletion = false;
  try {
    const result = await f.executor.run("run", {approvalMode:"yolo", onShellOutput(event) {
      if (event.stream !== "status") { chunks.push(event.chunk); streamedBeforeCompletion ||= !finished; }
    }});
    finished = true;
    assert.ok(streamedBeforeCompletion);
    assert.equal(chunks.join(""), "中文tailstderr-tail");
    assert.equal(result.executions?.[0].stdout, "中文tail");
    assert.equal(result.executions?.[0].stderr, "stderr-tail");
    assert.equal(result.executions?.[0].timedOut, false);
    assert.equal(utf8Tail("中".repeat(4000)+"尾", 8192), "中".repeat(2729)+"尾");
    assert.ok(Buffer.byteLength(utf8Tail("中".repeat(4000),8192)) <= 8192);
  } finally { await f.close(); }
});

test("cancel retains output written by a SIGTERM cleanup handler", async () => {
  const f = fixture("trap 'printf cleanup-tail; exit 0' TERM; printf ready; while :; do sleep 0.02; done");
  let cancel: Promise<unknown> | undefined;
  try {
    const run = f.executor.run("run", {taskId:"cancel-tail", approvalMode:"yolo",onShellOutput(event) {
      if (event.chunk.includes("ready") && !cancel) cancel = f.executor.cancel("cancel-tail");
    }});
    await assert.rejects(run);
    await cancel;
    const task = f.executor.getTask("cancel-tail");
    assert.equal(task?.state, "cancelled");
    assert.ok(task?.result?.executions?.[0].stdout?.includes("cleanup-tail"));
    assert.equal(task?.result?.executions?.[0].aborted, true);
  } finally { await f.close(); }
});

test("command timeout and explicit exit 124 keep distinct receipts", async () => {
  for (const [command, timedOut] of [["printf before-timeout; sleep 5", true], ["exit 124", false]] as const) {
    const f = fixture(command, {commandTimeoutMs:40});
    try {
      const result = await f.executor.run("run", {approvalMode:"yolo"});
      assert.equal(result.executions?.[0].timedOut, timedOut);
      if (timedOut) assert.equal(result.executions?.[0].stdout, "before-timeout");
      else assert.equal(result.executions?.[0].exitCode,124);
    } finally { await f.close(); }
  }
});

test("local_auto requests approval for guest package and global npm changes", async () => {
  for (const command of ["apk add git", "apk del git", "npm install -g pnpm", "pnpm add --global typescript", "printf x > /usr/bin/looi-policy-probe", "rm /bin/looi-policy-probe"]) {
    const f = fixture(command);
    let asked = false;
    try {
      await f.executor.run("install", {approvalMode:"local_auto",onStep(event) {
        if (event.interaction?.kind !== "approval") return;
        asked = true;
        f.executor.respond(event.taskId!,event.interaction.id,{outcome:"rejected"});
      }});
      assert.ok(asked, command);
      assert.equal(f.executor.listTasks()[0].result?.executions?.length ?? 0,0);
    } finally { await f.close(); }
  }
});

test("dangling and external links do not stop the remaining artifact scan", async () => {
  const f = fixture("ln -s missing a-broken; ln -s /usr/bin/python3 b-external; printf data > z-good");
  try {
    const result = await f.executor.run("scan",{approvalMode:"yolo"});
    assert.ok(result.artifacts?.some(item=>item.path==="z-good"));
  } finally { await f.close(); }
});
