import {
  Canvas,
  cleanup,
  createAnimatedValue,
  createMotion,
  effect,
  Image,
  reduceMotion,
  Scroll,
  signal,
  Text,
  token,
  View,
} from "nsh";
import { Button } from "nsh/base";
import { DeviceCameraPreview } from "../../../ui/DeviceCameraPreview";
import type { PluginViewContext } from "../../../ui/plugins/ui-contracts";
import {
  WEREWOLF_PHASE_LABELS,
  WEREWOLF_PRESET_LABELS,
  WEREWOLF_ROLE_HINTS,
  WEREWOLF_ROLE_LABELS,
  WEREWOLF_ROLES,
  isGodRole,
  isWolfRole,
  type WerewolfCommand,
  type WerewolfPresetId,
  type WerewolfPublicState,
  type WerewolfRole,
  type WerewolfSeatPublicView,
} from "../contracts";
import { WEREWOLF_HISTORY_TITLE } from "./HistoryView";
import { WerewolfHistoryOverlay, type WerewolfHistoryRoute } from "./HistoryOverlay";
import { QrCodeCanvas } from "./QrCodeCanvas";
import { readWerewolfDiagnostic, readWerewolfState } from "./StageCapsule";
import {
  WerewolfRoleIcon,
  WerewolfStageIcon,
  type WerewolfIconTone,
} from "./WerewolfIcons";

const HOLD_THRESHOLD_MS = 220;
const NIGHT_GATE_HOLD_MS = 350;

/**
 * Shared hold-to-reveal + tap-toggle press handler with slide-out/touch-cancel protection:
 * - Holding >= thresholdMs immediately masks (0ms) inside onPressUp.
 * - Releasing/sliding out before thresholdMs schedules a short grace timer cleared by onPress;
 *   if onPress never fires (finger slid off or touch canceled), the shield masks immediately.
 */
function createPrivacyHoldHandlers(options: {
  thresholdMs: number;
  isOpen: () => boolean;
  setOpen: (open: boolean) => void;
  onDown?: () => void;
  onPressMark?: () => void;
}) {
  let downAtMs = 0;
  let hadDown = false;
  let wasOpenOnDown = false;
  let holdConsumed = false;
  let slideOutTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelSlideTimer = () => {
    if (slideOutTimer !== null) {
      clearTimeout(slideOutTimer);
      slideOutTimer = null;
    }
  };
  cleanup(cancelSlideTimer);

  return {
    reset: () => {
      cancelSlideTimer();
      downAtMs = 0;
      hadDown = false;
      wasOpenOnDown = false;
      holdConsumed = false;
    },
    onPressDown: () => {
      cancelSlideTimer();
      options.onDown?.();
      hadDown = true;
      wasOpenOnDown = options.isOpen();
      downAtMs = Date.now();
      holdConsumed = false;
      if (!wasOpenOnDown) {
        options.setOpen(true);
      }
    },
    onPressUp: () => {
      if (downAtMs > 0 && Date.now() - downAtMs >= options.thresholdMs) {
        cancelSlideTimer();
        holdConsumed = true;
        downAtMs = 0;
        options.setOpen(false);
        return;
      }
      if (hadDown && !wasOpenOnDown) {
        cancelSlideTimer();
        slideOutTimer = setTimeout(() => {
          slideOutTimer = null;
          if (hadDown && !holdConsumed) {
            hadDown = false;
            downAtMs = 0;
            options.setOpen(false);
          }
        }, 48);
      }
    },
    onPress: () => {
      cancelSlideTimer();
      options.onPressMark?.();
      if (holdConsumed) {
        holdConsumed = false;
        hadDown = false;
        return;
      }
      if (hadDown) {
        hadDown = false;
        downAtMs = 0;
        if (wasOpenOnDown) {
          options.setOpen(false);
        }
        return;
      }
      downAtMs = 0;
      options.setOpen(!options.isOpen());
    },
  };
}

const PRESET_TABS: ReadonlyArray<{
  readonly id: WerewolfPresetId;
  readonly zh: string;
  readonly en: string;
}> = [
  { id: "6p_joy", zh: "6人欢乐局", en: "6P Joy" },
  { id: "9p_standard", zh: "9人标准局", en: "9P Std" },
  { id: "12p_guard", zh: "12人守卫", en: "12P Guard" },
  { id: "12p_idiot", zh: "12人白痴", en: "12P Idiot" },
];

function roleFactionTone(role: WerewolfRole): WerewolfIconTone {
  if (isWolfRole(role)) return "rose";
  if (isGodRole(role)) return "amber";
  return "sage";
}

function roleFactionTag(
  role: WerewolfRole,
  locale: "zh-CN" | "en-US",
): { label: string; cardClass: string; badgeTextClass: string } {
  if (isWolfRole(role)) {
    return {
      label: locale === "en-US" ? "Werewolf Pack" : "狼人阵营",
      cardClass:
        "rounded-2xl border border-stage-rose-border bg-stage-rose-bg p-3 gap-1.5",
      badgeTextClass: "text-face-rose-core text-xs font-semibold",
    };
  }
  if (isGodRole(role)) {
    return {
      label: locale === "en-US" ? "Priesthood" : "神职阵营",
      cardClass:
        "rounded-2xl border border-stage-amber-border bg-stage-amber-bg p-3 gap-1.5",
      badgeTextClass: "text-face-amber-core text-xs font-semibold",
    };
  }
  return {
    label: locale === "en-US" ? "Villagers" : "平民阵营",
    cardClass:
      "rounded-2xl border border-stage-sage-border bg-stage-sage-bg p-3 gap-1.5",
    badgeTextClass: "text-face-sage-core text-xs font-semibold",
  };
}

function formatClockMmSs(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(safe / 60)).padStart(2, "0");
  const ss = String(safe % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function WerewolfStageCompanion(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
}) {
  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();

  const phase = () => st().phase;
  const goodWon = () => st().winner === "good";

  const isDaySpeechCompanion = () => {
    const p = phase();
    if (p === "dawn_announce" || p === "day_discussion" || p === "day_pk_speech") {
      return true;
    }
    if (p === "sheriff_election") {
      const sub = st().sheriffSubphase;
      return sub === "speech" || sub === "pk_speech";
    }
    return false;
  };

  const dealingMainText = () => {
    const seat = st().dealingCurrentSeat;
    if (seat === null) {
      return loc() === "en-US"
        ? "Close your eyes."
        : "请闭眼，准备入夜。";
    }
    return loc() === "en-US"
      ? `Player #${seat}, inspect your role.`
      : `${seat}号玩家，请查看你的身份。`;
  };

  const dealingSubText = () => {
    if (st().rules.surfaceMode === "lan_companion") {
      return loc() === "en-US"
        ? "Check privately on your phone"
        : "请在各自手机副屏查看身份";
    }
    return loc() === "en-US"
      ? "Release to hide immediately"
      : "松手立即遮蔽";
  };

  const daySpeechMainText = () => {
    const s = st();
    if (s.speakingSeat !== null) {
      return loc() === "en-US"
        ? `Player #${s.speakingSeat}, please speak.`
        : `现在请${s.speakingSeat}号玩家发言。`;
    }
    return (
      s.voiceStatus.lastSpokenText ||
      s.lastJudgeSpeech ||
      (loc() === "en-US" ? "Listen attentively." : "请按顺序轮流发言。")
    );
  };

  const daySpeechSubText = () => {
    if (st().voiceStatus.degradedToSubtitles) {
      return loc() === "en-US" ? "Subtitles Only" : "语音异常已转字幕";
    }
    return loc() === "en-US"
      ? "Other players please listen quietly"
      : "其余玩家请耐心聆听";
  };

  return (
    <View
      testID="werewolf-stage-companion"
      class="w-full items-center justify-start px-2 gap-1"
      style={{ pointerEvents: "none" }}
    >
      <If when={phase() === "dealing"}>
        <Text
          class="text-stage-fg text-sm font-bold text-center"
          style={{ numberOfLines: 2 }}
        >
          {dealingMainText()}
        </Text>
        <If when={st().dealingCurrentSeat !== null}>
          <Text
            class="text-stage-pill-muted text-xs text-center"
            style={{ numberOfLines: 1 }}
          >
            {dealingSubText()}
          </Text>
        </If>
      </If>

      <If when={isDaySpeechCompanion()}>
        <Text
          testID="werewolf-judge-subtitle"
          class="text-stage-fg text-sm font-bold text-center"
          style={{ numberOfLines: 2 }}
        >
          {daySpeechMainText()}
        </Text>
        <If
          when={st().voiceStatus.degradedToSubtitles}
          else={
            <Text
              class="text-stage-pill-muted text-xs text-center"
              style={{ numberOfLines: 1 }}
            >
              {daySpeechSubText()}
            </Text>
          }
        >
          <Text
            testID="werewolf-voice-degraded-badge"
            class="text-warning text-xs font-semibold text-center"
            style={{ numberOfLines: 1 }}
          >
            {daySpeechSubText()}
          </Text>
        </If>
      </If>

      <If when={phase() === "game_over"}>
        <View
          testID="werewolf-winner-banner"
          class="items-center gap-0.5"
        >
          <Text
            class={
              goodWon()
                ? "text-face-sage-core text-lg font-bold text-center"
                : "text-face-rose-core text-lg font-bold text-center"
            }
            style={{ numberOfLines: 1 }}
          >
            {goodWon()
              ? loc() === "en-US"
                ? "Good Camp Wins"
                : "好人阵营获胜"
              : loc() === "en-US"
                ? "Werewolves Win"
                : "狼人阵营获胜"}
          </Text>
          <If when={Boolean(st().winReason)}>
            <Text
              class="text-stage-pill-fg text-xs font-medium text-center"
              style={{ numberOfLines: 2 }}
            >
              {st().winReason}
            </Text>
          </If>
        </View>
      </If>
    </View>
  );
}

const COMPACT_ROLE_LABELS: Record<
  WerewolfRole,
  Record<"zh-CN" | "en-US", string>
> = {
  werewolf: { "zh-CN": "狼", "en-US": "W" },
  white_wolf_king: { "zh-CN": "白狼", "en-US": "WWK" },
  seer: { "zh-CN": "预", "en-US": "S" },
  witch: { "zh-CN": "巫", "en-US": "Wi" },
  hunter: { "zh-CN": "猎", "en-US": "H" },
  guard: { "zh-CN": "守", "en-US": "G" },
  idiot: { "zh-CN": "愚", "en-US": "Id" },
  villager: { "zh-CN": "民", "en-US": "V" },
};

