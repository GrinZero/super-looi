import {
  VoiceCredentialStore,
  type VoiceConfigurationSnapshot,
} from "./credentials.js";
import { LiveVoiceSession } from "./live-session.js";
import {
  createVoiceProtocol,
  type RealtimeProtocolAdapter,
} from "./protocol.js";
import type {
  VoiceProactiveNotice,
  VoiceRuntimeOptions,
  VoiceState,
} from "./types.js";

const STANDBY_POLL_MS = 60;
const PERMISSION_POLL_MS = 250;

/**
 * Foreground voice supervisor: coordinates microphone permission, local KWS
 * standby polling, at most one disposable LiveVoiceSession at a time, and
 * cross-session background task receipts / `WHEN_IDLE` notice delivery.
 */
export class VoiceRuntime {
  private readonly credentials: VoiceCredentialStore;
  private readonly protocol: RealtimeProtocolAdapter;
  private state: VoiceState;
  private session?: LiveVoiceSession;
  private latestContextNote = "";
  private readonly pendingNotices: VoiceProactiveNotice[] = [];
  private standbyTimer?: ReturnType<typeof setTimeout>;
  private cueStopTimer?: ReturnType<typeof setTimeout>;
  private standbyGeneration = 0;
  private standbyPreparing?: number;
  private suppressAutoStandbyPrompt = false;
  private prePreviewTranscript?: string;
  private closed = false;

  constructor(private readonly options: VoiceRuntimeOptions) {
    this.protocol =
      options.protocol ??
      createVoiceProtocol({
        providerId: process.env.VOICE_PROVIDER,
        baseUrl: process.env.VOICE_BASE_URL,
        model: process.env.VOICE_MODEL,
      });
    this.credentials = new VoiceCredentialStore(options.vault);
    this.state = {
      phase: this.credentials.corruptOnLoad ? "error" : "idle",
      muted: false,
      wakeEnabled: this.credentials.wakeEnabled,
      transcript: "",
      error: this.credentials.corruptOnLoad
        ? "@looi:runtimeVoiceCredentialsUnavailableConfigureThemAgain"
        : "",
    };
  }

  configuration(): VoiceConfigurationSnapshot {
    return this.credentials.configuration(this.protocol.providerId);
  }

  refreshCredentials(autoStandby = true): VoiceConfigurationSnapshot {
    const configuration = this.configuration();
    if (!configuration.hasKey && !["idle", "error"].includes(this.state.phase)) {
      this.stop();
    } else if (
      autoStandby &&
      configuration.hasKey &&
      this.state.wakeEnabled &&
      ["idle", "error"].includes(this.state.phase)
    ) {
      void this.enterStandby();
    }
    return configuration;
  }

  configure(value: string): void {
    if (this.closed) throw new Error("@looi:runtimeVoiceClosed");
    this.suppressAutoStandbyPrompt = false;
    const next = this.credentials.setApiKey(this.protocol.providerId, value);
    this.stop();
    this.options.tracer?.registerSecret(next);
    if (this.state.wakeEnabled) void this.enterStandby();
  }

  clearCredentials(): void {
    if (this.closed) throw new Error("@looi:runtimeVoiceClosed");
    this.suppressAutoStandbyPrompt = false;
    this.credentials.clearApiKey(this.protocol.providerId);
    this.stop();
  }

  configureVoiceId(value: string): void {
    if (this.closed) throw new Error("@looi:runtimeVoiceClosed");
    this.credentials.setVoiceId(this.protocol.providerId, value);
  }

  setWakeEnabled(enabled: boolean, options: { autoStandby?: boolean } = {}): void {
    if (this.closed) return;
    if (enabled) this.suppressAutoStandbyPrompt = false;
    this.publish({ wakeEnabled: enabled });
    this.credentials.setWakeEnabled(enabled);
    if (
      enabled &&
      options.autoStandby !== false &&
      this.credentials.resolveApiKey(this.protocol.providerId) &&
      ["idle", "error", "permission"].includes(this.state.phase)
    ) {
      void this.enterStandby();
    }
    if (!enabled) {
      this.stopStandby();
      if (this.state.phase === "error" && !this.state.error) {
        this.publish({ phase: "idle" });
      }
    }
  }

  snapshot(): VoiceState {
    return { ...this.state };
  }

