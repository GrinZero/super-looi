import { Clipboard, effect, Scroll, signal, Text, View, windowSize } from "nsh";
import { Button } from "nsh/base";
import {
  ActionButton,
  SelectField,
  SwitchRow,
} from "../../../ui/Controls";
import { PluginVectorIcon } from "../../../ui/plugins/PluginVectorIcon";
import type { PluginViewContext } from "../../../ui/plugins/ui-contracts";
import {
  WEREWOLF_PHASE_LABELS,
  WEREWOLF_PRESET_LABELS,
  WEREWOLF_ROLES,
  WEREWOLF_ROLE_LABELS,
  isGodRole,
  isWolfRole,
  type WerewolfCommand,
  type WerewolfMotionMode,
  type WerewolfPresetId,
  type WerewolfPublicState,
  type WerewolfRole,
  type WerewolfSurfaceMode,
  type WerewolfWinMode,
  type WerewolfWitchSelfSaveMode,
} from "../contracts";
import { QrCodeCanvas } from "./QrCodeCanvas";
import { readWerewolfState } from "./StageCapsule";
import { WerewolfRoleIcon } from "./WerewolfIcons";

const SINGLETON_ROLES: ReadonlySet<WerewolfRole> = new Set([
  "white_wolf_king",
  "seer",
  "witch",
  "hunter",
  "guard",
  "idiot",
]);