function LobbyStagePanel(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
  onOpenHistory: () => void;
}) {
  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();

  const surfaceTrackWidth = signal(0);
  const surfaceSlideTx = createAnimatedValue(0);
  let surfaceInitialized = false;

  effect(() => {
    const slotW = Math.max(0, (surfaceTrackWidth() - 8) / 2);
    const targetX = st().rules.surfaceMode === "lan_companion" ? slotW : 0;
    if (!surfaceInitialized || reduceMotion() || slotW <= 0) {
      surfaceSlideTx.set(targetX);
      if (slotW > 0) surfaceInitialized = true;
      return;
    }
    void surfaceSlideTx.timing(targetX, { duration: 240, easing: "easeInOut" });
  });

  const activeRoleEntries = () =>
    WEREWOLF_ROLES.filter((role) => (st().rules.roleCounts[role] ?? 0) > 0).map(
      (role) => ({
        role,
        label: WEREWOLF_ROLE_LABELS[role][loc()],
        count: st().rules.roleCounts[role] ?? 0,
      }),
    );

  const hasGuardInDeck = () => (st().rules.roleCounts.guard ?? 0) > 0;

  const isLanMode = () =>
    st().rules.surfaceMode === "lan_companion" || st().lan.active;

  const seatGridColsClass = () =>
    st().rules.playerCount <= 6
      ? "grid grid-cols-3 gap-2"
      : "grid grid-cols-4 gap-1.5";

  const roleSummaryLine = () => {
    const entries = activeRoleEntries();
    const useCompact = entries.length >= 6;
    return entries
      .map(
        (entry) =>
          `${useCompact ? COMPACT_ROLE_LABELS[entry.role][loc()] : entry.label}×${entry.count}`,
      )
      .join(" · ");
  };

  const formatLanAddress = () => {
    const raw = st().lan.baseUrl?.trim() ?? "";
    return raw.replace(/^https?:\/\//, "");
  };

  const claimedCount = () => st().lan.claimedSeats.length;
  const targetPlayers = () => st().rules.playerCount;
  const allClaimed = () =>
    targetPlayers() > 0 && claimedCount() >= targetPlayers();

  const panelEnter = createMotion(
    reduceMotion() ? {} : { enter: "fadeIn", duration: 180 },
  );

  return (
    <View
      testID="werewolf-lobby-panel"
      class="flex-1 min-h-0 flex-row gap-3"
      style={{ pointerEvents: "auto", opacity: panelEnter.opacity }}
    >
      {/* Left Panel (54%): Header + Presets + Compact Distribution + Sliding Surface + Single-Row Rule Chips */}
      <View class="flex-[1.18] min-w-0 min-h-0 rounded-3xl border border-stage-pill-border bg-stage-panel p-3 justify-between gap-2">
        <View class="flex-row items-start justify-between gap-2 shrink-0">
          <View class="flex-1 min-w-0 gap-0.5">
            <Text
              class="text-stage-fg text-lg font-bold"
              style={{ numberOfLines: 1 }}
            >
              {loc() === "en-US" ? "Tonight, let's play." : "今晚，来一局。"}
            </Text>
            <Text
              class="text-stage-pill-muted text-xs"
              style={{ numberOfLines: 1 }}
            >
              {loc() === "en-US"
                ? "Choose a board and let LOOI host"
                : "选择板子，让 LOOI 主持"}
            </Text>
          </View>

          <Button
            testID="werewolf-lobby-open-history"
            onPress={props.onOpenHistory}
            class="min-h-11 px-2 rounded-full flex-row items-center gap-1 shrink-0 active:opacity-75 hover:bg-stage-pill-bg transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-face-amber-edge"
          >
            <WerewolfStageIcon name="clock" tone="stageMuted" size={16} />
            <Text class="text-stage-pill-fg text-xs font-medium">{WEREWOLF_HISTORY_TITLE[loc()]}</Text>
          </Button>
          <Button
            testID="werewolf-open-settings-btn"
            hitSlop={6}
            onPress={() => props.ctx.openPluginSettings()}
            class="min-h-11 px-2 -mr-1 rounded-full flex-row items-center gap-0.5 shrink-0 active:opacity-75"
          >
            <Text class="text-stage-pill-fg text-xs font-medium">
              {loc() === "en-US" ? "Rules" : "调整规则"}
            </Text>
            <WerewolfStageIcon name="chevron_right" tone="stageMuted" size={14} />
          </Button>
        </View>

        {/* Single-row presets */}
        <View class="flex-row items-center gap-1.5 shrink-0">
          <Each of={PRESET_TABS} key={(item) => item.id}>
            {(tabAcc) => {
              const tab = () => tabAcc();
              const active = () => st().rules.presetId === tab().id;
              return (
                <Button
                  testID={`werewolf-preset-${tab().id}`}
                  selected={active()}
                  hitSlop={{ top: 2, bottom: 2 }}
                  onPress={() => {
                    void props.ctx.sendCommand({
                      type: "select_preset",
                      presetId: tab().id,
                    });
                  }}
                  class={
                    active()
                      ? "flex-1 min-w-0 h-10 px-1.5 rounded-xl border border-stage-amber-border bg-stage-amber-bg items-center justify-center transition-transform duration-180 active:scale-[0.97] motion-reduce:active:scale-100"
                      : "flex-1 min-w-0 h-10 px-1.5 rounded-xl border border-stage-pill-border bg-stage-tile items-center justify-center transition-transform duration-180 active:scale-[0.97] motion-reduce:active:scale-100"
                  }
                >
                  <Text
                    class={
                      active()
                        ? "text-face-amber-core text-xs font-bold text-center"
                        : "text-stage-fg text-xs font-medium text-center"
                    }
                    style={{ numberOfLines: 1 }}
                  >
                    {loc() === "en-US" ? tab().en : tab().zh}
                  </Text>
                </Button>
              );
            }}
          </Each>
        </View>

        {/* Compact single-line role composition summary */}
        <Text
          class="text-stage-fg text-xs font-medium px-0.5 shrink-0"
          style={{ numberOfLines: 1, fontVariant: ["tabular-nums"] }}
        >
          {roleSummaryLine()}
        </Text>

        <View class="h-px bg-stage-pill-border shrink-0" />

        {/* Surface mode segmented toggle with 240ms sliding indicator */}
        <View
          onLayout={(ev) => surfaceTrackWidth.set(ev.bounds.size.width)}
          class="relative rounded-2xl border border-stage-pill-border bg-stage-tile p-1 flex-row items-center shrink-0"
        >
          <If when={surfaceTrackWidth() > 8}>
            <View
              class="absolute top-1 bottom-1 left-1 rounded-xl border border-stage-amber-border bg-stage-amber-bg"
              style={{
                width: Math.max(0, (surfaceTrackWidth() - 8) / 2),
                pointerEvents: "none",
                transform: [{ translateX: surfaceSlideTx }],
              }}
            />
          </If>

          <Button
            testID="werewolf-surface-on_device"
            selected={st().rules.surfaceMode === "on_device"}
            onPress={() => {
              void props.ctx.sendCommand({
                type: "update_rules",
                patch: { surfaceMode: "on_device" },
              });
              void props.ctx.sendCommand({
                type: "toggle_lan_room",
                enabled: false,
              });
            }}
            class="flex-1 h-9 px-2 rounded-xl items-center justify-center active:opacity-80"
          >
            <Text
              class={
                st().rules.surfaceMode === "on_device"
                  ? "text-face-amber-core text-xs font-bold"
                  : "text-stage-fg text-xs font-medium"
              }
            >
              {loc() === "en-US" ? "On-Device Shield" : "本机防窥"}
            </Text>
          </Button>

          <Button
            testID="werewolf-surface-lan_companion"
            selected={st().rules.surfaceMode === "lan_companion"}
            onPress={() => {
              void props.ctx.sendCommand({
                type: "update_rules",
                patch: { surfaceMode: "lan_companion" },
              });
            }}
            class="flex-1 h-9 px-2 rounded-xl items-center justify-center active:opacity-80"
          >
            <Text
              class={
                st().rules.surfaceMode === "lan_companion"
                  ? "text-face-amber-core text-xs font-bold"
                  : "text-stage-fg text-xs font-medium"
              }
            >
              {loc() === "en-US" ? "Phone Companion" : "手机副屏"}
            </Text>
          </Button>
        </View>

        <View class="h-px bg-stage-pill-border shrink-0" />

        {/* Bottom single-row quick chips */}
        <View class="flex-row items-center gap-1.5 shrink-0">
          <Button
            testID="werewolf-toggle-sheriff"
            selected={st().rules.hasSheriff}
            hitSlop={{ top: 4, bottom: 4 }}
            onPress={() => {
              void props.ctx.sendCommand({
                type: "update_rules",
                patch: { hasSheriff: !st().rules.hasSheriff },
              });
            }}
            class={
              st().rules.hasSheriff
                ? "flex-1 min-w-0 h-9 px-2 rounded-full border border-stage-amber-border bg-stage-amber-bg items-center justify-center active:opacity-75"
                : "flex-1 min-w-0 h-9 px-2 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
            }
          >
            <Text
              class={
                st().rules.hasSheriff
                  ? "text-face-amber-core text-xs font-semibold"
                  : "text-stage-pill-muted text-xs"
              }
              style={{ numberOfLines: 1 }}
            >
              {st().rules.hasSheriff
                ? loc() === "en-US"
                  ? "Sheriff"
                  : "警长开"
                : loc() === "en-US"
                  ? "No Sheriff"
                  : "警长关"}
            </Text>
          </Button>

          <Button
            testID="werewolf-toggle-winmode"
            selected={st().rules.winMode === "slaughter_all"}
            hitSlop={{ top: 4, bottom: 4 }}
            onPress={() => {
              void props.ctx.sendCommand({
                type: "update_rules",
                patch: {
                  winMode:
                    st().rules.winMode === "slaughter_all"
                      ? "slaughter_side"
                      : "slaughter_all",
                },
              });
            }}
            class={
              st().rules.winMode === "slaughter_all"
                ? "flex-1 min-w-0 h-9 px-2 rounded-full border border-stage-amber-border bg-stage-amber-bg items-center justify-center active:opacity-75"
                : "flex-1 min-w-0 h-9 px-2 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
            }
          >
            <Text
              class={
                st().rules.winMode === "slaughter_all"
                  ? "text-face-amber-core text-xs font-semibold"
                  : "text-stage-pill-muted text-xs"
              }
              style={{ numberOfLines: 1 }}
            >
              {st().rules.winMode === "slaughter_all"
                ? loc() === "en-US"
                  ? "Slaughter All"
                  : "屠城"
                : loc() === "en-US"
                  ? "Slaughter Side"
                  : "屠边"}
            </Text>
          </Button>

          <If when={hasGuardInDeck()}>
            <Button
              testID="werewolf-toggle-same-guard-save"
              selected={st().rules.sameGuardSameSaveDies}
              hitSlop={{ top: 4, bottom: 4 }}
              onPress={() => {
                void props.ctx.sendCommand({
                  type: "update_rules",
                  patch: {
                    sameGuardSameSaveDies: !st().rules.sameGuardSameSaveDies,
                  },
                });
              }}
              class={
                st().rules.sameGuardSameSaveDies
                  ? "flex-1 min-w-0 h-9 px-2 rounded-full border border-stage-amber-border bg-stage-amber-bg items-center justify-center active:opacity-75"
                  : "flex-1 min-w-0 h-9 px-2 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
              }
            >
              <Text
                class={
                  st().rules.sameGuardSameSaveDies
                    ? "text-face-amber-core text-xs font-semibold"
                    : "text-stage-pill-muted text-xs"
                }
                style={{ numberOfLines: 1 }}
              >
                {st().rules.sameGuardSameSaveDies
                  ? loc() === "en-US"
                    ? "Clash Dies"
                    : "同守救倒"
                  : loc() === "en-US"
                    ? "Clash Lives"
                    : "同守救活"}
              </Text>
            </Button>
          </If>

          <Button
            testID="werewolf-toggle-motion"
            selected={st().rules.motionMode === "embodied_patrol"}
            hitSlop={{ top: 4, bottom: 4 }}
            onPress={() => {
              void props.ctx.sendCommand({
                type: "update_rules",
                patch: {
                  motionMode:
                    st().rules.motionMode === "embodied_patrol"
                      ? "stationary_gaze"
                      : "embodied_patrol",
                },
              });
            }}
            class={
              st().rules.motionMode === "embodied_patrol"
                ? "flex-1 min-w-0 h-9 px-2 rounded-full border border-stage-mist-border bg-stage-mist-bg items-center justify-center active:opacity-75"
                : "flex-1 min-w-0 h-9 px-2 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
            }
          >
            <Text
              class={
                st().rules.motionMode === "embodied_patrol"
                  ? "text-face-mist-core text-xs font-semibold"
                  : "text-stage-pill-muted text-xs"
              }
              style={{ numberOfLines: 1 }}
            >
              {st().rules.motionMode === "embodied_patrol"
                ? loc() === "en-US"
                  ? "Embodied"
                  : "具身环视"
                : loc() === "en-US"
                  ? "Gaze Only"
                  : "纯眼神"}
            </Text>
          </Button>
        </View>
      </View>

      {/* Right Panel (46%): QR Companion Join OR On-Device Summary + Start CTA */}
      <View class="flex-1 min-w-0 min-h-0 rounded-3xl border border-stage-pill-border bg-stage-panel p-3 justify-between gap-2">
        <If
          when={isLanMode()}
          else={
            <View class="flex-1 min-h-0 justify-between gap-2">
              <View class="flex-row items-center justify-between gap-2">
                <Text class="text-stage-fg text-lg font-bold">
                  {loc() === "en-US" ? "Local Tabletop" : "本机防窥模式"}
                </Text>
                <Text
                  class="text-face-amber-core text-xs font-semibold"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {loc() === "en-US"
                    ? `${st().rules.playerCount} Seats`
                    : `共 ${st().rules.playerCount} 人`}
                </Text>
              </View>

              <View class="flex-1 min-h-0 justify-center gap-2.5">
                <View class={seatGridColsClass()}>
                  <Each of={st().seats} key={(item) => item.seat}>
                    {(seatAcc) => (
                      <View class="items-center justify-center">
                        <View
                          class={
                            st().rules.playerCount <= 9
                              ? "w-10 h-10 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center"
                              : "w-9 h-9 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center"
                          }
                        >
                          <Text
                            class="text-stage-fg text-xs font-bold"
                            style={{ fontVariant: ["tabular-nums"] }}
                          >
                            {String(seatAcc().seat)}
                          </Text>
                        </View>
                      </View>
                    )}
                  </Each>
                </View>

                <Text
                  class="text-stage-pill-muted text-xs text-center"
                  style={{ numberOfLines: 1 }}
                >
                  {st().visionAvailable
                    ? loc() === "en-US"
                      ? "Pass seat-by-seat; camera aligns & captures portraits."
                      : "按座位轮流传递主机查看底牌；视觉追踪就绪可抓拍。"
                    : loc() === "en-US"
                      ? "Pass seat-by-seat; hold shield to peek, release to hide."
                      : "按座位轮流传递主机查看底牌，按住查看、松手遮蔽。"}
                </Text>
              </View>
            </View>
          }
        >
          <View class="flex-1 min-h-0 justify-between gap-2">
            <View class="flex-row items-center justify-between gap-2">
              <Text class="text-stage-fg text-lg font-bold">
                {loc() === "en-US" ? "Scan to Join" : "扫码入座"}
              </Text>
              <View class="flex-row items-center gap-1.5">
                <Text
                  class={
                    allClaimed()
                      ? "text-face-sage-core text-xs font-semibold"
                      : claimedCount() > 0
                        ? "text-face-amber-core text-xs font-semibold"
                        : "text-stage-pill-muted text-xs font-semibold"
                  }
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {loc() === "en-US"
                    ? `${claimedCount()} / ${targetPlayers()} Ready`
                    : `${claimedCount()} / ${targetPlayers()} 已就绪`}
                </Text>
                <If when={allClaimed()}>
                  <WerewolfStageIcon name="check_circle" tone="sage" size={14} />
                </If>
              </View>
            </View>

            <View class="flex-1 min-h-0 flex-row items-center gap-2.5">
              <QrCodeCanvas
                value={st().lan.baseUrl ?? ""}
                size={104}
                locale={loc()}
                surface="stage"
                onNotify={(msg) => props.ctx.notify(msg)}
              />

              <View class="flex-1 min-w-0 justify-center">
                <View class={seatGridColsClass()}>
                  <Each of={st().seats} key={(item) => item.seat}>
                    {(seatAcc) => {
                      const s = () => seatAcc();
                      const circleClass = () =>
                        targetPlayers() <= 9
                          ? s().lanClaimed
                            ? "relative w-9 h-9 rounded-full border border-face-sage-edge bg-stage-sage-bg items-center justify-center"
                            : "relative w-9 h-9 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center"
                          : s().lanClaimed
                            ? "relative w-8 h-8 rounded-full border border-face-sage-edge bg-stage-sage-bg items-center justify-center"
                            : "relative w-8 h-8 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center";
                      return (
                        <View class="items-center justify-center p-0.5">
                          <View class={circleClass()}>
                            <Text
                              class={
                                s().lanClaimed
                                  ? "text-stage-fg text-xs font-bold"
                                  : "text-stage-pill-muted text-xs font-semibold"
                              }
                              style={{ fontVariant: ["tabular-nums"] }}
                            >
                              {String(s().seat)}
                            </Text>
                            <If when={s().lanClaimed}>
                              <View class="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-stage-panel border border-face-sage-edge items-center justify-center">
                                <WerewolfStageIcon
                                  name="check"
                                  tone="sage"
                                  size={10}
                                />
                              </View>
                            </If>
                          </View>
                        </View>
                      );
                    }}
                  </Each>
                </View>
              </View>
            </View>

            <If
              when={Boolean(st().lan.error)}
              else={
                <View class="flex-row items-center gap-1.5">
                  <WerewolfStageIcon name="wifi" tone="stageMuted" size={14} />
                  <Text
                    testID="werewolf-lan-url"
                    class="text-stage-pill-muted text-xs flex-1 font-mono"
                    style={{ numberOfLines: 1 }}
                  >
                    {formatLanAddress()
                      ? `${loc() === "en-US" ? "Same Wi-Fi" : "同 Wi-Fi 扫码"} · ${formatLanAddress()}`
                      : loc() === "en-US"
                        ? "Starting LAN room…"
                        : "正在开启局域网房间…"}
                  </Text>
                </View>
              }
            >
              <Text class="text-face-rose-core text-xs" style={{ numberOfLines: 1 }}>
                {st().lan.error}
              </Text>
            </If>
          </View>
        </If>

        <Button
          testID="werewolf-start-dealing-btn"
          onPress={() => {
            void props.ctx.sendCommand({ type: "start_dealing" });
          }}
          class="min-h-11 rounded-full bg-eye-core flex-row items-center justify-center gap-1.5 transition-transform duration-180 active:scale-[0.97] motion-reduce:active:scale-100"
        >
          <Text class="text-stage-bg text-sm font-bold">
            {loc() === "en-US" ? "Shuffle & Deal Cards" : "开始洗牌发牌"}
          </Text>
          <WerewolfStageIcon name="arrow_right" tone="stageBg" size={16} />
        </Button>
      </View>
    </View>
  );
}

function DealingStageCard(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
}) {
  const lanLocalDealSeat = signal<number | null>(null);
  const peekedSeat = signal<number | null>(null);
  const firstNightSeconds = signal<number | null>(null);

  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();
  const currentSeatNum = () => st().dealingCurrentSeat;
  const firstNightStartsAtMs = () => st().firstNightStartsAtMs;

  effect(() => {
    const startsAtMs = firstNightStartsAtMs();
    if (startsAtMs === null) {
      firstNightSeconds.set(null);
      return;
    }
    const update = () =>
      firstNightSeconds.set(Math.max(0, Math.ceil((startsAtMs - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 100);
    cleanup(() => clearInterval(timer));
  });

  effect(() => {
    const num = currentSeatNum();
    if (peekedSeat() !== num && isRevealing()) {
      peekedSeat.set(num);
    }
  });

  const currentSeat = (): WerewolfSeatPublicView | undefined => {
    const num = currentSeatNum();
    if (num === null) return undefined;
    return st().seats.find((s) => s.seat === num);
  };
  const isRevealing = () => {
    const num = currentSeatNum();
    return num !== null && st().dealingRevealingSeat === num;
  };

  const dealHold = createPrivacyHoldHandlers({
    thresholdMs: HOLD_THRESHOLD_MS,
    isOpen: isRevealing,
    onDown: () => {
      const seat = currentSeatNum();
      if (seat !== null) peekedSeat.set(seat);
    },
    onPressMark: () => {
      const seat = currentSeatNum();
      if (seat !== null) peekedSeat.set(seat);
    },
    setOpen: (revealing) => {
      const seat = currentSeatNum();
      if (seat === null) return;
      void props.ctx.sendCommand({
        type: "set_deal_reveal",
        seat,
        revealing,
      });
    },
  });
  const hasPeekedCurrent = () =>
    currentSeatNum() !== null && peekedSeat() === currentSeatNum();
  const showLanCompanionDealCard = () =>
    st().rules.surfaceMode === "lan_companion" &&
    lanLocalDealSeat() !== currentSeatNum() &&
    !isRevealing();
  const totalCount = () => st().seats.length || st().rules.playerCount;

  const cardEnter = createMotion(
    reduceMotion() ? {} : { enter: "fadeIn", duration: 180 },
  );

  return (
    <View
      testID="werewolf-dealing-panel"
      class="flex-1 min-h-0 rounded-3xl border border-stage-pill-border bg-stage-panel p-3.5 justify-between gap-2"
      style={{ pointerEvents: "auto", opacity: cardEnter.opacity }}
    >
      {/* Top progress nodes: 1..N circular badges */}
      <View class="gap-1.5 shrink-0">
        <View class="flex-row items-center gap-1.5 flex-wrap">
          <Each of={st().seats} key={(item) => item.seat}>
            {(seatAcc) => {
              const s = () => seatAcc();
              const isCurrent = () => st().dealingCurrentSeat === s().seat;
              return (
                <View
                  class={
                    s().dealtConfirmed
                      ? "w-6 h-6 rounded-full border border-face-sage-edge bg-stage-sage-bg items-center justify-center"
                      : isCurrent()
                        ? "w-6 h-6 rounded-full border-2 border-face-amber-edge bg-stage-amber-bg items-center justify-center"
                        : "w-6 h-6 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center"
                  }
                >
                  <If
                    when={s().dealtConfirmed}
                    else={
                      <Text
                        class={
                          isCurrent()
                            ? "text-face-amber-core text-xs font-bold"
                            : "text-stage-pill-muted text-xs"
                        }
                        style={{ fontVariant: ["tabular-nums"] }}
                      >
                        {String(s().seat)}
                      </Text>
                    }
                  >
                    <WerewolfStageIcon name="check" tone="sage" size={12} />
                  </If>
                </View>
              );
            }}
          </Each>
        </View>

        <If when={currentSeatNum() !== null}>
          <View class="flex-row items-center gap-2.5">
            <Text
              class="text-stage-fg text-base font-bold"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {loc() === "en-US"
                ? `Player #${currentSeatNum()}`
                : `${currentSeatNum()}号玩家`}
            </Text>
            <View class="w-px h-3.5 bg-stage-pill-border" />
            <Text class="text-stage-pill-muted text-xs font-medium">
              {showLanCompanionDealCard()
                ? loc() === "en-US"
                  ? "Waiting on phone"
                  : "等待手机领牌"
                : loc() === "en-US"
                  ? "Waiting to peek"
                  : "等待领牌"}
            </Text>
          </View>
        </If>
      </View>

      {/* Main content: active seat dealing OR all-confirmed ready state */}
      <If
        when={currentSeatNum() !== null && Boolean(currentSeat())}
        else={
          <View
            testID="werewolf-dealing-complete"
            class="flex-1 items-center justify-center gap-3 px-4"
          >
            <Text class="text-stage-fg text-lg font-bold text-center">
              {loc() === "en-US"
                ? `All ${totalCount()} Seats Confirmed`
                : `全员领牌完毕（${totalCount()}/${totalCount()}）`}
            </Text>
            <View class="items-center gap-1">
              <Text
                testID="werewolf-first-night-countdown"
                class="text-face-sage-core text-4xl font-bold text-center"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {firstNightSeconds() ?? "—"}
              </Text>
              <Text class="text-stage-pill-fg text-sm font-medium text-center">
                {firstNightSeconds() === null
                  ? loc() === "en-US" ? "Countdown paused" : "倒计时已暂停"
                  : loc() === "en-US" ? "Seconds until Night 1" : "秒后进入首夜"}
              </Text>
            </View>
            <Text class="text-stage-pill-muted text-xs text-center">
              {loc() === "en-US"
                ? 'Say “Start the game” to begin now.'
                : "说「开始游戏」可提前入夜"}
            </Text>
            <If when={st().canStepBackDeal}>
              <Button
                testID="werewolf-step-back-deal-btn"
                onPress={() => {
                  lanLocalDealSeat.set(null);
                  void props.ctx.sendCommand({ type: "step_back_deal" });
                }}
                class="min-h-11 px-4 rounded-full border border-stage-pill-border bg-stage-tile flex-row items-center gap-1.5 active:opacity-75"
              >
                <WerewolfStageIcon name="arrow_left" tone="stageFg" size={14} />
                <Text class="text-stage-pill-fg text-xs font-semibold">
                  {loc() === "en-US" ? "Previous seat" : "上一位"}
                </Text>
              </Button>
            </If>
          </View>
        }
      >
        <View class="flex-1 min-h-0 justify-between gap-2">
          {/* Two-column body separated by single thin hairline (zero nested card-in-card) */}
          <View class="flex-1 min-h-0 flex-row items-stretch gap-3">
            {/* Left column: 56x56 Camera ring or seat portrait */}
            <View class="w-24 shrink-0 items-center justify-center gap-1.5">
              <View
                class={
                  st().dealingFaceAligned
                    ? "w-14 h-14 rounded-full border-2 border-face-sage-edge bg-stage-tile overflow-hidden items-center justify-center"
                    : "w-14 h-14 rounded-full border border-stage-pill-border bg-stage-tile overflow-hidden items-center justify-center"
                }
              >
                <If
                  when={Boolean(st().previewSessionId)}
                  else={
                    <If
                      when={Boolean(currentSeat()?.portraitDataUri)}
                      else={
                        <WerewolfStageIcon
                          name="avatar_silhouette"
                          tone="stageMuted"
                          size={26}
                        />
                      }
                    >
                      <Image
                        testID="werewolf-seat-portrait"
                        src={currentSeat()?.portraitDataUri ?? ""}
                        class="w-full h-full rounded-full"
                      />
                    </If>
                  }
                >
                  <DeviceCameraPreview
                    sessionId={st().previewSessionId ?? ""}
                    class="w-full h-full"
                  />
                </If>
              </View>

              <If when={Boolean(st().previewSessionId) || st().visionAvailable}>
                <Text
                  class={
                    st().dealingFaceAligned
                      ? "text-face-sage-core text-xs font-medium text-center"
                      : "text-stage-pill-muted text-xs text-center"
                  }
                  style={{ numberOfLines: 1 }}
                >
                  {st().dealingFaceAligned
                    ? loc() === "en-US"
                      ? "Aligned"
                      : "已对准"
                    : loc() === "en-US"
                      ? "Align Face"
                      : "请对准"}
                </Text>
                <Button
                  testID="werewolf-capture-portrait-btn"
                  hitSlop={4}
                  onPress={() => {
                    const seat = currentSeatNum();
                    if (seat === null) return;
                    void props.ctx.sendCommand({
                      type: "capture_seat_portrait",
                      seat,
                    });
                  }}
                  class="h-9 px-3 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
                >
                  <Text class="text-stage-pill-fg text-xs font-medium">
                    {loc() === "en-US" ? "Capture" : "抓拍头像"}
                  </Text>
                </Button>
              </If>
            </View>

            <View class="w-px bg-stage-pill-border my-1 shrink-0" />

            {/* Right column: Privacy shield OR revealed card OR LAN companion info */}
            <View class="flex-1 min-w-0 justify-center">
              <If
                when={showLanCompanionDealCard()}
                else={
                  <If
                    when={isRevealing() && Boolean(currentSeat()?.revealedRole)}
                    else={
                      <View
                        testID="werewolf-deal-masked-card"
                        class="items-center justify-center gap-1.5 px-2 py-3"
                      >
                        <WerewolfStageIcon
                          name="privacy_shield"
                          tone="amber"
                          size={34}
                        />
                        <Text class="text-stage-fg text-base font-bold text-center">
                          {loc() === "en-US"
                            ? "Your Role is Hidden"
                            : "你的身份已遮蔽"}
                        </Text>
                        <Text class="text-stage-pill-muted text-xs text-center">
                          {loc() === "en-US"
                            ? "Hold the button below to view your role"
                            : "按住下方按钮查看底牌"}
                        </Text>
                      </View>
                    }
                  >
                    {() => {
                      const role = currentSeat()!.revealedRole!;
                      const tag = roleFactionTag(role, loc());
                      return (
                        <View
                          testID="werewolf-deal-role-card"
                          class={`justify-center py-3.5 px-4 ${tag.cardClass}`}
                        >
                          <View class="flex-row items-center justify-between gap-2">
                            <View class="flex-row items-center gap-2">
                              <WerewolfRoleIcon
                                role={role}
                                tone={roleFactionTone(role)}
                                size={22}
                              />
                              <Text class="text-stage-fg text-lg font-bold">
                                {WEREWOLF_ROLE_LABELS[role][loc()]}
                              </Text>
                            </View>
                            <Text class={tag.badgeTextClass}>{tag.label}</Text>
                          </View>
                          <Text
                            class="text-stage-fg text-xs"
                            style={{ numberOfLines: 3 }}
                          >
                            {WEREWOLF_ROLE_HINTS[role][loc()]}
                          </Text>
                        </View>
                      );
                    }}
                  </If>
                }
              >
                <View class="flex-1 items-center justify-center gap-1.5 px-2">
                  <WerewolfStageIcon
                    name="privacy_shield"
                    tone="amber"
                    size={32}
                  />
                  <Text class="text-stage-fg text-sm font-bold text-center">
                    {loc() === "en-US"
                      ? `Phone Dealing · Seat #${currentSeatNum()}`
                      : `手机副屏领牌中 · #${currentSeatNum()} 号`}
                  </Text>
                  <Text
                    class="text-stage-pill-muted text-xs text-center"
                    style={{ numberOfLines: 3 }}
                  >
                    {loc() === "en-US"
                      ? "Players inspect roles on their own phones. Confirm for a seat without a phone."
                      : "每位玩家在各自手机查看身份并确认；无手机玩家可点本机查牌或代确认。"}
                  </Text>
                </View>
              </If>
            </View>
          </View>

          {/* Bottom full-width action row (at most 3 clean controls, zero squeezing) */}
          <If
            when={showLanCompanionDealCard()}
            else={
              <View class="flex-row items-center justify-between gap-2 shrink-0">
                <View class="flex-row items-center gap-1.5 shrink-0">
                  <If when={st().canStepBackDeal}>
                    <Button
                      testID="werewolf-step-back-deal-btn"
                      onPress={() => {
                        dealHold.reset();
                        lanLocalDealSeat.set(null);
                        void props.ctx.sendCommand({ type: "step_back_deal" });
                      }}
                      class="min-h-11 px-3 rounded-full border border-stage-pill-border bg-stage-tile flex-row items-center gap-1 active:opacity-75"
                    >
                      <WerewolfStageIcon name="arrow_left" tone="stageFg" size={14} />
                      <Text
                        class="text-stage-pill-fg text-xs font-medium"
                        style={{ numberOfLines: 1 }}
                      >
                        {loc() === "en-US" ? "Prev" : "上一位"}
                      </Text>
                    </Button>
                  </If>

                  <If
                    when={
                      st().rules.surfaceMode === "lan_companion" &&
                      lanLocalDealSeat() === currentSeatNum()
                    }
                  >
                    <Button
                      testID="werewolf-lan-local-cancel-btn"
                      onPress={() => {
                        const seat = currentSeatNum();
                        dealHold.reset();
                        if (seat !== null && isRevealing()) {
                          void props.ctx.sendCommand({
                            type: "set_deal_reveal",
                            seat,
                            revealing: false,
                          });
                        }
                        lanLocalDealSeat.set(null);
                      }}
                      class="min-h-11 px-2.5 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
                    >
                      <Text class="text-stage-pill-fg text-xs font-medium">
                        {loc() === "en-US" ? "Phone" : "副屏"}
                      </Text>
                    </Button>
                  </If>
                </View>

                <View class="flex-1 min-w-0 flex-row items-center justify-end gap-2">
                  <Button
                    testID="werewolf-deal-reveal-btn"
                    accessibilityLabel={
                      loc() === "en-US"
                        ? "Hold or press to reveal role card"
                        : "按住查看底牌"
                    }
                    onPressDown={() => {
                      if (currentSeatNum() === null) return;
                      dealHold.onPressDown();
                    }}
                    onPressUp={() => {
                      if (currentSeatNum() === null) return;
                      dealHold.onPressUp();
                    }}
                    onPress={() => {
                      if (currentSeatNum() === null) return;
                      dealHold.onPress();
                    }}
                    class={
                      isRevealing()
                        ? "flex-1 min-w-0 min-h-11 px-3 rounded-full border border-stage-amber-border bg-stage-amber-bg flex-row items-center justify-center gap-1.5 active:opacity-80"
                        : !hasPeekedCurrent()
                          ? "flex-1 min-w-0 min-h-11 px-3 rounded-full bg-eye-core flex-row items-center justify-center gap-1.5 transition-transform duration-180 active:scale-[0.97] motion-reduce:active:scale-100"
                          : "flex-1 min-w-0 min-h-11 px-3 rounded-full border border-stage-pill-border bg-stage-tile flex-row items-center justify-center gap-1.5 active:opacity-80"
                    }
                  >
                    <WerewolfStageIcon
                      name="hold_hand"
                      tone={
                        isRevealing()
                          ? "amber"
                          : !hasPeekedCurrent()
                            ? "stageBg"
                            : "stageFg"
                      }
                      size={16}
                    />
                    <Text
                      class={
                        isRevealing()
                          ? "text-face-amber-core text-xs font-bold"
                          : !hasPeekedCurrent()
                            ? "text-stage-bg text-xs font-bold"
                            : "text-stage-fg text-xs font-semibold"
                      }
                      style={{ numberOfLines: 1 }}
                    >
                      {isRevealing()
                        ? loc() === "en-US"
                          ? "Tap to Hide"
                          : "松手或点击隐藏"
                        : loc() === "en-US"
                          ? "Hold to Peek"
                          : "按住查看底牌"}
                    </Text>
                  </Button>

                  <Button
                    testID="werewolf-deal-confirm-btn"
                    onPress={() => {
                      const seat = currentSeatNum();
                      if (seat === null) return;
                      dealHold.reset();
                      lanLocalDealSeat.set(null);
                      void props.ctx.sendCommand({
                        type: "confirm_seat_dealt",
                        seat,
                      });
                    }}
                    class={
                      hasPeekedCurrent()
                        ? "min-h-11 px-3.5 rounded-full bg-eye-core items-center justify-center shrink-0 transition-transform duration-180 active:scale-[0.97] motion-reduce:active:scale-100"
                        : "min-h-11 px-3.5 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center shrink-0 active:opacity-75"
                    }
                  >
                    <Text
                      class={
                        hasPeekedCurrent()
                          ? "text-stage-bg text-xs font-bold"
                          : "text-stage-pill-fg text-xs font-medium"
                      }
                      style={{ numberOfLines: 1 }}
                    >
                      {loc() === "en-US" ? "Next" : "记住了，下一位"}
                    </Text>
                  </Button>
                </View>
              </View>
            }
          >
            {/* LAN companion dealing actions (never silently skip undealt seats) */}
            <View class="flex-row items-center justify-between gap-2 shrink-0">
              <If when={st().canStepBackDeal} else={<View />}>
                <Button
                  testID="werewolf-step-back-deal-btn"
                  onPress={() => {
                    lanLocalDealSeat.set(null);
                    void props.ctx.sendCommand({ type: "step_back_deal" });
                  }}
                  class="min-h-11 px-3 rounded-full border border-stage-pill-border bg-stage-tile flex-row items-center gap-1 active:opacity-75"
                >
                  <WerewolfStageIcon name="arrow_left" tone="stageFg" size={14} />
                  <Text class="text-stage-pill-fg text-xs font-medium">
                    {loc() === "en-US" ? "Prev" : "上一位"}
                  </Text>
                </Button>
              </If>

              <View class="flex-row items-center gap-2">
                <Button
                  testID="werewolf-lan-local-deal-btn"
                  onPress={() => lanLocalDealSeat.set(currentSeatNum())}
                  class="min-h-11 px-3.5 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
                >
                  <Text class="text-stage-pill-fg text-xs font-semibold">
                    {loc() === "en-US" ? "Local Peek" : "本机查牌"}
                  </Text>
                </Button>
                <Button
                  testID="werewolf-deal-confirm-btn"
                  onPress={() => {
                    const seat = currentSeatNum();
                    if (seat === null) return;
                    void props.ctx.sendCommand({
                      type: "confirm_seat_dealt",
                      seat,
                    });
                  }}
                  class="min-h-11 px-4 rounded-full bg-eye-core items-center justify-center active:opacity-75"
                >
                  <Text class="text-stage-bg text-xs font-bold">
                    {loc() === "en-US"
                      ? `Confirm #${currentSeatNum()}`
                      : `代 #${currentSeatNum()} 确认`}
                  </Text>
                </Button>
              </View>
            </View>
          </If>
        </View>
      </If>
    </View>
  );
}

/**
 * Shared Night Role Action Panel:
 * Mounted directly inside StageCanvas during `on_device` night turns,
 * and inside StageDrawer when `lan_companion` host override is expanded.
 */
export function WerewolfNightActionBody(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
  onCollapseLanOverride?: () => void;
}) {
  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();

  const prompt = () => st().nightPrompt;
  const activeRole = () => prompt()?.activeRole ?? null;
  const unlocked = () => Boolean(prompt()?.gateUnlocked);
  const selectedSeat = () => prompt()?.selectedTargetSeat ?? null;

  const nightGateHold = createPrivacyHoldHandlers({
    thresholdMs: NIGHT_GATE_HOLD_MS,
    isOpen: unlocked,
    setOpen: (unlock) => {
      void props.ctx.sendCommand({
        type: "set_night_gate",
        unlocked: unlock,
      });
    },
  });

  const isRoseAction = () =>
    activeRole() === "witch" || activeRole() === "werewolf";

  const roleWakeTitle = () => {
    const r = activeRole();
    if (r === "seer" && prompt()?.seerResult) {
      return loc() === "en-US" ? "Inspection Result" : "查验结果";
    }
    if (loc() === "en-US") {
      if (r === "guard") return "Guard, Choose Tonight's Target";
      if (r === "werewolf") return "Werewolves, Choose Your Target";
      if (r === "witch") return "Witch, Choose Tonight's Action";
      if (r === "seer") return "Seer, Choose One Player to Inspect";
      return "Night Action";
    }
    if (r === "guard") return "守卫，请选择今晚守护的玩家";
    if (r === "werewolf") return "狼人，请确认今晚袭击的目标";
    if (r === "witch") return "女巫，请选择今晚的行动";
    if (r === "seer") return "预言家，请选择查验的玩家";
    return "夜间行动";
  };

  const roleSubtitle = () => {
    const r = activeRole();
    const p = prompt();
    if (r === "seer" && p?.seerResult) {
      return loc() === "en-US"
        ? "Confirm alignment below before closing your eyes."
        : "确认下方查验结论后，点击闭眼结束。";
    }
    if (r === "guard") {
      return p?.lastGuardedSeat !== null && p?.lastGuardedSeat !== undefined
        ? loc() === "en-US"
          ? `Protected #${p.lastGuardedSeat} last night (cannot guard consecutively).`
          : `昨晚已守护 ${p.lastGuardedSeat}号，不可连续两晚守护同一人。`
        : loc() === "en-US"
          ? "Pick one living player to guard, or pass empty."
          : "请选择一名存活玩家守护，或直接空守。";
    }
    if (r === "werewolf") {
      const mates = p?.wolfTeammateSeats.map((s) => `${s}号`).join("、") || "-";
      return loc() === "en-US"
        ? `Pack teammates: ${p?.wolfTeammateSeats.map((s) => `#${s}`).join(", ") || "-"}`
        : `狼队存活同伴：${mates}，选座后点击确认袭击。`;
    }
    if (r === "witch") {
      const wc = p?.witchContext;
      if (wc?.canSave && wc.attackedSeat !== null) {
        return loc() === "en-US"
          ? `Player #${wc.attackedSeat} was attacked tonight. Use antidote, poison, or pass.`
          : `今晚 ${wc.attackedSeat}号被狼人袭击，可使用解药或选择毒药目标。`;
      }
      if (wc?.antidoteAvailable && wc.attackedSeat !== null) {
        return loc() === "en-US"
          ? "You were attacked tonight (self-save disabled by rules). Use poison or close your eyes."
          : "今晚你成为袭击目标，按当前规则不可自救；可使用毒药或直接闭眼。";
      }
      if (wc?.antidoteAvailable) {
        return loc() === "en-US"
          ? "No one was attacked tonight. Use poison or close your eyes."
          : "今晚无人被袭击（空刀），可使用毒药或直接闭眼。";
      }
      return loc() === "en-US"
        ? "Antidote used. Pick a poison target or close your eyes."
        : "解药已用尽，可使用毒药或直接闭眼。";
    }
    if (r === "seer") {
      return loc() === "en-US"
        ? "Select one living player to reveal their alignment."
        : "请选择一名存活玩家查验其阵营。";
    }
    return "";
  };

  const targetSummaryTitle = () => {
    const r = activeRole();
    const wc = prompt()?.witchContext;
    if (
      r === "witch" &&
      selectedSeat() === null &&
      wc?.canSave &&
      wc.attackedSeat !== null
    ) {
      return loc() === "en-US" ? "Tonight's Victim" : "今晚刀口";
    }
    if (loc() === "en-US") {
      if (r === "witch") return "Poison Target";
      if (r === "werewolf") return "Attack Target";
      if (r === "guard") return "Guard Target";
      return "Inspect Target";
    }
    if (r === "witch") return "毒药目标";
    if (r === "werewolf") return "袭击目标";
    if (r === "guard") return "守护目标";
    return "查验目标";
  };

  const seatGridClass = () =>
    st().seats.length <= 9 ? "grid grid-cols-3 gap-2" : "grid grid-cols-4 gap-1.5";

  return (
    <If
      when={unlocked()}
      else={
        <View
          testID="werewolf-night-gate-panel"
          class="flex-1 items-center justify-center gap-2.5 px-4"
        >
          <WerewolfStageIcon name="privacy_shield" tone="amber" size={34} />
          <Text class="text-stage-fg text-base font-bold text-center">
            {roleWakeTitle()}
          </Text>
          <Text class="text-stage-pill-muted text-xs text-center">
            {loc() === "en-US"
              ? "Tap to unlock the role panel, or hold to peek and release to hide."
              : "仅当前睁眼角色操作：点击解锁技能面板，或按住查看、松手立即遮蔽"}
          </Text>
          <View class="flex-row items-center gap-2">
            <If when={Boolean(props.onCollapseLanOverride)}>
              <Button
                onPress={() => props.onCollapseLanOverride?.()}
                class="min-h-11 px-4 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
              >
                <Text class="text-stage-pill-fg text-xs font-medium">
                  {loc() === "en-US" ? "Collapse" : "收起"}
                </Text>
              </Button>
            </If>
            <Button
              testID="werewolf-night-gate-btn"
              onPressDown={nightGateHold.onPressDown}
              onPressUp={nightGateHold.onPressUp}
              onPress={nightGateHold.onPress}
              class="min-h-11 px-6 rounded-full border border-stage-amber-border bg-stage-amber-bg items-center justify-center active:opacity-80"
            >
              <Text class="text-face-amber-core text-sm font-bold">
                {loc() === "en-US" ? "Unlock Night Turn" : "解锁夜间行动"}
              </Text>
            </Button>
          </View>
        </View>
      }
    >
      <View
        testID="werewolf-night-unlocked-panel"
        class="flex-1 min-h-0 justify-between gap-2"
      >
        {/* Header: Title + Witch status chips + sole subtitle + Mask Now */}
        <View class="flex-row items-start justify-between gap-3 shrink-0">
          <View class="flex-1 min-w-0 gap-0.5">
            <View class="flex-row items-center flex-wrap gap-2">
              <Text class="text-stage-fg text-base font-bold">
                {roleWakeTitle()}
              </Text>

              <If when={activeRole() === "witch"}>
                <View
                  class={
                    prompt()?.witchContext?.antidoteAvailable
                      ? "px-2.5 py-0.5 rounded-full border border-stage-sage-border bg-stage-sage-bg"
                      : "px-2.5 py-0.5 rounded-full border border-stage-pill-border bg-stage-tile"
                  }
                >
                  <Text
                    class={
                      prompt()?.witchContext?.antidoteAvailable
                        ? "text-face-sage-core text-xs font-medium"
                        : "text-stage-pill-muted text-xs font-medium"
                    }
                  >
                    {prompt()?.witchContext?.antidoteAvailable
                      ? loc() === "en-US"
                        ? "Antidote Ready"
                        : "解药 可用"
                      : loc() === "en-US"
                        ? "Antidote Used"
                        : "解药 已用尽"}
                  </Text>
                </View>

                <View
                  class={
                    prompt()?.witchContext?.canPoison
                      ? "px-2.5 py-0.5 rounded-full border border-stage-rose-border bg-stage-rose-bg"
                      : "px-2.5 py-0.5 rounded-full border border-stage-pill-border bg-stage-tile"
                  }
                >
                  <Text
                    class={
                      prompt()?.witchContext?.canPoison
                        ? "text-face-rose-core text-xs font-medium"
                        : "text-stage-pill-muted text-xs font-medium"
                    }
                  >
                    {prompt()?.witchContext?.canPoison
                      ? loc() === "en-US"
                        ? "Poison ×1"
                        : "毒药 1瓶"
                      : loc() === "en-US"
                        ? "Poison Used"
                        : "毒药 已用尽"}
                  </Text>
                </View>
              </If>
            </View>

            <Text
              class="text-stage-pill-muted text-xs"
              style={{ numberOfLines: 1 }}
            >
              {roleSubtitle()}
            </Text>
          </View>

          <View class="flex-row items-center gap-1.5 shrink-0">
            <If when={Boolean(props.onCollapseLanOverride)}>
              <Button
                onPress={() => props.onCollapseLanOverride?.()}
                class="min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
              >
                <Text class="text-stage-pill-fg text-xs font-medium">
                  {loc() === "en-US" ? "Collapse" : "收起"}
                </Text>
              </Button>
            </If>
            <Button
              testID="werewolf-night-gate-lock-btn"
              onPressDown={() => {
                void props.ctx.sendCommand({
                  type: "set_night_gate",
                  unlocked: false,
                });
              }}
              onPress={() => {
                void props.ctx.sendCommand({
                  type: "set_night_gate",
                  unlocked: false,
                });
              }}
              class="min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
            >
              <Text class="text-stage-pill-fg text-xs font-medium">
                {loc() === "en-US" ? "Mask Now" : "立即遮蔽"}
              </Text>
            </Button>
          </View>
        </View>

        {/* Middle body: Seer result OR Left seat grid + vertical hairline + Right target summary */}
        <If
          when={activeRole() === "seer" && Boolean(prompt()?.seerResult)}
          else={
            <View class="flex-1 min-h-0 flex-row items-stretch gap-3">
              <Scroll class="flex-1 min-w-0 min-h-0" contentClass="min-h-full justify-center py-0.5">
                <View class={seatGridClass()}>
                  <Each of={st().seats} key={(item) => item.seat}>
                    {(seatAcc) => {
                      const s = () => seatAcc();
                      const canSelect = () =>
                        Boolean(prompt()?.selectableSeats.includes(s().seat));
                      const isPicked = () => selectedSeat() === s().seat;
                      const compact = () => st().seats.length > 9;
                      const baseTile = () =>
                        compact()
                          ? "min-w-0 h-11 px-2 rounded-xl border"
                          : "min-w-0 min-h-11 px-2.5 rounded-xl border";
                      return (
                        <Button
                          testID={`werewolf-night-seat-${s().seat}`}
                          disabled={!canSelect()}
                          selected={isPicked()}
                          onPress={() => {
                            void props.ctx.sendCommand({
                              type: "select_night_target",
                              targetSeat: isPicked() ? null : s().seat,
                            });
                          }}
                          class={
                            isPicked()
                              ? isRoseAction()
                                ? `${baseTile()} border-stage-rose-border bg-stage-rose-bg flex-row items-center justify-between gap-1 transition-colors duration-120 active:opacity-80 disabled:opacity-30`
                                : `${baseTile()} border-stage-amber-border bg-stage-amber-bg flex-row items-center justify-between gap-1 transition-colors duration-120 active:opacity-80 disabled:opacity-30`
                              : `${baseTile()} border-stage-pill-border bg-stage-tile flex-row items-center gap-1.5 transition-colors duration-120 active:opacity-80 disabled:opacity-30`
                          }
                        >
                          <View class="flex-row items-center gap-1.5 min-w-0 flex-1">
                            <View
                              class={
                                isPicked() && isRoseAction()
                                  ? "w-6 h-6 rounded-full bg-stage-rose-bg items-center justify-center shrink-0"
                                  : isPicked()
                                    ? "w-6 h-6 rounded-full bg-stage-amber-bg items-center justify-center shrink-0"
                                    : "w-6 h-6 rounded-full bg-stage-bg/60 items-center justify-center shrink-0"
                              }
                            >
                              <WerewolfStageIcon
                                name="avatar_silhouette"
                                tone={
                                  isPicked()
                                    ? isRoseAction()
                                      ? "rose"
                                      : "amber"
                                    : "stageMuted"
                                }
                                size={13}
                              />
                            </View>
                            <Text
                              class={
                                isPicked()
                                  ? isRoseAction()
                                    ? "text-face-rose-core text-xs font-bold"
                                    : "text-face-amber-core text-xs font-bold"
                                  : "text-stage-fg text-xs font-semibold"
                              }
                              style={{ fontVariant: ["tabular-nums"], numberOfLines: 1 }}
                            >
                              {loc() === "en-US" ? `#${s().seat}` : `${s().seat}号`}
                            </Text>
                          </View>

                          <If when={isPicked()}>
                            <WerewolfStageIcon
                              name="check"
                              tone={isRoseAction() ? "rose" : "amber"}
                              size={13}
                            />
                          </If>
                        </Button>
                      );
                    }}
                  </Each>
                </View>
              </Scroll>

              <View class="w-px bg-stage-pill-border my-1 shrink-0" />

              {/* Right Target Summary Area */}
              <View class="w-40 shrink-0 items-center justify-center gap-1.5 px-1">
                <If
                  when={activeRole() === "witch"}
                  else={
                    <WerewolfRoleIcon
                      role={activeRole() ?? "villager"}
                      tone={isRoseAction() ? "rose" : "amber"}
                      size={30}
                    />
                  }
                >
                  <WerewolfStageIcon name="potion_bottle" tone="rose" size={32} />
                </If>
                <Text class="text-stage-pill-muted text-xs font-medium text-center">
                  {targetSummaryTitle()}
                </Text>
                <Text
                  class="text-stage-fg text-xl font-bold text-center"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {selectedSeat() !== null
                    ? loc() === "en-US"
                      ? `Player #${selectedSeat()}`
                      : `${selectedSeat()}号玩家`
                    : activeRole() === "witch" &&
                        prompt()?.witchContext?.canSave &&
                        prompt()?.witchContext?.attackedSeat !== null
                      ? loc() === "en-US"
                        ? `Victim #${prompt()!.witchContext!.attackedSeat}`
                        : `刀口 ${prompt()!.witchContext!.attackedSeat}号`
                      : loc() === "en-US"
                        ? "Not Selected"
                        : "暂未选择"}
                </Text>
                <Text
                  class="text-stage-pill-muted text-xs text-center"
                  style={{ numberOfLines: 2 }}
                >
                  {loc() === "en-US"
                    ? "Confirm to end your night turn"
                    : "确认后结束你的夜间行动"}
                </Text>
              </View>
            </View>
          }
        >
          {() => {
            const res = prompt()!.seerResult!;
            return (
              <View
                testID="werewolf-seer-result-card"
                class={
                  res.isWolf
                    ? "flex-1 rounded-2xl border border-stage-rose-border bg-stage-rose-bg px-5 py-4 flex-row items-center justify-between gap-4"
                    : "flex-1 rounded-2xl border border-stage-amber-border bg-stage-amber-bg px-5 py-4 flex-row items-center justify-between gap-4"
                }
              >
                <View class="flex-row items-center gap-3">
                  <WerewolfRoleIcon
                    role={res.isWolf ? "werewolf" : "villager"}
                    tone={res.isWolf ? "rose" : "amber"}
                    size={28}
                  />
                  <View class="gap-0.5">
                    <Text class="text-stage-pill-muted text-xs">
                      {loc() === "en-US"
                        ? `Seat #${res.targetSeat} Alignment`
                        : `${res.targetSeat}号玩家身份查验结果`}
                    </Text>
                    <Text
                      class={
                        res.isWolf
                          ? "text-face-rose-core text-xl font-bold"
                          : "text-face-amber-core text-xl font-bold"
                      }
                    >
                      {res.isWolf
                        ? loc() === "en-US"
                          ? "Werewolf (Wolf Pack)"
                          : "查杀 · 狼人阵营"
                        : loc() === "en-US"
                          ? "Gold Water (Good)"
                          : "金水 · 好人阵营"}
                    </Text>
                  </View>
                </View>

                <Button
                  testID="werewolf-finish-seer-btn"
                  onPress={() => {
                    void props.ctx.sendCommand({ type: "finish_seer_turn" });
                  }}
                  class="min-h-11 px-5 rounded-full bg-eye-core items-center justify-center active:opacity-75"
                >
                  <Text class="text-stage-bg text-xs font-bold">
                    {loc() === "en-US"
                      ? "Got It · Close Eyes"
                      : "记住了，闭眼结束"}
                  </Text>
                </Button>
              </View>
            );
          }}
        </If>

        {/* Role-specific bottom bar: ALWAYS at most one clear primary CTA */}
        <If when={activeRole() === "guard"}>
          <View class="flex-row items-center gap-2.5 shrink-0">
            <Button
              testID="werewolf-guard-empty-btn"
              onPress={() => {
                void props.ctx.sendCommand({
                  type: "submit_guard_action",
                  targetSeat: null,
                });
              }}
              class={
                selectedSeat() === null
                  ? "flex-1 min-h-11 px-4 rounded-full bg-eye-core items-center justify-center active:opacity-75"
                  : "flex-1 min-h-11 px-4 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
              }
            >
              <Text
                class={
                  selectedSeat() === null
                    ? "text-stage-bg text-xs font-bold"
                    : "text-stage-pill-fg text-xs font-semibold"
                }
              >
                {loc() === "en-US" ? "Empty Guard" : "空守本轮"}
              </Text>
            </Button>
            <Button
              testID="werewolf-guard-submit-btn"
              disabled={selectedSeat() === null}
              onPress={() => {
                void props.ctx.sendCommand({
                  type: "submit_guard_action",
                  targetSeat: selectedSeat(),
                });
              }}
              class={
                selectedSeat() !== null
                  ? "flex-1 min-h-11 px-4 rounded-full bg-eye-core items-center justify-center active:opacity-75"
                  : "flex-1 min-h-11 px-4 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center disabled:opacity-40"
              }
            >
              <Text
                class={
                  selectedSeat() !== null
                    ? "text-stage-bg text-xs font-bold"
                    : "text-stage-pill-muted text-xs font-semibold"
                }
              >
                {selectedSeat() !== null
                  ? loc() === "en-US"
                    ? `Protect #${selectedSeat()}`
                    : `确认守护 ${selectedSeat()}号`
                  : loc() === "en-US"
                    ? "Select Seat"
                    : "选座进行守护"}
              </Text>
            </Button>
          </View>
        </If>

        <If when={activeRole() === "werewolf"}>
          <View class="flex-row items-center gap-2.5 shrink-0">
            <Button
              testID="werewolf-wolf-empty-btn"
              onPress={() => {
                void props.ctx.sendCommand({
                  type: "submit_wolf_action",
                  targetSeat: null,
                });
              }}
              class={
                selectedSeat() === null
                  ? "flex-1 min-h-11 px-4 rounded-full bg-eye-core items-center justify-center active:opacity-75"
                  : "flex-1 min-h-11 px-4 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
              }
            >
              <Text
                class={
                  selectedSeat() === null
                    ? "text-stage-bg text-xs font-bold"
                    : "text-stage-pill-fg text-xs font-semibold"
                }
              >
                {loc() === "en-US" ? "Empty Attack" : "放弃袭击（空刀）"}
              </Text>
            </Button>
            <Button
              testID="werewolf-wolf-submit-btn"
              disabled={selectedSeat() === null}
              onPress={() => {
                void props.ctx.sendCommand({
                  type: "submit_wolf_action",
                  targetSeat: selectedSeat(),
                });
              }}
              class={
                selectedSeat() !== null
                  ? "flex-1 min-h-11 px-4 rounded-full bg-eye-core items-center justify-center active:opacity-75"
                  : "flex-1 min-h-11 px-4 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center disabled:opacity-40"
              }
            >
              <Text
                class={
                  selectedSeat() !== null
                    ? "text-stage-rose-ink text-xs font-bold"
                    : "text-stage-pill-muted text-xs font-semibold"
                }
              >
                {selectedSeat() !== null
                  ? loc() === "en-US"
                    ? `Attack #${selectedSeat()}`
                    : `确认袭击 ${selectedSeat()}号`
                  : loc() === "en-US"
                    ? "Select Target"
                    : "选座确认袭击"}
              </Text>
            </Button>
          </View>
        </If>

        <If when={activeRole() === "witch"}>
          {() => {
            const canSaveNow = () =>
              Boolean(prompt()?.witchContext?.canSave) &&
              prompt()?.witchContext?.attackedSeat !== null &&
              prompt()?.witchContext?.attackedSeat !== undefined;
            const canPoisonNow = () =>
              Boolean(prompt()?.witchContext?.canPoison) &&
              selectedSeat() !== null;

            return (
              <View class="flex-row items-center gap-2.5 shrink-0">
                <If
                  when={canPoisonNow()}
                  else={
                    <If
                      when={canSaveNow()}
                      else={
                        /* No save & no poison target selected: disabled poison left + PRIMARY pass right */
                        <>
                          <Button
                            testID="werewolf-witch-poison-btn"
                            disabled={true}
                            class="flex-1 min-h-11 px-4 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center disabled:opacity-45"
                          >
                            <Text class="text-stage-pill-muted text-xs font-semibold">
                              {loc() === "en-US"
                                ? "Pick Seat to Poison"
                                : "选座使用毒药"}
                            </Text>
                          </Button>
                          <Button
                            testID="werewolf-witch-pass-btn"
                            onPress={() => {
                              void props.ctx.sendCommand({
                                type: "submit_witch_action",
                                save: false,
                                poisonTargetSeat: null,
                              });
                            }}
                            class="flex-1 min-h-11 px-4 rounded-full bg-eye-core items-center justify-center active:opacity-75"
                          >
                            <Text class="text-stage-bg text-sm font-bold">
                              {loc() === "en-US" ? "Close Eyes" : "不用药，闭眼"}
                            </Text>
                          </Button>
                        </>
                      }
                    >
                      {/* Save is available & no poison selected */}
                      <Button
                        testID="werewolf-witch-pass-btn"
                        onPress={() => {
                          void props.ctx.sendCommand({
                            type: "submit_witch_action",
                            save: false,
                            poisonTargetSeat: null,
                          });
                        }}
                        class="flex-1 min-h-11 px-3 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
                      >
                        <Text class="text-stage-pill-fg text-xs font-semibold">
                          {loc() === "en-US" ? "Pass" : "不用药，闭眼"}
                        </Text>
                      </Button>
                      <Button
                        testID="werewolf-witch-poison-btn"
                        disabled={true}
                        class="flex-1 min-h-11 px-3 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center disabled:opacity-40"
                      >
                        <Text class="text-stage-pill-muted text-xs font-medium">
                          {loc() === "en-US" ? "Select Poison" : "选座用毒"}
                        </Text>
                      </Button>
                      <Button
                        testID="werewolf-witch-save-btn"
                        onPress={() => {
                          void props.ctx.sendCommand({
                            type: "submit_witch_action",
                            save: true,
                            poisonTargetSeat: null,
                          });
                        }}
                        class="flex-[1.15] min-h-11 px-3.5 rounded-full bg-eye-core items-center justify-center active:opacity-75"
                      >
                        <Text class="text-stage-bg text-xs font-bold">
                          {loc() === "en-US"
                            ? `Save #${prompt()?.witchContext?.attackedSeat}`
                            : `解药救 ${prompt()?.witchContext?.attackedSeat}号`}
                        </Text>
                      </Button>
                    </If>
                  }
                >
                  {/* Poison target selected: pass left + optional save middle + PRIMARY ivory/rose poison button right */}
                  <Button
                    testID="werewolf-witch-pass-btn"
                    onPress={() => {
                      void props.ctx.sendCommand({
                        type: "submit_witch_action",
                        save: false,
                        poisonTargetSeat: null,
                      });
                    }}
                    class="flex-1 min-h-11 px-3 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
                  >
                    <Text class="text-stage-pill-fg text-xs font-semibold">
                      {loc() === "en-US" ? "Close Eyes" : "不用药，闭眼"}
                    </Text>
                  </Button>
                  <If when={canSaveNow()}>
                    <Button
                      testID="werewolf-witch-save-btn"
                      onPress={() => {
                        void props.ctx.sendCommand({
                          type: "submit_witch_action",
                          save: true,
                          poisonTargetSeat: null,
                        });
                      }}
                      class="flex-1 min-h-11 px-3 rounded-full border border-stage-sage-border bg-stage-sage-bg items-center justify-center active:opacity-75"
                    >
                      <Text class="text-face-sage-core text-xs font-semibold">
                        {loc() === "en-US"
                          ? `Save #${prompt()?.witchContext?.attackedSeat}`
                          : `救 ${prompt()?.witchContext?.attackedSeat}号`}
                      </Text>
                    </Button>
                  </If>
                  <Button
                    testID="werewolf-witch-poison-btn"
                    onPress={() => {
                      const target = selectedSeat();
                      if (target === null) return;
                      void props.ctx.sendCommand({
                        type: "submit_witch_action",
                        save: false,
                        poisonTargetSeat: target,
                      });
                    }}
                    class="flex-[1.15] min-h-11 px-3.5 rounded-full bg-eye-core flex-row items-center justify-center gap-1.5 active:opacity-75"
                  >
                    <WerewolfStageIcon
                      name="potion_bottle"
                      tone="roseInk"
                      size={16}
                    />
                    <Text class="text-stage-rose-ink text-sm font-bold">
                      {loc() === "en-US"
                        ? `Poison #${selectedSeat()}`
                        : `对${selectedSeat()}号使用毒药`}
                    </Text>
                  </Button>
                </If>
              </View>
            );
          }}
        </If>

        <If
          when={activeRole() === "seer" && !Boolean(prompt()?.seerResult)}
        >
          <View class="flex-row items-center justify-end shrink-0">
            <Button
              testID="werewolf-seer-check-btn"
              disabled={selectedSeat() === null}
              onPress={() => {
                const target = selectedSeat();
                if (target === null) return;
                void props.ctx.sendCommand({
                  type: "submit_seer_check",
                  targetSeat: target,
                });
              }}
              class={
                selectedSeat() !== null
                  ? "min-h-11 px-6 rounded-full bg-eye-core items-center justify-center active:opacity-75"
                  : "min-h-11 px-6 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center disabled:opacity-40"
              }
            >
              <Text
                class={
                  selectedSeat() !== null
                    ? "text-stage-bg text-xs font-bold"
                    : "text-stage-pill-muted text-xs font-semibold"
                }
              >
                {selectedSeat() !== null
                  ? loc() === "en-US"
                    ? `Inspect #${selectedSeat()}`
                    : `查验 ${selectedSeat()}号身份`
                  : loc() === "en-US"
                    ? "Select Player"
                    : "请选择查验目标"}
              </Text>
            </Button>
          </View>
        </If>
      </View>
    </If>
  );
}

function TabletopRingStage(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
}) {
  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();

  const progressRatio = () => {
    const total = Math.max(1, st().rules.speechSeconds);
    return Math.max(0, Math.min(1, st().speakingRemainingSec / total));
  };

  const canDropOutSheriff = () =>
    st().phase === "sheriff_election" &&
    st().sheriffSubphase === "speech" &&
    st().speakingSeat !== null;

  const headingText = () => {
    const s = st();
    if (s.phase === "dawn_announce") {
      if (s.dawnDeathsToday.length === 0) {
        return loc() === "en-US"
          ? "Peaceful Night — No Casualties"
          : "昨晚是平安夜，无人倒牌";
      }
      return loc() === "en-US"
        ? `Fallen Last Night: ${s.dawnDeathsToday.map((n) => `#${n}`).join(", ")}`
        : `昨晚倒牌：${s.dawnDeathsToday.map((n) => `${n}号`).join("、")}`;
    }
    if (s.speakingSeat !== null) {
      return loc() === "en-US"
        ? `Player #${s.speakingSeat} Speaking`
        : `${s.speakingSeat}号玩家发言中`;
    }
    return WEREWOLF_PHASE_LABELS[s.phase]?.[loc()] ?? s.phase;
  };

  const seatGridClass = () =>
    st().seats.length <= 9 ? "grid grid-cols-3 gap-2" : "grid grid-cols-4 gap-1.5";

  const panelEnter = createMotion(
    reduceMotion() ? {} : { enter: "fadeIn", duration: 180 },
  );

  return (
    <View
      testID="werewolf-tabletop-stage"
      class="flex-1 min-h-0 rounded-3xl border border-stage-pill-border bg-stage-panel p-3 justify-between gap-2"
      style={{ pointerEvents: "auto", opacity: panelEnter.opacity }}
    >
      {/* Top Row: Heading + Countdown ring & MM:SS */}
      <View class="flex-row items-center justify-between gap-2.5 shrink-0">
        <View class="flex-1 min-w-0 flex-row items-center gap-2.5">
          <View class="w-1.5 h-5 rounded-full bg-face-amber-core shrink-0" />
          <Text
            class="text-stage-fg text-base font-bold flex-1"
            style={{ numberOfLines: 1 }}
          >
            {headingText()}
          </Text>
        </View>

        <If when={st().speakingSeat !== null}>
          <View class="flex-row items-center gap-2 shrink-0">
            <Canvas
              testID="werewolf-speaker-arc"
              class="w-7 h-7"
              style={{ pointerEvents: "none" }}
              draw={(cx, size) => {
                cx.clearRect(0, 0, size.width, size.height);
                const r = Math.min(size.width, size.height) / 2 - 2.5;
                const center = size.width / 2;
                cx.lineWidth = 2.5;
                cx.strokeStyle = token("stage-pill-border");
                cx.beginPath();
                cx.arc(center, center, r, 0, Math.PI * 2);
                cx.stroke();

                const ratio = progressRatio();
                if (ratio > 0) {
                  cx.strokeStyle = token(
                    !st().timerPaused && st().speakingRemainingSec <= 10
                      ? "warning"
                      : "face-amber-core",
                  );
                  cx.lineCap = "round";
                  cx.beginPath();
                  cx.arc(
                    center,
                    center,
                    r,
                    -Math.PI / 2,
                    -Math.PI / 2 + Math.PI * 2 * ratio,
                  );
                  cx.stroke();
                }
              }}
            />
            <Text
              class={
                !st().timerPaused && st().speakingRemainingSec <= 10
                  ? "text-warning text-lg font-bold"
                  : "text-stage-fg text-lg font-bold"
              }
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {st().timerPaused
                ? loc() === "en-US"
                  ? "Paused"
                  : "已暂停"
                : formatClockMmSs(st().speakingRemainingSec)}
            </Text>
          </View>
        </If>
      </View>

      <View class="h-px bg-stage-pill-border shrink-0" />

      {/* Tabletop Seat Grid */}
      <Scroll class="flex-1 min-h-0" contentClass="min-h-full justify-center gap-2">
        <View class={seatGridClass()}>
          <Each of={st().seats} key={(item) => item.seat}>
            {(seatAcc) => {
              const s = () => seatAcc();
              const isSpeaking = () => st().speakingSeat === s().seat;
              const isPk = () => st().pkCandidates.includes(s().seat);
              const compact = () => st().seats.length > 9;
              const tileBase = () =>
                compact()
                  ? "min-w-0 h-11 rounded-2xl border px-2 py-1.5 flex-row items-center gap-1.5"
                  : "min-w-0 min-h-11 rounded-2xl border px-2.5 py-2 flex-row items-center gap-2";
              return (
                <View
                  testID={`werewolf-table-seat-${s().seat}`}
                  class={
                    !s().alive
                      ? `${tileBase()} border-stage-pill-border bg-stage-tile`
                      : isSpeaking()
                        ? `${tileBase()} border-stage-amber-border bg-stage-amber-bg`
                        : isPk()
                          ? `${tileBase()} border-face-amber-edge bg-stage-tile`
                          : `${tileBase()} border-stage-pill-border bg-stage-tile`
                  }
                  style={{ opacity: s().alive ? 1 : 0.45 }}
                >
                  <View class="relative w-7 h-7 shrink-0 items-center justify-center">
                    <View class="w-7 h-7 rounded-full border border-stage-pill-border bg-stage-bg overflow-hidden items-center justify-center">
                      <If
                        when={Boolean(s().portraitDataUri)}
                        else={
                          <Text
                            class={
                              isSpeaking()
                                ? "text-face-amber-core text-xs font-bold"
                                : "text-stage-fg text-xs font-bold"
                            }
                            style={{ fontVariant: ["tabular-nums"] }}
                          >
                            {String(s().seat)}
                          </Text>
                        }
                      >
                        <Image
                          src={s().portraitDataUri ?? ""}
                          class="w-full h-full rounded-full"
                        />
                      </If>
                    </View>
                    <If when={Boolean(s().portraitDataUri)}>
                      <View class="absolute -bottom-0.5 -right-1 px-1 rounded-full bg-stage-bg border border-stage-pill-border items-center justify-center">
                        <Text
                          class="text-stage-fg text-[10px] font-bold"
                          style={{ fontVariant: ["tabular-nums"] }}
                        >
                          {String(s().seat)}
                        </Text>
                      </View>
                    </If>
                  </View>

                  <View class="flex-1 min-w-0 flex-row items-center gap-1">
                    <If when={isSpeaking()}>
                      <WerewolfStageIcon name="waveform" tone="amber" size={13} />
                    </If>
                    <Text
                      class={
                        !s().alive
                          ? "text-stage-pill-muted text-xs flex-1 min-w-0"
                          : isSpeaking()
                            ? "text-face-amber-core text-xs font-semibold flex-1 min-w-0"
                            : s().idiotRevealed || isPk()
                              ? "text-face-amber-core text-xs font-medium flex-1 min-w-0"
                              : s().isCandidate
                                ? "text-face-mist-core text-xs font-medium flex-1 min-w-0"
                                : "text-stage-pill-muted text-xs flex-1 min-w-0"
                      }
                      style={{ numberOfLines: 1 }}
                    >
                      {!s().alive
                        ? loc() === "en-US"
                          ? "Out"
                          : compact()
                            ? "出局"
                            : "已出局"
                        : isSpeaking()
                          ? loc() === "en-US"
                            ? compact()
                              ? "Talk"
                              : "Speaking"
                            : compact()
                              ? "发言"
                              : "发言中"
                          : s().idiotRevealed
                            ? loc() === "en-US"
                              ? "Idiot"
                              : compact()
                                ? "白痴"
                                : "白痴翻牌"
                            : isPk()
                              ? "PK"
                              : s().isCandidate
                                ? loc() === "en-US"
                                  ? compact()
                                    ? "Cand."
                                    : "Candidate"
                                  : compact()
                                    ? "候选"
                                    : "警上候选"
                                : loc() === "en-US"
                                  ? "Wait"
                                  : compact()
                                    ? "待发"
                                    : "等待发言"}
                    </Text>
                    <If when={s().isSheriff}>
                      <Text class="text-face-amber-core text-xs font-bold shrink-0">
                        ★
                      </Text>
                    </If>
                  </View>
                </View>
              );
            }}
          </Each>
        </View>
      </Scroll>

      <View class="h-px bg-stage-pill-border shrink-0" />

      {/* Bottom integrated action bar (single primary CTA on right) */}
      <View class="flex-row items-center justify-between gap-2 shrink-0">
        <View class="flex-row items-center gap-2 flex-wrap">
          <If when={st().speakingSeat !== null}>
            <Button
              testID="werewolf-pause-timer-btn"
              onPress={() => {
                void props.ctx.sendCommand({ type: "toggle_timer_pause" });
              }}
              class="min-h-11 px-3.5 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
            >
              <Text class="text-stage-pill-fg text-xs font-medium">
                {st().timerPaused
                  ? loc() === "en-US"
                    ? "Resume"
                    : "继续计时"
                  : loc() === "en-US"
                    ? "Pause Timer"
                    : "暂停计时"}
              </Text>
            </Button>
          </If>

          <If when={st().phase !== "dawn_announce"}>
            <Button
              testID="werewolf-next-speaker-btn"
              onPress={() => {
                void props.ctx.sendCommand({ type: "advance_speaker" });
              }}
              class="min-h-11 px-4 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
            >
              <Text class="text-stage-fg text-xs font-semibold">
                {loc() === "en-US" ? "Next" : "下一位"}
              </Text>
            </Button>
          </If>

          <If when={canDropOutSheriff()}>
            <Button
              testID="werewolf-sheriff-dropout-btn"
              onPress={() => {
                const spk = st().speakingSeat;
                if (spk === null) return;
                void props.ctx.sendCommand({
                  type: "sheriff_drop_out",
                  seat: spk,
                });
              }}
              class="min-h-11 px-3.5 rounded-full border border-stage-amber-border bg-stage-amber-bg items-center justify-center active:opacity-75"
            >
              <Text class="text-face-amber-core text-xs font-semibold">
                {loc() === "en-US"
                  ? `#${st().speakingSeat} Drop`
                  : `${st().speakingSeat}号退水`}
              </Text>
            </Button>
          </If>
        </View>

        <View class="flex-row items-center gap-2 shrink-0">
          <If when={st().phase === "dawn_announce"}>
            <Button
              testID="werewolf-ack-dawn-btn"
              onPress={() => {
                void props.ctx.sendCommand({ type: "acknowledge_dawn" });
              }}
              class="min-h-11 px-5 rounded-full bg-eye-core flex-row items-center gap-1.5 active:opacity-75"
            >
              <Text class="text-stage-bg text-xs font-bold">
                {loc() === "en-US" ? "Begin Speech" : "开始发言"}
              </Text>
              <WerewolfStageIcon name="arrow_right" tone="stageBg" size={15} />
            </Button>
          </If>

          <If when={st().phase === "day_discussion"}>
            <Button
              testID="werewolf-start-voting-btn"
              onPress={() => {
                void props.ctx.sendCommand({ type: "start_voting" });
              }}
              class="min-h-11 px-5 rounded-full bg-eye-core flex-row items-center gap-1.5 active:opacity-75"
            >
              <Text class="text-stage-bg text-xs font-bold">
                {loc() === "en-US" ? "Start Vote" : "进入放逐公投"}
              </Text>
              <WerewolfStageIcon name="arrow_right" tone="stageBg" size={15} />
            </Button>
          </If>
        </View>
      </View>
    </View>
  );
}

function VotingStagePanel(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
}) {
  const hostOverrideMode = signal(false);
  const activeVoter = signal<number | null>(null);
  const progressBarWidth = signal(0);
  let lastVoteKey = "";

  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();

  effect(() => {
    const key = `${st().day}:${st().phase}:${st().sheriffSubphase ?? ""}`;
    if (key !== lastVoteKey) {
      lastVoteKey = key;
      hostOverrideMode.set(false);
    }
  });

  effect(() => {
    const voters = st().eligibleVoterSeats;
    const cur = activeVoter();
    if (voters.length === 0) {
      activeVoter.set(null);
      return;
    }
    if (cur === null || !voters.includes(cur)) {
      const firstUnvoted =
        voters.find((v) => !st().votedSeats.includes(v)) ?? voters[0]!;
      activeVoter.set(firstUnvoted);
    }
  });

  const validTargets = (): number[] => {
    const s = st();
    if (
      s.phase === "day_pk_voting" ||
      (s.phase === "sheriff_election" &&
        (s.sheriffSubphase === "voting" || s.sheriffSubphase === "pk_voting"))
    ) {
      if (s.pkCandidates.length > 0) {
        return [...s.pkCandidates];
      }
      return s.seats
        .filter((seat) => seat.alive && seat.isCandidate)
        .map((seat) => seat.seat);
    }
    return s.seats.filter((seat) => seat.alive).map((seat) => seat.seat);
  };

  const castForActiveVoter = (targetSeat: number | null) => {
    const voter = activeVoter();
    if (voter === null) return;
    const voters = st().eligibleVoterSeats;
    const alreadyVoted = new Set([...st().votedSeats, voter]);
    const nextUnvoted = voters.find((v) => !alreadyVoted.has(v)) ?? voter;
    void props.ctx
      .sendCommand({
        type: "cast_on_device_vote",
        voterSeat: voter,
        targetSeat,
      })
      .then(() => {
        activeVoter.set(nextUnvoted);
      });
  };

  const showLanSecretCollection = () =>
    st().rules.surfaceMode === "lan_companion" && !hostOverrideMode();

  const totalVoters = () => Math.max(0, st().eligibleVoterSeats.length);
  const votedCount = () => st().votedSeats.length;
  const remainingVoters = () => Math.max(0, totalVoters() - votedCount());
  const allVoted = () => totalVoters() > 0 && remainingVoters() === 0;
  const voteRatio = () =>
    totalVoters() > 0 ? Math.min(1, votedCount() / totalVoters()) : 0;

  const voterGridClass = () =>
    totalVoters() <= 6
      ? "grid grid-cols-3 gap-2"
      : totalVoters() <= 9
        ? "grid grid-cols-3 gap-1.5"
        : "grid grid-cols-4 gap-1.5";
  const isDenseOnDevice = () =>
    totalVoters() > 9 || validTargets().length + 1 > 9;
  const onDeviceVoterGridClass = () =>
    totalVoters() <= 6
      ? "grid grid-cols-3 gap-2"
      : totalVoters() <= 9
        ? "grid grid-cols-3 gap-1.5"
        : "grid grid-cols-5 gap-1";
  const onDeviceTargetGridClass = () => {
    const count = validTargets().length + 1;
    if (count <= 6) return "grid grid-cols-3 gap-1.5";
    if (count <= 9) return "grid grid-cols-4 gap-1.5";
    return "grid grid-cols-5 gap-1";
  };

  const panelEnter = createMotion(
    reduceMotion() ? {} : { enter: "fadeIn", duration: 180 },
  );

  return (
    <View
      testID="werewolf-voting-panel"
      class="flex-1 min-h-0 rounded-3xl border border-stage-pill-border bg-stage-panel p-3.5 flex-row items-stretch gap-3.5"
      style={{ pointerEvents: "auto", opacity: panelEnter.opacity }}
    >
      <If
        when={showLanSecretCollection()}
        else={
          /* On-Device / Host Override Two-Step Ballot Collection */
          <>
            <Scroll
              class="flex-[1.38] min-w-0 min-h-0"
              contentClass={
                isDenseOnDevice()
                  ? "min-h-full justify-center gap-1.5 pr-1"
                  : "min-h-full justify-center gap-2 pr-1"
              }
            >
              <View class={isDenseOnDevice() ? "gap-1" : "gap-1.5"}>
                <Text
                  class={
                    isDenseOnDevice()
                      ? "text-stage-fg text-sm font-bold"
                      : "text-stage-fg text-base font-bold"
                  }
                >
                  {loc() === "en-US"
                    ? `1. Select Voter (${votedCount()}/${totalVoters()})`
                    : `1. 选择投票座位（已投 ${votedCount()}/${totalVoters()}）`}
                </Text>
                <View class={onDeviceVoterGridClass()}>
                  <Each of={st().eligibleVoterSeats} key={(v) => v}>
                    {(voterAcc) => {
                      const v = () => voterAcc();
                      const isSelected = () => activeVoter() === v();
                      const hasVoted = () => st().votedSeats.includes(v());
                      const recordedTarget = () => st().votesByVoter[v()];
                      const isSheriffWeight = () =>
                        st().phase !== "sheriff_election" &&
                        st().sheriffSeat === v();

                      const pillLabel = () => {
                        const prefix = `${v()}${isSheriffWeight() ? "★" : "#"}`;
                        const compactPrefix = `#${v()}${isSheriffWeight() ? "★" : ""}`;
                        if (!hasVoted()) {
                          return totalVoters() > 6
                            ? compactPrefix
                            : `#${v()}${isSheriffWeight() ? "(1.5)" : ""}`;
                        }
                        const tgt = recordedTarget();
                        if (tgt === undefined) return `${prefix} ✓`;
                        return tgt === null
                          ? `${compactPrefix}→${loc() === "en-US" ? "P" : "弃"}`
                          : `${compactPrefix}→${tgt}`;
                      };

                      return (
                        <Button
                          testID={`werewolf-voter-${v()}`}
                          selected={isSelected()}
                          hitSlop={
                            isDenseOnDevice()
                              ? { top: 6, bottom: 6 }
                              : { top: 2, bottom: 2 }
                          }
                          onPress={() => activeVoter.set(v())}
                          class={
                            isDenseOnDevice()
                              ? isSelected()
                                ? "min-w-0 h-8 px-1 rounded-xl border-2 border-stage-amber-border bg-stage-amber-bg items-center justify-center active:opacity-80"
                                : hasVoted()
                                  ? "min-w-0 h-8 px-1 rounded-xl border border-stage-sage-border bg-stage-sage-bg items-center justify-center active:opacity-80"
                                  : "min-w-0 h-8 px-1 rounded-xl border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-80"
                              : isSelected()
                                ? "min-w-0 h-10 px-1.5 rounded-xl border-2 border-stage-amber-border bg-stage-amber-bg items-center justify-center active:opacity-80"
                                : hasVoted()
                                  ? "min-w-0 h-10 px-1.5 rounded-xl border border-stage-sage-border bg-stage-sage-bg items-center justify-center active:opacity-80"
                                  : "min-w-0 h-10 px-1.5 rounded-xl border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-80"
                          }
                        >
                          <Text
                            class={
                              isSelected()
                                ? "text-face-amber-core text-xs font-bold text-center"
                                : hasVoted()
                                  ? "text-face-sage-core text-xs font-semibold text-center"
                                  : "text-stage-fg text-xs font-medium text-center"
                            }
                            style={{ numberOfLines: 1, fontVariant: ["tabular-nums"] }}
                          >
                            {pillLabel()}
                          </Text>
                        </Button>
                      );
                    }}
                  </Each>
                </View>
              </View>

              <View class={isDenseOnDevice() ? "gap-1" : "gap-1.5"}>
                <Text class="text-stage-pill-muted text-xs font-semibold">
                  {activeVoter() !== null
                    ? loc() === "en-US"
                      ? `2. Cast Ballot for #${activeVoter()}`
                      : `2. 为 ${activeVoter()}号选择投票目标`
                    : loc() === "en-US"
                      ? "2. Cast Ballot"
                      : "2. 选择投票目标"}
                </Text>
                <View class={onDeviceTargetGridClass()}>
                  <Each of={validTargets()} key={(t) => t}>
                    {(targetAcc) => {
                      const target = () => targetAcc();
                      return (
                        <Button
                          testID={`werewolf-vote-target-${target()}`}
                          disabled={activeVoter() === null}
                          hitSlop={
                            isDenseOnDevice()
                              ? { top: 6, bottom: 6 }
                              : { top: 2, bottom: 2 }
                          }
                          onPress={() => castForActiveVoter(target())}
                          class={
                            isDenseOnDevice()
                              ? "min-w-0 h-8 px-1 rounded-xl border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75 disabled:opacity-35"
                              : "min-w-0 h-10 px-1.5 rounded-xl border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75 disabled:opacity-35"
                          }
                        >
                          <Text
                            class="text-stage-fg text-xs font-bold text-center"
                            style={{ numberOfLines: 1, fontVariant: ["tabular-nums"] }}
                          >
                            {`→ #${target()}`}
                          </Text>
                        </Button>
                      );
                    }}
                  </Each>

                  <Button
                    testID="werewolf-vote-abstain"
                    disabled={activeVoter() === null}
                    hitSlop={
                      isDenseOnDevice()
                        ? { top: 6, bottom: 6 }
                        : { top: 2, bottom: 2 }
                    }
                    onPress={() => castForActiveVoter(null)}
                    class={
                      isDenseOnDevice()
                        ? "min-w-0 h-8 px-1 rounded-xl border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75 disabled:opacity-35"
                        : "min-w-0 h-10 px-1.5 rounded-xl border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75 disabled:opacity-35"
                    }
                  >
                    <Text
                      class="text-stage-pill-muted text-xs font-semibold text-center"
                      style={{ numberOfLines: 1 }}
                    >
                      {loc() === "en-US" ? "Abstain" : "弃票"}
                    </Text>
                  </Button>
                </View>
              </View>

              <If when={st().rules.surfaceMode === "lan_companion"}>
                <Button
                  testID="werewolf-lan-vote-back-btn"
                  onPress={() => hostOverrideMode.set(false)}
                  class="min-h-11 self-start px-1 flex-row items-center gap-1 active:opacity-75"
                >
                  <WerewolfStageIcon name="arrow_left" tone="stageMuted" size={14} />
                  <Text class="text-stage-pill-muted text-xs font-medium">
                    {loc() === "en-US" ? "Back to LAN Progress" : "返回暗票收集"}
                  </Text>
                </Button>
              </If>
            </Scroll>

            <View class="w-px bg-stage-pill-border my-1 shrink-0" />

            <View class="flex-1 min-w-0 justify-between gap-2.5">
              <Scroll
                class="flex-1 min-h-0"
                contentClass="gap-1.5"
              >
                <Text class="text-stage-fg text-base font-bold">
                  {st().rules.surfaceMode === "lan_companion" &&
                  st().voteTallies.length === 0
                    ? loc() === "en-US"
                      ? "Secret Ballots"
                      : "暗票统计中"
                    : loc() === "en-US"
                      ? "Live Tally"
                      : "实时得票"}
                </Text>

                <If
                  when={st().voteTallies.length > 0}
                  else={
                    <Text class="text-stage-pill-muted text-xs">
                      {loc() === "en-US"
                        ? `${votedCount()}/${totalVoters()} ballots received`
                        : `已收到 ${votedCount()}/${totalVoters()} 张选票`}
                    </Text>
                  }
                >
                  <Each of={st().voteTallies} key={(item) => item.targetSeat}>
                    {(tallyAcc) => {
                      const item = () => tallyAcc();
                      return (
                        <View class="flex-row items-center justify-between gap-2 rounded-xl bg-stage-tile px-3 py-1.5">
                          <Text
                            class="text-stage-fg text-xs font-bold"
                            style={{ fontVariant: ["tabular-nums"] }}
                          >
                            {`#${item().targetSeat}`}
                          </Text>
                          <Text
                            class="text-face-amber-core text-xs font-bold"
                            style={{ fontVariant: ["tabular-nums"] }}
                          >
                            {loc() === "en-US"
                              ? `${item().weightedVotes} votes`
                              : `${item().weightedVotes} 票`}
                          </Text>
                        </View>
                      );
                    }}
                  </Each>
                </If>
              </Scroll>

              <Button
                testID="werewolf-finalize-votes-btn"
                disabled={!allVoted()}
                onPress={() => {
                  void props.ctx.sendCommand({ type: "finalize_votes" });
                }}
                class="min-h-11 rounded-full bg-eye-core items-center justify-center active:opacity-75 disabled:opacity-45"
              >
                <Text class="text-stage-bg text-xs font-bold">
                  {allVoted()
                    ? loc() === "en-US" ? "Finalize Votes" : "结算公布票型"
                    : loc() === "en-US" ? "Waiting for All Votes" : "等待全员投票"}
                </Text>
              </Button>
            </View>
          </>
        }
      >
        {/* LAN Secret Ballots Collection (06-voting.png) */}
        <>
          <View class="flex-[1.35] min-w-0 justify-between gap-2.5">
            <View class="gap-0.5">
              <Text class="text-stage-fg text-lg font-bold">
                {loc() === "en-US"
                  ? "Vote on Your Phones"
                  : "请在各自手机上投票"}
              </Text>
              <Text class="text-stage-pill-muted text-xs">
                {loc() === "en-US"
                  ? "Ballots will be revealed once everyone votes"
                  : "选票提交后统一公布"}
              </Text>
            </View>

            <Scroll class="flex-1 min-h-0" contentClass="min-h-full justify-center">
              <View class={voterGridClass()}>
                <Each of={st().eligibleVoterSeats} key={(v) => v}>
                  {(voterAcc) => {
                    const v = () => voterAcc();
                    const hasVoted = () => st().votedSeats.includes(v());
                    const compact = () => totalVoters() > 9;
                    return (
                      <View
                        testID={`werewolf-voter-status-${v()}`}
                        class={
                          compact()
                            ? "min-w-0 h-10 rounded-xl border border-stage-pill-border bg-stage-tile px-1.5 flex-row items-center gap-1"
                            : "min-w-0 min-h-11 rounded-2xl border border-stage-pill-border bg-stage-tile px-2.5 py-2 flex-row items-center gap-1.5"
                        }
                      >
                        <Text
                          class="text-stage-fg text-xs font-bold shrink-0"
                          style={{ fontVariant: ["tabular-nums"] }}
                        >
                          {`#${v()}`}
                        </Text>
                        <If when={!compact()}>
                          <View class="w-px h-3.5 bg-stage-pill-border shrink-0" />
                        </If>
                        <If
                          when={hasVoted()}
                          else={
                            <View class="flex-row items-center gap-1 flex-1 min-w-0">
                              <WerewolfStageIcon
                                name="clock"
                                tone="stageMuted"
                                size={compact() ? 12 : 14}
                              />
                              <Text
                                class="text-stage-pill-muted text-xs font-medium flex-1 min-w-0"
                                style={{ numberOfLines: 1 }}
                              >
                                {loc() === "en-US"
                                  ? compact()
                                    ? "Wait"
                                    : "Waiting"
                                  : compact()
                                    ? "待投"
                                    : "等待投票"}
                              </Text>
                            </View>
                          }
                        >
                          <View class="flex-row items-center gap-1 flex-1 min-w-0">
                            <WerewolfStageIcon
                              name="check_circle"
                              tone="sage"
                              size={compact() ? 12 : 14}
                            />
                            <Text
                              class="text-face-sage-core text-xs font-semibold flex-1 min-w-0"
                              style={{ numberOfLines: 1 }}
                            >
                              {loc() === "en-US"
                                ? "Voted"
                                : compact()
                                  ? "已投"
                                  : "已投票"}
                            </Text>
                          </View>
                        </If>
                      </View>
                    );
                  }}
                </Each>
              </View>
            </Scroll>

            <Button
              testID="werewolf-lan-vote-override-btn"
              onPress={() => hostOverrideMode.set(true)}
              class="min-h-11 self-start px-1 flex-row items-center gap-1 active:opacity-75"
            >
              <Text class="text-stage-fg text-xs font-medium">
                {loc() === "en-US" ? "Vote on Host" : "本机代投"}
              </Text>
              <WerewolfStageIcon name="chevron_right" tone="stageFg" size={14} />
            </Button>
          </View>

          <View class="w-px bg-stage-pill-border my-1 shrink-0" />

          <View class="flex-1 min-w-0 justify-between items-center py-0.5">
            <Text class="text-stage-fg text-lg font-bold self-start">
              {loc() === "en-US" ? "Collecting Ballots" : "选票收集中"}
            </Text>

            <View class="flex-1 w-full items-center justify-center gap-2">
              <Text
                testID="werewolf-vote-progress-count"
                class="text-stage-fg text-3xl font-bold text-center"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {`${votedCount()} / ${totalVoters()}`}
              </Text>
              <Text class="text-stage-pill-muted text-xs text-center">
                {loc() === "en-US" ? "Ballots Received" : "已收到选票"}
              </Text>

              <View
                onLayout={(ev) => progressBarWidth.set(ev.bounds.size.width)}
                class="w-full h-2.5 rounded-full bg-stage-tile overflow-hidden"
              >
                <View
                  class="h-full rounded-full bg-face-sage-core"
                  style={{
                    width: Math.round(progressBarWidth() * voteRatio()),
                  }}
                />
              </View>

              <Text class="text-stage-pill-muted text-xs text-center">
                {remainingVoters() > 0
                  ? loc() === "en-US"
                    ? `${remainingVoters()} player(s) left to vote`
                    : `还有${remainingVoters()}位玩家未投票`
                  : loc() === "en-US"
                    ? "All ballots received"
                    : "全员选票已到齐"}
              </Text>
            </View>

            <Button
              testID="werewolf-finalize-votes-btn"
              disabled={!allVoted()}
              onPress={() => {
                void props.ctx.sendCommand({ type: "finalize_votes" });
              }}
              class={
                allVoted()
                  ? "w-full min-h-11 rounded-full bg-eye-core flex-row items-center justify-center gap-1.5 active:opacity-75"
                  : "w-full min-h-11 rounded-full bg-stage-tile border border-stage-pill-border items-center justify-center disabled:opacity-60"
              }
            >
              <Text
                class={
                  allVoted()
                    ? "text-stage-bg text-sm font-bold"
                    : "text-stage-pill-muted text-sm font-semibold"
                }
              >
                {allVoted()
                  ? loc() === "en-US"
                    ? "Reveal Results"
                    : "公布票型结果"
                  : loc() === "en-US"
                    ? "Waiting for All Votes"
                    : "等待全员投票"}
              </Text>
              <If when={allVoted()}>
                <WerewolfStageIcon name="arrow_right" tone="stageBg" size={15} />
              </If>
            </Button>
          </View>
        </>
      </If>
    </View>
  );
}

