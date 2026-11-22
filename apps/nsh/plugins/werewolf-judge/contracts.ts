import type { LocalizedText, PluginFailure } from "../../runtime/plugins/shared-types.js";

export const WEREWOLF_PLUGIN_ID = "werewolf-judge" as const;

export const WEREWOLF_ROLES = [
  "werewolf",
  "white_wolf_king",
  "seer",
  "witch",
  "hunter",
  "guard",
  "idiot",
  "villager",
] as const;

export type WerewolfRole = (typeof WEREWOLF_ROLES)[number];

export const WOLF_FACTION_ROLES: readonly WerewolfRole[] = [
  "werewolf",
  "white_wolf_king",
] as const;

export const GOD_FACTION_ROLES: readonly WerewolfRole[] = [
  "seer",
  "witch",
  "hunter",
  "guard",
  "idiot",
] as const;

export type WerewolfPresetId =
  | "6p_joy"
  | "9p_standard"
  | "12p_guard"
  | "12p_idiot"
  | "custom";

export type WerewolfPhase =
  | "idle"
  | "lobby"
  | "dealing"
  | "night_intro"
  | "night_guard"
  | "night_wolf"
  | "night_witch"
  | "night_seer"
  | "dawn_settle"
  | "sheriff_election"
  | "dawn_announce"
  | "leave_resolution"
  | "day_discussion"
  | "day_voting"
  | "day_pk_speech"
  | "day_pk_voting"
  | "game_over";

export type WerewolfSheriffSubphase =
  | "signup"
  | "speech"
  | "voting"
  | "pk_speech"
  | "pk_voting";

export type WerewolfSurfaceMode = "on_device" | "lan_companion";

export type WerewolfMotionMode = "embodied_patrol" | "stationary_gaze";

export type WerewolfWinMode = "slaughter_side" | "slaughter_all";

export type WerewolfWitchSelfSaveMode = "first_night_only" | "never" | "any_night";

export type WerewolfDeathCause = "night" | "vote" | "hunter_shot" | "wolf_explode";

export type WerewolfLeaveReason =
  | "hunter_shoot"
  | "sheriff_badge"
  | "last_words"
  | "white_wolf_explode";

export interface WerewolfRulesConfig {
  readonly presetId: WerewolfPresetId;
  readonly playerCount: number;
  readonly roleCounts: Readonly<Record<WerewolfRole, number>>;
  readonly winMode: WerewolfWinMode;
  readonly hasSheriff: boolean;
  readonly witchSelfSaveMode: WerewolfWitchSelfSaveMode;
  readonly sameGuardSameSaveDies: boolean;
  readonly speechSeconds: number;
  readonly surfaceMode: WerewolfSurfaceMode;
  readonly motionMode: WerewolfMotionMode;
}

export interface WerewolfSeatPublicView {
  readonly seat: number;
  readonly nickname: string;
  readonly alive: boolean;
  readonly dealtConfirmed: boolean;
  readonly lanClaimed: boolean;
  readonly portraitDataUri: string | null;
  readonly isSheriff: boolean;
  readonly isCandidate: boolean;
  readonly droppedOutSheriff: boolean;
  readonly idiotRevealed: boolean;
  readonly canVote: boolean;
  readonly deathDay: number | null;
  readonly deathPhase: WerewolfDeathCause | null;
  /**
   * Secret isolation invariant:
   * Always `null` while `phase !== "game_over"`, EXCEPT:
   * 1. `idiotRevealed === true` -> `"idiot"` (publicly flipped card to survive exile)
   * 2. `phase === "dealing" && dealingCurrentSeat === seat && dealingRevealingSeat === seat` ->
   *    the single active seat's dealt role ONLY while the privacy shield is held down.
   */
  readonly revealedRole: WerewolfRole | null;
}

export interface WerewolfWitchPromptContext {
  readonly attackedSeat: number | null;
  readonly antidoteAvailable: boolean;
  readonly canSave: boolean;
  readonly canPoison: boolean;
  readonly saveSelected: boolean;
  readonly poisonTargetSeat: number | null;
}

