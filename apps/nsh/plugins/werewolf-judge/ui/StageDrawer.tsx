import {
  createAnimatedValue,
  effect,
  reduceMotion,
  Scroll,
  signal,
  Text,
  View,
} from "nsh";
import { Button } from "nsh/base";
import type {
  PluginViewContext,
  StageDrawerDetent,
} from "../../../ui/plugins/ui-contracts";
import {
  WEREWOLF_PRESET_LABELS,
  WEREWOLF_ROLES,
  WEREWOLF_ROLE_LABELS,
  type WerewolfCommand,
  type WerewolfPresetId,
  type WerewolfPublicState,
} from "../contracts";
import { QrCodeCanvas } from "./QrCodeCanvas";
import { readWerewolfState } from "./StageCapsule";

const PRESET_TABS: readonly WerewolfPresetId[] = [
  "6p_joy",
  "9p_standard",
  "12p_guard",
  "12p_idiot",
];

const NIGHT_GATE_HOLD_MS = 350;

function LobbyDrawerPanel(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
  detent: () => StageDrawerDetent;
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

  const deckSummary = () =>
    WEREWOLF_ROLES.filter((role) => (st().rules.roleCounts[role] ?? 0) > 0)
      .map(
        (role) =>
          `${WEREWOLF_ROLE_LABELS[role][loc()]}×${st().rules.roleCounts[role]}`,
      )
      .join(" · ");

  return (
    <If
      when={props.detent() !== "peek"}
      else={
        <View
          testID="werewolf-lobby-peek"
          class="flex-1 flex-row items-center justify-between gap-2.5"
        >
          <View class="flex-1 min-w-0 gap-0.5">
            <Text
              class="text-stage-fg text-xs font-bold"
              style={{ numberOfLines: 1 }}
            >
              {WEREWOLF_PRESET_LABELS[st().rules.presetId][loc()]}
            </Text>
            <Text
              class="text-stage-muted text-xs"
              style={{ numberOfLines: 1 }}
            >
              {deckSummary()}
            </Text>
          </View>
          <View class="flex-row items-center gap-2 shrink-0">
            <Button
              testID="werewolf-open-settings-btn"
              onPress={() => props.ctx.openPluginSettings()}
              class="min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
            >
              <Text class="text-stage-pill-fg text-xs font-medium">
                {loc() === "en-US" ? "Rules" : "详细规则"}
              </Text>
            </Button>
            <Button
              testID="werewolf-start-dealing-btn"
              onPress={() => {
                void props.ctx.sendCommand({ type: "start_dealing" });
              }}
              class="min-h-11 px-4 rounded-xl bg-eye-core items-center justify-center active:opacity-75"
            >
              <Text class="text-stage-bg text-xs font-bold">
                {loc() === "en-US" ? "Deal Cards" : "开始发牌"}
              </Text>
            </Button>
          </View>
        </View>
      }
    >
      <View
        testID="werewolf-lobby-panel"
        class="flex-1 min-h-0 flex-row gap-3"
      >
        {/* Left column: Preset tabs + Surface mode + Quick toggles */}
        <Scroll class="flex-1 min-w-0 min-h-0" contentClass="gap-2.5 pr-1">
          <View class="flex-row flex-wrap gap-1.5">
            <Each of={PRESET_TABS} key={(id) => id}>
              {(presetAcc) => {
                const pid = () => presetAcc();
                const active = () => st().rules.presetId === pid();
                return (
                  <Button
                    testID={`werewolf-preset-${pid()}`}
                    selected={active()}
                    onPress={() => {
                      void props.ctx.sendCommand({
                        type: "select_preset",
                        presetId: pid(),
                      });
                    }}
                    class={
                      active()
                        ? "min-h-11 px-3 rounded-xl border border-face-amber-edge bg-lighting-bg items-center justify-center active:opacity-75"
                        : "min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
                    }
                  >
                    <Text
                      class={
                        active()
                          ? "text-face-amber-core text-xs font-bold"
                          : "text-stage-fg text-xs font-medium"
                      }
                    >
                      {WEREWOLF_PRESET_LABELS[pid()][loc()]}
                    </Text>
                  </Button>
                );
              }}
            </Each>
          </View>

          {/* Surface mode segmented toggle with sliding selection indicator */}
          <View
            onLayout={(ev) => surfaceTrackWidth.set(ev.bounds.size.width)}
            class="relative rounded-2xl border border-stage-pill-border bg-stage-pill-bg p-1 flex-row items-center"
          >
            <If when={surfaceTrackWidth() > 8}>
              <View
                class="absolute top-1 bottom-1 left-1 rounded-xl border border-face-amber-edge bg-lighting-bg"
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
              class="flex-1 min-h-11 px-3 rounded-xl items-center justify-center active:opacity-75"
            >
              <Text
                class={
                  st().rules.surfaceMode === "on_device"
                    ? "text-face-amber-core text-xs font-bold"
                    : "text-stage-fg text-xs font-medium"
                }
              >
                {loc() === "en-US" ? "On-Device Shield" : "本机触控防窥"}
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
              class="flex-1 min-h-11 px-3 rounded-xl items-center justify-center active:opacity-75"
            >
              <Text
                class={
                  st().rules.surfaceMode === "lan_companion"
                    ? "text-face-amber-core text-xs font-bold"
                    : "text-stage-fg text-xs font-medium"
                }
              >
                {loc() === "en-US" ? "Phone QR Companion" : "手机扫码副屏"}
              </Text>
            </Button>
          </View>

          {/* Rule chips + Settings entry */}
          <View class="flex-row flex-wrap items-center gap-1.5">
            <Button
              testID="werewolf-toggle-sheriff"
              selected={st().rules.hasSheriff}
              onPress={() => {
                void props.ctx.sendCommand({
                  type: "update_rules",
                  patch: { hasSheriff: !st().rules.hasSheriff },
                });
              }}
              class={
                st().rules.hasSheriff
                  ? "min-h-11 px-3 rounded-xl border border-lighting-border bg-lighting-bg items-center justify-center active:opacity-75"
                  : "min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
              }
            >
              <Text
                class={
                  st().rules.hasSheriff
                    ? "text-face-amber-core text-xs font-semibold"
                    : "text-stage-muted text-xs"
                }
              >
                {st().rules.hasSheriff
                  ? loc() === "en-US"
                    ? "Sheriff: On"
                    : "警长竞选：开"
                  : loc() === "en-US"
                    ? "Sheriff: Off"
                    : "警长竞选：关"}
              </Text>
            </Button>

            <Button
              testID="werewolf-toggle-same-guard-save"
              selected={st().rules.sameGuardSameSaveDies}
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
                  ? "min-h-11 px-3 rounded-xl border border-lighting-border bg-lighting-bg items-center justify-center active:opacity-75"
                  : "min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
              }
            >
              <Text
                class={
                  st().rules.sameGuardSameSaveDies
                    ? "text-face-amber-core text-xs font-semibold"
                    : "text-stage-muted text-xs"
                }
              >
                {st().rules.sameGuardSameSaveDies
                  ? loc() === "en-US"
                    ? "Guard+Save Clash"
                    : "同守同救奶穿"
                  : loc() === "en-US"
                    ? "Guard+Save Lives"
                    : "同守同救存活"}
              </Text>
            </Button>

            <Button
              testID="werewolf-toggle-motion"
              selected={st().rules.motionMode === "embodied_patrol"}
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
                  ? "min-h-11 px-3 rounded-xl border border-airflow-border bg-airflow-bg items-center justify-center active:opacity-75"
                  : "min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
              }
            >
              <Text
                class={
                  st().rules.motionMode === "embodied_patrol"
                    ? "text-face-mist-core text-xs font-semibold"
                    : "text-stage-muted text-xs"
                }
              >
                {st().rules.motionMode === "embodied_patrol"
                  ? loc() === "en-US"
                    ? "Embodied Patrol"
                    : "具身转体环视"
                  : loc() === "en-US"
                    ? "Stationary Gaze"
                    : "纯眼神凝视"}
              </Text>
            </Button>

            <Button
              testID="werewolf-open-settings-btn"
              onPress={() => props.ctx.openPluginSettings()}
              class="min-h-11 px-3 rounded-xl border border-stage-pill-border bg-elevated-glass items-center justify-center active:opacity-75"
            >
              <Text class="text-stage-pill-fg text-xs font-medium">
                {loc() === "en-US" ? "Custom Deck" : "自定义配牌"}
              </Text>
            </Button>
          </View>
        </Scroll>

        {/* Right column: QR Companion card OR Deck composition + Start CTA */}
        <View class="w-80 shrink-0 justify-between gap-2">
          <If
            when={
              st().rules.surfaceMode === "lan_companion" || st().lan.active
            }
            else={
              <View class="flex-1 rounded-2xl border border-stage-pill-border bg-stage-pill-bg p-3 justify-between gap-1.5">
                <View class="flex-row items-center justify-between gap-2">
                  <Text class="text-stage-fg text-xs font-bold">
                    {loc() === "en-US"
                      ? `${st().rules.playerCount}-Player Deck`
                      : `${st().rules.playerCount}人局配牌概览`}
                  </Text>
                  <Text class="text-face-amber-core text-xs font-semibold">
                    {st().rules.winMode === "slaughter_all"
                      ? loc() === "en-US"
                        ? "Slaughter All"
                        : "屠城局"
                      : loc() === "en-US"
                        ? "Slaughter Side"
                        : "屠边局"}
                  </Text>
                </View>
                <Text
                  class="text-stage-fg text-xs"
                  style={{ numberOfLines: 3 }}
                >
                  {deckSummary()}
                </Text>
                <Text class="text-stage-muted text-xs">
                  {st().visionAvailable
                    ? loc() === "en-US"
                      ? "Person tracker active · auto face alignment ready"
                      : "视觉人物追踪已就绪 · 发牌自动寻人抓拍"
                    : loc() === "en-US"
                      ? "Servo clockwise seat patrol ready"
                      : "桌面顺时针环视发牌就绪"}
                </Text>
              </View>
            }
          >
            <View class="flex-1 rounded-2xl border border-stage-pill-border bg-stage-pill-bg p-2.5 flex-row items-center gap-2.5">
              <QrCodeCanvas value={st().lan.baseUrl ?? ""} size={104} />
              <View class="flex-1 min-w-0 justify-between gap-1.5">
                <Text
                  testID="werewolf-lan-url"
                  class="text-stage-fg text-xs font-mono"
                  style={{ numberOfLines: 2 }}
                >
                  {st().lan.baseUrl ??
                    (loc() === "en-US"
                      ? "Starting LAN room..."
                      : "正在开启局域网房间…")}
                </Text>

                <If when={Boolean(st().lan.error)}>
                  <Text class="text-destructive text-xs" style={{ numberOfLines: 2 }}>
                    {st().lan.error}
                  </Text>
                </If>

                <View class="flex-row flex-wrap items-center gap-2">
                  <Each of={st().seats} key={(item) => item.seat}>
                    {(seatAcc) => {
                      const s = () => seatAcc();
                      return (
                        <If
                          when={s().lanClaimed}
                          else={
                            <Text
                              class="text-stage-muted text-xs"
                              style={{ fontVariant: ["tabular-nums"] }}
                            >
                              {`#${s().seat}`}
                            </Text>
                          }
                        >
                          <Button
                            testID={`werewolf-release-seat-${s().seat}`}
                            hitSlop={{ top: 4, bottom: 4, left: 3, right: 3 }}
                            accessibilityLabel={
                              loc() === "en-US"
                                ? `Release seat ${s().seat}`
                                : `解绑 ${s().seat} 号座位`
                            }
                            onPress={() => {
                              void props.ctx.sendCommand({
                                type: "release_lan_seat",
                                seat: s().seat,
                              });
                            }}
                            class="min-h-9 min-w-11 px-2.5 py-0.5 rounded-full border border-air-quality-border bg-air-quality-bg items-center justify-center active:opacity-75"
                          >
                            <Text
                              class="text-face-sage-core text-xs font-bold"
                              style={{ fontVariant: ["tabular-nums"] }}
                            >
                              {loc() === "en-US"
                                ? `#${s().seat}✓×`
                                : `#${s().seat}解绑`}
                            </Text>
                          </Button>
                        </If>
                      );
                    }}
                  </Each>
                </View>

                <Button
                  testID="werewolf-refresh-lan-btn"
                  onPress={() => {
                    void props.ctx.sendCommand({ type: "refresh_lan_address" });
                  }}
                  class="min-h-11 px-2.5 rounded-xl border border-stage-pill-border bg-elevated-glass items-center justify-center active:opacity-75"
                >
                  <Text class="text-stage-pill-fg text-xs font-medium">
                    {loc() === "en-US" ? "Refresh IP" : "刷新地址"}
                  </Text>
                </Button>
              </View>
            </View>
          </If>

          <Button
            testID="werewolf-start-dealing-btn"
            onPress={() => {
              void props.ctx.sendCommand({ type: "start_dealing" });
            }}
            class="min-h-11 rounded-2xl bg-eye-core items-center justify-center active:opacity-75"
          >
            <Text class="text-stage-bg text-sm font-bold">
              {loc() === "en-US" ? "Shuffle & Deal Cards" : "开始洗牌发牌"}
            </Text>
          </Button>
        </View>
      </View>
    </If>
  );
}

