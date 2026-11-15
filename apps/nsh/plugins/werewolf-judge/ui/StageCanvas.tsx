import {
  Canvas,
  createMotion,
  Image,
  reduceMotion,
  Scroll,
  signal,
  Text,
  token,
  View,
} from "nsh";
import { Button } from "nsh/base";
import { LoadingIndicator } from "../../../ui/Controls";
import { DeviceCameraPreview } from "../../../ui/DeviceCameraPreview";
import type { PluginViewContext } from "../../../ui/plugins/ui-contracts";
import {
  WEREWOLF_ROLE_HINTS,
  WEREWOLF_ROLE_LABELS,
  isGodRole,
  isWolfRole,
  type WerewolfCommand,
  type WerewolfPublicState,
  type WerewolfRole,
  type WerewolfSeatPublicView,
} from "../contracts";
import { readWerewolfState } from "./StageCapsule";

const HOLD_THRESHOLD_MS = 220;

function roleFactionTag(
  role: WerewolfRole,
  locale: "zh-CN" | "en-US",
): { label: string; cardClass: string; badgeTextClass: string } {
  if (isWolfRole(role)) {
    return {
      label: locale === "en-US" ? "Werewolf Pack" : "狼人阵营",
      cardClass:
        "rounded-2xl border border-face-rose-edge bg-stage-pill-bg p-3 gap-1.5",
      badgeTextClass: "text-face-rose-core text-xs font-semibold",
    };
  }
  if (isGodRole(role)) {
    return {
      label: locale === "en-US" ? "Priesthood" : "神职阵营",
      cardClass:
        "rounded-2xl border border-face-amber-edge bg-lighting-bg p-3 gap-1.5",
      badgeTextClass: "text-face-amber-core text-xs font-semibold",
    };
  }
  return {
    label: locale === "en-US" ? "Villagers" : "平民阵营",
    cardClass:
      "rounded-2xl border border-face-sage-edge bg-air-quality-bg p-3 gap-1.5",
    badgeTextClass: "text-face-sage-core text-xs font-semibold",
  };
}

