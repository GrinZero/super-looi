import type {
  ObservationRequest,
  BodyPrimitive,
  MotionObservation,
  MemoryClaim,
  Id,
} from "@super-looi/contracts";
import { createMemoryClaim } from "@super-looi/contracts";
import type { BodySupervisor } from "@super-looi/looi-driver";
import type { VisionProvider } from "./provider.js";

export interface ActiveLookResult {
  success: boolean;
  found: boolean;
  attemptsUsed: number;
  totalMotionMs: number;
  detectedClaim?: MemoryClaim;
  honestFallbackMessage?: string;
  motionObservations: MotionObservation[];
}

export class BoundedActiveLookCoordinator {
  constructor(
    private readonly supervisor: Pick<BodySupervisor, "getIsDocked" | "executePulse">,
    private readonly visionProvider: VisionProvider,
  ) {}

  public async executeActiveLook(
    request: ObservationRequest,
    targetLabel = "keys",
  ): Promise<ActiveLookResult> {
    const observations: MotionObservation[] = [];
    let attemptsUsed = 0;
    let totalMotionMs = 0;

    // Safety check: must be docked
    if (!this.supervisor.getIsDocked()) {
      return {
        success: false,
        found: false,
        attemptsUsed: 0,
        totalMotionMs: 0,
        honestFallbackMessage: "机器人未在底座上，无法执行主动转向观察。",
        motionObservations: [],
      };
    }

    const maxAttempts = Math.min(request.budget.max_attempts, 2); // Hard bound <= 2 attempts
    const maxTotalMotionMs = Math.min(request.budget.max_total_motion_ms, 3000);
    const primitivesToTry: BodyPrimitive[] =
      request.allowed_primitives.length > 0
        ? request.allowed_primitives
        : ["head_up", "turn_left"];

    for (const primitive of primitivesToTry) {
      if (attemptsUsed >= maxAttempts || totalMotionMs >= maxTotalMotionMs) {
        break;
      }

      attemptsUsed++;
      const pulseDurationMs = Math.min(250, maxTotalMotionMs - totalMotionMs); // Bounded <= 250ms per micro-pitch/turn
      totalMotionMs += pulseDurationMs;

      try {
        // Execute calibrated bounded pulse
        const pulseStartedAt = Date.now();
        const motionObs = await this.supervisor.executePulse(
          {
            holder: `active_look_${request.observation_id}`,
            primitive,
            durationMs: pulseDurationMs,
          },
          request.settling_ms || 200,
        );
        observations.push(motionObs);

        const stopAt = Date.parse(motionObs.stop_command_at ?? "");
        const endAt = Date.parse(motionObs.verified_motion_end_at ?? "");
        const captureAt = Date.parse(motionObs.stable_capture_at ?? "");
        if (!Number.isFinite(stopAt) || !Number.isFinite(endAt) ||
            !Number.isFinite(captureAt) || endAt < stopAt || captureAt < endAt ||
            stopAt < pulseStartedAt || captureAt > Date.now() ||
            !Array.isArray(motionObs.stability_evidence_ids) ||
            !motionObs.stability_evidence_ids.length ||
            motionObs.stability_evidence_ids.some((id) => typeof id !== "string" || !id.trim())) {
          return {
            success: false, found: false, attemptsUsed, totalMotionMs,
            honestFallbackMessage: "已发送停止指令，但尚未确认底座停稳，无法确认新视角中的物体。",
            motionObservations: observations,
          };
        }

        // Analyze new viewpoint
        const visionResult = await this.visionProvider.analyze({
          request_id: `look_${request.observation_id}_${attemptsUsed}`,
          prompt: request.question,
          mode: "detect_objects",
        });

        const targetFound = visionResult.detected_objects?.find(
          (o) => o.label.toLowerCase() === targetLabel.toLowerCase(),
        );

        if (targetFound) {
          const claim = createMemoryClaim({
            claim_id: `claim_seen_${targetLabel}_${Date.now()}`,
            predicate: "object_last_seen",
            object: {
              target: targetLabel,
              location: "观察已确认位置",
              confidence: targetFound.confidence,
              viewpoint: primitive,
            },
            status: "observed",
            source_kind: "camera_frame",
            evidence_ids: motionObs.stability_evidence_ids,
            derivation_roots: [`root_look_${request.observation_id}`],
          });

          return {
            success: true,
            found: true,
            attemptsUsed,
            totalMotionMs,
            detectedClaim: claim,
            motionObservations: observations,
          };
        }
      } catch (err) {
        // If supervisor was stopped or undocked, abort immediately
        break;
      }
    }

    // Budget exhausted or target still occluded -> honest fallback
    return {
      success: true,
      found: false,
      attemptsUsed,
      totalMotionMs,
      honestFallbackMessage:
        "微调视角后这边还是被挡住了，可以帮我把它移开一下吗？",
      motionObservations: observations,
    };
  }
}
