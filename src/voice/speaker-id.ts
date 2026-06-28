import { Asset } from "expo-asset";
import * as SecureStore from "expo-secure-store";
import { createMMKV } from "react-native-mmkv";

const OWNER_SPEAKER_NAME = "owner";
const OWNER_EMBEDDING_MMKV_KEY = "owner_speaker_embedding";
const OWNER_EMBEDDING_META_KEY = "looi.owner_speaker_embedding.meta";
const OWNER_EMBEDDING_CHUNK_KEY_PREFIX = "looi.owner_speaker_embedding.chunk.";
const OWNER_EMBEDDING_CHUNK_SIZE = 1800;
const DIAGNOSTIC_NON_OWNER_AUDIO = require("@/assets/diagnostics/non-owner-voice.wav");
const speakerStorage = createMMKV({
  id: "looi.voice.speaker-id",
});

interface StoredSpeakerEmbedding {
  version: 1;
  speakerName: string;
  embedding: number[];
  createdAt: string;
}

async function getSherpaVoiceAdapter() {
  const { sherpaVoiceAdapter } = await import("./sherpa-adapter");
  return sherpaVoiceAdapter;
}

export class SpeakerIdService {
  private enrolled = false;
  private readonly verificationThreshold = 0.35;

  async getStoredEnrollmentStatus(): Promise<boolean> {
    if (this.enrolled) return true;
    const stored = await this.readOwnerEmbedding();
    this.enrolled = Boolean(stored);
    return this.enrolled;
  }

  async refreshEnrollmentStatus(): Promise<boolean> {
    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    this.enrolled = await sherpaVoiceAdapter.hasSpeaker(OWNER_SPEAKER_NAME);
    if (!this.enrolled) {
      this.enrolled = await this.restoreOwnerEmbedding();
    }
    console.log(`[SpeakerId] Enrollment status refreshed: enrolled=${this.enrolled}`);
    return this.enrolled;
  }

  get isEnrolled(): boolean {
    return this.enrolled;
  }

  async enroll(audioSamples: number[] = []): Promise<void> {
    if (audioSamples.length === 0) {
      throw new Error("Speaker enrollment requires audio samples");
    }

    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    const embedding = await sherpaVoiceAdapter.computeSpeakerEmbedding(audioSamples);
    await sherpaVoiceAdapter.registerSpeaker(OWNER_SPEAKER_NAME, embedding);
    await this.storeOwnerEmbedding(embedding);
    this.enrolled = true;
  }

  async enrollFromFile(audioUri: string): Promise<void> {
    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    const embedding = await sherpaVoiceAdapter.computeSpeakerFileEmbedding(audioUri);
    await sherpaVoiceAdapter.registerSpeaker(OWNER_SPEAKER_NAME, embedding);
    await this.storeOwnerEmbedding(embedding);
    this.enrolled = true;
  }

  async clearEnrollment(): Promise<void> {
    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    try {
      if (await sherpaVoiceAdapter.hasSpeaker(OWNER_SPEAKER_NAME)) {
        await sherpaVoiceAdapter.removeSpeaker(OWNER_SPEAKER_NAME);
      }
    } catch (error) {
      console.warn("[SpeakerId] Failed to clear native owner speaker:", error);
    }

    speakerStorage.remove(OWNER_EMBEDDING_MMKV_KEY);
    await this.clearLegacySecureStoreOwnerEmbedding();
    this.enrolled = false;
    console.log("[SpeakerId] Owner enrollment cleared");
  }

  async verifySamples(audioSamples: number[]): Promise<boolean> {
    const ready = await this.ensureOwnerRegistered();
    if (!ready || audioSamples.length === 0) {
      return false;
    }

    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    const embedding = await sherpaVoiceAdapter.computeSpeakerEmbedding(audioSamples);
    return this.verifyOwnerEmbedding(
      OWNER_SPEAKER_NAME,
      embedding,
      this.verificationThreshold
    );
  }

  async verifyFile(audioUri: string): Promise<boolean> {
    const ready = await this.ensureOwnerRegistered();
    if (!ready) {
      return false;
    }

    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    const embedding = await sherpaVoiceAdapter.computeSpeakerFileEmbedding(audioUri);
    return this.verifyOwnerEmbedding(
      OWNER_SPEAKER_NAME,
      embedding,
      this.verificationThreshold
    );
  }

  async verifyDiagnosticNonOwner(): Promise<boolean> {
    if (!this.enrolled) {
      await this.refreshEnrollmentStatus();
    }
    if (!this.enrolled) {
      return false;
    }

    const asset = Asset.fromModule(DIAGNOSTIC_NON_OWNER_AUDIO);
    await asset.downloadAsync();
    const audioUri = asset.localUri || asset.uri;
    if (!audioUri) {
      throw new Error("Diagnostic non-owner audio asset is unavailable");
    }

    return this.verifyFile(audioUri);
  }

  async verify(): Promise<boolean> {
    return this.verifySamples([]);
  }

  get threshold(): number {
    return this.verificationThreshold;
  }

  private async restoreOwnerEmbedding(): Promise<boolean> {
    const stored = await this.readOwnerEmbedding();
    if (!stored) {
      console.log("[SpeakerId] No stored owner embedding to restore");
      return false;
    }

    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    await sherpaVoiceAdapter.registerSpeaker(OWNER_SPEAKER_NAME, stored.embedding);
    console.log(
      `[SpeakerId] Restored owner embedding from MMKV: dims=${stored.embedding.length}`
    );
    return true;
  }