function DealingStageCard(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
}) {
  let pressDownAtMs = 0;
  let hadPressDown = false;
  let wasRevealingOnDown = false;
  let holdReleaseConsumed = false;
  const lanLocalDealSeat = signal<number | null>(null);

  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();
  const currentSeatNum = () => st().dealingCurrentSeat;
  const currentSeat = (): WerewolfSeatPublicView | undefined => {
    const num = currentSeatNum();
    if (num === null) return undefined;
    return st().seats.find((s) => s.seat === num);
  };
  const isRevealing = () => {
    const num = currentSeatNum();
    return num !== null && st().dealingRevealingSeat === num;
  };
  const showLanCompanionDealCard = () =>
    st().rules.surfaceMode === "lan_companion" &&
    lanLocalDealSeat() !== currentSeatNum() &&
    !isRevealing();
  const confirmedCount = () =>
    st().seats.filter((s) => s.dealtConfirmed).length;
  const totalCount = () => st().seats.length || st().rules.playerCount;

  const cardEnter = createMotion(
    reduceMotion() ? {} : { enter: "fadeIn", duration: 180 },
  );

  return (
    <View
      testID="werewolf-dealing-panel"
      class="flex-1 min-h-0 rounded-3xl border border-stage-pill-border bg-elevated-glass p-3.5 gap-2.5 justify-between"
      style={{ pointerEvents: "auto", opacity: cardEnter.opacity }}
    >
      {/* Top progress strip: seats 1..N */}
      <View class="flex-row items-center justify-between gap-2">
        <View class="flex-row flex-wrap items-center gap-1.5 flex-1">
          <Each of={st().seats} key={(item) => item.seat}>
            {(seatAcc) => {
              const s = () => seatAcc();
              const isCurrent = () => st().dealingCurrentSeat === s().seat;
              return (
                <View
                  class={
                    isCurrent()
                      ? "px-2 py-0.5 rounded-full border border-face-amber-edge bg-lighting-bg"
                      : s().dealtConfirmed
                        ? "px-2 py-0.5 rounded-full border border-air-quality-border bg-air-quality-bg"
                        : "px-2 py-0.5 rounded-full border border-stage-pill-border bg-stage-pill-bg"
                  }
                >
                  <Text
                    class={
                      isCurrent()
                        ? "text-face-amber-core text-xs font-bold"
                        : s().dealtConfirmed
                          ? "text-face-sage-core text-xs font-semibold"
                          : "text-stage-muted text-xs"
                    }
                    style={{ fontVariant: ["tabular-nums"] }}
                  >
                    {s().dealtConfirmed ? `#${s().seat}✓` : `#${s().seat}`}
                  </Text>
                </View>
              );
            }}
          </Each>
        </View>
        <Text
          class="text-stage-muted text-xs font-medium shrink-0"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {`${confirmedCount()}/${totalCount()}`}
        </Text>
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
            <Text class="text-stage-muted text-xs text-center">
              {loc() === "en-US"
                ? "Everyone please close your eyes to begin Night 1."
                : "请全场玩家闭上双眼，法官即将开启第一夜行动。"}
            </Text>
            <View class="flex-row items-center justify-center gap-2.5">
              <If when={st().canStepBackDeal}>
                <Button
                  testID="werewolf-step-back-deal-btn"
                  onPress={() => {
                    lanLocalDealSeat.set(null);
                    void props.ctx.sendCommand({ type: "step_back_deal" });
                  }}
                  class="min-h-12 px-4 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
                >
                  <Text class="text-stage-pill-fg text-sm font-semibold">
                    {loc() === "en-US" ? "Undo Last" : "重发上一位"}
                  </Text>
                </Button>
              </If>
              <Button
                testID="werewolf-begin-night-btn"
                onPress={() => {
                  void props.ctx.sendCommand({ type: "begin_first_night" });
                }}
                class="min-h-12 px-6 rounded-full bg-eye-core items-center justify-center active:opacity-75"
              >
                <Text class="text-stage-bg text-sm font-bold">
                  {loc() === "en-US"
                    ? "Close Eyes · Enter Night 1"
                    : "天黑请闭眼 · 进入首夜"}
                </Text>
              </Button>
            </View>
          </View>
        }
      >
        <View class="flex-1 min-h-0 flex-row gap-3.5 items-stretch">
          {/* Left column: Camera alignment ring or seat portrait */}
          <View class="w-36 shrink-0 rounded-2xl border border-stage-pill-border bg-stage-pill-bg p-2.5 items-center justify-center gap-2">
            <View
              class={
                st().dealingFaceAligned
                  ? "w-20 h-20 rounded-full border-2 border-face-sage-edge bg-ask-bar-bg overflow-hidden items-center justify-center"
                  : "w-20 h-20 rounded-full border border-stage-pill-border bg-ask-bar-bg overflow-hidden items-center justify-center"
              }
            >
              <If
                when={Boolean(st().previewSessionId)}
                else={
                  <If
                    when={Boolean(currentSeat()?.portraitDataUri)}
                    else={
                      <Text
                        class="text-stage-fg text-xl font-bold"
                        style={{ fontVariant: ["tabular-nums"] }}
                      >
                        {`#${currentSeatNum()}`}
                      </Text>
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

            <Text
              class="text-stage-fg text-xs font-semibold text-center"
              style={{ numberOfLines: 1 }}
            >
              {currentSeat()?.nickname ?? `#${currentSeatNum()}`}
            </Text>

            <If when={Boolean(st().previewSessionId) || st().visionAvailable}>
              <Text
                class={
                  st().dealingFaceAligned
                    ? "text-face-sage-core text-xs font-medium"
                    : "text-stage-muted text-xs"
                }
              >
                {st().dealingFaceAligned
                  ? loc() === "en-US"
                    ? "Face Aligned"
                    : "已正对镜头"
                  : loc() === "en-US"
                    ? "Align Face"
                    : "请正对镜头"}
              </Text>
              <Button
                testID="werewolf-capture-portrait-btn"
                onPress={() => {
                  const seat = currentSeatNum();
                  if (seat === null) return;
                  void props.ctx.sendCommand({
                    type: "capture_seat_portrait",
                    seat,
                  });
                }}
                class="min-h-11 px-3 rounded-xl border border-stage-pill-border bg-elevated-glass items-center justify-center active:opacity-75"
              >
                <Text class="text-stage-pill-fg text-xs font-medium">
                  {loc() === "en-US" ? "Capture Avatar" : "抓拍头像"}
                </Text>
              </Button>
            </If>
          </View>

          {/* Right column: Privacy shield / LAN companion dealing controls */}
          <View class="flex-1 min-w-0 justify-between gap-2.5">
            <If
              when={showLanCompanionDealCard()}
              else={
                <View class="flex-1 min-h-0 justify-between gap-2.5">
                  <If
                    when={
                      isRevealing() && Boolean(currentSeat()?.revealedRole)
                    }
                    else={
                      <View
                        testID="werewolf-deal-masked-card"
                        class="flex-1 rounded-2xl border border-stage-pill-border bg-stage-pill-bg px-4 py-3 items-center justify-center gap-1.5"
                      >
                        <Text class="text-stage-fg text-sm font-bold text-center">
                          {loc() === "en-US"
                            ? `Privacy Shield · Seat #${currentSeatNum()} Only`
                            : `防窥保护中 · 仅限 #${currentSeatNum()} 号查看`}
                        </Text>
                        <Text class="text-stage-muted text-xs text-center">
                          {loc() === "en-US"
                            ? "Hold the shield button to inspect your role; release to mask immediately."
                            : "按住下方防窥盾查看底牌，松手 0ms 瞬时遮蔽"}
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
                          class={`flex-1 justify-center ${tag.cardClass}`}
                        >
                          <View class="flex-row items-center justify-between gap-2">
                            <Text class="text-stage-fg text-lg font-bold">
                              {WEREWOLF_ROLE_LABELS[role][loc()]}
                            </Text>
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

                  <View class="flex-row flex-wrap items-center gap-2">
                    <Button
                      testID="werewolf-deal-reveal-btn"
                      accessibilityLabel={
                        loc() === "en-US"
                          ? "Hold or press to reveal role card"
                          : "按住查看底牌"
                      }
                      onPressDown={() => {
                        const seat = currentSeatNum();
                        if (seat === null) return;
                        hadPressDown = true;
                        wasRevealingOnDown = isRevealing();
                        pressDownAtMs = Date.now();
                        holdReleaseConsumed = false;
                        if (!wasRevealingOnDown) {
                          void props.ctx.sendCommand({
                            type: "set_deal_reveal",
                            seat,
                            revealing: true,
                          });
                        }
                      }}
                      onPressUp={() => {
                        const seat = currentSeatNum();
                        if (seat === null) return;
                        if (
                          pressDownAtMs > 0 &&
                          Date.now() - pressDownAtMs >= HOLD_THRESHOLD_MS
                        ) {
                          holdReleaseConsumed = true;
                          pressDownAtMs = 0;
                          void props.ctx.sendCommand({
                            type: "set_deal_reveal",
                            seat,
                            revealing: false,
                          });
                        }
                      }}
                      onPress={() => {
                        const seat = currentSeatNum();
                        if (seat === null) return;
                        if (holdReleaseConsumed) {
                          holdReleaseConsumed = false;
                          hadPressDown = false;
                          return;
                        }
                        if (hadPressDown) {
                          hadPressDown = false;
                          pressDownAtMs = 0;
                          if (wasRevealingOnDown) {
                            void props.ctx.sendCommand({
                              type: "set_deal_reveal",
                              seat,
                              revealing: false,
                            });
                          }
                          return;
                        }
                        pressDownAtMs = 0;
                        void props.ctx.sendCommand({
                          type: "set_deal_reveal",
                          seat,
                          revealing: !isRevealing(),
                        });
                      }}
                      class={
                        isRevealing()
                          ? "flex-1 min-h-11 px-3 rounded-xl border border-face-amber-edge bg-lighting-bg items-center justify-center active:opacity-80"
                          : "flex-1 min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-80"
                      }
                    >
                      <Text
                        class={
                          isRevealing()
                            ? "text-face-amber-core text-xs font-bold"
                            : "text-stage-fg text-xs font-semibold"
                        }
                      >
                        {isRevealing()
                          ? loc() === "en-US"
                            ? "Release / Tap to Hide"
                            : "松手或点击隐藏底牌"
                          : loc() === "en-US"
                            ? "Hold to Reveal Role"
                            : "按住防窥盾看底牌"}
                      </Text>
                    </Button>

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
                          hadPressDown = false;
                          pressDownAtMs = 0;
                          holdReleaseConsumed = false;
                          if (seat !== null && isRevealing()) {
                            void props.ctx.sendCommand({
                              type: "set_deal_reveal",
                              seat,
                              revealing: false,
                            });
                          }
                          lanLocalDealSeat.set(null);
                        }}
                        class="min-h-11 px-2.5 rounded-xl border border-stage-pill-border bg-elevated-glass items-center justify-center active:opacity-75"
                      >
                        <Text class="text-stage-pill-fg text-xs font-medium">
                          {loc() === "en-US" ? "LAN Wait" : "返回副屏"}
                        </Text>
                      </Button>
                    </If>

                    <If when={isRevealing()}>
                      <Button
                        testID="werewolf-deal-hide-btn"
                        onPressDown={() => {
                          const seat = currentSeatNum();
                          if (seat === null) return;
                          void props.ctx.sendCommand({
                            type: "set_deal_reveal",
                            seat,
                            revealing: false,
                          });
                        }}
                        onPress={() => {
                          const seat = currentSeatNum();
                          if (seat === null) return;
                          void props.ctx.sendCommand({
                            type: "set_deal_reveal",
                            seat,
                            revealing: false,
                          });
                        }}
                        class="min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
                      >
                        <Text class="text-stage-pill-fg text-xs font-medium">
                          {loc() === "en-US" ? "Hide" : "遮蔽"}
                        </Text>
                      </Button>
                    </If>

                    <If when={st().canStepBackDeal}>
                      <Button
                        testID="werewolf-step-back-deal-btn"
                        onPress={() => {
                          pressDownAtMs = 0;
                          hadPressDown = false;
                          holdReleaseConsumed = false;
                          lanLocalDealSeat.set(null);
                          void props.ctx.sendCommand({ type: "step_back_deal" });
                        }}
                        class="min-h-11 px-2.5 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
                      >
                        <Text class="text-stage-pill-fg text-xs font-medium">
                          {loc() === "en-US" ? "Prev" : "重发上一位"}
                        </Text>
                      </Button>
                    </If>

                    <Button
                      testID="werewolf-deal-confirm-btn"
                      onPress={() => {
                        const seat = currentSeatNum();
                        if (seat === null) return;
                        pressDownAtMs = 0;
                        hadPressDown = false;
                        holdReleaseConsumed = false;
                        lanLocalDealSeat.set(null);
                        void props.ctx.sendCommand({
                          type: "confirm_seat_dealt",
                          seat,
                        });
                      }}
                      class="min-h-11 px-3.5 rounded-xl bg-eye-core items-center justify-center active:opacity-75"
                    >
                      <Text class="text-stage-bg text-xs font-bold">
                        {loc() === "en-US" ? "Got It · Next" : "记住了，下一位"}
                      </Text>
                    </Button>
                  </View>
                </View>
              }
            >
              {/* LAN Companion dealing progress & host fallback */}
              <View class="flex-1 rounded-2xl border border-stage-pill-border bg-stage-pill-bg p-3.5 justify-center gap-1.5">
                <Text class="text-stage-fg text-sm font-bold">
                  {loc() === "en-US"
                    ? `Companion Dealing · Waiting for #${currentSeatNum()}`
                    : `手机副屏领牌中 · 当前环视 #${currentSeatNum()} 号`}
                </Text>
                <Text class="text-stage-muted text-xs">
                  {loc() === "en-US"
                    ? "Players inspect roles privately on their phones. Use host confirm if a seat has no phone."
                    : "每位玩家在各自手机副屏查看身份并确认；如遇无手机玩家可由主机代为确认。"}
                </Text>
              </View>
              <View class="flex-row flex-wrap items-center justify-end gap-2">
                <If when={st().canStepBackDeal}>
                  <Button
                    testID="werewolf-step-back-deal-btn"
                    onPress={() => {
                      lanLocalDealSeat.set(null);
                      void props.ctx.sendCommand({ type: "step_back_deal" });
                    }}
                    class="min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
                  >
                    <Text class="text-stage-pill-fg text-xs font-medium">
                      {loc() === "en-US" ? "Prev" : "重发上一位"}
                    </Text>
                  </Button>
                </If>
                <Button
                  testID="werewolf-lan-local-deal-btn"
                  onPress={() => lanLocalDealSeat.set(currentSeatNum())}
                  class="min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
                >
                  <Text class="text-stage-pill-fg text-xs font-semibold">
                    {loc() === "en-US" ? "Local Reveal" : "本机查牌"}
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
                  class="min-h-11 px-3.5 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
                >
                  <Text class="text-stage-pill-fg text-xs font-semibold">
                    {loc() === "en-US"
                      ? `Confirm #${currentSeatNum()}`
                      : `代 #${currentSeatNum()} 确认`}
                  </Text>
                </Button>
                <Button
                  testID="werewolf-begin-night-btn"
                  onPress={() => {
                    void props.ctx.sendCommand({ type: "begin_first_night" });
                  }}
                  class="min-h-11 px-4 rounded-xl bg-eye-core items-center justify-center active:opacity-75"
                >
                  <Text class="text-stage-bg text-xs font-bold">
                    {loc() === "en-US" ? "Begin Night 1" : "全员进入首夜"}
                  </Text>
                </Button>
              </View>
            </If>
          </View>
        </View>
      </If>
    </View>
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

  return (
    <View
      testID="werewolf-tabletop-stage"
      class="flex-1 min-h-0 rounded-3xl border border-stage-pill-border bg-elevated-glass p-3 justify-between gap-2"
      style={{ pointerEvents: "auto" }}
    >
      {/* Top Row: Judge subtitle + central timer status */}
      <View class="flex-row items-center justify-between gap-2.5">
        <View class="flex-1 min-w-0 flex-row items-center gap-2">
          <View class="w-1.5 h-4 rounded-full bg-face-amber-core shrink-0" />
          <Text
            testID="werewolf-judge-subtitle"
            class="text-stage-fg text-xs font-medium flex-1"
            style={{ numberOfLines: 1 }}
          >
            {st().voiceStatus.lastSpokenText ||
              st().lastJudgeSpeech ||
              (loc() === "en-US"
                ? "Daytime discussion in progress"
                : "请按顺序轮流发言")}
          </Text>
          <If when={st().voiceStatus.degradedToSubtitles}>
            <Text
              testID="werewolf-voice-degraded-badge"
              class="text-warning text-xs font-semibold shrink-0"
            >
              {loc() === "en-US" ? "Subtitles Only" : "语音异常已转字幕"}
            </Text>
          </If>
        </View>

        <If when={st().speakingSeat !== null}>
          <View class="flex-row items-center gap-2 px-2.5 py-1 rounded-full border border-stage-pill-border bg-stage-pill-bg shrink-0">
            <Canvas
              testID="werewolf-speaker-arc"
              class="w-6 h-6"
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
                  ? "text-warning text-xs font-bold"
                  : "text-stage-fg text-xs font-bold"
              }
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {`#${st().speakingSeat} · ${
                st().timerPaused
                  ? loc() === "en-US"
                    ? "Paused"
                    : "暂停"
                  : `${st().speakingRemainingSec}s`
              }`}
            </Text>
          </View>
        </If>
      </View>

      {/* Dawn Announce Banner if paused on dawn_announce */}
      <If when={st().phase === "dawn_announce"}>
        <View
          testID="werewolf-dawn-banner"
          class="rounded-2xl border border-lighting-border bg-lighting-bg px-3.5 py-2.5 flex-row items-center justify-between gap-3"
        >
          <Text class="text-face-amber-core text-xs font-semibold flex-1">
            {st().dawnDeathsToday.length === 0
              ? loc() === "en-US"
                ? "Peaceful Night — no casualties."
                : "昨晚是平安夜，无人倒牌。"
              : loc() === "en-US"
                ? `Fallen last night: ${st()
                    .dawnDeathsToday.map((n) => `#${n}`)
                    .join(", ")}`
                : `昨晚倒牌玩家：${st()
                    .dawnDeathsToday.map((n) => `#${n}`)
                    .join("、")}`}
          </Text>
          <Button
            testID="werewolf-ack-dawn-btn"
            onPress={() => {
              void props.ctx.sendCommand({ type: "acknowledge_dawn" });
            }}
            class="min-h-11 px-3.5 rounded-xl bg-eye-core items-center justify-center active:opacity-75"
          >
            <Text class="text-stage-bg text-xs font-bold">
              {loc() === "en-US" ? "Continue" : "继续流程"}
            </Text>
          </Button>
        </View>
      </If>

      {/* Tabletop Seat Matrix (clean 2-row responsive ring layout for 6..12 seats) */}
      <Scroll class="flex-1 min-h-0" contentClass="gap-2 justify-center">
        <View class="flex-row flex-wrap gap-2">
          <Each of={st().seats} key={(item) => item.seat}>
            {(seatAcc) => {
              const s = () => seatAcc();
              const isSpeaking = () => st().speakingSeat === s().seat;
              const isPk = () => st().pkCandidates.includes(s().seat);
              return (
                <View
                  testID={`werewolf-table-seat-${s().seat}`}
                  class={
                    !s().alive
                      ? "w-28 min-h-12 rounded-2xl border border-stage-pill-border bg-stage-pill-bg px-2.5 py-1.5 flex-row items-center gap-2"
                      : isSpeaking()
                        ? "w-28 min-h-12 rounded-2xl border-2 border-face-amber-edge bg-lighting-bg px-2.5 py-1.5 flex-row items-center gap-2"
                        : isPk()
                          ? "w-28 min-h-12 rounded-2xl border border-warning bg-stage-pill-bg px-2.5 py-1.5 flex-row items-center gap-2"
                          : "w-28 min-h-12 rounded-2xl border border-stage-pill-border bg-ask-bar-bg px-2.5 py-1.5 flex-row items-center gap-2"
                  }
                  style={{ opacity: s().alive ? 1 : 0.45 }}
                >
                  <View class="w-7 h-7 rounded-full border border-stage-pill-border bg-stage-pill-bg overflow-hidden items-center justify-center shrink-0">
                    <If
                      when={Boolean(s().portraitDataUri)}
                      else={
                        <Text
                          class="text-stage-fg text-xs font-bold"
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

                  <View class="flex-1 min-w-0 gap-0.5">
                    <View class="flex-row items-center justify-between gap-1">
                      <Text
                        class="text-stage-fg text-xs font-semibold flex-1"
                        style={{
                          fontVariant: ["tabular-nums"],
                          numberOfLines: 1,
                        }}
                      >
                        {`#${s().seat}`}
                      </Text>
                      <If when={s().isSheriff}>
                        <Text class="text-face-amber-core text-xs font-bold">
                          {loc() === "en-US" ? "★" : "警"}
                        </Text>
                      </If>
                    </View>
                    <Text
                      class={
                        !s().alive
                          ? "text-stage-muted text-xs"
                          : isSpeaking()
                            ? "text-face-amber-core text-xs font-semibold"
                            : s().idiotRevealed
                              ? "text-face-amber-core text-xs"
                              : s().isCandidate
                                ? "text-face-mist-core text-xs"
                                : "text-stage-muted text-xs"
                      }
                      style={{ numberOfLines: 1 }}
                    >
                      {!s().alive
                        ? loc() === "en-US"
                          ? "Out"
                          : "已出局"
                        : isSpeaking()
                          ? loc() === "en-US"
                            ? "Speaking"
                            : "发言中"
                          : s().idiotRevealed
                            ? loc() === "en-US"
                              ? "Idiot"
                              : "白痴翻牌"
                            : isPk()
                              ? "PK"
                              : s().isCandidate
                                ? loc() === "en-US"
                                  ? "Candidate"
                                  : "警上候选"
                                : loc() === "en-US"
                                  ? "Alive"
                                  : "在座"}
                    </Text>
                  </View>
                </View>
              );
            }}
          </Each>
        </View>
      </Scroll>
    </View>
  );
}