function NightRoleDrawerPanel(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
  detent: () => StageDrawerDetent;
  requestDetent?: (detent: Exclude<StageDrawerDetent, "closed">) => void;
}) {
  const lanOverride = signal(false);
  let lastPhaseKey = "";
  let gateDownAtMs = 0;
  let gateTriggeredOnDown = false;
  let gateHoldConsumed = false;

  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();

  effect(() => {
    const key = `${st().day}:${st().phase}`;
    if (key !== lastPhaseKey) {
      lastPhaseKey = key;
      gateDownAtMs = 0;
      gateTriggeredOnDown = false;
      gateHoldConsumed = false;
      lanOverride.set(false);
    }
  });

  const prompt = () => st().nightPrompt;
  const activeRole = () => prompt()?.activeRole ?? null;
  const unlocked = () => Boolean(prompt()?.gateUnlocked);
  const selectedSeat = () => prompt()?.selectedTargetSeat ?? null;

  const roleWakeTitle = () => {
    const r = activeRole();
    if (loc() === "en-US") {
      if (r === "guard") return "Guard — Open Your Eyes";
      if (r === "werewolf") return "Werewolves — Open Your Eyes";
      if (r === "witch") return "Witch — Open Your Eyes";
      if (r === "seer") return "Seer — Open Your Eyes";
      return "Night Turn";
    }
    if (r === "guard") return "守卫请睁眼";
    if (r === "werewolf") return "狼人请睁眼";
    if (r === "witch") return "女巫请睁眼";
    if (r === "seer") return "预言家请睁眼";
    return "夜间行动";
  };

  const showLanDesensitizedBar = () =>
    st().rules.surfaceMode === "lan_companion" &&
    !lanOverride() &&
    props.detent() === "peek";

  return (
    <If
      when={!showLanDesensitizedBar()}
      else={
        <View
          testID="werewolf-night-lan-peek"
          class="flex-1 flex-row items-center justify-between gap-3"
        >
          <View class="flex-1 min-w-0 gap-0.5">
            <Text class="text-stage-fg text-xs font-semibold">
              {loc() === "en-US"
                ? "Night Action via Companion Phones"
                : "手机副屏夜间行动中 · 请全场保持闭眼"}
            </Text>
            <Text class="text-stage-muted text-xs" style={{ numberOfLines: 1 }}>
              {st().lastJudgeSpeech}
            </Text>
          </View>
          <Button
            testID="werewolf-lan-host-override-btn"
            onPress={() => {
              lanOverride.set(true);
              props.requestDetent?.("large");
            }}
            class="min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75 shrink-0"
          >
            <Text class="text-stage-pill-fg text-xs font-medium">
              {loc() === "en-US" ? "Host Panel" : "应急本机操作"}
            </Text>
          </Button>
        </View>
      }
    >
      <If
        when={unlocked()}
        else={
          <View
            testID="werewolf-night-gate-panel"
            class="flex-1 items-center justify-center gap-2.5 px-4"
          >
            <Text class="text-stage-fg text-base font-bold text-center">
              {roleWakeTitle()}
            </Text>
            <Text class="text-stage-muted text-xs text-center">
              {loc() === "en-US"
                ? "Tap to unlock the role panel (or hold to peek and release to mask immediately)."
                : "仅当前睁眼角色操作：点击解锁技能面板（或按住窥视、松手 0ms 瞬时遮蔽）"}
            </Text>
            <Button
              testID="werewolf-night-gate-btn"
              onPressDown={() => {
                gateDownAtMs = Date.now();
                gateTriggeredOnDown = true;
                gateHoldConsumed = false;
                void props.ctx.sendCommand({
                  type: "set_night_gate",
                  unlocked: true,
                });
              }}
              onPressUp={() => {
                if (
                  gateDownAtMs > 0 &&
                  Date.now() - gateDownAtMs >= NIGHT_GATE_HOLD_MS
                ) {
                  gateHoldConsumed = true;
                  gateDownAtMs = 0;
                  void props.ctx.sendCommand({
                    type: "set_night_gate",
                    unlocked: false,
                  });
                }
              }}
              onPress={() => {
                if (gateHoldConsumed) {
                  gateHoldConsumed = false;
                  gateTriggeredOnDown = false;
                  return;
                }
                if (gateTriggeredOnDown) {
                  gateTriggeredOnDown = false;
                  gateDownAtMs = 0;
                  return;
                }
                gateDownAtMs = 0;
                void props.ctx.sendCommand({
                  type: "set_night_gate",
                  unlocked: true,
                });
              }}
              class="min-h-12 px-6 rounded-2xl border border-face-amber-edge bg-lighting-bg items-center justify-center active:opacity-80"
            >
              <Text class="text-face-amber-core text-sm font-bold">
                {loc() === "en-US"
                  ? "Unlock Privacy Shield"
                  : "解锁夜间防窥盾"}
              </Text>
            </Button>
          </View>
        }
      >
        <View
          testID="werewolf-night-unlocked-panel"
          class="flex-1 min-h-0 justify-between gap-2"
        >
          {/* Header: Role context + instant 0ms lock shield button */}
          <View class="flex-row items-center justify-between gap-2">
            <View class="flex-1 min-w-0 gap-0.5">
              <Text class="text-stage-fg text-sm font-bold">
                {roleWakeTitle()}
              </Text>
              <If when={activeRole() === "guard"}>
                <Text class="text-stage-muted text-xs">
                  {prompt()?.lastGuardedSeat !== null
                    ? loc() === "en-US"
                      ? `Guarded #${prompt()?.lastGuardedSeat} last night (cannot guard twice in a row)`
                      : `昨晚已守护 #${prompt()?.lastGuardedSeat} 号（不可连续两晚守护同一人）`
                    : loc() === "en-US"
                      ? "Choose one living player to protect, or leave empty."
                      : "请选择一名存活玩家守护，或选择空守"}
                </Text>
              </If>
              <If when={activeRole() === "werewolf"}>
                <Text class="text-face-rose-core text-xs font-medium">
                  {loc() === "en-US"
                    ? `Pack Teammates: ${
                        prompt()
                          ?.wolfTeammateSeats.map((s) => `#${s}`)
                          .join(", ") || "-"
                      }`
                    : `狼队存活同伴：${
                        prompt()
                          ?.wolfTeammateSeats.map((s) => `#${s}`)
                          .join("、") || "-"
                      }`}
                </Text>
              </If>
              <If when={activeRole() === "witch"}>
                <Text class="text-face-sage-core text-xs font-medium">
                  {prompt()?.witchContext?.attackedSeat !== null &&
                  prompt()?.witchContext?.attackedSeat !== undefined
                    ? loc() === "en-US"
                      ? `Attacked tonight: #${prompt()?.witchContext?.attackedSeat}`
                      : `今晚被狼人袭击的是：#${prompt()?.witchContext?.attackedSeat} 号`
                    : prompt()?.witchContext?.canSave
                      ? loc() === "en-US"
                        ? "No wolf victim tonight"
                        : "今晚无人被袭击（空刀）"
                      : loc() === "en-US"
                        ? "Antidote already used"
                        : "解药已用尽（不可获知刀口）"}
                </Text>
              </If>
              <If when={activeRole() === "seer"}>
                <Text class="text-face-mist-core text-xs font-medium">
                  {loc() === "en-US"
                    ? "Select one living player to inspect their alignment."
                    : "请选择一名其他存活玩家查验阵营"}
                </Text>
              </If>
            </View>

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
              class="min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75 shrink-0"
            >
              <Text class="text-stage-pill-fg text-xs font-medium">
                {loc() === "en-US" ? "Mask Now" : "立即遮蔽"}
              </Text>
            </Button>
          </View>

          {/* Seer post-check oracle result OR 1..N target grid */}
          <If
            when={
              activeRole() === "seer" && Boolean(prompt()?.seerResult)
            }
            else={
              <Scroll class="flex-1 min-h-0" contentClass="gap-2">
                <View class="flex-row flex-wrap gap-2">
                  <Each of={st().seats} key={(item) => item.seat}>
                    {(seatAcc) => {
                      const s = () => seatAcc();
                      const canSelect = () =>
                        Boolean(prompt()?.selectableSeats.includes(s().seat));
                      const isPicked = () => selectedSeat() === s().seat;
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
                              ? "min-w-14 min-h-11 px-3 rounded-xl border-2 border-face-amber-edge bg-lighting-bg items-center justify-center active:opacity-80 disabled:opacity-30"
                              : "min-w-14 min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-80 disabled:opacity-30"
                          }
                        >
                          <Text
                            class={
                              isPicked()
                                ? "text-face-amber-core text-xs font-bold"
                                : "text-stage-fg text-xs font-semibold"
                            }
                            style={{ fontVariant: ["tabular-nums"] }}
                          >
                            {`#${s().seat}`}
                          </Text>
                        </Button>
                      );
                    }}
                  </Each>
                </View>
              </Scroll>
            }
          >
            {() => {
              const res = prompt()!.seerResult!;
              return (
                <View
                  testID="werewolf-seer-result-card"
                  class={
                    res.isWolf
                      ? "flex-1 rounded-2xl border border-face-rose-edge bg-stage-pill-bg px-4 py-3 flex-row items-center justify-between gap-3"
                      : "flex-1 rounded-2xl border border-face-amber-edge bg-lighting-bg px-4 py-3 flex-row items-center justify-between gap-3"
                  }
                >
                  <View class="gap-0.5">
                    <Text class="text-stage-muted text-xs">
                      {loc() === "en-US"
                        ? `Seat #${res.targetSeat} Alignment`
                        : `#${res.targetSeat} 号玩家身份查验结果`}
                    </Text>
                    <Text
                      class={
                        res.isWolf
                          ? "text-face-rose-core text-lg font-bold"
                          : "text-face-amber-core text-lg font-bold"
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

                  <Button
                    testID="werewolf-finish-seer-btn"
                    onPress={() => {
                      void props.ctx.sendCommand({ type: "finish_seer_turn" });
                    }}
                    class="min-h-11 px-5 rounded-xl bg-eye-core items-center justify-center active:opacity-75"
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

          {/* Role-specific submit bar */}
          <If when={activeRole() === "guard"}>
            <View class="flex-row items-center justify-end gap-2">
              <Button
                testID="werewolf-guard-empty-btn"
                onPress={() => {
                  void props.ctx.sendCommand({
                    type: "submit_guard_action",
                    targetSeat: null,
                  });
                }}
                class="min-h-11 px-3.5 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
              >
                <Text class="text-stage-pill-fg text-xs font-semibold">
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
                class="min-h-11 px-4 rounded-xl bg-eye-core items-center justify-center active:opacity-75 disabled:opacity-35"
              >
                <Text class="text-stage-bg text-xs font-bold">
                  {selectedSeat() !== null
                    ? loc() === "en-US"
                      ? `Protect #${selectedSeat()}`
                      : `确认守护 #${selectedSeat()}`
                    : loc() === "en-US"
                      ? "Select Seat"
                      : "请选择守护座位"}
                </Text>
              </Button>
            </View>
          </If>

          <If when={activeRole() === "werewolf"}>
            <View class="flex-row items-center justify-end gap-2">
              <Button
                testID="werewolf-wolf-empty-btn"
                onPress={() => {
                  void props.ctx.sendCommand({
                    type: "submit_wolf_action",
                    targetSeat: null,
                  });
                }}
                class="min-h-11 px-3.5 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
              >
                <Text class="text-stage-pill-fg text-xs font-semibold">
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
                class="min-h-11 px-4 rounded-xl bg-eye-core items-center justify-center active:opacity-75 disabled:opacity-35"
              >
                <Text class="text-stage-bg text-xs font-bold">
                  {selectedSeat() !== null
                    ? loc() === "en-US"
                      ? `Attack #${selectedSeat()}`
                      : `确认袭击 #${selectedSeat()}`
                    : loc() === "en-US"
                      ? "Select Target"
                      : "请选择袭击目标"}
                </Text>
              </Button>
            </View>
          </If>

          <If when={activeRole() === "witch"}>
            <View class="flex-row flex-wrap items-center justify-end gap-2">
              <Button
                testID="werewolf-witch-pass-btn"
                onPress={() => {
                  void props.ctx.sendCommand({
                    type: "submit_witch_action",
                    save: false,
                    poisonTargetSeat: null,
                  });
                }}
                class="min-h-11 px-3.5 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
              >
                <Text class="text-stage-pill-fg text-xs font-semibold">
                  {loc() === "en-US" ? "Use No Potion" : "不用药，闭眼"}
                </Text>
              </Button>

              <Button
                testID="werewolf-witch-poison-btn"
                disabled={
                  !prompt()?.witchContext?.canPoison || selectedSeat() === null
                }
                onPress={() => {
                  const target = selectedSeat();
                  if (target === null) return;
                  void props.ctx.sendCommand({
                    type: "submit_witch_action",
                    save: false,
                    poisonTargetSeat: target,
                  });
                }}
                class="min-h-11 px-3.5 rounded-xl border border-face-rose-edge bg-stage-pill-bg items-center justify-center active:opacity-75 disabled:opacity-35"
              >
                <Text class="text-face-rose-core text-xs font-bold">
                  {selectedSeat() !== null
                    ? loc() === "en-US"
                      ? `Poison #${selectedSeat()}`
                      : `使用毒药毒 #${selectedSeat()}`
                    : loc() === "en-US"
                      ? "Pick Seat to Poison"
                      : "选座使用毒药"}
                </Text>
              </Button>

              <Button
                testID="werewolf-witch-save-btn"
                disabled={
                  !prompt()?.witchContext?.canSave ||
                  prompt()?.witchContext?.attackedSeat === null ||
                  prompt()?.witchContext?.attackedSeat === undefined
                }
                onPress={() => {
                  void props.ctx.sendCommand({
                    type: "submit_witch_action",
                    save: true,
                    poisonTargetSeat: null,
                  });
                }}
                class="min-h-11 px-4 rounded-xl bg-eye-core items-center justify-center active:opacity-75 disabled:opacity-35"
              >
                <Text class="text-stage-bg text-xs font-bold">
                  {prompt()?.witchContext?.attackedSeat !== null &&
                  prompt()?.witchContext?.attackedSeat !== undefined
                    ? loc() === "en-US"
                      ? `Save #${prompt()?.witchContext?.attackedSeat}`
                      : `使用解药救 #${prompt()?.witchContext?.attackedSeat}`
                    : loc() === "en-US"
                      ? "Antidote Unavailable"
                      : "无法使用解药"}
                </Text>
              </Button>
            </View>
          </If>

          <If
            when={
              activeRole() === "seer" && !Boolean(prompt()?.seerResult)
            }
          >
            <View class="flex-row items-center justify-end gap-2">
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
                class="min-h-11 px-4 rounded-xl bg-eye-core items-center justify-center active:opacity-75 disabled:opacity-35"
              >
                <Text class="text-stage-bg text-xs font-bold">
                  {selectedSeat() !== null
                    ? loc() === "en-US"
                      ? `Inspect #${selectedSeat()}`
                      : `查验 #${selectedSeat()} 身份`
                    : loc() === "en-US"
                      ? "Select Player"
                      : "请选择查验目标"}
                </Text>
              </Button>
            </View>
          </If>
        </View>
      </If>
    </If>
  );
}

function WolfExplodeInlineRow(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
  onClose: () => void;
}) {
  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();
  const livingSeats = () => st().seats.filter((s) => s.alive);

  return (
    <View
      testID="werewolf-explode-picker"
      class="flex-row items-center justify-between gap-2"
    >
      <Text class="text-face-rose-core text-xs font-bold shrink-0">
        {loc() === "en-US" ? "Self-Explode:" : "选择自爆狼人："}
      </Text>
      <Scroll
        horizontal
        class="flex-1 min-w-0"
        contentClass="flex-row items-center gap-1.5"
      >
        <Each of={livingSeats()} key={(item) => item.seat}>
          {(seatAcc) => {
            const s = () => seatAcc();
            return (
              <Button
                testID={`werewolf-explode-seat-${s().seat}`}
                onPress={() => {
                  void props.ctx
                    .sendCommand({
                      type: "trigger_wolf_explode",
                      wolfSeat: s().seat,
                    })
                    .then(() => {
                      if (!props.ctx.uiError()) {
                        props.onClose();
                      }
                    });
                }}
                class="min-w-12 min-h-11 px-3 rounded-xl border border-face-rose-edge bg-stage-pill-bg items-center justify-center active:opacity-75"
              >
                <Text
                  class="text-face-rose-core text-xs font-bold"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {`#${s().seat}`}
                </Text>
              </Button>
            );
          }}
        </Each>
      </Scroll>
      <Button
        testID="werewolf-cancel-explode-btn"
        onPress={() => props.onClose()}
        class="min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75 shrink-0"
      >
        <Text class="text-stage-pill-fg text-xs font-medium">
          {loc() === "en-US" ? "Cancel" : "取消"}
        </Text>
      </Button>
    </View>
  );
}

function SheriffSignupDrawerPanel(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
}) {
  const explodeOpen = signal(false);
  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();

  const candidateCount = () =>
    st().seats.filter((s) => s.alive && s.isCandidate).length;

  return (
    <View
      testID="werewolf-sheriff-signup-panel"
      class="flex-1 min-h-0 justify-between gap-2"
    >
      <View class="flex-row items-center justify-between gap-2">
        <Text class="text-stage-fg text-sm font-bold">
          {loc() === "en-US"
            ? "Sheriff Election Sign-Up"
            : "警长竞选上警报名（点击上警玩家号码）"}
        </Text>
        <Text
          class="text-face-amber-core text-xs font-semibold"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {loc() === "en-US"
            ? `Candidates: ${candidateCount()}`
            : `已报名上警：${candidateCount()} 人`}
        </Text>
      </View>

      <Scroll class="flex-1 min-h-0" contentClass="gap-2">
        <View class="flex-row flex-wrap gap-2">
          <Each of={st().seats} key={(item) => item.seat}>
            {(seatAcc) => {
              const s = () => seatAcc();
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
                      ? "min-w-16 min-h-11 px-3 rounded-xl border-2 border-face-amber-edge bg-lighting-bg items-center justify-center active:opacity-80 disabled:opacity-30"
                      : "min-w-16 min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-80 disabled:opacity-30"
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
                    {s().isCandidate ? `#${s().seat} 上警` : `#${s().seat}`}
                  </Text>
                </Button>
              );
            }}
          </Each>
        </View>
      </Scroll>

      <If
        when={!explodeOpen()}
        else={
          <WolfExplodeInlineRow
            ctx={props.ctx}
            onClose={() => explodeOpen.set(false)}
          />
        }
      >
        <View class="flex-row items-center justify-between gap-2">
          <Button
            testID="werewolf-open-explode-btn"
            onPress={() => explodeOpen.set(true)}
            class="min-h-11 px-3.5 rounded-xl border border-face-rose-edge bg-stage-pill-bg items-center justify-center active:opacity-75"
          >
            <Text class="text-face-rose-core text-xs font-semibold">
              {loc() === "en-US" ? "Wolf Self-Explode" : "狼人自爆"}
            </Text>
          </Button>

          <Button
            testID="werewolf-lock-sheriff-btn"
            onPress={() => {
              void props.ctx.sendCommand({ type: "lock_sheriff_candidates" });
            }}
            class="min-h-11 px-5 rounded-xl bg-eye-core items-center justify-center active:opacity-75"
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
          </Button>
        </View>
      </If>
    </View>
  );
}

