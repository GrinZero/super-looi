import {
  AudioModule,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  type AudioRecorder,
  type RecordingOptions,
} from "expo-audio";
import { useUserStore } from "../store/user";
import { getRuntimeProfile } from "../core/runtime-profile";

const SHERPA_RECORDING_OPTIONS: RecordingOptions = {
  extension: ".wav",
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 256000,
  android: {
    extension: ".wav",
    outputFormat: "default",
    audioEncoder: "default",
  },
  ios: {
    extension: ".wav",
    outputFormat: "lpcm",
    audioQuality: 0x7f,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: "audio/wav",
    bitsPerSecond: 256000,
  },
};

async function getKwsAudioFeeder() {
  const { kwsAudioFeeder } = await import("./kws-audio-feeder");
  return kwsAudioFeeder;
}

async function getSherpaVoiceAdapter() {
  const { sherpaVoiceAdapter } = await import("./sherpa-adapter");
  return sherpaVoiceAdapter;
}

/**
 * STT Service — Speech-to-Text
 * Legacy file-recording helper for settings diagnostics and owner enrollment.
 * The main conversation path uses streaming-stt.ts.
 */
export class STTService {
  private recording: AudioRecorder | null = null;
  private isRecording = false;
  private pausedWakewordFeeder = false;

  /**
   * Start recording audio
   */
  async startRecording(): Promise<void> {
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        throw new Error("Microphone permission denied");
      }

      await this.pauseWakewordFeeder();

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      const recording = new AudioModule.AudioRecorder(SHERPA_RECORDING_OPTIONS);
      await recording.prepareToRecordAsync();
      recording.record();

      this.recording = recording;
      this.isRecording = true;
    } catch (error) {
      await this.resumeWakewordFeederIfNeeded();
      console.error("[STT] Failed to start recording:", error);
      throw error;
    }
  }

  /**
   * Stop recording and transcribe
   */
  async stopAndTranscribe(): Promise<string> {
    const uri = await this.stopRecording();
    return await this.transcribeFile(uri);
  }

  /**
   * Stop recording and return the local audio file URI without transcribing it.
   */
  async stopRecording(): Promise<string> {
    if (!this.recording) {
      throw new Error("No active recording");
    }

    try {
      await this.recording.stop();
      this.isRecording = false;

      const uri = this.recording.uri;
      this.recording = null;

      if (!uri) {
        throw new Error("No recording URI");
      }

      return uri;
    } catch (error) {
      this.isRecording = false;
      this.recording = null;
      console.error("[STT] Failed to stop recording:", error);
      throw error;
    }
  }

  /**
   * Cancel current recording without transcribing
   */
  async cancel(): Promise<void> {
    if (this.recording) {
      try {
        await this.recording.stop();
      } catch {
        // Ignore
      }
      this.recording = null;
      this.isRecording = false;
    }
    await this.resumeWakewordFeederIfPaused();
  }

  get recording_active(): boolean {
    return this.isRecording;
  }

  /**
   * Transcribe the recorded audio file on device with sherpa-onnx.
   */
  async transcribeFile(audioUri: string): Promise<string> {
    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    return sherpaVoiceAdapter.transcribeFile(audioUri);
  }

  async resumeWakewordFeederIfPaused(): Promise<void> {
    await this.resumeWakewordFeederIfNeeded();
  }

  private async pauseWakewordFeeder(): Promise<void> {
    const kwsAudioFeeder = await getKwsAudioFeeder();
    if (!kwsAudioFeeder.isRunning) {
      return;
    }

    await kwsAudioFeeder.stop();
    this.pausedWakewordFeeder = true;
    console.log("[STT] Paused KWS feeder for recording");
  }

  private async resumeWakewordFeederIfNeeded(): Promise<void> {
    if (!this.pausedWakewordFeeder) {
      return;
    }

    this.pausedWakewordFeeder = false;
    if (!useUserStore.getState().preferences.wakeWordEnabled) {
      return;
    }
    if (!getRuntimeProfile().allowsWakewordAutostart) {
      return;
    }

    const kwsAudioFeeder = await getKwsAudioFeeder();
    await kwsAudioFeeder.start();
    console.log("[STT] Resumed KWS feeder after recording");
  }
}

export const sttService = new STTService();