  /**
   * Queues a proactive notice (`WHEN_IDLE`) if a live conversation is active;
   * always persists `notice.contextNote` so subsequent sessions retain the receipt.
   */
  enqueueNotice(notice: VoiceProactiveNotice): void {
    if (this.closed) return;
    if (notice.contextNote) {
      this.latestContextNote = notice.contextNote.trim();
    }
    if (this.session?.sessionPurpose === "conversation") {
      this.session.enqueueNotice(notice);
    } else {
      this.pendingNotices.push(notice);
    }
  }

  /** Updates background context note for future turns or active session instructions. */
  setContextNote(note: string, syncActiveSession = false): void {
    if (this.closed) return;
    this.latestContextNote = note.trim();
    this.session?.updateContextNote(this.latestContextNote, syncActiveSession);
  }

  async enterStandby(options: { preserveError?: string } = {}): Promise<void> {
    if (
      this.closed ||
      !this.credentials.resolveApiKey(this.protocol.providerId) ||
      !this.state.wakeEnabled
    ) {
      return;
    }
    if (this.state.phase === "standby" || this.standbyPreparing !== undefined) return;

    const permission = this.options.audio.status().permission;
    if (permission !== "granted") {
      if (this.suppressAutoStandbyPrompt) {
        return;
      }
      const result =
        ["undetermined", "cancelled"].includes(permission) &&
        this.state.phase !== "permission"
          ? this.options.audio.requestPermission()
          : permission;
      if (result !== "granted") {
        if (result !== "undetermined") {
          this.options.audio.stop();
          this.publish({
            phase: "error",
            error:
              result === "cancelled"
                ? "@looi:runtimeMicrophoneRequestCancelledEnableVoiceWakeupAgain"
                : "@looi:runtimeMicrophoneAccessUnavailableEnableItInSystemSettings",
          });
          return;
        }
        this.publish({ phase: "permission", error: "@looi:runtimeAllowMicrophoneAccess" });
        const generation = ++this.standbyGeneration;
        this.clearStandbyTimer();
        this.standbyTimer = setTimeout(() => {
          if (this.isStandbyGeneration(generation) && this.state.wakeEnabled) {
            void this.enterStandby();
          }
        }, PERMISSION_POLL_MS);
        return;
      }
    }

    const generation = ++this.standbyGeneration;
    this.standbyPreparing = generation;
    try {
      if (this.cueStopTimer) {
        this.clearCueStopTimer();
        this.options.audio.stop();
      }
      const started = await this.options.audio.startWake(this.options.audio.beginWake());
      if (!this.isStandbyGeneration(generation) || !started) return;
      const status = this.options.audio.status();
      if (status.state !== "running" || status.captureMode !== "kws" || !status.kwsReady) {
        throw new Error("");
      }
      this.clearStandbyTimer();
      this.publish({
        phase: "standby",
        muted: false,
        purpose: undefined,
        activeVoiceId: undefined,
        error: options.preserveError ?? "",
      });
      this.pollStandby(generation);
    } catch {
      if (!this.isStandbyGeneration(generation)) return;
      this.options.audio.stop();
      this.publish({ phase: "error", muted: false, error: "" });
    } finally {
      if (this.standbyPreparing === generation) this.standbyPreparing = undefined;
    }
  }

  async start(options: { fromWakeWord?: boolean } = {}): Promise<void> {
    if (this.closed) throw new Error("@looi:runtimeVoiceClosed");
    this.suppressAutoStandbyPrompt = false;
    this.prePreviewTranscript = undefined;
    if (!["idle", "standby", "error", "permission"].includes(this.state.phase)) {
      return;
    }
    const apiKey = this.credentials.resolveApiKey(this.protocol.providerId);
    if (!apiKey) throw new Error("@looi:configureVoiceKey");

    const selectedVoiceId = this.credentials.voiceId;
    const initialLanguage = this.options.defaultLanguage?.() ?? "zh-CN";
    const fromStandby = this.state.phase === "standby";

    ++this.standbyGeneration;
    this.clearStandbyTimer();
    this.clearCueStopTimer();
    if (!fromStandby) this.stop();

    if (this.options.audio.status().permission !== "granted") {
      const permission = this.options.audio.requestPermission();
      if (permission !== "granted") {
        this.publish({
          phase: "permission",
          error: "@looi:runtimeAllowMicrophoneAccessThenTapLiveAgainIf",
        });
        return;
      }
    }

    const session = new LiveVoiceSession({
      apiKey,
      voiceId: selectedVoiceId,
      purpose: "conversation",
      initialLanguage,
      initialContextNote: this.latestContextNote,
      fromWakeWord: options.fromWakeWord === true,
      protocol: this.protocol,
      audio: this.options.audio,
      connect: this.options.connect,
      tracer: this.options.tracer,
      requestTask: this.options.requestTask,
      taskBridge: this.options.taskBridge,
      onConversationActivity: this.options.onConversationActivity,
      controlBody: this.options.controlBody,
      onStatePatch: (patch) => {
        if (this.session === session) this.publish(patch);
      },
      onAudioLevel: this.options.onAudioLevel,
      onSessionComplete: () => {
        if (this.session === session) this.endSession();
      },
      onSessionError: (message) => {
        if (this.session === session) this.fail(message);
      },
    });
    this.session = session;
    await session.open();
    if (this.session === session && !session.isDisposed) {
      for (const notice of this.pendingNotices.splice(0)) session.enqueueNotice(notice);
    }
  }