function SheriffSignupStagePanel(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
}) {
  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();

  const candidateCount = () =>
    st().seats.filter((s) => s.alive && s.isCandidate).length;

  const seatGridClass = () =>
    st().seats.length <= 9 ? "grid grid-cols-3 gap-2" : "grid grid-cols-4 gap-1.5";

  const panelEnter = createMotion(
    reduceMotion() ? {} : { enter: "fadeIn", duration: 180 },
  );

  return (
    <View
      testID="werewolf-sheriff-signup-panel"
      class="flex-1 min-h-0 rounded-3xl border border-stage-pill-border bg-stage-panel p-3 justify-between gap-2"
      style={{ pointerEvents: "auto", opacity: panelEnter.opacity }}
    >
      <View class="flex-row items-center justify-between gap-2 shrink-0">
        <View class="gap-0.5">
          <Text class="text-stage-fg text-base font-bold">
            {loc() === "en-US"
              ? "Sheriff Election Sign-Up"
              : "警长竞选上警报名"}
          </Text>
          <Text class="text-stage-pill-muted text-xs">
            {loc() === "en-US"
              ? "Tap seat numbers of candidates running for sheriff."
              : "点击想要竞选警长的玩家号码"}
          </Text>
        </View>
        <Text
          class="text-face-amber-core text-xs font-semibold shrink-0"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {loc() === "en-US"
            ? `${candidateCount()} Candidates`
            : `已上警 ${candidateCount()} 人`}
        </Text>
      </View>

      <View class="h-px bg-stage-pill-border shrink-0" />

      <Scroll class="flex-1 min-h-0" contentClass="min-h-full justify-center">
        <View class={seatGridClass()}>
          <Each of={st().seats} key={(item) => item.seat}>
            {(seatAcc) => {
              const s = () => seatAcc();
              const compact = () => st().seats.length > 9;
              return (
                <Button
                  testID={`werewolf-sheriff-cand-${s().seat}`}
                  disabled={!s().alive}
                  selected={s().isCandidate}
                  onPress={() => {
                    void props.ctx.sendCommand({
                      type: "toggle_sheriff_candidate",
                      seat: s().seat,
                    });
                  }}
                  class={
                    s().isCandidate
                      ? compact()
                        ? "min-w-0 h-11 px-2.5 rounded-xl border border-stage-amber-border bg-stage-amber-bg flex-row items-center justify-between gap-1.5 active:opacity-80 disabled:opacity-30"
                        : "min-w-0 min-h-11 px-3 rounded-xl border border-stage-amber-border bg-stage-amber-bg flex-row items-center justify-between gap-1.5 active:opacity-80 disabled:opacity-30"
                      : compact()
                        ? "min-w-0 h-11 px-2.5 rounded-xl border border-stage-pill-border bg-stage-tile flex-row items-center justify-between gap-1.5 active:opacity-80 disabled:opacity-30"
                        : "min-w-0 min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-tile flex-row items-center justify-between gap-1.5 active:opacity-80 disabled:opacity-30"
                  }
                >
                  <Text
                    class={
                      s().isCandidate
                        ? "text-face-amber-core text-xs font-bold"
                        : "text-stage-fg text-xs font-semibold"
                    }
                    style={{ fontVariant: ["tabular-nums"] }}
                  >
                    {loc() === "en-US"
                      ? s().isCandidate
                        ? `#${s().seat} Up`
                        : `#${s().seat}`
                      : s().isCandidate
                        ? `${s().seat}号 上警`
                        : `${s().seat}号`}
                  </Text>
                  <If when={s().isCandidate}>
                    <WerewolfStageIcon name="check" tone="amber" size={13} />
                  </If>
                </Button>
              );
            }}
          </Each>
        </View>
      </Scroll>

      <View class="flex-row items-center justify-end shrink-0">
        <Button
          testID="werewolf-lock-sheriff-btn"
          onPress={() => {
            void props.ctx.sendCommand({ type: "lock_sheriff_candidates" });
          }}
          class="min-h-11 px-6 rounded-full bg-eye-core flex-row items-center gap-1.5 active:opacity-75"
        >
          <Text class="text-stage-bg text-xs font-bold">
            {candidateCount() === 0
              ? loc() === "en-US"
                ? "No Candidates · Skip Badge"
                : "无人上警 · 直接公布死讯"
              : loc() === "en-US"
                ? "Lock Candidates & Start Speech"
                : "锁定上警名单 · 开始发言"}
          </Text>
          <WerewolfStageIcon name="arrow_right" tone="stageBg" size={15} />
        </Button>
      </View>
    </View>
  );
}

