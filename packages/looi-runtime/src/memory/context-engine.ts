import type {
  SourceKind,
  EventEnvelope,
  Episode,
  SelfEventWindow,
  Id,
} from "@super-looi/contracts";

export type TriggerKind =
  | "explicit_remember"
  | "vad_utterance"
  | "visual_change"
  | "home_anomaly"
  | "active_look_complete";

export interface ContextTrigger {
  trigger_id: Id;
  kind: TriggerKind;
  source_id: Id;
  captured_at_ms: number;
  priority: "high" | "normal" | "low";
  payload?: Record<string, unknown>;
}

/**
 * ContextTriggerBus: Merges overlapping triggers, prioritizes explicit user requests,
 * and rate-limits background automated triggers.
 */
export class ContextTriggerBus {
  private lastBackgroundTriggerMs = 0;
  private readonly minBackgroundIntervalMs: number;
  private triggerQueue: ContextTrigger[] = [];

  constructor(options: { minBackgroundIntervalMs?: number } = {}) {
    this.minBackgroundIntervalMs = options.minBackgroundIntervalMs ?? 3000;
  }

  public emitTrigger(trigger: ContextTrigger): {
    accepted: boolean;
    reason?: string;
  } {
    const isExplicit =
      trigger.kind === "explicit_remember" || trigger.priority === "high";

    if (!isExplicit) {
      const now = trigger.captured_at_ms;
      if (now - this.lastBackgroundTriggerMs < this.minBackgroundIntervalMs) {
        return {
          accepted: false,
          reason: "Rate limited: background trigger within suppression window",
        };
      }
      this.lastBackgroundTriggerMs = now;
    }

    // Merge window: if a similar trigger exists within 400ms, keep the higher priority
    const windowMs = 400;
    const existingIndex = this.triggerQueue.findIndex(
      (t) =>
        t.kind === trigger.kind &&
        Math.abs(t.captured_at_ms - trigger.captured_at_ms) < windowMs,
    );

    if (existingIndex >= 0) {
      if (isExplicit) {
        this.triggerQueue[existingIndex] = trigger;
      }
      return { accepted: true, reason: "Merged with in-flight trigger window" };
    }

    this.triggerQueue.push(trigger);
    return { accepted: true };
  }

  public getPendingTriggers(): ContextTrigger[] {
    const triggers = [...this.triggerQueue];
    this.triggerQueue = [];
    return triggers.sort((a, b) => (a.priority === "high" ? -1 : 1));
  }
}

/**
 * NoveltyGate: Filters out redundant static video frames, preserving small ROI changes,
 * view_id changes, and explicit user commands.
 */
export class NoveltyGate {
  private lastViewId = "";
  private lastFingerprint = "";

  public shouldCapture(frame: {
    viewId: string;
    fingerprint: string;
    isExplicitUserRequest?: boolean;
    roiChanged?: boolean;
  }): boolean {
    if (frame.isExplicitUserRequest) {
      this.lastViewId = frame.viewId;
      this.lastFingerprint = frame.fingerprint;
      return true;
    }

    // New perspective after body rotation or head tilt
    if (frame.viewId !== this.lastViewId) {
      this.lastViewId = frame.viewId;
      this.lastFingerprint = frame.fingerprint;
      return true;
    }

    // Significant ROI change or visual delta
    if (frame.roiChanged || frame.fingerprint !== this.lastFingerprint) {
      this.lastFingerprint = frame.fingerprint;
      return true;
    }

    // Redundant static frame
    return false;
  }
}

/**
 * EvidenceAssembler: Combines vision frames and audio segments into coherent Episodes
 * with distinct derivation roots and explicit sensor gap markers.
 */
export class EvidenceAssembler {
  public assembleEpisode(params: {
    episodeId: Id;
    triggerSourceKind: SourceKind;
    cameraFrameEvent?: EventEnvelope;
    audioSegmentEvent?: EventEnvelope;
    activeSelfWindows?: SelfEventWindow[];
  }): Episode & { gapMarkers: string[] } {
    const now = new Date().toISOString();
    const evidenceRoots: Id[] = [];
    const gapMarkers: string[] = [];

    // Camera and audio have distinct derivation roots per protocol contracts
    if (params.cameraFrameEvent) {
      const rootId =
        params.cameraFrameEvent.derivation_roots[0] ||
        `root_cam_${params.cameraFrameEvent.event_id}`;
      evidenceRoots.push(rootId);
    }

    if (params.audioSegmentEvent) {
      const rootId =
        params.audioSegmentEvent.derivation_roots[0] ||
        `root_audio_${params.audioSegmentEvent.event_id}`;
      evidenceRoots.push(rootId);
    }

    // Record sensor gap markers if suppressed by self events
    if (params.activeSelfWindows && params.activeSelfWindows.length > 0) {
      for (const win of params.activeSelfWindows) {
        gapMarkers.push(
          `sensor_gap:${win.cause}:${win.suppress_sensors.join("+")}`,
        );
      }
    }

    return {
      episode_id: params.episodeId,
      started_at: now,
      ended_at: now,
      trigger_source_kind: params.triggerSourceKind,
      evidence_root_ids: evidenceRoots,
      summary: `Episode with ${evidenceRoots.length} independent roots and ${gapMarkers.length} sensor gaps`,
      gapMarkers,
    };
  }
}