export interface WerewolfSeerCheckResult {
  readonly targetSeat: number;
  readonly isWolf: boolean;
}

export interface WerewolfNightPromptPublic {
  readonly activeRole: "guard" | "werewolf" | "witch" | "seer" | null;
  /** True ONLY while the active role holds/unlocks the on-device privacy gate. */
  readonly gateUnlocked: boolean;
  readonly selectableSeats: readonly number[];
  readonly selectedTargetSeat: number | null;
  readonly canEmptyTarget: boolean;
  /** Populated ONLY when `activeRole === "witch" && gateUnlocked === true`. */
  readonly witchContext: WerewolfWitchPromptContext | null;
  /** Populated ONLY when `activeRole === "seer" && gateUnlocked === true` after check. */
  readonly seerResult: WerewolfSeerCheckResult | null;
  /** Populated ONLY when `activeRole === "guard" && gateUnlocked === true`. */
  readonly lastGuardedSeat: number | null;
  /** Populated ONLY when `activeRole === "werewolf" && gateUnlocked === true`. */
  readonly wolfTeammateSeats: readonly number[];
}

export interface WerewolfPublicEvent {
  readonly id: string;
  readonly day: number;
  readonly phase: WerewolfPhase;
  readonly text: string;
  readonly timestampMs: number;
}

export interface WerewolfMatchHighlight {
  readonly kind: "peaceful_night" | "day_tie" | "sheriff_tie" | "badge_transfer";
  readonly day: number;
}

export interface WerewolfMatchSummary {
  readonly id: string;
  readonly endedAtMs: number;
  readonly presetId: WerewolfPresetId;
  readonly playerCount: number;
  readonly winner: "good" | "werewolf";
  readonly day: number;
  readonly highlight: WerewolfMatchHighlight | null;
}

export interface WerewolfReplaySeat {
  readonly seat: number;
  readonly nickname: string;
  readonly role: WerewolfRole;
  readonly alive: boolean;
  readonly isSheriff: boolean;
  readonly deathDay: number | null;
  readonly deathPhase: WerewolfDeathCause | null;
}

export type WerewolfReplayVoteKind = "sheriff" | "sheriff_pk" | "exile" | "exile_pk";

export type WerewolfReplayVoteOutcome =
  | "elected"
  | "badge_lost"
  | "runoff"
  | "exiled"
  | "idiot_revealed"
  | "no_votes"
  | "tied_again";

interface WerewolfReplayEventPosition {
  readonly sequence: number;
  readonly day: number;
  readonly round: "deal" | "night" | "day";
}

export type WerewolfReplayEventContent =
  | {
      readonly type: "event" | "dawn";
      readonly visibility: "public" | "postgame";
      readonly text: string;
      readonly seats: readonly number[];
      readonly highlight?: WerewolfMatchHighlight["kind"];
    }
  | {
      readonly type: "speaking_order";
      readonly kind: "sheriff" | "sheriff_pk" | "discussion" | "exile_pk";
      readonly seats: readonly number[];
    }
  | {
      readonly type: "ballot";
      readonly kind: WerewolfReplayVoteKind;
      readonly votes: Readonly<Record<number, number | null>>;
      readonly tallies: readonly WerewolfVoteTallyItem[];
      readonly outcome: WerewolfReplayVoteOutcome;
      readonly seats: readonly number[];
    };

export type WerewolfReplayEvent = WerewolfReplayEventPosition & WerewolfReplayEventContent;

export interface WerewolfMatchReplay {
  readonly winReason: string;
  readonly seats: readonly WerewolfReplaySeat[];
  readonly events: readonly WerewolfReplayEvent[];
  readonly partialTimeline: boolean;
  readonly review?: WerewolfAiMvpReview;
}

export interface WerewolfMatchRecord extends WerewolfMatchSummary {
  readonly replay?: WerewolfMatchReplay;
}

export type WerewolfReplaySource =
  | { readonly current: true }
  | { readonly matchId: string };