function DaySpeechHostToolbar(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
  detent: () => StageDrawerDetent;
}) {
  const explodeOpen = signal(false);
  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();

  const canExplode = () => {
    const p = st().phase;
    return (
      p === "sheriff_election" ||
      p === "dawn_announce" ||
      p === "day_discussion"
    );
  };

  const canDropOutSheriff = () =>
    st().phase === "sheriff_election" &&
    st().sheriffSubphase === "speech" &&
    st().speakingSeat !== null;

  return (
    <View
      testID="werewolf-day-toolbar"
      class="flex-1 min-h-0 justify-between gap-2"
    >
      <If
        when={!explodeOpen()}
        else={
          <WolfExplodeInlineRow
            ctx={props.ctx}
            onClose={() => explodeOpen.set(false)}
          />
        }
      >
        <View class="flex-row items-center justify-between gap-2">
          <View class="flex-row items-center gap-2 flex-wrap flex-1">
            <If when={st().phase !== "dawn_announce"}>
              <Button
                testID="werewolf-next-speaker-btn"
                onPress={() => {
                  void props.ctx.sendCommand({ type: "advance_speaker" });
                }}
                class="min-h-11 px-3.5 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
              >
                <Text class="text-stage-fg text-xs font-semibold">
                  {loc() === "en-US" ? "Next Speaker" : "下一位发言"}
                </Text>
              </Button>
            </If>

            <If when={st().speakingSeat !== null}>
              <Button
                testID="werewolf-pause-timer-btn"
                onPress={() => {
                  void props.ctx.sendCommand({ type: "toggle_timer_pause" });
                }}
                class="min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
              >
                <Text class="text-stage-pill-fg text-xs font-medium">
                  {st().timerPaused
                    ? loc() === "en-US"
                      ? "Resume"
                      : "继续计时"
                    : loc() === "en-US"
                      ? "Pause"
                      : "暂停计时"}
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
                class="min-h-11 px-3 rounded-xl border border-lighting-border bg-lighting-bg items-center justify-center active:opacity-75"
              >
                <Text class="text-face-amber-core text-xs font-semibold">
                  {loc() === "en-US"
                    ? `#${st().speakingSeat} Drop Out`
                    : `#${st().speakingSeat} 退水`}
                </Text>
              </Button>
            </If>

            <If when={canExplode()}>
              <Button
                testID="werewolf-open-explode-btn"
                onPress={() => explodeOpen.set(true)}
                class="min-h-11 px-3 rounded-xl border border-face-rose-edge bg-stage-pill-bg items-center justify-center active:opacity-75"
              >
                <Text class="text-face-rose-core text-xs font-semibold">
                  {loc() === "en-US" ? "Self-Explode" : "狼人自爆"}
                </Text>
              </Button>
            </If>
          </View>

          <View class="flex-row items-center gap-2 shrink-0">
            <If when={st().phase === "dawn_announce"}>
              <Button
                testID="werewolf-ack-dawn-drawer-btn"
                onPress={() => {
                  void props.ctx.sendCommand({ type: "acknowledge_dawn" });
                }}
                class="min-h-11 px-4 rounded-xl bg-eye-core items-center justify-center active:opacity-75"
              >
                <Text class="text-stage-bg text-xs font-bold">
                  {loc() === "en-US" ? "Begin Speech" : "开始发言"}
                </Text>
              </Button>
            </If>

            <If
              when={
                st().phase === "day_discussion" ||
                st().phase === "dawn_announce"
              }
            >
              <Button
                testID="werewolf-start-voting-btn"
                onPress={() => {
                  void props.ctx.sendCommand({ type: "start_voting" });
                }}
                class="min-h-11 px-4 rounded-xl bg-eye-core items-center justify-center active:opacity-75"
              >
                <Text class="text-stage-bg text-xs font-bold">
                  {loc() === "en-US" ? "Start Vote" : "进入放逐公投"}
                </Text>
              </Button>
            </If>
          </View>
        </View>
      </If>

      {/* Expanded battle log when user pulls drawer to medium/large */}
      <If
        when={props.detent() !== "peek" && st().publicEvents.length > 0}
      >
        <Scroll class="flex-1 min-h-0" contentClass="gap-1.5 pt-1">
          <Each
            of={st().publicEvents.slice(-8)}
            key={(ev) => ev.id}
          >
            {(evAcc) => {
              const ev = () => evAcc();
              return (
                <View class="rounded-xl bg-stage-pill-bg px-2.5 py-1.5 flex-row items-center gap-2">
                  <Text
                    class="text-stage-muted text-xs shrink-0"
                    style={{ fontVariant: ["tabular-nums"] }}
                  >
                    {`D${ev().day}`}
                  </Text>
                  <Text
                    class="text-stage-fg text-xs flex-1"
                    style={{ numberOfLines: 2 }}
                  >
                    {ev().text}
                  </Text>
                </View>
              );
            }}
          </Each>
        </Scroll>
      </If>
    </View>
  );
}

