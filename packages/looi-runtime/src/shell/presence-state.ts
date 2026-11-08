import type {
  PrivacyEpoch,
  UserActionRef,
  BodySupervisorState,
} from "@super-looi/contracts";
import {
  FACE_EXPRESSION_IDS,
  getFaceExpressionBehavior,
  isFaceExpression,
  type FaceExpression,
  type FaceExpressionBehavior,
} from "./face-expressions.js";

export {
  FACE_EXPRESSION_IDS,
  getFaceExpressionBehavior,
  isFaceExpression,
  type FaceExpression,
  type FaceExpressionBehavior,
};

export type CaptureMode = "off" | "foreground_explicit" | "docked_context";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export type InnerSpaceDestination =
  | "none"
  | "memories"
  | "tasks_and_rules"
  | "home"
  | "cabin";

export interface PresenceSnapshot {
  faceExpression: FaceExpression;
  captureMode: CaptureMode;
  bodyState: BodySupervisorState;
  connectionState: ConnectionState;
  innerSpace: InnerSpaceDestination;
  isDocked: boolean;
  privacyEpoch: PrivacyEpoch;
}

export interface PresenceStateEvents {
  onStateChange?: (snapshot: PresenceSnapshot) => void;
  onPrivacyPaused?: (epoch: PrivacyEpoch) => void;
  onNavigationBlocked?: (reason: string) => void;
}

export class PresenceStateManager {
  private faceExpression: FaceExpression = "neutral";
  private captureMode: CaptureMode = "docked_context";
  private bodyState: BodySupervisorState = "disconnected";
  private connectionState: ConnectionState = "disconnected";
  private innerSpace: InnerSpaceDestination = "none";
  private isDocked = false;

  private privacyEpoch: PrivacyEpoch = {
    scope_id: "scope_household_default",
    household_id: "household_default",
    capture_epoch: 1,
    deletion_generation: 0,
    capture_mode: "docked_context",
    camera: "on",
    microphone: "on",
    background_processing: true,
    retention_policy_id: "retention_default",
    changed_at: new Date().toISOString(),
    changed_by_principal_id: "user_owner",
    local_buffer_state: "not_applicable",
  };

  constructor(private readonly events: PresenceStateEvents = {}) {}

  public getSnapshot(): PresenceSnapshot {
    return {
      faceExpression: this.faceExpression,
      captureMode: this.captureMode,
      bodyState: this.bodyState,
      connectionState: this.connectionState,
      innerSpace: this.innerSpace,
      isDocked: this.isDocked,
      privacyEpoch: { ...this.privacyEpoch },
    };
  }

  public setFaceExpression(expression: FaceExpression): void {
    if (this.faceExpression !== expression) {
      this.faceExpression = expression;
      this.emitChange();
    }
  }

  public setConnectionState(state: ConnectionState): void {
    if (this.connectionState !== state) {
      this.connectionState = state;
      this.emitChange();
    }
  }

  public setBodyState(state: BodySupervisorState): void {
    if (this.bodyState !== state) {
      this.bodyState = state;
      this.emitChange();
    }
  }

  /**
   * Handle physical docking state transition.
   * When undocked, immediately disarms body movement to connected_unarmed.
   */
  public handleDockChange(docked: boolean): void {
    this.isDocked = docked;
    if (!docked) {
      if (this.bodyState !== "disconnected" && this.bodyState !== "fault") {
        this.bodyState = "connected_unarmed";
      }
    } else {
      if (this.bodyState === "connected_unarmed") {
        this.bodyState = "ready";
      }
    }
    this.emitChange();
  }

  /**
   * User-triggered Privacy Pause.
   * Increments capture_epoch, turns off sensors, and sets local_buffer_state to 'cleared'.
   */
  public pausePrivacy(byPrincipalId = "user_owner"): PrivacyEpoch {
    const newEpoch = this.privacyEpoch.capture_epoch + 1;
    const now = new Date().toISOString();

    this.captureMode = "off";
    this.privacyEpoch = {
      ...this.privacyEpoch,
      capture_epoch: newEpoch,
      capture_mode: "off",
      camera: "off",
      microphone: "off",
      background_processing: false,
      changed_at: now,
      changed_by_principal_id: byPrincipalId,
      local_buffer_state: "cleared",
    };

    this.setFaceExpression("sleeping");
    this.events.onPrivacyPaused?.(this.privacyEpoch);
    this.emitChange();
    return { ...this.privacyEpoch };
  }

  /**
   * User-triggered Privacy Resume.
   */
  public resumePrivacy(
    mode: CaptureMode = "docked_context",
    byPrincipalId = "user_owner",
  ): PrivacyEpoch {
    if (mode === "off") return this.pausePrivacy(byPrincipalId);
    const now = new Date().toISOString();
    this.captureMode = mode;
    this.privacyEpoch = {
      ...this.privacyEpoch,
      capture_mode: mode,
      camera: "on",
      microphone: "on",
      background_processing: true,
      changed_at: now,
      changed_by_principal_id: byPrincipalId,
      local_buffer_state: "not_applicable",
    };

    this.setFaceExpression("neutral");
    this.emitChange();
    return { ...this.privacyEpoch };
  }

  /** Stop camera capture without enabling or interrupting the current mic mode. */
  public pauseCamera(byPrincipalId = "user_owner"): PrivacyEpoch {
    this.privacyEpoch = {
      ...this.privacyEpoch,
      capture_epoch: this.privacyEpoch.capture_epoch + 1,
      camera: "off",
      changed_at: new Date().toISOString(),
      changed_by_principal_id: byPrincipalId,
      local_buffer_state: "cleared",
    };
    if (this.bodyState === "observing") this.bodyState = "connected_unarmed";
    this.emitChange();
    return { ...this.privacyEpoch };
  }

  /**
   * UI Navigation Guard:
   * Only trusted, explicit user actions can navigate into inner space pages.
   * Background task completions, model output, or autonomous events CANNOT hijack the foreground screen.
   */
  public navigateInnerSpace(
    destination: InnerSpaceDestination,
    originatingUserAction?: UserActionRef,
  ): boolean {
    if (destination === "none") {
      this.innerSpace = "none";
      this.emitChange();
      return true;
    }

    if (!originatingUserAction) {
      const reason =
        "Navigation rejected: missing explicit UserActionRef (background hijacking blocked).";
      this.events.onNavigationBlocked?.(reason);
      return false;
    }

    const validKinds: UserActionRef["kind"][] = [
      "tap",
      "gesture",
      "voice_command",
    ];
    if (!validKinds.includes(originatingUserAction.kind)) {
      const reason = `Navigation rejected: user action kind '${originatingUserAction.kind}' is not authorized.`;
      this.events.onNavigationBlocked?.(reason);
      return false;
    }

    this.innerSpace = destination;
    this.emitChange();
    return true;
  }

  private emitChange(): void {
    this.events.onStateChange?.(this.getSnapshot());
  }
}