  async preview(options: { voiceId?: string; sampleText?: string } = {}): Promise<void> {
    if (this.closed) throw new Error("@looi:runtimeVoiceClosed");
    const apiKey = this.credentials.resolveApiKey(this.protocol.providerId);
    if (!apiKey) throw new Error("@looi:configureVoiceKey");

    let targetVoiceId = this.credentials.voiceId;
    if (options.voiceId !== undefined) {
      const candidate = options.voiceId.trim();
      if (candidate && !/^[A-Za-z0-9_-]{1,256}$/.test(candidate)) {
        throw new Error("@looi:runtimeEnterAValidDoubaoSpeakerId");
      }
      targetVoiceId = candidate;
    }

    this.suppressAutoStandbyPrompt = true;
    const savedTranscript =
      this.prePreviewTranscript !== undefined
        ? this.prePreviewTranscript
        : this.state.transcript;
    const initialLanguage = this.options.defaultLanguage?.() ?? "zh-CN";
    ++this.standbyGeneration;
    this.clearStandbyTimer();
    this.clearCueStopTimer();
    this.stop();
    this.prePreviewTranscript = savedTranscript;

    const session = new LiveVoiceSession({
      apiKey,
      voiceId: targetVoiceId,
      purpose: "preview",
      previewText: options.sampleText,
      initialLanguage,
      fromWakeWord: false,
      protocol: this.protocol,
      audio: this.options.audio,
      connect: this.options.connect,
      tracer: this.options.tracer,
      onStatePatch: (patch) => {
        if (this.session === session) this.publish(patch);
      },
      onAudioLevel: this.options.onAudioLevel,
      onSessionComplete: () => {
        if (this.session === session) this.endSession();
      },
      onSessionError: (message) => {
        if (this.session === session) this.fail(message);
      },
    });
    this.session = session;
    await session.open();
  }

  async restartSession(): Promise<void> {
    if (this.closed) throw new Error("@looi:runtimeVoiceClosed");
    this.stop();
    await this.start();
  }

  mute(value: boolean): void {
    this.session?.mute(value);
  }

  interrupt(trigger: "manual" | "server_vad" = "manual"): void {
    this.session?.interrupt(trigger);
  }

