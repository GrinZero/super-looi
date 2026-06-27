import * as SecureStore from "expo-secure-store";
import { sherpaVoiceAdapter } from "./sherpa-adapter";

const OWNER_SPEAKER_NAME = "owner";
const OWNER_EMBEDDING_META_KEY = "looi.owner_speaker_embedding.meta";
const OWNER_EMBEDDING_CHUNK_KEY_PREFIX = "looi.owner_speaker_embedding.chunk.";
const OWNER_EMBEDDING_CHUNK_SIZE = 1800;

interface StoredSpeakerEmbedding {
  version: 1;
  speakerName: string;
  embedding: number[];
  createdAt: string;
}

export class SpeakerIdService {
  private enrolled = false;
  private readonly verificationThreshold = 0.6;

  async refreshEnrollmentStatus(): Promise<boolean> {
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

    const embedding = await sherpaVoiceAdapter.computeSpeakerEmbedding(audioSamples);
    await sherpaVoiceAdapter.registerSpeaker(OWNER_SPEAKER_NAME, embedding);
    await this.storeOwnerEmbedding(embedding);
    this.enrolled = true;
  }

  async enrollFromFile(audioUri: string): Promise<void> {
    const embedding = await sherpaVoiceAdapter.computeSpeakerFileEmbedding(audioUri);
    await sherpaVoiceAdapter.registerSpeaker(OWNER_SPEAKER_NAME, embedding);
    await this.storeOwnerEmbedding(embedding);
    this.enrolled = true;
  }

  async verifySamples(audioSamples: number[]): Promise<boolean> {
    if (!this.enrolled) {
      await this.refreshEnrollmentStatus();
    }
    if (!this.enrolled || audioSamples.length === 0) {
      return false;
    }

    const embedding = await sherpaVoiceAdapter.computeSpeakerEmbedding(audioSamples);
    return sherpaVoiceAdapter.verifySpeaker(
      OWNER_SPEAKER_NAME,
      embedding,
      this.verificationThreshold
    );
  }

  async verifyFile(audioUri: string): Promise<boolean> {
    if (!this.enrolled) {
      await this.refreshEnrollmentStatus();
    }
    if (!this.enrolled) {
      return false;
    }

    const embedding = await sherpaVoiceAdapter.computeSpeakerFileEmbedding(audioUri);
    return sherpaVoiceAdapter.verifySpeaker(
      OWNER_SPEAKER_NAME,
      embedding,
      this.verificationThreshold
    );
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

    await sherpaVoiceAdapter.registerSpeaker(OWNER_SPEAKER_NAME, stored.embedding);
    console.log(
      `[SpeakerId] Restored owner embedding from SecureStore: dims=${stored.embedding.length}`
    );
    return true;
  }

  private async storeOwnerEmbedding(embedding: number[]): Promise<void> {
    const payload: StoredSpeakerEmbedding = {
      version: 1,
      speakerName: OWNER_SPEAKER_NAME,
      embedding,
      createdAt: new Date().toISOString(),
    };
    const serialized = JSON.stringify(payload);
    const chunks = serialized.match(new RegExp(`.{1,${OWNER_EMBEDDING_CHUNK_SIZE}}`, "g")) || [];

    await this.clearStoredOwnerEmbedding();
    for (let index = 0; index < chunks.length; index += 1) {
      await SecureStore.setItemAsync(
        `${OWNER_EMBEDDING_CHUNK_KEY_PREFIX}${index}`,
        chunks[index]
      );
    }
    await SecureStore.setItemAsync(
      OWNER_EMBEDDING_META_KEY,
      JSON.stringify({ version: 1, chunks: chunks.length })
    );
  }

  private async readOwnerEmbedding(): Promise<StoredSpeakerEmbedding | null> {
    const metaValue = await SecureStore.getItemAsync(OWNER_EMBEDDING_META_KEY);
    if (!metaValue) {
      return null;
    }

    let meta: { version?: number; chunks?: number };
    try {
      meta = JSON.parse(metaValue);
    } catch {
      await this.clearStoredOwnerEmbedding();
      return null;
    }

    if (meta.version !== 1 || !meta.chunks || meta.chunks < 1) {
      await this.clearStoredOwnerEmbedding();
      return null;
    }

    const chunks: string[] = [];
    for (let index = 0; index < meta.chunks; index += 1) {
      const chunk = await SecureStore.getItemAsync(`${OWNER_EMBEDDING_CHUNK_KEY_PREFIX}${index}`);
      if (!chunk) {
        await this.clearStoredOwnerEmbedding();
        return null;
      }
      chunks.push(chunk);
    }

    try {
      const stored = JSON.parse(chunks.join("")) as StoredSpeakerEmbedding;
      if (
        stored.version !== 1 ||
        stored.speakerName !== OWNER_SPEAKER_NAME ||
        !Array.isArray(stored.embedding) ||
        stored.embedding.length === 0
      ) {
        await this.clearStoredOwnerEmbedding(meta.chunks);
        return null;
      }
      return stored;
    } catch {
      await this.clearStoredOwnerEmbedding(meta.chunks);
      return null;
    }
  }

  private async clearStoredOwnerEmbedding(chunkCount?: number): Promise<void> {
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