function LeaveResolutionStagePanel(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
}) {
  const targetSeat = signal<number | null>(null);
  let lastLeaveKey = "";

  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();

  effect(() => {
    const key = `${st().pendingLeaveSeat ?? "none"}:${st().pendingLeaveReason ?? "none"}`;
    if (key !== lastLeaveKey) {
      lastLeaveKey = key;
      targetSeat.set(null);
    }
  });

  const actor = () => st().pendingLeaveSeat;
  const reason = () => st().pendingLeaveReason;

  const selectableSeats = (): number[] => {
    const r = reason();
    const act = actor();
    return st()
      .seats.filter((s) => {
        if (!s.alive) return false;
        if (act !== null && s.seat === act) return false;
        if (r === "sheriff_badge" && s.idiotRevealed) return false;
        return true;
      })
      .map((s) => s.seat);
  };

  const headerText = () => {
    const act = actor();
    const r = reason();
    if (loc() === "en-US") {
      if (r === "hunter_shoot") return `Hunter #${act} — Choose Shot Target or Hold Fire`;
      if (r === "sheriff_badge") return `Sheriff #${act} — Pass or Tear Badge`;
      if (r === "white_wolf_explode") return `White Wolf King #${act} — Drag One Player`;
      return `Player #${act} — Last Words`;
    }
    if (r === "hunter_shoot") return `猎人 ${act}号离场技能：选择开枪带走目标或压枪`;
    if (r === "sheriff_badge") return `警长 ${act}号警徽流转：选择移交警徽或撕毁警徽`;
    if (r === "white_wolf_explode") return `白狼王 ${act}号自爆：指定带走一名存活玩家`;
    return `请 ${act}号玩家发表遗言`;
  };

  const panelEnter = createMotion(
    reduceMotion() ? {} : { enter: "fadeIn", duration: 180 },
  );

  return (
    <View
      testID="werewolf-leave-panel"
      class="flex-1 min-h-0 rounded-3xl border border-stage-pill-border bg-stage-panel p-4 justify-between gap-2.5"
      style={{ pointerEvents: "auto", opacity: panelEnter.opacity }}
    >
      <Text class="text-stage-fg text-base font-bold shrink-0">{headerText()}</Text>

      <View class="h-px bg-stage-pill-border shrink-0" />

      <If
        when={reason() !== "last_words"}
        else={
          <View class="flex-1 items-center justify-center gap-2 px-4">
            <WerewolfStageIcon name="waveform" tone="amber" size={28} />
            <Text class="text-stage-pill-muted text-sm text-center">
              {st().lastJudgeSpeech ||
                (loc() === "en-US"
                  ? "Tap Finish Last Words once the player concludes."
                  : "玩家发表遗言完毕后，点击下方按钮继续游戏流程。")}
            </Text>
          </View>
        }
      >
        <Scroll class="flex-1 min-h-0" contentClass="min-h-full justify-center">
          <View class="grid grid-cols-4 gap-2">
            <Each of={selectableSeats()} key={(n) => n}>
              {(seatNumAcc) => {
                const num = () => seatNumAcc();
                const picked = () => targetSeat() === num();
                return (
                  <Button
                    testID={`werewolf-leave-target-${num()}`}
                    selected={picked()}
                    onPress={() => targetSeat.set(picked() ? null : num())}
                    class={
                      picked()
                        ? "min-w-0 min-h-11 px-3 rounded-xl border border-stage-amber-border bg-stage-amber-bg items-center justify-center active:opacity-80"
                        : "min-w-0 min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-80"
                    }
                  >
                    <Text
                      class={
                        picked()
                          ? "text-face-amber-core text-xs font-bold"
                          : "text-stage-fg text-xs font-semibold"
                      }
                      style={{ fontVariant: ["tabular-nums"] }}
                    >
                      {loc() === "en-US" ? `#${num()}` : `${num()}号`}
                    </Text>
                  </Button>
                );
              }}
            </Each>
          </View>
        </Scroll>
      </If>

      <If when={reason() === "hunter_shoot"}>
        <View class="flex-row items-center justify-end gap-2 shrink-0">
          <Button
            testID="werewolf-hunter-skip-btn"
            onPress={() => {
              void props.ctx.sendCommand({
                type: "resolve_hunter_shot",
                targetSeat: null,
              });
            }}
            class="min-h-11 px-4 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
          >
            <Text class="text-stage-pill-fg text-xs font-semibold">
              {loc() === "en-US" ? "Hold Fire" : "压枪不开枪"}
            </Text>
          </Button>
          <Button
            testID="werewolf-hunter-shoot-btn"
            disabled={targetSeat() === null}
            onPress={() => {
              void props.ctx.sendCommand({
                type: "resolve_hunter_shot",
                targetSeat: targetSeat(),
              });
            }}
            class="min-h-11 px-5 rounded-full bg-eye-core items-center justify-center active:opacity-75 disabled:opacity-35"
          >
            <Text class="text-stage-bg text-xs font-bold">
              {targetSeat() !== null
                ? loc() === "en-US"
                  ? `Shoot #${targetSeat()}`
                  : `开枪带走 ${targetSeat()}号`
                : loc() === "en-US"
                  ? "Select Target"
                  : "请选择开枪目标"}
            </Text>
          </Button>
        </View>
      </If>

      <If when={reason() === "sheriff_badge"}>
        <View class="flex-row items-center justify-end gap-2 shrink-0">
          <Button
            testID="werewolf-sheriff-tear-btn"
            onPress={() => {
              void props.ctx.sendCommand({
                type: "resolve_sheriff_transfer",
                targetSeat: null,
              });
            }}
            class="min-h-11 px-4 rounded-full border border-stage-rose-border bg-stage-rose-bg items-center justify-center active:opacity-75"
          >
            <Text class="text-face-rose-core text-xs font-semibold">
              {loc() === "en-US" ? "Tear Badge" : "撕毁警徽"}
            </Text>
          </Button>
          <Button
            testID="werewolf-sheriff-pass-btn"
            disabled={targetSeat() === null}
            onPress={() => {
              void props.ctx.sendCommand({
                type: "resolve_sheriff_transfer",
                targetSeat: targetSeat(),
              });
            }}
            class="min-h-11 px-5 rounded-full bg-eye-core items-center justify-center active:opacity-75 disabled:opacity-35"
          >
            <Text class="text-stage-bg text-xs font-bold">
              {targetSeat() !== null
                ? loc() === "en-US"
                  ? `Pass Badge to #${targetSeat()}`
                  : `移交警徽给 ${targetSeat()}号`
                : loc() === "en-US"
                  ? "Select Heir"
                  : "请选择接任玩家"}
            </Text>
          </Button>
        </View>
      </If>

      <If when={reason() === "white_wolf_explode"}>
        <View class="flex-row items-center justify-end gap-2 shrink-0">
          <Button
            testID="werewolf-whitewolf-skip-btn"
            onPress={() => {
              const wolf = actor();
              if (wolf === null) return;
              void props.ctx.sendCommand({
                type: "trigger_wolf_explode",
                wolfSeat: wolf,
                whiteWolfTargetSeat: null,
              });
            }}
            class="min-h-11 px-4 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75"
          >
            <Text class="text-stage-pill-fg text-xs font-semibold">
              {loc() === "en-US" ? "Skip Drag" : "放弃带人"}
            </Text>
          </Button>
          <Button
            testID="werewolf-whitewolf-drag-btn"
            disabled={targetSeat() === null}
            onPress={() => {
              const wolf = actor();
              if (wolf === null) return;
              void props.ctx.sendCommand({
                type: "trigger_wolf_explode",
                wolfSeat: wolf,
                whiteWolfTargetSeat: targetSeat(),
              });
            }}
            class="min-h-11 px-5 rounded-full bg-eye-core items-center justify-center active:opacity-75 disabled:opacity-35"
          >
            <Text class="text-stage-bg text-xs font-bold">
              {targetSeat() !== null
                ? loc() === "en-US"
                  ? `Drag #${targetSeat()}`
                  : `白狼王带走 ${targetSeat()}号`
                : loc() === "en-US"
                  ? "Select Target"
                  : "请选择带人目标"}
            </Text>
          </Button>
        </View>
      </If>

      <If when={reason() === "last_words"}>
        <View class="flex-row items-center justify-end shrink-0">
          <Button
            testID="werewolf-finish-last-words-btn"
            onPress={() => {
              void props.ctx.sendCommand({ type: "finish_last_words" });
            }}
            class="min-h-11 px-5 rounded-full bg-eye-core flex-row items-center gap-1.5 active:opacity-75"
          >
            <Text class="text-stage-bg text-xs font-bold">
              {loc() === "en-US" ? "Finish Last Words" : "遗言完毕，继续流程"}
            </Text>
            <WerewolfStageIcon name="arrow_right" tone="stageBg" size={15} />
          </Button>
        </View>
      </If>
    </View>
  );
}

