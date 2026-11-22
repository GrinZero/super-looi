import { randomUUID } from "node:crypto";
import {
  VoiceCredentialStore,
  type VoiceConfigurationSnapshot,
} from "./credentials.js";
import { LiveVoiceSession } from "./live-session.js";
import { VoiceConversationWindow } from "./conversation-window.js";
import { VoiceHomeReferences } from "./tools/home.js";
import { describeVoiceFailure, nativeAudioFailure } from "./failure.js";
import type { VoiceConversationMessage, VoiceSessionFailure } from "../../../../packages/looi-runtime/src/telemetry/realtime-observer.js";
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
  private protocol: RealtimeProtocolAdapter;
  private state: VoiceState;
  private session?: LiveVoiceSession;
  private latestContextNote = "";
  private pluginContextNote = "";
  private readonly conversationWindow = new VoiceConversationWindow();
  private conversation?: { id: string; messages: VoiceConversationMessage[]; homeReferences: VoiceHomeReferences };
  private readonly pendingNotices: VoiceProactiveNotice[] = [];
  private standbyTimer?: ReturnType<typeof setTimeout>;
  private cueStopTimer?: ReturnType<typeof setTimeout>;
  private broadcastHoldTimer?: ReturnType<typeof setTimeout>;
  private standbyGeneration = 0;
  private standbyPreparing?: number;
  private suppressAutoStandbyPrompt = false;
  private sessionOpenedForBroadcast = false;
  private pluginListening?: { session: LiveVoiceSession; deadlineMs: number };
  private prePreviewTranscript?: string;
  private closed = false;

  constructor(private readonly options: VoiceRuntimeOptions) {
    this.pluginContextNote = (options.initialPluginContext?.() ?? "").trim();
    this.credentials = new VoiceCredentialStore(options.vault);
    this.protocol =
      options.protocol ??
      createVoiceProtocol({
        providerId: this.credentials.selectedProviderId || process.env.VOICE_PROVIDER,
        baseUrl: process.env.VOICE_BASE_URL,
        model: process.env.VOICE_MODEL,
      });
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

  selectProvider(providerId: string): VoiceConfigurationSnapshot {
    if (this.closed) throw new Error("@looi:runtimeVoiceClosed");
    this.suppressAutoStandbyPrompt = false;
    this.protocol = createVoiceProtocol({
      providerId,
      baseUrl: process.env.VOICE_BASE_URL,
      model: process.env.VOICE_MODEL,
    });
    this.credentials.setProviderId(this.protocol.providerId);
    this.publish({ wakeNeedsConfiguration: false });
    this.stop();
    if (
      this.state.wakeEnabled &&
      this.credentials.resolveApiKey(this.protocol.providerId)
    ) {
      void this.enterStandby();
    }
    return this.configuration();
  }

  refreshCredentials(autoStandby = true, modelProviderId?: string): VoiceConfigurationSnapshot {
    if (this.state.wakeNeedsConfiguration && modelProviderId === this.protocol.providerId &&
        this.credentials.usesModelApiKey(modelProviderId)) {
      this.publish({ wakeNeedsConfiguration: false });
      this.stop();
    }
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
    this.publish({ wakeNeedsConfiguration: false });
    this.stop();
    this.options.tracer?.registerSecret(next);
    if (this.state.wakeEnabled) void this.enterStandby();
  }

  clearCredentials(): void {
    if (this.closed) throw new Error("@looi:runtimeVoiceClosed");
    this.suppressAutoStandbyPrompt = false;
    this.credentials.clearApiKey(this.protocol.providerId);
    this.publish({ wakeNeedsConfiguration: false });
    this.stop();
  }

  configureVoiceId(value: string): void {
    if (this.closed) throw new Error("@looi:runtimeVoiceClosed");
    this.credentials.setVoiceId(this.protocol.providerId, value);
    if (this.state.wakeNeedsConfiguration) {
      this.publish({ wakeNeedsConfiguration: false });
      void this.enterStandby();
    }
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
    if (this.closed) {
      this.settleNotice(notice, "runtime_closed");
      return;
    }
    if (notice.contextNote) {
      this.latestContextNote = notice.contextNote.trim();
    }
    if (this.session?.sessionPurpose === "conversation") {
      this.session.enqueueNotice(notice);
    } else {
      this.pushPendingNotice(notice);
    }
  }

  /** Updates background context note for future turns or active session instructions. */
  setContextNote(note: string, syncActiveSession = false): void {
    if (this.closed) return;
    this.latestContextNote = note.trim();
    this.session?.updateContextNote(this.latestContextNote, syncActiveSession);
  }

  /** Updates ambient plugin persona and context slices independently from task receipts. */
  setPluginContext(note: string, syncActiveSession = true): void {
    if (this.closed) return;
    this.pluginContextNote = note.trim();
    if (this.session?.sessionPurpose === "conversation") {
      this.session.updatePluginContext(this.pluginContextNote, syncActiveSession);
    }
  }

  /** Refreshes plugin-contributed voice tools on an active conversation session. */
  refreshPluginVoiceTools(): void {
    if (this.closed) return;
    if (this.session?.sessionPurpose === "conversation") {
      this.session.updatePluginVoiceTools(this.options.pluginVoiceTools?.() ?? [], true);
    }
  }

  /** Temporarily enables capture on a session opened for plugin broadcasts. */
  async listenUntil(deadlineMs: number, signal: AbortSignal): Promise<void> {
    if (
      this.closed ||
      signal.aborted ||
      this.options.audio.status().permission !== "granted" ||
      !this.credentials.resolveApiKey(this.protocol.providerId) ||
      this.session?.sessionPurpose === "preview"
    ) {
      return;
    }

    // Keep an existing user session and its microphone setting.
    const current = this.session;
    if (current && !current.isDisposed && !this.sessionOpenedForBroadcast) {
      if (!current.isMuted) current.holdIdleFor(deadlineMs - Date.now());
      return;
    }
    const opening = !current || current.isDisposed ? this.start({ initialMuted: true }) : undefined;
    const active = this.session;
    if (active && this.sessionOpenedForBroadcast) {
      this.clearBroadcastHoldTimer();
      const listening = { session: active, deadlineMs };
      this.pluginListening = listening;
      active.mute(false);
      active.holdIdleFor(deadlineMs - Date.now());
      signal.addEventListener("abort", () => {
        if (this.pluginListening !== listening) return;
        this.pluginListening = undefined;
        if (this.session === active && !active.isDisposed && this.sessionOpenedForBroadcast) {
          active.mute(true);
          this.scheduleBroadcastStandby(active, 20_000);
        }
      }, { once: true });
    }
    await opening;
  }

  /**
   * Speaks proactive plugin text with playback-completion synchronization.
   * Resolves `{ completed: true }` only when hardware audio playback drains,
   * or `{ completed: false, interruptedReason }` if interrupted, closed, or inactive.
   */
  async speak(options: {
    spokenText: string;
    contextNote?: string;
    delivery?: "when_idle" | "interrupt";
    capturePolicy?: "inherit" | "duplex" | "muted_broadcast";
    verbatim?: boolean;
    respectQuietHours?: boolean;
    holdAliveMs?: number;
    closeToStandbyOnComplete?: boolean;
    signal?: AbortSignal;
  }): Promise<{ readonly completed: boolean; readonly interruptedReason?: string }> {
    const text = options.spokenText.trim();
    const signal = options.signal;
    const cancelled = { completed: false, interruptedReason: "speech_cancelled" } as const;
    if (signal?.aborted) return cancelled;
    if (this.closed) {
      return { completed: false, interruptedReason: "voice_closed" };
    }
    if (!text) {
      return { completed: false, interruptedReason: "empty_speech" };
    }
    if (options.contextNote) {
      this.setContextNote(options.contextNote, true);
    }
    if (options.respectQuietHours && this.options.isQuietHoursNow?.()) {
      if (this.state.phase !== "speaking") {
        this.options.audio.clearPlayback();
      }
      return { completed: false, interruptedReason: "quiet_hours_suppressed" };
    }
    this.clearBroadcastHoldTimer();

    const mutedBroadcast = options.capturePolicy === "muted_broadcast";
    if (!this.session || this.session.sessionPurpose !== "conversation" || this.session.isDisposed) {
      if (!this.credentials.resolveApiKey(this.protocol.providerId)) {
        return { completed: false, interruptedReason: "voice_provider_unconfigured" };
      }
      if (this.options.audio.status().permission !== "granted") {
        return { completed: false, interruptedReason: "microphone_permission_required" };
      }
      if (this.session?.sessionPurpose === "preview") {
        this.stop();
      }
      if (["idle", "standby", "error", "permission"].includes(this.state.phase)) {
        try {
          await this.start({ initialMuted: mutedBroadcast });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return {
            completed: false,
            interruptedReason: detail ? `session_start_failed:${detail}` : "session_start_failed",
          };
        }
      }
    }

    const active = this.session;
    if (signal?.aborted) return cancelled;
    if (!active || active.sessionPurpose !== "conversation" || active.isDisposed) {
      const reason =
        this.state.error ||
        (this.state.phase === "permission"
          ? "microphone_permission_required"
          : "session_inactive");
      return { completed: false, interruptedReason: reason };
    }
    if (options.respectQuietHours && this.options.isQuietHoursNow?.()) {
      if (this.state.phase !== "speaking") {
        this.options.audio.clearPlayback();
      }
      if (mutedBroadcast && this.sessionOpenedForBroadcast) {
        this.scheduleBroadcastStandby(active, 600);
      }
      return { completed: false, interruptedReason: "quiet_hours_suppressed" };
    }

    const previousMuted = active.isMuted;
    const listeningDuringBroadcast = this.pluginListening?.session === active;
    if (mutedBroadcast && !previousMuted) {
      active.mute(true);
    } else if (options.capturePolicy === "duplex" && previousMuted) {
      this.sessionOpenedForBroadcast = false;
      active.mute(false);
    }

    return new Promise((resolve) => {
      const cancel = () => active.cancelNotice(notice);
      const notice: VoiceProactiveNotice = {
        id: `plugin_speak_${randomUUID()}`,
        spokenText: text,
        contextNote: options.contextNote,
        delivery: options.delivery ?? "when_idle",
        verbatim: options.verbatim,
        respectQuietHours: options.respectQuietHours,
        onResult: (result) => {
          signal?.removeEventListener("abort", cancel);
          if (mutedBroadcast && this.session === active && !active.isDisposed) {
            const listening = this.pluginListening;
            if (listeningDuringBroadcast || listening?.session === active) {
              if (listening?.session === active) {
                active.mute(false);
                active.holdIdleFor(listening.deadlineMs - Date.now());
              }
            } else if (options.closeToStandbyOnComplete) {
              this.scheduleBroadcastStandby(active, 600);
            } else if (this.sessionOpenedForBroadcast) {
              this.scheduleBroadcastStandby(active, Math.max(1_000, options.holdAliveMs ?? 15_000));
            } else if (!previousMuted) {
              active.mute(false);
            }
          }
          resolve(result);
        },
      };
      if (signal?.aborted) {
        notice.onResult?.(cancelled);
      } else {
        signal?.addEventListener("abort", cancel, { once: true });
        active.enqueueNotice(notice);
      }
    });
  }

  async enterStandby(): Promise<void> {
    if (
      this.closed ||
      this.options.canAutoStandby?.() === false ||
      this.state.wakeNeedsConfiguration ||
      !this.credentials.resolveApiKey(this.protocol.providerId) ||
      !this.state.wakeEnabled
    ) {
      return;
    }
    if (this.state.phase === "standby" || this.standbyPreparing !== undefined) return;

    const initial = this.options.audio.status();
    if (initial.errorCode === "AUDIOFOCUS_LOSS") {
      this.failWake("wake.focus", nativeAudioFailure(initial));
      return;
    }
    const permission = initial.permission;
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

    if (initial.wakeFocus === "waiting") {
      this.waitForAudioFocus();
      return;
    }

    const generation = ++this.standbyGeneration;
    this.standbyPreparing = generation;
    try {
      if (this.cueStopTimer) {
        this.clearCueStopTimer();
        this.options.audio.stop();
      }
      const resumeFocus = initial.wakeFocus === "ready";
      const started = await this.options.audio.startWake(this.options.audio.beginWake(), resumeFocus);
      if (!this.isStandbyGeneration(generation)) return;
      const status = this.options.audio.status();
      if (!started) {
        if (status.wakeFocus) this.waitForAudioFocus();
        else if (resumeFocus) this.failWake("wake.focus", nativeAudioFailure(status));
        return;
      }
      if (status.wakeFocus) {
        this.failWake("wake.capture", nativeAudioFailure(status), true);
        this.waitForAudioFocus();
        return;
      }
      if (status.state !== "running" || status.captureMode !== "kws" || !status.kwsReady) {
        throw nativeAudioFailure(status);
      }
      this.clearStandbyTimer();
      this.standbyPreparing = undefined;
      this.publish({
        phase: "standby",
        muted: false,
        purpose: undefined,
        activeVoiceId: undefined,
        error: "",
      });
      this.pollStandby(generation);
    } catch (error) {
      if (!this.isStandbyGeneration(generation)) return;
      const status = this.options.audio.status();
      const detail = error instanceof Error ? error.message : String(error);
      const cause = status.errorCode && status.error && detail.includes(status.error)
        ? nativeAudioFailure(status)
        : error;
      this.failWake("wake.start", cause);
    } finally {
      if (this.standbyPreparing === generation) this.standbyPreparing = undefined;
    }
  }

  async start(options: { fromWakeWord?: boolean; initialMuted?: boolean } = {}): Promise<void> {
    if (this.closed) throw new Error("@looi:runtimeVoiceClosed");
    this.clearBroadcastHoldTimer();
    this.suppressAutoStandbyPrompt = false;
    this.prePreviewTranscript = undefined;
    const broadcastHold = options.initialMuted === true;
    if (!broadcastHold) {
      this.sessionOpenedForBroadcast = false;
      this.pluginListening = undefined;
      if (
        this.session &&
        this.session.sessionPurpose === "conversation" &&
        !this.session.isDisposed &&
        this.session.isMuted
      ) {
        this.session.mute(false);
      }
    }
    if (!["idle", "standby", "error", "permission"].includes(this.state.phase)) {
      return;
    }
    const apiKey = this.credentials.resolveApiKey(this.protocol.providerId);
    if (!apiKey) throw new Error("@looi:configureVoiceKey");

    const selectedVoiceId = this.credentials.voiceIdFor(this.protocol.providerId);
    const initialLanguage = this.options.defaultLanguage?.() ?? "zh-CN";
    const fromStandby = this.state.phase === "standby";

    ++this.standbyGeneration;
    this.clearStandbyTimer();
    this.clearCueStopTimer();
    if (!fromStandby) this.stop();
    this.sessionOpenedForBroadcast = broadcastHold;

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

    const conversationId = this.options.conversationId?.() ?? this.conversationWindow.current();
    if (this.conversation?.id !== conversationId) {
      if (this.conversation) this.latestContextNote = "";
      this.conversation = { id: conversationId, messages: [], homeReferences: new VoiceHomeReferences() };
    }
    const history = [...this.conversation.messages];
    const home = this.options.home?.();
    const schedule = this.options.schedule?.();
    const session = new LiveVoiceSession({
      apiKey,
      voiceId: selectedVoiceId,
      purpose: "conversation",
      initialLanguage,
      initialContextNote: this.latestContextNote,
      initialPluginContext: this.options.initialPluginContext
        ? this.options.initialPluginContext()
        : this.pluginContextNote,
      pluginVoiceTools: this.options.pluginVoiceTools?.(),
      evaluateVoiceToolCall: this.options.evaluateVoiceToolCall,
      evaluateVoiceUserTurn: this.options.evaluateVoiceUserTurn,
      assembleVoiceTurn: this.options.assembleVoiceTurn,
      sessionId: conversationId,
      history,
      onConversation: (messages) => {
        if (this.conversation?.id !== conversationId) return;
        const retained = [...history, ...messages].slice(-80);
        let chars = retained.reduce((total, message) => total + message.content.length, 0);
        while (chars > 24_000 && retained.length > 1) chars -= retained.shift()!.content.length;
        this.conversation.messages = retained;
      },
      fromWakeWord: options.fromWakeWord === true,
      initialMuted: broadcastHold,
      protocol: this.protocol,
      audio: this.options.audio,
      connect: this.options.connect,
      tracer: this.options.tracer,
      requestTask: this.options.requestTask,
      taskBridge: this.options.taskBridge,
      home: home ? { runtime: home, references: this.conversation.homeReferences } : undefined,
      schedule,
      isQuietHoursNow: this.options.isQuietHoursNow,
      onConversationActivity: () => {
        this.conversationWindow.touch();
        this.options.onConversationActivity?.();
      },
      controlBody: this.options.controlBody,
      stopVoiceMotion: this.options.stopVoiceMotion,
      redactSecrets: this.options.redactSecrets,
      onStatePatch: (patch) => {
        if (this.session === session) {
          this.publish(patch.phase === "listening" ? { ...patch, wakeNeedsConfiguration: false } : patch);
        }
      },
      onAudioLevel: this.options.onAudioLevel,
      onSessionComplete: () => {
        if (this.session === session) this.endSession();
      },
      onSessionError: (message, failure) => {
        if (this.session === session) this.fail(message, failure);
      },
    });
    this.session = session;
    await session.open();
    if (this.session === session && !session.isDisposed) {
      for (const notice of this.pendingNotices.splice(0)) {
        if (notice.contextNote) {
          this.latestContextNote = notice.contextNote.trim();
          session.updateContextNote(this.latestContextNote, true);
        }
        if (notice.respectQuietHours && this.options.isQuietHoursNow?.()) {
          if (this.state.phase !== "speaking") {
            this.options.audio.clearPlayback();
          }
          this.settleNotice(notice, "quiet_hours_suppressed");
          continue;
        }
        session.enqueueNotice(notice);
      }
    }
  }

  async preview(options: { voiceId?: string; sampleText?: string } = {}): Promise<void> {
    if (this.closed) throw new Error("@looi:runtimeVoiceClosed");
    const apiKey = this.credentials.resolveApiKey(this.protocol.providerId);
    if (!apiKey) throw new Error("@looi:configureVoiceKey");

    let targetVoiceId = this.credentials.voiceIdFor(this.protocol.providerId);
    if (options.voiceId !== undefined) {
      const candidate = options.voiceId.trim();
      if (candidate && !/^[A-Za-z0-9_-]{1,256}$/.test(candidate)) {
        throw new Error("@looi:runtimeEnterAValidDoubaoSpeakerId");
      }
      targetVoiceId =
        candidate || this.credentials.voiceIdFor(this.protocol.providerId);
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
    this.stop(undefined, "", true);
    this.prePreviewTranscript = savedTranscript;

    const session = new LiveVoiceSession({
      apiKey,
      voiceId: targetVoiceId,
      purpose: "preview",
      previewInput: this.options.previewInput,
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
      onSessionError: (message, failure) => {
        if (this.session === session) this.fail(message, failure);
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
    if (this.sessionOpenedForBroadcast) {
      this.clearBroadcastHoldTimer();
      this.sessionOpenedForBroadcast = false;
      this.pluginListening = undefined;
    }
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
    this.clearBroadcastHoldTimer();
    this.sessionOpenedForBroadcast = false;
    this.pluginListening = undefined;
    const active = this.session;
    const wasPreview = active?.sessionPurpose === "preview";
    const restoredTranscript =
      wasPreview && this.prePreviewTranscript !== undefined
        ? this.prePreviewTranscript
        : undefined;
    this.prePreviewTranscript = undefined;
    this.session = undefined;
    if (active) {
      for (const pending of active.takePendingNotices()) {
        if (pending.onResult) {
          this.settleNotice(pending, "session_ended");
        } else {
          this.pushPendingNotice(pending);
        }
      }
      active.dispose(preserveError ? "immediate" : "graceful");
    } else {
      this.options.audio.clearPlayback();
      this.options.onAudioLevel?.(0);
    }
    if (wasPreview) {
      if (!this.options.audio.status().wakeFocus) this.options.audio.stop();
      this.options.onAudioLevel?.(0);
    }
    (this.options.onSessionEnd ?? this.options.cancelTask)?.();
    const canResumeWake =
      this.state.wakeEnabled &&
      !this.closed &&
      this.options.canAutoStandby?.() !== false &&
      (!wasPreview || this.options.audio.status().permission === "granted");
    if (canResumeWake) {
      this.publish({
        phase: preserveError ? "error" : "idle",
        muted: false,
        purpose: undefined,
        activeVoiceId: undefined,
        ...(restoredTranscript !== undefined ? { transcript: restoredTranscript } : {}),
        ...(preserveError ? { error: preserveError } : {}),
      });
      void this.enterStandby();
    } else {
      this.stop(restoredTranscript, preserveError);
    }
  }

  /** Cancel pending or active local wake without ending a live conversation. */
  stopStandby(): void {
    if (this.standbyPreparing !== undefined || this.standbyTimer !== undefined ||
        ["standby", "permission"].includes(this.state.phase)) {
      this.stop();
    }
  }

  stop(restoredTranscriptOverride?: string, error = "", preparingPreview = false): void {
    ++this.standbyGeneration;
    this.standbyPreparing = undefined;
    this.clearStandbyTimer();
    this.clearCueStopTimer();
    this.clearBroadcastHoldTimer();
    this.sessionOpenedForBroadcast = false;
    this.pluginListening = undefined;
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
      for (const pending of active.takePendingNotices()) {
        if (pending.onResult) {
          this.settleNotice(pending, "session_stopped");
        } else {
          this.pushPendingNotice(pending);
        }
      }
      active.dispose("immediate");
    }
    this.options.audio.stop();
    this.options.onAudioLevel?.(0);
    (this.options.onSessionEnd ?? this.options.cancelTask)?.();
    this.publish({
      phase: error ? "error" : preparingPreview ? "connecting" : "idle",
      muted: false,
      purpose: preparingPreview ? "preview" : undefined,
      activeVoiceId: undefined,
      ...(restoredTranscript !== undefined ? { transcript: restoredTranscript } : {}),
      error: error || (this.state.wakeNeedsConfiguration && !preparingPreview ? this.state.error : ""),
    });
  }

  close(): void {
    this.closed = true;
    this.stop();
    for (const pending of this.pendingNotices.splice(0)) {
      this.settleNotice(pending, "runtime_closed");
    }
  }

  private settleNotice(notice: VoiceProactiveNotice, reason: string): void {
    try {
      notice.onResult?.({ completed: false, interruptedReason: reason });
    } catch {
      // Isolate notice settlement listener errors from VoiceRuntime teardown.
    }
  }

  private pushPendingNotice(notice: VoiceProactiveNotice): void {
    while (this.pendingNotices.length >= 16) {
      const evicted = this.pendingNotices.shift();
      if (evicted) this.settleNotice(evicted, "queue_overflow");
    }
    this.pendingNotices.push(notice);
  }

  private pollStandby(generation: number): void {
    if (!this.isStandbyGeneration(generation) || this.state.phase !== "standby") {
      return;
    }
    const status = this.options.audio.status();
    if (status.state !== "running" || status.captureMode !== "kws" || !status.kwsReady) {
      if (status.errorCode === "ACTIVITY_PAUSED") {
        this.stop();
        return;
      }
      this.failWake("wake.capture", nativeAudioFailure(status), Boolean(status.wakeFocus));
      if (status.wakeFocus) void this.enterStandby();
      return;
    }
    if (status.wakeWord) {
      void this.start({ fromWakeWord: true });
      return;
    }
    this.standbyTimer = setTimeout(() => this.pollStandby(generation), STANDBY_POLL_MS);
  }

  private waitForAudioFocus(): void {
    const generation = ++this.standbyGeneration;
    this.clearStandbyTimer();
    this.standbyTimer = setTimeout(() => {
      if (!this.isStandbyGeneration(generation) || !this.state.wakeEnabled ||
          this.options.canAutoStandby?.() === false) return;
      const status = this.options.audio.status();
      if (status.wakeFocus) void this.enterStandby();
      else if (status.errorCode === "ACTIVITY_PAUSED") this.stop();
      else this.failWake("wake.focus", nativeAudioFailure(status));
    }, PERMISSION_POLL_MS);
  }

  private failWake(stage: string, error: unknown, recovering = false): void {
    const secret = this.credentials.resolveApiKey(this.protocol.providerId);
    const failure = describeVoiceFailure(stage, error, secret);
    this.options.tracer?.start("voice.wake", "span", { traceId: "", traceName: "voice.wake" }).end({
      "langfuse.observation.level": "ERROR",
      "langfuse.observation.status_message": failure.message,
      "langfuse.observation.metadata.failureStage": failure.stage,
      ...(failure.code ? { "langfuse.observation.metadata.errorCode": failure.code } : {}),
    });
    const message = `@looi:runtimeWakeStageFailed|${JSON.stringify({ stage, detail: failure.message })}`;
    if (!recovering) this.options.audio.stop();
    this.publish({ phase: "error", muted: false, error: message });
  }

  private fail(message: string, failure?: VoiceSessionFailure): void {
    const status = this.options.audio.status();
    const code = failure?.code;
    const audioCode = status.errorCode || (failure?.stage.startsWith("audio.") ? code : undefined);
    if (audioCode === "ACTIVITY_PAUSED") {
      this.stop();
      return;
    }
    const configurationRejected = code === "invalid_api_key" || code === "authentication_error" ||
      code === "401" || code === "403" ||
      (!code && failure?.stage === "provider.error" && this.state.phase === "connecting");
    if (configurationRejected) this.publish({ wakeNeedsConfiguration: true });
    if (audioCode === "AUDIOFOCUS_LOSS" || configurationRejected ||
        (status.permission !== "granted" && !status.wakeFocus)) {
      this.stop(undefined, message);
      return;
    }
    this.endSession(message);
  }

  private isStandbyGeneration(generation: number): boolean {
    return !this.closed && generation === this.standbyGeneration;
  }

  private scheduleBroadcastStandby(active: LiveVoiceSession, delayMs: number): void {
    this.clearBroadcastHoldTimer();
    active.holdIdleFor(delayMs + 500);
    const timer = setTimeout(() => {
      if (this.broadcastHoldTimer === timer) {
        this.broadcastHoldTimer = undefined;
      }
      if (!this.closed && this.session === active && !active.isDisposed) {
        this.sessionOpenedForBroadcast = false;
        this.endSession();
      }
    }, delayMs);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    this.broadcastHoldTimer = timer;
  }

  private clearBroadcastHoldTimer(): void {
    if (this.broadcastHoldTimer) clearTimeout(this.broadcastHoldTimer);
    this.broadcastHoldTimer = undefined;
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
