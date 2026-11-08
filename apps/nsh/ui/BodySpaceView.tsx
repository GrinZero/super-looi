import { t } from "../i18n";
import { cleanup, signal, Text, View, Scroll, windowSize } from "nsh";
import { Button } from "nsh/base";
import type { createAppStore } from "../store";
import { SwitchRow, VerticalPitchSlider } from "./Controls";

function DockMiniIcon() {
  return (
    <View class="w-12 h-12 rounded-2xl border border-border bg-muted items-center justify-center gap-0.5">
      <View class="w-6 h-4 rounded-sm border border-foreground bg-card flex-row items-center justify-center gap-1">
        <View class="w-1 h-1 rounded-full bg-foreground" />
        <View class="w-1 h-1 rounded-full bg-foreground" />
      </View>
      <View class="w-1.5 h-1 bg-foreground" />
      <View class="w-7 h-2 rounded-full bg-foreground" />
    </View>
  );
}

function SignalBars(props: { rssi: number | null }) {
  const level = () => {
    const rssi = props.rssi;
    if (rssi === null) return 3;
    if (rssi >= -55) return 4;
    if (rssi >= -68) return 3;
    if (rssi >= -80) return 2;
    return 1;
  };
  const barClass = (bar: number) =>
    level() >= bar ? "w-1 rounded-full bg-foreground" : "w-1 rounded-full bg-border";

  return (
    <View class="flex-row items-end gap-0.5 h-3.5">
      <View class={barClass(1)} style={{ height: 4 }} />
      <View class={barClass(2)} style={{ height: 7 }} />
      <View class={barClass(3)} style={{ height: 10 }} />
      <View class={barClass(4)} style={{ height: 13 }} />
    </View>
  );
}

