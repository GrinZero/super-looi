import type { TaskEvent, TaskStatus, Id } from "@super-looi/contracts";
import { LOOI_PALETTE } from "./theme.js";
import { LightToastQueue, type ToastItem } from "./light-toast-queue.js";

export type TasksMorphState =
  | "face_fullscreen"
  | "eyes_closing_to_ledger"
  | "tasks_and_rules_open"
  | "ledger_converging_to_eyes";

export type LayoutMode = "landscape_docked" | "portrait_portable";

export interface FormattedTaskCard {
  taskId: Id;
  seq: number;
  state: TaskStatus;
  stateLabel: string;
  badgeColor: string;
  summary: string;
  cancellationLabel?: string;
  artifactsCount: number;
  rawEvent: TaskEvent;
}

export interface CommitmentItem {
  id: Id;
  title: string;
  conditionDescription: string;
  status: "active" | "paused" | "completed";
  createdAt: string;
}

export interface TasksAndRulesEvents {
  onMorphStateChange?: (state: TasksMorphState) => void;
  onLayoutChange?: (mode: LayoutMode) => void;
  onTaskSelected?: (task: FormattedTaskCard) => void;
}

export class TasksAndRulesSpaceController {
  private morphState: TasksMorphState = "face_fullscreen";
  private layoutMode: LayoutMode = "landscape_docked";
  private deskObservationCutoffAtMs: number | null = null;
  private readonly toastQueue: LightToastQueue;
  private readonly commitments = new Map<Id, CommitmentItem>();

  constructor(
    private readonly events: TasksAndRulesEvents = {},
    toastQueue?: LightToastQueue,
  ) {
    this.toastQueue = toastQueue ?? new LightToastQueue();
  }

  public getMorphState(): TasksMorphState {
    return this.morphState;
  }

  public getLayoutMode(): LayoutMode {
    return this.layoutMode;
  }

  public getToastQueue(): LightToastQueue {
    return this.toastQueue;
  }

  public getDeskObservationCutoffAt(): number | null {
    return this.deskObservationCutoffAtMs;
  }

  /**
   * Generates honest freshness boundary notice for undocked portable mode.
   * "已离开底座 · 桌面观察停于 19:42"
   */
  public getDeskFreshnessNotice(): string | null {
    if (
      !this.deskObservationCutoffAtMs ||
      this.layoutMode === "landscape_docked"
    ) {
      return null;
    }
    const d = new Date(this.deskObservationCutoffAtMs);
    const timeStr = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    return `已离开底座 · 桌面观察停于 ${timeStr}`;
  }

  /**
   * Adapts layout when robot is removed from dock (portable portrait mode).
   */
  public handleUndock(timestampMs: number = Date.now()): void {
    this.layoutMode = "portrait_portable";
    this.deskObservationCutoffAtMs = timestampMs;
    this.events.onLayoutChange?.(this.layoutMode);
  }

  /**
   * Restores docked landscape layout.
   */
  public handleDock(): void {
    this.layoutMode = "landscape_docked";
    this.deskObservationCutoffAtMs = null;
    this.events.onLayoutChange?.(this.layoutMode);
  }

  /**
   * Signature Conformal Transition:
   * Robot eyes morph into ledger header tabs.
   */
  public async openTasksAndRules(): Promise<void> {
    if (this.morphState === "tasks_and_rules_open") return;

    this.setMorphState("eyes_closing_to_ledger");
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.setMorphState("tasks_and_rules_open");
  }

  public async closeTasksAndRules(): Promise<void> {
    if (this.morphState === "face_fullscreen") return;

    this.setMorphState("ledger_converging_to_eyes");
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.setMorphState("face_fullscreen");
  }

  /**
   * Background task notification integration:
   * When user is on fullscreen robot face, NEVER hijack the screen with auto-navigation.
   * Instead, enqueues a gentle 3-second toast.
   */
  public handleTaskEventNotification(
    event: TaskEvent,
    nowMs: number = Date.now(),
  ): ToastItem | null {
    if (this.morphState !== "face_fullscreen") {
      return null; // Already in inner space, no need for toast
    }

    if (event.state === "succeeded") {
      return this.toastQueue.enqueueToast("准备好了，打开任务可以看", {
        color: LOOI_PALETTE.confirmGreen,
        durationMs: 3000,
        nowMs,
      });
    }

    if (event.state === "awaiting_approval") {
      return this.toastQueue.enqueueToast("任务需要授权，打开任务可确认", {
        color: LOOI_PALETTE.amberWarning,
        durationMs: 3000,
        priority: "urgent",
        nowMs,
      });
    }

    if (event.state === "failed" || event.state === "unknown") {
      return this.toastQueue.enqueueToast("任务遇到异常，可打开任务查看", {
        color: LOOI_PALETTE.alertCoral,
        durationMs: 3000,
        nowMs,
      });
    }

    return null;
  }

  /**
   * Formats raw TaskEvent into a semantic card.
   */
  public formatTaskCard(event: TaskEvent): FormattedTaskCard {
    let stateLabel = "排队中";
    let badgeColor: string = LOOI_PALETTE.presenceCyan;
    let cancellationLabel: string | undefined;

    switch (event.state) {
      case "queued":
        stateLabel = "排队中";
        badgeColor = LOOI_PALETTE.presenceCyan;
        break;
      case "running":
        stateLabel = "执行中";
        badgeColor = LOOI_PALETTE.presenceCyan;
        break;
      case "awaiting_approval":
        stateLabel = "待审批";
        badgeColor = LOOI_PALETTE.amberWarning;
        break;
      case "succeeded":
        stateLabel = "已完成 · 产物已核验";
        badgeColor = LOOI_PALETTE.confirmGreen;
        break;
      case "cancelling":
        stateLabel = "取消中";
        badgeColor = LOOI_PALETTE.alertCoral;
        cancellationLabel = "请求取消中";
        break;
      case "cancelled":
        stateLabel = "已取消";
        badgeColor = LOOI_PALETTE.alertCoral;
        cancellationLabel = "已确认停止";
        break;
      case "unknown":
        stateLabel = "状态待核实";
        badgeColor = LOOI_PALETTE.alertCoral;
        cancellationLabel = "结果待核实（连接中断）";
        break;
      case "failed":
        stateLabel = "执行失败";
        badgeColor = LOOI_PALETTE.alertCoral;
        break;
    }

    return {
      taskId: event.task_id,
      seq: event.event_seq,
      state: event.state,
      stateLabel,
      badgeColor,
      summary: event.summary,
      cancellationLabel,
      artifactsCount: event.artifact_refs.length,
      rawEvent: event,
    };
  }

  /* Commitment / Reminder Management */

  public addCommitment(item: CommitmentItem): void {
    this.commitments.set(item.id, item);
  }

  public getCommitments(): CommitmentItem[] {
    return Array.from(this.commitments.values());
  }

  public removeCommitment(id: Id): void {
    this.commitments.delete(id);
  }

  private setMorphState(state: TasksMorphState): void {
    this.morphState = state;
    this.events.onMorphStateChange?.(state);
  }
}
