import {
  WEREWOLF_PHASE_LABELS,
  WEREWOLF_ROLE_HINTS,
  WEREWOLF_ROLE_LABELS,
  isGodRole,
  isWolfRole,
  type WerewolfAiMvpReview,
  type WerewolfDeathCause,
  type WerewolfJudgeVoiceStatus,
  type WerewolfLanStatus,
  type WerewolfLeaveReason,
  type WerewolfNightPromptPublic,
  type WerewolfPhase,
  type WerewolfPresetId,
  type WerewolfPublicEvent,
  type WerewolfPublicState,
  type WerewolfRole,
  type WerewolfRulesConfig,
  type WerewolfSeatPublicView,
  type WerewolfSeerCheckResult,
  type WerewolfSheriffSubphase,
  type WerewolfTimelineRevealEntry,
  type WerewolfVoteTallyItem,
} from "../contracts.js";
import {
  applyCustomRoleCount,
  buildPresetRules,
  defaultCsprngInt,
  expandDeckFromRoleCounts,
  shuffleRolesCsprng,
  validateRulesConfig,
  type RandomIntFn,
} from "./presets.js";

export class WerewolfRuleError extends Error {
  readonly stage: string;
  readonly code: string;
  readonly reason: string;

  constructor(stage: string, code: string, reason: string) {
    super(`[stage=${stage} code=${code}] ${reason}`);
    this.name = "WerewolfRuleError";
    this.stage = stage;
    this.code = code;
    this.reason = reason;
  }
}

interface InternalSeatState {
  seat: number;
  nickname: string;
  alive: boolean;
  role: WerewolfRole | null;
  dealtConfirmed: boolean;
  portraitDataUri: string | null;
  isSheriff: boolean;
  signedUpSheriff: boolean;
  isCandidate: boolean;
  droppedOutSheriff: boolean;
  idiotRevealed: boolean;
  canVote: boolean;
  deathDay: number | null;
  deathPhase: WerewolfDeathCause | null;
  poisonedByWitch: boolean;
}

interface PendingNightDeath {
  readonly seat: number;
  readonly poisoned: boolean;
}

interface LeaveTask {
  readonly seat: number;
  readonly reason: WerewolfLeaveReason;
}

export interface CompanionSeatPrivateView {
  readonly revision: number;
  readonly seat: number;
  readonly nickname: string;
  readonly alive: boolean;
  readonly phase: WerewolfPhase;
  readonly phaseLabel: string;
  readonly sheriffSubphase: WerewolfSheriffSubphase | null;
  readonly day: number;
  readonly myRole: WerewolfRole | null;
  readonly myRoleLabel: string | null;
  readonly myRoleHint: string | null;
  readonly dealtConfirmed: boolean;
  readonly isSheriff: boolean;
  readonly canSelfExplode: boolean;
  readonly speakingSeat: number | null;
  readonly speakingRemainingSec: number;
  readonly sheriffSeat: number | null;
  readonly seats: ReadonlyArray<{
    readonly seat: number;
    readonly nickname: string;
    readonly alive: boolean;
    readonly isSheriff: boolean;
    readonly isCandidate: boolean;
    readonly idiotRevealed: boolean;
    readonly revealedRole: WerewolfRole | null;
  }>;
  readonly actionPrompt:
    | null
    | {
        readonly kind:
          | "confirm_deal"
          | "guard_pick"
          | "wolf_consensus"
          | "witch_act"
          | "seer_check"
          | "seer_ack"
          | "sheriff_signup"
          | "sheriff_drop"
          | "vote_ballot"
          | "hunter_shoot"
          | "sheriff_transfer"
          | "white_wolf_drag";
        readonly selectableSeats: readonly number[];
        readonly canSkip: boolean;
        readonly selectedTargetSeat?: number | null;
        readonly wolfTeammates?: ReadonlyArray<{
          readonly seat: number;
          readonly role: WerewolfRole;
          readonly alive: boolean;
          readonly selectedTarget: number | null | undefined;
        }>;
        readonly witchInfo?: {
          readonly attackedSeat: number | null;
          readonly canSave: boolean;
          readonly canPoison: boolean;
        };
        readonly seerHistory?: ReadonlyArray<{
          readonly day: number;
          readonly targetSeat: number;
          readonly isWolf: boolean;
        }>;
        readonly latestSeerResult?: WerewolfSeerCheckResult | null;
        readonly alreadySubmitted?: boolean;
      };
  readonly winner: "good" | "werewolf" | null;
  readonly winReason: string | null;
  readonly publicEvents: readonly WerewolfPublicEvent[];
  readonly aiMvpReviewText: string | null;
}

export interface EngineTransitionOutcome {
  readonly announcement?: string;
  readonly enteredNightRole?: "guard" | "werewolf" | "witch" | "seer" | null;
  /** Internal-only signal for choreography timing mask; NEVER projected to public UI. */
  readonly isDeadRoleDecoy?: boolean;
  readonly enteredNightIntro?: boolean;
  readonly exitedNight?: boolean;
  readonly gameEnded?: boolean;
}

export interface WerewolfEngineOptions {
  readonly initialRules?: WerewolfRulesConfig;
  readonly randomInt?: RandomIntFn;
  readonly now?: () => number;
}

export interface WerewolfMatchCheckpointV1 {
  readonly version: 1;
  readonly savedAtMs: number;
  readonly revision: number;
  readonly phase: WerewolfPhase;
  readonly sheriffSubphase: WerewolfSheriffSubphase | null;
  readonly day: number;
  readonly rules: WerewolfRulesConfig;
  readonly seats: ReadonlyArray<InternalSeatState>;
  readonly dealingCurrentSeat: number | null;
  readonly dealingRevealingSeat: number | null;
  readonly dealingHistorySeats: readonly number[];
  readonly currentNightStepIsDecoy: boolean;
  readonly selectedNightDraftTarget: number | null;
  readonly lastGuardedSeat: number | null;
  readonly currentNightGuardTarget: number | null;
  readonly currentNightWolfVotes: ReadonlyArray<readonly [number, number | null]>;
  readonly currentNightWolfTarget: number | null;
  readonly witchAntidoteAvailable: boolean;
  readonly witchPoisonAvailable: boolean;
  readonly currentNightWitchSave: boolean;
  readonly currentNightWitchPoisonTarget: number | null;
  readonly currentNightSeerChecked: boolean;
  readonly currentNightSeerResult: WerewolfSeerCheckResult | null;
  readonly seerHistory: ReadonlyArray<{
    readonly day: number;
    readonly targetSeat: number;
    readonly isWolf: boolean;
  }>;
  readonly pendingNightDeaths: ReadonlyArray<PendingNightDeath>;
  readonly dawnDeathsToday: readonly number[];
  readonly sheriffSeat: number | null;
  readonly speakingOrder: readonly number[];
  readonly speakingIndex: number;
  readonly speakingSeat: number | null;
  readonly speakingRemainingSec: number;
  readonly timerPaused: boolean;
  readonly leaveQueue: ReadonlyArray<LeaveTask>;
  readonly postLeaveDestination: "day_discussion" | "next_night";
  readonly pkCandidates: readonly number[];
  readonly eligibleVoterSeats: readonly number[];
  readonly currentBallots: ReadonlyArray<readonly [number, number | null]>;
  readonly lastPublishedBallots: Readonly<Record<number, number | null>>;
  readonly lastPublishedTallies: ReadonlyArray<WerewolfVoteTallyItem>;
  readonly eventCounter: number;
  readonly publicEvents: ReadonlyArray<WerewolfPublicEvent>;
  readonly truthTimeline: ReadonlyArray<WerewolfTimelineRevealEntry>;
  readonly winner: "good" | "werewolf" | null;
  readonly winReason: string | null;
  readonly aiMvpReview: WerewolfAiMvpReview;
  readonly lastJudgeSpeech: string;
  readonly lanSeatTokens: ReadonlyArray<readonly [number, string]>;
  readonly mutedByHost: boolean;
}

const DEFAULT_VOICE_STATUS: WerewolfJudgeVoiceStatus = {
  speaking: false,
  mutedByHost: false,
  lastSpokenText: null,
  lastInterruptedReason: null,
  degradedToSubtitles: false,
};

const ACTIVE_CHECKPOINT_PHASES = new Set<WerewolfPhase>([
  "dealing",
  "night_intro",
  "night_guard",
  "night_wolf",
  "night_witch",
  "night_seer",
  "dawn_settle",
  "sheriff_election",
  "dawn_announce",
  "leave_resolution",
  "day_discussion",
  "day_voting",
  "day_pk_speech",
  "day_pk_voting",
]);

export class WerewolfEngine {
  private readonly randomInt: RandomIntFn;
  private readonly now: () => number;

  private revision = 1;
  private phase: WerewolfPhase = "idle";
  private sheriffSubphase: WerewolfSheriffSubphase | null = null;
  private day = 0;
  private rules: WerewolfRulesConfig;
  private seats: InternalSeatState[] = [];

  // Dealing state
  private dealingCurrentSeat: number | null = null;
  private dealingRevealingSeat: number | null = null;
  private dealingHistorySeats: number[] = [];

  // Secret night state (strictly encapsulated)
  private nightGateUnlocked = false;
  private currentNightStepIsDecoy = false;
  private selectedNightDraftTarget: number | null = null;
  private lastGuardedSeat: number | null = null;
  private currentNightGuardTarget: number | null = null;
  private currentNightWolfVotes = new Map<number, number | null>();
  private currentNightWolfTarget: number | null = null;
  private witchAntidoteAvailable = true;
  private witchPoisonAvailable = true;
  private currentNightWitchSave = false;
  private currentNightWitchPoisonTarget: number | null = null;
  private currentNightSeerChecked = false;
  private currentNightSeerResult: WerewolfSeerCheckResult | null = null;
  private seerHistory: Array<{ day: number; targetSeat: number; isWolf: boolean }> = [];

  // Dawn & daytime state
  private pendingNightDeaths: PendingNightDeath[] = [];
  private dawnDeathsToday: number[] = [];
  private sheriffSeat: number | null = null;
  private speakingOrder: number[] = [];
  private speakingIndex = 0;
  private speakingSeat: number | null = null;
  private speakingRemainingSec = 0;
  private timerPaused = false;

  // Leave resolution queue
  private leaveQueue: LeaveTask[] = [];
  private postLeaveDestination: "day_discussion" | "next_night" = "day_discussion";

  // Voting state
  private pkCandidates: number[] = [];
  private eligibleVoterSeats: number[] = [];
  private currentBallots = new Map<number, number | null>();
  private lastPublishedBallots: Record<number, number | null> = {};
  private lastPublishedTallies: WerewolfVoteTallyItem[] = [];

  // Logs & Endgame
  private eventCounter = 0;
  private publicEvents: WerewolfPublicEvent[] = [];
  private truthTimeline: WerewolfTimelineRevealEntry[] = [];
  private winner: "good" | "werewolf" | null = null;
  private winReason: string | null = null;
  private aiMvpReview: WerewolfAiMvpReview = {
    status: "idle",
    text: null,
    error: null,
  };
  private lastJudgeSpeech = "";

  constructor(options: WerewolfEngineOptions = {}) {
    this.randomInt = options.randomInt ?? defaultCsprngInt;
    this.now = options.now ?? (() => Date.now());
    this.rules = options.initialRules ?? buildPresetRules("9p_standard");
    this.rebuildSeats(this.rules.playerCount, true);
  }

  // ===========================================================================
  // State Inspection & Safe Projections
  // ===========================================================================

  getPhase(): WerewolfPhase {
    return this.phase;
  }

  getDay(): number {
    return this.day;
  }

  getRules(): WerewolfRulesConfig {
    return this.rules;
  }

  getRevision(): number {
    return this.revision;
  }

  isNightPhase(): boolean {
    return (
      this.phase === "night_intro" ||
      this.phase === "night_guard" ||
      this.phase === "night_wolf" ||
      this.phase === "night_witch" ||
      this.phase === "night_seer"
    );
  }

  isCurrentNightStepDecoy(): boolean {
    return this.currentNightStepIsDecoy;
  }

  getDealingCurrentSeat(): number | null {
    return this.dealingCurrentSeat;
  }

  getSpeakingSeat(): number | null {
    return this.speakingSeat;
  }

  getPlayerCount(): number {
    return this.rules.playerCount;
  }

  /**
   * Internal choreography lookup ONLY for active living night role seat(s) when needed
   * inside anti-cheat movement planner; never exposed to public state.
   */
  getInternalLivingRoleSeats(role: "guard" | "werewolf" | "witch" | "seer"): number[] {
    if (role === "werewolf") {
      return this.seats
        .filter((s) => s.alive && s.role !== null && isWolfRole(s.role))
        .map((s) => s.seat);
    }
    return this.seats
      .filter((s) => s.alive && s.role === role)
      .map((s) => s.seat);
  }

  setSeatPortrait(seat: number, dataUri: string | null): void {
    const target = this.requireSeat(seat, "set_seat_portrait");
    target.portraitDataUri = dataUri;
    this.bumpRevision();
  }

  setAiMvpReview(review: WerewolfAiMvpReview): void {
    this.aiMvpReview = review;
    this.bumpRevision();
  }

  tickSpeakerTimer(deltaSeconds = 1): { expired: boolean; remainingSec: number } {
    if (
      this.timerPaused ||
      this.speakingSeat === null ||
      (this.phase !== "day_discussion" &&
        this.phase !== "day_pk_speech" &&
        !(
          this.phase === "sheriff_election" &&
          (this.sheriffSubphase === "speech" || this.sheriffSubphase === "pk_speech")
        ))
    ) {
      return { expired: false, remainingSec: this.speakingRemainingSec };
    }
    this.speakingRemainingSec = Math.max(0, this.speakingRemainingSec - deltaSeconds);
    this.bumpRevision();
    return {
      expired: this.speakingRemainingSec === 0,
      remainingSec: this.speakingRemainingSec,
    };
  }