export function WerewolfSettingsView(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
}) {
  const wide = () => windowSize().width >= 600;
  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();
  const enabled = () => props.ctx.enabled();
  const busy = () => props.ctx.busy();
  const confirmReset = signal(false);

  effect(() => {
    if (st().phase === "idle") {
      confirmReset.set(false);
    }
  });

  effect(() => {
    if (!confirmReset()) return;
    const timer = setTimeout(() => confirmReset.set(false), 3200);
    return () => clearTimeout(timer);
  });

  const editableDeck = () => {
    const p = st().phase;
    return p === "idle" || p === "lobby" || p === "game_over";
  };

  const statusDotClass = () => {
    if (!enabled()) return "w-2 h-2 rounded-full bg-subtle-text";
    if (st().phase === "idle") return "w-2 h-2 rounded-full bg-subtle-text";
    if (st().hostPaused) return "w-2 h-2 rounded-full bg-warning";
    return "w-2 h-2 rounded-full bg-verified";
  };

  const errorText = () => {
    const uiErr = props.ctx.uiError();
    if (uiErr) return uiErr;
    const lastErr = props.ctx.lastError();
    if (lastErr) {
      return `${lastErr.stage}${lastErr.code ? ` [${lastErr.code}]` : ""}: ${lastErr.reason}`;
    }
    return "";
  };

  const roleTotalSum = () =>
    WEREWOLF_ROLES.reduce(
      (sum, role) => sum + (st().rules.roleCounts[role] ?? 0),
      0,
    );

  const wolfSum = () =>
    WEREWOLF_ROLES.reduce(
      (sum, role) => sum + (isWolfRole(role) ? (st().rules.roleCounts[role] ?? 0) : 0),
      0,
    );

  const godSum = () =>
    WEREWOLF_ROLES.reduce(
      (sum, role) => sum + (isGodRole(role) ? (st().rules.roleCounts[role] ?? 0) : 0),
      0,
    );

  const villagerSum = () => st().rules.roleCounts.villager ?? 0;

  return (
    <View
      testID="werewolf-settings-view"
      class={
        wide()
          ? "flex-1 min-h-0 flex-row gap-3.5"
          : "flex-1 min-h-0 gap-3"
      }
    >
      {/* Left Card: Match Launch CTA + Preset & Custom Role Stepper */}
      <View class="flex-1 min-w-0 min-h-0 rounded-2xl border border-border bg-card overflow-hidden">
        <Scroll class="flex-1 min-h-0" contentClass="p-3.5 gap-3">
          {/* 1. Stage Launch Header */}
          <View class="gap-2">
            <If when={st().hasResumableMatch}>
              <View
                testID="werewolf-settings-resumable-banner"
                class="rounded-xl border border-air-quality-border bg-air-quality-bg px-3 py-2 flex-row items-center gap-2"
              >
                <View class="w-2 h-2 rounded-full bg-verified shrink-0" />
                <Text class="text-foreground text-xs font-semibold flex-1">
                  {loc() === "en-US"
                    ? "Match in progress · Return to the tabletop stage anytime"
                    : "对局进行中 · 可随时返回首屏舞台继续"}
                </Text>
              </View>
            </If>

            <View class="flex-row items-center justify-between gap-2.5 flex-wrap">
              <View class="flex-row items-center gap-2 min-w-0 flex-1">
                <View class={statusDotClass()} />
                <Text
                  testID="werewolf-settings-phase"
                  class="text-muted-foreground text-xs font-medium flex-1"
                  style={{ numberOfLines: 1 }}
                >
                  {!enabled()
                    ? loc() === "en-US"
                      ? "Plugin Disabled"
                      : "插件未启用"
                    : `${WEREWOLF_PHASE_LABELS[st().phase][loc()]}${
                        st().hostPaused
                          ? loc() === "en-US"
                            ? " (Paused)"
                            : "（舞台已挂起）"
                          : ""
                      }`}
                </Text>
              </View>

              <View class="flex-row items-center gap-2 shrink-0">
                <If when={st().phase !== "idle"}>
                  <ActionButton
                    testID="werewolf-exit-idle-btn"
                    compact
                    kind="danger"
                    disabled={!enabled() || busy()}
                    label={
                      st().hasResumableMatch && confirmReset()
                        ? loc() === "en-US"
                          ? "Tap Again to End"
                          : "再点确认结束对局"
                        : loc() === "en-US"
                          ? "End Match"
                          : "结束重置当前对局"
                    }
                    onPress={() => {
                      if (st().hasResumableMatch && !confirmReset()) {
                        confirmReset.set(true);
                        return;
                      }
                      confirmReset.set(false);
                      void props.ctx.sendCommand({ type: "exit_to_idle" });
                    }}
                  />
                </If>

                <ActionButton
                  testID="werewolf-launch-stage-btn"
                  compact
                  kind="primary"
                  disabled={!enabled() || busy()}
                  label={
                    st().phase === "idle"
                      ? loc() === "en-US"
                        ? "Launch Stage"
                        : "登上首屏开局"
                      : st().hasResumableMatch
                        ? loc() === "en-US"
                          ? "Resume Stage"
                          : "返回舞台"
                        : loc() === "en-US"
                          ? "Resume Stage"
                          : "回到牌局舞台"
                  }
                  onPress={() => {
                    const cmd: WerewolfCommand =
                      st().phase === "idle"
                        ? { type: "open_lobby" }
                        : { type: "resume_stage" };
                    void props.ctx.sendCommand(cmd).then(() => {
                      if (!props.ctx.uiError()) {
                        props.ctx.openStage();
                      }
                    });
                  }}
                />
              </View>
            </View>

            <If when={Boolean(errorText())}>
              <View class="rounded-xl bg-muted border border-destructive px-3 py-2">
                <Text
                  testID="werewolf-settings-error"
                  class="text-destructive text-xs"
                >
                  {errorText()}
                </Text>
              </View>
            </If>
          </View>

          <View class="h-px bg-border" />

          {/* 2. Preset & Custom Deck Fine-Tuning */}
          <View class="gap-2">
            <View class="flex-row items-center justify-between gap-2">
              <Text class="text-foreground text-sm font-bold" role="header">
                {loc() === "en-US" ? "Board & Role Deck" : "板子与身份配比"}
              </Text>
              <Text
                testID="werewolf-settings-player-count"
                class={
                  roleTotalSum() === st().rules.playerCount &&
                  st().rules.playerCount >= 6 &&
                  st().rules.playerCount <= 12
                    ? "text-muted-foreground text-xs font-semibold"
                    : "text-destructive text-xs font-semibold"
                }
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {loc() === "en-US"
                  ? `${roleTotalSum()} / ${st().rules.playerCount} Players`
                  : `共 ${roleTotalSum()} 人（支持 6–12 人）`}
              </Text>
            </View>

            <SelectField<WerewolfPresetId>
              testID="werewolf-settings-preset"
              compact
              disabled={!enabled() || !editableDeck()}
              label={loc() === "en-US" ? "Board Preset" : "预设板子"}
              value={st().rules.presetId}
              items={[
                {
                  value: "6p_joy",
                  title: WEREWOLF_PRESET_LABELS["6p_joy"][loc()],
                },
                {
                  value: "9p_standard",
                  title: WEREWOLF_PRESET_LABELS["9p_standard"][loc()],
                },
                {
                  value: "12p_guard",
                  title: WEREWOLF_PRESET_LABELS["12p_guard"][loc()],
                },
                {
                  value: "12p_idiot",
                  title: WEREWOLF_PRESET_LABELS["12p_idiot"][loc()],
                },
                {
                  value: "custom",
                  title: WEREWOLF_PRESET_LABELS.custom[loc()],
                },
              ]}
              onChange={(presetId) => {
                void props.ctx.sendCommand({
                  type: "select_preset",
                  presetId,
                });
              }}
            />

            <Text
              testID="werewolf-settings-faction-summary"
              class="text-muted-foreground text-xs font-medium"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {loc() === "en-US"
                ? `${wolfSum()} Wolf · ${godSum()} God · ${villagerSum()} Villager`
                : `${wolfSum()} 狼 · ${godSum()} 神 · ${villagerSum()} 民`}
            </Text>

            <View class="rounded-xl border border-border bg-card overflow-hidden">
              <Each of={WEREWOLF_ROLES} key={(r) => r}>
                {(roleAcc) => {
                  const role = () => roleAcc();
                  const count = () => st().rules.roleCounts[role()] ?? 0;
                  const maxAllowed = () =>
                    SINGLETON_ROLES.has(role()) ? 1 : 8;
                  const factionHint = () => {
                    const r = role();
                    if (isWolfRole(r)) {
                      return loc() === "en-US" ? "Wolf" : "狼人";
                    }
                    if (isGodRole(r)) {
                      return loc() === "en-US" ? "God" : "神职";
                    }
                    return loc() === "en-US" ? "Good" : "平民";
                  };
                  const isLast = () =>
                    role() === WEREWOLF_ROLES[WEREWOLF_ROLES.length - 1];

                  return (
                    <View
                      class={
                        isLast()
                          ? "min-h-11 px-3 py-1 flex-row items-center justify-between gap-2"
                          : "min-h-11 px-3 py-1 border-b border-border flex-row items-center justify-between gap-2"
                      }
                    >
                      <View class="flex-row items-center gap-2 flex-1 min-w-0">
                        <WerewolfRoleIcon
                          role={role()}
                          tone={count() > 0 ? "foreground" : "muted"}
                          size={18}
                        />
                        <Text
                          class="text-foreground text-xs font-semibold"
                          style={{ numberOfLines: 1 }}
                        >
                          {WEREWOLF_ROLE_LABELS[role()][loc()]}
                        </Text>
                        <If when={role() !== "werewolf" && role() !== "villager"}>
                          <Text class="text-muted-foreground text-xs">
                            {`· ${factionHint()}`}
                          </Text>
                        </If>
                      </View>

                      <View class="flex-row items-center gap-1.5 shrink-0">
                        <Button
                          testID={`werewolf-role-dec-${role()}`}
                          hitSlop={6}
                          disabled={
                            !enabled() || !editableDeck() || count() <= 0
                          }
                          accessibilityLabel={
                            loc() === "en-US"
                              ? `Decrease ${WEREWOLF_ROLE_LABELS[role()][loc()]}`
                              : `减少${WEREWOLF_ROLE_LABELS[role()][loc()]}数量`
                          }
                          onPress={() => {
                            void props.ctx.sendCommand({
                              type: "set_role_count",
                              role: role(),
                              count: Math.max(0, count() - 1),
                            });
                          }}
                          class="w-8 h-8 rounded-lg border border-border bg-muted items-center justify-center hover:bg-accent transition-colors duration-150 active:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-35"
                        >
                          <Text class="text-foreground text-base font-bold">
                            −
                          </Text>
                        </Button>

                        <Text
                          testID={`werewolf-role-count-${role()}`}
                          class="w-6 text-center text-foreground text-sm font-bold"
                          style={{ fontVariant: ["tabular-nums"] }}
                        >
                          {String(count())}
                        </Text>

                        <Button
                          testID={`werewolf-role-inc-${role()}`}
                          hitSlop={6}
                          disabled={
                            !enabled() ||
                            !editableDeck() ||
                            count() >= maxAllowed()
                          }
                          accessibilityLabel={
                            loc() === "en-US"
                              ? `Increase ${WEREWOLF_ROLE_LABELS[role()][loc()]}`
                              : `增加${WEREWOLF_ROLE_LABELS[role()][loc()]}数量`
                          }
                          onPress={() => {
                            void props.ctx.sendCommand({
                              type: "set_role_count",
                              role: role(),
                              count: Math.min(maxAllowed(), count() + 1),
                            });
                          }}
                          class="w-8 h-8 rounded-lg border border-border bg-muted items-center justify-center hover:bg-accent transition-colors duration-150 active:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-35"
                        >
                          <Text class="text-foreground text-base font-bold">
                            +
                          </Text>
                        </Button>
                      </View>
                    </View>
                  );
                }}
              </Each>
            </View>
          </View>
        </Scroll>
      </View>

      {/* Right Card: Rules Toggles + Vision Dependency + LAN Room */}
      <View class="flex-1 min-w-0 min-h-0 rounded-2xl border border-border bg-card overflow-hidden">
        <Scroll class="flex-1 min-h-0" contentClass="p-3.5 gap-3">
          {/* 1. Rules & Choreography */}
          <View class="gap-2.5">
            <Text class="text-foreground text-sm font-bold" role="header">
              {loc() === "en-US"
                ? "Match Rules & Choreography"
                : "竞赛规则与具身编排"}
            </Text>

            <View class={wide() ? "flex-row items-end gap-2.5" : "gap-2.5"}>
              <View class={wide() ? "flex-1 min-w-0" : ""}>
                <SelectField<WerewolfSurfaceMode>
                  testID="werewolf-settings-surface"
                  compact
                  disabled={!enabled() || !editableDeck()}
                  label={loc() === "en-US" ? "Player Surface" : "交互形态"}
                  value={st().rules.surfaceMode}
                  items={[
                    {
                      value: "on_device",
                      title:
                        loc() === "en-US"
                          ? "On-Device Shield"
                          : "本机防窥",
                    },
                    {
                      value: "lan_companion",
                      title:
                        loc() === "en-US"
                          ? "LAN QR Companion"
                          : "手机扫码副屏",
                    },
                  ]}
                  onChange={(surfaceMode) => {
                    void props.ctx.sendCommand({
                      type: "update_rules",
                      patch: { surfaceMode },
                    });
                    if (surfaceMode === "on_device") {
                      void props.ctx.sendCommand({
                        type: "toggle_lan_room",
                        enabled: false,
                      });
                    }
                  }}
                />
              </View>

              <View class={wide() ? "w-24 shrink-0" : ""}>
                <SelectField<string>
                  testID="werewolf-settings-speech-sec"
                  compact
                  disabled={!enabled()}
                  label={loc() === "en-US" ? "Speech Timer" : "单人发言时长"}
                  value={String(st().rules.speechSeconds)}
                  items={[
                    { value: "45", title: "45s" },
                    { value: "60", title: "60s" },
                    { value: "90", title: "90s" },
                    { value: "120", title: "120s" },
                  ]}
                  onChange={(raw) => {
                    const parsed = Number(raw);
                    if (Number.isFinite(parsed) && parsed >= 15) {
                      void props.ctx.sendCommand({
                        type: "update_rules",
                        patch: { speechSeconds: parsed },
                      });
                    }
                  }}
                />
              </View>
            </View>

            <SelectField<WerewolfMotionMode>
              testID="werewolf-settings-motion"
              compact
              disabled={!enabled()}
              label={loc() === "en-US" ? "Robot Choreography" : "法官动作模式"}
              value={st().rules.motionMode}
              items={[
                {
                  value: "embodied_patrol",
                  title:
                    loc() === "en-US"
                      ? "Embodied Pivot Patrol (Speed = 0)"
                      : "具身原地环视与防听声迷踪",
                },
                {
                  value: "stationary_gaze",
                  title:
                    loc() === "en-US"
                      ? "Stationary Gaze Only"
                      : "静默纯表情与眼神模式",
                },
              ]}
              onChange={(motionMode) => {
                void props.ctx.sendCommand({
                  type: "update_rules",
                  patch: { motionMode },
                });
              }}
            />

            <View class="border-y border-border">
              <SwitchRow
                testID="werewolf-settings-sheriff"
                variant="flat"
                disabled={!enabled() || !editableDeck()}
                label={
                  loc() === "en-US"
                    ? "Sheriff Election (1.5x Vote)"
                    : "警长竞选（1.5 票归票权）"
                }
                checked={st().rules.hasSheriff}
                onChange={(hasSheriff) => {
                  void props.ctx.sendCommand({
                    type: "update_rules",
                    patch: { hasSheriff },
                  });
                }}
              />

              <SwitchRow
                testID="werewolf-settings-guard-save"
                variant="flat"
                showDivider={false}
                disabled={!enabled() || !editableDeck()}
                label={
                  loc() === "en-US"
                    ? "Same Guard + Witch Save Dies"
                    : "同守同救判定倒牌（奶穿）"
                }
                checked={st().rules.sameGuardSameSaveDies}
                onChange={(sameGuardSameSaveDies) => {
                  void props.ctx.sendCommand({
                    type: "update_rules",
                    patch: { sameGuardSameSaveDies },
                  });
                }}
              />
            </View>

            <SelectField<WerewolfWinMode>
              testID="werewolf-settings-winmode"
              compact
              disabled={!enabled() || !editableDeck()}
              label={loc() === "en-US" ? "Win Condition" : "胜负判定模式"}
              value={st().rules.winMode}
              items={[
                {
                  value: "slaughter_side",
                  title:
                    loc() === "en-US"
                      ? "Slaughter Side (All Gods or All Villagers)"
                      : "屠边（神职或平民一方出局）",
                },
                {
                  value: "slaughter_all",
                  title:
                    loc() === "en-US"
                      ? "Slaughter All (All Good Eliminated)"
                      : "屠城（全部好人出局）",
                },
              ]}
              onChange={(winMode) => {
                void props.ctx.sendCommand({
                  type: "update_rules",
                  patch: { winMode },
                });
              }}
            />

            <SelectField<WerewolfWitchSelfSaveMode>
              testID="werewolf-settings-witch-save"
              compact
              disabled={!enabled() || !editableDeck()}
              label={loc() === "en-US" ? "Witch Self-Save" : "女巫自救规则"}
              value={st().rules.witchSelfSaveMode}
              items={[
                {
                  value: "first_night_only",
                  title:
                    loc() === "en-US" ? "Night 1 Only" : "仅第一夜可自救",
                },
                {
                  value: "never",
                  title: loc() === "en-US" ? "Never" : "全程不可自救",
                },
                {
                  value: "any_night",
                  title: loc() === "en-US" ? "Any Night" : "任意夜可自救",
                },
              ]}
              onChange={(witchSelfSaveMode) => {
                void props.ctx.sendCommand({
                  type: "update_rules",
                  patch: { witchSelfSaveMode },
                });
              }}
            />
          </View>

          <View class="h-px bg-border" />

          {/* 2. LAN Room Status */}
          <View class="gap-2.5">
            <Text class="text-foreground text-sm font-bold" role="header">
              {loc() === "en-US"
                ? "LAN Companion Room"
                : "局域网扫码副屏"}
            </Text>

            <View
              testID="werewolf-settings-lan-card"
              class="rounded-xl border border-border bg-muted p-3 gap-2.5"
            >
              <View class="flex-row items-center justify-between gap-2">
                <View class="flex-row items-center gap-2 flex-1 min-w-0">
                  <PluginVectorIcon
                    name="link"
                    tone={st().lan.active ? "foreground" : "muted"}
                    size={16}
                  />
                  <View
                    class={
                      st().lan.active
                        ? "w-2 h-2 rounded-full bg-verified"
                        : "w-2 h-2 rounded-full bg-subtle-text"
                    }
                  />
                  <Text
                    class="text-foreground text-xs font-semibold flex-1"
                    style={{ numberOfLines: 1 }}
                  >
                    {st().lan.active
                      ? loc() === "en-US"
                        ? `LAN Room Online (${st().lan.claimedSeats.length} joined)`
                        : `局域网房间已开启（${st().lan.claimedSeats.length} 人已认领）`
                      : loc() === "en-US"
                        ? "LAN Companion Room Offline"
                        : "局域网房间未开启"}
                  </Text>
                </View>

                <ActionButton
                  testID="werewolf-settings-toggle-lan"
                  compact
                  disabled={!enabled() || busy()}
                  label={
                    st().lan.active
                      ? loc() === "en-US"
                        ? "Stop LAN"
                        : "关闭房间"
                      : loc() === "en-US"
                        ? "Open LAN"
                        : "开启房间"
                  }
                  onPress={() => {
                    void props.ctx.sendCommand({
                      type: "toggle_lan_room",
                      enabled: !st().lan.active,
                    });
                  }}
                />
              </View>

              <If when={st().lan.active && Boolean(st().lan.baseUrl)}>
                <View class="flex-row items-center gap-3">
                  <QrCodeCanvas
                    testID="werewolf-settings-qr"
                    value={st().lan.baseUrl ?? ""}
                    size={96}
                    locale={loc()}
                    surface="card"
                    onNotify={(msg) => props.ctx.notify(msg)}
                  />
                  <View class="flex-1 min-w-0 gap-2">
                    <Text
                      testID="werewolf-settings-lan-url"
                      class="text-foreground text-xs font-mono"
                      style={{ numberOfLines: 2 }}
                    >
                      {st().lan.baseUrl}
                    </Text>
                    <View class="flex-row flex-wrap items-center gap-2">
                      <ActionButton
                        testID="werewolf-settings-copy-lan"
                        compact
                        label={loc() === "en-US" ? "Copy URL" : "复制链接"}
                        onPress={() => {
                          const url = st().lan.baseUrl;
                          if (!url) return;
                          void Clipboard.writeText(url).catch((err) => {
                            const detail =
                              err instanceof Error ? err.message : String(err);
                            const message = detail.includes("code=")
                              ? detail
                              : `[stage=qr.copy code=ERR_CLIPBOARD_WRITE] ${detail || "Clipboard write failed"}`;
                            props.ctx.notify(message);
                          });
                        }}
                      />
                      <ActionButton
                        testID="werewolf-settings-refresh-lan"
                        compact
                        label={loc() === "en-US" ? "Refresh" : "刷新地址"}
                        onPress={() => {
                          void props.ctx.sendCommand({
                            type: "refresh_lan_address",
                          });
                        }}
                      />
                    </View>
                  </View>
                </View>
              </If>

              <If when={Boolean(st().lan.error)}>
                <Text class="text-destructive text-xs">{st().lan.error}</Text>
              </If>
            </View>
          </View>
        </Scroll>
      </View>
    </View>
  );
}
