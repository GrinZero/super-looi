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
  WEREWOLF_PLUGIN_ID,
  type WerewolfCommand,
  type WerewolfLanStatus,
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
} from "./engine.js";
import {
  LanCompanionController,
  type CompanionSeatActionPayload,
} from "./lan-companion.js";
import { buildPresetRules, type RandomIntFn } from "./presets.js";

const STORAGE_RULES_KEY = "rules_v1";

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

function toPluginFailure(error: unknown, defaultStage: string): PluginFailure {
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
        : "ERR_WEREWOLF_RUNTIME";
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
    code: "ERR_WEREWOLF_RUNTIME",
    reason: String(error),
  };
}

function rethrowWithStage(error: unknown, defaultStage: string): never {
  if (error instanceof WerewolfRuleError) {
    throw error;
  }
  const failure = toPluginFailure(error, defaultStage);
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
      return bootstrapEngine.projectPublicState({
        dealingFaceAligned: false,
        previewSessionId: null,
        visionAvailable: false,
        lan: {
          active: false,
          baseUrl: null,
          lanIpv4: null,
          port: null,
          claimedSeats: [],
          error: null,
        },
        hostPaused: false,
      });
    },
    create: (ctx) => new WerewolfJudgePluginRuntime(ctx, options),
  };
}

