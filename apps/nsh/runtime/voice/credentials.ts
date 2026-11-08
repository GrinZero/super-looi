import type { Vault } from "../application.js";

export interface VoiceConfigurationSnapshot {
  hasKey: boolean;
  providerId: string;
  providerLabel: string;
  voiceId: string;
}

/**
 * Owns cross-session voice credential persistence, model-vault API key fallback,
 * speaker ID validation, and wake preference storage.
 */
export class VoiceCredentialStore {
  private apiKeys: Record<string, string> = {};
  private selectedVoiceId = "";
  private wake = true;
  readonly corruptOnLoad: boolean;

  constructor(private readonly vault: Vault) {
    let corrupt = false;
    try {
      const saved = vault.get("voice");
      if (saved) {
        const config = JSON.parse(saved);
        if (config.apiKeys && typeof config.apiKeys === "object") {
          this.apiKeys = { ...config.apiKeys };
        }
        if (typeof config.apiKey === "string" && config.apiKey.trim()) {
          this.apiKeys.doubao ??= config.apiKey.trim();
        }
        if (typeof config.voiceId === "string") {
          this.selectedVoiceId = config.voiceId.trim();
        }
        this.wake = config.wakeEnabled !== false;
      }
    } catch {
      corrupt = true;
    }
    this.corruptOnLoad = corrupt;
  }

  get wakeEnabled(): boolean {
    return this.wake;
  }

  get voiceId(): string {
    return this.selectedVoiceId;
  }

  resolveApiKey(providerId: string): string {
    const own = this.apiKeys[providerId];
    if (own) return own;
    if (providerId === "doubao") return "";
    try {
      const model = JSON.parse(this.vault.get("model") || "{}");
      const credential = model.credentials?.[providerId];
      return credential?.type === "api_key" && typeof credential.key === "string"
        ? credential.key
        : "";
    } catch {
      return "";
    }
  }

  configuration(providerId: string): VoiceConfigurationSnapshot {
    const providerLabel =
      providerId === "doubao"
        ? "@looi:runtimeDoubao"
        : providerId === "openai"
          ? "OpenAI"
          : providerId;
    return {
      hasKey: Boolean(this.resolveApiKey(providerId)),
      providerId,
      providerLabel,
      voiceId: providerId === "doubao" ? this.selectedVoiceId : "",
    };
  }

  setApiKey(providerId: string, rawValue: unknown): string {
    if (
      typeof rawValue !== "string" ||
      !rawValue.trim() ||
      rawValue.length > 8192 ||
      /[\r\n]/.test(rawValue)
    ) {
      throw new Error("@looi:runtimeEnterAValidVoiceApiKey");
    }
    const next = rawValue.trim();
    this.apiKeys[providerId] = next;
    this.save();
    return next;
  }

  setVoiceId(providerId: string, rawValue: string): void {
    if (providerId !== "doubao") {
      throw new Error("@looi:runtimeThisVoiceServiceDoesNotSupportDoubaoSpeaker");
    }
    const next = rawValue.trim();
    if (next && !/^[A-Za-z0-9_-]{1,256}$/.test(next)) {
      throw new Error("@looi:runtimeEnterAValidDoubaoSpeakerId");
    }
    this.selectedVoiceId = next;
    this.save();
  }

  setWakeEnabled(enabled: boolean): void {
    this.wake = enabled;
    this.save();
  }

  private save(): void {
    this.vault.set(
      "voice",
      JSON.stringify({
        ...(this.apiKeys.doubao ? { apiKey: this.apiKeys.doubao } : {}),
        apiKeys: this.apiKeys,
        wakeEnabled: this.wake,
        ...(this.selectedVoiceId ? { voiceId: this.selectedVoiceId } : {}),
      }),
    );
  }
}
