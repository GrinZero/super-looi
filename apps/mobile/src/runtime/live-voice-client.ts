import { createMemoryClaim, type MemoryClaim } from "@super-looi/contracts";

export type LiveVoicePhase = "disconnected" | "connecting" | "listening" | "thinking" | "speaking" | "error";

export interface HubMemoryItem {
  id: string;
  fact: string;
  subject?: string;
  location?: string;
  category: "item_location" | "preference" | "todo" | "note";
  source: "voice" | "agent" | "user";
  updatedAt: string;
}

export interface LiveAgentQuestion {
  id: string; question: string; detail?: string; multiSelect?: boolean;
  options?: Array<{ label: string; description?: string }>;
  intent?: { kind: string };
}
export interface LiveAgentInteraction {
  id: string; kind: "approval" | "question"; expiresAt: string;
  details: { questions?: LiveAgentQuestion[]; [key: string]: unknown };
}
export type LiveAgentAnswer = { outcome: "allowed-once" | "rejected" | "cancelled" } | { answers: Array<{ id: string; selected: string[]; custom?: string }> } | { cancelled: true };

export interface LiveVoiceAgentStatus {
  phase: "thinking" | "tool_start" | "tool_end" | "awaiting_approval" | "awaiting_input" | "done" | "error";
  taskId?: string;
  interaction?: LiveAgentInteraction;
  tool: string;
  summary: string;
  memories?: HubMemoryItem[];
}

export interface LiveVoiceClientCallbacks {
  onPhaseChange?: (phase: LiveVoicePhase) => void;
  onUserTranscript?: (text: string, isFinal: boolean) => void;
  onAssistantTranscript?: (text: string, isFinal: boolean) => void;
  onAgentStatus?: (status: LiveVoiceAgentStatus) => void;
  onAudioLevel?: (level: number) => void;
  onError?: (message: string) => void;
}

export interface WebSocketAdapter {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
}

export interface LiveVoiceClientOptions extends LiveVoiceClientCallbacks {
  hubOrigin: string;
  wsFactory?: (url: string) => WebSocketAdapter;
  enableNativeMic?: boolean;
  enableNativePlayback?: boolean;
}

/**
 * Encodes raw 16-bit little-endian mono PCM bytes into a standard 44-byte RIFF WAV buffer.
 */
export function buildWavFromPcm16Mono(pcmBytes: Uint8Array, sampleRate = 24_000): Uint8Array {
  const dataLen = pcmBytes.byteLength;
  const wav = new Uint8Array(44 + dataLen);
  const view = new DataView(wav.buffer);

  writeAscii(wav, 0, "RIFF");
  view.setUint32(4, 36 + dataLen, true);
  writeAscii(wav, 8, "WAVE");
  writeAscii(wav, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format = 1
  view.setUint16(22, 1, true); // Mono = 1 channel
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (sampleRate * blockAlign)
  view.setUint16(32, 2, true); // block align (1ch * 2 bytes)
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(wav, 36, "data");
  view.setUint32(40, dataLen, true);
  wav.set(pcmBytes, 44);
  return wav;
}

function writeAscii(target: Uint8Array, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    target[offset + i] = str.charCodeAt(i);
  }
}

/**
 * Computes normalized RMS audio level (0..1) from 16-bit signed LE PCM bytes.
 */
export function computePcm16Rms(pcmBytes: Uint8Array): number {
  const sampleCount = Math.floor(pcmBytes.byteLength / 2);
  if (sampleCount === 0) return 0;
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, sampleCount * 2);
  let sumSq = 0;
  const step = Math.max(1, Math.floor(sampleCount / 120));
  let counted = 0;
  for (let i = 0; i < sampleCount; i += step) {
    const sample = view.getInt16(i * 2, true) / 32768;
    sumSq += sample * sample;
    counted++;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, counted));
  return Math.min(1, Math.round(rms * 3.8 * 100) / 100);
}

/**
 * Converts Float32 audio samples (-1..1) into base64-encoded PCM16LE and computes RMS level.
 */
export function floatSamplesToPcm16Base64(samples: ArrayLike<number>): { base64: string; rms: number } {
  const len = samples.length;
  const pcmBytes = new Uint8Array(len * 2);
  const view = new DataView(pcmBytes.buffer);
  let sumSq = 0;
  for (let i = 0; i < len; i++) {
    const clamped = Math.max(-1, Math.min(1, Number(samples[i] ?? 0)));
    sumSq += clamped * clamped;
    const intVal = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    view.setInt16(i * 2, intVal, true);
  }
  const rms = len > 0 ? Math.min(1, Math.sqrt(sumSq / len) * 4.2) : 0;
  return {
    base64: bytesToBase64(pcmBytes),
    rms: Math.round(rms * 100) / 100,
  };
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return globalThis.btoa(bin);
}

