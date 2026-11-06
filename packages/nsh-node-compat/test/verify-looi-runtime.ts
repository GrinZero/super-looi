import { AcceptanceRunner } from "../../looi-runtime/src/acceptance/runner.js";
import { PiAgentExecutor } from "../../looi-runtime/src/agent/pi-executor.js";
import { MemoryLedgerService } from "../../looi-runtime/src/memory/ledger.js";
import { SqliteRuntimeStore } from "../../looi-runtime/src/storage/sqlite.js";
import {
  createMemoryClaim,
  type UserActionRef,
} from "../../contracts/src/index.js";
import { DatabaseSync } from "node:sqlite";
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
equal(report.totalCases, 48);
equal(
  report.passedCases,
  48,
  JSON.stringify(report.cases.filter((item) => !item.passed)),
);
assert(report.success);
equal(report.hardGates, {
  unauthorizedActions: 0,
  crossSubjectLeaks: 0,
  zombieResurrections: 0,
  unverifiedCompletions: 0,
});
const databasePath = "/home/looi-business.sqlite";
let storage = new SqliteRuntimeStore(new DatabaseSync(databasePath));
let ledger = new MemoryLedgerService(storage.ledger);
const generation = ledger.getDeletionGeneration();
const taskId = `task_nsh_business_${generation}`;
const evidence = `evidence_${generation}`;
const claim = createMemoryClaim({
  claim_id: `claim_${generation}`,
  predicate: "personal_note",
  object: { text: "native persisted memory" },
  status: "confirmed",
  source_kind: "authenticated_user_statement",
  evidence_ids: [evidence],
  derivation_roots: [evidence],
  deletion_generation: generation,
});
await ledger.upsertClaim(claim);
const oldBackup = ledger.exportSnapshot();
await ledger.deleteEvidenceSource(evidence);
storage.close();
storage = new SqliteRuntimeStore(new DatabaseSync(databasePath));
ledger = new MemoryLedgerService(storage.ledger);
ledger.restoreSnapshot(oldBackup);
equal((await ledger.getClaim(claim.claim_id))?.status, "retracted");
equal(ledger.getDeletionGeneration(), generation + 1);
let staleRejected = false;
try {
  await ledger.commitDerivedWrite(
    { ...claim, claim_id: "late_claim" },
    {
      scope_id: "scope_household_default",
      capture_epoch: 1,
      deletion_generation: generation,
    },
  );
} catch {
  staleRejected = true;
}
assert(staleRejected, "old backup resurrected deleted evidence");
const fresh = createMemoryClaim({
  ...claim,
  claim_id: `fresh_${generation}`,
  evidence_ids: [`fresh_evidence_${generation}`],
  derivation_roots: [],
  deletion_generation: generation + 1,
});
await ledger.upsertClaim(fresh);
storage.close();
storage = new SqliteRuntimeStore(new DatabaseSync(databasePath));
ledger = new MemoryLedgerService(storage.ledger);
equal((await ledger.getClaim(fresh.claim_id))?.object, {
  text: "native persisted memory",
});
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const executor = new PiAgentExecutor({
  stateDirectory: "/home/looi-runtime-test",
  workspaceRoot: "/workspace/looi-runtime-test",
  modelSpec: faux.getModel(),
  streamFn: models.streamSimple.bind(models),
  requireApprovalForAllWrites: true,
  approvalUiSessionId: "nsh_test",
  taskPersistence: storage.tasks,
  deadlineMs: 5000,
});
let approvals = 0;
let previousApproval: UserActionRef | undefined;
faux.setResponses([
  fauxAssistantMessage(
    fauxToolCall("write_file", { path: "proof.txt", content: "native LOOI\n" }),
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
} finally {
  await executor.close();
  storage.close();
}
storage = new SqliteRuntimeStore(new DatabaseSync(databasePath));
equal(
  storage.tasks.load().find((task) => task.id === taskId)?.state,
  "succeeded",
);
storage.close();
console.log(
  "PASS portable LOOI runtime: 48 behavioral contracts, enforced UI approval, real Pi tool/file/shell evidence, SQLite memory/task reopen and tombstone-safe backup restore",
);