function GameOverStage(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
}) {
  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();
  const revealMotion = createMotion(
    reduceMotion() ? {} : { enter: "fadeIn", duration: 220 },
  );

  const goodWon = () => st().winner === "good";

  return (
    <Scroll
      testID="werewolf-gameover-panel"
      class="flex-1 min-h-0 rounded-3xl border border-stage-pill-border bg-elevated-glass"
      contentClass="p-3.5 gap-3"
      style={{ pointerEvents: "auto", opacity: revealMotion.opacity }}
    >
      {/* 1. Winner Hero Banner + Primary Actions */}
      <View
        testID="werewolf-winner-banner"
        class={
          goodWon()
            ? "rounded-2xl border border-face-sage-edge bg-air-quality-bg p-3 flex-row items-center justify-between gap-3"
            : "rounded-2xl border border-face-rose-edge bg-stage-pill-bg p-3 flex-row items-center justify-between gap-3"
        }
      >
        <View class="flex-1 min-w-0 gap-0.5">
          <Text
            class={
              goodWon()
                ? "text-face-sage-core text-base font-bold"
                : "text-face-rose-core text-base font-bold"
            }
          >
            {goodWon()
              ? loc() === "en-US"
                ? "Villagers & Priesthood Victory"
                : "好人阵营获胜"
              : loc() === "en-US"
                ? "Werewolf Pack Victory"
                : "狼人阵营获胜"}
          </Text>
          <If when={Boolean(st().winReason)}>
            <Text class="text-stage-fg text-xs" style={{ numberOfLines: 2 }}>
              {st().winReason}
            </Text>
          </If>
        </View>

        <View class="flex-row items-center gap-2 shrink-0">
          <Button
            testID="werewolf-back-lobby-btn"
            onPress={() => {
              void props.ctx.sendCommand({ type: "open_lobby" });
            }}
            class="min-h-11 px-3 rounded-xl border border-stage-pill-border bg-ask-bar-bg items-center justify-center active:opacity-75"
          >
            <Text class="text-stage-pill-fg text-xs font-medium">
              {loc() === "en-US" ? "Lobby" : "调整板子"}
            </Text>
          </Button>
          <Button
            testID="werewolf-play-again-btn"
            onPress={() => {
              void props.ctx.sendCommand({ type: "play_again" });
            }}
            class="min-h-11 px-4 rounded-xl bg-eye-core items-center justify-center active:opacity-75"
          >
            <Text class="text-stage-bg text-xs font-bold">
              {loc() === "en-US" ? "Play Again" : "再来一局"}
            </Text>
          </Button>
        </View>
      </View>

      {/* 2. True Role Reveal Grid */}
      <View testID="werewolf-role-reveal-grid" class="gap-1.5">
        <Text class="text-stage-pill-fg text-xs font-bold">
          {loc() === "en-US" ? "Full Deck Reveal" : "全员底牌揭晓"}
        </Text>
        <View class="flex-row flex-wrap gap-2">
          <Each of={st().seats} key={(item) => item.seat}>
            {(seatAcc) => {
              const s = () => seatAcc();
              const role = () => s().revealedRole;
              const roleLabel = () => {
                const r = role();
                return r ? WEREWOLF_ROLE_LABELS[r][loc()] : "?";
              };
              const roleTextClass = () => {
                const r = role();
                if (!r) return "text-stage-muted text-xs font-semibold";
                if (isWolfRole(r)) {
                  return "text-face-rose-core text-xs font-bold";
                }
                if (isGodRole(r)) {
                  return "text-face-amber-core text-xs font-bold";
                }
                return "text-face-sage-core text-xs font-semibold";
              };
              return (
                <View class="w-36 rounded-xl border border-stage-pill-border bg-ask-bar-bg px-2.5 py-2 gap-0.5">
                  <View class="flex-row items-center justify-between gap-1">
                    <Text
                      class="text-stage-fg text-xs font-semibold"
                      style={{ fontVariant: ["tabular-nums"] }}
                    >
                      {`#${s().seat}${s().isSheriff ? " ★" : ""}`}
                    </Text>
                    <Text class={roleTextClass()}>{roleLabel()}</Text>
                  </View>
                  <Text
                    class="text-stage-muted text-xs"
                    style={{ numberOfLines: 1 }}
                  >
                    {s().alive
                      ? loc() === "en-US"
                        ? "Survived"
                        : "存活至终局"
                      : loc() === "en-US"
                        ? `Out Day ${s().deathDay ?? "?"}`
                        : `第${s().deathDay ?? "?"}天出局`}
                  </Text>
                </View>
              );
            }}
          </Each>
        </View>
      </View>

      {/* 3. AI Judge MVP Commentary Card */}
      <View
        testID="werewolf-mvp-card"
        class="rounded-2xl border border-stage-pill-border bg-ask-bar-bg p-3 gap-2"
      >
        <View class="flex-row items-center justify-between gap-2">
          <Text class="text-face-amber-core text-xs font-bold">
            {loc() === "en-US"
              ? "AI Judge Match Review & MVP"
              : "AI 法官全场复盘与 MVP"}
          </Text>
          <Button
            testID="werewolf-regen-mvp-btn"
            disabled={st().aiMvpReview.status === "generating"}
            onPress={() => {
              void props.ctx.sendCommand({ type: "regenerate_mvp_review" });
            }}
            class="min-h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75 disabled:opacity-40"
          >
            <Text class="text-stage-pill-fg text-xs font-medium">
              {st().aiMvpReview.status === "ready"
                ? loc() === "en-US"
                  ? "Refresh Review"
                  : "重新点评"
                : loc() === "en-US"
                  ? "Generate MVP"
                  : "生成点评"}
            </Text>
          </Button>
        </View>

        <If when={st().aiMvpReview.status === "generating"}>
          <LoadingIndicator
            testID="werewolf-mvp-loading"
            label={
              loc() === "en-US"
                ? "AI Judge is reviewing the match..."
                : "AI 法官正在复盘关键回合与全场 MVP…"
            }
          />
        </If>

        <If
          when={
            st().aiMvpReview.status === "ready" &&
            Boolean(st().aiMvpReview.text)
          }
        >
          <Text testID="werewolf-mvp-text" class="text-stage-fg text-xs">
            {st().aiMvpReview.text}
          </Text>
        </If>

        <If
          when={
            st().aiMvpReview.status === "failed" &&
            Boolean(st().aiMvpReview.error)
          }
        >
          <Text testID="werewolf-mvp-error" class="text-destructive text-xs">
            {st().aiMvpReview.error}
          </Text>
        </If>

        <If when={st().aiMvpReview.status === "idle"}>
          <Text class="text-stage-muted text-xs">
            {loc() === "en-US"
              ? "Tap Generate MVP to request an AI Judge post-game commentary."
              : "对局已归档，可点击右上角生成 AI 法官高光复盘。"}
          </Text>
        </If>
      </View>

      {/* 4. Full Night/Day Truth Timeline */}
      <If when={st().fullTimelineReveal.length > 0}>
        <View testID="werewolf-truth-timeline" class="gap-1.5">
          <Text class="text-stage-pill-fg text-xs font-bold">
            {loc() === "en-US"
              ? "Night & Day Truth Log"
              : "全量真实夜行动时间轴"}
          </Text>
          <Each
            of={st().fullTimelineReveal}
            key={(_, idx) => `${idx}`}
          >
            {(entryAcc) => {
              const item = () => entryAcc();
              return (
                <View class="flex-row items-start gap-2 rounded-xl bg-stage-pill-bg px-2.5 py-1.5">
                  <Text
                    class="text-face-mist-core text-xs font-semibold shrink-0"
                    style={{ fontVariant: ["tabular-nums"] }}
                  >
                    {loc() === "en-US" ? `D${item().day}` : `第${item().day}天`}
                  </Text>
                  <Text class="text-stage-fg text-xs flex-1">
                    {item().summary}
                  </Text>
                </View>
              );
            }}
          </Each>
        </View>
      </If>
    </Scroll>
  );
}

