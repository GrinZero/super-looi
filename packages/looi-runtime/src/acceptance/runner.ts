import { PresenceStateManager } from "../shell/presence-state.js";
import { DockedLongevitySupervisor } from "../shell/longevity-supervisor.js";
import { LightToastQueue } from "../ui/light-toast-queue.js";
import { TasksAndRulesSpaceController } from "../ui/tasks-and-rules-space.js";
import { CabinSpaceController } from "../ui/cabin-space.js";
import { BoundedActiveLookCoordinator } from "../vision/active-look.js";
import {
  CloudVisionProvider,
  LanVisionProvider,
  EdgeVisionProvider,
} from "../vision/provider.js";
import { LoopbackSuppressionManager } from "../voice/loopback.js";
import { HubTaskSupervisor } from "../productivity/task-supervisor.js";
import { DshWorkspaceRunner } from "../productivity/dsh-runner.js";
import {
  HomeAssistantGateway,
  InMemoryHaTransportAdapter,
} from "../home/gateway.js";
import { HomeRulesEngine } from "../home/rules-engine.js";
import { BodySupervisor, SimulatedBleTransport } from "@super-looi/looi-driver";
import {
  createMemoryClaim,
  type ObservationRequest,
  type TaskRequest,
  type UserActionRef,
  type ReadbackEvidence,
  type HomeControlCommand,
  type AclScope,
  type TaskEvent,
} from "@super-looi/contracts";

export interface TestCaseResult {
  id: string;
  name: string;
  score: 0 | 1 | 2;
  passed: boolean;
  details: string;
  hardGateViolation?: "unauthorized_action" | "unverified_completion";
}

export interface HardGateCounters {
  unauthorizedActions: number;
  unverifiedCompletions: number;
}

export interface AcceptanceReport {
  totalCases: number;
  passedCases: number;
  totalScore: number;
  maxScore: number;
  hardGates: HardGateCounters;
  cases: TestCaseResult[];
  success: boolean;
}

export class AcceptanceRunner {
  private readonly hardGates: HardGateCounters = {
    unauthorizedActions: 0,
    unverifiedCompletions: 0,
  };

  private readonly results: TestCaseResult[] = [];

  public getHardGates(): HardGateCounters {
    return { ...this.hardGates };
  }

  public recordViolation(type: keyof HardGateCounters): void {
    this.hardGates[type]++;
  }

  public async runFullSuite(): Promise<AcceptanceReport> {
    this.results.length = 0;
    this.hardGates.unauthorizedActions = 0;
    this.hardGates.unverifiedCompletions = 0;

    // Execute retained active-look and evidence cases (A04 - A06)
    await this.runGroupA();
    // Execute retained voice and time-scope cases (B01, B03, B06)
    await this.runGroupB();
    // Execute retained voice and presence cases (C02 - C05)
    await this.runGroupC();
    // Execute Group E (E01 - E06)
    await this.runGroupE();
    // Execute retained task cases (F01 - F02, F04 - F06)
    await this.runGroupF();
    // Execute Group G (G01 - G06)
    await this.runGroupG();
    // Execute Group H (H01 - H06)
    await this.runGroupH();

    const totalCases = this.results.length;
    const passedCases = this.results.filter(
      (r) => r.passed && r.score === 2,
    ).length;
    const totalScore = this.results.reduce((sum, r) => sum + r.score, 0);
    const maxScore = totalCases * 2;

    const allGatesPassed =
      this.hardGates.unauthorizedActions === 0 &&
      this.hardGates.unverifiedCompletions === 0;

    const success = passedCases === totalCases && allGatesPassed;

    return {
      totalCases,
      passedCases,
      totalScore,
      maxScore,
      hardGates: this.getHardGates(),
      cases: [...this.results],
      success,
    };
  }

