import { AcceptanceRunner } from "../../looi-runtime/src/acceptance/runner.js";
import { PiAgentExecutor } from "../../looi-runtime/src/agent/pi-executor.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SqliteRuntimeStore } from "../../looi-runtime/src/storage/sqlite.js";
import { createLangfuseTracer } from "../../looi-runtime/src/telemetry/langfuse.js";
import {
  type UserActionRef,
} from "../../contracts/src/index.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  resolveTranscript,
} from "@earendil-works/pi-ai";
import fs from "node:fs";
import { assert, equal } from "./assert.js";

const report = await new AcceptanceRunner().runFullSuite();
equal(report.totalCases, 33);
equal(
  report.passedCases,
  33,
  JSON.stringify(report.cases.filter((item) => !item.passed)),
);
assert(report.success);
equal(report.hardGates, {
  unauthorizedActions: 0,
  unverifiedCompletions: 0,
});
const databasePath = "/home/looi-business.sqlite";
let storage = new SqliteRuntimeStore(new DatabaseSync(databasePath));
const localTracer = createLangfuseTracer({ onObservation: node => storage.saveObservation(node) });
const taskId = `task_nsh_business_${randomUUID()}`;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const executor = new PiAgentExecutor({
  tracer: localTracer,
  stateDirectory: "/home/looi-runtime-test",
  workspaceRoot: "/workspace/looi-runtime-test",
  modelSpec: faux.getModel(),
  modelsRegistry: models, streamFn: models.streamSimple.bind(models),
  requireApprovalForAllWrites: true,
  approvalUiSessionId: "nsh_test",
  taskPersistence: storage.tasks,
  deadlineMs: 5000,
});
let approvals = 0;
let previousApproval: UserActionRef | undefined;
faux.setResponses([
  fauxAssistantMessage(
    fauxToolCall("write", { path: "proof.txt", content: "native LOOI\n" }),
    { stopReason: "toolUse" },
  ),
  (context: any) => {
    const previous = resolveTranscript(context, undefined).messages.at(-1);
    assert(
      previous?.role === "toolResult" && !previous.isError,
      JSON.stringify(previous),
    );
    return fauxAssistantMessage(
      fauxToolCall("bash", {
        command: "echo shell-write > shell-proof.txt && cat proof.txt",
      }),
      { stopReason: "toolUse" },
    );
  },
  (context: any) => {
    const previous = resolveTranscript(context, undefined).messages.at(-1);
    assert(
      previous?.role === "toolResult" && !previous.isError,
      JSON.stringify(previous),
    );
    return fauxAssistantMessage("File verified");
  },
]);
try {
  const result = await executor.run("Write a workspace file and verify it", {
    taskId: taskId,
    onStep(event) {
      if (event.phase === "awaiting_approval" && event.interaction) {
        const now = Date.now();
        const action = {
          event_id: `native_tap_${event.interaction.id}`,
          ui_session_id: "nsh_test",
          kind: "tap" as const,
          captured_at: new Date(now).toISOString(),
          expires_at: new Date(now + 10000).toISOString(),
        };
        for (const invalid of [
          undefined,
          previousApproval,
          { ...action, kind: "voice_command" as const },
          { ...action, expires_at: new Date(now - 1).toISOString() },
          { ...action, ui_session_id: "other_screen" },
        ]) {
          let rejected = false;
          try {
            executor.respond(taskId, event.interaction.id, {
              outcome: "allowed-once",
              userAction: invalid,
            });
          } catch {
            rejected = true;
          }
          assert(rejected, "untrusted UI approval reached the tool");
        }
        approvals++;
        executor.respond(taskId, event.interaction.id, {
          outcome: "allowed-once",
          userAction: action,
        });
        previousApproval = action;
      }
    },
  });
  equal(approvals, 2);
  equal(
    fs.readFileSync("/workspace/looi-runtime-test/shell-proof.txt", "utf8"),
    "shell-write\n",
  );
  assert(result.runtimeExited);
  equal(result.executions?.[0].exitCode, 0);
  assert(result.artifacts?.some((item) => item.path === "proof.txt"));
  equal(
    fs.readFileSync("/workspace/looi-runtime-test/proof.txt", "utf8"),
    "native LOOI\n",
  );
  equal(executor.getTask(result.taskId)?.state, "succeeded");
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", { path: "auto.txt", content: "automatic\n" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("bash", { command: "cat auto.txt > auto-copy.txt" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Automatic task finished"),
  ]);
  let automaticApprovals = 0;
  const automatic = await executor.run("Write and copy without prompts", {
    taskId: `${taskId}_automatic`,
    approvalMode: "local_auto",
    onStep(event) {
      if (event.phase === "awaiting_approval") automaticApprovals++;
    },
  });
  equal(automaticApprovals, 0);
  equal(automatic.executions?.[0].exitCode, 0);
  equal(fs.readFileSync("/workspace/looi-runtime-test/auto-copy.txt", "utf8"), "automatic\n");
} finally {
  await executor.close();
  storage.close();
}
storage = new SqliteRuntimeStore(new DatabaseSync(databasePath));
const tracedTask = storage.tasks.load().find(task => task.id === taskId)!;
assert(Boolean(tracedTask.trace));
const localTrace = storage.traceObservations(tracedTask.trace!.traceId);
assert(localTrace.some(node => node.name === "agent.context"));
assert(localTrace.some(node => node.name === "llm.chat" && node.endedAt !== undefined));
await localTracer.shutdown();
equal(
  storage.tasks.load().find((task) => task.id === taskId)?.state,
  "succeeded",
);
const sessionId = executor.getTask(taskId)!.sessionId;
const sessionFile = SessionManager.findById(
  "/workspace/looi-runtime-test", sessionId, "/home/looi-runtime-test/sessions",
);
assert(sessionFile?.endsWith(`_${sessionId}.jsonl`), "runtime writes a Pi JSONL session");
const sessionMessages = SessionManager.open(sessionFile!).buildSessionContext().messages;
assert(sessionMessages.some(message => message.role === "toolResult"));
const reopened = new PiAgentExecutor({
  stateDirectory: "/home/looi-runtime-test", workspaceRoot: "/workspace/looi-runtime-test",
  modelSpec: faux.getModel(), modelsRegistry: models, streamFn: models.streamSimple.bind(models), taskPersistence: storage.tasks,
});
try {
  faux.setResponses([context => {
    const history = resolveTranscript(context, undefined).messages;
    assert(history.some(message => message.role === "toolResult"));
    assert(JSON.stringify(history).includes("proof.txt"));
    return fauxAssistantMessage("Recovered JSONL conversation");
  }]);
  const followUp = await reopened.run("Continue the previous task", { sessionId });
  equal(followUp.answer, "Recovered JSONL conversation");
  equal(SessionManager.findById("/workspace/looi-runtime-test", sessionId, "/home/looi-runtime-test/sessions"), sessionFile);
} finally {
  await reopened.close();
}
storage.close();
// A non-cooperative async tool must not turn a stop deadline into a false exit.
const stubbornFaux = fauxProvider(),
  stubbornModels = createModels();
