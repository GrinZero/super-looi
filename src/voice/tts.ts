import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { getConfiguredServerUrl } from "../server-api/client";

const MINIMAX_TTS_URL = "https://api.minimax.chat/v1/t2a_v2";
const TTS_PLAYBACK_MIN_TIMEOUT_MS = 8_000;
const TTS_PLAYBACK_MAX_TIMEOUT_MS = 30_000;
const BINARY_STRING_CHUNK_SIZE = 0x8000;

interface TTSOptions {
  text: string;
  voiceId?: string;
  speed?: number;
}

interface TTSAudioUrlOptions {
  text: string;
  audioUrl: string;
  onPlaybackStart?: () => void;
}

interface SpeakSentencesOptions extends Omit<TTSOptions, "text"> {
  onSentenceStart?: (sentence: string) => void;
  onSentenceEnd?: (sentence: string) => void;
}

interface SpeakAudioUrlsOptions {
  onSentenceStart?: (sentence: string) => void;
  onSentenceEnd?: (sentence: string) => void;
}

/**
 * MiniMax TTS — stream synthesis and playback
 */
export class TTSService {
  private apiKey: string;
  private groupId: string;
  private player: AudioPlayer | null = null;
  private isPlaying = false;

  constructor() {
    this.apiKey = process.env.EXPO_PUBLIC_MINIMAX_API_KEY || "";
    this.groupId = process.env.EXPO_PUBLIC_MINIMAX_GROUP_ID || "";
  }

  /**
   * Synthesize text to speech and play it
   */
  async speak(options: TTSOptions & { onPlaybackStart?: () => void }): Promise<void> {
    const { text, voiceId = "male-qn-qingse", speed = 1.0 } = options;

    if (!text.trim()) return;

    // Stop any currently playing audio
    await this.stop();

    try {
      await this.playStreamingTts({
        text,
        voiceId,
        speed,
        onPlaybackStart: options.onPlaybackStart,
      });
      return;
    } catch (error) {
      this.isPlaying = false;
      console.warn("[TTS] Streaming playback failed; falling back to buffered synthesis:", error);
      await this.stop();
    }

    await this.speakBuffered({ text, voiceId, speed, onPlaybackStart: options.onPlaybackStart });
  }

  async speakAudioUrl(options: TTSAudioUrlOptions): Promise<void> {
    const { text, audioUrl } = options;
    if (!text.trim() || !audioUrl.trim()) return;

    await this.stop();

    const player = createAudioPlayer(
      { uri: audioUrl },
      {
        updateInterval: 250,
        preferredForwardBufferDuration: 0.2,
      }
    );

    this.player = player;
    this.isPlaying = true;
    player.play();
    options.onPlaybackStart?.();

    return this.waitForPlaybackToFinish(player, text);
  }

