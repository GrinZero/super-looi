import {
  Clipboard,
  effect,
  reduceMotion,
  Scroll,
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
  firstNightStartsAtMs: null,
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
  completedMatchId: null,
  matchHistory: [],
  matchHistoryLoadError: null,
  matchHistoryVersion: 0,
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

export function readWerewolfDiagnostic(
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>,
): string {
  const error = ctx.lastError();
  const code = error?.code === undefined ? "" : ` code=${String(error.code)}`;
  return ctx.uiError() || (error ? `[stage=${error.stage}${code}] ${error.reason}` : "");
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

const SHERIFF_CAPSULE_LABELS: Record<
  WerewolfSheriffSubphase,
  Record<"zh-CN" | "en-US", string>
> = {
  signup: { "zh-CN": "上警报名", "en-US": "Sheriff" },
  speech: { "zh-CN": "警上发言", "en-US": "Sheriff" },
  voting: { "zh-CN": "警长投票", "en-US": "Sheriff Vote" },
  pk_speech: { "zh-CN": "警长PK", "en-US": "Sheriff PK" },
  pk_voting: { "zh-CN": "警长PK投", "en-US": "Sheriff PK" },
};

const PHASE_CAPSULE_LABELS: Partial<
  Record<WerewolfPhase, Record<"zh-CN" | "en-US", string>>
> = {
  night_intro: { "zh-CN": "入夜", "en-US": "Night" },
  night_guard: { "zh-CN": "守卫", "en-US": "Guard" },
  night_wolf: { "zh-CN": "狼人", "en-US": "Wolves" },
  night_witch: { "zh-CN": "女巫", "en-US": "Witch" },
  night_seer: { "zh-CN": "预言家", "en-US": "Seer" },
  sheriff_election: { "zh-CN": "警长竞选", "en-US": "Sheriff" },
  day_voting: { "zh-CN": "放逐公投", "en-US": "Vote" },
  day_pk_speech: { "zh-CN": "平票PK", "en-US": "Tie PK" },
  day_pk_voting: { "zh-CN": "平票重投", "en-US": "Tie Vote" },
  day_discussion: { "zh-CN": "白天发言", "en-US": "Discuss" },
  dawn_settle: { "zh-CN": "天亮结算", "en-US": "Dawn" },
  dawn_announce: { "zh-CN": "昨夜公告", "en-US": "Dawn" },
  leave_resolution: { "zh-CN": "离场结算", "en-US": "Leave" },
};

function formatCapsulePhaseLabel(
  phase: WerewolfPhase,
  sub: WerewolfSheriffSubphase | null,
  locale: "zh-CN" | "en-US",
): string {
  if (phase === "sheriff_election" && sub) {
    return SHERIFF_CAPSULE_LABELS[sub][locale];
  }
  return PHASE_CAPSULE_LABELS[phase]?.[locale] ?? phase;
}

export function WerewolfStageCapsule(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
}) {
  const explodeDialogOpen = signal(false);
  const explodeAttempted = signal(false);
  const seatManageDialogOpen = signal(false);
  const errorDialogOpen = signal(false);
  const errorCopied = signal(false);
  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();
  const diagnosticError = () => readWerewolfDiagnostic(props.ctx);

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
            ? `N${s.day}·`
            : `第${s.day}夜·`
          : loc() === "en-US"
            ? `D${s.day}·`
            : `第${s.day}天·`
        : "";
    return `${dayPrefix}${formatCapsulePhaseLabel(s.phase, s.sheriffSubphase, loc())}`;
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
      return loc() === "en-US" ? "Subtitles" : "字幕";
    }
    if (vs.speaking) return loc() === "en-US" ? "Speaking" : "播报中";
    return loc() === "en-US" ? "Voice" : "语音";
  };

  const voiceStatusTextClass = () => {
    const vs = st().voiceStatus;
    if (vs.mutedByHost || vs.speaking || vs.degradedToSubtitles) {
      return "text-face-amber-core text-xs font-semibold shrink-0";
    }
    return "text-stage-muted text-xs font-medium shrink-0";
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
    "min-w-52 rounded-2xl border border-stage-pill-border bg-stage-panel p-1.5 shadow-lg";
  const menuItemClass =
    "min-h-11 rounded-xl px-3 py-2 flex-row items-center justify-between active:bg-stage-tile focus:bg-stage-tile";

  return (
    <View
      testID="werewolf-stage-capsule"
      class="flex-row items-center gap-1.5 max-w-full"
    >
      {/* Left status cluster */}
      <View class="flex-row items-center gap-1 min-w-0 shrink">
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
          <View class="w-px h-3 bg-stage-pill-border shrink-0" />
          <Text
            testID="werewolf-capsule-voice-status"
            class={voiceStatusTextClass()}
            style={{ numberOfLines: 1 }}
          >
            {voiceStatusLabel()}
          </Text>
        </If>
      </View>

      {/* Right compact 44x44pt quick actions */}
      <View class="flex-row items-center gap-1.5 shrink-0">
        <If when={Boolean(diagnosticError())}>
          <Button
            testID="werewolf-stage-error-btn"
            hitSlop={4}
            accessibilityLabel={
              loc() === "en-US" ? "View error details" : "查看异常详情"
            }
            onPress={() => {
              errorCopied.set(false);
              errorDialogOpen.set(true);
            }}
            class="w-11 h-11 rounded-full border border-stage-rose-border bg-stage-rose-bg items-center justify-center active:opacity-75 focus-visible:border-face-rose-edge"
          >
            <WerewolfStageIcon name="alert" tone="rose" size={17} />
          </Button>
        </If>

        <If when={showJudgeVoiceControls()}>
          <Button
            testID="werewolf-mute-speech-btn"
            hitSlop={4}
            selected={st().voiceStatus.mutedByHost}
            accessibilityLabel={
              st().voiceStatus.mutedByHost
                ? loc() === "en-US"
                  ? "Unmute"
                  : "取消静音"
                : loc() === "en-US"
                  ? "Mute"
                  : "静音"
            }
            onPress={() => {
              void props.ctx.sendCommand({
                type: "set_judge_voice_muted",
                muted: !st().voiceStatus.mutedByHost,
              });
            }}
            class={
              st().voiceStatus.mutedByHost
                ? "w-11 h-11 rounded-full border border-stage-amber-border bg-stage-amber-bg items-center justify-center active:opacity-75 focus-visible:border-stage-pill-fg"
                : "w-11 h-11 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75 focus-visible:border-stage-pill-fg"
            }
          >
            <WerewolfStageIcon
              name={st().voiceStatus.mutedByHost ? "speaker_off" : "speaker_on"}
              tone={st().voiceStatus.mutedByHost ? "amber" : "stageFg"}
              size={17}
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
              hitSlop={4}
              class="w-11 h-11 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75 focus-visible:border-stage-pill-fg"
            >
              <WerewolfStageIcon name="more_dots" tone="stageFg" size={17} />
            </View>
          }
        >
          <If when={showJudgeVoiceControls() && canReplaySpeech()}>
            <MenuItem
              testID="werewolf-replay-speech-btn"
              class={menuItemClass}
              onSelect={() => {
                void props.ctx.sendCommand({ type: "replay_last_speech" });
              }}
            >
              <Text class="text-stage-fg text-sm font-medium">
                {loc() === "en-US" ? "Replay Last Speech" : "重播本轮语音"}
              </Text>
            </MenuItem>
          </If>

          <If when={canExplode()}>
            <MenuItem
              testID="werewolf-open-explode-btn"
              class={menuItemClass}
              onSelect={() => {
                explodeAttempted.set(false);
                explodeDialogOpen.set(true);
              }}
            >
              <Text class="text-face-rose-core text-sm font-semibold">
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
              <Text class="text-stage-fg text-sm font-medium">
                {loc() === "en-US"
                  ? "Finalize Early (Unvoted = Abstain)…"
                  : "提前结算（未投视为弃票）…"}
              </Text>
            </MenuItem>
          </If>

          <If when={st().lan.claimedSeats.length > 0 && st().lan.claimedSeats.length <= 3}>
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
                    <Text class="text-stage-fg text-sm font-medium">
                      {loc() === "en-US"
                        ? `Unbind Seat #${seat()}`
                        : `解绑 #${seat()} 座位`}
                    </Text>
                  </MenuItem>
                );
              }}
            </Each>
          </If>

          <If when={st().lan.claimedSeats.length > 3}>
            <MenuItem
              testID="werewolf-manage-lan-seats-btn"
              class={menuItemClass}
              onSelect={() => {
                seatManageDialogOpen.set(true);
              }}
            >
              <Text class="text-stage-fg text-sm font-medium">
                {loc() === "en-US"
                  ? `Manage Claimed Seats (${st().lan.claimedSeats.length})…`
                  : `管理已入座副屏 (${st().lan.claimedSeats.length})…`}
              </Text>
            </MenuItem>
          </If>

          <If when={st().lan.active}>
            <MenuItem
              testID="werewolf-refresh-lan-btn"
              class={menuItemClass}
              onSelect={() => {
                void props.ctx.sendCommand({ type: "refresh_lan_address" });
              }}
            >
              <Text class="text-stage-fg text-sm font-medium">
                {loc() === "en-US" ? "Refresh LAN Address" : "刷新局域网地址"}
              </Text>
            </MenuItem>
          </If>

          <MenuItem
            testID="werewolf-menu-settings-btn"
            class={menuItemClass}
            onSelect={() => props.ctx.openPluginSettings()}
          >
            <Text class="text-stage-fg text-sm font-medium">
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
            <MenuSeparator class="my-1 h-px bg-stage-pill-border" />
            <MenuItem
              testID="werewolf-abort-match-btn"
              class={menuItemClass}
              onSelect={() => {
                void confirmAbortMatch();
              }}
            >
              <Text class="text-face-rose-core text-sm font-semibold">
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
              <Text class="text-face-rose-core text-sm font-medium">
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
          maxHeight: Math.max(180, windowSize().height - 32),
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

          <Scroll
            class="min-h-0"
            style={{ maxHeight: Math.max(100, windowSize().height - 180) }}
          >
            <View
              class={
                st().seats.filter((s) => s.alive).length > 6
                  ? "grid grid-cols-4 gap-2"
                  : "grid grid-cols-3 gap-2"
              }
            >
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
                      class="min-h-11 px-3 rounded-xl border border-stage-rose-border bg-stage-rose-bg items-center justify-center active:opacity-75"
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
          </Scroll>

          <If when={explodeAttempted() && Boolean(props.ctx.uiError())}>
            <Text class="text-face-rose-core text-xs font-medium">
              {props.ctx.uiError()}
            </Text>
          </If>

          <View class="flex-row justify-end">
            <Button
              testID="werewolf-cancel-explode-btn"
              onPress={() => explodeDialogOpen.set(false)}
              class="min-h-11 px-5 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75 focus-visible:border-stage-pill-fg"
            >
              <Text class="text-stage-pill-fg text-xs font-semibold">
                {loc() === "en-US" ? "Cancel" : "取消"}
              </Text>
            </Button>
          </View>
        </View>
      </Dialog>

      {/* Claimed LAN seats management Dialog (>3 seats) */}
      <Dialog
        testID="werewolf-manage-lan-seats-dialog"
        open={seatManageDialogOpen() && st().lan.claimedSeats.length > 0}
        animation={reduceMotion() ? "none" : "fade"}
        presentation="fullScreen"
        accessibilityLabel={
          loc() === "en-US" ? "Manage Claimed LAN Seats" : "管理已入座副屏"
        }
        closeOnEscape={true}
        closeOnBackdropPress={true}
        onOpenChange={(e) => {
          if (!e.open) seatManageDialogOpen.set(false);
        }}
        backdropClass="bg-backdrop"
        class="m-auto rounded-2xl border border-stage-pill-border bg-stage-panel p-4 shadow-lg"
        style={{
          width: Math.min(440, windowSize().width - 32),
          maxHeight: Math.max(180, windowSize().height - 32),
        }}
      >
        <View class="gap-3">
          <View class="gap-1">
            <Text class="text-stage-fg text-base font-bold">
              {loc() === "en-US" ? "Manage Claimed Seats" : "管理已入座副屏"}
            </Text>
            <Text class="text-stage-muted text-xs">
              {loc() === "en-US"
                ? "Tap a seat below to release its phone binding so another phone can scan and join."
                : "轻触以下已绑定座位可解除副屏绑定，便于更换手机重新扫码。"}
            </Text>
          </View>

          <View class="grid grid-cols-4 gap-2">
            <Each of={st().lan.claimedSeats} key={(s) => s}>
              {(seatAcc) => {
                const seat = () => seatAcc();
                return (
                  <Button
                    testID={`werewolf-release-seat-${seat()}`}
                    onPress={() => {
                      void props.ctx.sendCommand({
                        type: "release_lan_seat",
                        seat: seat(),
                      });
                    }}
                    class="min-h-11 px-2.5 rounded-xl border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
                  >
                    <Text
                      class="text-stage-pill-fg text-xs font-semibold"
                      style={{ fontVariant: ["tabular-nums"] }}
                    >
                      {loc() === "en-US" ? `Unbind #${seat()}` : `解绑 #${seat()}`}
                    </Text>
                  </Button>
                );
              }}
            </Each>
          </View>

          <View class="flex-row justify-end">
            <Button
              testID="werewolf-manage-lan-seats-close-btn"
              onPress={() => seatManageDialogOpen.set(false)}
              class="min-h-11 px-5 rounded-full bg-eye-core items-center justify-center active:opacity-75"
            >
              <Text class="text-stage-bg text-xs font-bold">
                {loc() === "en-US" ? "Done" : "完成"}
              </Text>
            </Button>
          </View>
        </View>
      </Dialog>

      {/* Stage error diagnostic Dialog (Rule 16: exposes full stage/code/reason) */}
      <Dialog
        testID="werewolf-stage-error-dialog"
        open={errorDialogOpen() && Boolean(diagnosticError())}
        animation={reduceMotion() ? "none" : "fade"}
        presentation="fullScreen"
        accessibilityLabel={
          loc() === "en-US" ? "Stage Error Diagnostic" : "舞台运行异常详情"
        }
        closeOnEscape={true}
        closeOnBackdropPress={true}
        onOpenChange={(e) => {
          if (!e.open) errorDialogOpen.set(false);
        }}
        backdropClass="bg-backdrop"
        class="m-auto rounded-2xl border border-stage-rose-border bg-stage-panel p-4 shadow-lg"
        style={{
          width: Math.min(480, windowSize().width - 32),
          maxHeight: Math.max(180, windowSize().height - 32),
        }}
      >
        <View class="gap-3">
          <View class="flex-row items-center gap-2">
            <WerewolfStageIcon name="alert" tone="rose" size={18} />
            <Text class="text-face-rose-core text-base font-bold">
              {loc() === "en-US" ? "Stage Error Details" : "舞台运行异常详情"}
            </Text>
          </View>

          <Scroll class="max-h-40 rounded-xl border border-stage-pill-border bg-stage-tile">
            <View class="px-3 py-2.5" selectable={true}>
              <Text
                testID="werewolf-stage-error-text"
                class="text-face-rose-core text-xs font-mono"
                role="alert"
              >
                {diagnosticError()}
              </Text>
            </View>
          </Scroll>

          <View class="flex-row items-center justify-end gap-2">
            <Button
              testID="werewolf-stage-error-copy-btn"
              onPress={() => {
                const text = diagnosticError();
                if (!text) return;
                void Clipboard.writeText(text).then(() => errorCopied.set(true));
              }}
              class="min-h-11 px-4 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
            >
              <Text class="text-stage-pill-fg text-xs font-semibold">
                {errorCopied()
                  ? loc() === "en-US"
                    ? "Copied"
                    : "已复制"
                  : loc() === "en-US"
                    ? "Copy Details"
                    : "复制详情"}
              </Text>
            </Button>
            <Button
              testID="werewolf-stage-error-close-btn"
              onPress={() => errorDialogOpen.set(false)}
              class="min-h-11 px-5 rounded-full bg-eye-core items-center justify-center active:opacity-75"
            >
              <Text class="text-stage-bg text-xs font-bold">
                {loc() === "en-US" ? "Close" : "关闭"}
              </Text>
            </Button>
          </View>
        </View>
      </Dialog>
    </View>
  );
}
