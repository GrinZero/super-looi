import { Text, View } from "nsh";
import { Button } from "nsh/base";
import type { PluginViewContext } from "../../../ui/plugins/ui-contracts";
import {
  WEREWOLF_PHASE_LABELS,
  type WerewolfCommand,
  type WerewolfPhase,
  type WerewolfPublicState,
  type WerewolfRulesConfig,
  type WerewolfSheriffSubphase,
} from "../contracts";

const DEFAULT_RULES: WerewolfRulesConfig = {
  presetId: "9p_standard",
  playerCount: 9,
  roleCounts: {
    werewolf: 3,
    white_wolf_king: 0,
    seer: 1,
    witch: 1,
    hunter: 1,
    guard: 0,
    idiot: 0,
    villager: 3,
  },
  winMode: "slaughter_side",
  hasSheriff: true,
  witchSelfSaveMode: "first_night_only",
  sameGuardSameSaveDies: true,
  speechSeconds: 90,
  surfaceMode: "on_device",
  motionMode: "embodied_patrol",
};

const EMPTY_PUBLIC_STATE: WerewolfPublicState = {
  revision: 0,
  phase: "idle",
  sheriffSubphase: null,
  day: 0,
  rules: DEFAULT_RULES,
  seats: [],
  dealingCurrentSeat: null,
  dealingRevealingSeat: null,
  dealingFaceAligned: false,
  previewSessionId: null,
  visionAvailable: false,
  nightPrompt: null,
  sheriffSeat: null,
  speakingSeat: null,
  speakingOrder: [],
  speakingRemainingSec: 0,
  timerPaused: false,
  pendingLeaveSeat: null,
  pendingLeaveReason: null,
  dawnDeathsToday: [],
  pkCandidates: [],
  votesByVoter: {},
  voteTallies: [],
  votedSeats: [],
  eligibleVoterSeats: [],
  lan: {
    active: false,
    baseUrl: null,
    lanIpv4: null,
    port: null,
    claimedSeats: [],
    error: null,
  },
  publicEvents: [],
  winner: null,
  winReason: null,
  fullTimelineReveal: [],
  aiMvpReview: {
    status: "idle",
    text: null,
    error: null,
  },
  hostPaused: false,
  lastJudgeSpeech: "",
  voiceStatus: {
    speaking: false,
    mutedByHost: false,
    lastSpokenText: null,
    lastInterruptedReason: null,
    degradedToSubtitles: false,
  },
  hasResumableMatch: false,
  canStepBackDeal: false,
};

export function readWerewolfState(
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>,
): WerewolfPublicState {
  const raw = ctx.state() as Partial<WerewolfPublicState> | undefined;
  if (!raw || typeof raw.phase !== "string" || !Array.isArray(raw.seats)) {
    return EMPTY_PUBLIC_STATE;
  }
  return raw as WerewolfPublicState;
}

function isNightAtmospherePhase(phase: WerewolfPhase): boolean {
  return (
    phase === "night_intro" ||
    phase === "night_guard" ||
    phase === "night_wolf" ||
    phase === "night_witch" ||
    phase === "night_seer" ||
    phase === "dawn_settle"
  );
}

function formatSheriffSubphase(
  sub: WerewolfSheriffSubphase | null,
  locale: "zh-CN" | "en-US",
): string {
  if (!sub) return "";
  if (locale === "en-US") {
    switch (sub) {
      case "signup":
        return " · Sign-Up";
      case "speech":
        return " · Speech";
      case "voting":
        return " · Vote";
      case "pk_speech":
        return " · Tie Speech";
      case "pk_voting":
        return " · Tie Vote";
    }
  }
  switch (sub) {
    case "signup":
      return " · 上警报名";
    case "speech":
      return " · 竞选发言";
    case "voting":
      return " · 警下投票";
    case "pk_speech":
      return " · PK发言";
    case "pk_voting":
      return " · PK投票";
  }
}