function GameOverStage(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
  onOpenHistory: () => void;
  onOpenReplay: () => void;
}) {
  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();
  const revealMotion = createMotion(reduceMotion() ? {} : { enter: "fadeIn", duration: 220 });
  const seatGridClass = () =>
    st().seats.length <= 9 ? "grid grid-cols-3 gap-1.5" : "grid grid-cols-4 gap-1";

  return (
    <View
      testID="werewolf-gameover-panel"
      class="flex-1 min-h-0 rounded-3xl border border-stage-pill-border bg-stage-panel p-3 gap-2"
      style={{ pointerEvents: "auto", opacity: revealMotion.opacity }}
    >
      <View class="flex-row items-center justify-between shrink-0">
        <Text role="header" class="text-stage-fg font-bold text-base">
          {loc() === "en-US" ? "Roles Revealed" : "身份揭晓"}
        </Text>
        <Button
          testID="werewolf-terminal-open-history"
          onPress={props.onOpenHistory}
          class="min-h-11 px-3 rounded-full flex-row items-center gap-1.5 hover:bg-stage-pill-bg active:opacity-75 transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-face-amber-edge"
        >
          <WerewolfStageIcon name="clock" tone="stageMuted" size={16} />
          <Text class="text-stage-pill-fg text-sm font-medium">{WEREWOLF_HISTORY_TITLE[loc()]}</Text>
        </Button>
      </View>
      <Scroll class="flex-1 min-h-0" contentClass="min-h-full justify-center">
        {/* Role reveal grid */}
        <View testID="werewolf-role-reveal-grid" class={seatGridClass()}>
          <Each of={st().seats} key={(item) => item.seat}>
            {(seatAcc) => {
              const s = () => seatAcc();
              const compact = () => st().seats.length > 9;
              const role = () => s().revealedRole ?? "villager";
              const roleLabel = () => {
                const r = s().revealedRole;
                return r ? WEREWOLF_ROLE_LABELS[r][loc()] : "?";
              };
              const roleTextClass = () => {
                const r = s().revealedRole;
                if (!r) return "text-stage-pill-muted text-xs font-semibold";
                if (isWolfRole(r)) {
                  return "text-face-rose-core text-xs font-bold";
                }
                if (isGodRole(r)) {
                  return "text-face-amber-core text-xs font-bold";
                }
                return "text-face-sage-core text-xs font-semibold";
              };
              return (
                <View
                  class={
                    compact()
                      ? "min-w-0 h-[38px] rounded-xl border border-stage-pill-border bg-stage-tile px-1.5 py-0.5 flex-row items-center gap-1"
                      : "min-w-0 min-h-[46px] rounded-2xl border border-stage-pill-border bg-stage-tile px-2.5 py-1.5 flex-row items-center gap-2"
                  }
                >
                  <WerewolfRoleIcon
                    role={role()}
                    tone={s().revealedRole ? roleFactionTone(role()) : "stageMuted"}
                    size={compact() ? 14 : 19}
                  />
                  <View class={compact() ? "flex-1 min-w-0" : "flex-1 min-w-0 gap-0.5"}>
                    <View class="flex-row items-center gap-1 min-w-0">
                      <Text
                        class="text-stage-fg text-xs font-bold shrink-0"
                        style={{ fontVariant: ["tabular-nums"] }}
                      >
                        {compact() || loc() === "en-US"
                          ? `#${s().seat}${s().isSheriff ? "★" : ""}`
                          : `${s().seat}号${s().isSheriff ? "★" : ""}`}
                      </Text>
                      <Text
                        class={`${roleTextClass()} shrink min-w-0`}
                        style={{ numberOfLines: 1 }}
                      >
                        {roleLabel()}
                      </Text>
                    </View>
                    <Text
                      class="text-stage-pill-muted text-xs"
                      style={{ numberOfLines: 1 }}
                    >
                      {s().nickname ? `${s().nickname} · ` : ""}
                      {s().alive
                        ? loc() === "en-US"
                          ? compact()
                            ? "Alive"
                            : "Survived"
                          : compact()
                            ? "存活"
                            : "存活至终局"
                        : loc() === "en-US"
                          ? `D${s().deathDay ?? "?"} Out`
                          : compact()
                            ? `D${s().deathDay ?? "?"}出局`
                            : `第${s().deathDay ?? "?"}天出局`}
                    </Text>
                  </View>
                </View>
              );
            }}
          </Each>
        </View>
      </Scroll>

      <View class="flex-row items-center gap-2 shrink-0">
        <Button
          testID="werewolf-back-lobby-btn"
          onPress={() => { void props.ctx.sendCommand({ type: "open_lobby" }); }}
          class="flex-1 min-h-11 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75 focus-visible:ring-2 focus-visible:ring-face-amber-edge"
        >
          <Text class="text-stage-pill-fg text-xs font-semibold">
            {loc() === "en-US" ? "Adjust Board" : "调整板子"}
          </Text>
        </Button>
        <Button
          testID="werewolf-start-replay"
          onPress={props.onOpenReplay}
          disabled={props.ctx.busy() || !st().completedMatchId}
          class="flex-[1.2] min-h-11 rounded-full border border-stage-amber-border bg-stage-amber-bg flex-row items-center justify-center gap-1.5 active:opacity-75 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-face-amber-edge"
        >
          <WerewolfStageIcon name="replay" tone="amber" size={16} />
          <Text class="text-face-amber-core text-sm font-bold">{loc() === "en-US" ? "Start Replay" : "开始复盘"}</Text>
        </Button>
        <Button
          testID="werewolf-play-again-btn"
          onPress={() => { void props.ctx.sendCommand({ type: "play_again" }); }}
          class="flex-[1.2] min-h-11 rounded-full bg-eye-core flex-row items-center justify-center gap-1.5 transition-transform duration-180 active:scale-[0.97] motion-reduce:active:scale-100 focus-visible:ring-2 focus-visible:ring-face-amber-edge"
        >
          <Text class="text-stage-bg text-sm font-bold">{loc() === "en-US" ? "Play Again" : "再来一局"}</Text>
          <WerewolfStageIcon name="arrow_right" tone="stageBg" size={16} />
        </Button>
      </View>
    </View>
  );
}

