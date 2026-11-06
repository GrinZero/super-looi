import fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  VoiceProviderRegistry,
  LoopbackSuppressionManager,
  DoubaoVoiceProvider,
  ModularVoiceProvider,
  DEFAULT_LOOI_INSTRUCTIONS,
} from "./voice/provider.js";
import { VisionProviderRegistry } from "./vision/provider.js";
import { MemoryLedgerService } from "./memory/ledger.js";
import { HubTaskSupervisor } from "./productivity/task-supervisor.js";
import { DshWorkspaceRunner } from "./productivity/dsh-runner.js";
import { HomeAssistantGateway, InMemoryHaTransportAdapter } from "./home/gateway.js";
import { HomeRulesEngine } from "./home/rules-engine.js";
import { executeHomeVoiceTool } from "./home/voice-tools.js";
import { AcceptanceRunner } from "./acceptance/runner.js";
import { BoundedActiveLookCoordinator } from "./vision/active-look.js";
import { BodySupervisor, SimulatedBleTransport } from "@super-looi/looi-driver";
import { getConsoleHtml } from "./console-html.js";
import { PersonalMemoryStore, type PersonalMemoryCategory } from "./agent/personal-memory.js";
import { DshAgentExecutor } from "./agent/dsh-executor.js";
import { type AgentExecutor, type AgentInteractionAnswer, AgentExecutionError } from "./agent/executor.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  type VoiceProviderKind,
  type VisionProviderKind,
  type EventEnvelope,
  type MemoryClaim,
  type TaskRequest,
  type UserActionRef,
  type HomeControlCommand,
  type ObservationRequest,
  type AclScope,
  type ReadbackEvidence,
  createMemoryClaim,
} from "@super-looi/contracts";

export interface HubAppOptions {
  voiceRegistry?: VoiceProviderRegistry;
  visionRegistry?: VisionProviderRegistry;
  memoryLedger?: MemoryLedgerService;
  taskSupervisor?: HubTaskSupervisor;
  dshRunner?: DshWorkspaceRunner;
  homeGateway?: HomeAssistantGateway;
  refreshHome?: () => Promise<void>;
  homeRulesEngine?: HomeRulesEngine;
  personalMemory?: PersonalMemoryStore;
  agentExecutor?: AgentExecutor;
  seedDemo?: boolean;
  persistState?: boolean;
}