export function WerewolfStageCapsule(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
}) {
  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();

  const aliveCount = () => st().seats.filter((s) => s.alive).length;
  const totalCount = () => st().seats.length || st().rules.playerCount;

  const dayOrSetupTag = () => {
    const s = st();
    if (s.phase === "lobby" || s.phase === "idle") {
      return loc() === "en-US" ? `${totalCount()}P` : `${totalCount()}人局`;
    }
    if (s.day <= 0) {
      return loc() === "en-US" ? "Match" : "对局";
    }
    if (isNightAtmospherePhase(s.phase)) {
      return loc() === "en-US" ? `Night ${s.day}` : `第${s.day}夜`;
    }
    return loc() === "en-US" ? `Day ${s.day}` : `第${s.day}天`;
  };

  const phaseTitle = () => {
    const s = st();
    const base = WEREWOLF_PHASE_LABELS[s.phase]?.[loc()] ?? s.phase;
    if (s.phase === "sheriff_election") {
      return `${base}${formatSheriffSubphase(s.sheriffSubphase, loc())}`;
    }
    return base;
  };

  const dotClass = () => {
    const phase = st().phase;
    if (isNightAtmospherePhase(phase)) {
      return "w-2 h-2 rounded-full bg-face-mist-core";
    }
    if (phase === "game_over") {
      return "w-2 h-2 rounded-full bg-face-sage-core";
    }
    return "w-2 h-2 rounded-full bg-face-amber-core";
  };

  const showAlive = () => {
    const phase = st().phase;
    if (phase === "idle" || phase === "lobby" || st().seats.length === 0) {
      return false;
    }
    if (st().speakingSeat !== null && st().sheriffSeat !== null && showLanBadge()) {
      return false;
    }
    return true;
  };

  const showLanBadge = () =>
    st().lan.active || st().rules.surfaceMode === "lan_companion";

  const showJudgeVoiceControls = () =>
    st().phase !== "idle" && st().phase !== "lobby";

  const voiceStatusLabel = () => {
    const vs = st().voiceStatus;
    if (vs.speaking) return loc() === "en-US" ? "Speaking" : "播报中";
    if (vs.mutedByHost) return loc() === "en-US" ? "Muted" : "已静音";
    if (vs.degradedToSubtitles) {
      return loc() === "en-US" ? "Subtitles" : "字幕模式";
    }
    return loc() === "en-US" ? "Voice" : "语音";
  };

  const voiceStatusPillClass = () => {
    const vs = st().voiceStatus;
    if (vs.speaking || vs.degradedToSubtitles) {
      return "px-2 py-0.5 rounded-full bg-lighting-bg border border-face-amber-edge";
    }
    return "px-2 py-0.5 rounded-full bg-stage-pill-bg border border-stage-pill-border";
  };

  const voiceStatusTextClass = () => {
    const vs = st().voiceStatus;
    if (vs.speaking) return "text-face-amber-core text-xs font-semibold";
    if (vs.degradedToSubtitles) return "text-warning text-xs font-semibold";
    if (vs.mutedByHost) return "text-stage-muted text-xs font-medium";
    return "text-stage-pill-muted text-xs font-medium";
  };

  const canReplaySpeech = () =>
    Boolean(st().voiceStatus.lastSpokenText || st().lastJudgeSpeech);

  return (
    <View
      testID="werewolf-stage-capsule"
      class="flex-row items-center gap-2.5 max-w-full overflow-hidden"
    >
      <View class="flex-row items-center gap-1.5">
        <View class={dotClass()} />
        <Text
          testID="werewolf-capsule-day"
          class="text-stage-pill-muted text-xs font-semibold"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {dayOrSetupTag()}
        </Text>
      </View>

      <View class="w-px h-3 bg-stage-pill-border" />

      <Text
        testID="werewolf-capsule-phase"
        class="text-stage-pill-fg text-xs font-semibold"
        style={{ numberOfLines: 1 }}
      >
        {phaseTitle()}
      </Text>

      <If when={showAlive()}>
        <View class="w-px h-3 bg-stage-pill-border" />
        <Text
          testID="werewolf-capsule-alive"
          class="text-stage-pill-muted text-xs font-medium"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {loc() === "en-US"
            ? `Alive ${aliveCount()}/${totalCount()}`
            : `存活 ${aliveCount()}/${totalCount()}`}
        </Text>
      </If>

      <If when={st().sheriffSeat !== null}>
        <View class="px-2 py-0.5 rounded-full bg-lighting-bg border border-lighting-border">
          <Text
            testID="werewolf-capsule-sheriff"
            class="text-face-amber-core text-xs font-semibold"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {loc() === "en-US"
              ? `Sheriff #${st().sheriffSeat}`
              : `警长 #${st().sheriffSeat}`}
          </Text>
        </View>
      </If>

      <If when={st().speakingSeat !== null}>
        <View class="px-2 py-0.5 rounded-full bg-stage-pill-bg border border-stage-pill-border flex-row items-center gap-1">
          <Text
            testID="werewolf-capsule-speaker"
            class={
              !st().timerPaused && st().speakingRemainingSec <= 10
                ? "text-warning text-xs font-semibold"
                : "text-stage-pill-fg text-xs font-semibold"
            }
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {`#${st().speakingSeat} · ${
              st().timerPaused
                ? loc() === "en-US"
                  ? "Paused"
                  : "已暂停"
                : `${st().speakingRemainingSec}s`
            }`}
          </Text>
        </View>
      </If>

      <If when={showLanBadge()}>
        <View class="px-2 py-0.5 rounded-full bg-air-quality-bg border border-air-quality-border">
          <Text
            testID="werewolf-capsule-lan"
            class="text-face-sage-core text-xs font-medium"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {loc() === "en-US"
              ? `LAN ${st().lan.claimedSeats.length}/${totalCount()}`
              : `扫码 ${st().lan.claimedSeats.length}/${totalCount()}`}
          </Text>
        </View>
      </If>

      <If when={showJudgeVoiceControls()}>
        <View class="w-px h-3 bg-stage-pill-border" />
        <View class={voiceStatusPillClass()}>
          <Text
            testID="werewolf-capsule-voice-status"
            class={voiceStatusTextClass()}
          >
            {voiceStatusLabel()}
          </Text>
        </View>

        <If when={canReplaySpeech()}>
          <Button
            testID="werewolf-replay-speech-btn"
            hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }}
            accessibilityLabel={
              loc() === "en-US"
                ? "Replay last judge announcement"
                : "重播上一条法官播报"
            }
            onPress={() => {
              void props.ctx.sendCommand({ type: "replay_last_speech" });
            }}
            class="min-h-7 min-w-11 px-2.5 py-0.5 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75 focus-visible:border-stage-pill-fg"
          >
            <Text class="text-stage-pill-fg text-xs font-medium">
              {loc() === "en-US" ? "Replay" : "重播"}
            </Text>
          </Button>
        </If>

        <Button
          testID="werewolf-mute-speech-btn"
          hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }}
          selected={st().voiceStatus.mutedByHost}
          accessibilityLabel={
            st().voiceStatus.mutedByHost
              ? loc() === "en-US"
                ? "Unmute judge voice"
                : "恢复法官语音播报"
              : loc() === "en-US"
                ? "Mute judge voice"
                : "静音法官语音播报"
          }
          onPress={() => {
            void props.ctx.sendCommand({
              type: "set_judge_voice_muted",
              muted: !st().voiceStatus.mutedByHost,
            });
          }}
          class={
            st().voiceStatus.mutedByHost
              ? "min-h-7 min-w-11 px-2.5 py-0.5 rounded-full border border-face-amber-edge bg-lighting-bg items-center justify-center active:opacity-75 focus-visible:border-stage-pill-fg"
              : "min-h-7 min-w-11 px-2.5 py-0.5 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75 focus-visible:border-stage-pill-fg"
          }
        >
          <Text
            class={
              st().voiceStatus.mutedByHost
                ? "text-face-amber-core text-xs font-semibold"
                : "text-stage-pill-fg text-xs font-medium"
            }
          >
            {st().voiceStatus.mutedByHost
              ? loc() === "en-US"
                ? "Unmute"
                : "取消静音"
              : loc() === "en-US"
                ? "Mute"
                : "静音"}
          </Text>
        </Button>
      </If>
    </View>
  );
}
