import type {
  Dispose,
  EffectScope,
  LanRoomSession,
  PluginContext,
  PluginDefinition,
  PluginFailure,
  PluginRuntime,
  PluginStagePresentation,
  PluginStorage,
  PluginVoiceTool,
} from "../../../runtime/plugins/contracts.js";
import {
  PERSON_TRACKER_SERVICE_ID,
  type PersonTrackerService,
} from "../../vision-person-tracker/contracts.js";
import {
  WEREWOLF_PHASE_LABELS,
  WEREWOLF_PLUGIN_ID,
  type WerewolfAiMvpReview,
  type WerewolfCommand,
  type WerewolfLanStatus,
  type WerewolfMatchRecord,
  type WerewolfReplaySource,
  type WerewolfPhase,
  type WerewolfPresetId,
  type WerewolfPublicState,
  type WerewolfRole,
  type WerewolfRulesConfig,
} from "../contracts.js";
import { werewolfJudgeManifest } from "../manifest.js";
import {
  WerewolfChoreographer,
  defaultAbortableSleep,
  resolveStagePresentation,
} from "./choreography.js";
import {
  WerewolfEngine,
  WerewolfRuleError,
  type EngineTransitionOutcome,
  type WerewolfMatchCheckpointV1,
} from "./engine.js";
import {
  LanCompanionController,
  type CompanionSeatActionPayload,
} from "./lan-companion.js";
import { buildPresetRules, type RandomIntFn } from "./presets.js";
import { JudgeSpeechCoordinator } from "./speech-coordinator.js";

const STORAGE_RULES_KEY = "rules_v1";
const STORAGE_MATCH_CHECKPOINT_KEY = "match_checkpoint_v1";
const STORAGE_MATCH_HISTORY_KEY = "match_history_v1";

type MatchHistoryState = Pick<WerewolfPublicState, "matchHistory" | "matchHistoryLoadError">;

interface MatchHistory {
  readonly records: readonly WerewolfMatchRecord[];
  readonly state: MatchHistoryState;
}

function projectMatchHistory(
  records: readonly WerewolfMatchRecord[],
  error: PluginFailure | null = null,
): MatchHistory {
  return {
    records,
    state: {
      matchHistory: records.map(({ replay: _replay, ...summary }) => summary),
      matchHistoryLoadError: error,
    },
  };
}

function readMatchHistory(storage: PluginStorage): MatchHistory {
  try {
    return projectMatchHistory(storage.get<readonly WerewolfMatchRecord[]>(STORAGE_MATCH_HISTORY_KEY) ?? []);
  } catch (error) {
    return projectMatchHistory([], toPluginFailure(error, "history.read", "ERR_WEREWOLF_HISTORY_READ"));
  }
}

type ReadReplayCommand = Extract<WerewolfCommand, { type: "read_match_replay" }>;
type MatchCommand = Exclude<WerewolfCommand, ReadReplayCommand>;

interface TerminalMatch {
  readonly record: WerewolfMatchRecord;
  readonly battleReport: string;
}

function isMatchActivePhase(phase: WerewolfPhase): boolean {
  return phase !== "idle" && phase !== "lobby" && phase !== "game_over";
}

function shouldCloseVoiceToStandby(phase: WerewolfPhase): boolean {
  return (
    phase === "dawn_announce" ||
    phase === "sheriff_election" ||
    phase === "leave_resolution" ||
    phase === "day_discussion" ||
    phase === "day_voting" ||
    phase === "day_pk_speech" ||
    phase === "day_pk_voting" ||
    phase === "game_over"
  );
}

function shouldRunSpeakerClock(
  phase: WerewolfPhase,
  sheriffSubphase: WerewolfPublicState["sheriffSubphase"],
): boolean {
  return (
    phase === "day_discussion" ||
    phase === "day_pk_speech" ||
    (phase === "sheriff_election" &&
      (sheriffSubphase === "speech" || sheriffSubphase === "pk_speech"))
  );
}

export interface WerewolfJudgePluginOptions {
  readonly randomInt?: RandomIntFn;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly nightIntroDelayMs?: number;
  readonly speakerTickMs?: number;
  readonly fixedRolesBySeat?: Readonly<Record<number, WerewolfRole>>;
  readonly autoAdvanceNightIntro?: boolean;
  readonly onTimingMaskScheduled?: (info: {
    readonly role: "guard" | "witch" | "seer";
    readonly plannedDelayMs: number;
  }) => void;
  readonly onDecoySweepExecuted?: (info: {
    readonly pulses: ReadonlyArray<{
      readonly speed: 0;
      readonly turn: number;
      readonly durationMs: number;
    }>;
  }) => void;
}

function readStoredRules(storage: PluginStorage): WerewolfRulesConfig {
  const saved = storage.get<Partial<WerewolfRulesConfig>>(STORAGE_RULES_KEY);
  const base = buildPresetRules("9p_standard");
  if (!saved || typeof saved !== "object") {
    return base;
  }
  const presetId = saved.presetId;
  if (
    presetId === "6p_joy" ||
    presetId === "9p_standard" ||
    presetId === "12p_guard" ||
    presetId === "12p_idiot"
  ) {
    const presetBase = buildPresetRules(presetId, {
      surfaceMode: saved.surfaceMode === "lan_companion" ? "lan_companion" : "on_device",
      motionMode: saved.motionMode === "stationary_gaze" ? "stationary_gaze" : "embodied_patrol",
    });
    return {
      ...presetBase,
      hasSheriff: typeof saved.hasSheriff === "boolean" ? saved.hasSheriff : presetBase.hasSheriff,
      sameGuardSameSaveDies:
        typeof saved.sameGuardSameSaveDies === "boolean"
          ? saved.sameGuardSameSaveDies
          : presetBase.sameGuardSameSaveDies,
      witchSelfSaveMode:
        saved.witchSelfSaveMode === "first_night_only" ||
        saved.witchSelfSaveMode === "never" ||
        saved.witchSelfSaveMode === "any_night"
          ? saved.witchSelfSaveMode
          : presetBase.witchSelfSaveMode,
      speechSeconds:
        typeof saved.speechSeconds === "number" &&
        saved.speechSeconds >= 15 &&
        saved.speechSeconds <= 300
          ? saved.speechSeconds
          : presetBase.speechSeconds,
    };
  }
  return base;
}

function toPluginFailure(
  error: unknown,
  defaultStage: string,
  defaultCode = "ERR_WEREWOLF_RUNTIME",
): PluginFailure {
  if (error instanceof WerewolfRuleError) {
    return {
      stage: error.stage,
      code: error.code,
      reason: error.reason,
    };
  }
  if (error && typeof error === "object") {
    const rec = error as { stage?: unknown; code?: unknown; reason?: unknown; message?: unknown };
    const stage = typeof rec.stage === "string" && rec.stage ? rec.stage : defaultStage;
    const code =
      typeof rec.code === "string" || typeof rec.code === "number"
        ? rec.code
        : defaultCode;
    const reason =
      typeof rec.reason === "string" && rec.reason
        ? rec.reason
        : typeof rec.message === "string" && rec.message
          ? rec.message
          : String(error);
    return { stage, code, reason };
  }
  return {
    stage: defaultStage,
    code: defaultCode,
    reason: String(error),
  };
}

function rethrowWithStage(error: unknown, defaultStage: string, defaultCode?: string): never {
  if (error instanceof WerewolfRuleError) {
    throw error;
  }
  const failure = toPluginFailure(error, defaultStage, defaultCode);
  throw Object.assign(
    error instanceof Error
      ? error
      : new Error(`[stage=${failure.stage} code=${String(failure.code)}] ${failure.reason}`),
    {
      stage: failure.stage,
      code: failure.code,
      reason: failure.reason,
    },
  );
}

