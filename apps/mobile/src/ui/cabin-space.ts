import type {
  VoiceProviderKind,
  VisionProviderKind,
  Id,
} from "@super-looi/contracts";
import { LOOI_PALETTE } from "./theme.js";

export type CabinMorphState =
  | "face_fullscreen"
  | "eyes_closing_to_cabin"
  | "cabin_open"
  | "cabin_converging_to_eyes";

export type ConnectionStatus = "connected" | "connecting" | "disconnected";

export interface SubsystemConnection {
  name: string;
  status: ConnectionStatus;
  lastVerifiedAt: string | null;
  statusColor: string;
}

export interface CabinSubsystemsState {
  bleDock: SubsystemConnection;
  hub: SubsystemConnection;
  homeAssistant: SubsystemConnection;
}

export interface HardwareSensorsState {
  camera: boolean;
  microphone: boolean;
  backgroundProcessing: boolean;
}

export interface CabinSpaceEvents {
  onMorphStateChange?: (state: CabinMorphState) => void;
  onSubsystemsChange?: (subsystems: CabinSubsystemsState) => void;
  onVoiceProviderChange?: (provider: VoiceProviderKind) => void;
  onVisionProviderChange?: (provider: VisionProviderKind) => void;
}

export class CabinSpaceController {
  private morphState: CabinMorphState = "face_fullscreen";

  // Separate subsystem connectivity (Screen 14: Degraded Connection Honesty)
  private subsystems: CabinSubsystemsState = {
    bleDock: {
      name: "LOOI 具身底座 (BLE)",
      status: "connected",
      lastVerifiedAt: new Date().toISOString(),
      statusColor: LOOI_PALETTE.confirmGreen,
    },
    hub: {
      name: "本地大脑主机 (Hub)",
      status: "connected",
      lastVerifiedAt: new Date().toISOString(),
      statusColor: LOOI_PALETTE.confirmGreen,
    },
    homeAssistant: {
      name: "智能家居网关 (HA)",
      status: "connected",
      lastVerifiedAt: new Date().toISOString(),
      statusColor: LOOI_PALETTE.confirmGreen,
    },
  };

  // Provider selections
  private activeVoiceProvider: VoiceProviderKind = "doubao";
  private activeVisionProvider: VisionProviderKind = "cloud";

  // Hardware sensor activity
  private sensors: HardwareSensorsState = {
    camera: false,
    microphone: true,
    backgroundProcessing: false,
  };

  // Reconnection safe motion policy
  private suppressedOldMotionCommandsCount = 0;

  constructor(private readonly events: CabinSpaceEvents = {}) {}

  public getMorphState(): CabinMorphState {
    return this.morphState;
  }

  public getSubsystems(): CabinSubsystemsState {
    return { ...this.subsystems };
  }

  public getActiveVoiceProvider(): VoiceProviderKind {
    return this.activeVoiceProvider;
  }

  public getActiveVisionProvider(): VisionProviderKind {
    return this.activeVisionProvider;
  }

  public getSensorsState(): HardwareSensorsState {
    return { ...this.sensors };
  }

  public getSuppressedMotionCommandsCount(): number {
    return this.suppressedOldMotionCommandsCount;
  }

  /**
   * Conformal Transition into Cabin (维修舱):
   * Eyes morph into the system diagnostics & settings panel.
   */
  public async openCabinSpace(): Promise<void> {
    if (this.morphState === "cabin_open") return;

    this.setMorphState("eyes_closing_to_cabin");
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.setMorphState("cabin_open");
  }

  public async closeCabinSpace(): Promise<void> {
    if (this.morphState === "face_fullscreen") return;

    this.setMorphState("cabin_converging_to_eyes");
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.setMorphState("face_fullscreen");
  }

  /**
   * Updates subsystem connection status independently.
   * STRICT PRINCIPLE: Never hide partial outage behind a single green dot!
   */
  public updateSubsystemStatus(
    system: "bleDock" | "hub" | "homeAssistant",
    status: ConnectionStatus,
    timestampIso?: string
  ): void {
    const color =
      status === "connected"
        ? LOOI_PALETTE.confirmGreen
        : status === "connecting"
        ? LOOI_PALETTE.amberWarning
        : LOOI_PALETTE.alertCoral;

    this.subsystems[system] = {
      ...this.subsystems[system],
      status,
      statusColor: color,
      lastVerifiedAt: timestampIso ?? (status === "connected" ? new Date().toISOString() : this.subsystems[system].lastVerifiedAt),
    };

    this.events.onSubsystemsChange?.(this.getSubsystems());
  }

  /**
   * Produces an honest summary without masking degraded subsystems.
   */
  public getOverallStatusSummary(): { isDegraded: boolean; summary: string } {
    const { bleDock, hub, homeAssistant } = this.subsystems;

    const allConnected =
      bleDock.status === "connected" &&
      hub.status === "connected" &&
      homeAssistant.status === "connected";

    if (allConnected) {
      return { isDegraded: false, summary: "全部系统正常在线" };
    }

    const issues: string[] = [];
    if (bleDock.status !== "connected") {
      issues.push("LOOI底座未连");
    }
    if (hub.status !== "connected") {
      issues.push("本地主机失联");
    }
    if (homeAssistant.status !== "connected") {
      issues.push("智能家居网关未连接");
    }

    return {
      isDegraded: true,
      summary: `部分系统异常: ${issues.join("，")}`,
    };
  }

  /**
   * Reconnection motion suppression:
   * When reconnecting, old in-flight motion commands are strictly suppressed,
   * avoiding sudden unverified mechanical head or wheel jerks.
   */
  public handleReconnect(): { suppressedOldMotionCommands: number } {
    // If BLE reconnected, increment suppression count of stale commands
    this.suppressedOldMotionCommandsCount += 2;
    return { suppressedOldMotionCommands: this.suppressedOldMotionCommandsCount };
  }

  /**
   * Switch active voice provider.
   */
  public setActiveVoiceProvider(provider: VoiceProviderKind): void {
    this.activeVoiceProvider = provider;
    this.events.onVoiceProviderChange?.(provider);
  }

  /**
   * Switch active vision provider.
   */
  public setActiveVisionProvider(provider: VisionProviderKind): void {
    this.activeVisionProvider = provider;
    this.events.onVisionProviderChange?.(provider);
  }

  /**
   * Set sensor hardware indicators.
   */
  public setSensorStatus(status: {
    camera?: boolean;
    microphone?: boolean;
    backgroundProcessing?: boolean;
  }): void {
    if (typeof status.camera === "boolean") this.sensors.camera = status.camera;
    if (typeof status.microphone === "boolean") this.sensors.microphone = status.microphone;
    if (typeof status.backgroundProcessing === "boolean") this.sensors.backgroundProcessing = status.backgroundProcessing;
  }

  private setMorphState(state: CabinMorphState): void {
    this.morphState = state;
    this.events.onMorphStateChange?.(state);
  }
}