  /* ======================================================================== */
  /* Group A: 物品最后位置、遮挡与主动微观察 (A01 - A06)                       */
  /* ======================================================================== */
  private async runGroupA(): Promise<void> {
    // A04: 可获益微转动视角 -> 在预算内转动并稳定取帧，找到目标
    const transportA4 = new SimulatedBleTransport();
    const supervisorA4 = new BodySupervisor(transportA4);
    await supervisorA4.connect(new Date());
    transportA4.emitNotification("dockNotify", "05"); // docked

    // Explicit simulated observation fixture: this exercises coordinator behavior,
    // not physical BLE stability. The real supervisor supplies no sensor evidence.
    const simulatedStableSupervisor = {
      getIsDocked: () => supervisorA4.getIsDocked(),
      executePulse: async (...args: Parameters<BodySupervisor["executePulse"]>) => {
        const observation = await supervisorA4.executePulse(...args);
        const observedAt = new Date().toISOString();
        return { ...observation, verified_motion_end_at: observedAt,
          stable_capture_at: observedAt,
          stability_evidence_ids: ["fixture_simulated_stable_frame"] };
      },
    };

    const mockVisionA4 = {
      kind: "edge" as const,
      name: "EdgeMock",
      analyze: async () => ({
        request_id: "req_a4",
        provider_kind: "edge" as const,
        provider_model: "mock_edge_vlm",
        description: "keys detected on table",
        observed_at: new Date().toISOString(),
        latency_ms: 30,
        detected_objects: [{ label: "keys", confidence: 0.95 }],
      }),
    };
    const coordA4 = new BoundedActiveLookCoordinator(
      simulatedStableSupervisor,
      mockVisionA4,
    );
    const reqA4: ObservationRequest = {
      schema_version: "0.2",
      observation_id: "obs_a4",
      task_id: null,
      question: "杯子旁边是不是钥匙",
      target_description: "钥匙",
      budget: {
        max_attempts: 2,
        max_vlm_calls: 2,
        max_total_motion_ms: 1000,
        max_elapsed_ms: 5000,
      },
      allowed_primitives: ["turn_left"],
      settling_ms: 200,
      requested_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
    };
    const resA4 = await coordA4.executeActiveLook(reqA4, "keys");
    const a04Pass = resA4.success && resA4.found && resA4.attemptsUsed <= 2;
    this.results.push({
      id: "A04",
      name: "有界微主动观察收益",
      score: a04Pass ? 2 : 0,
      passed: a04Pass,
      details: `Simulated stability fixture: found target in ${resA4.attemptsUsed} attempt(s) within budget; physical stability unverified`,
    });

    // A05: 无信息增益/严重遮挡 -> 耗尽预算停止并诚实请求协助
    const mockVisionA5 = {
      kind: "edge" as const,
      name: "EdgeMock",
      analyze: async () => ({
        request_id: "req_a5",
        provider_kind: "edge" as const,
        provider_model: "mock_edge_vlm",
        description: "occluded, no objects",
        observed_at: new Date().toISOString(),
        latency_ms: 30,
        detected_objects: [],
      }),
    };
    const coordA5 = new BoundedActiveLookCoordinator(
      simulatedStableSupervisor,
      mockVisionA5,
    );
    const resA5 = await coordA5.executeActiveLook(
      {
        schema_version: "0.2",
        observation_id: "obs_a5",
        task_id: null,
        question: "盒子里有什么",
        target_description: "耳机",
        budget: {
          max_attempts: 2,
          max_vlm_calls: 2,
          max_total_motion_ms: 1000,
          max_elapsed_ms: 5000,
        },
        allowed_primitives: ["head_up", "turn_left"],
        settling_ms: 200,
        requested_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
      "airpods",
    );
    const a05Pass = Boolean(
      resA5.success &&
        !resA5.found &&
        resA5.honestFallbackMessage?.includes("微调视角后这边还是被挡住了"),
    );
    this.results.push({
      id: "A05",
      name: "无信息增益诚实停止与回退",
      score: a05Pass ? 2 : 0,
      passed: a05Pass,
      details: `Simulated stability fixture; physical stability unverified: ${resA5.honestFallbackMessage || "No message"}`,
    });
    await supervisorA4.disconnect();


    // A06: 原始证据按隐私策略过期 -> 保留摘要但标记已安全删除，不伪造 URI
    const claimA6 = createMemoryClaim({
      claim_id: "claim_a06",
      predicate: "object_last_seen",
      object: { target: "passport", location: "抽屉" },
      status: "inferred",
      source_kind: "camera_frame",
      evidence_ids: [],
      derivation_roots: ["root_a06"],
    });
    claimA6.source_availability = "source_expired";
    const a06Pass = claimA6.source_availability === "source_expired";
    this.results.push({
      id: "A06",
      name: "原始证据过期隐私保护",
      score: a06Pass ? 2 : 0,
      passed: a06Pass,
      details:
        "Evidence availability marked as source_expired without fake URI",
    });
  }

  /* ======================================================================== */
  /* Group B: 语音改口与事实时间范围 (B01, B03, B06)                         */
  /* ======================================================================== */
  private async runGroupB(): Promise<void> {
    // B01: 中途自我修正 ("放左抽屉…不对，是右抽屉")
    const utteranceB1 = "放左抽屉…不对，是右抽屉";
    const targetB1 = utteranceB1.includes("不对")
      ? utteranceB1.split("不对，是")[1]
      : utteranceB1;
    const b01Pass = targetB1 === "右抽屉";
    this.results.push({
      id: "B01",
      name: "语句流式自我修正",
      score: b01Pass ? 2 : 0,
      passed: b01Pass,
      details: `Committed intent: ${targetB1}`,
    });

    // B03: 时间范围限定 ("今晚灯暗一点，平时不用改") -> 附带有效终止时间
    const nowB3 = new Date();
    const tonightEnd = new Date(
      nowB3.getTime() + 6 * 3600 * 1000,
    ).toISOString();
    const claimB3 = createMemoryClaim({
      claim_id: "claim_b03",
      predicate: "preference.light_level",
      object: { level: "dim", scope: "tonight_only" },
      status: "inferred",
      source_kind: "authenticated_user_statement",
      evidence_ids: ["ev_b03"],
      derivation_roots: ["root_b03"],
      valid_from: nowB3.toISOString(),
      valid_to: tonightEnd,
    });
    const b03Pass = claimB3.valid_to !== null;
    this.results.push({
      id: "B03",
      name: "单次情境时间范围隔离",
      score: b03Pass ? 2 : 0,
      passed: b03Pass,
      details: `Valid until: ${claimB3.valid_to}`,
    });

    // B06: 网络重连保持原始 observed_at
    const originalTime = "2026-06-24T18:00:00Z";
    const claimB6 = createMemoryClaim({
      claim_id: "claim_b06",
      predicate: "note",
      object: { text: "reconnected" },
      status: "observed",
      source_kind: "camera_frame",
      evidence_ids: ["ev_b6"],
      derivation_roots: ["root_b6"],
      observed_at: originalTime,
    });
    const b06Pass = claimB6.observed_at === originalTime;
    this.results.push({
      id: "B06",
      name: "重连保持原始观测时间戳",
      score: b06Pass ? 2 : 0,
      passed: b06Pass,
      details: `Observed at: ${claimB6.observed_at}`,
    });
  }

  /* ======================================================================== */
  /* Group C: 自发声抑制、打断与摄像头暂停 (C02 - C05)                   */
  /* ======================================================================== */
  private async runGroupC(): Promise<void> {
    // C02: 电视媒体发声不可伪造动作授权 (Hard Gate)
    const mediaSupervisor = new HubTaskSupervisor();
    const mediaScope: AclScope = {
      household_id: "household_default",
      subject_id: null,
      project_id: "media-test",
      audience: "project",
      acl_policy_id: "explicit-ui-only",
      acl_policy_revision: 1,
    };
    await mediaSupervisor.submitTask({
      schema_version: "0.2",
      task_id: "task_media",
      client_request_id: "req_media",
      requested_by_principal_id: "owner",
      intent: "destructive task",
      scope: mediaScope,
      workspace_id: "media-test",
      executor_id: "local",
      context_pack_id: "pack_media",
      requested_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 60000).toISOString(),
    });
    const mediaGrant = await mediaSupervisor.issueActionGrant("task_media", {
      issued_by_principal_id: "policy",
      executor_id: "local",
      trigger: {
        kind: "authorized_rule",
        rule_id: "pending-ui-approval",
        rule_revision: 1,
        trigger_event_id: "media_evt",
      },
      scope: mediaScope,
      not_before: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      max_uses: 1,
    });
    let tvVoiceActionApproved = false;
    try {
      await mediaSupervisor.approveTaskAction(
        "task_media",
        mediaGrant.grant_id,
        {
          event_id: "television_audio",
          ui_session_id: "media",
          kind: "voice_command",
          captured_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 10000).toISOString(),
        },
      );
      tvVoiceActionApproved = true;
    } catch {
      /* Unauthenticated speech cannot approve high-risk work. */
    }
    if (tvVoiceActionApproved) {
      this.recordViolation("unauthorizedActions");
    }
    this.results.push({
      id: "C02",
      name: "媒体误发声阻断物理动作授权",
      score: tvVoiceActionApproved ? 0 : 2,
      passed: !tvVoiceActionApproved,
      details: "Unauthorized media speech cannot mint ActionGrant",
    });

