import type { MemoryClaim, Id } from "@super-looi/contracts";
import { LOOI_PALETTE, getColorForClaimStatus } from "./theme.js";

export type ConformalMorphState =
  | "face_fullscreen"
  | "eyes_closing_to_nodes"
  | "memories_timeline_open"
  | "nodes_converging_to_eyes";

export interface TimelineAnchorNodes {
  leftNode: { x: number; y: number; glowColor: string };
  rightNode: { x: number; y: number; glowColor: string };
}

export interface MiniRobotAvatarState {
  gazeVector: { x: number; y: number };
  gazeTargetCardId: Id | null;
  expression: "curious" | "neutral" | "sleeping";
}

export interface FormattedMemoryCard {
  claimId: Id;
  revision: number;
  status: MemoryClaim["status"];
  statusLabel: string;
  statusBadgeColor: string;
  heroImageUri?: string;
  expiredBadgeText?: string;
  whenText: string;
  whereText: string;
  howText: string;
  trustLabel: string;
  rawClaim: MemoryClaim;
}

export interface ConformalSpaceEvents {
  onMorphStateChange?: (state: ConformalMorphState) => void;
  onCardSelected?: (card: FormattedMemoryCard) => void;
  onClaimActionTriggered?: (action: "location_correction" | "item_removed" | "forget_memory", claimId: Id, payload?: unknown) => void;
}

export class MemoriesConformalSpaceController {
  private morphState: ConformalMorphState = "face_fullscreen";
  private selectedClaimId: Id | null = null;
  private miniRobotAvatar: MiniRobotAvatarState = {
    gazeVector: { x: 0, y: 0 },
    gazeTargetCardId: null,
    expression: "neutral",
  };

  private timelineAnchorNodes: TimelineAnchorNodes = {
    leftNode: { x: 80, y: 120, glowColor: LOOI_PALETTE.presenceCyan },
    rightNode: { x: 240, y: 120, glowColor: LOOI_PALETTE.presenceCyan },
  };

  constructor(private readonly events: ConformalSpaceEvents = {}) {}

  public getMorphState(): ConformalMorphState {
    return this.morphState;
  }

  public getTimelineAnchorNodes(): TimelineAnchorNodes {
    return this.timelineAnchorNodes;
  }

  public getMiniRobotAvatar(): MiniRobotAvatarState {
    return { ...this.miniRobotAvatar };
  }

  public getSelectedClaimId(): Id | null {
    return this.selectedClaimId;
  }

  /**
   * Signature Conformal Transition:
   * Smoothly morphs the robot's glowing eyes into the timeline navigation nodes.
   */
  public async openMemoriesTimeline(): Promise<void> {
    if (this.morphState === "memories_timeline_open") return;

    this.setMorphState("eyes_closing_to_nodes");
    // Simulate eye-to-node animation step (e.g. 50ms)
    await new Promise((resolve) => setTimeout(resolve, 50));

    this.miniRobotAvatar = {
      gazeVector: { x: 0.1, y: 0.1 },
      gazeTargetCardId: null,
      expression: "curious",
    };
    this.setMorphState("memories_timeline_open");
  }

  /**
   * Reverses the timeline nodes back into fullscreen robot eyes.
   */
  public async closeMemoriesTimeline(): Promise<void> {
    if (this.morphState === "face_fullscreen") return;

    this.setMorphState("nodes_converging_to_eyes");
    await new Promise((resolve) => setTimeout(resolve, 50));

    this.selectedClaimId = null;
    this.miniRobotAvatar = {
      gazeVector: { x: 0, y: 0 },
      gazeTargetCardId: null,
      expression: "neutral",
    };
    this.setMorphState("face_fullscreen");
  }

  /**
   * User taps a memory card:
   * Corner mini robot avatar shifts its gaze directly toward the selected photo!
   */
  public selectMemoryCard(card: FormattedMemoryCard): void {
    this.selectedClaimId = card.claimId;
    this.miniRobotAvatar = {
      gazeVector: { x: 0.65, y: 0.35 }, // Gaze focused toward bottom-right content card
      gazeTargetCardId: card.claimId,
      expression: "curious",
    };
    this.events.onCardSelected?.(card);
  }

  /** Clearing the inspector also clears the avatar's reference to a forgotten/filtered claim. */
  public clearMemorySelection(): void {
    this.selectedClaimId = null;
    this.miniRobotAvatar = { gazeVector: { x: 0, y: 0 }, gazeTargetCardId: null, expression: "neutral" };
  }

  /**
   * Formats a raw MemoryClaim into a human-friendly life fragment card with 4-question clarity.
   */
  public formatClaimCard(claim: MemoryClaim): FormattedMemoryCard {
    const obj = (claim.object as Record<string, unknown>) ?? {};
    const location = String(obj.location ?? obj.text ?? "桌面");

    let statusLabel = "推测 · 待确认";
    let trustLabel = "依据近期规律推测";
    if (claim.status === "confirmed") {
      statusLabel = "已确认事实";
      trustLabel = "主人已确认准确无误";
    } else if (claim.status === "observed") {
      statusLabel = "观察记录";
      trustLabel = "由摄像头抓拍观测";
    }

    let howText = "摄像头抓拍分析";
    if (claim.source_kind === "authenticated_user_statement") {
      howText = "主人对话记录";
    } else if (claim.source_kind === "audio_segment") {
      howText = "环境拾音分析";
    }

    const date = new Date(claim.observed_at);
    const whenText = `${date.getMonth() + 1}月${date.getDate()}日 ${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;

    const expiredBadgeText =
      claim.source_availability === "source_expired"
        ? "原始证据已按隐私策略安全删除（仅保留事实摘要）"
        : undefined;

    return {
      claimId: claim.claim_id,
      revision: claim.revision,
      status: claim.status,
      statusLabel,
      statusBadgeColor: getColorForClaimStatus(claim.status),
      heroImageUri: claim.source_availability === "retained" ? `evidence://${claim.evidence_ids[0] || "hero"}` : undefined,
      expiredBadgeText,
      whenText,
      whereText: location,
      howText,
      trustLabel,
      rawClaim: claim,
    };
  }

  /* Natural User Actions */

  public triggerLocationCorrection(claimId: Id, newLocation: string): void {
    this.events.onClaimActionTriggered?.("location_correction", claimId, { newLocation });
  }

  public triggerItemRemoved(claimId: Id): void {
    this.events.onClaimActionTriggered?.("item_removed", claimId);
  }

  public triggerForgetMemory(claimId: Id): void {
    this.events.onClaimActionTriggered?.("forget_memory", claimId);
  }

  private setMorphState(state: ConformalMorphState): void {
    this.morphState = state;
    this.events.onMorphStateChange?.(state);
  }
}