export interface WerewolfTimelineRevealEntry {
  readonly day: number;
  readonly summary: string;
  readonly actors: readonly number[];
}

export interface WerewolfLanStatus {
  readonly active: boolean;
  readonly baseUrl: string | null;
  readonly lanIpv4: string | null;
  readonly port: number | null;
  readonly claimedSeats: readonly number[];
  readonly error: string | null;
}

export interface WerewolfVoteTallyItem {
  readonly targetSeat: number;
  readonly weightedVotes: number;
  readonly voterSeats: readonly number[];
}

export interface WerewolfAiMvpReview {
  readonly status: "idle" | "generating" | "ready" | "failed";
  readonly text: string | null;
  readonly error: string | null;
}

export interface WerewolfJudgeVoiceStatus {
  readonly speaking: boolean;
  readonly mutedByHost: boolean;
  readonly lastSpokenText: string | null;
  readonly lastInterruptedReason: string | null;
  readonly degradedToSubtitles: boolean;
}

export interface WerewolfPublicState {
  readonly revision: number;
  readonly phase: WerewolfPhase;
  readonly sheriffSubphase: WerewolfSheriffSubphase | null;
  readonly day: number;
  readonly rules: WerewolfRulesConfig;
  readonly seats: readonly WerewolfSeatPublicView[];
  readonly dealingCurrentSeat: number | null;
  readonly dealingRevealingSeat: number | null;
  readonly dealingFaceAligned: boolean;
  readonly firstNightStartsAtMs: number | null;
  readonly previewSessionId: string | null;
  readonly visionAvailable: boolean;
  readonly nightPrompt: WerewolfNightPromptPublic | null;
  readonly sheriffSeat: number | null;
  readonly speakingSeat: number | null;
  readonly speakingOrder: readonly number[];
  readonly speakingRemainingSec: number;
  readonly timerPaused: boolean;
  readonly pendingLeaveSeat: number | null;
  readonly pendingLeaveReason: WerewolfLeaveReason | null;
  readonly dawnDeathsToday: readonly number[];
  readonly pkCandidates: readonly number[];
  /**
   * Public ballot map (`voterSeat -> targetSeat | null`).
   * In `lan_companion` mode while voting is still in progress, individual targets stay hidden (`{}`)
   * and only `votedSeats` shows participation until `finalize_votes` / auto-tally completes.
   */
  readonly votesByVoter: Readonly<Record<number, number | null>>;
  readonly voteTallies: readonly WerewolfVoteTallyItem[];
  readonly votedSeats: readonly number[];
  readonly eligibleVoterSeats: readonly number[];
  readonly lan: WerewolfLanStatus;
  readonly publicEvents: readonly WerewolfPublicEvent[];
  readonly winner: "good" | "werewolf" | null;
  readonly winReason: string | null;
  /** Strictly empty `[]` until `phase === "game_over"`. */
  readonly fullTimelineReveal: readonly WerewolfTimelineRevealEntry[];
  readonly completedMatchId: string | null;
  readonly matchHistory: readonly WerewolfMatchSummary[];
  readonly matchHistoryLoadError: PluginFailure | null;
  readonly matchHistoryVersion: number;
  readonly aiMvpReview: WerewolfAiMvpReview;
  readonly hostPaused: boolean;
  readonly lastJudgeSpeech: string;
  readonly voiceStatus: WerewolfJudgeVoiceStatus;
  readonly hasResumableMatch: boolean;
  readonly canStepBackDeal: boolean;
}

