import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BoundedActiveLookCoordinator } from "../src/vision/active-look.js";
import type { VisionProvider } from "../src/vision/provider.js";
import type { BodySupervisor } from "@super-looi/looi-driver";
import type {
  ObservationRequest,
  MotionObservation,
  VisionAnalyzeRequest,
  VisionAnalyzeResult,
} from "@super-looi/contracts";

describe("BoundedActiveLookCoordinator (Phase 2)", () => {
  it("rejects active look immediately with honest fallback if robot is not docked", async () => {
    const mockSupervisor = {
      getIsDocked: () => false,
      executePulse: async () => {
        throw new Error("Should not be called");
      },
    } as unknown as BodySupervisor;

    const mockVision: VisionProvider = {
      kind: "edge",
      name: "MockVision",
      analyze: async () => ({ request_id: "req_1", latency_ms: 10 }),
    };

    const coordinator = new BoundedActiveLookCoordinator(mockSupervisor, mockVision);

    const request: ObservationRequest = {
      observation_id: "obs_undocked_1",
      question: "我的钥匙在哪里？",
      budget: { max_attempts: 2, max_total_motion_ms: 1000 },
      allowed_primitives: ["turn_left"],
      settling_ms: 100,
    };

    const result = await coordinator.executeActiveLook(request, "keys");

    assert.equal(result.success, false);
    assert.equal(result.found, false);
    assert.equal(result.attemptsUsed, 0);
    assert.match(result.honestFallbackMessage || "", /未在底座上/);
  });

  it("strictly enforces attempt and duration budgets, finding target and generating verified MemoryClaim", async () => {
    const pulsesExecuted: Array<{ primitive: string; durationMs: number }> = [];

    const mockSupervisor = {
      getIsDocked: () => true,
      executePulse: async (leaseReq: { primitive: string; durationMs: number }) => {
        pulsesExecuted.push({
          primitive: leaseReq.primitive,
          durationMs: leaseReq.durationMs,
        });
        return {
          observation_id: "obs_motion_1",
          primitive: leaseReq.primitive,
          executed_ms: leaseReq.durationMs,
          stop_command_at: new Date().toISOString(),
          verified_motion_end_at: new Date().toISOString(),
          stable_capture_at: new Date().toISOString(),
          stability_evidence_ids: ["ev_stable_frame_1"],
        };
      },
    } as unknown as BodySupervisor;

    const mockVision: VisionProvider = {
      kind: "cloud",
      name: "MockCloudVision",
      analyze: async (req: VisionAnalyzeRequest): Promise<VisionAnalyzeResult> => {
        // First look finds nothing, second look finds the keys!
        if (req.request_id.endsWith("_1")) {
          return {
            request_id: req.request_id,
            latency_ms: 50,
            detected_objects: [{ label: "cup", confidence: 0.9 }],
          };
        }
        return {
          request_id: req.request_id,
          latency_ms: 50,
          detected_objects: [{ label: "keys", confidence: 0.94 }],
        };
      },
    };

    const coordinator = new BoundedActiveLookCoordinator(mockSupervisor, mockVision);

    const request: ObservationRequest = {
      observation_id: "obs_look_keys",
      question: "钥匙在哪里？",
      budget: { max_attempts: 5, max_total_motion_ms: 5000 }, // Requests 5 attempts, coordinator must hard cap at <= 2
      allowed_primitives: ["turn_left", "turn_right", "head_up"],
      settling_ms: 150,
    };

    const result = await coordinator.executeActiveLook(request, "keys");

    assert.equal(result.success, true);
    assert.equal(result.found, true);
    assert.equal(result.attemptsUsed, 2);
    assert.equal(pulsesExecuted.length, 2);
    // Bounded <= 250ms per pulse
    assert.ok(pulsesExecuted[0].durationMs <= 250);
    assert.ok(pulsesExecuted[1].durationMs <= 250);

    // Verify generated claim
    assert.ok(result.detectedClaim);
    assert.equal(result.detectedClaim.status, "observed");
    assert.equal(result.detectedClaim.predicate, "object_last_seen");
    const claimObj = result.detectedClaim.object as { target: string; confidence: number };
    assert.equal(claimObj.target, "keys");
    assert.equal(claimObj.confidence, 0.94);
    assert.deepEqual(result.detectedClaim.evidence_ids, ["ev_stable_frame_1"]);
  });

  it("rejects missing or inconsistent motion evidence before vision or another pulse", async () => {
    const at = (offset: number) => new Date(Date.now() + offset).toISOString();
    for (const invalid of [
      { verified_motion_end_at: null }, { stable_capture_at: null },
      { stop_command_at: null }, { stability_evidence_ids: [] },
      { stability_evidence_ids: [" "] }, { stable_capture_at: "invalid" },
      { verified_motion_end_at: at(-60000) }, { stable_capture_at: at(-60000) },
      { stable_capture_at: at(60000) },
      { stop_command_at: "2000-01-01T00:00:00.000Z",
        verified_motion_end_at: "2000-01-01T00:00:01.000Z",
        stable_capture_at: "2000-01-01T00:00:02.000Z" },
      { stability_evidence_ids: null }, { stability_evidence_ids: [42] },
    ]) {
      let pulses = 0;
      let visionCalls = 0;
      const coordinator = new BoundedActiveLookCoordinator({
        getIsDocked: () => true,
        executePulse: async () => {
          pulses++;
          const timestamp = at(0);
          return { stop_command_at: timestamp, verified_motion_end_at: timestamp,
            stable_capture_at: timestamp, stability_evidence_ids: ["fixture_frame"],
            ...invalid } as unknown as MotionObservation;
        },
      }, {
        kind: "edge", name: "NeverCalled",
        analyze: async () => { visionCalls++; throw new Error("must not analyze"); },
      });
      const result = await coordinator.executeActiveLook({
        observation_id: "unverified", question: "keys?",
        budget: { max_attempts: 2, max_total_motion_ms: 1000 },
        allowed_primitives: ["head_up", "turn_left"], settling_ms: 1,
      } as ObservationRequest);
      assert.equal(result.success, false);
      assert.equal(result.found, false);
      assert.equal(result.detectedClaim, undefined);
      assert.equal(pulses, 1);
      assert.equal(visionCalls, 0);
      assert.match(result.honestFallbackMessage!, /尚未确认底座停稳/);
    }
  });

  it("exhausts budget honestly when target is occluded, returning epistemic fallback phrase", async () => {
    let pulsesCount = 0;
    const mockSupervisor = {
      getIsDocked: () => true,
      executePulse: async () => {
        pulsesCount++;
        return {
          observation_id: `obs_${pulsesCount}`,
          primitive: "head_up",
          executed_ms: 200,
          stop_command_at: new Date().toISOString(),
          verified_motion_end_at: new Date().toISOString(),
          stable_capture_at: new Date().toISOString(),
          stability_evidence_ids: ["fixture_stable_frame"],
        };
      },
    } as unknown as BodySupervisor;

    const mockVision: VisionProvider = {
      kind: "edge",
      name: "MockEdgeVision",
      analyze: async (req: VisionAnalyzeRequest) => ({
        request_id: req.request_id,
        latency_ms: 40,
        detected_objects: [{ label: "monitor", confidence: 0.99 }], // Target not found
      }),
    };

    const coordinator = new BoundedActiveLookCoordinator(mockSupervisor, mockVision);

    const request: ObservationRequest = {
      observation_id: "obs_glasses",
      question: "我的眼镜在哪里？",
      budget: { max_attempts: 2, max_total_motion_ms: 1000 },
      allowed_primitives: ["head_up", "turn_left"],
      settling_ms: 100,
    };

    const result = await coordinator.executeActiveLook(request, "glasses");

    assert.equal(result.success, true);
    assert.equal(result.found, false);
    assert.equal(result.attemptsUsed, 2);
    assert.equal(pulsesCount, 2);
    assert.equal(
      result.honestFallbackMessage,
      "微调视角后这边还是被挡住了，可以帮我把它移开一下吗？"
    );
  });
});