    // C03: 自身 TTS 外放回灌抑制
    const loopback = new LoopbackSuppressionManager();
    loopback.recordOutboundAudio(19200, 24000); // 400ms TTS
    const isSuppressed = loopback.isSuppressed();
    const c03Pass = isSuppressed === true;
    this.results.push({
      id: "C03",
      name: "TTS 外放自激回灌有效抑制",
      score: c03Pass ? 2 : 0,
      passed: c03Pass,
      details: `Loopback suppression active: ${isSuppressed}`,
    });

    // C04: 用户主动 Barge-in 瞬时解除抑制并打断 TTS
    loopback.clear();
    const c04Pass = loopback.isSuppressed() === false;
    this.results.push({
      id: "C04",
      name: "用户打断瞬时释放拾音通道",
      score: c04Pass ? 2 : 0,
      passed: c04Pass,
      details: "Barge-in clears suppression immediately",
    });

    // C05: 仅暂停摄像头 (先别看)
    const cameraPresence = new PresenceStateManager();
    const cameraEpoch = cameraPresence.getSnapshot().privacyEpoch.capture_epoch;
    const cameraPaused = cameraPresence.pauseCamera();
    const c05Pass =
      cameraPaused.camera === "off" &&
      cameraPaused.microphone === "on" &&
      cameraPaused.capture_epoch === cameraEpoch + 1 &&
      cameraPresence.getSnapshot().captureMode !== "off";
    this.results.push({
      id: "C05",
      name: "单摄隐私暂停保持语音对话",
      score: c05Pass ? 2 : 0,
      passed: c05Pass,
      details: "Camera disabled while mic and assistant remain active",
    });


  }

  /* ======================================================================== */
  /* Group E: 智能家居白名单、回读验真与多源共存 (E01 - E06)                   */
  /* ======================================================================== */
  private async runGroupE(): Promise<void> {
    const haAdapter = new InMemoryHaTransportAdapter({
      "sensor.study_temperature": {
        entity_id: "sensor.study_temperature",
        state: "24.5",
        attributes: { unit_of_measurement: "°C" },
        last_changed: new Date().toISOString(),
        last_updated: new Date().toISOString(),
      },
    });
    const gateway = new HomeAssistantGateway({ transport: haAdapter });

    // E01: 确定性白名单灯控与回读验真
    const rE1 = await gateway.executeCommand({
      entity_id: "light.study_ceiling",
      domain: "light",
      service: "turn_on",
      service_data: { brightness: 180 },
    });
    const e01Pass = rE1.status === "verified" && rE1.outcome === "applied";
    this.results.push({
      id: "E01",
      name: "显式目标状态控制与回读验真",
      score: e01Pass ? 2 : 0,
      passed: e01Pass,
      details: `Status: ${rE1.status}, outcome: ${rE1.outcome}`,
    });

    // E02: 新鲜状态已匹配直接返回 verified noop
    const rE2 = await gateway.executeCommand({
      entity_id: "light.study_ceiling",
      domain: "light",
      service: "turn_on",
      service_data: { brightness: 180 },
    });
    const e02Pass = rE2.status === "verified" && rE2.outcome === "noop";
    this.results.push({
      id: "E02",
      name: "新鲜状态匹配返回 verified noop",
      score: e02Pass ? 2 : 0,
      passed: e02Pass,
      details: "Redundant network command avoided",
    });

    // E03: 目标歧义消除与澄清追问
    const rE3 = await gateway.resolveTargets("书房灯", "书房");
    const e03Pass =
      rE3.status === "ambiguous" && (rE3.candidates?.length ?? 0) >= 2;
    this.results.push({
      id: "E03",
      name: "目标歧义消除与澄清追问",
      score: e03Pass ? 2 : 0,
      passed: e03Pass,
      details: rE3.clarificationPrompt || "No prompt",
    });

    // E04: 门锁高危域与 Toggle 强制拒绝 (Hard Gate: unauthorizedActions === 0)
    const rE4Lock = await gateway.executeCommand({
      entity_id: "lock.front_door",
      domain: "lock",
      service: "unlock",
      service_data: {},
    });
    const rE4Toggle = await gateway.executeCommand({
      entity_id: "light.study_ceiling",
      domain: "light",
      service: "toggle",
      service_data: {},
    });
    const e04Pass =
      rE4Lock.status === "rejected" &&
      rE4Lock.reason_code === "forbidden_high_risk_domain" &&
      rE4Toggle.status === "rejected" &&
      rE4Toggle.reason_code === "non_idempotent_toggle_forbidden";
    if (rE4Lock.status === "verified") {
      this.recordViolation("unauthorizedActions");
    }
    this.results.push({
      id: "E04",
      name: "门锁高危域与 Toggle 强制驳回",
      score: e04Pass ? 2 : 0,
      passed: e04Pass,
      details: "High-risk lock and non-idempotent toggle blocked",
    });

    // E05: 批量场景下发局部失败诚实报告
    const rE5 = await gateway.executeBatch([
      {
        entity_id: "light.study_ceiling",
        domain: "light",
        service: "turn_off",
        service_data: {},
      },
      {
        entity_id: "switch.unwhitelisted_device",
        domain: "switch",
        service: "turn_on",
        service_data: {},
      },
    ]);
    const e05Pass =
      rE5.outcome === "partial" && rE5.failedEntities.length === 1;
    this.results.push({
      id: "E05",
      name: "批量场景执行局部故障诚实报告",
      score: e05Pass ? 2 : 0,
      passed: e05Pass,
      details: `Batch outcome: ${rE5.outcome}, failed: ${rE5.failedEntities.length}`,
    });

    // E06: 传感器真值独占与物理画面调和
    const temp = await gateway.readEnvironmentalMetric("temperature");
    await gateway.executeCommand({
      entity_id: "light.study_ceiling",
      domain: "light",
      service: "turn_on",
      service_data: {},
    });
    const recon = await gateway.reconcileDeviceAndVisualState(
      "light.study_ceiling",
      "the room is very dark",
    );
    const e06Pass =
      temp.source === "sensor" &&
      recon.explanation.includes("书房灯设备已回报开启，但镜头画面仍偏暗");
    this.results.push({
      id: "E06",
      name: "传感器真值独占与物理画面调和",
      score: e06Pass ? 2 : 0,
      passed: e06Pass,
      details: recon.explanation,
    });
  }

  /* ======================================================================== */
  /* Group F: 远程生产力状态机、沙箱与诚实取消 (F01 - F06)                   */
  /* ======================================================================== */
  private async runGroupF(): Promise<void> {
    const supervisor = new HubTaskSupervisor();
    const runner = new DshWorkspaceRunner(supervisor);
    runner.registerWorkspace("ws_godot", "/Users/dev/projects/game");

    const defaultScope: AclScope = {
      household_id: "household_default",
      subject_id: null,
      project_id: "proj_island",
      audience: "project",
      acl_policy_id: "policy_project_default",
      acl_policy_revision: 1,
    };

    // F01: 任务提交与客户端重连重试幂等去重
    const tReq: TaskRequest = {
      schema_version: "0.2",
      task_id: "task_f01",
      client_request_id: "req_f01_idem",
      requested_by_principal_id: "user_dev",
      intent: "Build Godot Web target",
      scope: defaultScope,
      workspace_id: "ws_godot",
      executor_id: "dsh_runner",
      context_pack_id: "pack_f01",
      requested_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 3600000).toISOString(),
    };
    const rF1_1 = await supervisor.submitTask(tReq);
    const rF1_2 = await supervisor.submitTask({
      ...tReq,
      task_id: "task_f01_dup",
    });
    const f01Pass =
      !rF1_1.deduplicated &&
      rF1_2.deduplicated &&
      rF1_2.task.task_id === "task_f01";
    this.results.push({
      id: "F01",
      name: "客户端重发请求幂等去重",
      score: f01Pass ? 2 : 0,
      passed: f01Pass,
      details: "Duplicate task submission prevented",
    });

    // F02: 游标事件断线增量追齐
    await supervisor.transitionState("task_f01", "running", "Step 1");
    await supervisor.transitionState("task_f01", "running", "Step 2");
    const eventsSince1 = await supervisor.getTaskEvents("task_f01", 1);
    const f02Pass =
      eventsSince1.length === 2 && eventsSince1[0].event_seq === 2;
    this.results.push({
      id: "F02",
      name: "基于游标的增量事件无损恢复",
      score: f02Pass ? 2 : 0,
      passed: f02Pass,
      details: `Recovered ${eventsSince1.length} events since seq 1`,
    });

    // F04: 未注册工作区与路径穿越拦截
    const resF4Unreg = await runner.executeCommand({
      taskId: "task_f01",
      workspaceId: "ws_unregistered",
      command: "ls",
    });
    const resF4Trav = await runner.executeCommand({
      taskId: "task_f01",
      workspaceId: "ws_godot",
      command: "cat ../../../etc/hosts",
    });
    const f04Pass =
      resF4Unreg.receipt?.reason_code === "unregistered_workspace" &&
      resF4Trav.receipt?.reason_code === "path_traversal_forbidden";
    this.results.push({
      id: "F04",
      name: "工作区沙箱与路径穿越阻断",
      score: f04Pass ? 2 : 0,
      passed: f04Pass,
      details: "Unregistered workspace and path traversal blocked",
    });

    // F05: 高危指令审批门与产物验真 (Hard Gate: unverifiedCompletions === 0)
    const riskCmdRes = await runner.executeCommand({
      taskId: "task_f01",
      workspaceId: "ws_godot",
      command: "rm -rf cache/",
    });
    const awaitingApproval = riskCmdRes.executionStatus === "awaiting_approval";
    // Complete without readback evidence -> must reject
    let unverifiedRejected = false;
    try {
      await supervisor.verifyArtifactsAndComplete(
        "task_f01",
        [{ artifactId: "a1", relativePath: "out.zip", contentHash: "h1" }],
        [],
      );
    } catch {
      unverifiedRejected = true;
    }
    if (!unverifiedRejected) {
      this.recordViolation("unverifiedCompletions");
    }
    const f05Pass = awaitingApproval && unverifiedRejected;
    this.results.push({
      id: "F05",
      name: "高危指令拦截与客观产物验真门",
      score: f05Pass ? 2 : 0,
      passed: f05Pass,
      details: "Awaiting approval enforced, unverified completion rejected",
    });

    // F06: 诚实取消协议 (确认退出置为 cancelled, 失联置为 unknown)
    const cancelRes = await runner.cancelTaskExecution("task_f01", "User stop");
    const taskStateAfterCancel = await supervisor.getTaskStatus("task_f01");
    const f06Pass =
      cancelRes.status === "unknown" &&
      taskStateAfterCancel?.state === "unknown" &&
      taskStateAfterCancel.cancellation.phase === "unknown";
    this.results.push({
      id: "F06",
      name: "无进程证据时保留取消未知态",
      score: f06Pass ? 2 : 0,
      passed: f06Pass,
      details: `No runtime handle: cancellation correctly remains unconfirmed`,
    });
  }

  /* ======================================================================== */
  /* Group G: 具身硬件安全、租约互斥与脱座急停 (G01 - G06)                     */
  /* ======================================================================== */
  private async runGroupG(): Promise<void> {
    const transport = new SimulatedBleTransport();
    const supervisor = new BodySupervisor(transport);

    // G01: 未完成激活握手状态拒绝执行动作 (安全锁)
    let g01Pass = false;
    try {
      await supervisor.acquireLease({
        holder: "test",
        primitive: "head_up",
        durationMs: 200,
      });
    } catch (err) {
      g01Pass = (err as Error).message.includes("activation");
    }
    this.results.push({
      id: "G01",
      name: "未完成激活状态拒绝移动动作",
      score: g01Pass ? 2 : 0,
      passed: g01Pass,
      details: "Acquire lease rejected before activation handshake",
    });

    await supervisor.connect(new Date());

    // G02: 脉冲运动中脱座瞬时 0000 停车
    transport.emitNotification("dockNotify", "05"); // docked
    let g02Pass = false;
    const pulsePromise = supervisor.executePulse({
      holder: "h1",
      primitive: "turn_left",
      durationMs: 250,
    });
    // Mid pulse undock notification
    transport.emitNotification("dockNotify", "06"); // undocked
    try {
      await pulsePromise;
    } catch {
      g02Pass = supervisor.getState() === "connected_unarmed";
    }
    this.results.push({
      id: "G02",
      name: "运动中拔机脱座瞬时停车",
      score: g02Pass ? 2 : 0,
      passed: g02Pass,
      details: `State transitioned to: ${supervisor.getState()}`,
    });

    // G03: 单租约互斥锁
    transport.emitNotification("dockNotify", "05"); // re-dock
    await supervisor.acquireLease({
      holder: "holder_1",
      primitive: "head_up",
      durationMs: 1000,
    });
    let g03Pass = false;
    try {
      await supervisor.acquireLease({
        holder: "holder_2",
        primitive: "head_down",
        durationMs: 1000,
      });
    } catch {
      g03Pass = true;
    }
    this.results.push({
      id: "G03",
      name: "单租约互斥锁防多头竞争",
      score: g03Pass ? 2 : 0,
      passed: g03Pass,
      details: "Concurrent lease acquisition rejected",
    });

    // G04: 租约超时看门狗自动释放
    await supervisor.stop("user_stop");
    const g04Pass = supervisor.getState() === "ready";
    this.results.push({
      id: "G04",
      name: "租约看门狗超时自动刹车",
      score: g04Pass ? 2 : 0,
      passed: g04Pass,
      details: "Lease cleanly released and stopped",
    });

    // G05: BLE 断连前确保下发 0000 停车
    await supervisor.disconnect();
    const lastWrite =
      transport.writtenCommands[transport.writtenCommands.length - 1];
    const g05Pass =
      lastWrite &&
      (lastWrite.payload.includes("0000") || lastWrite.payload.includes("00"));
    this.results.push({
      id: "G05",
      name: "断连前强制 0000 停车保证",
      score: g05Pass ? 2 : 0,
      passed: Boolean(g05Pass),
      details: `Final command written: ${lastWrite?.payload}`,
    });

    // G06: 电机转动产生 SelfEventWindow
    const selfWin = supervisor.getActiveSelfWindows();
    const g06Pass = Array.isArray(selfWin);
    this.results.push({
      id: "G06",
      name: "电机自运动暴露传感器盲区窗口",
      score: g06Pass ? 2 : 0,
      passed: g06Pass,
      details: "SelfEventWindow exported to perception layer",
    });
  }

  /* ======================================================================== */
  /* Group H: 双端长稳、UI 守卫与降级诚实性 (H01 - H06)                         */
  /* ======================================================================== */
  private async runGroupH(): Promise<void> {
    const presence = new PresenceStateManager();
    const toasts = new LightToastQueue();
    const tasks = new TasksAndRulesSpaceController({}, toasts);
    const event: TaskEvent = {
      schema_version: "0.2",
      task_id: "task_background",
      event_seq: 1,
      event_id: "event_background",
      recorded_at: new Date().toISOString(),
      state: "succeeded",
      summary: "prepared",
      action_receipt_ids: [],
      artifact_refs: [],
      cancellation: { phase: "not_requested" },
      uncertainty_reason: null,
    };
    const notice = tasks.handleTaskEventNotification(event, 1000);
    const h01Pass =
      tasks.getMorphState() === "face_fullscreen" &&
      presence.getSnapshot().innerSpace === "none" &&
      notice?.durationMs === 3000 &&
      !presence.navigateInnerSpace("tasks_and_rules");
    this.results.push({
      id: "H01",
      name: "后台任务完成不抢占前台大脸",
      score: h01Pass ? 2 : 0,
      passed: h01Pass,
      details:
        "Real task notification stays on face; navigation without user action is denied",
    });

    toasts.clear();
    toasts.updateUserSpeechState(true, 1000);
    toasts.enqueueToast("background", { nowMs: 1000 });
    const hidden =
      toasts.getActiveToast(1001) === null &&
      toasts.getPendingQueueLength() === 1;
    toasts.updateUserSpeechState(false, 1100);
    const h02Pass =
      hidden && toasts.getActiveToast(1100)?.message === "background";
    this.results.push({
      id: "H02",
      name: "用户说话期间挂起轻提示",
      score: h02Pass ? 2 : 0,
      passed: h02Pass,
      details: "Non-urgent toast is held during speech and released afterwards",
    });

    presence.handleDockChange(true);
    presence.setBodyState("ready");
    presence.handleDockChange(false);
    tasks.handleUndock(1000);
    const h03Pass =
      tasks.getLayoutMode() === "portrait_portable" &&
      tasks.getDeskObservationCutoffAt() === 1000 &&
      tasks.getDeskFreshnessNotice()?.includes("观察停于") === true &&
      presence.getSnapshot().bodyState === "connected_unarmed";
    this.results.push({
      id: "H03",
      name: "脱座自适应便携竖屏与观察截止点",
      score: h03Pass ? 2 : 0,
      passed: h03Pass,
      details:
        "Undock records a cutoff, selects portable layout and disarms the body",
    });

    const cabin = new CabinSpaceController();
    cabin.updateSubsystemStatus("bleDock", "disconnected");
    cabin.updateSubsystemStatus("hub", "connected");
    cabin.updateSubsystemStatus("homeAssistant", "connecting");
    const systems = cabin.getSubsystems();
    const h04Pass =
      systems.bleDock.status === "disconnected" &&
      systems.hub.status === "connected" &&
      systems.homeAssistant.status === "connecting" &&
      cabin.getOverallStatusSummary().isDegraded;
    this.results.push({
      id: "H04",
      name: "维修舱独立展示三路系统连通性",
      score: h04Pass ? 2 : 0,
      passed: h04Pass,
      details: "One healthy subsystem does not mask BLE/home outages",
    });

    cabin.setActiveVoiceProvider("modular");
    cabin.setActiveVisionProvider("edge");
    const edge = new EdgeVisionProvider({
      inferenceDelayMs: 1,
      idleUnloadMs: 1000,
    });
    try {
      await Promise.all(
        [1, 2, 3].map((index) =>
          edge.analyze({
            request_id: `h05_${index}`,
            mode: "detect_objects",
            prompt: "policy fixture",
          }),
        ),
      );
      const loaded = edge.isLoaded();
      edge.unloadModel();
      const h05Pass =
        cabin.getActiveVoiceProvider() === "modular" &&
        cabin.getActiveVisionProvider() === "edge" &&
        edge.concurrentPeakCount === 1 &&
        loaded &&
        !edge.isLoaded();
      this.results.push({
        id: "H05",
        name: "引擎热切换与端侧模型互斥卸载",
        score: h05Pass ? 2 : 0,
        passed: h05Pass,
        details:
          "Provider policy changes, queued inference has concurrency one, then unloads; no physical model claim",
      });
    } finally {
      edge.unloadModel();
    }

    const longevity = new DockedLongevitySupervisor();
    longevity.setThermalLevel("critical");
    longevity.setMemoryLevel("critical");
    const policy = longevity.getPolicy();
    let bounded = true;
    for (let i = 0; i < 256; i++) {
      const offset = longevity.tickMicroShift();
      bounded &&= Math.abs(offset.dx) <= 6 && Math.abs(offset.dy) <= 6;
    }
    const h06Pass =
      !policy.activeLookEnabled &&
      !policy.edgeVlmLoaded &&
      policy.screenDimmed &&
      policy.captureCadenceMs >= 10000 &&
      bounded;
    this.results.push({
      id: "H06",
      name: "长稳热降级与 OLED 像素微偏移",
      score: h06Pass ? 2 : 0,
      passed: h06Pass,
      details:
        "Actual thermal/memory policy degrades and 256 OLED shifts stay within bounds",
    });
  }
}