stubbornModels.setProvider(stubbornFaux.provider);
stubbornFaux.setResponses([
  fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
]);
let release!: () => void, entered!: () => void;
const held = new Promise<void>((resolve) => {
    release = resolve;
  }),
  started = new Promise<void>((resolve) => {
    entered = resolve;
  });
const stubborn = new PiAgentExecutor({
  stateDirectory: "/home/looi-stop-test",
  workspaceRoot: "/workspace/looi-stop-test",
  modelSpec: stubbornFaux.getModel(),
  modelsRegistry: stubbornModels, streamFn: stubbornModels.streamSimple.bind(stubbornModels),
  stopGraceMs: 15,
  customTools: [
    {
      name: "hold",
      label: "hold",
      description: "non-cooperative test tool",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        entered();
        await held;
        return { content: [{ type: "text", text: "late" }], details: {} };
      },
    },
  ],
});
const stoppedTask = `stop_${randomUUID()}`;
const stalled = stubborn.run("hold", { taskId: stoppedTask }).then(
  () => false,
  () => true,
);
await started;
equal(await stubborn.cancel(stoppedTask), {
  state: "unknown",
  runtimeExited: false,
  confirmed: false,
});
let closeRejected = false;
try {
  await stubborn.close();
} catch {
  closeRejected = true;
}
assert(closeRejected, "close fabricated an exit receipt");
release();
assert(await stalled);
equal(stubborn.getTask(stoppedTask)?.state, "unknown");
console.log(
  "PASS portable LOOI runtime: 33 behavioral contracts, enforced UI approval, real Pi tool/file/shell evidence, SQLite task reopen and honest unconfirmed stop",
);

// A native cleanup failure is not evidence that the guest descendants exited.
const shellWait = globalThis.__nsh_shell_wait!;
const cleanupFaux = fauxProvider(), cleanupModels = createModels();
cleanupModels.setProvider(cleanupFaux.provider);
cleanupFaux.setResponses([
  fauxAssistantMessage(fauxToolCall("bash",{command:"true"}),{stopReason:"toolUse"}),
  fauxAssistantMessage("Finished"),
]);
const cleanupExecutor = new PiAgentExecutor({stateDirectory:"/home/cleanup-receipt-probe",workspaceRoot:"/workspace",modelSpec:cleanupFaux.getModel(),modelsRegistry:cleanupModels,streamFn:cleanupModels.streamSimple.bind(cleanupModels)});
try {
  globalThis.__nsh_shell_wait = async request => {
    await shellWait(request);
    return JSON.stringify({error:"ERR_SHELL_CLEANUP: process cleanup was not confirmed"});
  };
  let rejected = false;
  try { await cleanupExecutor.run("run",{taskId:"unconfirmed-native-cleanup",approvalMode:"yolo"}); }
  catch { rejected = true; }
  assert(rejected,"unconfirmed native cleanup produced a successful task");
  equal(cleanupExecutor.getTask("unconfirmed-native-cleanup")?.state,"unknown");
  equal(cleanupExecutor.getTask("unconfirmed-native-cleanup")?.runtimeExited,false);
  equal(cleanupExecutor.getTask("unconfirmed-native-cleanup")?.result?.runtimeExited,false);
} finally { globalThis.__nsh_shell_wait = shellWait; await cleanupExecutor.close(); }
console.log("PASS native cleanup uncertainty stays unknown and runtimeExited false");
