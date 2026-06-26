/**
 * Wakeword detection
 * Phase 1 degraded: Button-triggered instead of always-on KWS
 * Full sherpa-onnx KWS integration planned for Phase 1.5
 *
 * This module provides the interface but uses a manual trigger for now.
 */

export type WakewordState = "idle" | "detected";

type WakewordCallback = () => void;

export class WakewordService {
  private listeners: WakewordCallback[] = [];
  private _state: WakewordState = "idle";

  /**
   * In Phase 1, we simulate wakeword with button press
   * In Phase 1.5, this will use sherpa-onnx KWS with "Hey Moge"
   */
  async start(): Promise<void> {
    this._state = "idle";
    console.log("[Wakeword] Listening for wake trigger (button mode in Phase 1)");
  }

  async stop(): Promise<void> {
    this._state = "idle";
  }

  /**
   * Manually trigger wakeword (simulates "Hey Moge" detection)
   * Called by the VoiceButton UI component
   */
  trigger(): void {
    this._state = "detected";
    for (const listener of this.listeners) {
      listener();
    }
    this._state = "idle";
  }

  /**
   * Subscribe to wakeword detection events
   */
  onWakeword(callback: WakewordCallback): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== callback);
    };
  }

  get state(): WakewordState {
    return this._state;
  }
}

export const wakewordService = new WakewordService();
