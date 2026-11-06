import type {
  VoiceProviderKind,
  VoiceUpMessage,
  VoiceDownMessage,
  SelfEventWindow,
} from "@super-looi/contracts";
import { createSelfEventWindow } from "@super-looi/contracts";
import { DoubaoVoiceProvider } from "./doubao-engine.js";
import { ModularVoiceProvider } from "./modular-engine.js";

export * from "./doubao-engine.js";
export * from "./modular-engine.js";

export interface VoiceSessionOptions {
  sessionId: string;
  onDownMessage: (msg: VoiceDownMessage) => void;
  onError: (error: Error) => void;
}

export interface VoiceProvider {
  readonly kind: VoiceProviderKind;
  readonly name: string;
  createSession(options: VoiceSessionOptions): Promise<VoiceSessionHandle>;
}

export interface VoiceSessionHandle {
  sessionId: string;
  sendUpMessage(msg: VoiceUpMessage): Promise<void>;
  close(): Promise<void>;
}

/**
 * Tracks outbound assistant speech playout windows to prevent microphone loopback
 * and acoustic self-excitation.
 */
export class LoopbackSuppressionManager {
  private activeUntilMs = 0;

  public recordOutboundAudio(chunkBytes: number, sampleRate = 24000): SelfEventWindow {
    // 2 bytes per 16-bit mono PCM sample
    const durationMs = Math.ceil((chunkBytes / (sampleRate * 2)) * 1000) + 150;
    const now = Date.now();
    this.activeUntilMs = Math.max(this.activeUntilMs, now + durationMs);

    return createSelfEventWindow("tts_playback", durationMs, ["microphone"]);
  }

  public isSuppressed(nowMs: number = Date.now()): boolean {
    return nowMs < this.activeUntilMs;
  }

  public clear(): void {
    this.activeUntilMs = 0;
  }
}

export class VoiceProviderRegistry {
  private readonly providers = new Map<VoiceProviderKind, VoiceProvider>();
  private activeKind: VoiceProviderKind = "doubao";

  constructor(options?: {
    doubaoProvider?: DoubaoVoiceProvider;
    modularProvider?: ModularVoiceProvider;
  }) {
    this.register(options?.doubaoProvider ?? new DoubaoVoiceProvider());
    this.register(options?.modularProvider ?? new ModularVoiceProvider());
  }

  register(provider: VoiceProvider): void {
    this.providers.set(provider.kind, provider);
  }

  get(kind: VoiceProviderKind): VoiceProvider | undefined {
    return this.providers.get(kind);
  }

  getActive(): VoiceProvider {
    const provider = this.providers.get(this.activeKind);
    if (!provider) {
      throw new Error(`Active voice provider '${this.activeKind}' is not registered.`);
    }
    return provider;
  }

  setActive(kind: VoiceProviderKind): void {
    if (!this.providers.has(kind)) {
      throw new Error(`Cannot set active voice provider to '${kind}': not registered.`);
    }
    this.activeKind = kind;
  }

  getActiveKind(): VoiceProviderKind {
    return this.activeKind;
  }

  list(): Array<{ kind: VoiceProviderKind; name: string; isActive: boolean }> {
    return Array.from(this.providers.values()).map((p) => ({
      kind: p.kind,
      name: p.name,
      isActive: p.kind === this.activeKind,
    }));
  }
}