  projectPublicState(extras: {
    readonly dealingFaceAligned: boolean;
    readonly previewSessionId: string | null;
    readonly visionAvailable: boolean;
    readonly lan: WerewolfLanStatus;
    readonly hostPaused: boolean;
    readonly voiceStatus?: WerewolfJudgeVoiceStatus;
    readonly hasResumableMatch?: boolean;
  }): WerewolfPublicState {
    const claimedSet = new Set(extras.lan.claimedSeats);
    const isGameOver = this.phase === "game_over";

    const publicSeats: WerewolfSeatPublicView[] = this.seats.map((s) => {
      let revealedRole: WerewolfRole | null = null;
      if (isGameOver) {
        revealedRole = s.role;
      } else if (s.idiotRevealed && s.role === "idiot") {
        revealedRole = "idiot";
      } else if (
        this.phase === "dealing" &&
        this.dealingCurrentSeat === s.seat &&
        this.dealingRevealingSeat === s.seat
      ) {
        revealedRole = s.role;
      }

      return {
        seat: s.seat,
        nickname: s.nickname,
        alive: s.alive,
        dealtConfirmed: s.dealtConfirmed,
        lanClaimed: claimedSet.has(s.seat),
        portraitDataUri: s.portraitDataUri,
        isSheriff: s.isSheriff,
        isCandidate: s.isCandidate,
        droppedOutSheriff: s.droppedOutSheriff,
        idiotRevealed: s.idiotRevealed,
        canVote: s.canVote,
        deathDay: s.deathDay,
        deathPhase: s.deathPhase,
        revealedRole,
      };
    });

    const nightPrompt = this.buildPublicNightPrompt();
    const pendingLeave = this.leaveQueue[0] ?? null;

    const votingInProgress =
      this.phase === "day_voting" ||
      this.phase === "day_pk_voting" ||
      (this.phase === "sheriff_election" &&
        (this.sheriffSubphase === "voting" || this.sheriffSubphase === "pk_voting"));

    let votesByVoter: Record<number, number | null> = {};
    let voteTallies: WerewolfVoteTallyItem[] = [];
    if (votingInProgress) {
      if (this.rules.surfaceMode === "on_device") {
        for (const [voter, target] of this.currentBallots.entries()) {
          votesByVoter[voter] = target;
        }
        voteTallies = this.computeTalliesFromBallots(
          this.currentBallots,
          this.phase !== "sheriff_election",
        );
      } else {
        // Secret LAN ballot in progress: hide who voted for whom until finalized.
        votesByVoter = {};
        voteTallies = [];
      }
    } else {
      votesByVoter = { ...this.lastPublishedBallots };
      voteTallies = [...this.lastPublishedTallies];
    }

    return {
      revision: this.revision,
      phase: this.phase,
      sheriffSubphase: this.sheriffSubphase,
      day: this.day,
      rules: this.rules,
      seats: publicSeats,
      dealingCurrentSeat: this.dealingCurrentSeat,
      dealingRevealingSeat: this.dealingRevealingSeat,
      dealingFaceAligned: extras.dealingFaceAligned,
      previewSessionId: extras.previewSessionId,
      visionAvailable: extras.visionAvailable,
      nightPrompt,
      sheriffSeat: this.sheriffSeat,
      speakingSeat: this.speakingSeat,
      speakingOrder: [...this.speakingOrder],
      speakingRemainingSec: this.speakingRemainingSec,
      timerPaused: this.timerPaused,
      pendingLeaveSeat: pendingLeave?.seat ?? null,
      pendingLeaveReason: pendingLeave?.reason ?? null,
      dawnDeathsToday: [...this.dawnDeathsToday],
      pkCandidates: [...this.pkCandidates],
      votesByVoter,
      voteTallies,
      votedSeats: Array.from(this.currentBallots.keys()).sort((a, b) => a - b),
      eligibleVoterSeats: [...this.eligibleVoterSeats],
      lan: extras.lan,
      publicEvents: [...this.publicEvents],
      winner: this.winner,
      winReason: this.winReason,
      fullTimelineReveal: isGameOver ? [...this.truthTimeline] : [],
      aiMvpReview: this.aiMvpReview,
      hostPaused: extras.hostPaused,
      lastJudgeSpeech: this.lastJudgeSpeech,
      voiceStatus: extras.voiceStatus ?? DEFAULT_VOICE_STATUS,
      hasResumableMatch: extras.hasResumableMatch ?? false,
      canStepBackDeal:
        this.phase === "dealing" && this.dealingHistorySeats.length > 0,
    };
  }

  exportCheckpoint(runtimeExtras: {
    readonly lanSeatTokens: ReadonlyArray<readonly [number, string]>;
    readonly mutedByHost: boolean;
  }): WerewolfMatchCheckpointV1 | null {
    if (!ACTIVE_CHECKPOINT_PHASES.has(this.phase)) {
      return null;
    }
    return structuredClone({
      version: 1 as const,
      savedAtMs: this.now(),
      revision: this.revision,
      phase: this.phase,
      sheriffSubphase: this.sheriffSubphase,
      day: this.day,
      rules: this.rules,
      // Strip ephemeral camera base64 portraits so persisted SQLite checkpoints stay compact
      seats: this.seats.map((s) => ({ ...s, portraitDataUri: null })),
      dealingCurrentSeat: this.dealingCurrentSeat,
      dealingRevealingSeat: null,
      dealingHistorySeats: this.dealingHistorySeats,
      currentNightStepIsDecoy: this.currentNightStepIsDecoy,
      selectedNightDraftTarget: this.selectedNightDraftTarget,
      lastGuardedSeat: this.lastGuardedSeat,
      currentNightGuardTarget: this.currentNightGuardTarget,
      currentNightWolfVotes: Array.from(this.currentNightWolfVotes.entries()),
      currentNightWolfTarget: this.currentNightWolfTarget,
      witchAntidoteAvailable: this.witchAntidoteAvailable,
      witchPoisonAvailable: this.witchPoisonAvailable,
      currentNightWitchSave: this.currentNightWitchSave,
      currentNightWitchPoisonTarget: this.currentNightWitchPoisonTarget,
      currentNightSeerChecked: this.currentNightSeerChecked,
      currentNightSeerResult: this.currentNightSeerResult,
      seerHistory: this.seerHistory,
      pendingNightDeaths: this.pendingNightDeaths,
      dawnDeathsToday: this.dawnDeathsToday,
      sheriffSeat: this.sheriffSeat,
      speakingOrder: this.speakingOrder,
      speakingIndex: this.speakingIndex,
      speakingSeat: this.speakingSeat,
      speakingRemainingSec: this.speakingRemainingSec,
      timerPaused: this.timerPaused,
      leaveQueue: this.leaveQueue,
      postLeaveDestination: this.postLeaveDestination,
      pkCandidates: this.pkCandidates,
      eligibleVoterSeats: this.eligibleVoterSeats,
      currentBallots: Array.from(this.currentBallots.entries()),
      lastPublishedBallots: this.lastPublishedBallots,
      lastPublishedTallies: this.lastPublishedTallies,
      eventCounter: this.eventCounter,
      publicEvents: this.publicEvents,
      truthTimeline: this.truthTimeline,
      winner: this.winner,
      winReason: this.winReason,
      aiMvpReview: this.aiMvpReview,
      lastJudgeSpeech: this.lastJudgeSpeech,
      lanSeatTokens: runtimeExtras.lanSeatTokens,
      mutedByHost: runtimeExtras.mutedByHost,
    });
  }

  restoreCheckpoint(raw: unknown):
    | {
        readonly restored: true;
        readonly lanSeatTokens: ReadonlyArray<readonly [number, string]>;
        readonly mutedByHost: boolean;
      }
    | { readonly restored: false; readonly reason: string } {
    if (!raw || typeof raw !== "object") {
      return { restored: false, reason: "checkpoint_empty_or_non_object" };
    }
    const ck = raw as Partial<WerewolfMatchCheckpointV1>;
    if (ck.version !== 1) {
      return { restored: false, reason: `unsupported_checkpoint_version:${String(ck.version)}` };
    }
    if (!ck.phase || !ACTIVE_CHECKPOINT_PHASES.has(ck.phase)) {
      return { restored: false, reason: `non_active_checkpoint_phase:${String(ck.phase)}` };
    }
    if (!ck.rules || !Array.isArray(ck.seats) || ck.seats.length !== ck.rules.playerCount) {
      return { restored: false, reason: "checkpoint_seat_rule_mismatch" };
    }

    const cloned = structuredClone(ck as WerewolfMatchCheckpointV1);
    this.revision = Math.max(1, cloned.revision);
    this.phase = cloned.phase;
    this.sheriffSubphase = cloned.sheriffSubphase ?? null;
    this.day = cloned.day;
    this.rules = cloned.rules;
    this.seats = cloned.seats.map((s) => ({ ...s }));
    this.dealingCurrentSeat = cloned.dealingCurrentSeat;
    // Privacy invariant: never flash a secret card or unlocked night gate on cold resume.
    this.dealingRevealingSeat = null;
    this.dealingHistorySeats = [...(cloned.dealingHistorySeats ?? [])];
    this.nightGateUnlocked = false;
    this.currentNightStepIsDecoy = Boolean(cloned.currentNightStepIsDecoy);
    this.selectedNightDraftTarget = cloned.selectedNightDraftTarget ?? null;
    this.lastGuardedSeat = cloned.lastGuardedSeat ?? null;
    this.currentNightGuardTarget = cloned.currentNightGuardTarget ?? null;
    this.currentNightWolfVotes = new Map(cloned.currentNightWolfVotes ?? []);
    this.currentNightWolfTarget = cloned.currentNightWolfTarget ?? null;
    this.witchAntidoteAvailable = Boolean(cloned.witchAntidoteAvailable);
    this.witchPoisonAvailable = Boolean(cloned.witchPoisonAvailable);
    this.currentNightWitchSave = Boolean(cloned.currentNightWitchSave);
    this.currentNightWitchPoisonTarget = cloned.currentNightWitchPoisonTarget ?? null;
    this.currentNightSeerChecked = Boolean(cloned.currentNightSeerChecked);
    this.currentNightSeerResult = cloned.currentNightSeerResult ?? null;
    this.seerHistory = [...(cloned.seerHistory ?? [])];
    this.pendingNightDeaths = [...(cloned.pendingNightDeaths ?? [])];
    this.dawnDeathsToday = [...(cloned.dawnDeathsToday ?? [])];
    this.sheriffSeat = cloned.sheriffSeat ?? null;
    this.speakingOrder = [...(cloned.speakingOrder ?? [])];
    this.speakingIndex = cloned.speakingIndex ?? 0;
    this.speakingSeat = cloned.speakingSeat ?? null;
    this.speakingRemainingSec = cloned.speakingRemainingSec ?? 0;
    this.timerPaused = Boolean(cloned.timerPaused);
    this.leaveQueue = [...(cloned.leaveQueue ?? [])];
    this.postLeaveDestination = cloned.postLeaveDestination ?? "day_discussion";
    this.pkCandidates = [...(cloned.pkCandidates ?? [])];
    this.eligibleVoterSeats = [...(cloned.eligibleVoterSeats ?? [])];
    this.currentBallots = new Map(cloned.currentBallots ?? []);
    this.lastPublishedBallots = { ...(cloned.lastPublishedBallots ?? {}) };
    this.lastPublishedTallies = [...(cloned.lastPublishedTallies ?? [])];
    this.eventCounter = cloned.eventCounter ?? 0;
    this.publicEvents = [...(cloned.publicEvents ?? [])];
    this.truthTimeline = [...(cloned.truthTimeline ?? [])];
    this.winner = cloned.winner ?? null;
    this.winReason = cloned.winReason ?? null;
    this.aiMvpReview = cloned.aiMvpReview ?? { status: "idle", text: null, error: null };
    this.lastJudgeSpeech = cloned.lastJudgeSpeech ?? "";
    return {
      restored: true,
      lanSeatTokens: cloned.lanSeatTokens ?? [],
      mutedByHost: Boolean(cloned.mutedByHost),
    };
  }

  projectCompanionSeatView(seatNumber: number): CompanionSeatPrivateView {
    const me = this.requireSeat(seatNumber, "companion_view");
    const isGameOver = this.phase === "game_over";
    const myRole = this.phase === "idle" || this.phase === "lobby" ? null : me.role;

    const seatsSummary = this.seats.map((s) => ({
      seat: s.seat,
      nickname: s.nickname,
      alive: s.alive,
      isSheriff: s.isSheriff,
      isCandidate: s.isCandidate,
      idiotRevealed: s.idiotRevealed,
      revealedRole: isGameOver
        ? s.role
        : s.idiotRevealed && s.role === "idiot"
          ? ("idiot" as const)
          : null,
    }));

    return {
      revision: this.revision,
      seat: me.seat,
      nickname: me.nickname,
      alive: me.alive,
      phase: this.phase,
      phaseLabel: WEREWOLF_PHASE_LABELS[this.phase]["zh-CN"],
      sheriffSubphase: this.sheriffSubphase,
      day: this.day,
      myRole,
      myRoleLabel: myRole ? WEREWOLF_ROLE_LABELS[myRole]["zh-CN"] : null,
      myRoleHint: myRole ? WEREWOLF_ROLE_HINTS[myRole]["zh-CN"] : null,
      dealtConfirmed: me.dealtConfirmed,
      isSheriff: me.isSheriff,
      canSelfExplode:
        me.alive &&
        me.role !== null &&
        isWolfRole(me.role) &&
        (this.phase === "sheriff_election" ||
          this.phase === "dawn_announce" ||
          this.phase === "day_discussion"),
      speakingSeat: this.speakingSeat,
      speakingRemainingSec: this.speakingRemainingSec,
      sheriffSeat: this.sheriffSeat,
      seats: seatsSummary,
      actionPrompt: this.buildCompanionActionPrompt(me),
      winner: this.winner,
      winReason: this.winReason,
      publicEvents: this.publicEvents.slice(-12),
      aiMvpReviewText: this.aiMvpReview.text,
    };
  }

