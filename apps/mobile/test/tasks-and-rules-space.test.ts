import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TasksAndRulesSpaceController,
  type TasksMorphState,
  type LayoutMode,
} from "../src/ui/tasks-and-rules-space.js";
import { LightToastQueue } from "../src/ui/light-toast-queue.js";
import { LOOI_PALETTE } from "../src/ui/theme.js";
import type { TaskEvent } from "@super-looi/contracts";

describe("TasksAndRulesSpaceController: 约定与任务簿 Conformal UI (Phase 3)", () => {
  it("manages conformal morph transitions between robot face and tasks ledger", async () => {
    const statesReported: TasksMorphState[] = [];

    const controller = new TasksAndRulesSpaceController({
      onMorphStateChange: (state) => {
        statesReported.push(state);
      },
    });

    assert.equal(controller.getMorphState(), "face_fullscreen");

    // Open tasks & rules
    await controller.openTasksAndRules();
    assert.equal(controller.getMorphState(), "tasks_and_rules_open");
    assert.deepEqual(statesReported, [
      "eyes_closing_to_ledger",
      "tasks_and_rules_open",
    ]);

    // Close tasks & rules
    await controller.closeTasksAndRules();
    assert.equal(controller.getMorphState(), "face_fullscreen");
    assert.deepEqual(statesReported, [
      "eyes_closing_to_ledger",
      "tasks_and_rules_open",
      "ledger_converging_to_eyes",
      "face_fullscreen",
    ]);
  });

  it("handles undocked transition with honest desk observation cutoff boundary", () => {
    const layoutsReported: LayoutMode[] = [];

    const controller = new TasksAndRulesSpaceController({
      onLayoutChange: (mode) => {
        layoutsReported.push(mode);
      },
    });

    assert.equal(controller.getLayoutMode(), "landscape_docked");
    assert.equal(controller.getDeskFreshnessNotice(), null);

    // Robot removed from dock at 19:42 local time
    const cutoffDate = new Date("2026-06-24T19:42:00");
    controller.handleUndock(cutoffDate.getTime());

    assert.equal(controller.getLayoutMode(), "portrait_portable");
    assert.equal(layoutsReported[0], "portrait_portable");

    const notice = controller.getDeskFreshnessNotice();
    assert.ok(notice);
    assert.match(notice, /已离开底座 · 桌面观察停于 \d{2}:\d{2}/);

    // Redocked
    controller.handleDock();
    assert.equal(controller.getLayoutMode(), "landscape_docked");
    assert.equal(controller.getDeskFreshnessNotice(), null);
  });

  it("queues gentle 3-second toasts for background task events without hijacking foreground face", () => {
    const toastQueue = new LightToastQueue();
    const controller = new TasksAndRulesSpaceController({}, toastQueue);

    // In face_fullscreen mode: background task completes
    const successEvent: TaskEvent = {
      schema_version: "0.2",
      task_id: "task_export_01",
      event_seq: 4,
      event_id: "tev_101",
      recorded_at: new Date().toISOString(),
      state: "succeeded",
      summary: "HTML5 build ready",
      action_receipt_ids: ["rcpt_1"],
      artifact_refs: [
        { artifact_id: "art_zip", verified_at: new Date().toISOString(), evidence_ids: ["ev_1"] },
      ],
      cancellation: { phase: "not_requested" },
      uncertainty_reason: null,
    };

    const toast1 = controller.handleTaskEventNotification(successEvent);
    assert.ok(toast1);
    assert.equal(toast1.message, "准备好了，打开任务可以看");
    assert.equal(toast1.color, LOOI_PALETTE.confirmGreen);
    assert.equal(toast1.durationMs, 3000);

    // Background task requires approval
    const approvalEvent: TaskEvent = {
      ...successEvent,
      state: "awaiting_approval",
      summary: "Clean repo needs permission",
    };

    const toast2 = controller.handleTaskEventNotification(approvalEvent);
    assert.ok(toast2);
    assert.equal(toast2.message, "任务需要授权，打开任务可确认");
    assert.equal(toast2.color, LOOI_PALETTE.amberWarning);

    // If user is already on the tasks screen, do not spam toasts
    controller.openTasksAndRules();
    const toastInSpace = controller.handleTaskEventNotification(successEvent);
    assert.equal(toastInSpace, null);
  });

  it("formats task cards with semantic colors and honest cancellation labels", () => {
    const controller = new TasksAndRulesSpaceController();

    // 1. Running task
    const runningCard = controller.formatTaskCard({
      schema_version: "0.2",
      task_id: "t_1",
      event_seq: 2,
      event_id: "tev_1",
      recorded_at: new Date().toISOString(),
      state: "running",
      summary: "Compiling assets",
      action_receipt_ids: [],
      artifact_refs: [],
      cancellation: { phase: "not_requested" },
      uncertainty_reason: null,
    });
    assert.equal(runningCard.stateLabel, "执行中");
    assert.equal(runningCard.badgeColor, LOOI_PALETTE.presenceCyan);

    // 2. Awaiting approval
    const approvalCard = controller.formatTaskCard({
      schema_version: "0.2",
      task_id: "t_2",
      event_seq: 3,
      event_id: "tev_2",
      recorded_at: new Date().toISOString(),
      state: "awaiting_approval",
      summary: "rm -rf build cache",
      action_receipt_ids: [],
      artifact_refs: [],
      cancellation: { phase: "not_requested" },
      uncertainty_reason: null,
    });
    assert.equal(approvalCard.stateLabel, "待审批");
    assert.equal(approvalCard.badgeColor, LOOI_PALETTE.amberWarning);

    // 3. Succeeded with artifacts
    const succeededCard = controller.formatTaskCard({
      schema_version: "0.2",
      task_id: "t_3",
      event_seq: 5,
      event_id: "tev_3",
      recorded_at: new Date().toISOString(),
      state: "succeeded",
      summary: "Export done",
      action_receipt_ids: ["r_1"],
      artifact_refs: [
        { artifact_id: "art_1", verified_at: new Date().toISOString(), evidence_ids: ["e_1"] },
      ],
      cancellation: { phase: "not_requested" },
      uncertainty_reason: null,
    });
    assert.equal(succeededCard.stateLabel, "已完成 · 产物已核验");
    assert.equal(succeededCard.badgeColor, LOOI_PALETTE.confirmGreen);
    assert.equal(succeededCard.artifactsCount, 1);

    // 4. Unknown outcome during cancel (connection lost)
    const unknownCard = controller.formatTaskCard({
      schema_version: "0.2",
      task_id: "t_4",
      event_seq: 6,
      event_id: "tev_4",
      recorded_at: new Date().toISOString(),
      state: "unknown",
      summary: "停止请求已发出，远端进程终态待核实",
      action_receipt_ids: [],
      artifact_refs: [],
      cancellation: { phase: "unknown", request_id: "req_1", requested_at: "...", stop_sent_at: "..." },
      uncertainty_reason: "transport_lost",
    });
    assert.equal(unknownCard.stateLabel, "状态待核实");
    assert.equal(unknownCard.cancellationLabel, "结果待核实（连接中断）");
    assert.equal(unknownCard.badgeColor, LOOI_PALETTE.alertCoral);
  });

  it("manages commitments (约定 & reminders) list", () => {
    const controller = new TasksAndRulesSpaceController();

    assert.equal(controller.getCommitments().length, 0);

    controller.addCommitment({
      id: "rule_night_sleep",
      title: "每日 22:30 提醒熄灯",
      conditionDescription: "时间到达 22:30 且人在书房",
      status: "active",
      createdAt: new Date().toISOString(),
    });

    assert.equal(controller.getCommitments().length, 1);
    assert.equal(controller.getCommitments()[0].title, "每日 22:30 提醒熄灯");

    controller.removeCommitment("rule_night_sleep");
    assert.equal(controller.getCommitments().length, 0);
  });
});
