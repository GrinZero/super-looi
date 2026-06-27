import {
  onKeywordDetected,
  startKeywordListening,
  stopKeywordListening,
} from "expo-sherpa-kws";

const DEFAULT_KWS_MODEL_DIR = "sherpa-onnx/kws";
const DEFAULT_KEYWORDS_FILE = "sherpa-onnx/kws/keywords.txt";

function getKwsModelDir(): string {
  return process.env.EXPO_PUBLIC_SHERPA_KWS_MODEL_DIR || DEFAULT_KWS_MODEL_DIR;
}

function getKeywordsFile(): string {
  return process.env.EXPO_PUBLIC_SHERPA_KEYWORDS_FILE || DEFAULT_KEYWORDS_FILE;
}

export type WakewordState = "idle" | "listening" | "detected" | "unavailable";

type WakewordCallback = () => void;

export class WakewordService {
  private listeners: WakewordCallback[] = [];
  private nativeUnsubscribe: (() => void) | null = null;
  private _state: WakewordState = "idle";

  async start(): Promise<void> {
    if (this.nativeUnsubscribe) return;

    try {
      await startKeywordListening(getKwsModelDir(), getKeywordsFile());
      this.nativeUnsubscribe = onKeywordDetected(() => this.notifyDetected());
      this._state = "listening";
    } catch (error) {
      this._state = "unavailable";
      console.warn("[Wakeword] Native KWS unavailable:", error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.nativeUnsubscribe) {
      this.nativeUnsubscribe();
      this.nativeUnsubscribe = null;
    }

    await stopKeywordListening();
    this._state = "idle";
  }

  trigger(): void {
    this.notifyDetected();
  }

  onWakeword(callback: WakewordCallback): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((listener) => listener !== callback);
    };
  }

  private notifyDetected(): void {
    this._state = "detected";
    for (const listener of this.listeners) {
      listener();
    }
    this._state = this.nativeUnsubscribe ? "listening" : "idle";
  }

  get state(): WakewordState {
    return this._state;
  }
}

export const wakewordService = new WakewordService();