export type WerewolfCommand =
  | { readonly type: "open_lobby"; readonly presetId?: WerewolfPresetId }
  | { readonly type: "resume_stage" }
  | { readonly type: "exit_to_idle" }
  | { readonly type: "abort_match_to_lobby" }
  | { readonly type: "select_preset"; readonly presetId: WerewolfPresetId }
  | { readonly type: "update_rules"; readonly patch: Partial<WerewolfRulesConfig> }
  | { readonly type: "set_role_count"; readonly role: WerewolfRole; readonly count: number }
  | { readonly type: "set_seat_nickname"; readonly seat: number; readonly nickname: string }
  | { readonly type: "toggle_lan_room"; readonly enabled: boolean }
  | { readonly type: "refresh_lan_address" }
  | { readonly type: "release_lan_seat"; readonly seat: number }
  | { readonly type: "start_dealing" }
  | { readonly type: "capture_seat_portrait"; readonly seat: number }
  | { readonly type: "set_deal_reveal"; readonly seat: number; readonly revealing: boolean }
  | { readonly type: "confirm_seat_dealt"; readonly seat: number }
  | { readonly type: "step_back_deal" }
  | { readonly type: "replay_last_speech" }
  | { readonly type: "set_judge_voice_muted"; readonly muted: boolean }
  | { readonly type: "begin_first_night" }
  | { readonly type: "set_night_gate"; readonly unlocked: boolean }
  | { readonly type: "select_night_target"; readonly targetSeat: number | null }
  | { readonly type: "submit_guard_action"; readonly targetSeat: number | null }
  | { readonly type: "submit_wolf_action"; readonly targetSeat: number | null }
  | {
      readonly type: "submit_witch_action";
      readonly save: boolean;
      readonly poisonTargetSeat: number | null;
    }
  | { readonly type: "submit_seer_check"; readonly targetSeat: number }
  | { readonly type: "finish_seer_turn" }
  | { readonly type: "toggle_sheriff_candidate"; readonly seat: number }
  | { readonly type: "lock_sheriff_candidates" }
  | { readonly type: "sheriff_drop_out"; readonly seat: number }
  | { readonly type: "advance_speaker" }
  | { readonly type: "toggle_timer_pause" }
  | { readonly type: "start_voting" }
  | {
      readonly type: "cast_on_device_vote";
      readonly voterSeat: number;
      readonly targetSeat: number | null;
    }
  | { readonly type: "finalize_votes" }
  | { readonly type: "acknowledge_dawn" }
  | { readonly type: "resolve_hunter_shot"; readonly targetSeat: number | null }
  | { readonly type: "resolve_sheriff_transfer"; readonly targetSeat: number | null }
  | { readonly type: "finish_last_words" }
  | {
      readonly type: "trigger_wolf_explode";
      readonly wolfSeat: number;
      readonly whiteWolfTargetSeat?: number | null;
    }
  | { readonly type: "read_match_replay"; readonly source: WerewolfReplaySource }
  | { readonly type: "delete_match_record"; readonly matchId: string }
  | { readonly type: "regenerate_mvp_review" }
  | { readonly type: "play_again" };

export const WEREWOLF_ROLE_LABELS: Readonly<Record<WerewolfRole, LocalizedText>> = {
  werewolf: { "zh-CN": "狼人", "en-US": "Werewolf" },
  white_wolf_king: { "zh-CN": "白狼王", "en-US": "White Wolf King" },
  seer: { "zh-CN": "预言家", "en-US": "Seer" },
  witch: { "zh-CN": "女巫", "en-US": "Witch" },
  hunter: { "zh-CN": "猎人", "en-US": "Hunter" },
  guard: { "zh-CN": "守卫", "en-US": "Guard" },
  idiot: { "zh-CN": "白痴", "en-US": "Idiot" },
  villager: { "zh-CN": "平民", "en-US": "Villager" },
};

