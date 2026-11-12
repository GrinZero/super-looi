import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  resolveTranscript,
} from "@earendil-works/pi-ai";
import { PiAgentExecutor } from "../src/agent/pi-executor.js";
import { taskNeedsReview } from "../src/agent/executor.js";
import { AgentTaskStore } from "../src/agent/task-store.js";

test("conversation history survives new task IDs and executor restart without crossing sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-chat-"));
  const faux = fauxProvider(),
    models = createModels();
  models.setProvider(faux.provider);
  const make = () =>
    new PiAgentExecutor({
      stateDirectory: join(root, "state"),
      workspaceRoot: join(root, "work"),
      modelSpec: faux.getModel(),
      modelsRegistry: models, streamFn: models.streamSimple.bind(models),
    });
  let executor = make();
  try {
    faux.setResponses([fauxAssistantMessage("The code is ORCHID.")]);
    const first = await executor.run("Remember the code ORCHID", {
      sessionId: "chat_one",
    });
    await executor.close();
    executor = make();
    let restored = false;
    faux.setResponses([
      (context: any) => {
        const messages = resolveTranscript(context, undefined).messages.filter(
          (message) => message.role !== "system",
        );
        restored =
          messages.length === 3 &&
          JSON.stringify(messages[0]).includes("ORCHID") &&
          JSON.stringify(messages[1]).includes("ORCHID");
        return fauxAssistantMessage("ORCHID");
      },
    ]);
    const second = await executor.run("What was the code?", {
      sessionId: "chat_one",
    });
    assert.ok(restored);
    assert.notEqual(first.taskId, second.taskId);
    assert.equal(first.sessionId, second.sessionId);
    assert.equal(
      executor.getTask(first.taskId)?.prompt,
      "Remember the code ORCHID",
    );
    let isolated = false;
    faux.setResponses([
      (context: any) => {
        isolated =
          resolveTranscript(context, undefined).messages.filter(
            (message) => message.role !== "system",
          ).length === 1;
        return fauxAssistantMessage("New conversation");
      },
    ]);
    await executor.run("Hello", { sessionId: "chat_two" });
    assert.ok(isolated);
    await assert.rejects(
      executor.run("Wrong workspace", {
        sessionId: "chat_one",
        workspaceRoot: join(root, "other"),
      }),
      /conversation workspace/,
    );
    await assert.rejects(
      executor.run("Wrong session", {
        taskId: first.taskId,
        sessionId: "chat_two",
        resume: true,
      }),
      /persisted task session/,
    );
    faux.setResponses([
      fauxAssistantMessage("Custom one"),
      fauxAssistantMessage("Custom two"),
      fauxAssistantMessage("Custom resume"),
    ]);
    await executor.run("Custom first", {
      sessionId: "custom_chat",
      workspaceRoot: join(root, "custom"),
    });
    const custom = await executor.run("Custom next", {
      sessionId: "custom_chat",
      workspaceRoot: join(root, "custom"),
    });
    const resumed = await executor.run("Continue custom", {
      taskId: custom.taskId,
      resume: true,
    });
    assert.equal(resumed.sessionId, "custom_chat");
  } finally {
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("conversation admission rejects concurrent turns and unresolved crash outcomes", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-chat-guard-"));
  const faux = fauxProvider(),
    models = createModels();
  models.setProvider(faux.provider);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const config = {
    stateDirectory: join(root, "state"),
    workspaceRoot: join(root, "work"),
    modelSpec: faux.getModel(),
    modelsRegistry: models, streamFn: models.streamSimple.bind(models),
  };
  const executor = new PiAgentExecutor(config);
  try {
    faux.setResponses([fauxAssistantMessage("Cached")]);
    const cached = await executor.run("Cached turn", {
      sessionId: "shared",
      taskId: "cached",
    });
    faux.setResponses([
      async () => {
        await held;
        return fauxAssistantMessage("Done");
      },
    ]);
    const first = executor.run("First", {
      sessionId: "shared",
      taskId: "first",
    });
    await assert.rejects(
      executor.run("Second", { sessionId: "shared" }),
      /active task/,
    );
    assert.deepEqual(
      await executor.run("Cached turn", {
        sessionId: "shared",
        taskId: "cached",
      }),
      cached,
    );
    release();
    await first;
    const crashed = {
      ...executor.getTask("first")!,
      id: "crashed",
      state: "running" as const,
      result: undefined,
    };
    const recovered = new PiAgentExecutor({
      ...config,
      taskPersistence: {
        load: () => [crashed, executor.getTask("cached")!],
        save: () => {},
      },
    });
    try {
      await assert.rejects(
        recovered.run("Continue", { sessionId: "shared" }),
        /unverified task outcome/,
      );
      assert.deepEqual(
        await recovered.run("Cached turn", {
          sessionId: "shared",
          taskId: "cached",
        }),
        cached,
      );
    } finally {
      await recovered.close();
    }
  } finally {
    release();
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("human review survives restart and releases the conversation without changing execution evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-chat-review-"));
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  const config = {
    stateDirectory: join(root, "state"), workspaceRoot: join(root, "work"),
    modelSpec: faux.getModel(), modelsRegistry: models, streamFn: models.streamSimple.bind(models),
  };
  const store = new AgentTaskStore(join(root, "state/tasks"));
  const crashed = {
    id: "crashed", sessionId: "shared", workspaceRoot: config.workspaceRoot,
    prompt: "Turn on the light", state: "unknown" as const,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    steps: [{ step: 1, phase: "error" as const, summary: "write: MIOT_ERROR_503" }],
    error: "write: MIOT_ERROR_503", runtimeExited: false,
  };
  store.save(crashed);
  let executor = new PiAgentExecutor(config);
  try {
    await assert.rejects(executor.run("Continue", { sessionId: "shared" }), /unverified task outcome/);
    executor.reviewTask("crashed");
    const reviewed = executor.getTask("crashed")!;
    assert.ok(reviewed.reviewedAt);
    assert.equal(taskNeedsReview(reviewed), false);
    const { reviewedAt, ...evidence } = reviewed;
    assert.deepEqual(evidence, crashed);
    executor.reviewTask("crashed");
    assert.equal(executor.getTask("crashed")?.reviewedAt, reviewedAt);
    await executor.close();
    executor = new PiAgentExecutor(config);
    assert.deepEqual(executor.getTask("crashed"), reviewed);
    faux.setResponses([fauxAssistantMessage("Continue after review")]);
    assert.equal((await executor.run("Continue", { sessionId: "shared" })).answer, "Continue after review");
    faux.setResponses([fauxAssistantMessage("Explicit rerun")]);
    await executor.run("Try again", { taskId: "crashed", resume: true });
    assert.equal(executor.getTask("crashed")?.reviewedAt, undefined);
  } finally {
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});