export async function seedInitialDemoState(deps: {
  memoryLedger: MemoryLedgerService;
  taskSupervisor: HubTaskSupervisor;
  dshRunner: DshWorkspaceRunner;
  homeGateway: HomeAssistantGateway;
}): Promise<{ memoriesCount: number; tasksCount: number; homeCount: number }> {
  const { memoryLedger, taskSupervisor, dshRunner, homeGateway } = deps;
  const now = Date.now();

  // 1. Pre-seeded Memories
  await memoryLedger.upsertClaim(
    createMemoryClaim({
      claim_id: "claim_demo_keys",
      predicate: "object_last_seen",
      object: { target: "钥匙", location: "键盘左侧", text: "钥匙在键盘左侧" },
      status: "confirmed",
      source_kind: "authenticated_user_statement",
      evidence_ids: ["ev_keys_stmt"],
      derivation_roots: ["root_keys_1"],
      observed_at: new Date(now - 20 * 60 * 1000).toISOString(),
      source_availability: "retained",
    })
  );

  await memoryLedger.upsertClaim(
    createMemoryClaim({
      claim_id: "claim_demo_airpods",
      predicate: "object_last_seen",
      object: { target: "AirPods 耳机盒", location: "显示器右下方", text: "白色耳机盒在显示器右下方" },
      status: "observed",
      source_kind: "camera_frame",
      evidence_ids: ["ev_airpods_frame"],
      derivation_roots: ["root_airpods_cam"],
      observed_at: new Date(now - 45 * 60 * 1000).toISOString(),
      source_availability: "retained",
    })
  );

  await memoryLedger.upsertClaim(
    createMemoryClaim({
      claim_id: "claim_demo_mug",
      predicate: "object_last_seen",
      object: { target: "保温杯", location: "书架第二层", text: "黑色保温杯在书架第二层" },
      status: "inferred",
      source_kind: "vision_description",
      evidence_ids: ["ev_mug_vlm"],
      derivation_roots: ["root_mug_vlm"],
      observed_at: new Date(now - 2 * 3600 * 1000).toISOString(),
      source_availability: "retained",
    })
  );

  await memoryLedger.upsertClaim(
    createMemoryClaim({
      claim_id: "claim_demo_expired",
      predicate: "object_last_seen",
      object: { target: "备用充电线", location: "右侧抽屉", text: "编织快充线在右侧抽屉" },
      status: "observed",
      source_kind: "camera_frame",
      evidence_ids: ["ev_cable_frame"],
      derivation_roots: ["root_cable_frame"],
      observed_at: new Date(now - 3 * 24 * 3600 * 1000).toISOString(),
      source_availability: "source_expired",
    })
  );

  // 2. Pre-seeded Productivity Tasks
  dshRunner.registerWorkspace("ws_godot_island", "/Users/dev/projects/island");

  const defaultScope: AclScope = {
    household_id: "household_default",
    subject_id: null,
    project_id: "proj_island",
    audience: "project",
    acl_policy_id: "policy_project_default",
    acl_policy_revision: 1,
  };

  const taskGodotReq: TaskRequest = {
    schema_version: "0.2",
    task_id: "task_demo_godot",
    client_request_id: "req_demo_godot_01",
    requested_by_principal_id: "user_owner",
    intent: "整理海岛城池道路与阶梯问题清单并执行 Godot 构建",
    scope: defaultScope,
    workspace_id: "ws_godot_island",
    executor_id: "dsh_runner",
    context_pack_id: "pack_demo_godot",
    requested_at: new Date(now - 30 * 60 * 1000).toISOString(),
    deadline_at: new Date(now + 3600 * 1000).toISOString(),
  };
  await taskSupervisor.submitTask(taskGodotReq);
  await taskSupervisor.transitionState("task_demo_godot", "running", "Godot build target macos started");
  const readbackEvidence: ReadbackEvidence = {
    kind: "artifact_probe",
    evidence_ids: ["ev_artifact_godot"],
    observed_at: new Date(now - 5 * 60 * 1000).toISOString(),
    received_at: new Date(now - 5 * 60 * 1000).toISOString(),
    state_version: "v1.0",
    value: { files: ["docs/island-road-checklist.md", "build/macos/island.app"] },
  };
  await taskSupervisor.verifyArtifactsAndComplete(
    "task_demo_godot",
    [
      { artifactId: "art_checklist", relativePath: "docs/island-road-checklist.md", contentHash: "sha_checklist_881" },
      { artifactId: "art_app", relativePath: "build/macos/island.app", contentHash: "sha_godot_app_992" },
    ],
    [readbackEvidence]
  );

  const taskPushReq: TaskRequest = {
    schema_version: "0.2",
    task_id: "task_demo_push",
    client_request_id: "req_demo_push_02",
    requested_by_principal_id: "user_owner",
    intent: "将修复分支强制推送到远端仓库 (git push --force origin fix/stairs)",
    scope: defaultScope,
    workspace_id: "ws_godot_island",
    executor_id: "dsh_runner",
    context_pack_id: "pack_demo_push",
    requested_at: new Date(now - 2 * 60 * 1000).toISOString(),
    deadline_at: new Date(now + 1800 * 1000).toISOString(),
  };
  await taskSupervisor.submitTask(taskPushReq);
  await taskSupervisor.transitionState("task_demo_push", "running", "Branch prepared, preparing force push");
  await dshRunner.executeCommand({
    taskId: "task_demo_push",
    workspaceId: "ws_godot_island",
    command: "git push --force origin fix/stairs",
  });

  // 3. Pre-seeded Smart Home Entities
  if (!(homeGateway.getTransport() instanceof InMemoryHaTransportAdapter)) {
    return { memoriesCount: 4, tasksCount: 2, homeCount: 0 };
  }
  homeGateway.registerEntity({
    entity_id: "fan.study_fresh_air",
    friendly_name: "书房新风",
    room: "书房",
    domain: "fan",
    supported_features: ["turn_on", "turn_off"],
    is_whitelisted: true,
  });
  homeGateway.registerEntity({
    entity_id: "sensor.study_co2",
    friendly_name: "书房 CO₂ 传感器",
    room: "书房",
    domain: "sensor",
    supported_features: [],
    is_whitelisted: true,
  });
  homeGateway.registerEntity({
    entity_id: "sensor.study_temperature",
    friendly_name: "书房温度传感器",
    room: "书房",
    domain: "sensor",
    supported_features: [],
    is_whitelisted: true,
  });

  const transport = homeGateway.getTransport();
  if (transport instanceof InMemoryHaTransportAdapter) {
    transport.setInternalState("light.study_ceiling", {
      entity_id: "light.study_ceiling",
      state: "on",
      attributes: { brightness: 180, color_temp: 4000 },
      last_changed: new Date().toISOString(),
      last_updated: new Date().toISOString(),
    });
    transport.setInternalState("light.study_desk", {
      entity_id: "light.study_desk",
      state: "on",
      attributes: { brightness: 90, color_temp: 3000 },
      last_changed: new Date().toISOString(),
      last_updated: new Date().toISOString(),
    });
    transport.setInternalState("fan.study_fresh_air", {
      entity_id: "fan.study_fresh_air",
      state: "off",
      attributes: {},
      last_changed: new Date().toISOString(),
      last_updated: new Date().toISOString(),
    });
    transport.setInternalState("sensor.study_co2", {
      entity_id: "sensor.study_co2",
      state: "612",
      attributes: { unit_of_measurement: "ppm" },
      last_changed: new Date().toISOString(),
      last_updated: new Date().toISOString(),
    });
    transport.setInternalState("sensor.study_temperature", {
      entity_id: "sensor.study_temperature",
      state: "23.8",
      attributes: { unit_of_measurement: "°C" },
      last_changed: new Date().toISOString(),
      last_updated: new Date().toISOString(),
    });
  }

  return { memoriesCount: 4, tasksCount: 2, homeCount: 5 };
}

