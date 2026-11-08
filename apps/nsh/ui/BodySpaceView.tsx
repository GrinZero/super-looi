import { t } from "../i18n";
import { cleanup, effect, signal, Text, View, Scroll, windowSize } from "nsh";
import { Button } from "nsh/base";
import type { createAppStore } from "../store";
import {
  HorizontalValueSlider,
  SteplessWheel,
  SwitchRow,
  VerticalPitchSlider,
} from "./Controls";

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

function BatteryIcon(props: { percent: number | null; externalPower: boolean }) {
  const fillWidth = () => {
    if (props.percent === null) return 0;
    return Math.max(2, Math.min(16, Math.round((props.percent / 100) * 16)));
  };
  const fillClass = () => {
    if (props.externalPower) return "h-2 rounded-xs bg-verified";
    if (props.percent !== null && props.percent <= 10) return "h-2 rounded-xs bg-destructive";
    if (props.percent !== null && props.percent < 25) return "h-2 rounded-xs bg-warning";
    return "h-2 rounded-xs bg-foreground";
  };

  return (
    <View class="flex-row items-center gap-0.5">
      <View
        class="h-3.5 rounded-xs border border-muted-foreground px-0.5 flex-row items-center"
        style={{ width: 22 }}
      >
        <If when={props.percent !== null}>
          <View class={fillClass()} style={{ width: fillWidth() }} />
        </If>
      </View>
      <View class="w-0.5 h-1.5 rounded-r-xs bg-muted-foreground" />
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

  const wheelDraft = signal<{ speed: number; turn: number } | null>(null);
  const wheelResetToken = signal(0);

  const lightDraft = signal<number | null>(null);
  const lastNonZeroBrightness = signal(128);
  type LightRequest =
    | { kind: "set"; brightness: number }
    | { kind: "on"; brightness: number }
    | { kind: "off" };
  let requestedLight: LightRequest | null = null;
  let lightWrite: Promise<void> | null = null;
  let lightRevision = 0;

  effect(() => {
    const reported = status().lightBrightness;
    if (reported > 0) {
      lastNonZeroBrightness.set(reported);
    }
  });

  effect(() => {
    if (!canControlMotion()) {
      ++headRevision;
      requestedHead = null;
      if (headDraft() !== null) headDraft.set(null);
      if (wheelDraft() !== null) wheelDraft.set(null);
    }
  });

  effect(() => {
    if (!canControlLight()) {
      ++lightRevision;
      requestedLight = null;
      if (lightDraft() !== null) lightDraft.set(null);
    }
  });

  cleanup(() => {
    wheelDraft.set(null);
    headDraft.set(null);
    lightDraft.set(null);
    void props.store.stopBody();
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

  const flushLight = (): Promise<void> => {
    if (lightWrite) return lightWrite;
    lightWrite = (async () => {
      while (requestedLight !== null) {
        const request = requestedLight;
        requestedLight = null;
        if (request.kind === "set") {
          await props.store.controlBody("light_set", undefined, undefined, {
            brightness: request.brightness,
          });
        } else if (request.kind === "on") {
          await props.store.controlBody("light_on", undefined, undefined, {
            brightness: request.brightness,
          });
        } else {
          await props.store.controlBody("light_off");
        }
      }
    })().finally(() => {
      lightWrite = null;
      if (requestedLight !== null) void flushLight();
    });
    return lightWrite;
  };

  const effectiveLightBytes = () => {
    if (!status().connected) return 0;
    const draft = lightDraft();
    if (draft !== null) return draft;
    if (!status().lightOn) return 0;
    return status().lightBrightness > 0 ? status().lightBrightness : 128;
  };

  const effectiveLightOn = () => effectiveLightBytes() > 0;

  const effectiveLightPercent = () =>
    Math.round((effectiveLightBytes() / 255) * 100);

  const percentToLightByte = (percent: number): number => {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    if (clamped === 0) return 0;
    return Math.max(1, Math.min(255, Math.round((clamped / 100) * 255)));
  };

  const requestLightPercent = (percent: number) => {
    ++lightRevision;
    const byte = percentToLightByte(percent);
    if (byte > 0) {
      lastNonZeroBrightness.set(byte);
    }
    lightDraft.set(byte);
    requestedLight = { kind: "set", brightness: byte };
    return flushLight();
  };

  const toggleLight = () => {
    const revision = ++lightRevision;
    if (effectiveLightOn()) {
      const current = effectiveLightBytes();
      if (current > 0) lastNonZeroBrightness.set(current);
      lightDraft.set(0);
      requestedLight = { kind: "off" };
    } else {
      const target = lastNonZeroBrightness() > 0 ? lastNonZeroBrightness() : 128;
      lightDraft.set(target);
      requestedLight = { kind: "on", brightness: target };
    }
    void flushLight().finally(() => {
      if (revision === lightRevision) lightDraft.set(null);
    });
  };

  const wheelVectorLabel = () => {
    const vec = wheelDraft() ?? status().motion;
    if (vec.speed === 0 && vec.turn === 0) {
      return t("wheelVectorIdle");
    }
    const fmt = (n: number) => (n > 0 ? `+${n}` : String(n));
    return t("wheelVectorLive", { speed: fmt(vec.speed), turn: fmt(vec.turn) });
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

      {/* Connected Dock Power & External Supply Bar */}
      <If when={status().connected}>
        <View
          testID="body-power-row"
          class="min-h-11 rounded-xl bg-muted border border-border px-3 py-1 flex-row items-center justify-between gap-2"
        >
          <View class="flex-row items-center gap-2 flex-1 min-w-0">
            <BatteryIcon
              percent={status().powerStatus?.batteryPercent ?? null}
              externalPower={Boolean(status().powerStatus?.externalPower)}
            />
            <Text
              testID="body-power-percent"
              class="text-foreground text-sm font-semibold"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {status().powerStatus
                ? `${status().powerStatus!.batteryPercent}%`
                : "—"}
            </Text>
            <Text
              testID="body-power-source"
              class={
                status().powerStatus?.externalPower
                  ? "text-verified text-xs font-medium flex-1"
                  : "text-muted-foreground text-xs font-medium flex-1"
              }
              style={{ numberOfLines: 1 }}
            >
              {status().powerStatus
                ? status().powerStatus!.externalPower
                  ? t("externalPowerTag")
                  : t("batteryPowerTag")
                : status().powerReading
                  ? t("readingPower")
                  : t("powerUnread")}
            </Text>
          </View>
          <Button
            testID="body-power-refresh"
            accessibilityLabel={t("refreshPower")}
            disabled={status().powerReading}
            onPress={() => void props.store.refreshBodyPower()}
            class="min-h-11 px-3 rounded-lg border border-border bg-card items-center justify-center active:opacity-75 disabled:opacity-40"
          >
            <Text class="text-foreground text-xs font-medium">
              {status().powerReading ? t("readingPower") : t("refreshPower")}
            </Text>
          </Button>
        </View>
      </If>

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

  const wide = () => windowSize().width >= 600;
  const stackRightControls = () => windowSize().width < 380;
  const wheelSize = () => {
    const sz = windowSize();
    if (sz.width >= 600) {
      return Math.max(116, Math.min(136, sz.height - 268));
    }
    if (sz.width < 380) {
      return 132;
    }
    return Math.max(116, Math.min(136, Math.floor((sz.width - 72) / 2)));
  };

  const renderRightCard = () => (
    <View
      class={
        stackRightControls()
          ? "rounded-2xl border border-border bg-card p-2.5 flex-col gap-2"
          : "rounded-2xl border border-border bg-card p-2 flex-row gap-2"
      }
    >
      {/* Left Inner Sub-panel: 360° Stepless Analog Wheel */}
      <View class="flex-1 rounded-2xl bg-muted border border-border p-2 items-center justify-between gap-1">
        <View class="w-full flex-row items-center justify-between gap-1.5">
          <Text
            class="flex-1 text-foreground text-xs font-semibold"
            style={{ numberOfLines: 1 }}
          >
            {t("directionalWheel")}
          </Text>
          <Button
            testID="body-wheel-stop"
            accessibilityLabel={t("wheelStop")}
            disabled={!status().connected}
            onPress={() => {
              wheelResetToken.update((n) => n + 1);
              wheelDraft.set(null);
              void props.store.stopBody();
            }}
            class="min-w-11 min-h-11 px-2.5 rounded-full border border-border bg-card flex-row items-center justify-center gap-1.5 active:opacity-75 disabled:opacity-40"
          >
            <View class="w-2.5 h-2.5 rounded-xs bg-destructive" />
            <Text class="text-foreground text-xs font-semibold">
              {t("wheelStop")}
            </Text>
          </Button>
        </View>

        <View class="items-center justify-center">
          <SteplessWheel
            testID="body-wheel-joystick"
            accessibilityLabel={t("directionalWheel")}
            disabled={!canControlMotion()}
            resetToken={wheelResetToken()}
            size={wheelSize()}
            onVectorChange={(speed, turn) => {
              wheelDraft.set({ speed, turn });
              void props.store.setBodyDriveVector(speed, turn);
            }}
            onRelease={() => {
              wheelDraft.set(null);
              void props.store.stopBody();
            }}
          />
        </View>

        <View class="w-full items-center gap-0.5">
          <Text
            testID="body-wheel-vector"
            class="w-full text-foreground text-xs font-medium text-center"
            style={{ fontVariant: ["tabular-nums"], numberOfLines: 1 }}
          >
            {wheelVectorLabel()}
          </Text>
          <Text
            class="w-full text-muted-foreground text-xs text-center"
            style={{ numberOfLines: 1 }}
          >
            {t("wheelGestureHint")}
          </Text>
        </View>
      </View>

      {/* Right Inner Column: Two-Column Head Pitch Card + Fill Light Brightness Card */}
      <View class="flex-1 justify-between gap-2">
        {/* Top Recessed Sub-panel: Head Presets Stack + Vertical Pitch Slider */}
        <View class="flex-1 rounded-2xl bg-muted border border-border px-2.5 py-1 flex-row items-center justify-between gap-2">
          <View class="flex-1 justify-between">
            <Button
              testID="body-head-up"
              disabled={!canControlMotion()}
              onPress={() => setHeadPreset("head_up")}
              class="min-h-11 justify-center active:opacity-75 disabled:opacity-40"
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

            <Button
              testID="body-head-center"
              disabled={!canControlMotion()}
              accessibilityLabel={t("headCenter")}
              onPress={() => setHeadPreset("head_center")}
              class="min-h-11 justify-center active:opacity-75 disabled:opacity-40"
            >
              <Text
                testID="body-head-degrees"
                class="text-foreground text-2xl font-bold"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {`${Math.round((headDraft() ?? status().headDegrees) * 10) / 10}°`}
              </Text>
            </Button>

            <Button
              testID="body-head-down"
              disabled={!canControlMotion()}
              onPress={() => setHeadPreset("head_down")}
              class="min-h-11 justify-center active:opacity-75 disabled:opacity-40"
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

        {/* Bottom Fill Light Toggle + Stepless Brightness Card */}
        <View class="rounded-2xl bg-muted border border-border px-2.5 py-1 gap-0.5">
          <Button
            testID="body-light-toggle"
            selected={effectiveLightOn()}
            disabled={!canControlLight()}
            onPress={() => toggleLight()}
            class={
              effectiveLightOn()
                ? "min-h-11 w-full rounded-xl bg-primary border border-transparent px-3 flex-row items-center justify-between gap-2 active:opacity-75 disabled:opacity-40"
                : "min-h-11 w-full rounded-xl bg-card border border-border px-3 flex-row items-center justify-between gap-2 active:opacity-75 disabled:opacity-40"
            }
          >
            <View class="flex-row items-center gap-2 flex-1 min-w-0">
              <View
                class={
                  effectiveLightOn()
                    ? "w-2.5 h-2.5 rounded-full bg-primary-foreground"
                    : "w-2.5 h-2.5 rounded-full border border-muted-foreground"
                }
              />
              <Text
                class={
                  effectiveLightOn()
                    ? "text-primary-foreground text-xs font-semibold flex-1"
                    : "text-foreground text-xs font-medium flex-1"
                }
                style={{ numberOfLines: 1 }}
              >
                {effectiveLightOn() ? t("fillLightOn") : t("fillLightOff")}
              </Text>
            </View>
            <Text
              testID="body-light-brightness-value"
              class={
                effectiveLightOn()
                  ? "text-primary-foreground text-xs font-semibold"
                  : "text-muted-foreground text-xs font-medium"
              }
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {`${effectiveLightPercent()}%`}
            </Text>
          </Button>

          <HorizontalValueSlider
            testID="body-light-slider"
            accessibilityLabel={t("fillLightBrightness")}
            min={0}
            max={100}
            step={1}
            value={effectiveLightPercent()}
            disabled={!canControlLight()}
            onChange={(pct) => {
              void requestLightPercent(pct);
            }}
            onChangeEnd={(pct) => {
              const finished = requestLightPercent(pct);
              const revision = lightRevision;
              void finished.finally(() => {
                if (revision === lightRevision) lightDraft.set(null);
              });
            }}
          />
        </View>
      </View>
    </View>
  );

  return (
    <If
      when={wide()}
      else={
        <Scroll class="flex-1" contentClass="gap-3 pb-5">
          {renderLeftCard()}
          {renderRightCard()}
        </Scroll>
      }
    >
      <View class="flex-1 flex-row gap-3 min-h-0">
        <View style={{ flex: 5, minWidth: 0, minHeight: 0 }}>
          <Scroll class="flex-1" contentClass="gap-2.5 pb-2">
            {renderLeftCard()}
          </Scroll>
        </View>
        <View style={{ flex: 7, minWidth: 0, minHeight: 0 }}>
          <Scroll class="flex-1" contentClass="gap-2 pb-1">
            {renderRightCard()}
          </Scroll>
        </View>
      </View>
    </If>
  );
}