  /**
   * 100% public-only daytime context summary for `ctx.ai.useContextSlice`.
   * Contains ZERO secret role or night action data.
   */
  exportPublicDayContextSummary(): string {
    const living = this.seats.filter((s) => s.alive).map((s) => `${s.seat}号(${s.nickname})`);
    const out = this.seats
      .filter((s) => !s.alive)
      .map((s) => `${s.seat}号(第${s.deathDay ?? "?"}天${s.deathPhase ?? "出局"})`);
    const recentLogs = this.publicEvents
      .slice(-8)
      .map((ev) => `- [第${ev.day}天] ${ev.text}`)
      .join("\n");
    return [
      `[狼人杀公开台面状态] 第 ${this.day} 天 · ${WEREWOLF_PHASE_LABELS[this.phase]["zh-CN"]}`,
      `存活座位(${living.length}人): ${living.join("、") || "无"}`,
      `已出局座位(${out.length}人): ${out.join("、") || "无"}`,
      `当前警长: ${this.sheriffSeat ? `${this.sheriffSeat}号` : "无/已流失"}`,
      `当前发言位: ${this.speakingSeat ? `${this.speakingSeat}号（剩余 ${this.speakingRemainingSec}s）` : "非发言环节"}`,
      recentLogs ? `近期公开战报:\n${recentLogs}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * Full truth export for AI Judge MVP commentary ONLY after `phase === "game_over"`.
   */
  exportMatchBattleReportForAi(): string {
    if (this.phase !== "game_over") {
      throw new WerewolfRuleError(
        "mvp_report",
        "ERR_WEREWOLF_MATCH_NOT_OVER",
        "对局尚未结束，禁止导出全量底牌战报",
      );
    }
    const roster = this.seats
      .map((s) => {
        const roleName = s.role ? WEREWOLF_ROLE_LABELS[s.role]["zh-CN"] : "未知";
        const status = s.alive ? "存活到终局" : `第${s.deathDay}天(${s.deathPhase})出局`;
        return `${s.seat}号 ${s.nickname}：底牌【${roleName}】，${status}${s.isSheriff ? "，终局警长" : ""}`;
      })
      .join("\n");
    const truth = this.truthTimeline.map((t) => `[第${t.day}天] ${t.summary}`).join("\n");
    return [
      `胜负结果：${this.winner === "good" ? "好人阵营获胜" : "狼人阵营获胜"}（${this.winReason ?? ""}）`,
      `板子配置：${this.rules.playerCount}人局（${this.rules.winMode === "slaughter_all" ? "屠城" : "屠边"}）`,
      `全员底牌：\n${roster}`,
      `真实全量时间轴：\n${truth}`,
    ].join("\n\n");
  }

  // ===========================================================================
  // Lobby & Dealing Transitions
  // ===========================================================================

  openLobby(presetId?: WerewolfPresetId): EngineTransitionOutcome {
    if (presetId && presetId !== "custom") {
      this.rules = buildPresetRules(presetId, {
        surfaceMode: this.rules.surfaceMode,
        motionMode: this.rules.motionMode,
      });
    }
    this.resetMatchFields();
    this.phase = "lobby";
    this.rebuildSeats(this.rules.playerCount, true);
    const announcement = `欢迎来到狼人杀房间，当前为 ${this.rules.playerCount} 人局，请入座准备。`;
    this.lastJudgeSpeech = announcement;
    this.bumpRevision();
    return { announcement };
  }

  exitToIdle(): void {
    this.resetMatchFields();
    this.phase = "idle";
    this.lastJudgeSpeech = "";
    this.bumpRevision();
  }

  selectPreset(presetId: WerewolfPresetId): void {
    this.assertLobbyEditable("select_preset");
    if (presetId === "custom") {
      this.rules = { ...this.rules, presetId: "custom" };
    } else {
      this.rules = buildPresetRules(presetId, {
        surfaceMode: this.rules.surfaceMode,
        motionMode: this.rules.motionMode,
      });
      this.rebuildSeats(this.rules.playerCount, true);
    }
    this.bumpRevision();
  }

  updateRules(patch: Partial<WerewolfRulesConfig>): void {
    // Allow switching motionMode or surfaceMode safely in lobby (and motionMode anytime).
    if (this.phase !== "idle" && this.phase !== "lobby" && this.phase !== "game_over") {
      const allowedLiveKeys = new Set(["motionMode", "speechSeconds"]);
      const illegal = Object.keys(patch).filter((k) => !allowedLiveKeys.has(k));
      if (illegal.length > 0) {
        throw new WerewolfRuleError(
          "update_rules",
          "ERR_WEREWOLF_RULES_LOCKED_IN_MATCH",
          `对局进行中不可修改板子规则字段: ${illegal.join(", ")}`,
        );
      }
    }
    const nextRules: WerewolfRulesConfig = {
      ...this.rules,
      ...patch,
      roleCounts: patch.roleCounts
        ? { ...this.rules.roleCounts, ...patch.roleCounts }
        : this.rules.roleCounts,
    };
    this.rules = nextRules;
    if (
      (this.phase === "idle" || this.phase === "lobby") &&
      nextRules.playerCount !== this.seats.length
    ) {
      this.rebuildSeats(nextRules.playerCount, true);
    }
    this.bumpRevision();
  }

  setRoleCount(role: WerewolfRole, count: number): void {
    this.assertLobbyEditable("set_role_count");
    this.rules = applyCustomRoleCount(this.rules, role, count);
    if (this.rules.playerCount !== this.seats.length) {
      this.rebuildSeats(this.rules.playerCount, true);
    }
    this.bumpRevision();
  }

  setSeatNickname(seat: number, nickname: string): void {
    const target = this.requireSeat(seat, "set_seat_nickname");
    const trimmed = nickname.trim().slice(0, 16);
    target.nickname = trimmed || `${seat}号玩家`;
    this.bumpRevision();
  }

  startDealing(options?: {
    readonly fixedRolesBySeat?: Readonly<Record<number, WerewolfRole>>;
  }): EngineTransitionOutcome {
    if (this.phase !== "lobby" && this.phase !== "idle" && this.phase !== "game_over") {
      throw new WerewolfRuleError(
        "start_dealing",
        "ERR_WEREWOLF_INVALID_PHASE",
        `当前阶段 ${this.phase} 无法重新发牌`,
      );
    }
    const check = validateRulesConfig(this.rules);
    if (!check.valid) {
      throw new WerewolfRuleError(check.stage, check.code, check.reason);
    }

    if (options?.fixedRolesBySeat) {
      for (let seat = 1; seat <= this.rules.playerCount; seat += 1) {
        if (!options.fixedRolesBySeat[seat]) {
          throw new WerewolfRuleError(
            "start_dealing",
            "ERR_WEREWOLF_INCOMPLETE_FIXED_DECK",
            `测试固定牌组缺少 ${seat} 号座位身份`,
          );
        }
      }
    }

    this.resetMatchFields();
    this.rebuildSeats(this.rules.playerCount, true);

    if (options?.fixedRolesBySeat) {
      for (const s of this.seats) {
        s.role = options.fixedRolesBySeat[s.seat]!;
      }
    } else {
      const deck = expandDeckFromRoleCounts(this.rules.roleCounts);
      const shuffled = shuffleRolesCsprng(deck, this.randomInt);
      for (let i = 0; i < this.seats.length; i += 1) {
        this.seats[i]!.role = shuffled[i]!;
      }
    }

    this.day = 1;
    this.phase = "dealing";
    this.dealingCurrentSeat = 1;
    this.dealingRevealingSeat = null;
    this.recordTruth(
      1,
      `完成洗牌发牌：${this.seats
        .map((s) => `${s.seat}号=${WEREWOLF_ROLE_LABELS[s.role!]["zh-CN"]}`)
        .join("，")}`,
      this.seats.map((s) => s.seat),
    );
    const announcement =
      this.rules.surfaceMode === "lan_companion"
        ? "底牌已下发至各位手机副屏，我将依次环视认座，请确认各自身份。"
        : "开始顺时针发牌，请 1 号玩家正对屏幕，按住防窥盾查看底牌。";
    this.addPublicEvent(announcement);
    this.lastJudgeSpeech = announcement;
    this.bumpRevision();
    return { announcement };
  }

  setDealReveal(seat: number, revealing: boolean): void {
    if (this.phase !== "dealing") {
      throw new WerewolfRuleError(
        "set_deal_reveal",
        "ERR_WEREWOLF_INVALID_PHASE",
        "仅发牌阶段可按住查看底牌",
      );
    }
    if (this.dealingCurrentSeat !== seat) {
      throw new WerewolfRuleError(
        "set_deal_reveal",
        "ERR_WEREWOLF_WRONG_DEALING_SEAT",
        `当前轮到 ${this.dealingCurrentSeat} 号领牌，${seat} 号不可越序查看`,
      );
    }
    this.dealingRevealingSeat = revealing ? seat : null;
    this.bumpRevision();
  }

  confirmSeatDealt(seat: number): EngineTransitionOutcome {
    if (this.phase !== "dealing") {
      throw new WerewolfRuleError(
        "confirm_seat_dealt",
        "ERR_WEREWOLF_INVALID_PHASE",
        "当前不在发牌阶段",
      );
    }
    const target = this.requireSeat(seat, "confirm_seat_dealt");
    // In on_device mode enforce sequential order; in lan_companion allow parallel phone confirmations!
    if (
      this.rules.surfaceMode === "on_device" &&
      this.dealingCurrentSeat !== null &&
      this.dealingCurrentSeat !== seat
    ) {
      throw new WerewolfRuleError(
        "confirm_seat_dealt",
        "ERR_WEREWOLF_WRONG_DEALING_SEAT",
        `请先由 ${this.dealingCurrentSeat} 号确认领牌`,
      );
    }

    target.dealtConfirmed = true;
    this.dealingHistorySeats.push(seat);
    if (this.dealingRevealingSeat === seat) {
      this.dealingRevealingSeat = null;
    }

    const nextUnconfirmed = this.seats.find((s) => !s.dealtConfirmed);
    this.dealingCurrentSeat = nextUnconfirmed ? nextUnconfirmed.seat : null;
    this.bumpRevision();

    if (!nextUnconfirmed) {
      const announcement = "全员领牌完毕，准备进入第一夜。";
      this.lastJudgeSpeech = announcement;
      return { announcement };
    }
    const announcement = `请 ${nextUnconfirmed.seat} 号玩家确认底牌。`;
    this.lastJudgeSpeech = announcement;
    return { announcement };
  }

  stepBackDeal(): EngineTransitionOutcome {
    if (this.phase !== "dealing") {
      throw new WerewolfRuleError(
        "step_back_deal",
        "ERR_WEREWOLF_INVALID_PHASE",
        "仅发牌阶段支持退回上一位",
      );
    }
    const prevSeat = this.dealingHistorySeats.pop();
    if (prevSeat === undefined) {
      throw new WerewolfRuleError(
        "step_back_deal",
        "ERR_WEREWOLF_CANNOT_STEP_BACK",
        "当前已经是第一位玩家，无法继续回退",
      );
    }
    const target = this.requireSeat(prevSeat, "step_back_deal");
    target.dealtConfirmed = false;
    this.dealingCurrentSeat = prevSeat;
    this.dealingRevealingSeat = null;
    const announcement = `已退回至 ${prevSeat} 号玩家，请重新查看并确认底牌。`;
    this.lastJudgeSpeech = announcement;
    this.bumpRevision();
    return { announcement };
  }

  beginFirstNight(): EngineTransitionOutcome {
    if (this.phase !== "dealing") {
      throw new WerewolfRuleError(
        "begin_first_night",
        "ERR_WEREWOLF_INVALID_PHASE",
        "仅发牌阶段完成后可进入首夜",
      );
    }
    for (const s of this.seats) {
      s.dealtConfirmed = true;
    }
    this.dealingCurrentSeat = null;
    this.dealingRevealingSeat = null;
    this.dealingHistorySeats = [];
    return this.enterNight(1);
  }

  // ===========================================================================
  // Night Phases & Anti-Cheat Decoy Progression
  // ===========================================================================

  setNightGate(unlocked: boolean): void {
    if (!this.isNightPhase() || this.phase === "night_intro") {
      this.nightGateUnlocked = false;
      this.bumpRevision();
      return;
    }
    // Never unlock private data during a dead-role decoy window!
    if (this.currentNightStepIsDecoy) {
      this.nightGateUnlocked = false;
      this.bumpRevision();
      return;
    }
    this.nightGateUnlocked = unlocked;
    this.bumpRevision();
  }

  selectNightTarget(targetSeat: number | null): void {
    if (!this.isNightPhase()) {
      throw new WerewolfRuleError(
        "select_night_target",
        "ERR_WEREWOLF_INVALID_PHASE",
        "当前不在夜晚阶段",
      );
    }
    this.selectedNightDraftTarget = targetSeat;
    this.bumpRevision();
  }

  advanceFromNightIntro(): EngineTransitionOutcome {
    if (this.phase !== "night_intro") {
      throw new WerewolfRuleError(
        "advance_night_intro",
        "ERR_WEREWOLF_INVALID_PHASE",
        "当前不在入夜引导阶段",
      );
    }
    return this.enterNextNightRoleAfter("night_intro");
  }

  /**
   * Invoked automatically by choreography after the `6–9s` jittered timing mask
   * when the current night role on the board is secretly dead.
   */
  advanceDecoyNightStep(): EngineTransitionOutcome {
    if (
      this.phase !== "night_guard" &&
      this.phase !== "night_witch" &&
      this.phase !== "night_seer"
    ) {
      throw new WerewolfRuleError(
        "advance_decoy_night_step",
        "ERR_WEREWOLF_INVALID_PHASE",
        `阶段 ${this.phase} 不支持伪装空窗推进`,
      );
    }
    if (!this.currentNightStepIsDecoy) {
      throw new WerewolfRuleError(
        "advance_decoy_night_step",
        "ERR_WEREWOLF_NOT_DECOY_STEP",
        "当前夜晚角色仍存活，必须由玩家提交动作",
      );
    }
    const from = this.phase;
    return this.enterNextNightRoleAfter(from);
  }

  submitGuardAction(targetSeat: number | null, actorSeat?: number): EngineTransitionOutcome {
    this.assertPhase("night_guard", "submit_guard_action");
    if (this.currentNightStepIsDecoy) {
      return this.advanceDecoyNightStep();
    }
    if (actorSeat !== undefined) {
      this.assertActorHasRole(actorSeat, "guard", "submit_guard_action");
    }
    if (targetSeat !== null) {
      const target = this.requireLivingSeat(targetSeat, "submit_guard_action");
      if (this.lastGuardedSeat !== null && target.seat === this.lastGuardedSeat) {
        throw new WerewolfRuleError(
          "submit_guard_action",
          "ERR_WEREWOLF_CONSECUTIVE_GUARD",
          `守卫不能连续两晚守护同一名玩家（昨晚已守护 ${this.lastGuardedSeat} 号）`,
        );
      }
      this.currentNightGuardTarget = target.seat;
      this.recordTruth(this.day, `守卫守护了 ${target.seat} 号`, [target.seat]);
    } else {
      this.currentNightGuardTarget = null;
      this.recordTruth(this.day, "守卫选择空守", []);
    }
    this.lastGuardedSeat = this.currentNightGuardTarget;
    this.nightGateUnlocked = false;
    return this.enterNextNightRoleAfter("night_guard");
  }

  /**
   * LAN companion per-wolf target vote; auto-advances when all living wolves reach consensus
   * and `confirm` is true (or `submitWolfAction` is invoked directly on-device).
   */
  submitWolfCompanionVote(
    wolfSeat: number,
    targetSeat: number | null,
    confirm = true,
  ): EngineTransitionOutcome | null {
    this.assertPhase("night_wolf", "submit_wolf_companion_vote");
    const actor = this.requireLivingSeat(wolfSeat, "submit_wolf_companion_vote");
    if (!actor.role || !isWolfRole(actor.role)) {
      throw new WerewolfRuleError(
        "submit_wolf_companion_vote",
        "ERR_WEREWOLF_NOT_A_WOLF",
        `${wolfSeat} 号不是狼人，无权参与狼队袭击决策`,
      );
    }
    if (targetSeat !== null) {
      this.requireLivingSeat(targetSeat, "submit_wolf_companion_vote");
    }
    this.currentNightWolfVotes.set(wolfSeat, targetSeat);
    this.selectedNightDraftTarget = targetSeat;
    this.bumpRevision();

    if (!confirm) return null;

    const livingWolves = this.getInternalLivingRoleSeats("werewolf");
    const allVoted = livingWolves.every((s) => this.currentNightWolfVotes.has(s));
    if (!allVoted) return null;

    const firstChoice = this.currentNightWolfVotes.get(livingWolves[0]!);
    const unanimous = livingWolves.every(
      (s) => this.currentNightWolfVotes.get(s) === firstChoice,
    );
    if (!unanimous) return null;

    return this.submitWolfAction(firstChoice ?? null);
  }

  submitWolfAction(targetSeat: number | null): EngineTransitionOutcome {
    this.assertPhase("night_wolf", "submit_wolf_action");
    if (targetSeat !== null) {
      this.requireLivingSeat(targetSeat, "submit_wolf_action");
      this.currentNightWolfTarget = targetSeat;
      this.recordTruth(this.day, `狼人阵营袭击了 ${targetSeat} 号`, [targetSeat]);
    } else {
      this.currentNightWolfTarget = null;
      this.recordTruth(this.day, "狼人阵营选择空刀", []);
    }
    this.nightGateUnlocked = false;
    return this.enterNextNightRoleAfter("night_wolf");
  }

  submitWitchAction(
    options: { readonly save: boolean; readonly poisonTargetSeat: number | null },
    actorSeat?: number,
  ): EngineTransitionOutcome {
    this.assertPhase("night_witch", "submit_witch_action");
    if (this.currentNightStepIsDecoy) {
      return this.advanceDecoyNightStep();
    }
    if (actorSeat !== undefined) {
      this.assertActorHasRole(actorSeat, "witch", "submit_witch_action");
    }

    const { save, poisonTargetSeat } = options;
    if (save && poisonTargetSeat !== null) {
      throw new WerewolfRuleError(
        "submit_witch_action",
        "ERR_WEREWOLF_DUAL_POTION_FORBIDDEN",
        "女巫同一晚最多只能使用一瓶药水（解药与毒药互斥）",
      );
    }

    if (save) {
      if (!this.witchAntidoteAvailable) {
        throw new WerewolfRuleError(
          "submit_witch_action",
          "ERR_WEREWOLF_NO_ANTIDOTE",
          "女巫解药已用尽",
        );
      }
      if (this.currentNightWolfTarget === null) {
        throw new WerewolfRuleError(
          "submit_witch_action",
          "ERR_WEREWOLF_NO_WOLF_VICTIM",
          "今晚无人被狼人袭击，无法使用解药",
        );
      }
      if (!this.canWitchSaveTarget(this.currentNightWolfTarget)) {
        throw new WerewolfRuleError(
          "submit_witch_action",
          "ERR_WEREWOLF_SELF_SAVE_FORBIDDEN",
          "当前板子规则禁止女巫在此回合自救",
        );
      }
      this.witchAntidoteAvailable = false;
      this.currentNightWitchSave = true;
      this.recordTruth(
        this.day,
        `女巫对 ${this.currentNightWolfTarget} 号使用了解药`,
        [this.currentNightWolfTarget],
      );
    }

    if (poisonTargetSeat !== null) {
      if (!this.witchPoisonAvailable) {
        throw new WerewolfRuleError(
          "submit_witch_action",
          "ERR_WEREWOLF_NO_POISON",
          "女巫毒药已用尽",
        );
      }
      const victim = this.requireLivingSeat(poisonTargetSeat, "submit_witch_action");
      this.witchPoisonAvailable = false;
      this.currentNightWitchPoisonTarget = victim.seat;
      this.recordTruth(this.day, `女巫对 ${victim.seat} 号使用了毒药`, [victim.seat]);
    }

    if (!save && poisonTargetSeat === null) {
      this.recordTruth(this.day, "女巫选择不用药", []);
    }

    this.nightGateUnlocked = false;
    return this.enterNextNightRoleAfter("night_witch");
  }

  submitSeerCheck(targetSeat: number, actorSeat?: number): WerewolfSeerCheckResult {
    this.assertPhase("night_seer", "submit_seer_check");
    if (this.currentNightStepIsDecoy) {
      throw new WerewolfRuleError(
        "submit_seer_check",
        "ERR_WEREWOLF_SEER_DEAD",
        "当前预言家已出局",
      );
    }
    const seerSeats = this.getInternalLivingRoleSeats("seer");
    const seerSeat = seerSeats[0] ?? null;
    if (actorSeat !== undefined && actorSeat !== seerSeat) {
      throw new WerewolfRuleError(
        "submit_seer_check",
        "ERR_WEREWOLF_WRONG_ROLE",
        `${actorSeat} 号不是预言家`,
      );
    }
    if (this.currentNightSeerChecked && this.currentNightSeerResult) {
      return this.currentNightSeerResult;
    }
    const target = this.requireLivingSeat(targetSeat, "submit_seer_check");
    if (target.seat === seerSeat) {
      throw new WerewolfRuleError(
        "submit_seer_check",
        "ERR_WEREWOLF_INVALID_SEER_TARGET",
        "预言家不能查验自己，请选择其他存活座位",
      );
    }
    const isWolf = target.role !== null && isWolfRole(target.role);
    const result: WerewolfSeerCheckResult = { targetSeat: target.seat, isWolf };
    this.currentNightSeerChecked = true;
    this.currentNightSeerResult = result;
    this.seerHistory.push({ day: this.day, targetSeat: target.seat, isWolf });
    this.recordTruth(
      this.day,
      `预言家查验了 ${target.seat} 号，结果为【${isWolf ? "狼人查杀" : "好人金水"}】`,
      [target.seat],
    );
    this.bumpRevision();
    return result;
  }

  finishSeerTurn(actorSeat?: number): EngineTransitionOutcome {
    this.assertPhase("night_seer", "finish_seer_turn");
    if (this.currentNightStepIsDecoy) {
      return this.advanceDecoyNightStep();
    }
    if (actorSeat !== undefined) {
      this.assertActorHasRole(actorSeat, "seer", "finish_seer_turn");
    }
    this.nightGateUnlocked = false;
    this.currentNightSeerResult = null;
    return this.enterNextNightRoleAfter("night_seer");
  }

  // ===========================================================================
  // Sheriff Election, Dawn Death Announcement, Leave Resolution & Day Voting
  // ===========================================================================

  toggleSheriffCandidate(seat: number): void {
    if (this.phase !== "sheriff_election" || this.sheriffSubphase !== "signup") {
      throw new WerewolfRuleError(
        "toggle_sheriff_candidate",
        "ERR_WEREWOLF_INVALID_PHASE",
        "当前不在上警报名环节",
      );
    }
    const player = this.requireLivingSeat(seat, "toggle_sheriff_candidate");
    player.isCandidate = !player.isCandidate;
    player.signedUpSheriff = player.isCandidate;
    this.bumpRevision();
  }

  lockSheriffCandidates(): EngineTransitionOutcome {
    if (this.phase !== "sheriff_election" || this.sheriffSubphase !== "signup") {
      throw new WerewolfRuleError(
        "lock_sheriff_candidates",
        "ERR_WEREWOLF_INVALID_PHASE",
        "当前不在上警报名环节",
      );
    }
    const candidates = this.seats.filter((s) => s.alive && s.isCandidate).map((s) => s.seat);
    if (candidates.length === 0) {
      this.sheriffSubphase = null;
      this.addPublicEvent("无人报名上警，本局警徽流失。");
      this.recordTruth(this.day, "无人上警，警徽流失", []);
      return this.enterDawnAnnounce();
    }
    if (candidates.length === 1) {
      const winnerSeat = candidates[0]!;
      this.assignSheriff(winnerSeat);
      this.sheriffSubphase = null;
      this.addPublicEvent(`仅 ${winnerSeat} 号上警，自动当选警长。`);
      this.recordTruth(this.day, `${winnerSeat} 号单人上警自动当选警长`, [winnerSeat]);
      return this.enterDawnAnnounce();
    }

    // 2+ candidates: check if everyone signed up (0 off-badge voters -> standard rule: if nobody drops out during speech, 0 voters -> badge lost).
    const ordered = this.buildRandomOrderedSeats(candidates);
    this.sheriffSubphase = "speech";
    this.startSpeechQueue(ordered);
    const announcement = `上警玩家为 ${candidates.join("、")} 号，随机由 ${ordered[0]} 号开始竞选发言。`;
    this.addPublicEvent(announcement);
    this.lastJudgeSpeech = announcement;
    this.bumpRevision();
    return { announcement };
  }

  sheriffDropOut(seat: number): EngineTransitionOutcome {
    if (
      this.phase !== "sheriff_election" ||
      (this.sheriffSubphase !== "speech" && this.sheriffSubphase !== "signup")
    ) {
      throw new WerewolfRuleError(
        "sheriff_drop_out",
        "ERR_WEREWOLF_INVALID_PHASE",
        "仅上警报名或竞选发言阶段可退水",
      );
    }
    const target = this.requireSeat(seat, "sheriff_drop_out");
    if (!target.isCandidate) {
      throw new WerewolfRuleError(
        "sheriff_drop_out",
        "ERR_WEREWOLF_NOT_CANDIDATE",
        `${seat} 号并非警上候选人`,
      );
    }
    target.isCandidate = false;
    target.droppedOutSheriff = true;
    this.addPublicEvent(`${seat} 号玩家选择退水。`);
    this.recordTruth(this.day, `${seat} 号警上退水`, [seat]);

    const remaining = this.seats.filter((s) => s.alive && s.isCandidate).map((s) => s.seat);
    if (remaining.length === 0) {
      this.sheriffSubphase = null;
      this.clearSpeechState();
      this.addPublicEvent("警上候选人全部退水，警徽流失。");
      return this.enterDawnAnnounce();
    }
    if (remaining.length === 1) {
      const sole = remaining[0]!;
      this.assignSheriff(sole);
      this.sheriffSubphase = null;
      this.clearSpeechState();
      this.addPublicEvent(`其余候选人退水，${sole} 号自动当选警长。`);
      return this.enterDawnAnnounce();
    }

    // Remove dropped candidate from speakingOrder if they had not finished speaking
    this.speakingOrder = this.speakingOrder.filter((s) => s !== seat);
    if (this.speakingSeat === seat) {
      if (this.speakingIndex >= this.speakingOrder.length) {
        return this.beginSheriffVoting("voting", remaining);
      }
      this.speakingSeat = this.speakingOrder[this.speakingIndex] ?? null;
      this.speakingRemainingSec = this.rules.speechSeconds;
    } else {
      const activeIdx = this.speakingSeat ? this.speakingOrder.indexOf(this.speakingSeat) : -1;
      if (activeIdx >= 0) this.speakingIndex = activeIdx;
    }

    this.bumpRevision();
    return { announcement: `${seat} 号退水，请 ${this.speakingSeat} 号继续发言。` };
  }

  advanceSpeaker(): EngineTransitionOutcome {
    if (this.phase === "sheriff_election") {
      if (this.sheriffSubphase !== "speech" && this.sheriffSubphase !== "pk_speech") {
        throw new WerewolfRuleError(
          "advance_speaker",
          "ERR_WEREWOLF_INVALID_PHASE",
          "当前不在警上发言阶段",
        );
      }
      this.speakingIndex += 1;
      if (this.speakingIndex < this.speakingOrder.length) {
        this.speakingSeat = this.speakingOrder[this.speakingIndex]!;
        this.speakingRemainingSec = this.rules.speechSeconds;
        const announcement = `请 ${this.speakingSeat} 号候选人发言。`;
        this.lastJudgeSpeech = announcement;
        this.bumpRevision();
        return { announcement };
      }
      const candidates =
        this.sheriffSubphase === "pk_speech"
          ? [...this.pkCandidates]
          : this.seats.filter((s) => s.alive && s.isCandidate).map((s) => s.seat);
      return this.beginSheriffVoting(
        this.sheriffSubphase === "pk_speech" ? "pk_voting" : "voting",
        candidates,
      );
    }

    if (this.phase === "day_discussion") {
      this.speakingIndex += 1;
      if (this.speakingIndex < this.speakingOrder.length) {
        this.speakingSeat = this.speakingOrder[this.speakingIndex]!;
        this.speakingRemainingSec = this.rules.speechSeconds;
        const announcement = `请 ${this.speakingSeat} 号玩家发言。`;
        this.lastJudgeSpeech = announcement;
        this.bumpRevision();
        return { announcement };
      }
      return this.startVoting();
    }

    if (this.phase === "day_pk_speech") {
      this.speakingIndex += 1;
      if (this.speakingIndex < this.speakingOrder.length) {
        this.speakingSeat = this.speakingOrder[this.speakingIndex]!;
        this.speakingRemainingSec = this.rules.speechSeconds;
        const announcement = `请平票台上的 ${this.speakingSeat} 号玩家进行 PK 发言。`;
        this.lastJudgeSpeech = announcement;
        this.bumpRevision();
        return { announcement };
      }
      return this.beginDayPkVoting();
    }

    throw new WerewolfRuleError(
      "advance_speaker",
      "ERR_WEREWOLF_INVALID_PHASE",
      `当前阶段 ${this.phase} 没有发言队列`,
    );
  }

  toggleTimerPause(): boolean {
    this.timerPaused = !this.timerPaused;
    this.bumpRevision();
    return this.timerPaused;
  }

  acknowledgeDawn(): EngineTransitionOutcome {
    this.assertPhase("dawn_announce", "acknowledge_dawn");
    return this.proceedAfterDawnAnnounce();
  }

  startVoting(): EngineTransitionOutcome {
    if (this.phase !== "day_discussion" && this.phase !== "dawn_announce") {
      throw new WerewolfRuleError(
        "start_voting",
        "ERR_WEREWOLF_INVALID_PHASE",
        `当前阶段 ${this.phase} 无法直接发起放逐投票`,
      );
    }
    this.clearSpeechState();
    this.phase = "day_voting";
    this.pkCandidates = [];
    this.currentBallots.clear();
    this.eligibleVoterSeats = this.seats
      .filter((s) => s.alive && s.canVote)
      .map((s) => s.seat);
    const announcement = "发言结束，现在开始放逐公投，请选择放逐目标或弃票。";
    this.addPublicEvent(announcement);
    this.lastJudgeSpeech = announcement;
    this.bumpRevision();
    return { announcement };
  }

  castVote(
    voterSeat: number,
    targetSeat: number | null,
    options?: { readonly autoFinalizeWhenAllVoted?: boolean },
  ): EngineTransitionOutcome | null {
    const isSheriffVote =
      this.phase === "sheriff_election" &&
      (this.sheriffSubphase === "voting" || this.sheriffSubphase === "pk_voting");
    const isDayVote = this.phase === "day_voting" || this.phase === "day_pk_voting";

    if (!isSheriffVote && !isDayVote) {
      throw new WerewolfRuleError(
        "cast_vote",
        "ERR_WEREWOLF_INVALID_PHASE",
        `当前阶段 ${this.phase} 不在投票环节`,
      );
    }

    if (!this.eligibleVoterSeats.includes(voterSeat)) {
      throw new WerewolfRuleError(
        "cast_vote",
        "ERR_WEREWOLF_INELIGIBLE_VOTER",
        `${voterSeat} 号在当前投票轮次无投票权`,
      );
    }

    if (targetSeat !== null) {
      const validTargets = this.getValidVoteTargets();
      if (!validTargets.includes(targetSeat)) {
        throw new WerewolfRuleError(
          "cast_vote",
          "ERR_WEREWOLF_INVALID_VOTE_TARGET",
          `${targetSeat} 号不在有效候选目标列表 [${validTargets.join(", ")}] 中`,
        );
      }
    }

    this.currentBallots.set(voterSeat, targetSeat);
    this.bumpRevision();

    if (
      options?.autoFinalizeWhenAllVoted &&
      this.eligibleVoterSeats.length > 0 &&
      this.eligibleVoterSeats.every((s) => this.currentBallots.has(s))
    ) {
      return this.finalizeVotes();
    }
    return null;
  }

  finalizeVotes(): EngineTransitionOutcome {
    const isSheriffVote =
      this.phase === "sheriff_election" &&
      (this.sheriffSubphase === "voting" || this.sheriffSubphase === "pk_voting");
    const isDayVote = this.phase === "day_voting" || this.phase === "day_pk_voting";

    if (!isSheriffVote && !isDayVote) {
      throw new WerewolfRuleError(
        "finalize_votes",
        "ERR_WEREWOLF_INVALID_PHASE",
        `当前阶段 ${this.phase} 无法结算选票`,
      );
    }

    // Default uncast eligible voters to abstain (`null`) when host finalizes tally.
    for (const voter of this.eligibleVoterSeats) {
      if (!this.currentBallots.has(voter)) {
        this.currentBallots.set(voter, null);
      }
    }

    if (isSheriffVote) {
      return this.finalizeSheriffVotes();
    }

    return this.finalizeDayExileVotes();
  }

  resolveHunterShot(targetSeat: number | null, actorSeat?: number): EngineTransitionOutcome {
    const task = this.requireLeaveTask("hunter_shoot", "resolve_hunter_shot");
    if (actorSeat !== undefined && actorSeat !== task.seat) {
      throw new WerewolfRuleError(
        "resolve_hunter_shot",
        "ERR_WEREWOLF_WRONG_ACTOR",
        `当前待发动技能的猎人是 ${task.seat} 号`,
      );
    }
    const victim =
      targetSeat !== null ? this.requireLivingSeat(targetSeat, "resolve_hunter_shot") : null;
    if (victim && victim.seat === task.seat) {
      throw new WerewolfRuleError(
        "resolve_hunter_shot",
        "ERR_WEREWOLF_INVALID_HUNTER_TARGET",
        "猎人不能开枪带走自己",
      );
    }
    this.leaveQueue.shift();

    if (victim !== null) {
      this.killSeat(victim.seat, "hunter_shot");
      const msg = `猎人 ${task.seat} 号翻牌开枪，带走了 ${victim.seat} 号！`;
      this.addPublicEvent(msg);
      this.recordTruth(this.day, msg, [task.seat, victim.seat]);

      if (this.evaluateAndEnterGameOverIfFinished()) {
        return { announcement: this.lastJudgeSpeech, gameEnded: true };
      }

      // If shot victim held the Sheriff badge, enqueue badge transfer at front!
      if (victim.seat === this.sheriffSeat) {
        this.leaveQueue.unshift({ seat: victim.seat, reason: "sheriff_badge" });
      }
    } else {
      const msg = `${task.seat} 号选择压枪不发动技能。`;
      this.addPublicEvent(msg);
      this.recordTruth(this.day, msg, [task.seat]);
    }

    return this.advanceLeaveQueue();
  }

  resolveSheriffTransfer(targetSeat: number | null, actorSeat?: number): EngineTransitionOutcome {
    const task = this.requireLeaveTask("sheriff_badge", "resolve_sheriff_transfer");
    if (actorSeat !== undefined && actorSeat !== task.seat) {
      throw new WerewolfRuleError(
        "resolve_sheriff_transfer",
        "ERR_WEREWOLF_WRONG_ACTOR",
        `当前待移交警徽的警长是 ${task.seat} 号`,
      );
    }
    const heir =
      targetSeat !== null ? this.requireLivingSeat(targetSeat, "resolve_sheriff_transfer") : null;
    if (heir && heir.idiotRevealed) {
      throw new WerewolfRuleError(
        "resolve_sheriff_transfer",
        "ERR_WEREWOLF_IDIOT_CANNOT_BE_SHERIFF",
        "已翻牌的白痴无法接任警徽",
      );
    }
    this.leaveQueue.shift();

    if (heir !== null) {
      this.assignSheriff(heir.seat);
      const msg = `${task.seat} 号将警徽移交给 ${heir.seat} 号。`;
      this.addPublicEvent(msg);
      this.recordTruth(this.day, msg, [task.seat, heir.seat]);
    } else {
      this.clearSheriff();
      const msg = `${task.seat} 号选择撕毁警徽，本局无警长。`;
      this.addPublicEvent(msg);
      this.recordTruth(this.day, msg, [task.seat]);
    }

    return this.advanceLeaveQueue();
  }

  finishLastWords(): EngineTransitionOutcome {
    const task = this.requireLeaveTask("last_words", "finish_last_words");
    this.leaveQueue.shift();
    this.recordTruth(this.day, `${task.seat} 号发表完毕遗言`, [task.seat]);
    return this.advanceLeaveQueue();
  }

  triggerWolfExplode(
    wolfSeat: number,
    whiteWolfTargetSeat?: number | null,
  ): EngineTransitionOutcome {
    const allowedPhases: readonly WerewolfPhase[] = [
      "sheriff_election",
      "dawn_announce",
      "day_discussion",
    ];
    if (!allowedPhases.includes(this.phase)) {
      throw new WerewolfRuleError(
        "trigger_wolf_explode",
        "ERR_WEREWOLF_EXPLODE_PHASE_FORBIDDEN",
        `当前阶段 ${this.phase} 不可自爆`,
      );
    }

    const wolf = this.requireLivingSeat(wolfSeat, "trigger_wolf_explode");
    if (!wolf.role || !isWolfRole(wolf.role)) {
      throw new WerewolfRuleError(
        "trigger_wolf_explode",
        "ERR_WEREWOLF_NOT_A_WOLF",
        `法官校验未通过：${wolfSeat} 号并非狼人阵营，无法自爆`,
      );
    }

    const wasDuringSheriffElection = this.phase === "sheriff_election";
    const isWhiteWolfKing = wolf.role === "white_wolf_king";

    // Validate optional white-wolf target BEFORE mutating state if provided!
    if (!wasDuringSheriffElection && isWhiteWolfKing && whiteWolfTargetSeat != null) {
      if (whiteWolfTargetSeat === wolfSeat) {
        throw new WerewolfRuleError(
          "trigger_wolf_explode",
          "ERR_WEREWOLF_INVALID_WHITE_WOLF_TARGET",
          "白狼王自爆带人目标不能是自己",
        );
      }
      this.requireLivingSeat(whiteWolfTargetSeat, "trigger_wolf_explode");
    }

    this.clearSpeechState();
    this.leaveQueue = [];
    this.killSeat(wolfSeat, "wolf_explode");

    if (wasDuringSheriffElection) {
      this.sheriffSubphase = null;
      this.clearSheriff();
      for (const s of this.seats) {
        s.isCandidate = false;
      }
      // Apply Night 1 pending casualties immediately since Sheriff election was swallowed!
      const nightDeathsApplied = this.applyPendingNightDeaths();
      const nightMsg =
        nightDeathsApplied.length > 0
          ? `昨晚倒牌玩家为 ${nightDeathsApplied.map((d) => d.seat).join("、")} 号。`
          : "昨晚是平安夜。";
      const msg = `${wolfSeat} 号狼人警上自爆，本局警徽流失！${nightMsg}`;
      this.addPublicEvent(msg);
      this.recordTruth(this.day, msg, [wolfSeat, ...nightDeathsApplied.map((d) => d.seat)]);

      if (this.evaluateAndEnterGameOverIfFinished()) {
        return { announcement: this.lastJudgeSpeech, gameEnded: true };
      }

      // Check if any Night 1 casualty was an unpoisoned Hunter!
      for (const casualty of nightDeathsApplied) {
        const seatObj = this.seats[casualty.seat - 1]!;
        if (seatObj.role === "hunter" && !casualty.poisoned) {
          this.leaveQueue.push({ seat: casualty.seat, reason: "hunter_shoot" });
        }
      }
      this.postLeaveDestination = "next_night";
      if (this.leaveQueue.length > 0) {
        this.phase = "leave_resolution";
        const nextTask = this.leaveQueue[0]!;
        const announcement = `${msg} 请 ${nextTask.seat} 号发动离场技能。`;
        this.lastJudgeSpeech = announcement;
        this.bumpRevision();
        return { announcement };
      }
      return this.enterNight(this.day + 1, `${msg} 直接进入第 ${this.day + 1} 夜，天黑请闭眼。`);
    }

    // Outside sheriff election
    if (wolfSeat === this.sheriffSeat) {
      this.leaveQueue.push({ seat: wolfSeat, reason: "sheriff_badge" });
    }

    if (isWhiteWolfKing) {
      if (whiteWolfTargetSeat === undefined) {
        // Prompt UI / companion for White Wolf King target selection
        this.addPublicEvent(`白狼王 ${wolfSeat} 号自爆！请选择要带走的一名玩家。`);
        this.recordTruth(this.day, `白狼王 ${wolfSeat} 号自爆，等待选择带人目标`, [wolfSeat]);
        if (this.evaluateAndEnterGameOverIfFinished()) {
          return { announcement: this.lastJudgeSpeech, gameEnded: true };
        }
        this.leaveQueue.unshift({ seat: wolfSeat, reason: "white_wolf_explode" });
        this.postLeaveDestination = "next_night";
        this.phase = "leave_resolution";
        const announcement = `白狼王 ${wolfSeat} 号自爆，请指定要带走的目标。`;
        this.lastJudgeSpeech = announcement;
        this.bumpRevision();
        return { announcement };
      }
      if (whiteWolfTargetSeat !== null) {
        this.applyWhiteWolfDragTarget(wolfSeat, whiteWolfTargetSeat);
      } else {
        const msg = `白狼王 ${wolfSeat} 号自爆并选择不带人！白天立即结束。`;
        this.addPublicEvent(msg);
        this.recordTruth(this.day, msg, [wolfSeat]);
      }
    } else {
      const msg = `${wolfSeat} 号狼人拍刀自爆！白天发言与投票立即中止。`;
      this.addPublicEvent(msg);
      this.recordTruth(this.day, msg, [wolfSeat]);
    }

    if (this.evaluateAndEnterGameOverIfFinished()) {
      return { announcement: this.lastJudgeSpeech, gameEnded: true };
    }

    this.postLeaveDestination = "next_night";
    if (this.leaveQueue.length > 0) {
      this.phase = "leave_resolution";
      const announcement = `请 ${this.leaveQueue[0]!.seat} 号结算离场动作。`;
      this.lastJudgeSpeech = announcement;
      this.bumpRevision();
      return { announcement };
    }

    return this.enterNight(this.day + 1);
  }

  resolveWhiteWolfExplodeTarget(
    targetSeat: number | null,
    actorSeat?: number,
  ): EngineTransitionOutcome {
    const task = this.requireLeaveTask(
      "white_wolf_explode",
      "resolve_white_wolf_explode_target",
    );
    if (actorSeat !== undefined && actorSeat !== task.seat) {
      throw new WerewolfRuleError(
        "resolve_white_wolf_explode_target",
        "ERR_WEREWOLF_WRONG_ACTOR",
        `当前待选择带人目标的白狼王是 ${task.seat} 号`,
      );
    }
    const victim =
      targetSeat !== null
        ? this.requireLivingSeat(targetSeat, "resolve_white_wolf_explode_target")
        : null;
    this.leaveQueue.shift();

    if (victim !== null) {
      this.applyWhiteWolfDragTarget(task.seat, victim.seat);
    } else {
      const msg = `白狼王 ${task.seat} 号放弃带人。`;
      this.addPublicEvent(msg);
      this.recordTruth(this.day, msg, [task.seat]);
    }

    if (this.evaluateAndEnterGameOverIfFinished()) {
      return { announcement: this.lastJudgeSpeech, gameEnded: true };
    }
    return this.advanceLeaveQueue();
  }

  // ===========================================================================
  // Internal State Machine Helpers
  // ===========================================================================

  private applyWhiteWolfDragTarget(wolfSeat: number, victimSeat: number): void {
    const victim = this.requireLivingSeat(victimSeat, "white_wolf_drag");
    this.killSeat(victim.seat, "wolf_explode");
    const msg = `白狼王 ${wolfSeat} 号自爆，强行带走了 ${victim.seat} 号！`;
    this.addPublicEvent(msg);
    this.recordTruth(this.day, msg, [wolfSeat, victim.seat]);

    if (victim.seat === this.sheriffSeat) {
      this.leaveQueue.push({ seat: victim.seat, reason: "sheriff_badge" });
    }
    if (victim.role === "hunter" && !victim.poisonedByWitch) {
      this.leaveQueue.push({ seat: victim.seat, reason: "hunter_shoot" });
    }
  }

  private enterNight(nextDay: number, customPrefix?: string): EngineTransitionOutcome {
    this.day = nextDay;
    this.phase = "night_intro";
    this.sheriffSubphase = null;
    this.nightGateUnlocked = false;
    this.currentNightStepIsDecoy = false;
    this.selectedNightDraftTarget = null;
    this.currentNightGuardTarget = null;
    this.currentNightWolfVotes.clear();
    this.currentNightWolfTarget = null;
    this.currentNightWitchSave = false;
    this.currentNightWitchPoisonTarget = null;
    this.currentNightSeerChecked = false;
    this.currentNightSeerResult = null;
    this.pendingNightDeaths = [];
    this.dawnDeathsToday = [];
    this.pkCandidates = [];
    this.currentBallots.clear();
    this.eligibleVoterSeats = [];
    this.clearSpeechState();

    const announcement = customPrefix ?? `第 ${this.day} 夜降临，天黑请闭眼。`;
    this.addPublicEvent(`第 ${this.day} 夜开始，天黑请闭眼。`);
    this.lastJudgeSpeech = announcement;
    this.bumpRevision();
    return {
      announcement,
      enteredNightIntro: true,
    };
  }

  private boardHasRole(role: "guard" | "witch" | "seer"): boolean {
    return (this.rules.roleCounts[role] ?? 0) > 0;
  }

  private enterNextNightRoleAfter(
    completed: "night_intro" | "night_guard" | "night_wolf" | "night_witch" | "night_seer",
  ): EngineTransitionOutcome {
    this.nightGateUnlocked = false;
    this.selectedNightDraftTarget = null;
    this.currentNightStepIsDecoy = false;

    const sequence: Array<"guard" | "werewolf" | "witch" | "seer"> = [
      "guard",
      "werewolf",
      "witch",
      "seer",
    ];
    const indexMap: Record<typeof completed, number> = {
      night_intro: -1,
      night_guard: 0,
      night_wolf: 1,
      night_witch: 2,
      night_seer: 3,
    };
    const startIdx = indexMap[completed] + 1;

    for (let i = startIdx; i < sequence.length; i += 1) {
      const role = sequence[i]!;
      if (role !== "werewolf" && !this.boardHasRole(role)) {
        continue;
      }

      const livingHolders = this.getInternalLivingRoleSeats(role);
      const isDecoy = role !== "werewolf" && livingHolders.length === 0;
      this.currentNightStepIsDecoy = isDecoy;

      switch (role) {
        case "guard":
          this.phase = "night_guard";
          this.lastJudgeSpeech = "守卫请睁眼，请选择今晚要守护的目标。";
          break;
        case "werewolf":
          this.phase = "night_wolf";
          this.lastJudgeSpeech = "狼人请睁眼，请确认今晚袭击的目标。";
          break;
        case "witch":
          this.phase = "night_witch";
          this.lastJudgeSpeech = "女巫请睁眼，请确认是否使用解药或毒药。";
          break;
        case "seer":
          this.phase = "night_seer";
          this.lastJudgeSpeech = "预言家请睁眼，请选择要查验身份的座位。";
          break;
      }
      this.bumpRevision();
      return {
        announcement: this.lastJudgeSpeech,
        enteredNightRole: role,
        isDeadRoleDecoy: isDecoy,
      };
    }

    // All night roles completed -> settle dawn!
    return this.settleNightIntoDawn();
  }

  private settleNightIntoDawn(): EngineTransitionOutcome {
    this.phase = "dawn_settle";
    this.currentNightStepIsDecoy = false;
    this.nightGateUnlocked = false;

    const casualties = new Map<number, { poisoned: boolean }>();
    const bitten = this.currentNightWolfTarget;

    if (bitten !== null && this.seats[bitten - 1]?.alive) {
      const wasGuarded =
        this.currentNightGuardTarget !== null && this.currentNightGuardTarget === bitten;
      const wasSaved = this.currentNightWitchSave;

      let wolfKillSucceeds = true;
      if (wasGuarded && wasSaved) {
        wolfKillSucceeds = this.rules.sameGuardSameSaveDies;
        if (wolfKillSucceeds) {
          this.recordTruth(
            this.day,
            `${bitten} 号遭遇同守同救（奶穿），判定夜间倒牌`,
            [bitten],
          );
        } else {
          this.recordTruth(this.day, `${bitten} 号同守同救存活`, [bitten]);
        }
      } else if (wasGuarded || wasSaved) {
        wolfKillSucceeds = false;
      }

      if (wolfKillSucceeds) {
        casualties.set(bitten, { poisoned: false });
      }
    }

    const poisoned = this.currentNightWitchPoisonTarget;
    if (poisoned !== null && this.seats[poisoned - 1]?.alive) {
      casualties.set(poisoned, { poisoned: true });
    }

    this.pendingNightDeaths = Array.from(casualties.entries())
      .sort(([a], [b]) => a - b)
      .map(([seat, meta]) => ({ seat, poisoned: meta.poisoned }));

    // Standard Tournament Rule: On Day 1 with Sheriff enabled, run Sheriff Election BEFORE announcing Night 1 deaths!
    if (this.day === 1 && this.rules.hasSheriff) {
      this.phase = "sheriff_election";
      this.sheriffSubphase = "signup";
      for (const s of this.seats) {
        s.isCandidate = false;
        s.signedUpSheriff = false;
        s.droppedOutSheriff = false;
      }
      const announcement = "天亮了，现在进行警长竞选，请想要上警的玩家报名。";
      this.addPublicEvent(announcement);
      this.lastJudgeSpeech = announcement;
      this.bumpRevision();
      return {
        announcement,
        exitedNight: true,
      };
    }

    const outcome = this.enterDawnAnnounce();
    return {
      ...outcome,
      exitedNight: true,
    };
  }

  private applyPendingNightDeaths(): PendingNightDeath[] {
    const applied = [...this.pendingNightDeaths];
    this.pendingNightDeaths = [];
    this.dawnDeathsToday = applied.map((d) => d.seat);
    for (const d of applied) {
      const seatObj = this.seats[d.seat - 1]!;
      seatObj.poisonedByWitch = d.poisoned;
      this.killSeat(d.seat, "night");
    }
    return applied;
  }

  private enterDawnAnnounce(): EngineTransitionOutcome {
    const deaths = this.applyPendingNightDeaths();
    this.phase = "dawn_announce";
    this.sheriffSubphase = null;

    const deathText =
      deaths.length === 0
        ? `第 ${this.day} 天天亮了，昨晚是平安夜。`
        : `第 ${this.day} 天天亮了，昨晚倒牌的玩家是 ${deaths
            .map((d) => `${d.seat}号`)
            .join("、")}（排名不分先后）。`;
    this.addPublicEvent(deathText);
    this.recordTruth(
      this.day,
      deaths.length === 0
        ? "天亮公布：平安夜"
        : `天亮公布死讯：${deaths.map((d) => `${d.seat}号`).join("、")}`,
      deaths.map((d) => d.seat),
    );
    this.lastJudgeSpeech = deathText;

    if (this.evaluateAndEnterGameOverIfFinished()) {
      return { announcement: this.lastJudgeSpeech, gameEnded: true };
    }

    // Queue night-death leave tasks:
    // 1. Sheriff badge transfer if Sheriff died in the night
    // 2. Unpoisoned Hunter shoot
    // 3. Night 1 last words (standard rule: Day 1 night deaths have last words; Day 2+ night deaths do not)
    this.leaveQueue = [];
    for (const d of deaths) {
      const seatObj = this.seats[d.seat - 1]!;
      if (d.seat === this.sheriffSeat) {
        this.leaveQueue.push({ seat: d.seat, reason: "sheriff_badge" });
      }
      if (seatObj.role === "hunter" && !d.poisoned) {
        this.leaveQueue.push({ seat: d.seat, reason: "hunter_shoot" });
      }
      if (this.day === 1) {
        this.leaveQueue.push({ seat: d.seat, reason: "last_words" });
      }
    }
    this.postLeaveDestination = "day_discussion";
    this.bumpRevision();

    // Auto-transition into leave_resolution if tasks exist, else remain on dawn_announce briefly or enter day_discussion on acknowledgeDawn / auto-flow.
    if (this.leaveQueue.length > 0) {
      return this.proceedAfterDawnAnnounce();
    }
    return this.enterDayDiscussion(deathText);
  }

  private proceedAfterDawnAnnounce(): EngineTransitionOutcome {
    if (this.leaveQueue.length > 0) {
      this.phase = "leave_resolution";
      const task = this.leaveQueue[0]!;
      const announcement = `${this.lastJudgeSpeech} ${this.describeLeaveTaskPrompt(task)}`;
      this.lastJudgeSpeech = announcement;
      this.bumpRevision();
      return { announcement };
    }
    return this.enterDayDiscussion();
  }

  private advanceLeaveQueue(): EngineTransitionOutcome {
    if (this.evaluateAndEnterGameOverIfFinished()) {
      return { announcement: this.lastJudgeSpeech, gameEnded: true };
    }
    if (this.leaveQueue.length > 0) {
      this.phase = "leave_resolution";
      const next = this.leaveQueue[0]!;
      const announcement = this.describeLeaveTaskPrompt(next);
      this.lastJudgeSpeech = announcement;
      this.bumpRevision();
      return { announcement };
    }
    if (this.postLeaveDestination === "next_night") {
      return this.enterNight(this.day + 1);
    }
    return this.enterDayDiscussion();
  }

  private describeLeaveTaskPrompt(task: LeaveTask): string {
    switch (task.reason) {
      case "hunter_shoot":
        return `请 ${task.seat} 号玩家确认是否发动猎人开枪技能。`;
      case "sheriff_badge":
        return `请警长 ${task.seat} 号选择移交警徽或撕毁警徽。`;
      case "last_words":
        return `请 ${task.seat} 号玩家发表遗言。`;
      case "white_wolf_explode":
        return `请白狼王 ${task.seat} 号指定自爆带走的目标。`;
    }
  }

  private enterDayDiscussion(prefix?: string): EngineTransitionOutcome {
    this.phase = "day_discussion";
    this.sheriffSubphase = null;
    const order = this.computeDaySpeakingOrder();
    this.startSpeechQueue(order);
    const speakHint =
      order.length > 0 ? `现在按顺序由 ${order[0]} 号玩家开始发言。` : "";
    const announcement = [prefix, speakHint].filter(Boolean).join(" ");
    this.lastJudgeSpeech = announcement;
    this.bumpRevision();
    return { announcement };
  }

  private beginSheriffVoting(
    subphase: "voting" | "pk_voting",
    candidates: readonly number[],
  ): EngineTransitionOutcome {
    this.clearSpeechState();
    this.sheriffSubphase = subphase;
    this.pkCandidates = [...candidates];
    this.currentBallots.clear();

    // Off-badge players who never signed up for Sheriff vote for Sheriff.
    const offBadgeVoters = this.seats
      .filter((s) => s.alive && s.canVote && !s.signedUpSheriff)
      .map((s) => s.seat);

    if (offBadgeVoters.length === 0) {
      // Everyone signed up on-badge -> nobody off-badge to vote -> badge lost!
      this.sheriffSubphase = null;
      this.pkCandidates = [];
      for (const s of this.seats) {
        s.isCandidate = false;
      }
      this.addPublicEvent("全员上警且警下无人可投票，本局警徽流失。");
      this.recordTruth(this.day, "全员上警无警下选票，警徽流失", []);
      return this.enterDawnAnnounce();
    }

    this.eligibleVoterSeats = offBadgeVoters;
    const announcement = `警上发言完毕，请警下玩家（${offBadgeVoters.join("、")}号）投票选出警长。`;
    this.addPublicEvent(announcement);
    this.lastJudgeSpeech = announcement;
    this.bumpRevision();
    return { announcement };
  }

  private finalizeSheriffVotes(): EngineTransitionOutcome {
    const tallies = this.computeTalliesFromBallots(this.currentBallots, false);
    this.publishBallotsSnapshot(tallies);

    const topScore = tallies[0]?.weightedVotes ?? 0;
    const topTargets =
      topScore > 0
        ? tallies.filter((t) => Math.abs(t.weightedVotes - topScore) < 1e-6).map((t) => t.targetSeat)
        : [];

    if (topTargets.length === 1) {
      const elected = topTargets[0]!;
      this.assignSheriff(elected);
      for (const s of this.seats) {
        s.isCandidate = false;
      }
      this.sheriffSubphase = null;
      this.pkCandidates = [];
      const msg = `${elected} 号高票当选警长！`;
      this.addPublicEvent(msg);
      this.recordTruth(this.day, msg, [elected]);
      return this.enterDawnAnnounce();
    }

    // Tie or 0 votes
    const tiedCandidates =
      topTargets.length > 1
        ? topTargets
        : this.pkCandidates.length > 0
          ? [...this.pkCandidates]
          : this.seats.filter((s) => s.alive && s.isCandidate).map((s) => s.seat);

    if (this.sheriffSubphase === "voting" && tiedCandidates.length > 1) {
      this.sheriffSubphase = "pk_speech";
      this.pkCandidates = tiedCandidates;
      const ordered = this.buildRandomOrderedSeats(tiedCandidates);
      this.startSpeechQueue(ordered);
      const announcement = `警长投票出现平票（${tiedCandidates.join("、")}号），进入 PK 发言，由 ${ordered[0]} 号开始。`;
      this.addPublicEvent(announcement);
      this.lastJudgeSpeech = announcement;
      this.bumpRevision();
      return { announcement };
    }

    // Second tie in pk_voting -> badge lost!
    this.clearSheriff();
    for (const s of this.seats) {
      s.isCandidate = false;
    }
    this.sheriffSubphase = null;
    this.pkCandidates = [];
    const msg = "警长 PK 再次平票，本局警徽流失。";
    this.addPublicEvent(msg);
    this.recordTruth(this.day, msg, []);
    return this.enterDawnAnnounce();
  }

  private beginDayPkVoting(): EngineTransitionOutcome {
    this.clearSpeechState();
    this.phase = "day_pk_voting";
    this.currentBallots.clear();

    const pkSet = new Set(this.pkCandidates);
    const offBenchVoters = this.seats
      .filter((s) => s.alive && s.canVote && !pkSet.has(s.seat))
      .map((s) => s.seat);

    // If all eligible living voters are tied on the PK bench, all eligible living voters vote.
    this.eligibleVoterSeats =
      offBenchVoters.length > 0
        ? offBenchVoters
        : this.seats.filter((s) => s.alive && s.canVote).map((s) => s.seat);

    const announcement = `PK 发言结束，请投票在 ${this.pkCandidates.join("、")} 号之间做出放逐选择。`;
    this.addPublicEvent(announcement);
    this.lastJudgeSpeech = announcement;
    this.bumpRevision();
    return { announcement };
  }

  private finalizeDayExileVotes(): EngineTransitionOutcome {
    const tallies = this.computeTalliesFromBallots(this.currentBallots, true);
    this.publishBallotsSnapshot(tallies);

    const topScore = tallies[0]?.weightedVotes ?? 0;
    const topTargets =
      topScore > 0
        ? tallies.filter((t) => Math.abs(t.weightedVotes - topScore) < 1e-6).map((t) => t.targetSeat)
        : [];

    if (topTargets.length === 0) {
      const msg = "本轮全员弃票，无人出局，直接进入黑夜。";
      this.addPublicEvent(msg);
      this.recordTruth(this.day, msg, []);
      return this.enterNight(this.day + 1, `${msg} 第 ${this.day + 1} 夜降临，天黑请闭眼。`);
    }

    if (topTargets.length === 1) {
      const exiled = this.seats[topTargets[0]! - 1]!;

      // Check Idiot immunity!
      if (exiled.role === "idiot" && !exiled.idiotRevealed) {
        exiled.idiotRevealed = true;
        exiled.canVote = false;
        if (exiled.seat === this.sheriffSeat) {
          this.clearSheriff();
        }
        const msg = `${exiled.seat} 号得最高票（${topScore}票），翻出【白痴】身份牌免于放逐，后续失去投票权！`;
        this.addPublicEvent(msg);
        this.recordTruth(this.day, msg, [exiled.seat]);
        return this.enterNight(this.day + 1, `${msg} 天黑请闭眼。`);
      }

      this.killSeat(exiled.seat, "vote");
      const msg = `${exiled.seat} 号以 ${topScore} 票被公投放逐出局。`;
      this.addPublicEvent(msg);
      this.recordTruth(this.day, msg, [exiled.seat]);

      if (this.evaluateAndEnterGameOverIfFinished()) {
        return { announcement: this.lastJudgeSpeech, gameEnded: true };
      }

      this.leaveQueue = [];
      if (exiled.seat === this.sheriffSeat) {
        this.leaveQueue.push({ seat: exiled.seat, reason: "sheriff_badge" });
      }
      if (exiled.role === "hunter") {
        // Exiled by daytime vote -> Hunter ALWAYS has gun (`canShoot = true`)
        this.leaveQueue.push({ seat: exiled.seat, reason: "hunter_shoot" });
      }
      this.leaveQueue.push({ seat: exiled.seat, reason: "last_words" });
      this.postLeaveDestination = "next_night";
      this.phase = "leave_resolution";
      const announcement = `${msg} ${this.describeLeaveTaskPrompt(this.leaveQueue[0]!)}`;
      this.lastJudgeSpeech = announcement;
      this.bumpRevision();
      return { announcement };
    }

    // Tie (`topTargets.length > 1`)
    if (this.phase === "day_voting") {
      this.phase = "day_pk_speech";
      this.pkCandidates = topTargets;
      const ordered = this.buildRandomOrderedSeats(topTargets);
      this.startSpeechQueue(ordered);
      const announcement = `${topTargets.join("、")} 号同得最高票（${topScore}票），进入平票 PK 发言，请 ${ordered[0]} 号开始。`;
      this.addPublicEvent(announcement);
      this.recordTruth(this.day, announcement, topTargets);
      this.bumpRevision();
      return { announcement };
    }

    // Second tie in `day_pk_voting` -> peaceful day!
    this.pkCandidates = [];
    const msg = `${topTargets.join("、")} 号二次平票，今日平安日无人出局。`;
    this.addPublicEvent(msg);
    this.recordTruth(this.day, msg, topTargets);
    return this.enterNight(this.day + 1, `${msg} 第 ${this.day + 1} 夜降临，天黑请闭眼。`);
  }

  private evaluateAndEnterGameOverIfFinished(): boolean {
    const livingWolves = this.seats.filter(
      (s) => s.alive && s.role !== null && isWolfRole(s.role),
    ).length;
    const livingGods = this.seats.filter(
      (s) => s.alive && s.role !== null && isGodRole(s.role),
    ).length;
    const livingVillagers = this.seats.filter(
      (s) => s.alive && s.role === "villager",
    ).length;

    let winner: "good" | "werewolf" | null = null;
    let reason: string | null = null;

    if (livingWolves === 0) {
      winner = "good";
      reason = "全部狼人已出局，好人阵营获胜！";
    } else if (this.rules.winMode === "slaughter_all") {
      if (livingGods + livingVillagers === 0) {
        winner = "werewolf";
        reason = "好人全员出局（屠城达成），狼人阵营获胜！";
      }
    } else {
      if (livingGods === 0) {
        winner = "werewolf";
        reason = "神职阵营全员出局（屠神达成），狼人阵营获胜！";
      } else if (livingVillagers === 0) {
        winner = "werewolf";
        reason = "平民阵营全员出局（屠民达成），狼人阵营获胜！";
      }
    }

    if (!winner || !reason) {
      return false;
    }

    this.phase = "game_over";
    this.sheriffSubphase = null;
    this.winner = winner;
    this.winReason = reason;
    this.leaveQueue = [];
    this.clearSpeechState();
    this.nightGateUnlocked = false;
    this.addPublicEvent(`游戏结束：${reason}`);
    this.recordTruth(this.day, `终局判定：${reason}`, []);
    this.lastJudgeSpeech = `游戏结束！${reason}`;
    this.bumpRevision();
    return true;
  }

  private computeTalliesFromBallots(
    ballots: ReadonlyMap<number, number | null>,
    applySheriffWeight: boolean,
  ): WerewolfVoteTallyItem[] {
    const grouped = new Map<number, { weightedVotes: number; voterSeats: number[] }>();
    for (const [voter, target] of ballots.entries()) {
      if (target === null) continue;
      const weight =
        applySheriffWeight && this.sheriffSeat !== null && voter === this.sheriffSeat
          ? 1.5
          : 1.0;
      const item = grouped.get(target) ?? { weightedVotes: 0, voterSeats: [] };
      item.weightedVotes = Math.round((item.weightedVotes + weight) * 10) / 10;
      item.voterSeats.push(voter);
      grouped.set(target, item);
    }

    return Array.from(grouped.entries())
      .map(([targetSeat, info]) => ({
        targetSeat,
        weightedVotes: info.weightedVotes,
        voterSeats: info.voterSeats.sort((a, b) => a - b),
      }))
      .sort((a, b) => b.weightedVotes - a.weightedVotes || a.targetSeat - b.targetSeat);
  }

  private publishBallotsSnapshot(tallies: readonly WerewolfVoteTallyItem[]): void {
    const snapshot: Record<number, number | null> = {};
    for (const [voter, target] of this.currentBallots.entries()) {
      snapshot[voter] = target;
    }
    this.lastPublishedBallots = snapshot;
    this.lastPublishedTallies = [...tallies];

    const summaryParts = tallies.map(
      (t) => `${t.targetSeat}号(${t.weightedVotes}票: ${t.voterSeats.join("/")}号)`,
    );
    const abstained = Array.from(this.currentBallots.entries())
      .filter(([, target]) => target === null)
      .map(([voter]) => voter)
      .sort((a, b) => a - b);
    const logLine = [
      summaryParts.length > 0 ? `票型公布：${summaryParts.join("；")}` : "票型公布：无人得票",
      abstained.length > 0 ? `弃票：${abstained.join("/")}号` : "",
    ]
      .filter(Boolean)
      .join("，");
    this.addPublicEvent(logLine);
    this.recordTruth(this.day, logLine, []);
  }

  private buildPublicNightPrompt(): WerewolfNightPromptPublic | null {
    if (
      this.phase !== "night_guard" &&
      this.phase !== "night_wolf" &&
      this.phase !== "night_witch" &&
      this.phase !== "night_seer"
    ) {
      return null;
    }

    const activeRole =
      this.phase === "night_guard"
        ? "guard"
        : this.phase === "night_wolf"
          ? "werewolf"
          : this.phase === "night_witch"
            ? "witch"
            : "seer";

    const unlocked = this.nightGateUnlocked && !this.currentNightStepIsDecoy;
    const livingSeats = this.seats.filter((s) => s.alive).map((s) => s.seat);

    if (!unlocked) {
      return {
        activeRole,
        gateUnlocked: false,
        selectableSeats: [],
        selectedTargetSeat: null,
        canEmptyTarget: activeRole !== "seer",
        witchContext: null,
        seerResult: null,
        lastGuardedSeat: null,
        wolfTeammateSeats: [],
      };
    }

    if (activeRole === "guard") {
      return {
        activeRole: "guard",
        gateUnlocked: true,
        selectableSeats: livingSeats.filter((s) => s !== this.lastGuardedSeat),
        selectedTargetSeat: this.selectedNightDraftTarget,
        canEmptyTarget: true,
        witchContext: null,
        seerResult: null,
        lastGuardedSeat: this.lastGuardedSeat,
        wolfTeammateSeats: [],
      };
    }

    if (activeRole === "werewolf") {
      return {
        activeRole: "werewolf",
        gateUnlocked: true,
        selectableSeats: livingSeats,
        selectedTargetSeat: this.selectedNightDraftTarget,
        canEmptyTarget: true,
        witchContext: null,
        seerResult: null,
        lastGuardedSeat: null,
        wolfTeammateSeats: this.getInternalLivingRoleSeats("werewolf"),
      };
    }

    if (activeRole === "witch") {
      const attackedSeat = this.witchAntidoteAvailable ? this.currentNightWolfTarget : null;
      const canSave =
        this.witchAntidoteAvailable &&
        this.currentNightWolfTarget !== null &&
        this.canWitchSaveTarget(this.currentNightWolfTarget);
      return {
        activeRole: "witch",
        gateUnlocked: true,
        selectableSeats: this.witchPoisonAvailable ? livingSeats : [],
        selectedTargetSeat: this.selectedNightDraftTarget,
        canEmptyTarget: true,
        witchContext: {
          attackedSeat,
          antidoteAvailable: this.witchAntidoteAvailable,
          canSave,
          canPoison: this.witchPoisonAvailable,
          saveSelected: false,
          poisonTargetSeat: this.selectedNightDraftTarget,
        },
        seerResult: null,
        lastGuardedSeat: null,
        wolfTeammateSeats: [],
      };
    }

    const seerSeat = this.getInternalLivingRoleSeats("seer")[0] ?? null;
    return {
      activeRole: "seer",
      gateUnlocked: true,
      selectableSeats: livingSeats.filter((s) => s !== seerSeat),
      selectedTargetSeat: this.selectedNightDraftTarget,
      canEmptyTarget: false,
      witchContext: null,
      seerResult: this.currentNightSeerResult,
      lastGuardedSeat: null,
      wolfTeammateSeats: [],
    };
  }

  private buildCompanionActionPrompt(
    me: InternalSeatState,
  ): CompanionSeatPrivateView["actionPrompt"] {
    if (this.phase === "dealing" && !me.dealtConfirmed) {
      return {
        kind: "confirm_deal",
        selectableSeats: [],
        canSkip: false,
      };
    }

    if (this.phase === "night_guard" && me.alive && me.role === "guard") {
      const living = this.seats.filter((s) => s.alive).map((s) => s.seat);
      return {
        kind: "guard_pick",
        selectableSeats: living.filter((s) => s !== this.lastGuardedSeat),
        canSkip: true,
      };
    }

    if (this.phase === "night_wolf" && me.alive && me.role && isWolfRole(me.role)) {
      const living = this.seats.filter((s) => s.alive).map((s) => s.seat);
      const teammates = this.seats
        .filter((s) => s.role !== null && isWolfRole(s.role))
        .map((s) => ({
          seat: s.seat,
          role: s.role!,
          alive: s.alive,
          selectedTarget: this.currentNightWolfVotes.get(s.seat),
        }));
      return {
        kind: "wolf_consensus",
        selectableSeats: living,
        canSkip: true,
        selectedTargetSeat: this.currentNightWolfVotes.get(me.seat) ?? null,
        wolfTeammates: teammates,
        alreadySubmitted: this.currentNightWolfVotes.has(me.seat),
      };
    }

    if (this.phase === "night_witch" && me.alive && me.role === "witch") {
      const living = this.seats.filter((s) => s.alive).map((s) => s.seat);
      const attackedSeat = this.witchAntidoteAvailable ? this.currentNightWolfTarget : null;
      const canSave =
        this.witchAntidoteAvailable &&
        this.currentNightWolfTarget !== null &&
        this.canWitchSaveTarget(this.currentNightWolfTarget);
      return {
        kind: "witch_act",
        selectableSeats: this.witchPoisonAvailable ? living : [],
        canSkip: true,
        witchInfo: {
          attackedSeat,
          canSave,
          canPoison: this.witchPoisonAvailable,
        },
      };
    }

    if (this.phase === "night_seer" && me.alive && me.role === "seer") {
      if (this.currentNightSeerChecked) {
        return {
          kind: "seer_ack",
          selectableSeats: [],
          canSkip: false,
          seerHistory: [...this.seerHistory],
          latestSeerResult: this.currentNightSeerResult,
        };
      }
      const living = this.seats
        .filter((s) => s.alive && s.seat !== me.seat)
        .map((s) => s.seat);
      return {
        kind: "seer_check",
        selectableSeats: living,
        canSkip: false,
        seerHistory: [...this.seerHistory],
      };
    }

    if (this.phase === "sheriff_election" && me.alive) {
      if (this.sheriffSubphase === "signup") {
        return {
          kind: "sheriff_signup",
          selectableSeats: [],
          canSkip: true,
          alreadySubmitted: me.isCandidate,
        };
      }
      if (this.sheriffSubphase === "speech" && me.isCandidate) {
        return {
          kind: "sheriff_drop",
          selectableSeats: [],
          canSkip: true,
        };
      }
      if (
        (this.sheriffSubphase === "voting" || this.sheriffSubphase === "pk_voting") &&
        this.eligibleVoterSeats.includes(me.seat)
      ) {
        return {
          kind: "vote_ballot",
          selectableSeats: this.getValidVoteTargets(),
          canSkip: true,
          selectedTargetSeat: this.currentBallots.get(me.seat) ?? null,
          alreadySubmitted: this.currentBallots.has(me.seat),
        };
      }
    }

    if (
      (this.phase === "day_voting" || this.phase === "day_pk_voting") &&
      this.eligibleVoterSeats.includes(me.seat)
    ) {
      return {
        kind: "vote_ballot",
        selectableSeats: this.getValidVoteTargets(),
        canSkip: true,
        selectedTargetSeat: this.currentBallots.get(me.seat) ?? null,
        alreadySubmitted: this.currentBallots.has(me.seat),
      };
    }

    if (this.phase === "leave_resolution" && this.leaveQueue[0]?.seat === me.seat) {
      const task = this.leaveQueue[0]!;
      const livingOthers = this.seats
        .filter((s) => s.alive && s.seat !== me.seat)
        .map((s) => s.seat);
      if (task.reason === "hunter_shoot") {
        return {
          kind: "hunter_shoot",
          selectableSeats: livingOthers,
          canSkip: true,
        };
      }
      if (task.reason === "sheriff_badge") {
        return {
          kind: "sheriff_transfer",
          selectableSeats: livingOthers.filter((s) => !this.seats[s - 1]!.idiotRevealed),
          canSkip: true,
        };
      }
      if (task.reason === "white_wolf_explode") {
        return {
          kind: "white_wolf_drag",
          selectableSeats: livingOthers,
          canSkip: true,
        };
      }
    }

    return null;
  }

  private canWitchSaveTarget(attackedSeat: number): boolean {
    const witchSeats = this.getInternalLivingRoleSeats("witch");
    const witchSeat = witchSeats[0] ?? null;
    if (attackedSeat !== witchSeat) {
      return true;
    }
    switch (this.rules.witchSelfSaveMode) {
      case "any_night":
        return true;
      case "first_night_only":
        return this.day === 1;
      case "never":
        return false;
    }
  }

  private getValidVoteTargets(): number[] {
    if (this.phase === "sheriff_election") {
      if (this.sheriffSubphase === "pk_voting") {
        return [...this.pkCandidates];
      }
      return this.seats.filter((s) => s.alive && s.isCandidate).map((s) => s.seat);
    }
    if (this.phase === "day_pk_voting") {
      return [...this.pkCandidates];
    }
    return this.seats.filter((s) => s.alive).map((s) => s.seat);
  }

  private computeDaySpeakingOrder(): number[] {
    const living = this.seats.filter((s) => s.alive).map((s) => s.seat);
    if (living.length === 0) return [];

    const n = this.seats.length;
    const anchorDeath = this.dawnDeathsToday[0] ?? null;
    const startSeat = anchorDeath !== null ? (anchorDeath % n) + 1 : living[this.randomInt(living.length)]!;

    const ordered: number[] = [];
    for (let offset = 0; offset < n; offset += 1) {
      const candidate = ((startSeat - 1 + offset) % n) + 1;
      if (living.includes(candidate) && candidate !== this.sheriffSeat) {
        ordered.push(candidate);
      }
    }
    // Living Sheriff always speaks LAST ("归票位")
    if (this.sheriffSeat !== null && living.includes(this.sheriffSeat)) {
      ordered.push(this.sheriffSeat);
    }
    return ordered;
  }

  private buildRandomOrderedSeats(seats: readonly number[]): number[] {
    if (seats.length <= 1) return [...seats];
    const sorted = [...seats].sort((a, b) => a - b);
    const startIdx = this.randomInt(sorted.length);
    const clockwise = this.randomInt(2) === 0;
    const result: number[] = [];
    for (let i = 0; i < sorted.length; i += 1) {
      const idx = clockwise
        ? (startIdx + i) % sorted.length
        : (startIdx - i + sorted.length) % sorted.length;
      result.push(sorted[idx]!);
    }
    return result;
  }

  private startSpeechQueue(order: readonly number[]): void {
    this.speakingOrder = [...order];
    this.speakingIndex = 0;
    this.speakingSeat = order[0] ?? null;
    this.speakingRemainingSec = order.length > 0 ? this.rules.speechSeconds : 0;
    this.timerPaused = false;
  }

  private clearSpeechState(): void {
    this.speakingOrder = [];
    this.speakingIndex = 0;
    this.speakingSeat = null;
    this.speakingRemainingSec = 0;
    this.timerPaused = false;
  }

  private assignSheriff(seat: number): void {
    for (const s of this.seats) {
      s.isSheriff = s.seat === seat;
    }
    this.sheriffSeat = seat;
  }

  private clearSheriff(): void {
    for (const s of this.seats) {
      s.isSheriff = false;
    }
    this.sheriffSeat = null;
  }

  private killSeat(seat: number, cause: WerewolfDeathCause): void {
    const target = this.seats[seat - 1]!;
    target.alive = false;
    target.deathDay = this.day;
    target.deathPhase = cause;
    target.isCandidate = false;
  }

  private rebuildSeats(count: number, preserveMeta: boolean): void {
    const prevBySeat = new Map(this.seats.map((s) => [s.seat, s]));
    const next: InternalSeatState[] = [];
    for (let i = 1; i <= count; i += 1) {
      const prev = preserveMeta ? prevBySeat.get(i) : undefined;
      next.push({
        seat: i,
        nickname: prev?.nickname ?? `${i}号玩家`,
        alive: true,
        role: null,
        dealtConfirmed: false,
        portraitDataUri: prev?.portraitDataUri ?? null,
        isSheriff: false,
        signedUpSheriff: false,
        isCandidate: false,
        droppedOutSheriff: false,
        idiotRevealed: false,
        canVote: true,
        deathDay: null,
        deathPhase: null,
        poisonedByWitch: false,
      });
    }
    this.seats = next;
  }

  private resetMatchFields(): void {
    this.sheriffSubphase = null;
    this.day = 0;
    this.dealingCurrentSeat = null;
    this.dealingRevealingSeat = null;
    this.dealingHistorySeats = [];
    this.nightGateUnlocked = false;
    this.currentNightStepIsDecoy = false;
    this.selectedNightDraftTarget = null;
    this.lastGuardedSeat = null;
    this.currentNightGuardTarget = null;
    this.currentNightWolfVotes.clear();
    this.currentNightWolfTarget = null;
    this.witchAntidoteAvailable = true;
    this.witchPoisonAvailable = true;
    this.currentNightWitchSave = false;
    this.currentNightWitchPoisonTarget = null;
    this.currentNightSeerChecked = false;
    this.currentNightSeerResult = null;
    this.seerHistory = [];
    this.pendingNightDeaths = [];
    this.dawnDeathsToday = [];
    this.sheriffSeat = null;
    this.clearSpeechState();
    this.leaveQueue = [];
    this.postLeaveDestination = "day_discussion";
    this.pkCandidates = [];
    this.eligibleVoterSeats = [];
    this.currentBallots.clear();
    this.lastPublishedBallots = {};
    this.lastPublishedTallies = [];
    this.publicEvents = [];
    this.truthTimeline = [];
    this.winner = null;
    this.winReason = null;
    this.aiMvpReview = { status: "idle", text: null, error: null };
  }

  private addPublicEvent(text: string): void {
    this.eventCounter += 1;
    this.publicEvents.push({
      id: `ev-${this.eventCounter}`,
      day: this.day,
      phase: this.phase,
      text,
      timestampMs: this.now(),
    });
  }

  private recordTruth(day: number, summary: string, actors: readonly number[]): void {
    this.truthTimeline.push({
      day,
      summary,
      actors: [...actors],
    });
  }

  private assertLobbyEditable(stage: string): void {
    if (this.phase !== "idle" && this.phase !== "lobby" && this.phase !== "game_over") {
      throw new WerewolfRuleError(
        stage,
        "ERR_WEREWOLF_MATCH_IN_PROGRESS",
        "对局进行中，请先结束当前牌局再调整板子预设",
      );
    }
  }

  private assertPhase(expected: WerewolfPhase, stage: string): void {
    if (this.phase !== expected) {
      throw new WerewolfRuleError(
        stage,
        "ERR_WEREWOLF_INVALID_PHASE",
        `期望阶段为 ${expected}，当前实际阶段为 ${this.phase}`,
      );
    }
  }

  private assertActorHasRole(seat: number, expected: WerewolfRole, stage: string): void {
    const actor = this.requireLivingSeat(seat, stage);
    if (actor.role !== expected) {
      throw new WerewolfRuleError(
        stage,
        "ERR_WEREWOLF_WRONG_ROLE",
        `${seat} 号并非存活的 ${expected}`,
      );
    }
  }

  private requireSeat(seat: number, stage: string): InternalSeatState {
    if (!Number.isInteger(seat) || seat < 1 || seat > this.seats.length) {
      throw new WerewolfRuleError(
        stage,
        "ERR_WEREWOLF_INVALID_SEAT",
        `座位号 ${String(seat)} 超出有效范围 1..${this.seats.length}`,
      );
    }
    return this.seats[seat - 1]!;
  }

  private requireLivingSeat(seat: number, stage: string): InternalSeatState {
    const target = this.requireSeat(seat, stage);
    if (!target.alive) {
      throw new WerewolfRuleError(
        stage,
        "ERR_WEREWOLF_SEAT_ALREADY_OUT",
        `${seat} 号玩家已出局，不可作为操作对象`,
      );
    }
    return target;
  }

  private requireLeaveTask(reason: WerewolfLeaveReason, stage: string): LeaveTask {
    if (this.phase !== "leave_resolution" || this.leaveQueue.length === 0) {
      throw new WerewolfRuleError(
        stage,
        "ERR_WEREWOLF_NO_PENDING_LEAVE_TASK",
        "当前没有待结算的离场技能或遗言",
      );
    }
    const top = this.leaveQueue[0]!;
    if (top.reason !== reason) {
      throw new WerewolfRuleError(
        stage,
        "ERR_WEREWOLF_LEAVE_TASK_MISMATCH",
        `当前待处理事项为 ${top.reason}（${top.seat}号），而非 ${reason}`,
      );
    }
    return top;
  }

  private bumpRevision(): void {
    this.revision += 1;
  }
}