  /**
   * Plays a short magnetic attach / detach sound cue, sharing the active KWS/voice output
   * stream when running or opening a temporary output-only stream (no microphone prompt) when idle.
   */
  playDockCue(docked: boolean): void {
    if (
      this.closed ||
      this.state.phase === "speaking" ||
      this.state.phase === "connecting" ||
      this.state.phase === "permission"
    ) {
      return;
    }
    const audioRunning = this.options.audio.status().state === "running";
    if (audioRunning && !this.cueStopTimer) {
      try {
        if (this.options.audio.playDockCue) {
          this.options.audio.playDockCue(docked);
        } else if (docked) {
          this.options.audio.playReadyCue();
        }
      } catch {
        // Ignore transient playback backpressure
      }
      return;
    }

    this.clearCueStopTimer();
    try {
      if (!audioRunning) {
        this.options.audio.start(false);
      }
      if (this.options.audio.playDockCue) {
        this.options.audio.playDockCue(docked);
      } else if (docked) {
        this.options.audio.playReadyCue();
      }
      const timer = setTimeout(() => {
        if (this.cueStopTimer === timer) {
          this.cueStopTimer = undefined;
        }
        if (
          !this.closed &&
          !this.session &&
          this.state.phase !== "standby"
        ) {
          try {
            this.options.audio.stop();
          } catch {}
        }
      }, 420);
      (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
      this.cueStopTimer = timer;
    } catch {
      this.clearCueStopTimer();
      if (!this.session && this.state.phase !== "standby") {
        try {
          this.options.audio.stop();
        } catch {}
      }
    }
  }

  stopIdleCue(): void {
    const hadTimer = Boolean(this.cueStopTimer);
    this.clearCueStopTimer();
    if (hadTimer && !this.session && this.state.phase === "idle") {
      try {
        this.options.audio.stop();
      } catch {}
    }
  }

  endSession(preserveError = ""): void {
    ++this.standbyGeneration;
    this.clearStandbyTimer();
    this.clearCueStopTimer();
    const active = this.session;
    const wasPreview = active?.sessionPurpose === "preview";
    const restoredTranscript =
      wasPreview && this.prePreviewTranscript !== undefined
        ? this.prePreviewTranscript
        : undefined;
    this.prePreviewTranscript = undefined;
    this.session = undefined;
    if (active) {
      this.pendingNotices.push(...active.takePendingNotices());
      active.dispose("graceful");
    } else {
      this.options.audio.clearPlayback();
      this.options.onAudioLevel?.(0);
    }
    if (wasPreview) {
      this.options.audio.stop();
      this.options.onAudioLevel?.(0);
    }
    (this.options.onSessionEnd ?? this.options.cancelTask)?.();
    const canResumeWake =
      this.state.wakeEnabled &&
      !this.closed &&
      (!wasPreview || this.options.audio.status().permission === "granted");
    if (canResumeWake) {
      this.publish({
        purpose: undefined,
        activeVoiceId: undefined,
        ...(restoredTranscript !== undefined ? { transcript: restoredTranscript } : {}),
        ...(preserveError ? { error: preserveError } : {}),
      });
      void this.enterStandby({ preserveError });
    } else {
      this.stop(restoredTranscript);
    }
  }

  /** Cancel pending or active local wake without ending a live conversation. */
  stopStandby(): void {
    if (this.standbyPreparing !== undefined || ["standby", "permission"].includes(this.state.phase)) {
      this.stop();
    }
  }

  stop(restoredTranscriptOverride?: string): void {
    ++this.standbyGeneration;
    this.standbyPreparing = undefined;
    this.clearStandbyTimer();
    this.clearCueStopTimer();
    const active = this.session;
    const restoredTranscript =
      restoredTranscriptOverride !== undefined
        ? restoredTranscriptOverride
        : active?.sessionPurpose === "preview" && this.prePreviewTranscript !== undefined
          ? this.prePreviewTranscript
          : undefined;
    this.prePreviewTranscript = undefined;
    this.session = undefined;
    if (active) {
      this.pendingNotices.push(...active.takePendingNotices());
      active.dispose("immediate");
    }
    this.options.audio.stop();
    this.options.onAudioLevel?.(0);
    (this.options.onSessionEnd ?? this.options.cancelTask)?.();
    this.publish({
      phase: "idle",
      muted: false,
      purpose: undefined,
      activeVoiceId: undefined,
      ...(restoredTranscript !== undefined ? { transcript: restoredTranscript } : {}),
      error: "",
    });
  }

  close(): void {
    this.closed = true;
    this.stop();
  }

  private pollStandby(generation: number): void {
    if (!this.isStandbyGeneration(generation) || this.state.phase !== "standby") {
      return;
    }
    const status = this.options.audio.status();
    if (status.state !== "running" || status.captureMode !== "kws" || !status.kwsReady) {
      this.options.audio.stop();
      this.publish({ phase: "error", muted: false, error: "" });
      return;
    }
    if (status.wakeWord) {
      void this.start({ fromWakeWord: true });
      return;
    }
    this.standbyTimer = setTimeout(() => this.pollStandby(generation), STANDBY_POLL_MS);
  }

  private fail(message: string): void {
    if (
      this.state.wakeEnabled &&
      this.state.phase !== "standby" &&
      this.options.audio.status().state === "running"
    ) {
      this.endSession(message);
      this.publish({ error: message });
      return;
    }
    this.stop();
    this.publish({ phase: "error", error: message });
  }

  private isStandbyGeneration(generation: number): boolean {
    return !this.closed && generation === this.standbyGeneration;
  }

  private clearStandbyTimer(): void {
    if (this.standbyTimer) clearTimeout(this.standbyTimer);
    this.standbyTimer = undefined;
  }

  private clearCueStopTimer(): void {
    if (this.cueStopTimer) clearTimeout(this.cueStopTimer);
    this.cueStopTimer = undefined;
  }

  private publish(patch: Partial<VoiceState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onState(this.snapshot());
  }
}
