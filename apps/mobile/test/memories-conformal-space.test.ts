import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MemoriesConformalSpaceController,
  type ConformalMorphState,
  type FormattedMemoryCard,
} from "../src/ui/memories-space.js";
import { LOOI_PALETTE } from "../src/ui/theme.js";
import { createMemoryClaim, type MemoryClaim } from "@super-looi/contracts";

describe("MemoriesConformalSpaceController: 脸与页面共形 and Life Fragment Cards (Phase 2)", () => {
  it("manages signature conformal morph state transitions between robot face and timeline nodes", async () => {
    const statesReported: ConformalMorphState[] = [];

    const controller = new MemoriesConformalSpaceController({
      onMorphStateChange: (state) => {
        statesReported.push(state);
      },
    });

    assert.equal(controller.getMorphState(), "face_fullscreen");

    // Open memories timeline: eyes morph into timeline anchor nodes
    await controller.openMemoriesTimeline();

    assert.equal(controller.getMorphState(), "memories_timeline_open");
    assert.deepEqual(statesReported, [
      "eyes_closing_to_nodes",
      "memories_timeline_open",
    ]);

    // Timeline anchor nodes carry cyan glow coordinates
    const anchorNodes = controller.getTimelineAnchorNodes();
    assert.equal(anchorNodes.leftNode.glowColor, LOOI_PALETTE.presenceCyan);
    assert.equal(anchorNodes.rightNode.glowColor, LOOI_PALETTE.presenceCyan);
    assert.equal(anchorNodes.leftNode.x, 80);
    assert.equal(anchorNodes.rightNode.x, 240);

    // Close memories timeline: nodes converge back to full-screen robot face
    await controller.closeMemoriesTimeline();

    assert.equal(controller.getMorphState(), "face_fullscreen");
    assert.deepEqual(statesReported, [
      "eyes_closing_to_nodes",
      "memories_timeline_open",
      "nodes_converging_to_eyes",
      "face_fullscreen",
    ]);
  });

  it("shifts mini-robot avatar gaze toward selected memory card", async () => {
    let selectedCard: FormattedMemoryCard | null = null;

    const controller = new MemoriesConformalSpaceController({
      onCardSelected: (card) => {
        selectedCard = card;
      },
    });

    await controller.openMemoriesTimeline();

    const avatarInitial = controller.getMiniRobotAvatar();
    assert.equal(avatarInitial.expression, "curious");
    assert.deepEqual(avatarInitial.gazeVector, { x: 0.1, y: 0.1 });
    assert.equal(avatarInitial.gazeTargetCardId, null);

    const testClaim = createMemoryClaim({
      claim_id: "claim_sunglasses_01",
      predicate: "object_last_seen",
      object: { target: "太阳镜", location: "玄关柜台" },
      status: "observed",
      source_kind: "camera_frame",
      evidence_ids: ["ev_img_101"],
      derivation_roots: ["root_cam_01"],
    });

    const card = controller.formatClaimCard(testClaim);
    controller.selectMemoryCard(card);

    assert.equal(controller.getSelectedClaimId(), "claim_sunglasses_01");
    assert.equal(selectedCard?.claimId, "claim_sunglasses_01");

    // Mini-robot gaze turns down-right toward the tapped photo card
    const avatarAfterSelect = controller.getMiniRobotAvatar();
    assert.deepEqual(avatarAfterSelect.gazeVector, { x: 0.65, y: 0.35 });
    assert.equal(avatarAfterSelect.gazeTargetCardId, "claim_sunglasses_01");

    // Closing space restores neutral avatar
    await controller.closeMemoriesTimeline();
    const avatarClosed = controller.getMiniRobotAvatar();
    assert.deepEqual(avatarClosed.gazeVector, { x: 0, y: 0 });
    assert.equal(avatarClosed.expression, "neutral");
    assert.equal(avatarClosed.gazeTargetCardId, null);
  });

  it("formats 4-question life fragment cards with epistemic trust labels and privacy expiration badges", () => {
    const controller = new MemoriesConformalSpaceController();

    // 1. Observed claim with retained raw evidence
    const observedClaim = createMemoryClaim({
      claim_id: "claim_keys_01",
      predicate: "object_last_seen",
      object: { target: "钥匙", location: "电视柜右侧" },
      status: "observed",
      source_kind: "camera_frame",
      evidence_ids: ["ev_keys_cam_1"],
      derivation_roots: ["root_cam_1"],
      observed_at: "2026-06-24T19:42:00.000Z",
    });

    const card1 = controller.formatClaimCard(observedClaim);
    assert.equal(card1.claimId, "claim_keys_01");
    assert.equal(card1.status, "observed");
    assert.equal(card1.statusLabel, "观察记录");
    assert.equal(card1.statusBadgeColor, LOOI_PALETTE.presenceCyan);
    assert.equal(card1.trustLabel, "由摄像头抓拍观测");
    assert.equal(card1.howText, "摄像头抓拍分析");
    assert.equal(card1.whereText, "电视柜右侧");
    assert.equal(card1.heroImageUri, "evidence://ev_keys_cam_1");
    assert.equal(card1.expiredBadgeText, undefined);

    // 2. Confirmed claim from user dialogue
    const confirmedClaim = createMemoryClaim({
      claim_id: "claim_passport_02",
      predicate: "item_stored",
      object: { target: "护照", location: "主卧保险箱" },
      status: "confirmed",
      source_kind: "authenticated_user_statement",
      evidence_ids: ["ev_audio_dialog_1"],
      derivation_roots: ["root_dialog_1"],
    });

    const card2 = controller.formatClaimCard(confirmedClaim);
    assert.equal(card2.status, "confirmed");
    assert.equal(card2.statusLabel, "已确认事实");
    assert.equal(card2.statusBadgeColor, LOOI_PALETTE.confirmGreen);
    assert.equal(card2.trustLabel, "主人已确认准确无误");
    assert.equal(card2.howText, "主人对话记录");
    assert.equal(card2.whereText, "主卧保险箱");

    // 3. Inferred claim whose raw evidence expired per privacy retention policy
    const expiredClaim: MemoryClaim = {
      ...createMemoryClaim({
        claim_id: "claim_cup_03",
        predicate: "object_last_seen",
        object: { target: "保温杯", location: "书房书架" },
        status: "inferred",
        source_kind: "camera_frame",
        evidence_ids: [],
        derivation_roots: ["root_cam_old"],
      }),
      source_availability: "source_expired",
    };

    const card3 = controller.formatClaimCard(expiredClaim);
    assert.equal(card3.status, "inferred");
    assert.equal(card3.statusLabel, "推测 · 待确认");
    assert.equal(card3.statusBadgeColor, LOOI_PALETTE.amberWarning);
    assert.equal(card3.trustLabel, "依据近期规律推测");
    assert.equal(card3.heroImageUri, undefined);
    assert.equal(
      card3.expiredBadgeText,
      "原始证据已按隐私策略安全删除（仅保留事实摘要）"
    );
  });

  it("handles user correction, removal, and forget action triggers", () => {
    const actionsTriggered: Array<{
      action: string;
      claimId: string;
      payload?: unknown;
    }> = [];

    const controller = new MemoriesConformalSpaceController({
      onClaimActionTriggered: (action, claimId, payload) => {
        actionsTriggered.push({ action, claimId, payload });
      },
    });

    // 1. "不是这里" -> location correction
    controller.triggerLocationCorrection("claim_101", "茶几");
    assert.deepEqual(actionsTriggered[0], {
      action: "location_correction",
      claimId: "claim_101",
      payload: { newLocation: "茶几" },
    });

    // 2. "已经拿走了" -> item removed
    controller.triggerItemRemoved("claim_101");
    assert.deepEqual(actionsTriggered[1], {
      action: "item_removed",
      claimId: "claim_101",
      payload: undefined,
    });

    // 3. "忘掉这条" -> forget memory
    controller.triggerForgetMemory("claim_101");
    assert.deepEqual(actionsTriggered[2], {
      action: "forget_memory",
      claimId: "claim_101",
      payload: undefined,
    });
  });
});