function isNoiseOnlyUtterance(text: string): boolean {
  const stripped = text.replace(/[\s,.!?;:，。！？；：、…~～\-—'"“”‘’()（）]/g, "");
  return stripped.length <= 3;
}

export function werewolfJudgeDefinition(
  options: WerewolfJudgePluginOptions = {},
): PluginDefinition<WerewolfPublicState, WerewolfCommand> {
  return {
    manifest: werewolfJudgeManifest,
    initialState: (storage) => {
      const rules = readStoredRules(storage);
      const bootstrapEngine = new WerewolfEngine({
        initialRules: rules,
        randomInt: options.randomInt,
        now: options.now,
      });
      const savedCheckpoint = storage.get<WerewolfMatchCheckpointV1 | undefined>(
        STORAGE_MATCH_CHECKPOINT_KEY,
      );
      let restoredPaused = false;
      let restoredClaims: number[] = [];
      let mutedByHost = false;
      if (savedCheckpoint && !savedCheckpoint.completedMatch) {
        const result = bootstrapEngine.restoreCheckpoint(savedCheckpoint);
        if (result.restored) {
          restoredPaused = true;
          restoredClaims = result.lanSeatTokens.map(([seat]) => seat).sort((a, b) => a - b);
          mutedByHost = result.mutedByHost;
        }
      }
      const bootstrapState = bootstrapEngine.projectPublicState({
        dealingFaceAligned: false,
        previewSessionId: null,
        visionAvailable: false,
        lan: {
          active: false,
          baseUrl: null,
          lanIpv4: null,
          port: null,
          claimedSeats: restoredClaims,
          error: null,
        },
        hostPaused: restoredPaused,
        hasResumableMatch: isMatchActivePhase(bootstrapEngine.getPhase()),
      });
      return {
        ...bootstrapState,
        ...readMatchHistory(storage).state,
        matchHistoryVersion: 0,
        voiceStatus: {
          ...bootstrapState.voiceStatus,
          mutedByHost,
          lastSpokenText: bootstrapState.lastJudgeSpeech || null,
        },
      };
    },
    create: (ctx) => new WerewolfJudgePluginRuntime(ctx, options),
  };
}

export class WerewolfJudgePluginRuntime
  implements PluginRuntime<WerewolfCommand, WerewolfPublicState | WerewolfMatchRecord>
{
  private readonly engine: WerewolfEngine;
  private readonly choreographer: WerewolfChoreographer;
  private readonly lanCompanion: LanCompanionController;
  private readonly speechCoordinator: JudgeSpeechCoordinator;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly nightIntroDelayMs: number;
  private readonly speakerTickMs: number;

  private personTracker: PersonTrackerService | null = null;
  private dealingTrackScope: EffectScope | null = null;
  private previewSessionId: string | null = null;
  private dealingFaceAligned = false;

  private matchStageScope: EffectScope | null = null;
  private stagePresentationDispose: Dispose | null = null;
  private lastPresentationJson = "";

  private nightScope: EffectScope | null = null;
  private nightTaskAbort: AbortController | null = null;

  private dayContextScope: EffectScope | null = null;
  private dayContextDispose: Dispose | null = null;

  private lanScope: EffectScope | null = null;
  private lanSession: LanRoomSession | null = null;
  private lanError: string | null = null;
  private lastLanPort: number | undefined = undefined;

  private speakerInterval: ReturnType<typeof setInterval> | null = null;
  private hostPaused = false;
  private appForegroundActive = true;
  private readonly pendingMvpReviews = new Map<string, symbol>();
  private history: MatchHistory;
  private matchHistoryVersion = 0;
  private terminalMatch: TerminalMatch | null = null;
  private terminalCheckpoint: WerewolfMatchCheckpointV1 | null = null;
  private archivedMatchId: string | null = null;
  private opQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly ctx: PluginContext<WerewolfPublicState>,
    private readonly options: WerewolfJudgePluginOptions = {},
  ) {
    const initialRules = readStoredRules(ctx.storage);
    this.history = readMatchHistory(ctx.storage);
    this.sleep = options.sleep ?? defaultAbortableSleep;
    this.nightIntroDelayMs = options.nightIntroDelayMs ?? 1200;
    this.speakerTickMs = options.speakerTickMs ?? 1000;

    this.engine = new WerewolfEngine({
      initialRules,
      randomInt: options.randomInt,
      now: options.now,
    });

    this.choreographer = new WerewolfChoreographer({
      face: ctx.face,
      body: ctx.body,
      pluginScope: ctx.scope,
      randomInt: options.randomInt,
      sleep: this.sleep,
      onTimingMaskScheduled: options.onTimingMaskScheduled,
      onDecoySweepExecuted: options.onDecoySweepExecuted,
    });

    this.lanCompanion = new LanCompanionController({
      engine: this.engine,
      onClaimsChanged: () => {
        this.persistCheckpoint();
        this.syncPublicState();
      },
      onAuthenticatedAction: async (seat, payload) => {
        await this.enqueueOperation(() => this.handleCompanionAction(seat, payload));
      },
    });

    this.speechCoordinator = new JudgeSpeechCoordinator({
      ai: ctx.ai,
      pluginId: WEREWOLF_PLUGIN_ID,
      isPaused: () => this.hostPaused,
      sleep: (ms) => this.sleep(ms),
      onStatusChange: () => {
        this.syncPublicState();
      },
      onSpeechFailure: (failure) => {
        this.ctx.setLastError(failure);
      },
    });
  }

  async start(): Promise<void> {
    // 1. Soft dependency on `vision.person-tracker`
    this.ctx.services.whenAvailable<PersonTrackerService>(
      PERSON_TRACKER_SERVICE_ID,
      (service, depScope) => {
        this.personTracker = service;
        this.syncDealingCameraSubscription();
        this.syncPublicState();
        depScope.onDispose(() => {
          if (this.personTracker === service) {
            this.personTracker = null;
            this.previewSessionId = null;
            this.dealingFaceAligned = false;
            void this.stopDealingCameraSubscription();
            this.syncPublicState();
          }
        });
      },
      this.ctx.scope,
    );

    // 2. Host top-right "Exit Stage" synchronization
    this.ctx.stage?.onHostExit(() => {
      void this.enqueueOperation(() => this.handleHostStageExited());
    }, this.ctx.scope);

    // 3. Foreground/background synchronization for leases, checkpoint & LAN recovery
    this.ctx.onAppForegroundChange?.((active) => {
      void this.enqueueOperation(() => this.handleForegroundChanged(active));
    }, this.ctx.scope);

    // 4. Register daytime-safe voice tools
    this.ctx.ai?.useContribution(
      {
        voiceTools: this.buildVoiceTools(),
      },
      this.ctx.scope,
    );

    // 5. Restore cold-boot match checkpoint non-intrusively into hostPaused state
    const savedCheckpoint = this.ctx.storage.get<WerewolfMatchCheckpointV1 | undefined>(
      STORAGE_MATCH_CHECKPOINT_KEY,
    );
    if (savedCheckpoint) {
      const outcome = this.engine.restoreCheckpoint(savedCheckpoint);
      if (outcome.restored) {
        this.hostPaused = true;
        if (this.engine.getCompletedMatch()) {
          try {
            const recovered = this.unarchivedMatch();
            this.clearCheckpoint();
            if (recovered && !recovered.replay?.review) void this.generateEndgameMvpReview();
            this.engine.exitToIdle();
            this.hostPaused = false;
          } catch (error) {
            this.ctx.setLastError(
              toPluginFailure(error, "history.recover", "ERR_WEREWOLF_HISTORY_RECOVERY"),
            );
          }
        } else {
          this.lanCompanion.restoreSeatTokens(outcome.lanSeatTokens);
        }
        if (this.hostPaused) {
          this.speechCoordinator.restoreMutedByHost(outcome.mutedByHost);
          this.speechCoordinator.seedSubtitle(savedCheckpoint.lastJudgeSpeech ?? "");
        }
      }
    }

    this.ctx.scope.onDispose(async () => {
      this.stopSpeakerClock();
      this.speechCoordinator.bumpEpoch();
      this.ctx.stage?.setResumableSession(null);
      await this.teardownAllSubScopes({ clearLanTokens: false });
    });

    this.syncSpeakerClockForCurrentPhase();
    if (this.history.state.matchHistoryLoadError) {
      this.ctx.setLastError(this.history.state.matchHistoryLoadError);
    }
    this.syncPublicState();
  }

  async stop(): Promise<void> {
    this.stopSpeakerClock();
    this.speechCoordinator.bumpEpoch();
    this.persistCheckpoint();
    this.ctx.stage?.setResumableSession(null);
    await this.teardownAllSubScopes({ clearLanTokens: false });
    this.engine.exitToIdle();
    this.hostPaused = false;
    this.syncPublicState();
  }

  async configure(values: Record<string, string>): Promise<void> {
    const patch: Partial<WerewolfRulesConfig> = {};
    if (values.presetId === "6p_joy" || values.presetId === "9p_standard" || values.presetId === "12p_guard" || values.presetId === "12p_idiot") {
      this.engine.selectPreset(values.presetId);
    }
    if (values.surfaceMode === "on_device" || values.surfaceMode === "lan_companion") {
      (patch as { surfaceMode?: WerewolfRulesConfig["surfaceMode"] }).surfaceMode =
        values.surfaceMode;
    }
    if (values.motionMode === "embodied_patrol" || values.motionMode === "stationary_gaze") {
      (patch as { motionMode?: WerewolfRulesConfig["motionMode"] }).motionMode =
        values.motionMode;
    }
    if (Object.keys(patch).length > 0) {
      this.engine.updateRules(patch);
    }
    this.persistRules();
    this.syncPublicState();
  }

  handleCommand(command: ReadReplayCommand): Promise<WerewolfMatchRecord>;
  handleCommand(command: MatchCommand): Promise<WerewolfPublicState>;
  handleCommand(command: WerewolfCommand): Promise<WerewolfPublicState | WerewolfMatchRecord>;
  async handleCommand(command: WerewolfCommand): Promise<WerewolfPublicState | WerewolfMatchRecord> {
    return this.enqueueOperation(async () => {
      try {
        if (command.type === "read_match_replay") {
          return this.readReplay(command.source);
        }
        this.ctx.setLastError(undefined);
        await this.dispatchCommand(command);
        return this.ctx.getState();
      } catch (error) {
        const failure = toPluginFailure(error, `command:${command.type}`);
        this.ctx.setLastError(failure);
        return rethrowWithStage(error, failure.stage);
      }
    });
  }

  private enqueueOperation<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.opQueue.then(() => fn());
    this.opQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ===========================================================================
  // Command Dispatch
  // ===========================================================================

  private async dispatchCommand(command: MatchCommand): Promise<void> {
    switch (command.type) {
      case "open_lobby": {
        this.clearCheckpoint();
        this.hostPaused = false;
        this.speechCoordinator.bumpEpoch();
        this.cancelActiveNightTask();
        this.lanCompanion.clearAllClaims();
        const outcome = this.engine.openLobby(command.presetId);
        this.persistRules();
        this.lanCompanion.pruneOutOfRangeClaims(this.engine.getPlayerCount());
        this.syncResumableSession();
        await this.ensureMatchStageMounted();
        if (this.engine.getRules().surfaceMode === "lan_companion") {
          await this.ensureLanRoomOpen();
        }
        await this.applyPostTransitionEffects(outcome);
        return;
      }

      case "abort_match_to_lobby": {
        this.clearCheckpoint();
        this.hostPaused = false;
        this.speechCoordinator.bumpEpoch();
        this.cancelActiveNightTask();
        this.stopSpeakerClock();
        this.lanCompanion.clearAllClaims();
        const outcome = this.engine.openLobby();
        this.syncResumableSession();
        await this.ensureMatchStageMounted();
        if (this.engine.getRules().surfaceMode === "lan_companion") {
          await this.ensureLanRoomOpen();
        }
        await this.applyPostTransitionEffects(outcome);
        return;
      }

      case "resume_stage": {
        this.hostPaused = false;
        this.syncResumableSession();
        if (this.engine.getPhase() === "idle") {
          const outcome = this.engine.openLobby();
          await this.ensureMatchStageMounted();
          if (this.engine.getRules().surfaceMode === "lan_companion") {
            await this.ensureLanRoomOpen();
          }
          await this.applyPostTransitionEffects(outcome);
          return;
        }
        await this.ensureMatchStageMounted();
        await this.resumeActivePhaseSideEffects();
        return;
      }

      case "exit_to_idle": {
        this.clearCheckpoint();
        this.hostPaused = false;
        this.speechCoordinator.resetForIdle();
        this.cancelActiveNightTask();
        this.stopSpeakerClock();
        await this.teardownAllSubScopes({ clearLanTokens: true });
        this.engine.exitToIdle();
        this.syncResumableSession();
        this.syncPublicState();
        return;
      }

      case "select_preset": {
        this.engine.selectPreset(command.presetId);
        this.lanCompanion.pruneOutOfRangeClaims(this.engine.getPlayerCount());
        this.persistRules();
        this.syncPublicState();
        return;
      }

      case "update_rules": {
        this.engine.updateRules(command.patch);
        this.lanCompanion.pruneOutOfRangeClaims(this.engine.getPlayerCount());
        this.persistRules();
        if (
          command.patch.surfaceMode === "lan_companion" &&
          this.engine.getPhase() !== "idle"
        ) {
          await this.ensureLanRoomOpen();
        }
        this.syncPublicState();
        this.syncStagePresentation();
        return;
      }

      case "set_role_count": {
        this.engine.setRoleCount(command.role, command.count);
        this.lanCompanion.pruneOutOfRangeClaims(this.engine.getPlayerCount());
        this.persistRules();
        this.syncPublicState();
        return;
      }

      case "set_seat_nickname": {
        this.engine.setSeatNickname(command.seat, command.nickname);
        this.persistCheckpoint();
        this.syncPublicState();
        return;
      }

      case "toggle_lan_room": {
        if (command.enabled) {
          await this.ensureLanRoomOpen({ keepExistingTokens: true });
        } else {
          await this.closeLanRoom({ clearTokens: true });
        }
        this.persistCheckpoint();
        this.syncPublicState();
        return;
      }

      case "refresh_lan_address": {
        if (this.lanSession) {
          try {
            if (this.lanSession.refreshAddressesAsync) {
              const info = await this.lanSession.refreshAddressesAsync();
              if (info.port > 0) {
                this.lastLanPort = info.port;
              }
            } else {
              this.lanSession.refreshAddresses();
            }
            this.lanError = null;
          } catch (error) {
            const failure = toPluginFailure(error, "lan_refresh", "ERR_LAN_ROOM_REFRESH_FAILED");
            this.lanError = `[stage=${failure.stage} code=${String(failure.code)}] ${failure.reason}`;
            this.syncPublicState();
            throw error;
          }
        }
        this.syncPublicState();
        return;
      }

      case "release_lan_seat": {
        this.lanCompanion.releaseSeatToken(command.seat);
        this.persistCheckpoint();
        this.syncPublicState();
        return;
      }

      case "start_dealing": {
        this.clearCheckpoint();
        this.hostPaused = false;
        this.speechCoordinator.bumpEpoch();
        this.cancelActiveNightTask();
        this.stopSpeakerClock();
        await this.ensureMatchStageMounted();
        if (this.engine.getRules().surfaceMode === "lan_companion") {
          await this.ensureLanRoomOpen({ keepExistingTokens: true });
        }
        const outcome = this.engine.startDealing(
          this.options.fixedRolesBySeat
            ? { fixedRolesBySeat: this.options.fixedRolesBySeat }
            : undefined,
        );
        this.syncDealingCameraSubscription();
        await this.applyPostTransitionEffects(outcome);
        return;
      }

      case "capture_seat_portrait": {
        await this.capturePortraitForSeat(command.seat);
        this.syncPublicState();
        return;
      }

      case "set_deal_reveal": {
        this.engine.setDealReveal(command.seat, command.revealing);
        this.syncPublicState();
        return;
      }

      case "confirm_seat_dealt": {
        // Opportunistically capture seat portrait if tracker is streaming and portrait is empty
        const stateBefore = this.ctx.getState();
        const seatView = stateBefore.seats[command.seat - 1];
        if (this.personTracker && seatView && !seatView.portraitDataUri) {
          await this.capturePortraitForSeat(command.seat).catch(() => {});
        }
        const outcome = this.engine.confirmSeatDealt(command.seat);
        this.dealingFaceAligned = false;
        if (this.engine.getDealingCurrentSeat() !== null) {
          void this.choreographer
            .pivotClockwiseToNextSeat(
              this.engine.getPlayerCount(),
              this.engine.getRules().motionMode,
            )
            .catch(() => {});
        }
        await this.applyPostTransitionEffects(outcome);
        return;
      }

      case "step_back_deal": {
        const outcome = this.engine.stepBackDeal();
        this.dealingFaceAligned = false;
        this.syncDealingCameraSubscription();
        await this.applyPostTransitionEffects(outcome);
        return;
      }

      case "replay_last_speech": {
        const voiceStatus = this.speechCoordinator.status();
        if (!voiceStatus.lastSpokenText) {
          throw new WerewolfRuleError(
            "replay_last_speech",
            "ERR_NO_JUDGE_SPEECH",
            "当前暂无可重播的法官台词",
          );
        }
        if (voiceStatus.mutedByHost) {
          throw new WerewolfRuleError(
            "replay_last_speech",
            "ERR_JUDGE_VOICE_MUTED",
            "法官语音当前处于静音状态，请先取消静音或查看屏幕字幕",
          );
        }
        void this.speechCoordinator.replayLast().catch((err) => {
          this.ctx.setLastError(
            toPluginFailure(err, "replay_last_speech", "ERR_JUDGE_SPEECH_FAILED"),
          );
        });
        return;
      }

      case "set_judge_voice_muted": {
        this.speechCoordinator.setMutedByHost(command.muted);
        this.persistCheckpoint();
        this.syncPublicState();
        return;
      }

      case "begin_first_night": {
        await this.stopDealingCameraSubscription();
        const outcome = this.engine.beginFirstNight();
        await this.applyPostTransitionEffects(outcome);
        return;
      }

      case "set_night_gate": {
        this.engine.setNightGate(command.unlocked);
        this.syncPublicState();
        return;
      }

      case "select_night_target": {
        this.engine.selectNightTarget(command.targetSeat);
        this.syncPublicState();
        return;
      }

      case "submit_guard_action": {
        const outcome = this.engine.submitGuardAction(command.targetSeat);
        await this.finishLivingNightRoleStep("守卫请闭眼。", outcome);
        return;
      }

      case "submit_wolf_action": {
        const outcome = this.engine.submitWolfAction(command.targetSeat);
        await this.finishLivingNightRoleStep("狼人请闭眼。", outcome);
        return;
      }

      case "submit_witch_action": {
        const outcome = this.engine.submitWitchAction({
          save: command.save,
          poisonTargetSeat: command.poisonTargetSeat,
        });
        await this.finishLivingNightRoleStep("女巫请闭眼。", outcome);
        return;
      }

      case "submit_seer_check": {
        this.engine.submitSeerCheck(command.targetSeat);
        this.persistCheckpoint();
        this.syncPublicState();
        return;
      }

      case "finish_seer_turn": {
        const outcome = this.engine.finishSeerTurn();
        await this.finishLivingNightRoleStep("预言家请闭眼。", outcome);
        return;
      }

      case "toggle_sheriff_candidate": {
        this.engine.toggleSheriffCandidate(command.seat);
        this.persistCheckpoint();
        this.syncPublicState();
        return;
      }

      case "lock_sheriff_candidates": {
        const outcome = this.engine.lockSheriffCandidates();
        await this.applyPostTransitionEffects(outcome);
        return;
      }

      case "sheriff_drop_out": {
        const outcome = this.engine.sheriffDropOut(command.seat);
        await this.applyPostTransitionEffects(outcome);
        return;
      }

      case "advance_speaker": {
        const outcome = this.engine.advanceSpeaker();
        void this.choreographer
          .pivotClockwiseToNextSeat(
            this.engine.getPlayerCount(),
            this.engine.getRules().motionMode,
          )
          .catch(() => {});
        await this.applyPostTransitionEffects(outcome);
        return;
      }

      case "toggle_timer_pause": {
        this.engine.toggleTimerPause();
        this.persistCheckpoint();
        this.syncSpeakerClockForCurrentPhase();
        this.syncPublicState();
        return;
      }

      case "start_voting": {
        const outcome = this.engine.startVoting();
        await this.applyPostTransitionEffects(outcome);
        return;
      }

      case "cast_on_device_vote": {
        this.engine.castVote(command.voterSeat, command.targetSeat, {
          autoFinalizeWhenAllVoted: false,
        });
        this.persistCheckpoint();
        this.syncPublicState();
        return;
      }

      case "finalize_votes": {
        const outcome = this.engine.finalizeVotes();
        await this.applyPostTransitionEffects(outcome);
        return;
      }

      case "acknowledge_dawn": {
        const outcome = this.engine.acknowledgeDawn();
        await this.applyPostTransitionEffects(outcome);
        return;
      }

      case "resolve_hunter_shot": {
        const outcome = this.engine.resolveHunterShot(command.targetSeat);
        await this.applyPostTransitionEffects(outcome);
        return;
      }

      case "resolve_sheriff_transfer": {
        const outcome = this.engine.resolveSheriffTransfer(command.targetSeat);
        await this.applyPostTransitionEffects(outcome);
        return;
      }

      case "finish_last_words": {
        const outcome = this.engine.finishLastWords();
        await this.applyPostTransitionEffects(outcome);
        return;
      }

      case "trigger_wolf_explode": {
        this.cancelActiveNightTask();
        const outcome =
          this.engine.getPhase() === "leave_resolution" &&
          this.ctx.getState().pendingLeaveReason === "white_wolf_explode"
            ? this.engine.resolveWhiteWolfExplodeTarget(
                command.whiteWolfTargetSeat ?? null,
                command.wolfSeat,
              )
            : this.engine.triggerWolfExplode(
                command.wolfSeat,
                command.whiteWolfTargetSeat,
              );
        await this.applyPostTransitionEffects(outcome);
        return;
      }

      case "delete_match_record": {
        this.deleteMatchRecord(command.matchId);
        this.publishHistoryState();
        return;
      }

      case "regenerate_mvp_review": {
        if (this.engine.getPhase() !== "game_over") {
          throw new WerewolfRuleError(
            "regenerate_mvp_review",
            "ERR_WEREWOLF_MATCH_NOT_OVER",
            "仅终局阶段可生成 AI 复盘点评",
          );
        }
        void this.generateEndgameMvpReview();
        return;
      }

      case "play_again": {
        this.clearCheckpoint();
        this.hostPaused = false;
        this.speechCoordinator.bumpEpoch();
        this.cancelActiveNightTask();
        this.stopSpeakerClock();
        this.lanCompanion.clearAllClaims();
        const outcome = this.engine.openLobby();
        await this.ensureMatchStageMounted();
        if (this.engine.getRules().surfaceMode === "lan_companion") {
          await this.ensureLanRoomOpen();
        }
        await this.applyPostTransitionEffects(outcome);
        return;
      }
    }
  }

  private async handleCompanionAction(
    seat: number,
    payload: CompanionSeatActionPayload,
  ): Promise<void> {
    switch (payload.action) {
      case "confirm_deal": {
        const outcome = this.engine.confirmSeatDealt(seat);
        await this.applyPostTransitionEffects(outcome);
        return;
      }
      case "guard_pick": {
        const outcome = this.engine.submitGuardAction(payload.targetSeat, seat);
        await this.finishLivingNightRoleStep("守卫请闭眼。", outcome);
        return;
      }
      case "wolf_vote": {
        const outcome = this.engine.submitWolfCompanionVote(
          seat,
          payload.targetSeat,
          payload.confirm !== false,
        );
        if (outcome) {
          await this.finishLivingNightRoleStep("狼人请闭眼。", outcome);
        } else {
          this.persistCheckpoint();
          this.syncPublicState();
        }
        return;
      }
      case "witch_act": {
        const outcome = this.engine.submitWitchAction(
          {
            save: payload.save,
            poisonTargetSeat: payload.poisonTargetSeat,
          },
          seat,
        );
        await this.finishLivingNightRoleStep("女巫请闭眼。", outcome);
        return;
      }
      case "seer_check": {
        this.engine.submitSeerCheck(payload.targetSeat, seat);
        this.persistCheckpoint();
        this.syncPublicState();
        return;
      }
      case "seer_finish": {
        const outcome = this.engine.finishSeerTurn(seat);
        await this.finishLivingNightRoleStep("预言家请闭眼。", outcome);
        return;
      }
      case "sheriff_toggle_signup": {
        this.engine.toggleSheriffCandidate(seat);
        this.persistCheckpoint();
        this.syncPublicState();
        return;
      }
      case "sheriff_drop_out": {
        const outcome = this.engine.sheriffDropOut(seat);
        await this.applyPostTransitionEffects(outcome);
        return;
      }
      case "cast_vote": {
        const outcome = this.engine.castVote(seat, payload.targetSeat, {
          autoFinalizeWhenAllVoted: true,
        });
        if (outcome) {
          await this.applyPostTransitionEffects(outcome);
        } else {
          this.persistCheckpoint();
          this.syncPublicState();
        }
        return;
      }
      case "hunter_shoot": {
        const outcome = this.engine.resolveHunterShot(payload.targetSeat, seat);
        await this.applyPostTransitionEffects(outcome);
        return;
      }
      case "sheriff_transfer": {
        const outcome = this.engine.resolveSheriffTransfer(payload.targetSeat, seat);
        await this.applyPostTransitionEffects(outcome);
        return;
      }
      case "white_wolf_drag": {
        const outcome = this.engine.resolveWhiteWolfExplodeTarget(payload.targetSeat, seat);
        await this.applyPostTransitionEffects(outcome);
        return;
      }
      case "wolf_self_explode": {
        const outcome = this.engine.triggerWolfExplode(seat, payload.whiteWolfTargetSeat);
        await this.applyPostTransitionEffects(outcome);
        return;
      }
    }
  }

  // ===========================================================================
  // Phase Transitions, Night Decoy Sequencer & Scopes
  // ===========================================================================

  private async finishLivingNightRoleStep(
    closeEyesSpeech: string,
    nextOutcome: EngineTransitionOutcome,
  ): Promise<void> {
    await this.applyPostTransitionEffects(nextOutcome, async () => {
      this.syncPublicState();
      void this.speakJudgeLine(closeEyesSpeech);
      await this.choreographer.performAcousticDecoySweep(this.engine.getRules().motionMode);
    });
  }

  private async applyPostTransitionEffects(
    outcome: EngineTransitionOutcome,
    afterSettlement?: () => Promise<void>,
  ): Promise<void> {
    let settlementFailure: PluginFailure | undefined;
    if (outcome.gameEnded) {
      this.currentMatch();
      try {
        // Keep a completed checkpoint until the replay is durably archived.
        this.persistCheckpoint();
        this.clearCheckpoint();
      } catch (error) {
        settlementFailure = toPluginFailure(error, "history.checkpoint", "ERR_WEREWOLF_HISTORY_CHECKPOINT");
        this.ctx.setLastError(settlementFailure);
      }
    }
    if (afterSettlement) await afterSettlement();
    if (!outcome.gameEnded) {
      this.persistCheckpoint();
    }
    this.syncPublicState();
    this.syncLifecycleScopesForCurrentPhase();
    this.syncDealingCameraSubscription();
    this.syncStagePresentation();
    this.choreographer.applyPhaseAtmosphere(this.engine.getPhase());
    this.syncSpeakerClockForCurrentPhase();

    if (outcome.announcement) {
      void this.speakJudgeLine(outcome.announcement);
    }

    if (outcome.enteredNightIntro && this.options.autoAdvanceNightIntro !== false) {
      this.scheduleNightIntroAdvance();
      return;
    }

    if (outcome.enteredNightRole) {
      const role = outcome.enteredNightRole;
      if (outcome.isDeadRoleDecoy && role !== "werewolf") {
        this.scheduleDeadRoleDecoyMask(role);
      } else {
        void this.choreographer
          .performNightEntrySweep(
            this.engine.getRules().motionMode,
            this.engine.getRules().surfaceMode,
          )
          .catch(() => {});
      }
      return;
    }

    if (outcome.gameEnded && this.engine.getPhase() === "game_over") {
      void this.generateEndgameMvpReview();
    }
    if (settlementFailure) {
      throw Object.assign(new Error(settlementFailure.reason), settlementFailure);
    }
  }

  private scheduleNightIntroAdvance(): void {
    this.cancelActiveNightTask();
    const ac = new AbortController();
    this.nightTaskAbort = ac;

    void (async () => {
      await this.sleep(this.nightIntroDelayMs, ac.signal);
      if (ac.signal.aborted || this.hostPaused || this.engine.getPhase() !== "night_intro") {
        return;
      }
      await this.enqueueOperation(async () => {
        if (ac.signal.aborted || this.hostPaused || this.engine.getPhase() !== "night_intro") {
          return;
        }
        this.nightTaskAbort = null;
        const next = this.engine.advanceFromNightIntro();
        await this.applyPostTransitionEffects(next);
      });
    })().catch((error) => {
      this.ctx.setLastError(toPluginFailure(error, "night_intro"));
    });
  }

  private scheduleDeadRoleDecoyMask(role: "guard" | "witch" | "seer"): void {
    this.cancelActiveNightTask();
    const ac = new AbortController();
    this.nightTaskAbort = ac;
    const expectedPhase =
      role === "guard"
        ? "night_guard"
        : role === "witch"
          ? "night_witch"
          : "night_seer";
    const closeLine =
      role === "guard"
        ? "守卫请闭眼。"
        : role === "witch"
          ? "女巫请闭眼。"
          : "预言家请闭眼。";

    void (async () => {
      await this.choreographer.runDeadRoleTimingMask(
        role,
        this.engine.getRules().motionMode,
        ac.signal,
      );
      if (
        ac.signal.aborted ||
        this.hostPaused ||
        this.engine.getPhase() !== expectedPhase ||
        !this.engine.isCurrentNightStepDecoy()
      ) {
        return;
      }
      void this.speakJudgeLine(closeLine);
      await this.choreographer.performAcousticDecoySweep(
        this.engine.getRules().motionMode,
        ac.signal,
      );
      if (ac.signal.aborted || this.hostPaused || this.engine.getPhase() !== expectedPhase) {
        return;
      }
      await this.enqueueOperation(async () => {
        if (
          ac.signal.aborted ||
          this.hostPaused ||
          this.engine.getPhase() !== expectedPhase ||
          !this.engine.isCurrentNightStepDecoy()
        ) {
          return;
        }
        this.nightTaskAbort = null;
        const next = this.engine.advanceDecoyNightStep();
        await this.applyPostTransitionEffects(next);
      });
    })().catch((error) => {
      this.ctx.setLastError(toPluginFailure(error, "night_decoy"));
    });
  }

  private cancelActiveNightTask(): void {
    if (this.nightTaskAbort) {
      this.nightTaskAbort.abort();
      this.nightTaskAbort = null;
    }
  }

  private async ensureMatchStageMounted(): Promise<void> {
    if (!this.matchStageScope || !this.matchStageScope.active) {
      this.matchStageScope = this.ctx.forkScope("werewolf-match-stage");
    }
    await this.choreographer.ensureMatchLeases(this.matchStageScope);
    this.syncPublicState();
    this.syncStagePresentation();
  }

  private async resumeActivePhaseSideEffects(): Promise<void> {
    this.syncPublicState();
    this.syncLifecycleScopesForCurrentPhase();
    this.syncDealingCameraSubscription();
    this.choreographer.applyPhaseAtmosphere(this.engine.getPhase());
    this.syncSpeakerClockForCurrentPhase();

    const phase = this.engine.getPhase();
    if (this.engine.getRules().surfaceMode === "lan_companion" && phase !== "idle") {
      try {
        const session = await this.ensureLanRoomOpen({ keepExistingTokens: true });
        session.notifyRevision(this.engine.getRevision());
      } catch {
        // ensureLanRoomOpen already records this.lanError and this.ctx.setLastError
      }
    }

    if (phase === "night_intro" && this.options.autoAdvanceNightIntro !== false && !this.nightTaskAbort) {
      this.scheduleNightIntroAdvance();
    } else if (
      (phase === "night_guard" || phase === "night_witch" || phase === "night_seer") &&
      this.engine.isCurrentNightStepDecoy() &&
      !this.nightTaskAbort
    ) {
      const decoyRole =
        phase === "night_guard" ? "guard" : phase === "night_witch" ? "witch" : "seer";
      this.scheduleDeadRoleDecoyMask(decoyRole);
    } else if (phase === "game_over" && this.ctx.getState().aiMvpReview.status === "idle") {
      void this.generateEndgameMvpReview();
    }

    this.syncPublicState();
    this.syncStagePresentation();
  }

  private async handleForegroundChanged(active: boolean): Promise<void> {
    this.appForegroundActive = active;
    if (!active) {
      this.stopSpeakerClock();
      this.persistCheckpoint();
      return;
    }
    if (this.hostPaused || this.engine.getPhase() === "idle") {
      return;
    }
    if (this.matchStageScope?.active) {
      await this.choreographer.ensureMatchLeases(this.matchStageScope);
      this.choreographer.applyPhaseAtmosphere(this.engine.getPhase());
    }
    this.syncSpeakerClockForCurrentPhase();
    if (this.engine.getRules().surfaceMode === "lan_companion") {
      if (this.lanSession) {
        try {
          if (this.lanSession.refreshAddressesAsync) {
            const info = await this.lanSession.refreshAddressesAsync();
            if (info.port > 0) {
              this.lastLanPort = info.port;
            }
          } else {
            this.lanSession.refreshAddresses();
          }
          this.lanError = null;
          this.lanSession.notifyRevision(this.engine.getRevision());
        } catch (error) {
          const failure = toPluginFailure(error, "lan_rebind", "ERR_LAN_ROOM_REBIND_FAILED");
          this.lanError = `[stage=${failure.stage} code=${String(failure.code)}] ${failure.reason}`;
          this.ctx.setLastError(failure);
        }
      } else {
        try {
          const session = await this.ensureLanRoomOpen({ keepExistingTokens: true });
          session.notifyRevision(this.engine.getRevision());
        } catch {
          // ensureLanRoomOpen already records this.lanError and this.ctx.setLastError
        }
      }
    }
    this.syncPublicState();
  }

  private syncStagePresentation(): void {
    if (!this.ctx.stage) return;
    if (this.hostPaused || this.engine.getPhase() === "idle") {
      if (this.stagePresentationDispose) {
        void this.stagePresentationDispose();
        this.stagePresentationDispose = null;
      }
      this.lastPresentationJson = "";
      return;
    }

    const desired: PluginStagePresentation | null = resolveStagePresentation({
      phase: this.engine.getPhase(),
      sheriffSubphase: this.ctx.getState().sheriffSubphase,
      surfaceMode: this.engine.getRules().surfaceMode,
    });
    const serialized = JSON.stringify(desired);
    const currentHostJson = JSON.stringify(this.ctx.stage.currentPresentation());
    if (
      serialized === this.lastPresentationJson &&
      currentHostJson === serialized &&
      this.stagePresentationDispose
    ) {
      return;
    }

    if (this.stagePresentationDispose) {
      void this.stagePresentationDispose();
      this.stagePresentationDispose = null;
    }
    this.lastPresentationJson = serialized;

    if (desired && this.matchStageScope?.active) {
      this.stagePresentationDispose = this.ctx.stage.usePresentation(
        desired,
        this.matchStageScope,
      );
    }
  }

  private syncLifecycleScopesForCurrentPhase(): void {
    const phase = this.engine.getPhase();
    const inNight = this.engine.isNightPhase() && !this.hostPaused;
    const inDayOrMatch =
      !this.engine.isNightPhase() && phase !== "idle" && !this.hostPaused;

    // 1. Night silence scope (`interceptUserTurn`)
    if (inNight) {
      if (!this.nightScope || !this.nightScope.active) {
        const ns = this.ctx.forkScope(`night-round-${this.engine.getDay()}`);
        this.nightScope = ns;
        this.ctx.ai?.interceptUserTurn(({ text }) => {
          if (isNoiseOnlyUtterance(text)) {
            return {
              decision: "block",
              stage: "werewolf_night_guard",
              code: "ERR_WEREWOLF_NIGHT_NOISE",
              reason: "werewolf_night_silence",
            };
          }
          return {
            decision: "block",
            stage: "werewolf_night_guard",
            code: "ERR_WEREWOLF_NIGHT_SILENCE",
            reason: "werewolf_night_silence",
            spokenReply: "天黑请保持安静",
          };
        }, ns);
      }
    } else if (this.nightScope) {
      const old = this.nightScope;
      this.nightScope = null;
      void old.dispose();
    }

    // 2. Daytime public-only Judge persona & context slice
    if (inDayOrMatch) {
      if (!this.dayContextScope || !this.dayContextScope.active) {
        const ds = this.ctx.forkScope("werewolf-day-context");
        this.dayContextScope = ds;
        this.ctx.ai?.usePersonaOverlay(
          {
            mode: "append_rules",
            instructions:
              "你正在担任线下聚会狼人杀的 AI 法官主持。仅根据公开台面状态简要回答存活座位、公投票型或阶段规则，严禁编造任何未公开身份。",
          },
          ds,
        );
      }
      if (this.dayContextDispose) {
        void this.dayContextDispose();
        this.dayContextDispose = null;
      }
      if (this.dayContextScope?.active && this.ctx.ai) {
        this.dayContextDispose = this.ctx.ai.useContextSlice(
          {
            summary: this.engine.exportPublicDayContextSummary(),
            priority: 80,
          },
          this.dayContextScope,
        );
      }
    } else if (this.dayContextScope) {
      this.dayContextDispose = null;
      const old = this.dayContextScope;
      this.dayContextScope = null;
      void old.dispose();
    }
  }

  private syncDealingCameraSubscription(): void {
    const shouldStream =
      this.engine.getPhase() === "dealing" &&
      !this.hostPaused &&
      this.personTracker !== null;

    if (!shouldStream) {
      if (this.dealingTrackScope) {
        void this.stopDealingCameraSubscription();
      }
      return;
    }

    if (this.dealingTrackScope?.active) {
      return;
    }

    const tracker = this.personTracker!;
    const trackScope = this.ctx.forkScope("werewolf-dealing-vision");
    this.dealingTrackScope = trackScope;

    void (async () => {
      try {
        if (tracker.permissionStatus() === "undetermined") {
          await tracker.requestPermission();
        }
        if (!trackScope.active || tracker.permissionStatus() !== "granted") {
          return;
        }
        const sub = await tracker.acquireTracking(
          { maxFps: 6, maxDimension: 320, smoothingAlpha: 0.45 },
          (frame) => {
            if (!trackScope.active || this.engine.getPhase() !== "dealing") return;
            const target = frame.primaryTarget;
            if (!target) {
              if (this.dealingFaceAligned) {
                this.dealingFaceAligned = false;
                void this.choreographer.stopWheelPivot().catch(() => {});
                this.syncPublicState();
              }
              return;
            }
            void this.choreographer
              .applyVisualTrackingFrame(
                target.offsetX,
                target.offsetY,
                this.engine.getRules().motionMode,
                true,
              )
              .then(({ aligned }) => {
                if (this.dealingFaceAligned !== aligned) {
                  this.dealingFaceAligned = aligned;
                  this.syncPublicState();
                }
              })
              .catch(() => {});
          },
          trackScope,
        );
        if (trackScope.active) {
          this.previewSessionId = sub.previewSessionId;
          this.syncPublicState();
        } else {
          await sub.release();
        }
      } catch {
        // Soft optional dependency: continue dealing without camera alignment if unavailable
      }
    })();
  }

  private async stopDealingCameraSubscription(): Promise<void> {
    this.previewSessionId = null;
    this.dealingFaceAligned = false;
    const scope = this.dealingTrackScope;
    this.dealingTrackScope = null;
    if (scope) {
      await scope.dispose();
    }
    await this.choreographer.stopWheelPivot();
  }

  private async capturePortraitForSeat(seat: number): Promise<void> {
    if (!this.personTracker) {
      throw new WerewolfRuleError(
        "capture_seat_portrait",
        "ERR_WEREWOLF_VISION_UNAVAILABLE",
        "视觉座位追踪插件未启用或不可用",
      );
    }
    const portrait = await this.personTracker.capturePortrait({ maxDimension: 320 });
    this.engine.setSeatPortrait(seat, portrait.dataUri);
  }

  // ===========================================================================
  // LAN Room Lifecycle
  // ===========================================================================

  private async ensureLanRoomOpen(options?: { readonly keepExistingTokens?: boolean }): Promise<LanRoomSession> {
    if (this.lanSession) {
      this.lanError = null;
      return this.lanSession;
    }
    if (!this.ctx.lan) {
      const failure: PluginFailure = {
        stage: "lan_open",
        code: "ERR_LAN_CAPABILITY_UNAVAILABLE",
        reason: "当前宿主未注入局域网房间能力（network.lan_room）",
      };
      this.lanError = failure.reason;
      this.ctx.setLastError(failure);
      throw Object.assign(new Error(failure.reason), failure);
    }

    const scope = this.ctx.forkScope("werewolf-lan-room");
    this.lanScope = scope;
    try {
      const session = await this.ctx.lan.openRoom({
        scope,
        preferredPort: options?.keepExistingTokens ? this.lastLanPort : undefined,
        onRequest: (req) => this.lanCompanion.handleHttpRequest(req),
      });
      this.lanSession = session;
      this.lastLanPort = session.port;
      this.lanError = null;
      scope.onDispose(() => {
        if (this.lanSession === session) {
          this.lanSession = null;
        }
      });
      return session;
    } catch (error) {
      this.lanScope = null;
      await scope.dispose();
      const failure = toPluginFailure(error, "lan_open");
      this.lanError = failure.reason;
      this.ctx.setLastError(failure);
      return rethrowWithStage(error, "lan_open");
    }
  }

  private async closeLanRoom(options?: { readonly clearTokens?: boolean }): Promise<void> {
    const session = this.lanSession;
    this.lanSession = null;
    if (session) {
      await session.close().catch(() => {});
    }
    const scope = this.lanScope;
    this.lanScope = null;
    if (scope) {
      await scope.dispose();
    }
    if (options?.clearTokens !== false) {
      this.lanCompanion.clearAllClaims();
    }
  }

  // ===========================================================================
  // Host Exit, Speaker Clock, Voice Tools & Endgame AI MVP Commentary
  // ===========================================================================

  private async handleHostStageExited(): Promise<void> {
    this.hostPaused = true;
    this.speechCoordinator.bumpEpoch();
    this.cancelActiveNightTask();
    this.stopSpeakerClock();
    await this.stopDealingCameraSubscription();

    if (this.nightScope) {
      const ns = this.nightScope;
      this.nightScope = null;
      await ns.dispose();
    }
    if (this.dayContextScope) {
      this.dayContextDispose = null;
      const ds = this.dayContextScope;
      this.dayContextScope = null;
      await ds.dispose();
    }
    if (this.stagePresentationDispose) {
      await this.stagePresentationDispose();
      this.stagePresentationDispose = null;
    }
    this.lastPresentationJson = "";
    await this.choreographer.releaseMatchLeases();
    if (this.matchStageScope) {
      const ms = this.matchStageScope;
      this.matchStageScope = null;
      await ms.dispose();
    }
    this.persistCheckpoint();
    this.syncPublicState();
  }

  private syncSpeakerClockForCurrentPhase(): void {
    const state = this.ctx.getState();
    const shouldRun =
      this.appForegroundActive &&
      !this.hostPaused &&
      !state.timerPaused &&
      shouldRunSpeakerClock(this.engine.getPhase(), state.sheriffSubphase);
    if (shouldRun) {
      this.startSpeakerClock();
    } else {
      this.stopSpeakerClock();
    }
  }

  private startSpeakerClock(): void {
    if (this.speakerInterval || this.speakerTickMs <= 0) return;
    this.speakerInterval = setInterval(() => {
      if (this.hostPaused || !this.appForegroundActive) return;
      const { expired, remainingSec } = this.engine.tickSpeakerTimer(1);
      if (expired) {
        void this.enqueueOperation(async () => {
          if (this.hostPaused || !this.appForegroundActive) return;
          try {
            const outcome = this.engine.advanceSpeaker();
            await this.applyPostTransitionEffects(outcome);
          } catch {
            // Ignore race if user manually advanced on exact expiry tick
          }
        });
      } else if (this.engine.getSpeakingSeat() !== null && remainingSec >= 0) {
        this.syncPublicState();
      }
    }, this.speakerTickMs);
  }

  private stopSpeakerClock(): void {
    if (this.speakerInterval) {
      clearInterval(this.speakerInterval);
      this.speakerInterval = null;
    }
  }

  private buildVoiceTools(): readonly PluginVoiceTool[] {
    const openLobbyTool: PluginVoiceTool<{
      presetId?: WerewolfPresetId;
      surfaceMode?: "on_device" | "lan_companion";
    }> = {
      name: "werewolf_open_lobby",
      description:
        "在 LOOI 首屏舞台打开线下聚会狼人杀准备大厅（支持 6p_joy / 9p_standard / 12p_guard / 12p_idiot 预设）；若当前有未结束对局则恢复该对局而不覆盖进度。",
      parametersJsonSchema: {
        type: "object",
        properties: {
          presetId: {
            type: "string",
            enum: ["6p_joy", "9p_standard", "12p_guard", "12p_idiot"],
            description: "狼人杀板子预设 ID",
          },
          surfaceMode: {
            type: "string",
            enum: ["on_device", "lan_companion"],
            description: "交互模式：本机防窥触控或局域网手机扫码副屏",
          },
        },
      },
      execute: async (params) => {
        if (isMatchActivePhase(this.engine.getPhase())) {
          const resumed = await this.handleCommand({ type: "resume_stage" });
          return {
            ok: true,
            resumedExistingMatch: true,
            phase: resumed.phase,
            playerCount: resumed.rules.playerCount,
            lanUrl: resumed.lan.baseUrl,
          };
        }
        if (params.surfaceMode) {
          await this.handleCommand({
            type: "update_rules",
            patch: { surfaceMode: params.surfaceMode },
          });
        }
        const next = await this.handleCommand({
          type: "open_lobby",
          presetId: params.presetId,
        });
        return {
          ok: true,
          phase: next.phase,
          playerCount: next.rules.playerCount,
          lanUrl: next.lan.baseUrl,
        };
      },
    };

    const hostControlTool: PluginVoiceTool<{
      action: "next_speaker" | "start_voting" | "toggle_pause";
    }> = {
      name: "werewolf_host_control",
      description:
        "仅限狼人杀白天公开阶段使用：推进到下一位发言玩家、发起放逐公投或暂停/恢复发言倒计时。",
      parametersJsonSchema: {
        type: "object",
        required: ["action"],
        properties: {
          action: {
            type: "string",
            enum: ["next_speaker", "start_voting", "toggle_pause"],
          },
        },
      },
      execute: async (params) => {
        if (this.engine.isNightPhase()) {
          throw new WerewolfRuleError(
            "voice_host_control",
            "ERR_WEREWOLF_NIGHT_LOCKED",
            "黑夜阶段严禁语音干预流程",
          );
        }
        if (params.action === "next_speaker") {
          const state = await this.handleCommand({ type: "advance_speaker" });
          return { ok: true, phase: state.phase, speakingSeat: state.speakingSeat };
        }
        if (params.action === "start_voting") {
          const state = await this.handleCommand({ type: "start_voting" });
          return { ok: true, phase: state.phase };
        }
        const state = await this.handleCommand({ type: "toggle_timer_pause" });
        return { ok: true, timerPaused: state.timerPaused };
      },
    };

    return [openLobbyTool, hostControlTool];
  }

  private async generateEndgameMvpReview(): Promise<void> {
    const match = this.currentMatch();
    if (!match) return;
    const { record: { id }, battleReport } = match;
    const token = Symbol();
    this.pendingMvpReviews.set(id, token);
    this.engine.setAiMvpReview({ status: "generating", text: null, error: null });
    this.syncPublicState();

    let result: WerewolfAiMvpReview;
    let reviewFailure: PluginFailure | undefined;
    try {
      if (!this.ctx.ai) {
        throw new WerewolfRuleError("mvp_review", "ERR_WEREWOLF_AI_UNAVAILABLE", "AI 后台复盘服务未启用");
      }
      const prompt = [
        "你是线下聚会狼人杀的毒舌幽默 AI 法官。请严格根据下方真实战报，在 110 字以内颁出本局【全场 MVP】与一针见血的名场面复盘颁奖词（不要使用 Markdown 标题，直接给出适合语音朗读的精彩中文点评）：",
        "",
        battleReport,
      ].join("\n");
      const response = await this.ctx.ai.runBackgroundTask(prompt);
      const text = response.answer.trim();
      if (!text) {
        throw new WerewolfRuleError("mvp_review", "ERR_WEREWOLF_EMPTY_MVP_REVIEW", "后台模型返回空复盘文本");
      }
      result = { status: "ready", text, error: null };
    } catch (error) {
      reviewFailure = toPluginFailure(error, "mvp_review");
      result = this.failedMvpReview(reviewFailure);
    }

    await this.enqueueOperation(() => {
      if (!this.ctx.scope.active || !this.ctx.enabled() || this.pendingMvpReviews.get(id) !== token) return;
      this.pendingMvpReviews.delete(id);
      const current = this.engine.getCompletedMatch()?.id === id;
      if (reviewFailure) this.ctx.setLastError(reviewFailure);
      try {
        const archived = this.history.records.find((entry) => entry.id === id);
        const replay = archived?.replay;
        if (archived && replay) {
          this.writeMatchHistory(
            this.history.records.map((record) =>
              record === archived ? { ...archived, replay: { ...replay, review: result } } : record,
            ),
            "history.mvp",
          );
        } else if (current && this.archivedMatchId !== id) {
          this.persistCheckpoint(result);
        }
      } catch (error) {
        const failure = toPluginFailure(error, "history.mvp");
        this.ctx.setLastError(failure);
        result = this.failedMvpReview(failure);
        this.matchHistoryVersion += 1;
      }
      if (current) {
        const terminal = this.currentMatch();
        if (terminal?.record.replay) {
          this.terminalMatch = {
            ...terminal,
            record: { ...terminal.record, replay: { ...terminal.record.replay, review: result } },
          };
        }
        this.engine.setAiMvpReview(result);
        this.syncPublicState();
        if (result.status === "ready" && result.text) void this.speakJudgeLine(result.text);
      } else {
        this.publishHistoryState();
      }
    });
  }

  private failedMvpReview(failure: PluginFailure): WerewolfAiMvpReview {
    return {
      status: "failed",
      text: null,
      error: `[stage=${failure.stage} code=${String(failure.code)}] ${failure.reason}`,
    };
  }

  private async speakJudgeLine(text: string): Promise<void> {
    if (!text.trim() || this.hostPaused) return;
    await this.speechCoordinator.speakSequential({
      text,
      contextNote: `[${WEREWOLF_PLUGIN_ID}] 法官台词播报`,
      closeToStandbyOnComplete: shouldCloseVoiceToStandby(this.engine.getPhase()),
    });
  }

  private persistRules(): void {
    this.ctx.storage.set(STORAGE_RULES_KEY, this.engine.getRules());
  }

  private persistCheckpoint(terminalReview?: WerewolfAiMvpReview): void {
    const terminal = this.engine.getPhase() === "game_over";
    if (terminal && !this.unarchivedMatch()) {
      this.ctx.storage.delete(STORAGE_MATCH_CHECKPOINT_KEY);
      this.terminalCheckpoint = null;
      return;
    }
    const checkpoint = this.terminalCheckpoint ?? this.engine.exportCheckpoint({
      lanSeatTokens: this.lanCompanion.exportSeatTokens(),
      mutedByHost: this.speechCoordinator.isMutedByHost(),
    });
    if (checkpoint) {
      const saved = terminalReview ? { ...checkpoint, aiMvpReview: terminalReview } : checkpoint;
      if (terminal) this.terminalCheckpoint = saved;
      this.ctx.storage.set(STORAGE_MATCH_CHECKPOINT_KEY, saved);
    } else {
      this.ctx.storage.delete(STORAGE_MATCH_CHECKPOINT_KEY);
    }
  }

  private currentMatch(): TerminalMatch | null {
    const matchId = this.engine.getCompletedMatch()?.id;
    if (!matchId) return null;
    if (this.terminalMatch?.record.id !== matchId) {
      const record = this.engine.exportCompletedMatch();
      this.terminalMatch = record ? { record, battleReport: this.engine.exportMatchBattleReportForAi() } : null;
    }
    return this.terminalMatch;
  }

  private unarchivedMatch(): WerewolfMatchRecord | null {
    const match = this.currentMatch()?.record;
    if (!match || this.archivedMatchId === match.id || this.history.records.some(({ id }) => id === match.id)) {
      return null;
    }
    return match;
  }

  private ensureHistoryReadable(): void {
    if (!this.history.state.matchHistoryLoadError) return;
    this.history = readMatchHistory(this.ctx.storage);
    const failure = this.history.state.matchHistoryLoadError;
    if (failure) throw Object.assign(new Error(failure.reason), failure);
    this.publishHistoryState();
  }

  private readReplay(source: WerewolfReplaySource): WerewolfMatchRecord {
    if ("current" in source) {
      const match = this.currentMatch()?.record;
      if (!match) {
        throw new WerewolfRuleError("history.read", "ERR_WEREWOLF_MATCH_NOT_OVER", "当前对局尚未结算");
      }
      return match;
    }
    this.ensureHistoryReadable();
    const record = this.history.records.find(({ id }) => id === source.matchId);
    if (!record) {
      throw new WerewolfRuleError("history.read", "ERR_WEREWOLF_HISTORY_NOT_FOUND", "找不到该局历史记录");
    }
    if (record.replay && this.pendingMvpReviews.has(record.id)) {
      return { ...record, replay: { ...record.replay, review: { status: "generating", text: null, error: null } } };
    }
    return record;
  }

  private writeMatchHistory(
    records: readonly WerewolfMatchRecord[],
    stage: "history.write" | "history.delete" | "history.mvp",
  ): void {
    try {
      this.ctx.storage.set(STORAGE_MATCH_HISTORY_KEY, records);
    } catch (error) {
      rethrowWithStage(error, stage, "ERR_WEREWOLF_HISTORY_WRITE");
    }
    this.history = projectMatchHistory(records);
    this.matchHistoryVersion += 1;
  }

  private publishHistoryState(): void {
    this.ctx.setState({ ...this.ctx.getState(), ...this.history.state, matchHistoryVersion: this.matchHistoryVersion });
  }

  private clearCheckpoint(): void {
    if (this.engine.getCompletedMatch()) this.ensureHistoryReadable();
    const match = this.unarchivedMatch();
    if (match) {
      const records = [match, ...this.history.records].sort((a, b) => b.endedAtMs - a.endedAtMs);
      this.writeMatchHistory(records, "history.write");
      this.archivedMatchId = match.id;
    }
    this.ctx.storage.delete(STORAGE_MATCH_CHECKPOINT_KEY);
    this.terminalCheckpoint = null;
  }

  private deleteMatchRecord(matchId: string): void {
    this.ensureHistoryReadable();
    if (this.engine.getCompletedMatch()?.id === matchId) {
      // Remove any recoverable terminal checkpoint before removing its archive.
      try {
        this.clearCheckpoint();
      } catch (error) {
        rethrowWithStage(error, "history.checkpoint", "ERR_WEREWOLF_HISTORY_CHECKPOINT");
      }
      this.archivedMatchId = matchId;
    }
    const records = this.history.records.filter(({ id }) => id !== matchId);
    if (records.length !== this.history.records.length) this.writeMatchHistory(records, "history.delete");
  }

  private syncResumableSession(): void {
    if (!this.ctx.stage) return;
    const phase = this.engine.getPhase();
    const canResumeFromPause = this.hostPaused && phase !== "idle" && phase !== "lobby";
    if (!canResumeFromPause) {
      this.ctx.stage.setResumableSession(null);
      return;
    }
    const phaseLabel = WEREWOLF_PHASE_LABELS[phase]["zh-CN"];
    const subtitle =
      phase === "game_over"
        ? phaseLabel
        : `第 ${Math.max(1, this.engine.getDay())} 天 · ${phaseLabel}`;
    this.ctx.stage.setResumableSession({
      title: "狼人杀",
      subtitle,
      badgeText: phase === "game_over" ? "查看复盘" : "继续主持",
      onResume: async () => {
        await this.handleCommand({ type: "resume_stage" });
      },
    });
  }

  private syncPublicState(): void {
    if (this.lanSession) {
      this.lastLanPort = this.lanSession.port;
    }
    const lanAddr = this.lanSession
      ? {
          baseUrl: this.lanSession.baseUrl,
          lanIpv4: this.lanSession.lanIpv4,
          port: this.lanSession.port,
        }
      : {
          baseUrl: null,
          lanIpv4: null,
          port: null,
        };
    const lanStatus: WerewolfLanStatus = {
      active: this.lanSession !== null,
      baseUrl: lanAddr.baseUrl,
      lanIpv4: lanAddr.lanIpv4,
      port: lanAddr.port,
      claimedSeats: this.lanCompanion.claimedSeats(),
      error: this.lanError,
    };

    const nextState = this.engine.projectPublicState({
      dealingFaceAligned: this.dealingFaceAligned,
      previewSessionId: this.previewSessionId,
      visionAvailable: this.personTracker !== null,
      lan: lanStatus,
      hostPaused: this.hostPaused,
      voiceStatus: this.speechCoordinator.status(),
      hasResumableMatch: isMatchActivePhase(this.engine.getPhase()),
    });

    if (!nextState.completedMatchId) this.terminalMatch = null;
    this.ctx.setState({ ...nextState, ...this.history.state, matchHistoryVersion: this.matchHistoryVersion });
    this.syncResumableSession();
    this.lanSession?.notifyRevision(nextState.revision);

    // Keep daytime context slice fresh when public events/votes advance
    if (
      this.dayContextScope?.active &&
      !this.engine.isNightPhase() &&
      this.engine.getPhase() !== "idle" &&
      !this.hostPaused &&
      this.ctx.ai
    ) {
      if (this.dayContextDispose) {
        void this.dayContextDispose();
      }
      this.dayContextDispose = this.ctx.ai.useContextSlice(
        {
          summary: this.engine.exportPublicDayContextSummary(),
          priority: 80,
        },
        this.dayContextScope,
      );
    }
  }

  private async teardownAllSubScopes(options?: { readonly clearLanTokens?: boolean }): Promise<void> {
    this.cancelActiveNightTask();
    await this.stopDealingCameraSubscription();
    await this.closeLanRoom({ clearTokens: options?.clearLanTokens ?? true });

    if (this.nightScope) {
      const ns = this.nightScope;
      this.nightScope = null;
      await ns.dispose();
    }
    if (this.dayContextScope) {
      this.dayContextDispose = null;
      const ds = this.dayContextScope;
      this.dayContextScope = null;
      await ds.dispose();
    }
    if (this.stagePresentationDispose) {
      await this.stagePresentationDispose();
      this.stagePresentationDispose = null;
    }
    this.lastPresentationJson = "";
    await this.choreographer.releaseMatchLeases();
    if (this.matchStageScope) {
      const ms = this.matchStageScope;
      this.matchStageScope = null;
      await ms.dispose();
    }
  }
}

export { JudgeSpeechCoordinator } from "./speech-coordinator.js";
export { WerewolfEngine, WerewolfRuleError, type WerewolfMatchCheckpointV1 } from "./engine.js";
export {
  WEREWOLF_DYNAMIC_FACE_RECIPES,
  WerewolfChoreographer,
  computeDeadRoleMaskDelayMs,
  computeFaceCenteringTurn,
  resolveStagePresentation,
} from "./choreography.js";
export { LanCompanionController, renderCompanionMobileHtml } from "./lan-companion.js";
export {
  applyCustomRoleCount,
  buildPresetRules,
  expandDeckFromRoleCounts,
  shuffleRolesCsprng,
  validateRulesConfig,
} from "./presets.js";