export function WerewolfStageError(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
}) {
  const diagnostic = () => readWerewolfDiagnostic(props.ctx);
  return (
    <If when={Boolean(diagnostic())}>
      <View class="shrink-0 rounded-xl border border-stage-rose-border bg-stage-tile px-3 py-1.5" selectable={true}>
        <Text class="text-face-rose-core text-xs" role="alert">{diagnostic()}</Text>
      </View>
    </If>
  );
}

export function WerewolfStageCanvas(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
}) {
  const st = () => readWerewolfState(props.ctx);
  const historyRoute = signal<WerewolfHistoryRoute | null>(null);

  const isOnDeviceNightTurn = () => {
    const p = st().phase;
    const isNightTurn =
      p === "night_guard" ||
      p === "night_wolf" ||
      p === "night_witch" ||
      p === "night_seer";
    return isNightTurn && st().rules.surfaceMode !== "lan_companion";
  };

  const isSplitDayTable = () => {
    const p = st().phase;
    if (p === "dawn_announce" || p === "day_discussion" || p === "day_pk_speech") {
      return true;
    }
    if (p === "sheriff_election") {
      const sub = st().sheriffSubphase;
      return sub === "speech" || sub === "pk_speech";
    }
    return false;
  };

  const isSheriffSignup = () =>
    st().phase === "sheriff_election" && st().sheriffSubphase === "signup";

  const isVotingPhase = () => {
    const p = st().phase;
    if (p === "day_voting" || p === "day_pk_voting") return true;
    if (p === "sheriff_election") {
      const sub = st().sheriffSubphase;
      return sub === "voting" || sub === "pk_voting";
    }
    return false;
  };

  const nightEnter = createMotion(
    reduceMotion() ? {} : { enter: "fadeIn", duration: 180 },
  );
  const judgeSubtitle = () => {
    const { phase, voiceStatus, lastJudgeSpeech } = st();
    const isFullPostureRest =
      phase === "night_intro" || phase === "dawn_settle";
    return isFullPostureRest &&
      (voiceStatus.mutedByHost || voiceStatus.degradedToSubtitles)
      ? lastJudgeSpeech
      : "";
  };

  return (
    <View class="flex-1 min-h-0 gap-1.5" style={{ pointerEvents: "box-none" }}>
      <If when={Boolean(judgeSubtitle())}>
        <View class="shrink-0 rounded-xl border border-stage-pill-border bg-stage-panel px-3 py-1.5">
          <Text class="text-stage-fg text-xs" style={{ numberOfLines: 2 }}>{judgeSubtitle()}</Text>
        </View>
      </If>
      <If when={st().phase === "lobby"}>
        <LobbyStagePanel ctx={props.ctx} onOpenHistory={() => historyRoute.set({ view: "history", origin: "lobby" })} />
      </If>

      <If when={st().phase === "dealing"}>
        <DealingStageCard ctx={props.ctx} />
      </If>

      <If when={isOnDeviceNightTurn()}>
        <View
          class="flex-1 min-h-0 rounded-3xl border border-stage-pill-border bg-stage-panel p-4"
          style={{ pointerEvents: "auto", opacity: nightEnter.opacity }}
        >
          <WerewolfNightActionBody ctx={props.ctx} />
        </View>
      </If>

      <If when={isSheriffSignup()}>
        <SheriffSignupStagePanel ctx={props.ctx} />
      </If>

      <If when={isSplitDayTable()}>
        <TabletopRingStage ctx={props.ctx} />
      </If>

      <If when={isVotingPhase()}>
        <VotingStagePanel ctx={props.ctx} />
      </If>

      <If when={st().phase === "leave_resolution"}>
        <LeaveResolutionStagePanel ctx={props.ctx} />
      </If>

      <If when={st().phase === "game_over"}>
        <GameOverStage
          ctx={props.ctx}
          onOpenHistory={() => historyRoute.set({ view: "history", origin: "terminal" })}
          onOpenReplay={() => historyRoute.set({ view: "current" })}
        />
      </If>
      <WerewolfHistoryOverlay ctx={props.ctx} route={historyRoute()} onClose={() => historyRoute.set(null)} />
    </View>
  );
}