export async function fetchHubMemories(hubOrigin: string, signal?: AbortSignal): Promise<HubMemoryItem[]> {
  const url = `${hubOrigin.replace(/\/+$/, "")}/api/agent/memories`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = (await res.json()) as { memories?: HubMemoryItem[] };
  return Array.isArray(data.memories) ? data.memories : [];
}

export function hubMemoriesToClaims(items: HubMemoryItem[]): MemoryClaim[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items.map((item) =>
    createMemoryClaim({
      claim_id: `claim_${item.id}`,
      predicate: item.category === "item_location" ? "object_last_seen" : "personal_note",
      object: {
        target: item.subject || item.fact.slice(0, 16),
        location: item.location || "个人备忘",
        text: item.fact,
      },
      status: "confirmed",
      source_kind: "authenticated_user_statement",
      evidence_ids: [`ev_${item.id}`],
      derivation_roots: [`root_${item.id}`],
      observed_at: item.updatedAt,
      source_availability: "retained",
    })
  );
}

/**
 * LiveVoiceClient:
 * Manages full-duplex `/ws/voice` connection to Super-LOOI Hub, native 16kHz microphone capture,
 * real-time 24kHz WAV playout, barge-in interruption, and zero-cognitive-load Agent status updates.
 */
export class LiveVoiceClient {
  private connectionGeneration = 0;
  private ws: WebSocketAdapter | null = null;
  private phase: LiveVoicePhase = "disconnected";
  private sequence = 0;
  private outboundPcmChunks: Uint8Array[] = [];
  private outboundSampleRate = 24_000;
  private activePlayer: { pause?: () => void; remove?: () => void } | null = null;
  private activeWavFile: { delete?: () => void } | null = null;
  private playbackTimer: ReturnType<typeof setInterval> | null = null;
  private micSubscription: { remove: () => void } | null = null;
  private micRunning = false;
  private micGeneration = 0;
  private speakerUntil = 0;
  private playbackGeneration = 0;
  private assistantTextBuffer = "";
  private levelDecayTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: LiveVoiceClientOptions) {}

  public getPhase(): LiveVoicePhase {
    return this.phase;
  }

  public isActive(): boolean {
    return this.phase !== "disconnected" && this.phase !== "error";
  }

  private setPhase(next: LiveVoicePhase): void {
    if (this.phase === next) return;
    this.phase = next;
    this.options.onPhaseChange?.(next);
  }

  public async start(): Promise<void> {
    if (this.ws && this.isActive()) return;
    const generation = ++this.connectionGeneration;
    this.setPhase("connecting");

    const wsUrl = `${this.options.hubOrigin.replace(/^http/i, "ws").replace(/\/+$/, "")}/ws/voice`;
    const factory =
      this.options.wsFactory ??
      ((url: string) => new WebSocket(url) as unknown as WebSocketAdapter);

    const socket = factory(wsUrl);
    this.ws = socket;

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("连接语音服务超时"));
        }, 8_000);

        socket.onopen = () => {
          clearTimeout(timeout);
          resolve();
        };

        socket.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("无法连接语音通道，请检查连接设置"));
        };
        socket.onclose = () => { clearTimeout(timeout); reject(new Error("语音连接已取消")); };
      });
    } catch (err) {
      try {
        socket.close();
      } catch {
        // ignore
      }
      if (generation === this.connectionGeneration) { this.ws = null; this.setPhase("error"); }
      throw err;
    }
    if (generation !== this.connectionGeneration || this.ws !== socket) throw new Error("语音连接已取消");

    socket.onmessage = (event) => {
      if (this.ws !== socket || generation !== this.connectionGeneration) return;
      this.handleServerFrame(event.data);
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      void this.stopMicCapture();
      this.stopPlayback();
      this.ws = null;
      this.setPhase("disconnected");
    };

    // Unmute session and start native mic capture if available
    this.sendJson({ type: "unmute_commit" });
    this.setPhase("listening");

    if (this.options.enableNativeMic !== false) {
      await this.startMicCapture().catch(() => {
        // Simulator without mic hardware or permission still supports text/voice playback
      });
    }
  }

  public async stop(): Promise<void> {
    ++this.connectionGeneration;
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try { if (socket.readyState === 1) socket.send(JSON.stringify({ type: "session_close" })); socket.close(); } catch { /* Already closed. */ }
    }
    this.speakerUntil = 0;
    this.setPhase("disconnected");
    this.stopPlayback();
    await this.stopMicCapture();
    this.options.onAudioLevel?.(0);
  }

  public bargeIn(): void {
    this.stopPlayback();
    this.speakerUntil = 0;
    this.assistantTextBuffer = "";
    this.sendJson({ type: "barge_in" });
    this.setPhase("listening");
  }

  public respondToAgent(taskId: string, requestId: string, answer: LiveAgentAnswer): void {
    this.sendJson({ type: "agent_response", task_id: taskId, request_id: requestId, answer });
  }

  public cancelAgentTask(taskId: string): void {
    this.sendJson({ type: "agent_cancel", task_id: taskId });
  }

  public sendTextPrompt(text: string): void {
    const clean = text.trim();
    if (!clean || !this.ws) return;
    this.stopPlayback();
    this.assistantTextBuffer = "";
    this.sendJson({ type: "text_input", text: clean });
  }
  public speakText(text: string): void { if (text.trim()) this.sendJson({ type: "speak_text", text: text.trim() }); }

  public pushFloat32MicSamples(samples: ArrayLike<number>): void {
    if (!this.ws || this.phase === "disconnected" || Date.now() < this.speakerUntil) return;
    const { base64, rms } = floatSamplesToPcm16Base64(samples);
    if (this.phase === "listening") {
      this.options.onAudioLevel?.(rms);
    }
    this.sendJson({
      type: "audio_chunk",
      pcm_base64: base64,
      sample_rate: 16_000,
      sequence: ++this.sequence,
    });
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private handleServerFrame(raw: unknown): void {
    try {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      const type = String(msg.type ?? "");

      switch (type) {
        case "session_ready": {
          if (this.phase === "connecting") {
            this.setPhase("listening");
          }
          break;
        }
        case "state_change": {
          const state = String(msg.state ?? "");
          if (state === "listening" || state === "idle") {
            const startedPlayback = this.flushAudioPlayback();
            if (!startedPlayback) {
              this.setPhase("listening");
            }
          } else if (state === "thinking") {
            this.setPhase("thinking");
          } else if (state === "speaking") {
            this.setPhase("speaking");
          }
          break;
        }
        case "transcript": {
          const role = String(msg.role ?? "assistant");
          const text = String(msg.text ?? "");
          const isFinal = Boolean(msg.is_final);
          if (role === "user") {
            this.assistantTextBuffer = "";
            this.options.onUserTranscript?.(text, isFinal);
          } else {
            if (isFinal) {
              this.assistantTextBuffer = "";
              this.options.onAssistantTranscript?.(text, true);
            } else {
              this.assistantTextBuffer += text;
              this.options.onAssistantTranscript?.(this.assistantTextBuffer, false);
            }
          }
          break;
        }
        case "audio_chunk": {
          const b64 = String(msg.pcm_base64 ?? "");
          if (!b64) break;
          const bytes = base64ToBytes(b64);
          this.outboundSampleRate = Number(msg.sample_rate ?? 24_000);
          this.outboundPcmChunks.push(bytes);

          const rms = computePcm16Rms(bytes);
          this.options.onAudioLevel?.(Math.max(0.18, rms));
          this.scheduleLevelDecay();
          break;
        }
        case "agent_status": {
          this.options.onAgentStatus?.({
            phase: (msg.phase as LiveVoiceAgentStatus["phase"]) ?? "thinking",
            taskId: typeof msg.task_id === "string" ? msg.task_id : undefined,
            interaction: msg.interaction as LiveAgentInteraction | undefined,
            tool: String(msg.tool ?? "agent"),
            summary: String(msg.summary ?? ""),
            memories: Array.isArray(msg.memories) ? (msg.memories as HubMemoryItem[]) : undefined,
          });
          break;
        }
        case "interrupted": {
          this.stopPlayback();
          this.assistantTextBuffer = "";
          this.setPhase("listening");
          break;
        }
        case "error": {
          const errMsg = String(msg.message ?? "语音会话错误");
          this.options.onError?.(errMsg);
          break;
        }
      }
    } catch {
      // ignore non-JSON frame
    }
  }

  private scheduleLevelDecay(): void {
    if (this.levelDecayTimer) clearTimeout(this.levelDecayTimer);
    this.levelDecayTimer = setTimeout(() => {
      this.options.onAudioLevel?.(0);
    }, 360);
  }

  private flushAudioPlayback(): boolean {
    if (this.outboundPcmChunks.length === 0) return false;
    const totalBytes = this.outboundPcmChunks.reduce((acc, c) => acc + c.byteLength, 0);
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of this.outboundPcmChunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.outboundPcmChunks = [];

    if (this.options.enableNativePlayback !== false) {
      this.setPhase("speaking");
      this.speakerUntil = Date.now() + merged.length / (this.outboundSampleRate * 2) * 1000 + 150;
      this.startEnvelopePlayback(merged, this.outboundSampleRate);
      void this.playWavBytes(merged, this.outboundSampleRate);
      return true;
    }
    return false;
  }

  private startEnvelopePlayback(pcmBytes: Uint8Array, sampleRate: number): void {
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
    if (this.levelDecayTimer) {
      clearTimeout(this.levelDecayTimer);
      this.levelDecayTimer = null;
    }
    const bytesPer100Ms = Math.max(2, Math.floor((sampleRate * 2) / 10));
    const steps: number[] = [];
    for (let i = 0; i < pcmBytes.byteLength; i += bytesPer100Ms) {
      const slice = pcmBytes.subarray(i, Math.min(pcmBytes.byteLength, i + bytesPer100Ms));
      steps.push(Math.max(0.15, computePcm16Rms(slice)));
    }
    let idx = 0;
    this.playbackTimer = setInterval(() => {
      if (idx >= steps.length) {
        if (this.playbackTimer) {
          clearInterval(this.playbackTimer);
          this.playbackTimer = null;
        }
        this.options.onAudioLevel?.(0);
        if (this.phase === "speaking") {
          this.setPhase("listening");
        }
        return;
      }
      this.options.onAudioLevel?.(steps[idx]!);
      idx++;
    }, 100);
  }

  private async playWavBytes(pcmBytes: Uint8Array, sampleRate: number): Promise<void> {
    const generation = this.playbackGeneration;
    try {
      const wavBytes = buildWavFromPcm16Mono(pcmBytes, sampleRate);
      const [{ File, Paths }, { createAudioPlayer }] = await Promise.all([
        import("expo-file-system"),
        import("expo-audio"),
      ]);
      if (generation !== this.playbackGeneration || !this.isActive()) return;
      const file = new File(Paths.cache, `looi_reply_${Date.now()}.wav`);
      file.write(wavBytes);
      if (this.activePlayer) {
        try {
          this.activePlayer.pause?.();
          this.activePlayer.remove?.();
        } catch {
          // ignore
        }
      }
      if (this.activeWavFile) {
        try {
          this.activeWavFile.delete?.();
        } catch {
          // ignore
        }
      }
      const player = createAudioPlayer({ uri: file.uri });
      this.activePlayer = player;
      this.activeWavFile = file;
      this.speakerUntil = Date.now() + pcmBytes.length / (sampleRate * 2) * 1000 + 150;
      player.play();
    } catch {
      if (generation === this.playbackGeneration) this.speakerUntil = 0;
    }
  }

  private stopPlayback(): void {
    ++this.playbackGeneration;
    this.speakerUntil = 0;
    this.outboundPcmChunks = [];
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
    if (this.levelDecayTimer) {
      clearTimeout(this.levelDecayTimer);
      this.levelDecayTimer = null;
    }
    if (this.activePlayer) {
      try {
        this.activePlayer.pause?.();
        this.activePlayer.remove?.();
      } catch {
        // ignore
      }
      this.activePlayer = null;
    }
    if (this.activeWavFile) {
      try {
        this.activeWavFile.delete?.();
      } catch {
        // ignore
      }
      this.activeWavFile = null;
    }
    this.options.onAudioLevel?.(0);
  }

  private async startMicCapture(): Promise<void> {
    if (this.micRunning) return;
    const generation = ++this.micGeneration;
    const mod = (await import("@siteed/audio-studio").catch(() => null)) as any;
    const studio = mod?.AudioStudioModule;
    if (!studio?.startRecording) return;

    if (studio.requestPermissionsAsync) {
      const perm = await studio.requestPermissionsAsync();
      if (perm && perm.granted === false) return;
    }

    if (generation !== this.micGeneration || !this.isActive()) return;
    this.micSubscription = studio.addListener("AudioData", (event: any) => {
      const samples = event?.pcmFloat32 ?? event?.buffer ?? (typeof event?.data !== "string" ? event?.data : undefined);
      if (samples && samples.length > 0) {
        this.pushFloat32MicSamples(samples);
      }
    });

    const config = {
      sampleRate: 16000,
      channels: 1,
      encoding: "pcm_16bit",
      bitDepth: 16,
      interval: 80,
      streamFormat: "float32",
      keepAwake: true,
      autoResumeAfterInterruption: true,
      output: { primary: { enabled: false } },
      ios: { audioSession: { category: "PlayAndRecord", mode: "VoiceChat" } },
      android: { audioFocusStrategy: "interactive" },
    };

    if (studio.prepareRecording) {
      await studio.prepareRecording(config).catch(() => {});
    }
    await studio.startRecording(config);
    if (generation !== this.micGeneration || !this.isActive()) { await studio.stopRecording().catch(() => {}); return; }
    this.micRunning = true;
  }

  private async stopMicCapture(): Promise<void> {
    ++this.micGeneration;
    if (this.micSubscription) {
      try {
        this.micSubscription.remove();
      } catch {
        // ignore
      }
      this.micSubscription = null;
    }
    if (!this.micRunning) return;
    this.micRunning = false;
    try {
      const mod = (await import("@siteed/audio-studio").catch(() => null)) as any;
      await mod?.AudioStudioModule?.stopRecording?.();
    } catch {
      // ignore
    }
  }
}