export const WEREWOLF_ROLE_HINTS: Readonly<Record<WerewolfRole, LocalizedText>> = {
  werewolf: {
    "zh-CN": "每晚与狼同伴共同袭击一名玩家，白天可随时自爆直接入夜。",
    "en-US": "Eliminate one player each night with your pack; may self-explode during the day.",
  },
  white_wolf_king: {
    "zh-CN": "狼人阵营领袖，白天非警上发言阶段自爆可额外带走一名玩家。",
    "en-US": "Wolf leader; daytime self-explosion outside sheriff campaign drags one player.",
  },
  seer: {
    "zh-CN": "每晚可查验一名存活玩家的阵营（好人金水 / 狼人查杀）。",
    "en-US": "Inspect one living player each night to learn Good vs. Werewolf.",
  },
  witch: {
    "zh-CN": "拥有一瓶解药与一瓶毒药，每晚最多使用一瓶。",
    "en-US": "Holds one antidote and one poison; at most one potion may be used per night.",
  },
  hunter: {
    "zh-CN": "被狼人袭击或被放逐出局时可开枪带走一人；被女巫毒死不可开枪。",
    "en-US": "May shoot one player when killed by wolves or exiled; cannot shoot if poisoned.",
  },
  guard: {
    "zh-CN": "每晚守护一名玩家免受狼刀，不能连续两晚守护同一人。",
    "en-US": "Protect one player from wolf attack each night; cannot guard the same player twice in a row.",
  },
  idiot: {
    "zh-CN": "白天被放逐出局时自动翻牌免死一次，之后失去投票权与被选警徽权。",
    "en-US": "Reveals card to survive exile once, losing voting and sheriff eligibility afterward.",
  },
  villager: {
    "zh-CN": "无夜间技能，依靠白天逻辑推理与公投找出全部狼人。",
    "en-US": "No night ability; deduce and vote out all werewolves during the day.",
  },
};

export const WEREWOLF_PHASE_LABELS: Readonly<Record<WerewolfPhase, LocalizedText>> = {
  idle: { "zh-CN": "待机", "en-US": "Standby" },
  lobby: { "zh-CN": "建房准备", "en-US": "Lobby" },
  dealing: { "zh-CN": "环视发牌", "en-US": "Dealing" },
  night_intro: { "zh-CN": "天黑闭眼", "en-US": "Nightfall" },
  night_guard: { "zh-CN": "守卫行动", "en-US": "Guard Turn" },
  night_wolf: { "zh-CN": "狼人行动", "en-US": "Werewolves Turn" },
  night_witch: { "zh-CN": "女巫行动", "en-US": "Witch Turn" },
  night_seer: { "zh-CN": "预言家行动", "en-US": "Seer Turn" },
  dawn_settle: { "zh-CN": "拂晓结算", "en-US": "Dawn Settlement" },
  sheriff_election: { "zh-CN": "警长竞选", "en-US": "Sheriff Election" },
  dawn_announce: { "zh-CN": "天亮死讯", "en-US": "Dawn Announcement" },
  leave_resolution: { "zh-CN": "遗言与技能", "en-US": "Leave Resolution" },
  day_discussion: { "zh-CN": "白天发言", "en-US": "Day Discussion" },
  day_voting: { "zh-CN": "放逐公投", "en-US": "Exile Vote" },
  day_pk_speech: { "zh-CN": "平票 PK 发言", "en-US": "Tie-Break Speech" },
  day_pk_voting: { "zh-CN": "平票 PK 投票", "en-US": "Tie-Break Vote" },
  game_over: { "zh-CN": "终局复盘", "en-US": "Game Over" },
};

export const WEREWOLF_PRESET_LABELS: Readonly<Record<WerewolfPresetId, LocalizedText>> = {
  "6p_joy": { "zh-CN": "6人欢乐屠城", "en-US": "6P Joy Slaughter-All" },
  "9p_standard": { "zh-CN": "9人标准预女猎", "en-US": "9P Standard" },
  "12p_guard": { "zh-CN": "12人预女猎守", "en-US": "12P Guard" },
  "12p_idiot": { "zh-CN": "12人预女猎白", "en-US": "12P Idiot" },
  custom: { "zh-CN": "自定义板子", "en-US": "Custom Board" },
};

export function isWolfRole(role: WerewolfRole): boolean {
  return role === "werewolf" || role === "white_wolf_king";
}

export function isGodRole(role: WerewolfRole): boolean {
  return (
    role === "seer" ||
    role === "witch" ||
    role === "hunter" ||
    role === "guard" ||
    role === "idiot"
  );
}
