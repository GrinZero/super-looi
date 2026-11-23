import type { Vault } from "../vault.js";
import { MOSS_DEFAULT_VOICE_ID } from "../../voice-defaults.js";

export interface VoiceConfigurationSnapshot {
  hasKey: boolean;
  keyHint?: string;
  providerId: string;
  providerLabel: string;
  voiceId: string;
  configuredProviders: Record<string, boolean>;
}

/**
 * Owns cross-session voice credential persistence, model-vault API key fallback,
 * speaker ID validation, and wake preference storage.
 */
export class VoiceCredentialStore {
  private apiKeys: Record<string, string> = {};
  private selectedVoiceId = "";
  private voiceIds: Record<string, string> = {};
  private selectedProvider = "";
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
        if (config.voiceIds && typeof config.voiceIds === "object") {
          this.voiceIds = { ...config.voiceIds };
        }
        if (typeof config.voiceId === "string") {
          this.selectedVoiceId = config.voiceId.trim();
          if (this.selectedVoiceId) {
            this.voiceIds.doubao ??= this.selectedVoiceId;
          }
        }
        if (typeof config.providerId === "string") {
          this.selectedProvider = config.providerId.trim();
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

  get selectedProviderId(): string {
    return this.selectedProvider;
  }

  get voiceId(): string {
    return this.selectedVoiceId;
  }

  voiceIdFor(providerId: string): string {
    if (providerId === "doubao") {
      return this.voiceIds.doubao ?? this.selectedVoiceId;
    }
    return this.voiceIds[providerId] ?? (providerId === "moss" ? MOSS_DEFAULT_VOICE_ID : "");
  }

  usesModelApiKey(providerId: string): boolean {
    return providerId !== "doubao" && !this.apiKeys[providerId];
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
        : providerId === "moss"
          ? "MOSS-Live"
          : providerId === "openai"
            ? "OpenAI"
            : providerId;
    const key = this.resolveApiKey(providerId);
    const tail = key.length >= 4 ? key.slice(-4) : "";
    return {
      hasKey: Boolean(key),
      ...(tail ? { keyHint: `••••••••${tail}` } : {}),
      providerId,
      providerLabel,
      voiceId: this.voiceIdFor(providerId),
      configuredProviders: {
        doubao: Boolean(this.resolveApiKey("doubao")),
        moss: Boolean(this.resolveApiKey("moss")),
        openai: Boolean(this.resolveApiKey("openai")),
      },
    };
  }

  clearApiKey(providerId: string): void {
    delete this.apiKeys[providerId];
    this.save(true);
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
    this.save(true);
    return next;
  }

  setVoiceId(providerId: string, rawValue: string): void {
    if (
      providerId !== "doubao" &&
      providerId !== "moss" &&
      providerId !== "openai"
    ) {
      throw new Error("@looi:runtimeThisVoiceServiceDoesNotSupportDoubaoSpeaker");
    }
    const next = rawValue.trim();
    if (next && !/^[A-Za-z0-9_-]{1,256}$/.test(next)) {
      throw new Error("@looi:runtimeEnterAValidDoubaoSpeakerId");
    }
    if (providerId === "doubao") {
      this.selectedVoiceId = next;
    }
    if (next) {
      this.voiceIds[providerId] = next;
    } else {
      delete this.voiceIds[providerId];
    }
    this.save();
  }

  setProviderId(providerId: string): void {
    this.selectedProvider = providerId.trim();
    this.save();
  }

  setWakeEnabled(enabled: boolean): void {
    this.wake = enabled;
    this.save();
  }

  private save(requireVault = false): void {
    try {
      this.vault.set(
        "voice",
        JSON.stringify({
          ...(this.apiKeys.doubao ? { apiKey: this.apiKeys.doubao } : {}),
          apiKeys: this.apiKeys,
          wakeEnabled: this.wake,
          ...(this.selectedVoiceId ? { voiceId: this.selectedVoiceId } : {}),
          ...(Object.keys(this.voiceIds).length > 0 ? { voiceIds: this.voiceIds } : {}),
          ...(this.selectedProvider ? { providerId: this.selectedProvider } : {}),
        }),
      );
    } catch (error) {
      if (requireVault || Object.keys(this.apiKeys).length > 0) {
        throw error;
      }
    }
  }
}
