import { BasePerceiver } from "../core/perceiver";
import { createObservation } from "../core/observation";
import { visionService } from "../server-api/client";

/**
 * Camera mode: streaming (plugged in + wifi) or smart_capture (battery)
 */
export type CameraMode = "streaming" | "smart_capture";

/**
 * CameraPerceiver — handles visual capture and uploads to server
 *
 * Phase 1 implementation:
 * - smart_capture mode: manual/triggered capture
 * - Streaming mode: placeholder (Phase 1.5)
 * - Uses expo-camera for capture
 */
export class CameraPerceiver extends BasePerceiver {
  name = "camera";
  private mode: CameraMode = "smart_capture";
  private frameBuffer: string[] = []; // base64 frames
  private maxBufferSize = 10;

  async start(): Promise<void> {
    this.isActive = true;
    console.log(`[CameraPerceiver] Started in ${this.mode} mode`);
  }

  async stop(): Promise<void> {
    this.isActive = false;
    this.frameBuffer = [];
  }

  /**
   * Set camera mode based on device state
   */
  setMode(mode: CameraMode): void {
    this.mode = mode;
    console.log(`[CameraPerceiver] Switched to ${mode} mode`);
  }

  /**
   * Add a frame to the buffer (called by camera component)
   */
  addFrame(frameBase64: string): void {
    this.frameBuffer.push(frameBase64);
    if (this.frameBuffer.length > this.maxBufferSize) {
      this.frameBuffer.shift();
    }
  }

  /**
   * Capture and analyze the latest frame(s)
   * Called when voice+camera joint trigger is activated
   */
  async captureAndDescribe(voiceTranscript?: string): Promise<string | null> {
    if (this.frameBuffer.length === 0) {
      console.warn("[CameraPerceiver] No frames in buffer");
      return null;
    }

    // Take the most recent frame
    const latestFrame = this.frameBuffer[this.frameBuffer.length - 1];

    try {
      const prompt = voiceTranscript
        ? `用户说："${voiceTranscript}"。请描述画面中的场景，重点描述物品的位置。`
        : "请描述画面中的场景，包括物品的位置和环境。";

      const description = await visionService.describe(latestFrame, prompt);

      // Emit observation
      const observation = createObservation(
        description,
        voiceTranscript ? "voice+camera" : "camera",
        "placement",
        { confidence: 0.8 }
      );
      this.emit(observation);

      return description;
    } catch (error) {
      console.error("[CameraPerceiver] Vision analysis failed:", error);
      return null;
    }
  }

  /**
   * Get the latest frame as base64 (for evidence storage)
   */
  getLatestFrame(): string | null {
    if (this.frameBuffer.length === 0) return null;
    return this.frameBuffer[this.frameBuffer.length - 1];
  }

  get currentMode(): CameraMode {
    return this.mode;
  }

  get bufferSize(): number {
    return this.frameBuffer.length;
  }

  get hasFrame(): boolean {
    return this.frameBuffer.length > 0;
  }
}

export const cameraPerceiver = new CameraPerceiver();