export function BodySpaceView(props: {
  store: ReturnType<typeof createAppStore>;
}) {
  const status = () => props.store.bodyStatus();
  const config = () => props.store.bodyConfiguration();
  const isSimulation = () => status().mode === "simulation";
  const canControlMotion = () => status().connected && !status().connecting;
  const canControlLight = () => status().connected && !status().connecting;
  const connectionBusy = () => status().scanning || status().connecting;
  const headDraft = signal<number | null>(null);
  type HeadRequest = number | "head_up" | "head_center" | "head_down";
  let requestedHead: HeadRequest | null = null;
  let headWrite: Promise<void> | null = null;
  let headRevision = 0;
  type WheelDirection = "forward" | "backward" | "turn_left" | "turn_right";
  let pressedDirection: WheelDirection | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdHeartbeat: ReturnType<typeof setInterval> | null = null;
  let holdGeneration = 0;
  let holdStarted = false;
  let suppressTap: WheelDirection | null = null;
  let tapQueue: Promise<void> = Promise.resolve();
  let tapQueueGeneration = 0;

  const endWheelPress = (direction?: WheelDirection, stopHeld = true) => {
    if (direction && pressedDirection !== direction) return;
    if (holdTimer) clearTimeout(holdTimer);
    if (holdHeartbeat) clearInterval(holdHeartbeat);
    holdTimer = null;
    holdHeartbeat = null;
    ++holdGeneration;
    pressedDirection = null;
    if (holdStarted) {
      holdStarted = false;
      if (stopHeld) void props.store.stopBody();
    }
  };

  const startWheelPress = (direction: WheelDirection) => {
    endWheelPress();
    if (!canControlMotion()) return;
    pressedDirection = direction;
    suppressTap = null;
    const generation = holdGeneration;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (generation !== holdGeneration || pressedDirection !== direction) return;
      holdStarted = true;
      suppressTap = direction;
      ++tapQueueGeneration;
      void (async () => {
        await tapQueue;
        if (generation !== holdGeneration || pressedDirection !== direction) return;
        const started = await props.store.startBodyDrive(direction);
        if (generation !== holdGeneration || pressedDirection !== direction) {
          if (started) void props.store.stopBody();
          return;
        }
        if (!started) {
          endWheelPress(direction);
          return;
        }
        holdHeartbeat = setInterval(() => {
          if (!props.store.renewBodyDrive()) endWheelPress(direction);
        }, 500);
      })();
    }, 450);
  };

  const tapWheel = (direction: WheelDirection) => {
    if (suppressTap === direction) {
      suppressTap = null;
      return;
    }
    if (!canControlMotion()) return;
    const generation = tapQueueGeneration;
    tapQueue = tapQueue.then(async () => {
      if (generation === tapQueueGeneration && canControlMotion()) {
        await props.store.controlBody(direction, direction.startsWith("turn_") ? 140 : 180);
      }
    });
  };

  cleanup(() => {
    ++tapQueueGeneration;
    endWheelPress();
  });

  const flushHead = (): Promise<void> => {
    if (headWrite) return headWrite;
    headWrite = (async () => {
      while (requestedHead !== null) {
        const request = requestedHead;
        requestedHead = null;
        if (typeof request === "number") {
          await props.store.controlBody("head_set", undefined, request);
        } else {
          await props.store.controlBody(request);
        }
      }
    })().finally(() => {
      headWrite = null;
      if (requestedHead !== null) void flushHead();
    });
    return headWrite;
  };

  const requestHead = (degrees: number) => {
    ++headRevision;
    headDraft.set(degrees);
    requestedHead = degrees;
    return flushHead();
  };

  const setHeadPreset = (action: "head_up" | "head_center" | "head_down") => {
    const revision = ++headRevision;
    requestedHead = action;
    headDraft.set(action === "head_up" ? 85 : action === "head_down" ? 25 : 55);
    void flushHead().finally(() => {
      if (revision === headRevision) headDraft.set(null);
    });
  };

  const otherCandidates = () => {
    const currentId = status().deviceId;
    return status().candidates.filter((c) => !status().connected || c.id !== currentId);
  };

  const renderStatusPill = () => {
    if (status().connecting) {
      return (
        <View testID="body-status-pill" class="self-start flex-row items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted border border-warning">
          <View class="w-2 h-2 rounded-full bg-warning" />
          <Text class="text-warning text-xs font-medium">{t("connectingDock")}</Text>
        </View>
      );
    }
    if (status().connected && status().isDocked) {
      return (
        <View
          testID="body-status-pill"
          class="self-start flex-row items-center gap-1.5 px-2.5 py-1 rounded-full bg-live-active-bg border border-verified"
        >
          <View class="w-2 h-2 rounded-full bg-verified" />
          <Text class="text-verified text-xs font-semibold">{t("dockedReady")}</Text>
        </View>
      );
    }
    if (status().connected && !status().isDocked) {
      return (
        <View
          testID="body-status-pill"
          class="self-start flex-row items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted border border-warning"
        >
          <View class="w-2 h-2 rounded-full bg-warning" />
          <Text class="text-warning text-xs font-semibold">
            {t("connectedPlaceOnDock")}
          </Text>
        </View>
      );
    }
    if (status().scanning) {
      return (
        <View
          testID="body-status-pill"
          class="self-start flex-row items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted border border-border"
        >
          <View class="w-2 h-2 rounded-full bg-warning" />
          <Text class="text-muted-foreground text-xs font-medium">
            {t("scanningNearbyDocks")}
          </Text>
        </View>
      );
    }
    return (
      <View
        testID="body-status-pill"
        class="self-start flex-row items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted border border-border"
      >
        <View class="w-2 h-2 rounded-full bg-subtle-text" />
        <Text class="text-muted-foreground text-xs font-medium">
          {t("disconnectedDock")}
        </Text>
      </View>
    );
  };

  const renderLeftCard = () => (
    <View class="rounded-2xl border border-border bg-card p-3 gap-2">
      {/* Top Hero Row */}
      <View class="flex-row items-center gap-3">
        <DockMiniIcon />
        <View class="flex-1 min-w-0 gap-1">
          <Text
            testID="body-device-title"
            class="text-foreground text-lg font-bold"
            style={{ numberOfLines: 1 }}
          >
            {status().deviceName || t("looiDesktopDock")}
          </Text>
          {renderStatusPill()}
        </View>
      </View>

      {/* Recessed Toggle Row */}
      <If
        when={isSimulation()}
        else={
          <SwitchRow
            label={t("connectSavedOnLaunch")}
            testID="body-auto-reconnect-switch"
            checked={config().autoConnect}
            onChange={(next) =>
              void props.store.configureBody({ autoConnect: next })
            }
          />
        }
      >
        <SwitchRow
          label={t("simulatePlaceOnDock")}
          testID="body-sim-dock-switch"
          checked={status().isDocked}
          disabled={!status().connected}
          onChange={(next) => props.store.setSimulatedDock(next)}
        />
      </If>

      <If when={!isSimulation() && !connectionBusy() && status().error}>
        <Text testID="body-connection-error" class="text-warning text-xs">
          {status().error}
        </Text>
      </If>

      {/* Other Available Docks Section */}
      <View class="border-t border-border pt-1.5 gap-1">
        <Text class="text-muted-foreground text-xs font-medium">
          {status().connected ? t("otherAvailableDocks") : t("nearbyDocks")}
        </Text>
        <If
          when={otherCandidates().length > 0}
          else={
            <View class="py-1">
              <Text class="text-muted-foreground text-xs">
                {status().scanning
                  ? t("scanningNearbyDocks")
                  : status().scanCompleted
                    ? t(status().connected ? "noOtherDocksFound" : "noNearbyDocksFound")
                    : status().error
                      ? t("retryScanDock")
                    : t("scanToChooseDock")}
              </Text>
            </View>
          }
        >
          <View class="gap-1">
            <Each of={otherCandidates()} key={(c) => c.id}>
              {(c) => (
                <View class="min-h-11 flex-row items-center justify-between gap-2">
                  <Text
                    class="text-foreground text-sm font-medium flex-1"
                    style={{ numberOfLines: 1 }}
                  >
                    {c().name}
                  </Text>
                  <View class="flex-row items-center gap-2.5">
                    <SignalBars rssi={c().rssi} />
                    <Button
                      testID={`body-connect-${c().id}`}
                      onPress={() =>
                        void props.store.connectBodyDevice({
                          deviceId: c().id,
                          deviceName: c().name,
                        })
                      }
                      class="min-h-11 px-3.5 rounded-full border border-border bg-muted items-center justify-center active:opacity-75"
                    >
                      <Text class="text-foreground text-xs font-medium">
                        {t("connectDockBtn")}
                      </Text>
                    </Button>
                  </View>
                </View>
              )}
            </Each>
          </View>
        </If>
      </View>

      {/* Bottom Connection Action */}
      <If when={status().connected || status().connecting || config().savedDeviceId}>
      <View class="border-t border-border pt-1 items-center justify-center">
        <If
          when={status().connected || status().connecting}
          else={
            <Button
              testID="body-connect-primary-btn"
              disabled={status().connecting}
              onPress={() => void props.store.connectBodyDevice()}
              class="min-h-11 w-full rounded-xl bg-primary items-center justify-center active:opacity-75 disabled:opacity-40"
            >
              <Text class="text-primary-foreground text-sm font-semibold">
                {status().connecting ? t("connectingDock") : t("connectSavedDock")}
              </Text>
            </Button>
          }
        >
          <Button
            testID="body-disconnect-btn"
            onPress={() => void props.store.disconnectBody()}
            class="min-h-11 w-full rounded-xl items-center justify-center active:bg-muted"
          >
            <Text class="text-muted-foreground text-sm font-medium">
              {t("disconnectDockBtn")}
            </Text>
          </Button>
        </If>
      </View>
      </If>
      <If when={!isSimulation() && !!config().savedDeviceId}>
        <Button
          testID="body-forget-saved-btn"
          onPress={() => void props.store.forgetSavedDock()}
          class="min-h-11 w-full border-t border-border items-center justify-center rounded-xl active:bg-muted"
        >
          <Text class="text-muted-foreground text-xs font-medium">
            {t("forgetSavedDock")}
          </Text>
        </Button>
      </If>
    </View>
  );

  const wheelDirectionClass = (cmd: "forward" | "backward" | "turn_left" | "turn_right", posClass: string) => {
    const active = props.store.bodyActiveCommand() === cmd;
    return active
      ? `absolute ${posClass} min-w-11 min-h-11 rounded-full bg-primary items-center justify-center active:opacity-75 disabled:opacity-40`
      : `absolute ${posClass} min-w-11 min-h-11 rounded-full items-center justify-center active:bg-muted disabled:opacity-40`;
  };

  const wheelChevronTextClass = (cmd: "forward" | "backward" | "turn_left" | "turn_right") =>
    props.store.bodyActiveCommand() === cmd
      ? "text-primary-foreground text-base font-bold"
      : "text-muted-foreground text-base font-bold";

  const renderRightCard = () => (
    <View class="rounded-2xl border border-border bg-card p-3 flex-row gap-2.5">
      {/* Left Inner Sub-panel: Classic Directional Wheel */}
      <View class="flex-1 rounded-2xl bg-muted border border-border p-2.5 items-center justify-between gap-1.5">
        <View class="flex-1 items-center justify-center">
          <View class="w-36 h-36 rounded-full border border-border bg-card items-center justify-center relative">
            {/* Forward (Up) */}
            <Button
              testID="body-wheel-forward"
              accessibilityLabel={t("wheelForward")}
              disabled={!canControlMotion()}
              onPressDown={() => startWheelPress("forward")}
              onPressUp={() => endWheelPress("forward")}
              onPress={() => tapWheel("forward")}
              class={wheelDirectionClass("forward", "top-1")}
            >
              <Text class={wheelChevronTextClass("forward")}>⌃</Text>
            </Button>

            {/* Backward (Down) */}
            <Button
              testID="body-wheel-backward"
              accessibilityLabel={t("wheelBackward")}
              disabled={!canControlMotion()}
              onPressDown={() => startWheelPress("backward")}
              onPressUp={() => endWheelPress("backward")}
              onPress={() => tapWheel("backward")}
              class={wheelDirectionClass("backward", "bottom-1")}
            >
              <Text class={wheelChevronTextClass("backward")}>⌄</Text>
            </Button>

            {/* Turn Left */}
            <Button
              testID="body-wheel-left"
              accessibilityLabel={t("wheelLeft")}
              disabled={!canControlMotion()}
              onPressDown={() => startWheelPress("turn_left")}
              onPressUp={() => endWheelPress("turn_left")}
              onPress={() => tapWheel("turn_left")}
              class={wheelDirectionClass("turn_left", "left-1")}
            >
              <Text class={wheelChevronTextClass("turn_left")}>‹</Text>
            </Button>

            {/* Turn Right */}
            <Button
              testID="body-wheel-right"
              accessibilityLabel={t("wheelRight")}
              disabled={!canControlMotion()}
              onPressDown={() => startWheelPress("turn_right")}
              onPressUp={() => endWheelPress("turn_right")}
              onPress={() => tapWheel("turn_right")}
              class={wheelDirectionClass("turn_right", "right-1")}
            >
              <Text class={wheelChevronTextClass("turn_right")}>›</Text>
            </Button>

            {/* Center Stop Button */}
            <Button
              testID="body-wheel-stop"
              accessibilityLabel={t("wheelStop")}
              disabled={!status().connected}
              onPress={() => {
                ++tapQueueGeneration;
                endWheelPress(undefined, false);
                void props.store.stopBody();
              }}
              class="w-14 h-14 rounded-full border border-border bg-secondary items-center justify-center active:opacity-75 disabled:opacity-40"
            >
              <View class="w-3.5 h-3.5 rounded-xs bg-foreground" />
            </Button>
          </View>
        </View>

        <View class="items-center gap-0.5">
          <Text class="text-muted-foreground text-xs font-medium text-center">
            {t("directionalWheel")}
          </Text>
          <Text class="text-muted-foreground text-xs text-center">
            {t("wheelGestureHint")}
          </Text>
        </View>
      </View>

      {/* Right Inner Column: Vertical Head Slider + Bottom Fill Light Pill */}
      <View class="flex-1 justify-between gap-2">
        {/* Top Recessed Sub-panel: Vertical Head Pitch Slider */}
        <View class="flex-1 rounded-2xl bg-muted border border-border px-3 py-1.5 justify-between">
          <Button
            testID="body-head-up"
            disabled={!canControlMotion()}
            onPress={() => setHeadPreset("head_up")}
            class="min-h-11 flex-row items-center justify-between active:opacity-75 disabled:opacity-40"
          >
            <Text
              class={
                status().headPose === "up"
                  ? "text-foreground text-xs font-bold"
                  : "text-muted-foreground text-xs font-medium"
              }
            >
              {t("headUp")}
            </Text>
          </Button>

          <View class="flex-row items-center justify-between gap-2 py-1">
            <Button
              testID="body-head-center"
              disabled={!canControlMotion()}
              accessibilityLabel={t("headCenter")}
              onPress={() => setHeadPreset("head_center")}
              class="min-h-11 justify-center active:opacity-75 disabled:opacity-40"
            >
              <Text
                testID="body-head-degrees"
                class="text-foreground text-3xl font-bold"
              >
                {`${Math.round((headDraft() ?? status().headDegrees) * 10) / 10}°`}
              </Text>
            </Button>

            <VerticalPitchSlider
              testID="body-head-slider"
              accessibilityLabel={t("headPitchSlider")}
              min={25}
              max={85}
              step={0}
              value={headDraft() ?? status().headDegrees}
              disabled={!canControlMotion()}
              onChange={(deg) => {
                void requestHead(deg);
              }}
              onChangeEnd={(deg) => {
                const finished = requestHead(deg);
                const revision = headRevision;
                void finished.finally(() => {
                  if (revision === headRevision) headDraft.set(null);
                });
              }}
            />
          </View>

          <Button
            testID="body-head-down"
            disabled={!canControlMotion()}
            onPress={() => setHeadPreset("head_down")}
            class="min-h-11 flex-row items-center justify-between active:opacity-75 disabled:opacity-40"
          >
            <Text
              class={
                status().headPose === "down"
                  ? "text-foreground text-xs font-bold"
                  : "text-muted-foreground text-xs font-medium"
              }
            >
              {t("headDown")}
            </Text>
          </Button>
        </View>

        {/* Bottom Fill Light Toggle Pill */}
        <Button
          testID="body-light-toggle"
          selected={status().lightOn}
          disabled={!canControlLight()}
          onPress={() =>
            void props.store.controlBody(
              status().lightOn ? "light_off" : "light_on",
            )
          }
          class={
            status().lightOn
              ? "min-h-11 w-full rounded-full bg-primary border border-transparent px-3 flex-row items-center justify-center gap-2 active:opacity-75 disabled:opacity-40"
              : "min-h-11 w-full rounded-full bg-muted border border-border px-3 flex-row items-center justify-center gap-2 active:opacity-75 disabled:opacity-40"
          }
        >
          <View
            class={
              status().lightOn
                ? "w-2.5 h-2.5 rounded-full bg-primary-foreground"
                : "w-2.5 h-2.5 rounded-full border border-muted-foreground"
            }
          />
          <Text
            class={
              status().lightOn
                ? "text-primary-foreground text-xs font-semibold"
                : "text-foreground text-xs font-medium"
            }
            style={{ numberOfLines: 1 }}
          >
            {status().lightOn ? t("fillLightOn") : t("fillLightOff")}
          </Text>
        </Button>
      </View>
    </View>
  );

  const wide = () => windowSize().width >= 600;

  return (
    <If
      when={wide()}
      else={
        <Scroll class="flex-1" contentClass="gap-3.5 pb-6">
          {renderLeftCard()}
          {renderRightCard()}
        </Scroll>
      }
    >
      <View class="flex-1 flex-row gap-3.5 min-h-0">
        <View style={{ flex: 5, minWidth: 0, minHeight: 0 }}>
          <Scroll class="flex-1" contentClass="gap-3 pb-4">
            {renderLeftCard()}
          </Scroll>
        </View>
        <View style={{ flex: 7, minWidth: 0, minHeight: 0 }}>
          <Scroll class="flex-1" contentClass="gap-3 pb-4">
            {renderRightCard()}
          </Scroll>
        </View>
      </View>
    </If>
  );
}
