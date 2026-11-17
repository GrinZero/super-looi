import {
  effect,
  reduceMotion,
  signal,
  Text,
  View,
  windowSize,
} from "nsh";
import {
  AlertDialog,
  Button,
  Dialog,
  Menu,
  MenuItem,
  MenuSeparator,
} from "nsh/base";
import type { PluginViewContext } from "../../../ui/plugins/ui-contracts";
import {
  WEREWOLF_PHASE_LABELS,
  WEREWOLF_PRESET_LABELS,
  type WerewolfCommand,
  type WerewolfPhase,
  type WerewolfPublicState,
  type WerewolfSheriffSubphase,
} from "../contracts";
import { WerewolfStageIcon } from "./WerewolfIcons";

const DEFAULT_RULES: WerewolfPublicState["rules"] = {
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
  const explodeDialogOpen = signal(false);
  const explodeAttempted = signal(false);
  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();

  const aliveCount = () => st().seats.filter((s) => s.alive).length;
  const totalCount = () => st().seats.length || st().rules.playerCount;

  const canExplode = () => {
    const p = st().phase;
    return (
      p === "sheriff_election" ||
      p === "dawn_announce" ||
      p === "day_discussion"
    );
  };

  effect(() => {
    if (!canExplode() && explodeDialogOpen()) {
      explodeDialogOpen.set(false);
    }
  });

  const isVotingPhase = () => {
    const p = st().phase;
    if (p === "day_voting" || p === "day_pk_voting") return true;
    if (p === "sheriff_election") {
      const sub = st().sheriffSubphase;
      return sub === "voting" || sub === "pk_voting";
    }
    return false;
  };

  const mainTitle = () => {
    const s = st();
    if (s.phase === "lobby" || s.phase === "idle") {
      return loc() === "en-US" ? "Match Setup" : "开局准备";
    }
    if (s.phase === "dealing") {
      const dealt = s.seats.filter((seat) => seat.dealtConfirmed).length;
      const total = totalCount();
      return loc() === "en-US"
        ? `Dealing · ${dealt}/${total}`
        : `环视发牌 · 已领 ${dealt}/${total}`;
    }
    if (s.phase === "game_over") {
      return loc() === "en-US" ? "Game Over" : "终局复盘";
    }
    const dayPrefix =
      s.day > 0
        ? isNightAtmospherePhase(s.phase)
          ? loc() === "en-US"
            ? `Night ${s.day} · `
            : `第${s.day}夜 · `
          : loc() === "en-US"
            ? `Day ${s.day} · `
            : `第${s.day}天 · `
        : "";
    const base = WEREWOLF_PHASE_LABELS[s.phase]?.[loc()] ?? s.phase;
    const sub =
      s.phase === "sheriff_election"
        ? formatSheriffSubphase(s.sheriffSubphase, loc())
        : "";
    return `${dayPrefix}${base}${sub}`;
  };

  const secondaryInfo = () => {
    const s = st();
    if (s.phase === "idle" || s.phase === "lobby" || s.phase === "dealing") {
      return "";
    }
    if (s.phase === "game_over") {
      return WEREWOLF_PRESET_LABELS[s.rules.presetId]?.[loc()] ?? `${totalCount()}P`;
    }
    if (s.seats.length === 0) return "";
    return `${aliveCount()}/${totalCount()}`;
  };

  const dotClass = () => {
    const phase = st().phase;
    if (isNightAtmospherePhase(phase)) {
      return "w-2 h-2 rounded-full bg-face-mist-core shrink-0";
    }
    if (phase === "game_over") {
      return "w-2 h-2 rounded-full bg-face-sage-core shrink-0";
    }
    if (phase === "lobby") {
      return "w-2 h-2 rounded-full bg-eye-core shrink-0";
    }
    return "w-2 h-2 rounded-full bg-face-amber-core shrink-0";
  };

  const showJudgeVoiceControls = () =>
    st().phase !== "idle" && st().phase !== "lobby";

  const canReplaySpeech = () =>
    Boolean(st().voiceStatus.lastSpokenText || st().lastJudgeSpeech);

  const voiceStatusLabel = () => {
    const vs = st().voiceStatus;
    if (vs.mutedByHost) return loc() === "en-US" ? "Muted" : "已静音";
    if (vs.degradedToSubtitles) {
      return loc() === "en-US" ? "Subtitles" : "字幕模式";
    }
    if (vs.speaking) return loc() === "en-US" ? "Speaking" : "播报中";
    return loc() === "en-US" ? "Voice" : "语音";
  };

  const voiceStatusPillClass = () => {
    const vs = st().voiceStatus;
    if (vs.mutedByHost || vs.speaking || vs.degradedToSubtitles) {
      return "px-1.5 py-0.5 rounded-full bg-lighting-bg border border-face-amber-edge shrink-0";
    }
    return "px-1.5 py-0.5 rounded-full bg-stage-pill-bg border border-stage-pill-border shrink-0";
  };

  const voiceStatusTextClass = () => {
    const vs = st().voiceStatus;
    if (vs.mutedByHost || vs.speaking) {
      return "text-face-amber-core text-xs font-semibold";
    }
    if (vs.degradedToSubtitles) return "text-warning text-xs font-semibold";
    return "text-stage-pill-muted text-xs font-medium";
  };

  const confirmEarlyFinalize = async () => {
    const missing = Math.max(
      0,
      st().eligibleVoterSeats.length - st().votedSeats.length,
    );
    const res = await AlertDialog.show({
      title:
        loc() === "en-US"
          ? "End Voting Early?"
          : "提前结算本轮投票？",
      description:
        loc() === "en-US"
          ? `${missing} player(s) have not voted yet and will be recorded as abstentions.`
          : `仍有 ${missing} 位玩家未投票，提前结算将统一记为弃票。`,
      actions: [
        {
          id: "cancel",
          label: loc() === "en-US" ? "Cancel" : "取消",
          role: "cancel",
        },
        {
          id: "confirm",
          label: loc() === "en-US" ? "Finalize Votes" : "提前结算",
          role: "default",
        },
      ],
    });
    if (res.action === "confirm") {
      void props.ctx.sendCommand({ type: "finalize_votes" });
    }
  };

  const confirmAbortMatch = async () => {
    const res = await AlertDialog.show({
      title:
        loc() === "en-US"
          ? "Abort Current Match?"
          : "终止本局并返回大厅？",
      description:
        loc() === "en-US"
          ? "Current match progress will be cleared and returned to the lobby."
          : "当前对局进度将被清空，并返回开局准备大厅。",
      actions: [
        {
          id: "cancel",
          label: loc() === "en-US" ? "Cancel" : "取消",
          role: "cancel",
        },
        {
          id: "confirm",
          label: loc() === "en-US" ? "Abort Match" : "终止本局",
          role: "destructive",
        },
      ],
    });
    if (res.action === "confirm") {
      void props.ctx.sendCommand({ type: "abort_match_to_lobby" });
    }
  };

  const confirmQuitWerewolf = async () => {
    const res = await AlertDialog.show({
      title:
        loc() === "en-US"
          ? "Quit Werewolf Match?"
          : "退出狼人杀并结束对局？",
      description:
        loc() === "en-US"
          ? "Ends the current match and releases the tabletop stage."
          : "将结束当前对局并离开桌面裁判舞台。",
      actions: [
        {
          id: "cancel",
          label: loc() === "en-US" ? "Cancel" : "取消",
          role: "cancel",
        },
        {
          id: "confirm",
          label: loc() === "en-US" ? "Quit Werewolf" : "退出狼人杀",
          role: "destructive",
        },
      ],
    });
    if (res.action === "confirm") {
      void props.ctx.sendCommand({ type: "exit_to_idle" });
    }
  };

  const menuPopupClass =
    "min-w-52 rounded-2xl border border-border bg-popover p-1.5 shadow-lg";
  const menuItemClass =
    "min-h-11 rounded-xl px-3 py-2 flex-row items-center justify-between active:bg-muted focus:bg-muted";

  return (
    <View
      testID="werewolf-stage-capsule"
      class="flex-row items-center gap-1.5 max-w-full overflow-hidden"
    >
      {/* Left status cluster */}
      <View class="flex-row items-center gap-1.5 min-w-0 shrink overflow-hidden">
        <View class={dotClass()} />
        <Text
          testID="werewolf-capsule-phase"
          class="text-stage-pill-fg text-xs font-semibold shrink min-w-0"
          style={{ numberOfLines: 1, fontVariant: ["tabular-nums"] }}
        >
          {mainTitle()}
        </Text>

        <If when={Boolean(secondaryInfo())}>
          <View class="w-px h-3 bg-stage-pill-border shrink-0" />
          <Text
            testID="werewolf-capsule-alive"
            class="text-stage-pill-muted text-xs font-medium shrink-0"
            style={{ numberOfLines: 1, fontVariant: ["tabular-nums"] }}
          >
            {secondaryInfo()}
          </Text>
        </If>

        <If when={showJudgeVoiceControls()}>
          <View class={voiceStatusPillClass()}>
            <Text
              testID="werewolf-capsule-voice-status"
              class={voiceStatusTextClass()}
            >
              {voiceStatusLabel()}
            </Text>
          </View>
        </If>
      </View>

      {/* Right compact quick actions */}
      <View class="flex-row items-center gap-1 shrink-0">
        <If when={showJudgeVoiceControls() && canReplaySpeech()}>
          <Button
            testID="werewolf-replay-speech-btn"
            hitSlop={6}
            accessibilityLabel={
              loc() === "en-US"
                ? "Replay last judge announcement"
                : "重播上一条法官播报"
            }
            onPress={() => {
              void props.ctx.sendCommand({ type: "replay_last_speech" });
            }}
            class="w-8 h-8 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75 focus-visible:border-stage-pill-fg"
          >
            <WerewolfStageIcon name="replay" tone="stageFg" size={15} />
          </Button>
        </If>

        <If when={showJudgeVoiceControls()}>
          <Button
            testID="werewolf-mute-speech-btn"
            hitSlop={6}
            selected={st().voiceStatus.mutedByHost}
            accessibilityLabel={
              st().voiceStatus.mutedByHost
                ? loc() === "en-US"
                  ? "Unmute"
                  : "取消静音"
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
                ? "w-8 h-8 rounded-full border border-face-amber-edge bg-lighting-bg items-center justify-center active:opacity-75 focus-visible:border-stage-pill-fg"
                : "w-8 h-8 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75 focus-visible:border-stage-pill-fg"
            }
          >
            <WerewolfStageIcon
              name={st().voiceStatus.mutedByHost ? "speaker_off" : "speaker_on"}
              tone={st().voiceStatus.mutedByHost ? "amber" : "stageFg"}
              size={15}
            />
          </Button>
        </If>

        <Menu
          offset={6}
          popupClass={menuPopupClass}
          backdropClass="bg-backdrop"
          trigger={
            <View
              testID="werewolf-more-menu-btn"
              accessibilityLabel={
                loc() === "en-US" ? "More match actions" : "更多对局操作"
              }
              hitSlop={6}
              class="w-8 h-8 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75 focus-visible:border-stage-pill-fg"
            >
              <WerewolfStageIcon name="more_dots" tone="stageFg" size={15} />
            </View>
          }
        >
          <If when={canExplode()}>
            <MenuItem
              testID="werewolf-open-explode-btn"
              class={menuItemClass}
              onSelect={() => {
                explodeAttempted.set(false);
                explodeDialogOpen.set(true);
              }}
            >
              <Text class="text-destructive text-sm font-semibold">
                {loc() === "en-US" ? "Werewolf Self-Explode…" : "狼人自爆…"}
              </Text>
            </MenuItem>
          </If>

          <If
            when={
              isVotingPhase() &&
              st().votedSeats.length < st().eligibleVoterSeats.length
            }
          >
            <MenuItem
              testID="werewolf-early-finalize-menu-btn"
              class={menuItemClass}
              onSelect={() => {
                void confirmEarlyFinalize();
              }}
            >
              <Text class="text-foreground text-sm font-medium">
                {loc() === "en-US"
                  ? "Finalize Early (Unvoted = Abstain)…"
                  : "提前结算（未投视为弃票）…"}
              </Text>
            </MenuItem>
          </If>

          <If when={st().lan.claimedSeats.length > 0}>
            <Each of={st().lan.claimedSeats} key={(s) => s}>
              {(seatAcc) => {
                const seat = () => seatAcc();
                return (
                  <MenuItem
                    testID={`werewolf-release-seat-${seat()}`}
                    class={menuItemClass}
                    onSelect={() => {
                      void props.ctx.sendCommand({
                        type: "release_lan_seat",
                        seat: seat(),
                      });
                    }}
                  >
                    <Text class="text-foreground text-sm font-medium">
                      {loc() === "en-US"
                        ? `Unbind Seat #${seat()}`
                        : `解绑 #${seat()} 座位`}
                    </Text>
                  </MenuItem>
                );
              }}
            </Each>
          </If>

          <If when={st().lan.active}>
            <MenuItem
              testID="werewolf-refresh-lan-btn"
              class={menuItemClass}
              onSelect={() => {
                void props.ctx.sendCommand({ type: "refresh_lan_address" });
              }}
            >
              <Text class="text-foreground text-sm font-medium">
                {loc() === "en-US" ? "Refresh LAN Address" : "刷新局域网地址"}
              </Text>
            </MenuItem>
          </If>

          <MenuItem
            testID="werewolf-menu-settings-btn"
            class={menuItemClass}
            onSelect={() => props.ctx.openPluginSettings()}
          >
            <Text class="text-foreground text-sm font-medium">
              {loc() === "en-US" ? "Rules & Deck Settings" : "规则与配牌设置"}
            </Text>
          </MenuItem>

          <If
            when={
              st().phase !== "idle" &&
              st().phase !== "lobby" &&
              st().phase !== "game_over"
            }
          >
            <MenuSeparator class="my-1 h-px bg-border" />
            <MenuItem
              testID="werewolf-abort-match-btn"
              class={menuItemClass}
              onSelect={() => {
                void confirmAbortMatch();
              }}
            >
              <Text class="text-destructive text-sm font-semibold">
                {loc() === "en-US" ? "Abort Match…" : "终止本局…"}
              </Text>
            </MenuItem>
            <MenuItem
              testID="werewolf-drawer-exit-btn"
              class={menuItemClass}
              onSelect={() => {
                void confirmQuitWerewolf();
              }}
            >
              <Text class="text-destructive text-sm font-medium">
                {loc() === "en-US" ? "Quit Werewolf…" : "退出狼人杀…"}
              </Text>
            </MenuItem>
          </If>
        </Menu>
      </View>

      {/* Self-explode seat picker Dialog */}
      <Dialog
        testID="werewolf-explode-dialog"
        open={explodeDialogOpen() && canExplode()}
        animation={reduceMotion() ? "none" : "fade"}
        presentation="fullScreen"
        accessibilityLabel={
          loc() === "en-US" ? "Select Self-Exploding Werewolf" : "选择自爆狼人"
        }
        closeOnEscape={true}
        closeOnBackdropPress={true}
        onOpenChange={(e) => {
          if (!e.open) explodeDialogOpen.set(false);
        }}
        backdropClass="bg-backdrop"
        class="m-auto rounded-2xl border border-stage-rose-border bg-stage-panel p-4 shadow-lg"
        style={{
          width: Math.min(440, windowSize().width - 32),
        }}
      >
        <View testID="werewolf-explode-picker" class="gap-3">
          <View class="gap-1">
            <Text class="text-face-rose-core text-base font-bold">
              {loc() === "en-US"
                ? "Select Self-Exploding Werewolf"
                : "选择自爆狼人座位"}
            </Text>
            <Text class="text-stage-muted text-xs">
              {loc() === "en-US"
                ? "Immediately eliminates the werewolf and enters night."
                : "确认后该狼人立即出局，白天发言中止并直接入夜。"}
            </Text>
          </View>

          <View class="flex-row flex-wrap gap-2">
            <Each
              of={st().seats.filter((s) => s.alive)}
              key={(item) => item.seat}
            >
              {(seatAcc) => {
                const s = () => seatAcc();
                return (
                  <Button
                    testID={`werewolf-explode-seat-${s().seat}`}
                    onPress={() => {
                      explodeAttempted.set(true);
                      void props.ctx
                        .sendCommand({
                          type: "trigger_wolf_explode",
                          wolfSeat: s().seat,
                        })
                        .then(() => {
                          if (!props.ctx.uiError()) {
                            explodeAttempted.set(false);
                            explodeDialogOpen.set(false);
                          }
                        });
                    }}
                    class="min-w-14 min-h-11 px-3 rounded-xl border border-stage-rose-border bg-stage-rose-bg items-center justify-center active:opacity-75"
                  >
                    <Text
                      class="text-face-rose-core text-xs font-bold"
                      style={{ fontVariant: ["tabular-nums"] }}
                    >
                      {loc() === "en-US" ? `#${s().seat}` : `${s().seat}号`}
                    </Text>
                  </Button>
                );
              }}
            </Each>
          </View>

          <If when={explodeAttempted() && Boolean(props.ctx.uiError())}>
            <Text class="text-face-rose-core text-xs font-medium">
              {props.ctx.uiError()}
            </Text>
          </If>

          <View class="flex-row justify-end">
            <Button
              testID="werewolf-cancel-explode-btn"
              onPress={() => explodeDialogOpen.set(false)}
              class="min-h-11 px-4 rounded-xl border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
            >
              <Text class="text-stage-pill-fg text-xs font-semibold">
                {loc() === "en-US" ? "Cancel" : "取消"}
              </Text>
            </Button>
          </View>
        </View>
      </Dialog>
    </View>
  );
}