  private async speakBuffered(
    options: TTSOptions & { onPlaybackStart?: () => void }
  ): Promise<void> {
    const { text, voiceId = "male-qn-qingse", speed = 1.0 } = options;

    try {
      const response = await fetch(
        MINIMAX_TTS_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: "speech-02-hd",
            text,
            stream: false,
            voice_setting: {
              voice_id: voiceId,
              speed,
              vol: 1.0,
              pitch: 0,
            },
            audio_setting: {
              sample_rate: 32000,
              bitrate: 128000,
              format: "mp3",
            },
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`TTS request failed: ${response.status}`);
      }

      const data = await response.json();

      if (data.base_resp?.status_code !== 0) {
        throw new Error(`TTS error: ${data.base_resp?.status_msg || "unknown"}`);
      }

      // data.data.audio is hex-encoded MP3 audio
      const audioHex = data.data?.audio;
      if (!audioHex) {
        throw new Error("No audio data in TTS response");
      }

      // Convert hex to base64 for audio URI
      const hexToBase64 = (hex: string): string => {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
          bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        const chunks: string[] = [];
        for (let offset = 0; offset < bytes.length; offset += BINARY_STRING_CHUNK_SIZE) {
          chunks.push(
            String.fromCharCode(...bytes.subarray(offset, offset + BINARY_STRING_CHUNK_SIZE))
          );
        }
        const binary = chunks.join("");
        return btoa(binary);
      };

      const audioBase64 = hexToBase64(audioHex);

      // Create audio from base64
      const audioUri = `data:audio/mp3;base64,${audioBase64}`;
      const player = createAudioPlayer({ uri: audioUri }, { updateInterval: 250 });

      this.player = player;
      this.isPlaying = true;
      player.play();
      options.onPlaybackStart?.();

      return this.waitForPlaybackToFinish(player, text);
    } catch (error) {
      this.isPlaying = false;
      console.error("[TTS] Error:", error);
      throw error;
    }
  }

  private async playStreamingTts(
    options: TTSOptions & { onPlaybackStart?: () => void }
  ): Promise<void> {
    const { text, voiceId = "male-qn-qingse", speed = 1.0 } = options;
    const params = new URLSearchParams({
      text,
      voiceId,
      speed: String(speed),
    });
    const audioUri = `${getConfiguredServerUrl()}/api/tts/stream?${params.toString()}`;
    const player = createAudioPlayer(
      { uri: audioUri },
      {
        updateInterval: 250,
        preferredForwardBufferDuration: 0.2,
      }
    );

    this.player = player;
    this.isPlaying = true;
    player.play();
    options.onPlaybackStart?.();

    return this.waitForPlaybackToFinish(player, text);
  }

  private waitForPlaybackToFinish(player: AudioPlayer, text: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      const resolveOnce = () => {
        if (resolved) return;
        resolved = true;
        clearInterval(interval);
        clearTimeout(timeout);
        this.isPlaying = false;
        this.cleanup();
        resolve();
      };
      const rejectOnce = (error: Error) => {
        if (resolved) return;
        resolved = true;
        clearInterval(interval);
        clearTimeout(timeout);
        this.isPlaying = false;
        this.cleanup();
        reject(error);
      };
      const interval = setInterval(() => {
        if (player.currentStatus.error) {
          rejectOnce(new Error(player.currentStatus.error));
          return;
        }
        if (!player.playing && player.currentStatus.didJustFinish) {
          resolveOnce();
        }
      }, 250);
      const timeoutMs = Math.min(
        TTS_PLAYBACK_MAX_TIMEOUT_MS,
        Math.max(TTS_PLAYBACK_MIN_TIMEOUT_MS, text.length * 280)
      );
      const timeout = setTimeout(() => {
        console.warn(`[TTS] Playback timeout after ${timeoutMs}ms`);
        resolveOnce();
      }, timeoutMs);
    });
  }

  async speakSentences(
    sentences: AsyncIterable<string>,
    options: SpeakSentencesOptions = {}
  ): Promise<void> {
    for await (const sentence of sentences) {
      const text = sentence.trim();
      if (!text) continue;

      await this.speak({
        text,
        voiceId: options.voiceId,
        speed: options.speed,
        onPlaybackStart: () => options.onSentenceStart?.(text),
      });
      options.onSentenceEnd?.(text);
    }
  }

  /**
   * Play a stream of already-synthesized {text, audioUrl} items in order,
   * without re-synthesizing on the client (server did the TTS work).
   */
  async speakAudioUrls(
    items: AsyncIterable<{ text: string; audioUrl: string }>,
    options: SpeakAudioUrlsOptions = {}
  ): Promise<void> {
    for await (const item of items) {
      const text = item.text.trim();
      if (!text || !item.audioUrl.trim()) continue;

      await this.speakAudioUrl({
        text,
        audioUrl: item.audioUrl,
        onPlaybackStart: () => options.onSentenceStart?.(text),
      });
      options.onSentenceEnd?.(text);
    }
  }

  /**
   * Stop current playback
   */
  async stop(): Promise<void> {
    if (this.player) {
      try {
        this.player.pause();
      } catch {
        // Already stopped
      }
      this.cleanup();
    }
    this.isPlaying = false;
  }

  /**
   * Check if currently speaking
   */
  get speaking(): boolean {
    return this.isPlaying;
  }

  private async cleanup(): Promise<void> {
    if (this.player) {
      try {
        this.player.remove();
      } catch {
        // Ignore cleanup errors
      }
      this.player = null;
    }
  }
}

export const ttsService = new TTSService();