export class WerewolfJudgePluginRuntime
  implements PluginRuntime<WerewolfCommand, WerewolfPublicState>
{
  private readonly engine: WerewolfEngine;
  private readonly choreographer: WerewolfChoreographer;
  private readonly lanCompanion: LanCompanionController;
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

  private speakerInterval: ReturnType<typeof setInterval> | null = null;
  private hostPaused = false;
  private mvpRequestToken = 0;

  constructor(
    private readonly ctx: PluginContext<WerewolfPublicState>,
    private readonly options: WerewolfJudgePluginOptions = {},
  ) {
    const initialRules = readStoredRules(ctx.storage);
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
        this.syncPublicState();
      },
      onAuthenticatedAction: async (seat, payload) => {
        await this.handleCompanionAction(seat, payload);
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
      void this.handleHostStageExited();
    }, this.ctx.scope);

    // 3. Register daytime-safe voice tools
    this.ctx.ai?.useContribution(
      {
        voiceTools: this.buildVoiceTools(),
      },
      this.ctx.scope,
    );

    this.startSpeakerClock();
    this.ctx.scope.onDispose(async () => {
      this.stopSpeakerClock();
      await this.teardownAllSubScopes();
    });

    this.syncPublicState();
  }

  async stop(): Promise<void> {
    this.stopSpeakerClock();
    await this.teardownAllSubScopes();
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

  async handleCommand(command: WerewolfCommand): Promise<WerewolfPublicState> {
    this.ctx.setLastError(undefined);
    try {
      await this.dispatchCommand(command);
      return this.ctx.getState();
    } catch (error) {
      const failure = toPluginFailure(error, `command:${command.type}`);
      this.ctx.setLastError(failure);
      return rethrowWithStage(error, failure.stage);
    }
  }

  // ===========================================================================
  // Command Dispatch
  // ===========================================================================

  private async dispatchCommand(command: WerewolfCommand): Promise<void> {
    switch (command.type) {
      case "open_lobby": {
        this.hostPaused = false;
        this.cancelActiveNightTask();
        const outcome = this.engine.openLobby(command.presetId);
        this.persistRules();
        this.lanCompanion.pruneOutOfRangeClaims(this.engine.getPlayerCount());
        await this.ensureMatchStageMounted();
        if (this.engine.getRules().surfaceMode === "lan_companion") {
          await this.ensureLanRoomOpen();
        }
        await this.applyPostTransitionEffects(outcome);
        return;
      }

      case "resume_stage": {
        this.hostPaused = false;
        if (this.engine.getPhase() === "idle") {
          const outcome = this.engine.openLobby();
          await this.ensureMatchStageMounted();
          await this.applyPostTransitionEffects(outcome);
          return;
        }
        await this.ensureMatchStageMounted();
        this.syncLifecycleScopesForCurrentPhase();
        this.syncDealingCameraSubscription();
        this.choreographer.applyPhaseAtmosphere(this.engine.getPhase());
        this.syncPublicState();
        return;
      }

      case "exit_to_idle": {
        this.hostPaused = false;
        this.cancelActiveNightTask();
        await this.teardownAllSubScopes();
        this.engine.exitToIdle();
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
        this.syncStagePresentation();
        this.syncPublicState();
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
        this.syncPublicState();
        return;
      }

      case "toggle_lan_room": {
        if (command.enabled) {
          await this.ensureLanRoomOpen();
        } else {
          await this.closeLanRoom();
        }
        this.syncPublicState();
        return;
      }

      case "refresh_lan_address": {
        this.lanSession?.refreshAddresses();
        this.syncPublicState();
        return;
      }

      case "start_dealing": {
        this.hostPaused = false;
        this.cancelActiveNightTask();
        await this.ensureMatchStageMounted();
        if (this.engine.getRules().surfaceMode === "lan_companion") {
          await this.ensureLanRoomOpen();
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
          void this.choreographer.pivotClockwiseToNextSeat(
            this.engine.getPlayerCount(),
            this.engine.getRules().motionMode,
          );
        }
        await this.applyPostTransitionEffects(outcome);
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
        void this.choreographer.pivotClockwiseToNextSeat(
          this.engine.getPlayerCount(),
          this.engine.getRules().motionMode,
        );
        await this.applyPostTransitionEffects(outcome);
        return;
      }

      case "toggle_timer_pause": {
        this.engine.toggleTimerPause();
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
        this.cancelActiveNightTask();
        const outcome = this.engine.openLobby();
        await this.ensureMatchStageMounted();
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
    this.syncPublicState();
    void this.speakJudgeLine(closeEyesSpeech);
    await this.choreographer.performAcousticDecoySweep(this.engine.getRules().motionMode);
    await this.applyPostTransitionEffects(nextOutcome);
  }

  private async applyPostTransitionEffects(outcome: EngineTransitionOutcome): Promise<void> {
    this.syncLifecycleScopesForCurrentPhase();
    this.syncDealingCameraSubscription();
    this.syncStagePresentation();
    this.choreographer.applyPhaseAtmosphere(this.engine.getPhase());
    this.syncPublicState();

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
        void this.choreographer.performNightEntrySweep(
          this.engine.getRules().motionMode,
          this.engine.getRules().surfaceMode,
        );
      }
      return;
    }

    if (outcome.gameEnded && this.engine.getPhase() === "game_over") {
      void this.generateEndgameMvpReview();
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
      const next = this.engine.advanceFromNightIntro();
      await this.applyPostTransitionEffects(next);
    })();
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
      const next = this.engine.advanceDecoyNightStep();
      await this.applyPostTransitionEffects(next);
    })();
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
    await this.choreographer.acquireMatchLeases(this.matchStageScope);
    this.syncStagePresentation();
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
    if (serialized === this.lastPresentationJson && this.stagePresentationDispose) {
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
                void this.choreographer.stopWheelPivot();
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
              });
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

  private async ensureLanRoomOpen(): Promise<void> {
    if (this.lanSession) {
      this.lanError = null;
      return;
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
        onRequest: (req) => this.lanCompanion.handleHttpRequest(req),
      });
      this.lanSession = session;
      this.lanError = null;
      scope.onDispose(() => {
        if (this.lanSession === session) {
          this.lanSession = null;
        }
      });
    } catch (error) {
      this.lanScope = null;
      await scope.dispose();
      const failure = toPluginFailure(error, "lan_open");
      this.lanError = failure.reason;
      this.ctx.setLastError(failure);
      return rethrowWithStage(error, "lan_open");
    }
  }

  private async closeLanRoom(): Promise<void> {
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
    this.lanCompanion.clearAllClaims();
  }

  // ===========================================================================
  // Host Exit, Speaker Clock, Voice Tools & Endgame AI MVP Commentary
  // ===========================================================================

  private async handleHostStageExited(): Promise<void> {
    this.hostPaused = true;
    this.cancelActiveNightTask();
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
    this.syncPublicState();
  }

  private startSpeakerClock(): void {
    if (this.speakerInterval || this.speakerTickMs <= 0) return;
    this.speakerInterval = setInterval(() => {
      if (this.hostPaused) return;
      const { expired, remainingSec } = this.engine.tickSpeakerTimer(1);
      if (expired) {
        try {
          const outcome = this.engine.advanceSpeaker();
          void this.applyPostTransitionEffects(outcome);
        } catch {
          // Ignore race if user manually advanced on exact expiry tick
        }
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
        "在 LOOI 首屏舞台打开线下聚会狼人杀准备大厅（支持 6p_joy / 9p_standard / 12p_guard / 12p_idiot 预设）。",
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
    if (this.engine.getPhase() !== "game_over") return;
    if (!this.ctx.ai) {
      const failure: PluginFailure = {
        stage: "mvp_review",
        code: "ERR_WEREWOLF_AI_UNAVAILABLE",
        reason: "AI 后台复盘服务未启用",
      };
      this.engine.setAiMvpReview({
        status: "failed",
        text: null,
        error: `[stage=${failure.stage} code=${String(failure.code)}] ${failure.reason}`,
      });
      this.syncPublicState();
      return;
    }

    const token = ++this.mvpRequestToken;
    const battleReport = this.engine.exportMatchBattleReportForAi();
    this.engine.setAiMvpReview({
      status: "generating",
      text: null,
      error: null,
    });
    this.syncPublicState();

    const prompt = [
      "你是线下聚会狼人杀的毒舌幽默 AI 法官。请严格根据下方真实战报，在 110 字以内颁出本局【全场 MVP】与一针见血的名场面复盘颁奖词（不要使用 Markdown 标题，直接给出适合语音朗读的精彩中文点评）：",
      "",
      battleReport,
    ].join("\n");

    try {
      const res = await this.ctx.ai.runBackgroundTask(prompt);
      if (token !== this.mvpRequestToken || this.engine.getPhase() !== "game_over") {
        return;
      }
      const reviewText = res.answer.trim();
      if (!reviewText) {
        throw Object.assign(new Error("后台模型返回空复盘文本"), {
          stage: "mvp_review",
          code: "ERR_WEREWOLF_EMPTY_MVP_REVIEW",
        });
      }
      this.engine.setAiMvpReview({
        status: "ready",
        text: reviewText,
        error: null,
      });
      this.syncPublicState();
      void this.speakJudgeLine(reviewText);
    } catch (error) {
      if (token !== this.mvpRequestToken || this.engine.getPhase() !== "game_over") {
        return;
      }
      const failure = toPluginFailure(error, "mvp_review");
      this.ctx.setLastError(failure);
      this.engine.setAiMvpReview({
        status: "failed",
        text: null,
        error: `[stage=${failure.stage} code=${String(failure.code)}] ${failure.reason}`,
      });
      this.syncPublicState();
    }
  }

  private async speakJudgeLine(text: string): Promise<void> {
    if (!this.ctx.ai || !text.trim() || this.hostPaused) return;
    try {
      await this.ctx.ai.speak({
        spokenText: text,
        contextNote: `[${WEREWOLF_PLUGIN_ID}] 法官台词播报`,
        delivery: "when_idle",
      });
    } catch {
      // Voice session may be idle/offline during tabletop tap play; screen state remains authoritative.
    }
  }

  private persistRules(): void {
    this.ctx.storage.set(STORAGE_RULES_KEY, this.engine.getRules());
  }

  private syncPublicState(): void {
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
    });

    this.ctx.setState(nextState);
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

  private async teardownAllSubScopes(): Promise<void> {
    this.cancelActiveNightTask();
    await this.stopDealingCameraSubscription();
    await this.closeLanRoom();

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

export { WerewolfEngine, WerewolfRuleError } from "./engine.js";
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