  private async ensureOwnerRegistered(): Promise<boolean> {
    if (!this.enrolled) {
      await this.refreshEnrollmentStatus();
    }
    if (!this.enrolled) {
      return false;
    }

    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    if (await sherpaVoiceAdapter.hasSpeaker(OWNER_SPEAKER_NAME)) {
      return true;
    }

    this.enrolled = await this.restoreOwnerEmbedding();
    return this.enrolled;
  }

  private async verifyOwnerEmbedding(
    speakerName: string,
    embedding: number[],
    threshold: number
  ): Promise<boolean> {
    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    try {
      return await sherpaVoiceAdapter.verifySpeaker(speakerName, embedding, threshold);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("not found")) {
        throw error;
      }

      console.warn("[SpeakerId] Owner missing in native registry; restoring from MMKV");
      this.enrolled = await this.restoreOwnerEmbedding();
      if (!this.enrolled) {
        return false;
      }

      return sherpaVoiceAdapter.verifySpeaker(speakerName, embedding, threshold);
    }
  }

  private async storeOwnerEmbedding(embedding: number[]): Promise<void> {
    const payload: StoredSpeakerEmbedding = {
      version: 1,
      speakerName: OWNER_SPEAKER_NAME,
      embedding,
      createdAt: new Date().toISOString(),
    };
    speakerStorage.set(OWNER_EMBEDDING_MMKV_KEY, JSON.stringify(payload));
    await this.clearLegacySecureStoreOwnerEmbedding();
  }

  private async readOwnerEmbedding(): Promise<StoredSpeakerEmbedding | null> {
    const storedFromMmkv = this.readOwnerEmbeddingFromMmkv();
    if (storedFromMmkv) {
      return storedFromMmkv;
    }

    const legacyStored = await this.readLegacySecureStoreOwnerEmbedding();
    if (!legacyStored) {
      return null;
    }

    speakerStorage.set(OWNER_EMBEDDING_MMKV_KEY, JSON.stringify(legacyStored));
    await this.clearLegacySecureStoreOwnerEmbedding();
    console.log("[SpeakerId] Migrated owner embedding from SecureStore to MMKV");
    return legacyStored;
  }

  private readOwnerEmbeddingFromMmkv(): StoredSpeakerEmbedding | null {
    const serialized = speakerStorage.getString(OWNER_EMBEDDING_MMKV_KEY);
    if (!serialized) {
      return null;
    }

    try {
      const stored = JSON.parse(serialized) as StoredSpeakerEmbedding;
      if (!this.isValidStoredEmbedding(stored)) {
        speakerStorage.remove(OWNER_EMBEDDING_MMKV_KEY);
        return null;
      }
      return stored;
    } catch {
      speakerStorage.remove(OWNER_EMBEDDING_MMKV_KEY);
      return null;
    }
  }

  private async readLegacySecureStoreOwnerEmbedding(): Promise<StoredSpeakerEmbedding | null> {
    const metaValue = await SecureStore.getItemAsync(OWNER_EMBEDDING_META_KEY);
    if (!metaValue) {
      return null;
    }

    let meta: { version?: number; chunks?: number };
    try {
      meta = JSON.parse(metaValue);
    } catch {
      await this.clearLegacySecureStoreOwnerEmbedding();
      return null;
    }

    if (meta.version !== 1 || !meta.chunks || meta.chunks < 1) {
      await this.clearLegacySecureStoreOwnerEmbedding();
      return null;
    }

    const chunks: string[] = [];
    for (let index = 0; index < meta.chunks; index += 1) {
      const chunk = await SecureStore.getItemAsync(`${OWNER_EMBEDDING_CHUNK_KEY_PREFIX}${index}`);
      if (!chunk) {
        await this.clearLegacySecureStoreOwnerEmbedding();
        return null;
      }
      chunks.push(chunk);
    }

    try {
      const stored = JSON.parse(chunks.join("")) as StoredSpeakerEmbedding;
      if (!this.isValidStoredEmbedding(stored)) {
        await this.clearLegacySecureStoreOwnerEmbedding(meta.chunks);
        return null;
      }
      return stored;
    } catch {
      await this.clearLegacySecureStoreOwnerEmbedding(meta.chunks);
      return null;
    }
  }

  private isValidStoredEmbedding(stored: StoredSpeakerEmbedding): boolean {
    return (
      stored.version === 1 &&
      stored.speakerName === OWNER_SPEAKER_NAME &&
      Array.isArray(stored.embedding) &&
      stored.embedding.length > 0
    );
  }

  private async clearLegacySecureStoreOwnerEmbedding(chunkCount?: number): Promise<void> {
    const metaValue = await SecureStore.getItemAsync(OWNER_EMBEDDING_META_KEY);
    let chunks = chunkCount || 0;
    if (!chunks && metaValue) {
      try {
        const meta = JSON.parse(metaValue) as { chunks?: number };
        chunks = meta.chunks || 0;
      } catch {
        chunks = 0;
      }
    }

    await SecureStore.deleteItemAsync(OWNER_EMBEDDING_META_KEY);
    for (let index = 0; index < chunks; index += 1) {
      await SecureStore.deleteItemAsync(`${OWNER_EMBEDDING_CHUNK_KEY_PREFIX}${index}`);
    }
  }
}

export const speakerIdService = new SpeakerIdService();
