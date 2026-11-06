import {
  LOOI_PALETTE,
  getColorForReceiptStatus,
  getColorForClaimStatus,
} from "./theme.js";
import type { ActionReceiptStatus, ClaimStatus } from "@super-looi/contracts";

export interface ToastItem {
  id: string;
  message: string;
  color: string;
  durationMs: number; // default 3000ms
  priority?: "low" | "normal" | "urgent";
  createdAtMs: number;
}

export class LightToastQueue {
  private activeToast: (ToastItem & { expiresAtMs: number }) | null = null;
  private pendingQueue: ToastItem[] = [];
  private isUserSpeaking = false;
  private pausedAtMs: number | null = null;

  public updateUserSpeechState(isSpeaking: boolean, nowMs: number = Date.now()): void {
    if (this.isUserSpeaking === isSpeaking) return;
    if (isSpeaking && this.activeToast && this.activeToast.priority !== "urgent") {
      this.pausedAtMs = nowMs;
    } else if (!isSpeaking && this.pausedAtMs !== null) {
      if (this.activeToast) this.activeToast.expiresAtMs += Math.max(0, nowMs - this.pausedAtMs);
      this.pausedAtMs = null;
    }
    this.isUserSpeaking = isSpeaking;
    if (!this.isUserSpeaking && !this.activeToast && this.pendingQueue.length > 0) {
      this.popNextToast(nowMs);
    }
  }

  public enqueueToast(
    message: string,
    options: {
      color?: string;
      durationMs?: number;
      priority?: "low" | "normal" | "urgent";
      receiptStatus?: ActionReceiptStatus;
      claimStatus?: ClaimStatus;
      nowMs?: number;
    } = {}
  ): ToastItem {
    let color = options.color ?? LOOI_PALETTE.presenceCyan;
    if (options.receiptStatus) {
      color = getColorForReceiptStatus(options.receiptStatus);
    } else if (options.claimStatus) {
      color = getColorForClaimStatus(options.claimStatus);
    }

    const now = options.nowMs ?? Date.now();
    const toast: ToastItem = {
      id: `toast_${now}_${Math.random().toString(36).substring(2, 6)}`,
      message,
      color,
      durationMs: options.durationMs ?? 3000,
      priority: options.priority ?? "normal",
      createdAtMs: now,
    };
    // If user is speaking and not urgent, defer to pending queue so speech isn't distracted
    if (this.isUserSpeaking && toast.priority !== "urgent") {
      this.pendingQueue.push(toast);
      return toast;
    }

    if (!this.activeToast) {
      this.activeToast = {
        ...toast,
        expiresAtMs: now + toast.durationMs,
      };
    } else {
      this.pendingQueue.push(toast);
    }

    return toast;
  }

  public getActiveToast(nowMs: number = Date.now()): ToastItem | null {
    if (this.pausedAtMs !== null) return null;
    if (!this.activeToast) {
      return null;
    }

    if (nowMs >= this.activeToast.expiresAtMs) {
      this.activeToast = null;
      if (!this.isUserSpeaking && this.pendingQueue.length > 0) {
        this.popNextToast(nowMs);
      }
      return this.activeToast;
    }

    return this.activeToast;
  }

  public getPendingQueueLength(): number {
    return this.pendingQueue.length;
  }

  public clear(): void {
    this.activeToast = null;
    this.pendingQueue = [];
    this.pausedAtMs = null;
  }

  private popNextToast(nowMs: number): void {
    const next = this.pendingQueue.shift();
    if (next) {
      this.activeToast = {
        ...next,
        expiresAtMs: nowMs + next.durationMs,
      };
    }
  }
}