export function WerewolfStageCanvas(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
}) {
  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();

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

  const subtitleText = () =>
    st().voiceStatus.lastSpokenText || st().lastJudgeSpeech;

  const showFloatingJudgeSubtitle = () => {
    const p = st().phase;
    return (
      p !== "idle" &&
      p !== "lobby" &&
      p !== "dealing" &&
      p !== "game_over" &&
      !isSplitDayTable() &&
      Boolean(subtitleText())
    );
  };

  return (
    <View class="flex-1 min-h-0" style={{ pointerEvents: "box-none" }}>
      <If when={st().phase === "dealing"}>
        <DealingStageCard ctx={props.ctx} />
      </If>

      <If when={isSplitDayTable()}>
        <TabletopRingStage ctx={props.ctx} />
      </If>

      <If when={st().phase === "game_over"}>
        <GameOverStage ctx={props.ctx} />
      </If>

      <If when={showFloatingJudgeSubtitle()}>
        <View
          class="flex-1 justify-end items-center pb-14"
          style={{ pointerEvents: "none" }}
        >
          <View class="rounded-full border border-stage-pill-border bg-glass-bg px-4 py-2 flex-row items-center gap-2 max-w-full">
            <If when={st().voiceStatus.degradedToSubtitles}>
              <Text
                testID="werewolf-voice-degraded-badge"
                class="text-warning text-xs font-semibold shrink-0"
              >
                {loc() === "en-US" ? "Subtitles" : "字幕降级"}
              </Text>
            </If>
            <Text
              testID="werewolf-night-subtitle"
              class="text-stage-muted text-xs font-medium shrink"
              style={{ numberOfLines: 1 }}
            >
              {subtitleText()}
            </Text>
          </View>
        </View>
      </If>
    </View>
  );
}