export function buildApp(options: HubAppOptions = {}): FastifyInstance {
  const app = fastify({ logger: false });

  const memoryLedger = options.memoryLedger ?? new MemoryLedgerService();
  const personalMemory =
    options.personalMemory ??
    new PersonalMemoryStore({
      persistToDisk: options.persistState === true,
      ledger: options.persistState === true ? memoryLedger : undefined,
      seedDefaultsIfEmpty: options.seedDemo === true,
    });
  const agentExecutor = options.agentExecutor ?? new DshAgentExecutor({ memoryStore: personalMemory });
  app.addHook("onClose", async () => { await agentExecutor.close(); });

  const voiceRegistry =
    options.voiceRegistry ??
    new VoiceProviderRegistry({
      modularProvider: new ModularVoiceProvider({ llm: { async *generate(prompt, options) {
        const result = await agentExecutor.run(prompt, { mode: "voice", onStep: options?.onStep });
        yield { text: result.answer };
      } } }),
      doubaoProvider: new DoubaoVoiceProvider({
        buildInstructions: () =>
          `${DEFAULT_LOOI_INSTRUCTIONS}\n\n<personal_memory>\n${personalMemory.buildSystemPromptBlock(12)}\n</personal_memory>`,
      }),
    });
  const visionRegistry = options.visionRegistry ?? new VisionProviderRegistry();
  const taskSupervisor = options.taskSupervisor ?? new HubTaskSupervisor(options.persistState ? { filePath: path.resolve("data/tasks.json") } : {});
  const dshRunner = options.dshRunner ?? new DshWorkspaceRunner(taskSupervisor, agentExecutor);
  dshRunner.registerWorkspace("default", path.resolve(process.env.DSH_WORKSPACE_ROOT ?? "data/agent-workspace"));
  const homeGateway = options.homeGateway ?? new HomeAssistantGateway();
  const homeRulesEngine = options.homeRulesEngine ?? new HomeRulesEngine();

  // Pre-seed demo state if requested
  if (options.seedDemo === true) {
    void seedInitialDemoState({ memoryLedger, taskSupervisor, dshRunner, homeGateway });
  }

  void app.register(cors, { origin: true });
  void app.register(websocket);

  // Live Console Root
  app.get("/", async (_req, reply) => {
    reply.type("text/html; charset=utf-8").send(getConsoleHtml());
  });

  // Health check endpoint
  app.get("/health", async () => {
    return {
      status: "ok",
      version: "0.2.0",
      activeVoiceProvider: voiceRegistry.getActiveKind(),
      activeVisionProvider: visionRegistry.getActiveKind(),
      modules: {
        memory: memoryLedger.getStats(),
        productivity: taskSupervisor.getStats(),
        home: { status: "ready" },
      },
    };
  });

  // Console capabilities describe this Hub process, not a connected physical robot.
  app.get("/api/console/status", async () => {
    const transport = homeGateway.getTransport();
    return {
      transportMode: "simulation",
      ble: { connected: false, physicalStopVerified: false },
      home: {
        transportMode: transport instanceof InMemoryHaTransportAdapter ? "simulation" : "adapter",
        healthy: transport.isHealthy(),
        lastVerifiedAt: transport.getLastVerifiedAt(),
      },
      voice: { active: voiceRegistry.getActiveKind() },
      vision: { active: visionRegistry.getActiveKind() },
      observedAt: new Date().toISOString(),
    };
  });

  // Demo Seeding Endpoint
  app.post("/api/demo/seed", async () => {
    const result = await seedInitialDemoState({ memoryLedger, taskSupervisor, dshRunner, homeGateway });
    return { success: true, seeded: result };
  });

  // Demo Active Look Endpoint
  app.post("/api/demo/active-look", async () => {
    const transport = new SimulatedBleTransport();
    const supervisor = new BodySupervisor(transport);
    await supervisor.connect();
    transport.emitNotification("dockNotify", "05");

    const activeVision = visionRegistry.getActive();
    const coordinator = new BoundedActiveLookCoordinator(supervisor, activeVision);

    const nowIso = new Date().toISOString();
    const req: ObservationRequest = {
      schema_version: "0.2",
      observation_id: `obs_${Date.now()}`,
      task_id: null,
      question: "寻找钥匙位置",
      target_description: "钥匙",
      allowed_primitives: ["turn_left", "head_up"],
      budget: {
        max_attempts: 2,
        max_vlm_calls: 2,
        max_total_motion_ms: 1000,
        max_elapsed_ms: 5000,
      },
      settling_ms: 200,
      requested_at: nowIso,
      expires_at: new Date(Date.now() + 60000).toISOString(),
    };

    const result = await coordinator.executeActiveLook(req, "钥匙");

    if (result.found) {
      await memoryLedger.upsertClaim(
        createMemoryClaim({
          claim_id: "claim_demo_keys",
          predicate: "object_last_seen",
          object: { target: "钥匙", location: "键盘左侧", text: "钥匙在键盘左侧 (主动微观察确证)" },
          status: "confirmed",
          source_kind: "camera_frame",
          evidence_ids: ["ev_active_look_frame"],
          derivation_roots: ["root_active_look"],
          observed_at: nowIso,
          source_availability: "retained",
        })
      );
    }

    return {
      success: true,
      message: result.found
        ? `👀 主动微观察完成: 在键盘左侧发现钥匙 (消耗 ${result.attemptsUsed} 次微调尝试)`
        : `👀 主动微观察已执行: ${result.honestFallbackMessage}`,
      result,
    };
  });

  // 48 Cases Acceptance Runner Endpoint
  app.post("/api/acceptance/run", async () => {
    const runner = new AcceptanceRunner();
    const report = await runner.runFullSuite();
    return report;
  });

  // Voice Provider Endpoints
  app.get("/api/voice/providers", async () => {
    return {
      active: voiceRegistry.getActiveKind(),
      providers: voiceRegistry.list(),
    };
  });

  app.post<{ Body: { kind: VoiceProviderKind } }>("/api/voice/providers/select", async (req, reply) => {
    const { kind } = req.body;
    try {
      voiceRegistry.setActive(kind);
      return { success: true, active: kind };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Vision Provider Endpoints
  app.get("/api/vision/providers", async () => {
    return {
      active: visionRegistry.getActiveKind(),
      providers: visionRegistry.list(),
    };
  });

  app.post<{ Body: { kind: VisionProviderKind } }>("/api/vision/providers/select", async (req, reply) => {
    const { kind } = req.body;
    try {
      visionRegistry.setActive(kind);
      return { success: true, active: kind };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Vision Benchmark Trigger
  app.post("/api/vision/benchmark", async () => {
    const { runVisionBenchmark } = await import("./vision/benchmark.js");
    const report = await runVisionBenchmark(visionRegistry);
    return report;
  });

  // Memory Ledger Endpoints (Phase 2)
  app.post("/api/memory/events", async (req, reply) => {
    try {
      const result = await memoryLedger.ingestEvent(req.body as EventEnvelope);
      return { success: true, ...result };
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.post("/api/memory/claims", async (req, reply) => {
    try {
      const claim = req.body as MemoryClaim;
      await memoryLedger.upsertClaim(claim);
      return { success: true, claim_id: claim.claim_id };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get<{ Querystring: { predicate?: string; status?: string; subjectId?: string } }>(
    "/api/memory/claims",
    async (req) => {
      const claims = await memoryLedger.queryClaims(req.query as any);
      return { claims };
    }
  );

  app.get<{ Params: { objectName: string } }>("/api/memory/last-seen/:objectName", async (req, reply) => {
    const result = await memoryLedger.queryObjectLastSeen(req.params.objectName);
    if (!result) {
      return reply.code(404).send({ error: `No observation found for '${req.params.objectName}'` });
    }
    return result;
  });

  app.post<{ Params: { claimId: string }; Body: { newObject: any; userEventId: string } }>(
    "/api/memory/claims/:claimId/correct",
    async (req, reply) => {
      try {
        const updated = await memoryLedger.correctClaim(req.params.claimId, req.body.newObject, req.body.userEventId);
        return { success: true, claim: updated };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{ Params: { claimId: string }; Body: { suppressionKey?: string } }>(
    "/api/memory/claims/:claimId/reject",
    async (req, reply) => {
      try {
        await memoryLedger.rejectInference(req.params.claimId, req.body?.suppressionKey);
        return { success: true };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{ Params: { evidenceId: string }; Body: { scopeId?: string } }>(
    "/api/memory/evidence/:evidenceId/delete",
    async (req) => {
      const result = await memoryLedger.deleteEvidenceSource(req.params.evidenceId, req.body?.scopeId);
      return { success: true, ...result };
    }
  );

  // Productivity Task Endpoints (Phase 3)
  app.post("/api/tasks", async (req, reply) => {
    try {
      const taskReq = req.body as TaskRequest;
      if (!taskReq || typeof taskReq.task_id !== "string" || typeof taskReq.client_request_id !== "string" || typeof taskReq.intent !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(taskReq.task_id)) throw new Error("Invalid task request");
      const result = await taskSupervisor.submitTask(taskReq);
      if (!result.deduplicated && taskReq.executor_id === "dsh_runner") {
        void dshRunner.executeTask(taskReq).then(async outcome => {
          if (outcome.executionStatus === "rejected") await taskSupervisor.transitionState(taskReq.task_id, "failed", outcome.rejectionReason ?? "Execution rejected");
        }).catch(async error => { await taskSupervisor.transitionState(taskReq.task_id, "failed", (error as Error).message); });
      }
      return { success: true, ...result };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get("/api/tasks", async () => {
    const tasks = await taskSupervisor.getAllTasks();
    return { tasks };
  });

  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId", async (req, reply) => {
    const event = await taskSupervisor.getTaskStatus(req.params.taskId);
    if (!event) {
      return reply.code(404).send({ error: `Task '${req.params.taskId}' not found.` });
    }
    return { event };
  });

  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId/grants", async (req, reply) => {
    if (!(await taskSupervisor.getTaskStatus(req.params.taskId))) {
      return reply.code(404).send({ error: `Task '${req.params.taskId}' not found.` });
    }
    return { grants: await taskSupervisor.getTaskActionGrants(req.params.taskId) };
  });

  app.get<{ Params: { taskId: string }; Querystring: { sinceSeq?: string } }>(
    "/api/tasks/:taskId/events",
    async (req) => {
      const sinceSeq = req.query?.sinceSeq ? parseInt(req.query.sinceSeq, 10) : 0;
      const events = await taskSupervisor.getTaskEvents(req.params.taskId, sinceSeq);
      return { events };
    }
  );

  app.post<{ Params: { taskId: string }; Body: { grantId: string; userAction: UserActionRef } }>(
    "/api/tasks/:taskId/approve",
    async (req, reply) => {
      try {
        const result = await taskSupervisor.approveTaskAction(
          req.params.taskId,
          req.body.grantId,
          req.body.userAction
        );
        void dshRunner.continueApprovedCommand(req.params.taskId, req.body.grantId).catch(async error => {
          await taskSupervisor.transitionState(req.params.taskId, "failed", (error as Error).message);
        });
        return { success: true, ...result };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{ Params: { taskId: string }; Body: { prompt: string } }>("/api/tasks/:taskId/resume", async (req, reply) => {
    const task = (await taskSupervisor.getAllTasks()).find(item => item.task_id === req.params.taskId);
    const runtime = agentExecutor.getTask(req.params.taskId);
    const prompt = String(req.body?.prompt ?? "").trim();
    if (!task || !runtime) return reply.code(404).send({ error: "Persisted task not found" });
    if (!prompt || ["queued", "running", "awaiting_approval", "awaiting_input", "cancelling"].includes(runtime.state)) return reply.code(409).send({ error: "Task is active or resume prompt is empty" });
    void dshRunner.resumeTask(task, prompt).catch(async error => { await taskSupervisor.transitionState(task.task_id, "failed", (error as Error).message); });
    return reply.code(202).send({ taskId: task.task_id });
  });

  app.post<{ Params: { taskId: string }; Body: { reason?: string } }>(
    "/api/tasks/:taskId/cancel",
    async (req, reply) => {
      try {
        const receipt = await dshRunner.cancelTaskExecution(req.params.taskId, req.body?.reason);
        const event = await taskSupervisor.getTaskStatus(req.params.taskId);
        return { success: true, receipt, event };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  // Smart Home Endpoints (Phase 4)
  app.get("/api/home/entities", async () => {
    return {
      entities: await homeGateway.listEntities(),
    };
  });

  app.get("/api/home/states", async () => {
    const transport = homeGateway.getTransport();
    const states = await homeGateway.getStates();
    return {
      transportMode: transport instanceof InMemoryHaTransportAdapter ? "simulation" : "adapter",
      healthy: transport.isHealthy(),
      lastVerifiedAt: transport.getLastVerifiedAt(),
      observedAt: new Date().toISOString(),
      entities: states,
    };
  });

  app.get<{ Querystring: { q?: string; room?: string } }>("/api/home/resolve", async (req) => {
    const query = req.query?.q ?? "";
    const roomHint = req.query?.room;
    const result = await homeGateway.resolveTargets(query, roomHint);
    return result;
  });

  app.post<{ Body: HomeControlCommand }>("/api/home/execute", async (req) => {
    const receipt = await homeGateway.executeCommand(req.body);
    return { success: receipt.status === "verified", receipt };
  });

  app.post<{ Body: { commands: HomeControlCommand[] } }>("/api/home/batch-execute", async (req) => {
    const result = await homeGateway.executeBatch(req.body?.commands || []);
    return result;
  });

  app.get("/api/home/rules", async () => {
    return {
      rules: homeRulesEngine.listRules(),
      proposals: homeRulesEngine.listPendingProposals(),
    };
  });

  app.post<{
    Body: { entityId: string; service: string; serviceData: Record<string, unknown>; contextHint?: string };
  }>("/api/home/rules/adjustments", async (req) => {
    const result = homeRulesEngine.recordManualAdjustment(req.body);
    return result;
  });

  app.post<{ Params: { proposalId: string }; Body: { userAction: UserActionRef } }>(
    "/api/home/rules/:proposalId/confirm",
    async (req, reply) => {
      try {
        const rule = homeRulesEngine.confirmRuleProposal(req.params.proposalId, req.body.userAction);
        return { success: true, rule };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{ Params: { ruleId: string } }>("/api/home/rules/:ruleId/revoke", async (req, reply) => {
    try {
      const rule = homeRulesEngine.revokeRule(req.params.ruleId);
      return { success: true, rule };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Minimal Personal Agent & Zero-Cognitive-Load Memory Endpoints (Phase 11)
  app.get<{ Querystring: { q?: string } }>("/api/agent/memories", async (req) => {
    const q = req.query?.q;
    const memories = q ? personalMemory.recall(q, 20) : personalMemory.listAll();
    return { memories };
  });

  app.post<{
    Body: {
      fact: string;
      subject?: string;
      location?: string;
      category?: PersonalMemoryCategory;
      source?: "voice" | "agent" | "user";
    };
  }>("/api/agent/memories", async (req, reply) => {
    try {
      const entry = await personalMemory.remember(req.body);
      return { success: true, entry, memories: personalMemory.listAll() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { idOrQuery: string } }>("/api/agent/memories/:idOrQuery", async (req) => {
    const result = personalMemory.forget(decodeURIComponent(req.params.idOrQuery));
    return { success: true, ...result, memories: personalMemory.listAll() };
  });

  app.post<{ Body: { prompt: string; mode?: "voice" | "text"; taskId?: string } }>("/api/agent/run", async (req, reply) => {
    const prompt = String(req.body?.prompt ?? "").trim();
    if (!prompt) {
      return reply.code(400).send({ error: "prompt is required" });
    }
    try {
      const result = await agentExecutor.run(prompt, { mode: req.body?.mode ?? "voice", taskId: req.body?.taskId });
      return {
        success: true,
        ...result,
        memories: personalMemory.listAll(),
      };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message, taskId: err instanceof AgentExecutionError ? err.taskId : undefined });
    }
  });

  app.get("/api/agent/tasks", async () => ({ tasks: agentExecutor.listTasks() }));
  app.get<{ Params: { taskId: string } }>("/api/agent/tasks/:taskId", async (req, reply) => {
    const task = agentExecutor.getTask(req.params.taskId);
    return task ? { task } : reply.code(404).send({ error: "Task not found" });
  });
  app.post<{ Body: { prompt: string; taskId?: string; mode?: "voice" | "text" } }>("/api/agent/tasks", async (req, reply) => {
    const prompt = String(req.body?.prompt ?? "").trim();
    if (!prompt || prompt.length > 16000) return reply.code(400).send({ error: "prompt must contain 1..16000 characters" });
    const taskId = req.body.taskId ?? `task_${randomUUID()}`;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) return reply.code(400).send({ error: "Invalid task id" });
    const existing = agentExecutor.getTask(taskId);
    if (existing && existing.prompt !== prompt) return reply.code(409).send({ error: "Task id belongs to another prompt" });
    if (!existing) {
      const running = agentExecutor.run(prompt, { taskId, mode: req.body.mode });
      if (!agentExecutor.getTask(taskId)) {
        try { await running; } catch (error) { return reply.code(503).send({ error: (error as Error).message }); }
      }
      void running.catch(() => {}); // Failure is durable and returned by GET, never retried here.
    }
    return reply.code(202).send({ taskId, task: agentExecutor.getTask(taskId) });
  });
  app.post<{ Params: { taskId: string }; Body: { requestId: string; answer: AgentInteractionAnswer } }>("/api/agent/tasks/:taskId/respond", async (req, reply) => {
    try { agentExecutor.respond(req.params.taskId, req.body.requestId, req.body.answer); return { success: true }; }
    catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
  app.post<{ Params: { taskId: string } }>("/api/agent/tasks/:taskId/cancel", async (req, reply) => {
    try { return await agentExecutor.cancel(req.params.taskId); }
    catch (error) { return reply.code(404).send({ error: (error as Error).message }); }
  });
  app.post<{ Params: { taskId: string }; Body: { prompt: string } }>("/api/agent/tasks/:taskId/resume", async (req, reply) => {
    const task = agentExecutor.getTask(req.params.taskId);
    if (await taskSupervisor.getTaskStatus(req.params.taskId)) return reply.code(409).send({ error: "Resume productivity tasks through /api/tasks/:taskId/resume" });
    const prompt = String(req.body?.prompt ?? "").trim();
    if (!task) return reply.code(404).send({ error: "Task not found" });
    if (!prompt || ["queued", "running", "awaiting_approval", "awaiting_input", "cancelling"].includes(task.state)) return reply.code(409).send({ error: "Explicit prompt and an idle task are required" });
    const running = agentExecutor.run(prompt, { taskId: task.id, resume: true });
    const admitted = agentExecutor.getTask(task.id);
    if (admitted?.state !== "queued") {
      try { await running; } catch (error) { return reply.code(503).send({ error: (error as Error).message }); }
    }
    void running.catch(() => {});
    return reply.code(202).send({ taskId: task.id });
  });

  // WebSocket /ws/voice endpoint with automatic Fast/Slow Brain Tool Bridge
  const loopbackManager = new LoopbackSuppressionManager();

  app.register(async (instance) => {
    instance.get("/ws/voice", { websocket: true }, async (rawSocket) => {
      const socket = ((rawSocket as any).socket ?? rawSocket) as import("ws").WebSocket;
      const sessionId = `vsess_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const activeProvider = voiceRegistry.getActive();
      const sendSafe = (payload: Record<string, unknown>) => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(payload));
        }
      };

      let session: any = null;
      let pendingSpeechTask: string | null = null;
      let pendingRememberFact: string | null = null;
      let agentBusy = false;
      let turnToolHandled = false;
      let agentAbort: AbortController | null = null;
      let activeAgentTaskId: string | null = null;
      const emitAgentStep = (step: import("./agent/executor.js").AgentStepEvent) => {
        sendSafe({ type: "agent_status", phase: step.phase, tool: step.toolName ?? "agent", summary: step.summary,
          task_id: step.taskId, session_id: step.sessionId,
          interaction: step.taskId ? agentExecutor.getTask(step.taskId)?.interaction : undefined });
      };

      const runSpeechAgentFollowup = async (taskPrompt: string) => {
        if (agentBusy) return;
        agentBusy = true;
        agentAbort = new AbortController();
        activeAgentTaskId = `voice_${randomUUID()}`;
        try {
          sendSafe({
            type: "agent_status",
            phase: "thinking",
            tool: "agent",
            summary: `Agent 正在执行: ${taskPrompt.slice(0, 38)}`,
          });
          const result = await agentExecutor.run(taskPrompt, {
            mode: "voice",
            signal: agentAbort.signal,
            taskId: activeAgentTaskId!,
            onStep: emitAgentStep,
          });
          if (socket.readyState !== 1) return;
          sendSafe({
            type: "agent_status",
            phase: "done",
            tool: "agent",
            summary: result.answer,
            memories: personalMemory.listAll(),
          });
          await session?.sendUpMessage({
            type: "speak_text",
            text: result.answer,
          });
        } catch (err) {
          sendSafe({
            type: "agent_status",
            phase: "error",
            tool: "agent",
            summary: `Agent 执行异常: ${(err as Error).message}`,
          });
        } finally {
          agentBusy = false;
          agentAbort = null;
        }
      };

      const executeVoiceToolCall = async (
        callId: string,
        name: string,
        args: Record<string, unknown>
      ) => {
        pendingSpeechTask = null;
        pendingRememberFact = null;
        turnToolHandled = true;
        try {
          if (name === "list_home_devices" || name === "control_home_device") {
            await options.refreshHome?.();
            const output = await executeHomeVoiceTool(name, args, homeGateway);
            await session?.sendUpMessage({ type: "tool_result", call_id: callId, output });
            sendSafe({ type: "agent_status", phase: "done", tool: name,
              summary: name === "list_home_devices" ? "已读取家居设备状态" : String(output.instruction) });
            return;
          }
          if (name === "remember_fact") {
            const fact = String(args.fact ?? "").trim();
            sendSafe({
              type: "agent_status",
              phase: "tool_start",
              tool: name,
              summary: `正在记住: ${fact.slice(0, 36)}`,
            });
            const entry = await personalMemory.remember({
              fact,
              subject: args.subject ? String(args.subject) : undefined,
              location: args.location ? String(args.location) : undefined,
              source: "voice",
            });
            await session?.sendUpMessage({
              type: "tool_result",
              call_id: callId,
              output: { ok: true, entry },
            });
            sendSafe({
              type: "agent_status",
              phase: "done",
              tool: name,
              summary: `已记住: ${entry.fact}`,
              memories: personalMemory.listAll(),
            });
            return;
          }

          if (name === "recall_memory") {
            const query = String(args.query ?? "").trim();
            sendSafe({
              type: "agent_status",
              phase: "tool_start",
              tool: name,
              summary: `正在检索记忆: ${query || "最近记录"}`,
            });
            const items = personalMemory.recall(query, 5);
            await session?.sendUpMessage({
              type: "tool_result",
              call_id: callId,
              output: { ok: true, items },
            });
            const spoken =
              items.length > 0
                ? `我记得：${items.map((i) => i.fact).slice(0, 2).join("；")}。`
                : `我还没有关于${query || "这个"}的记录。`;
            if (socket.readyState === 1 && activeProvider.kind !== "doubao") {
              await session?.sendUpMessage({
                type: "speak_text",
                text: spoken,
              });
            }
            sendSafe({
              type: "agent_status",
              phase: "done",
              tool: name,
              summary: spoken,
            });
            return;
          }

          if (name === "run_agent_task") {
            if (agentBusy) return;
            agentBusy = true;
            agentAbort = new AbortController();
        activeAgentTaskId = `voice_${randomUUID()}`;
            const taskPrompt = String(args.task ?? "").trim();
            sendSafe({
              type: "agent_status",
              phase: "thinking",
              tool: name,
              summary: `Agent 正在处理: ${taskPrompt.slice(0, 40)}`,
            });
            try {
              const result = await agentExecutor.run(taskPrompt, {
                mode: "voice",
                signal: agentAbort.signal,
            taskId: activeAgentTaskId!,
                onStep: emitAgentStep,
              });
              if (socket.readyState !== 1) return;
              await session?.sendUpMessage({
                type: "tool_result",
                call_id: callId,
                output: { ok: true, answer: result.answer },
              });
              if (activeProvider.kind !== "doubao") {
                await session?.sendUpMessage({
                  type: "speak_text",
                  text: result.answer,
                });
              }
              sendSafe({
                type: "agent_status",
                phase: "done",
                tool: name,
                summary: result.answer,
                memories: personalMemory.listAll(),
              });
            } finally {
              agentBusy = false;
              agentAbort = null;
            }
            return;
          }
        } catch (err) {
          sendSafe({
            type: "agent_status",
            phase: "error",
            tool: name,
            summary: `工具执行异常: ${(err as Error).message}`,
          });
        }
      };

      const pendingClientMessages: Array<{ raw: unknown; isBinary?: boolean }> = [];
      let sessionReadyForMessages = false;

      const handleClientMessage = async (raw: unknown, isBinary?: boolean) => {
        try {
          if (isBinary && Buffer.isBuffer(raw)) {
            if (loopbackManager.isSuppressed()) return;
            await session?.sendUpMessage({
              type: "audio_chunk",
              pcm_base64: raw.toString("base64"),
              sample_rate: 16000,
              sequence: 0,
            });
            return;
          }

          const parsed = JSON.parse(String(raw));
          if (parsed.type === "agent_cancel") {
            if (activeAgentTaskId && (!parsed.task_id || parsed.task_id === activeAgentTaskId)) await agentExecutor.cancel(activeAgentTaskId);
            return;
          }
          if (parsed.type === "agent_response") {
            agentExecutor.respond(String(parsed.task_id), String(parsed.request_id), parsed.answer as AgentInteractionAnswer);
            return;
          }
          if (parsed.type === "barge_in") {
            loopbackManager.clear(); // Explicit barge-in overrides loopback suppression
            pendingSpeechTask = null;
            pendingRememberFact = null;
            // Barge-in only stops speech; work has a separate explicit cancel action.
            await session?.sendUpMessage(parsed);
            return;
          }

          // Gate microphone audio chunks during assistant speech playback
          if (parsed.type === "audio_chunk" && loopbackManager.isSuppressed()) {
            return; // Suppressed loopback
          }

          // When text_input is sent in Doubao mode, run the official DSH executor and speak output via Duplex TTS
          if (parsed.type === "text_input") {
            const text = String(parsed.text ?? "").trim();
            if (!text || agentBusy) return;
            agentBusy = true;
            agentAbort = new AbortController();
            activeAgentTaskId = `voice_${randomUUID()}`;
            sendSafe({ type: "transcript", text, is_final: true, role: "user" });
            sendSafe({ type: "state_change", state: "thinking" });
            try {
              const result = await agentExecutor.run(text, {
                mode: "voice",
                signal: agentAbort.signal,
                taskId: activeAgentTaskId!,
                onStep: emitAgentStep,
              });
              if (socket.readyState !== 1) return;
              sendSafe({
                type: "agent_status",
                phase: "done",
                tool: "agent",
                summary: result.answer,
                memories: personalMemory.listAll(),
              });
              await session?.sendUpMessage({ type: "speak_text", text: result.answer });
            } finally {
              agentBusy = false;
              agentAbort = null;
            }
            return;
          }

          await session?.sendUpMessage(parsed);
        } catch {
          // ignore malformed raw packets
        }
      };

      socket.on("message", (raw: unknown, isBinary?: boolean) => {
        if (!sessionReadyForMessages) {
          pendingClientMessages.push({ raw, isBinary });
          return;
        }
        void handleClientMessage(raw, isBinary);
      });

      socket.on("close", () => {
        // Tasks remain observable/recoverable after the mobile transport disconnects.
        pendingClientMessages.length = 0;
        void session?.close();
      });

      try {
        session = await activeProvider.createSession({
          sessionId,
          onDownMessage: (msg) => {
            if (msg.type === "agent_status" && msg.task_id) activeAgentTaskId = msg.task_id;
            if (msg.type === "audio_chunk") {
              const chunkLen = Buffer.from(msg.pcm_base64, "base64").length;
              const selfWindow = loopbackManager.recordOutboundAudio(chunkLen, msg.sample_rate);
              sendSafe({ type: "self_event", event_window: selfWindow });
            }
            sendSafe(msg as unknown as Record<string, unknown>);

            if (msg.type === "tool_call") {
              void executeVoiceToolCall(
                msg.call_id,
                msg.name,
                (msg.arguments ?? {}) as Record<string, unknown>
              );
            } else if (
              msg.type === "transcript" &&
              msg.role === "user" &&
              !msg.is_final
            ) {
              turnToolHandled = false;
            } else if (
              msg.type === "transcript" &&
              msg.role === "user" &&
              msg.is_final
            ) {
              // Zero-cognitive-load safeguard: if user explicitly said "记住..." in speech, persist if model didn't call remember_fact
              const rememberMatch = msg.text.match(/(?:帮我)?记住[，,：:\s]*(.+)/);
              const cleanedFact = rememberMatch?.[1]?.replace(/^[，,。：:\s]+|[。！!？?\s]+$/g, "").trim();
              if (cleanedFact) {
                if (activeProvider.kind !== "doubao") {
                  void personalMemory
                    .remember({ fact: cleanedFact, source: "voice" })
                    .then((entry) => {
                      sendSafe({
                        type: "agent_status",
                        phase: "done",
                        tool: "remember_fact",
                        summary: `已自动记住: ${entry.fact}`,
                        memories: personalMemory.listAll(),
                      });
                    })
                    .catch(() => {});
                } else if (!turnToolHandled) {
                  pendingRememberFact = cleanedFact;
                }
              } else if (
                activeProvider.kind === "doubao" && !turnToolHandled &&
                /(?:目录|文件|代码|运行|执行|检查|看看.*项目|git\b|pnpm\b|npm\b|ls\b|报错|日志|分支|package\.json)/i.test(
                  msg.text
                )
              ) {
                pendingSpeechTask = msg.text;
              }
            } else if (
              msg.type === "state_change" &&
              (msg.state === "listening" || msg.state === "idle")
            ) {
              const factToRemember = pendingRememberFact;
              const taskToRun = pendingSpeechTask;
              pendingRememberFact = null;
              pendingSpeechTask = null;
              if (!turnToolHandled && factToRemember) {
                void personalMemory
                  .remember({ fact: factToRemember, source: "voice" })
                  .then((entry) => {
                    sendSafe({
                      type: "agent_status",
                      phase: "done",
                      tool: "remember_fact",
                      summary: `已自动记住: ${entry.fact}`,
                      memories: personalMemory.listAll(),
                    });
                  })
                  .catch(() => {});
              } else if (!turnToolHandled && taskToRun) {
                void runSpeechAgentFollowup(taskToRun);
              }
              turnToolHandled = false;
            }
          },
          onError: (err) => {
            sendSafe({ type: "error", code: "session_error", message: err.message });
          },
        });
        if (socket.readyState !== 1) {
          pendingClientMessages.length = 0;
          await session.close();
          return;
        }
        sessionReadyForMessages = true;
        while (pendingClientMessages.length > 0 && socket.readyState === 1) {
          const item = pendingClientMessages.shift()!;
          void handleClientMessage(item.raw, item.isBinary);
        }
      } catch (err) {
        sendSafe({ type: "error", code: "create_failed", message: (err as Error).message });
        socket.close();
        return;
      }
    });
  });

  return app;
}
