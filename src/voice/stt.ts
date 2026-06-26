import { Audio } from "expo-av";

/**
 * STT Service — Speech-to-Text
 * Phase 1: Uses server-side Whisper-compatible API (degraded from sherpa-onnx)
 * The server at LLM_BASE_URL provides a Whisper-compatible endpoint
 */
export class STTService {
  private recording: Audio.Recording | null = null;
  private isRecording = false;
  private serverUrl: string;

  constructor() {
    this.serverUrl = process.env.EXPO_PUBLIC_LOOI_SERVER_URL || "http://192.168.3.71:8080";
  }

  /**
   * Start recording audio
   */
  async startRecording(): Promise<void> {
    try {
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );

      this.recording = recording;
      this.isRecording = true;
    } catch (error) {
      console.error("[STT] Failed to start recording:", error);
      throw error;
    }
  }

  /**
   * Stop recording and transcribe
   */
  async stopAndTranscribe(): Promise<string> {
    if (!this.recording) {
      throw new Error("No active recording");
    }

    try {
      await this.recording.stopAndUnloadAsync();
      this.isRecording = false;

      const uri = this.recording.getURI();
      this.recording = null;

      if (!uri) {
        throw new Error("No recording URI");
      }

      // Send to server for transcription
      return await this.transcribeAudio(uri);
    } catch (error) {
      this.isRecording = false;
      this.recording = null;
      console.error("[STT] Failed to transcribe:", error);
      throw error;
    }
  }

  /**
   * Cancel current recording without transcribing
   */
  async cancel(): Promise<void> {
    if (this.recording) {
      try {
        await this.recording.stopAndUnloadAsync();
      } catch {
        // Ignore
      }
      this.recording = null;
      this.isRecording = false;
    }
  }

  get recording_active(): boolean {
    return this.isRecording;
  }

  /**
   * Send audio file to server for transcription
   */
  private async transcribeAudio(audioUri: string): Promise<string> {
    const formData = new FormData();
    formData.append("file", {
      uri: audioUri,
      type: "audio/m4a",
      name: "recording.m4a",
    } as unknown as Blob);
    formData.append("language", "zh");

    const response = await fetch(`${this.serverUrl}/api/stt/transcribe`, {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "multipart/form-data",
      },
    });

    if (!response.ok) {
      throw new Error(`STT server error: ${response.status}`);
    }

    const data = await response.json();
    return data.text || "";
  }
}

export const sttService = new STTService();