function VotingDrawerPanel(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
}) {
  const activeVoter = signal<number | null>(null);
  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();

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
    const nextUnvoted =
      voters.find((v) => !alreadyVoted.has(v)) ?? voter;
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

  return (
    <View
      testID="werewolf-voting-panel"
      class="flex-1 min-h-0 flex-row gap-3"
    >
      {/* Left column: Voter selector + Target selector */}
      <Scroll class="flex-1 min-w-0 min-h-0" contentClass="gap-2.5 pr-1">
        <View class="gap-1.5">
          <Text class="text-stage-muted text-xs font-semibold">
            {loc() === "en-US"
              ? `1. Select Voter (${st().votedSeats.length}/${st().eligibleVoterSeats.length} cast)`
              : `1. 选择投票座位（已投 ${st().votedSeats.length}/${st().eligibleVoterSeats.length}）`}
          </Text>
          <View class="flex-row flex-wrap gap-1.5">
            <Each of={st().eligibleVoterSeats} key={(v) => v}>
              {(voterAcc) => {
                const v = () => voterAcc();
                const isSelected = () => activeVoter() === v();
                const hasVoted = () => st().votedSeats.includes(v());
                const recordedTarget = () => st().votesByVoter[v()];
                const isSheriffWeight = () =>
                  st().phase !== "sheriff_election" && st().sheriffSeat === v();

                const pillLabel = () => {
                  const prefix = `#${v()}${isSheriffWeight() ? "(1.5)" : ""}`;
                  if (!hasVoted()) return prefix;
                  const tgt = recordedTarget();
                  if (tgt === undefined) return `${prefix} ✓`;
                  return tgt === null
                    ? `${prefix}→${loc() === "en-US" ? "Pass" : "弃"}`
                    : `${prefix}→#${tgt}`;
                };

                return (
                  <Button
                    testID={`werewolf-voter-${v()}`}
                    selected={isSelected()}
                    onPress={() => activeVoter.set(v())}
                    class={
                      isSelected()
                        ? "min-h-11 px-3 rounded-xl border-2 border-face-amber-edge bg-lighting-bg items-center justify-center active:opacity-80"
                        : hasVoted()
                          ? "min-h-11 px-3 rounded-xl border border-air-quality-border bg-air-quality-bg items-center justify-center active:opacity-80"
                          : "min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-80"
                    }
                  >
                    <Text
                      class={
                        isSelected()
                          ? "text-face-amber-core text-xs font-bold"
                          : hasVoted()
                            ? "text-face-sage-core text-xs font-semibold"
                            : "text-stage-fg text-xs font-medium"
                      }
                      style={{ fontVariant: ["tabular-nums"] }}
                    >
                      {pillLabel()}
                    </Text>
                  </Button>
                );
              }}
            </Each>
          </View>
        </View>

        <View class="gap-1.5">
          <Text class="text-stage-muted text-xs font-semibold">
            {activeVoter() !== null
              ? loc() === "en-US"
                ? `2. Cast Ballot for #${activeVoter()}`
                : `2. 为 #${activeVoter()} 号点击投票目标`
              : loc() === "en-US"
                ? "2. Cast Ballot"
                : "2. 选择投票目标"}
          </Text>
          <View class="flex-row flex-wrap gap-1.5">
            <Each of={validTargets()} key={(t) => t}>
              {(targetAcc) => {
                const target = () => targetAcc();
                return (
                  <Button
                    testID={`werewolf-vote-target-${target()}`}
                    disabled={activeVoter() === null}
                    onPress={() => castForActiveVoter(target())}
                    class="min-w-14 min-h-11 px-3 rounded-xl border border-stage-pill-border bg-elevated-glass items-center justify-center active:opacity-75 disabled:opacity-35"
                  >
                    <Text
                      class="text-stage-fg text-xs font-bold"
                      style={{ fontVariant: ["tabular-nums"] }}
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
              onPress={() => castForActiveVoter(null)}
              class="min-h-11 px-3.5 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75 disabled:opacity-35"
            >
              <Text class="text-stage-muted text-xs font-semibold">
                {loc() === "en-US" ? "Abstain" : "弃票"}
              </Text>
            </Button>
          </View>
        </View>
      </Scroll>

      {/* Right column: Live tally + Finalize CTA */}
      <View class="w-60 shrink-0 justify-between gap-2">
        <Scroll
          class="flex-1 min-h-0 rounded-2xl border border-stage-pill-border bg-stage-pill-bg"
          contentClass="p-2.5 gap-1.5"
        >
          <Text class="text-stage-pill-fg text-xs font-bold">
            {st().rules.surfaceMode === "lan_companion" &&
            st().voteTallies.length === 0
              ? loc() === "en-US"
                ? "Secret LAN Ballot"
                : "手机副屏暗票统计中"
              : loc() === "en-US"
                ? "Live Tally"
                : "实时得票榜"}
          </Text>

          <If
            when={st().voteTallies.length > 0}
            else={
              <Text class="text-stage-muted text-xs">
                {st().rules.surfaceMode === "lan_companion"
                  ? loc() === "en-US"
                    ? `${st().votedSeats.length}/${st().eligibleVoterSeats.length} ballots received`
                    : `已收到 ${st().votedSeats.length}/${st().eligibleVoterSeats.length} 张选票`
                  : loc() === "en-US"
                    ? "No votes cast yet"
                    : "暂未录入有效得票"}
              </Text>
            }
          >
            <Each of={st().voteTallies} key={(item) => item.targetSeat}>
              {(tallyAcc) => {
                const item = () => tallyAcc();
                return (
                  <View class="flex-row items-center justify-between gap-2 rounded-lg bg-ask-bar-bg px-2.5 py-1">
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
          onPress={() => {
            void props.ctx.sendCommand({ type: "finalize_votes" });
          }}
          class="min-h-11 rounded-2xl bg-eye-core items-center justify-center active:opacity-75"
        >
          <Text class="text-stage-bg text-xs font-bold">
            {loc() === "en-US" ? "Finalize Votes" : "结算公布票型"}
          </Text>
        </Button>
      </View>
    </View>
  );
}

function LeaveResolutionDrawerPanel(props: {
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
      if (r === "hunter_shoot") return `Hunter #${act} — Choose Shot Target or Pass`;
      if (r === "sheriff_badge") return `Sheriff #${act} — Pass or Tear Badge`;
      if (r === "white_wolf_explode") return `White Wolf King #${act} — Drag One Player`;
      return `Seat #${act} — Last Words`;
    }
    if (r === "hunter_shoot") return `猎人 #${act} 号离场技能：选择开枪带走目标或压枪`;
    if (r === "sheriff_badge") return `警长 #${act} 号警徽流转：选择移交警徽或撕毁警徽`;
    if (r === "white_wolf_explode") return `白狼王 #${act} 号自爆：指定带走一名存活玩家`;
    return `请 #${act} 号玩家发表遗言`;
  };

  return (
    <View
      testID="werewolf-leave-panel"
      class="flex-1 min-h-0 justify-between gap-2.5"
    >
      <Text class="text-stage-fg text-sm font-bold">{headerText()}</Text>

      <If
        when={reason() !== "last_words"}
        else={
          <View class="flex-1 rounded-2xl border border-stage-pill-border bg-stage-pill-bg px-4 py-3 justify-center">
            <Text class="text-stage-muted text-xs">
              {st().lastJudgeSpeech ||
                (loc() === "en-US"
                  ? "Tap Finish Last Words once the player concludes."
                  : "玩家发言完毕后，点击下方按钮继续游戏流程。")}
            </Text>
          </View>
        }
      >
        <Scroll class="flex-1 min-h-0" contentClass="gap-2">
          <View class="flex-row flex-wrap gap-2">
            <Each of={selectableSeats()} key={(n) => n}>
              {(seatNumAcc) => {
                const num = () => seatNumAcc();
                const picked = () => targetSeat() === num();
                return (
                  <Button
                    testID={`werewolf-leave-target-${num()}`}
                    selected={picked()}
                    onPress={() =>
                      targetSeat.set(picked() ? null : num())
                    }
                    class={
                      picked()
                        ? "min-w-14 min-h-11 px-3 rounded-xl border-2 border-face-amber-edge bg-lighting-bg items-center justify-center active:opacity-80"
                        : "min-w-14 min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-80"
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
                      {`#${num()}`}
                    </Text>
                  </Button>
                );
              }}
            </Each>
          </View>
        </Scroll>
      </If>

      {/* Contextual action bar */}
      <If when={reason() === "hunter_shoot"}>
        <View class="flex-row items-center justify-end gap-2">
          <Button
            testID="werewolf-hunter-skip-btn"
            onPress={() => {
              void props.ctx.sendCommand({
                type: "resolve_hunter_shot",
                targetSeat: null,
              });
            }}
            class="min-h-11 px-4 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
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
            class="min-h-11 px-5 rounded-xl bg-eye-core items-center justify-center active:opacity-75 disabled:opacity-35"
          >
            <Text class="text-stage-bg text-xs font-bold">
              {targetSeat() !== null
                ? loc() === "en-US"
                  ? `Shoot #${targetSeat()}`
                  : `开枪带走 #${targetSeat()}`
                : loc() === "en-US"
                  ? "Select Target"
                  : "请选择开枪目标"}
            </Text>
          </Button>
        </View>
      </If>

      <If when={reason() === "sheriff_badge"}>
        <View class="flex-row items-center justify-end gap-2">
          <Button
            testID="werewolf-sheriff-tear-btn"
            onPress={() => {
              void props.ctx.sendCommand({
                type: "resolve_sheriff_transfer",
                targetSeat: null,
              });
            }}
            class="min-h-11 px-4 rounded-xl border border-face-rose-edge bg-stage-pill-bg items-center justify-center active:opacity-75"
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
            class="min-h-11 px-5 rounded-xl bg-eye-core items-center justify-center active:opacity-75 disabled:opacity-35"
          >
            <Text class="text-stage-bg text-xs font-bold">
              {targetSeat() !== null
                ? loc() === "en-US"
                  ? `Pass Badge to #${targetSeat()}`
                  : `移交警徽给 #${targetSeat()}`
                : loc() === "en-US"
                  ? "Select Heir"
                  : "请选择接任玩家"}
            </Text>
          </Button>
        </View>
      </If>

      <If when={reason() === "white_wolf_explode"}>
        <View class="flex-row items-center justify-end gap-2">
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
            class="min-h-11 px-4 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
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
            class="min-h-11 px-5 rounded-xl bg-eye-core items-center justify-center active:opacity-75 disabled:opacity-35"
          >
            <Text class="text-stage-bg text-xs font-bold">
              {targetSeat() !== null
                ? loc() === "en-US"
                  ? `Drag #${targetSeat()}`
                  : `白狼王带走 #${targetSeat()}`
                : loc() === "en-US"
                  ? "Select Target"
                  : "请选择带人目标"}
            </Text>
          </Button>
        </View>
      </If>

      <If when={reason() === "last_words"}>
        <View class="flex-row items-center justify-end">
          <Button
            testID="werewolf-finish-last-words-btn"
            onPress={() => {
              void props.ctx.sendCommand({ type: "finish_last_words" });
            }}
            class="min-h-11 px-5 rounded-xl bg-eye-core items-center justify-center active:opacity-75"
          >
            <Text class="text-stage-bg text-xs font-bold">
              {loc() === "en-US" ? "Finish Last Words" : "遗言完毕，继续流程"}
            </Text>
          </Button>
        </View>
      </If>
    </View>
  );
}

export function WerewolfStageDrawer(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
  detent: () => StageDrawerDetent;
  requestDetent?: (detent: Exclude<StageDrawerDetent, "closed">) => void;
}) {
  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();
  const confirmAbort = signal(false);
  const confirmExit = signal(false);

  effect(() => {
    const phase = st().phase;
    if (phase === "idle" || phase === "lobby") {
      confirmAbort.set(false);
      confirmExit.set(false);
    }
  });

  effect(() => {
    if (!confirmAbort()) return;
    const timer = setTimeout(() => confirmAbort.set(false), 3200);
    return () => clearTimeout(timer);
  });

  effect(() => {
    if (!confirmExit()) return;
    const timer = setTimeout(() => confirmExit.set(false), 3200);
    return () => clearTimeout(timer);
  });

  const isNightTurn = () => {
    const p = st().phase;
    return (
      p === "night_guard" ||
      p === "night_wolf" ||
      p === "night_witch" ||
      p === "night_seer"
    );
  };

  const isVotingPhase = () => {
    const p = st().phase;
    if (p === "day_voting" || p === "day_pk_voting") return true;
    if (p === "sheriff_election") {
      const sub = st().sheriffSubphase;
      return sub === "voting" || sub === "pk_voting";
    }
    return false;
  };

  const isSpeechToolbarPhase = () => {
    const p = st().phase;
    if (
      p === "dawn_announce" ||
      p === "day_discussion" ||
      p === "day_pk_speech"
    ) {
      return true;
    }
    if (p === "sheriff_election") {
      const sub = st().sheriffSubphase;
      return sub === "speech" || sub === "pk_speech";
    }
    return false;
  };

  const errorBannerText = () => {
    const uiErr = props.ctx.uiError();
    if (uiErr) return uiErr;
    const lastErr = props.ctx.lastError();
    if (lastErr) return `${lastErr.stage}: ${lastErr.reason}`;
    return "";
  };

  return (
    <View testID="werewolf-stage-drawer" class="flex-1 min-h-0 gap-1.5">
      <If when={Boolean(errorBannerText())}>
        <View
          testID="werewolf-drawer-error"
          class="rounded-xl border border-destructive bg-stage-pill-bg px-3 py-1.5"
        >
          <Text class="text-destructive text-xs" style={{ numberOfLines: 1 }}>
            {errorBannerText()}
          </Text>
        </View>
      </If>

      <If when={st().phase === "lobby"}>
        <LobbyDrawerPanel ctx={props.ctx} detent={props.detent} />
      </If>

      <If when={isNightTurn()}>
        <NightRoleDrawerPanel
          ctx={props.ctx}
          detent={props.detent}
          requestDetent={props.requestDetent}
        />
      </If>

      <If
        when={
          st().phase === "sheriff_election" &&
          st().sheriffSubphase === "signup"
        }
      >
        <SheriffSignupDrawerPanel ctx={props.ctx} />
      </If>

      <If when={isSpeechToolbarPhase()}>
        <DaySpeechHostToolbar ctx={props.ctx} detent={props.detent} />
      </If>

      <If when={isVotingPhase()}>
        <VotingDrawerPanel ctx={props.ctx} />
      </If>

      <If when={st().phase === "leave_resolution"}>
        <LeaveResolutionDrawerPanel ctx={props.ctx} />
      </If>

      <If
        when={
          st().phase !== "idle" &&
          st().phase !== "lobby" &&
          props.detent() !== "peek"
        }
      >
        <View
          testID="werewolf-drawer-resilience-bar"
          class="shrink-0 flex-row flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-stage-pill-border"
        >
          <View class="flex-row flex-wrap items-center gap-1.5 flex-1 min-w-0">
            <If
              when={
                st().rules.surfaceMode === "lan_companion" &&
                st().lan.claimedSeats.length > 0
              }
            >
              <Each of={st().lan.claimedSeats} key={(seat) => seat}>
                {(seatAcc) => {
                  const seat = () => seatAcc();
                  return (
                    <Button
                      testID={`werewolf-release-seat-${seat()}`}
                      hitSlop={{ top: 4, bottom: 4, left: 3, right: 3 }}
                      accessibilityLabel={
                        loc() === "en-US"
                          ? `Release seat ${seat()}`
                          : `解绑 ${seat()} 号座位`
                      }
                      onPress={() => {
                        void props.ctx.sendCommand({
                          type: "release_lan_seat",
                          seat: seat(),
                        });
                      }}
                      class="min-h-9 min-w-11 px-2.5 py-1 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
                    >
                      <Text
                        class="text-stage-pill-fg text-xs font-medium"
                        style={{ fontVariant: ["tabular-nums"] }}
                      >
                        {loc() === "en-US"
                          ? `Release #${seat()}`
                          : `#${seat()} 解绑`}
                      </Text>
                    </Button>
                  );
                }}
              </Each>
            </If>
          </View>

          <If when={st().phase !== "game_over"}>
            <View class="flex-row items-center gap-2 shrink-0">
              <Button
                testID="werewolf-abort-match-btn"
                hitSlop={{ top: 4, bottom: 4, left: 3, right: 3 }}
                onPress={() => {
                  if (!confirmAbort()) {
                    confirmExit.set(false);
                    confirmAbort.set(true);
                    return;
                  }
                  confirmAbort.set(false);
                  void props.ctx.sendCommand({ type: "abort_match_to_lobby" });
                }}
                class={
                  confirmAbort()
                    ? "min-h-9 min-w-11 px-3 py-1 rounded-full border border-destructive bg-stage-pill-bg items-center justify-center active:opacity-75"
                    : "min-h-9 min-w-11 px-3 py-1 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
                }
              >
                <Text
                  class={
                    confirmAbort()
                      ? "text-destructive text-xs font-bold"
                      : "text-stage-pill-fg text-xs font-medium"
                  }
                >
                  {confirmAbort()
                    ? loc() === "en-US"
                      ? "Tap Again to Abort"
                      : "再点确认终止"
                    : loc() === "en-US"
                      ? "Abort Match"
                      : "终止本局"}
                </Text>
              </Button>

              <Button
                testID="werewolf-drawer-exit-btn"
                hitSlop={{ top: 4, bottom: 4, left: 3, right: 3 }}
                onPress={() => {
                  if (!confirmExit()) {
                    confirmAbort.set(false);
                    confirmExit.set(true);
                    return;
                  }
                  confirmExit.set(false);
                  void props.ctx.sendCommand({ type: "exit_to_idle" });
                }}
                class={
                  confirmExit()
                    ? "min-h-9 min-w-11 px-3 py-1 rounded-full border border-destructive bg-stage-pill-bg items-center justify-center active:opacity-75"
                    : "min-h-9 min-w-11 px-3 py-1 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
                }
              >
                <Text
                  class={
                    confirmExit()
                      ? "text-destructive text-xs font-bold"
                      : "text-stage-muted text-xs font-medium"
                  }
                >
                  {confirmExit()
                    ? loc() === "en-US"
                      ? "Tap Again to Quit"
                      : "再点确认退出"
                    : loc() === "en-US"
                      ? "Quit Werewolf"
                      : "退出狼人杀"}
                </Text>
              </Button>
            </View>
          </If>
        </View>
      </If>
    </View>
  );
}
