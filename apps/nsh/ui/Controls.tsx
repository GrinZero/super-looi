import { t, translateMessage, formatDate } from "../i18n";
import {
  Canvas,
  cleanup,
  effect,
  lifecycle,
  signal,
  Text,
  token,
  View,
  Scroll,
  keyboardFrame,
  reduceMotion,
  windowSize,
  type GestureResponderEvent,
  type JSX,
  type TouchPoint,
} from "nsh";
import { Button, Input, Dialog, Select, Switch, Slider, type SelectItem } from "nsh/base";

/** App-owned controls: shared touch targets, focus, disabled and press states. */
export function ActionButton(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  kind?: "primary" | "quiet" | "danger";
  testID?: string;
  compact?: boolean;
}) {
  const containerClass = () => {
    if (props.compact) {
      if (props.kind === "primary") {
        return "min-h-11 rounded-xl bg-primary px-3.5 items-center justify-center active:opacity-70 focus:border-ring disabled:opacity-35";
      }
      if (props.kind === "danger") {
        return "min-h-11 rounded-xl border border-destructive px-3.5 items-center justify-center active:opacity-60 disabled:opacity-35";
      }
      return "min-h-11 rounded-xl border border-border bg-card px-3.5 items-center justify-center active:bg-muted focus:border-ring disabled:opacity-35";
    }
    if (props.kind === "primary") {
      return "min-h-12 rounded-full bg-primary px-5 items-center justify-center active:opacity-70 focus:border-ring disabled:opacity-35";
    }
    if (props.kind === "danger") {
      return "min-h-12 rounded-full border border-destructive px-5 items-center justify-center active:opacity-60 disabled:opacity-35";
    }
    return "min-h-12 rounded-full border border-border bg-card px-5 items-center justify-center active:bg-muted focus:border-ring disabled:opacity-35";
  };

  const textClass = () => {
    const size = props.compact ? "text-sm" : "text-base";
    if (props.kind === "primary") {
      return `text-primary-foreground ${size} font-semibold`;
    }
    if (props.kind === "danger") {
      return `text-destructive ${size} font-medium`;
    }
    return `text-foreground ${size} font-medium`;
  };

  return (
    <Button
      testID={props.testID}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class={containerClass()}
    >
      <Text class={textClass()}>
        {props.label}
      </Text>
    </Button>
  );
}

export function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  masked?: boolean;
  onSubmit?: () => void;
  testID?: string;
}) {
  return (
    <View class="gap-2">
      <Text class="text-muted-foreground text-sm">{props.label}</Text>
      <Input
        testID={props.testID}
        value={props.value}
        onChange={(e) => props.onChange(e.value)}
        masked={props.masked}
        placeholder={props.placeholder}
        autoCorrect={false}
        autoCapitalize="none"
        maxLength={8192}
        onSubmit={() => props.onSubmit?.()}
        class="h-12 rounded-xl border border-input bg-background px-4 text-foreground text-base focus:border-ring"
      />
    </View>
  );
}

export function SelectField<T extends string = string>(props: {
  label?: string;
  accessibilityLabel?: string;
  items: Array<Omit<SelectItem, "value"> & { value: T }>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  testID?: string;
}) {
  const open = signal(false);
  const selectedTitle = () =>
    props.items.find((item) => item.value === props.value)?.title ?? "";

  return (
    <View class="gap-2">
      <If when={props.label}>
        <Text class="text-muted-foreground text-sm">{props.label}</Text>
      </If>
      <Select
        accessibilityLabel={props.accessibilityLabel ?? props.label}
        items={props.items}
        value={props.value}
        open={open()}
        onOpenChange={(event) => open.set(event.open)}
        disabled={props.disabled}
        onChange={(event) => {
          const matched = props.items.find((item) => item.value === event.value);
          if (matched) {
            props.onChange(matched.value);
          }
        }}
        backdropClass="bg-backdrop"
        popupClass="rounded-t-2xl border border-border bg-popover shadow-lg"
        popupStyle={{
          paddingTop: 8,
          paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)",
          paddingLeft: "calc(env(safe-area-inset-left) + 12px)",
          paddingRight: "calc(env(safe-area-inset-right) + 12px)",
        }}
        itemClass="group my-0.5 w-full min-h-12 flex-row items-center justify-between gap-3 rounded-xl px-4 focus:bg-muted active:bg-muted selected:bg-muted disabled:opacity-40"
        renderItem={(entry) => (
          <View class="w-full flex-1 flex-row items-center justify-between gap-3">
            <Text
              class="flex-1 text-base text-foreground group-selected:font-semibold"
              style={{ numberOfLines: 1 }}
            >
              {entry.title}
            </Text>
            <Text class="text-base font-semibold text-transparent group-selected:text-foreground">
              ✓
            </Text>
          </View>
        )}
        trigger={
          <View
            testID={props.testID}
            class={
              open()
                ? "min-h-12 flex-row items-center justify-between gap-3 rounded-xl border border-ring bg-muted px-4 active:bg-muted disabled:opacity-40"
                : "min-h-12 flex-row items-center justify-between gap-3 rounded-xl border border-input bg-background px-4 active:bg-muted focus:border-ring disabled:opacity-40"
            }
          >
            <Text
              class="flex-1 text-base font-medium text-foreground"
              style={{ numberOfLines: 1 }}
            >
              {selectedTitle()}
            </Text>
            <Text
              class={
                open()
                  ? "text-base text-foreground"
                  : "text-base text-muted-foreground"
              }
            >
              ▾
            </Text>
          </View>
        }
      />
    </View>
  );
}

const WAVE_RATIOS = [0.34, 0.56, 0.84, 1, 0.78, 0.52, 0.34];

/** Lightweight iconographic LIVE voice trigger: communicates call state through waveform geometry and semantic tokens without text clutter. */
export function LiveVoiceButton(props: {
  phase:
    | "idle"
    | "standby"
    | "permission"
    | "connecting"
    | "listening"
    | "speaking"
    | "error";
  muted: boolean;
  audioLevel: number;
  accessibilityLabel: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const active = () =>
    props.phase === "connecting" ||
    props.phase === "listening" ||
    props.phase === "speaking";

  const surfaceClass = () => {
    if (props.phase === "connecting") {
      return "w-11 h-11 rounded-full border border-warning bg-stage-pill-bg flex-row items-center justify-center active:opacity-75 focus:border-stage-pill-fg disabled:opacity-40";
    }
    if (
      (props.phase === "listening" && !props.muted) ||
      props.phase === "speaking"
    ) {
      return "w-11 h-11 rounded-full border border-verified bg-live-active-bg flex-row items-center justify-center active:opacity-75 focus:border-stage-pill-fg disabled:opacity-40";
    }
    return "w-11 h-11 rounded-full border border-stage-pill-border bg-stage-pill-bg flex-row items-center justify-center active:opacity-75 focus:border-stage-pill-fg disabled:opacity-40";
  };

  const barHeight = (base: number, boost: number) => {
    if (props.phase === "listening" && props.muted) return 4;
    const energy =
      !reduceMotion() &&
      (props.phase === "listening" || props.phase === "speaking")
        ? Math.max(0, Math.min(1, props.audioLevel))
        : 0;
    return Math.min(18, Math.round(base + energy * boost));
  };

  const listeningBarClass = () =>
    props.muted ? "rounded-full bg-stage-muted" : "rounded-full bg-verified";

  return (
    <Button
      testID="voice-toggle"
      selected={active()}
      accessibilityLabel={props.accessibilityLabel}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class={surfaceClass()}
      style={{ minWidth: 44, minHeight: 44 }}
    >
      <If
        when={props.phase === "connecting"}
        else={
          <If
            when={props.phase === "speaking"}
            else={
              <If
                when={props.phase === "listening"}
                else={
                  <View
                    class="flex-row items-center justify-center gap-1"
                    style={{ height: 20 }}
                  >
                    <View
                      class="rounded-full bg-eye-core"
                      style={{ width: 2.5, height: 6 }}
                    />
                    <View
                      class="rounded-full bg-eye-core"
                      style={{ width: 2.5, height: 12 }}
                    />
                    <View
                      class="rounded-full bg-eye-core"
                      style={{ width: 2.5, height: 6 }}
                    />
                  </View>
                }
              >
                <View
                  class="flex-row items-center justify-center gap-1"
                  style={{ height: 20 }}
                >
                  <View
                    class={listeningBarClass()}
                    style={{ width: 2.5, height: barHeight(8, 5) }}
                  />
                  <View
                    class={listeningBarClass()}
                    style={{ width: 2.5, height: barHeight(16, 2) }}
                  />
                  <View
                    class={listeningBarClass()}
                    style={{ width: 2.5, height: barHeight(12, 6) }}
                  />
                  <View
                    class={listeningBarClass()}
                    style={{ width: 2.5, height: barHeight(8, 5) }}
                  />
                </View>
              </If>
            }
          >
            <View
              class="flex-row items-center justify-center gap-1"
              style={{ height: 20 }}
            >
              <View
                class="rounded-full bg-verified"
                style={{ width: 2.5, height: barHeight(8, 7) }}
              />
              <View
                class="bg-verified"
                style={{ width: 8, height: 8, borderRadius: 2.5 }}
              />
              <View
                class="rounded-full bg-verified"
                style={{ width: 2.5, height: barHeight(8, 7) }}
              />
            </View>
          </If>
        }
      >
        <View
          class="flex-row items-center justify-center gap-1"
          style={{ height: 20 }}
        >
          <View class="w-1.5 h-1.5 rounded-full bg-warning" />
          <View class="w-1.5 h-1.5 rounded-full bg-warning" />
          <View class="w-1.5 h-1.5 rounded-full bg-warning" />
        </View>
      </If>
    </Button>
  );
}

/** 7-bar symmetric acoustic wave ornament matching LooiWaveOrnament. */
export function WaveOrnament(props: { compact?: boolean }) {
  const scale = () => (props.compact ? 0.72 : 1);
  return (
    <View
      class="flex-row items-center gap-1"
      style={{ opacity: 0.6, height: 24 }}
    >
      {WAVE_RATIOS.map((ratio) => (
        <View
          class="rounded-full bg-eye-core"
          style={{
            width: 2.5,
            height: Math.max(4, Math.round(24 * ratio * scale())),
          }}
        />
      ))}
    </View>
  );
}

/** Bottom wake guide bar for the pure-face home screen. */
export function WakeGuideBar(props: { onPress: () => void; active: boolean }) {
  const narrow = () => windowSize().width < 440;
  return (
    <Button
      testID="wake-guide"
      accessibilityLabel={props.active ? t("sayHeyLooiToWakeMeOr") : t("tapToStartALiveVoiceConversation")}
      onPress={() => props.onPress()}
      class="flex-row items-center justify-center gap-3 px-3 py-1 active:opacity-75"
      style={{ minHeight: 52 }}
    >
      <If when={!narrow()}>
        <WaveOrnament />
      </If>
      <View
        class="relative flex-row items-center justify-center px-5 py-1.5"
        style={{ minHeight: 44 }}
      >
        <View
          class="absolute left-0 top-0 bottom-0 w-3 rounded-l-full border-l-2 border-stage-pill-border"
        />
        <Text
          class={
            narrow()
              ? "text-stage-muted text-sm text-center"
              : "text-stage-muted text-base text-center"
          }
        >
          <If when={props.active} else={<Text class="text-stage-muted">{t("tapToStartALiveVoiceConversation")}</Text>}>
            {t("wakeGuideActive")}{"  ·  "}
            <Text class="text-stage-muted text-xs">{t("tapToStartLive")}</Text>
          </If>
        </Text>
        <View
          class="absolute right-0 top-0 bottom-0 w-3 rounded-r-full border-r-2 border-stage-pill-border"
        />
      </View>
      <If when={!narrow()}>
        <WaveOrnament />
      </If>
    </Button>
  );
}

/** Glass subtitle capsule matching ConversationSubtitleOverlay. */
export function ResponsePreview(props: { text: string; onOpen: () => void }) {
  return (
    <Button
      testID="subtitle-capsule"
      accessibilityLabel={t("viewFullReply")}
      class="w-full rounded-full border border-stage-pill-border bg-glass-bg px-5 py-3 flex-row items-center gap-3 active:opacity-75"
      style={{ maxWidth: 720, minHeight: 54 }}
      onPress={() => props.onOpen()}
    >
      <View class="flex-row items-center gap-0.5">
        <View class="w-1 h-2.5 rounded-full bg-eye-core" />
        <View class="w-1 h-4 rounded-full bg-eye-core" />
        <View class="w-1 h-2.5 rounded-full bg-eye-core" />
      </View>
      <View class="flex-1 gap-0.5" style={{ minWidth: 0 }}>
        <Text
          class="text-stage-fg text-base font-medium"
          style={{ numberOfLines: 2 }}
        >
          {props.text}
        </Text>
        <If when={props.text.length > 48 || props.text.includes("\n")}>
          <Text class="text-stage-muted text-xs">{t("tapToViewFullReply")}</Text>
        </If>
      </View>
    </Button>
  );
}

/** Floating transient toast capsule matching LightToastCapsule. */
export function LightToast(props: { text: string; stage?: boolean }) {
  return (
    <View
      role="alert"
      class={
        props.stage
          ? "rounded-full border border-stage-pill-border bg-elevated-glass px-4 py-2 flex-row items-center gap-2 shadow-lg"
          : "rounded-full border border-border bg-card px-4 py-2 flex-row items-center gap-2 shadow-lg"
      }
      style={{ maxWidth: 520, minHeight: 40 }}
    >
      <View
        class={
          props.stage
            ? "w-2 h-2 rounded-full bg-eye-core"
            : "w-2 h-2 rounded-full bg-primary"
        }
      />
      <Text
        class={props.stage ? "text-stage-fg text-sm" : "text-foreground text-sm"}
        style={{ numberOfLines: 2, flexShrink: 1 }}
      >
        {props.text}
      </Text>
    </View>
  );
}

export function Panel(props: {
  open: boolean;
  title: string;
  onClose: () => void;
  children?: JSX.Element;
  dismissible?: boolean;
  height?: number;
  wide?: boolean;
}) {
  return (
    <Dialog
      open={props.open}
      animation="none"
      presentation="fullScreen"
      onOpenChange={(e) => {
        if (!e.open) props.onClose();
      }}
      closeOnEscape={props.dismissible !== false}
      closeOnSwipe={props.dismissible !== false}
      closeOnBackdropPress={props.dismissible !== false}
      class="m-auto rounded-3xl border border-border bg-popover p-6"
      backdropClass="bg-backdrop"
      style={{
        width: Math.min(props.wide ? 800 : 520, windowSize().width - 32),
        height: Math.max(
          100,
          Math.min(
            props.height ?? 420,
            windowSize().height - keyboardFrame().height - 32,
          ),
        ),
        marginBottom: keyboardFrame().height,
        padding: keyboardFrame().height ? 12 : 24,
      }}
    >
      <View class="flex-1 gap-3" style={{ minHeight: 0 }}>
        <View class="flex-row items-center justify-between gap-3">
          <Text class="text-foreground text-xl font-semibold" role="header">
            {props.title}
          </Text>
          <If when={props.dismissible !== false}>
            <ActionButton label={t("close")} onPress={() => props.onClose()} />
          </If>
        </View>
        <Scroll testID="panel-content" class="flex-1" style={{ minHeight: 0 }}>
          <View class="gap-4">{props.children}</View>
        </Scroll>
      </View>
    </Dialog>
  );
}

/** App-owned toggle switch row using `Switch` from `nsh/base` with styled track and thumb parts. */
export function SwitchRow(props: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  testID?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <View class="min-h-12 rounded-xl bg-muted border border-border px-3.5 py-2 flex-row items-center justify-between gap-3">
      <Text class="text-foreground text-sm font-medium flex-1" style={{ numberOfLines: 1 }}>
        {props.label}
      </Text>
      <Switch
        testID={props.testID}
        accessibilityLabel={props.label}
        checked={props.checked}
        disabled={props.disabled}
        hitSlop={8}
        onChange={(ev) => props.onChange(ev.checked)}
        class="flex-row items-center justify-center disabled:opacity-40"
        trackClass="w-11 h-6 rounded-full bg-border border border-border p-0.5 justify-center checked:bg-primary checked:border-primary"
        thumbClass="w-5 h-5 rounded-full bg-card checked:bg-primary-foreground checked:translate-x-5"
      />
    </View>
  );
}

/** App-owned vertical slider using `Slider` from `nsh/base` with styled track, indicator, range and thumb parts. */
export function VerticalPitchSlider(props: {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  accessibilityLabel: string;
  testID?: string;
  onChange: (value: number) => void;
  onChangeEnd?: (value: number) => void;
}) {
  return (
    <Slider
      testID={props.testID}
      axis="vertical"
      min={props.min}
      max={props.max}
      step={props.step}
      value={props.value}
      disabled={props.disabled}
      accessibilityLabel={props.accessibilityLabel}
      onChange={(ev) => {
        if (typeof ev.value === "number") {
          props.onChange(ev.value);
        }
      }}
      onChangeEnd={(ev) => {
        if (typeof ev.value === "number") {
          props.onChangeEnd?.(ev.value);
        }
      }}
      class="w-11 h-28 items-center justify-center disabled:opacity-40"
      trackClass="w-11 h-full items-center justify-center"
      indicatorClass="w-2 h-full rounded-full bg-border items-center"
      rangeClass="w-2 rounded-full bg-foreground"
      thumbClass="w-5 h-5 rounded-full bg-foreground border-2 border-card active:scale-110 focus:border-ring"
    />
  );
}

/** App-owned horizontal slider using `Slider` from `nsh/base` with styled track, indicator, range and thumb parts. */
export function HorizontalValueSlider(props: {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  accessibilityLabel: string;
  testID?: string;
  onChange: (value: number) => void;
  onChangeEnd?: (value: number) => void;
}) {
  return (
    <Slider
      testID={props.testID}
      axis="horizontal"
      min={props.min}
      max={props.max}
      step={props.step}
      value={props.value}
      disabled={props.disabled}
      accessibilityLabel={props.accessibilityLabel}
      onChange={(ev) => {
        if (typeof ev.value === "number") {
          props.onChange(ev.value);
        }
      }}
      onChangeEnd={(ev) => {
        if (typeof ev.value === "number") {
          props.onChangeEnd?.(ev.value);
        }
      }}
      class="w-full h-11 items-center justify-center disabled:opacity-40"
      trackClass="w-full h-11 justify-center"
      indicatorClass="w-full h-2 rounded-full bg-border justify-center"
      rangeClass="h-2 rounded-full bg-foreground"
      thumbClass="w-5 h-5 rounded-full bg-foreground border-2 border-card active:scale-110 focus:border-ring"
    />
  );
}

const WHEEL_DEADZONE_RATIO = 0.12;
const WHEEL_DRAG_ACTIVATE_PT = 5;

function computeSteplessMotion(
  rawDx: number,
  rawDy: number,
  maxTravel: number,
): { clampedDx: number; clampedDy: number; speed: number; turn: number } {
  const dist = Math.hypot(rawDx, rawDy);
  if (dist <= 0 || maxTravel <= 0) {
    return { clampedDx: 0, clampedDy: 0, speed: 0, turn: 0 };
  }
  const clampedDist = Math.min(dist, maxTravel);
  const ux = rawDx / dist;
  const uy = rawDy / dist;
  const clampedDx = ux * clampedDist;
  const clampedDy = uy * clampedDist;
  const norm = clampedDist / maxTravel;
  if (norm < WHEEL_DEADZONE_RATIO) {
    return { clampedDx, clampedDy, speed: 0, turn: 0 };
  }
  const mag = (norm - WHEEL_DEADZONE_RATIO) / (1 - WHEEL_DEADZONE_RATIO);
  const speed = Math.max(-127, Math.min(127, Math.round(-uy * mag * 127)));
  const turn = Math.max(-127, Math.min(127, Math.round(-ux * mag * 127)));
  return { clampedDx, clampedDy, speed, turn };
}

/**
 * 360-degree stepless analog directional joystick wheel (Honor of Kings style).
 * Claims responder gestures inside Scroll containers, ignores pure taps (<5pt),
 * maps 2D thumb displacement to signed `(speed, turn)` in `-127..127`, and
 * immediately resets + invokes `onRelease` when lifted, cancelled, or disabled.
 */
export function SteplessWheel(props: {
  disabled?: boolean;
  size?: number;
  resetToken?: number;
  accessibilityLabel: string;
  testID?: string;
  onVectorChange: (speed: number, turn: number) => void;
  onRelease: () => void;
}) {
  const wheelSize = () => props.size ?? 132;
  const puckRadius = 22;
  const maxTravel = () => Math.max(18, wheelSize() / 2 - 4 - puckRadius - 4);
  const thumb = signal<{
    dx: number;
    dy: number;
    active: boolean;
    engaged: boolean;
  }>({
    dx: 0,
    dy: 0,
    active: false,
    engaged: false,
  });

  let activeTouchId: number | null = null;
  let disarmedUntilGrant = false;
  let lastResetToken = props.resetToken ?? 0;
  let startPageX = 0;
  let startPageY = 0;
  let startLocalX = 0;
  let startLocalY = 0;
  let lastSpeed = 0;
  let lastTurn = 0;
  let emittedNonZero = false;

  const releaseWheel = (disarm = false) => {
    if (disarm) {
      disarmedUntilGrant = true;
    }
    const current = thumb();
    const shouldNotifyRelease =
      current.engaged || emittedNonZero || lastSpeed !== 0 || lastTurn !== 0;
    activeTouchId = null;
    lastSpeed = 0;
    lastTurn = 0;
    emittedNonZero = false;
    if (current.active || current.dx !== 0 || current.dy !== 0 || current.engaged) {
      thumb.set({ dx: 0, dy: 0, active: false, engaged: false });
    }
    if (shouldNotifyRelease) {
      props.onRelease();
    }
  };

  effect(() => {
    const currentToken = props.resetToken ?? 0;
    if (currentToken !== lastResetToken) {
      lastResetToken = currentToken;
      releaseWheel(true);
      return;
    }
    if (props.disabled || lifecycle() !== "active") {
      releaseWheel(true);
    }
  });

  cleanup(() => {
    releaseWheel(true);
  });

  const resolveTouch = (ev: GestureResponderEvent): TouchPoint | null => {
    if (activeTouchId === null) return null;
    if (Array.isArray(ev.touches) && ev.touches.length > 0) {
      return ev.touches.find((item) => item.identifier === activeTouchId) ?? null;
    }
    return ev.identifier === activeTouchId ? ev : null;
  };

  return (
    <Canvas
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      style={{
        width: wheelSize(),
        height: wheelSize(),
        opacity: props.disabled ? 0.42 : 1,
      }}
      onStartShouldSetResponder={() => !props.disabled}
      onMoveShouldSetResponder={() => !props.disabled && !disarmedUntilGrant}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(ev) => {
        if (props.disabled) return false;
        if (activeTouchId !== null) {
          return true;
        }
        disarmedUntilGrant = false;
        activeTouchId = ev.identifier;
        startPageX = ev.pageX;
        startPageY = ev.pageY;
        startLocalX = ev.locationX;
        startLocalY = ev.locationY;
        lastSpeed = 0;
        lastTurn = 0;
        emittedNonZero = false;
        thumb.set({ dx: 0, dy: 0, active: true, engaged: false });
        return true;
      }}
      onResponderMove={(ev) => {
        if (props.disabled || disarmedUntilGrant) {
          releaseWheel(disarmedUntilGrant);
          return;
        }
        const point = resolveTouch(ev);
        if (!point) {
          releaseWheel();
          return;
        }
        const dragDx = point.pageX - startPageX;
        const dragDy = point.pageY - startPageY;
        const dragDist = Math.hypot(dragDx, dragDy);
        const engaged = thumb().engaged || dragDist >= WHEEL_DRAG_ACTIVATE_PT;
        if (!engaged) {
          return;
        }
        const half = wheelSize() / 2;
        const rawDx = startLocalX + dragDx - half;
        const rawDy = startLocalY + dragDy - half;
        const { clampedDx, clampedDy, speed, turn } = computeSteplessMotion(
          rawDx,
          rawDy,
          maxTravel(),
        );
        thumb.set({ dx: clampedDx, dy: clampedDy, active: true, engaged: true });
        if (speed !== lastSpeed || turn !== lastTurn) {
          lastSpeed = speed;
          lastTurn = turn;
          if (speed !== 0 || turn !== 0) {
            emittedNonZero = true;
          }
          props.onVectorChange(speed, turn);
        }
      }}
      onResponderEnd={(ev) => {
        if (activeTouchId === null) return;
        const primaryLifted =
          ev.identifier === activeTouchId ||
          (Array.isArray(ev.changedTouches) &&
            ev.changedTouches.some((item) => item.identifier === activeTouchId)) ||
          (Array.isArray(ev.touches) &&
            ev.touches.length > 0 &&
            !ev.touches.some((item) => item.identifier === activeTouchId));
        if (primaryLifted) {
          releaseWheel();
        }
      }}
      onResponderRelease={() => {
        disarmedUntilGrant = false;
        releaseWheel();
      }}
      onResponderTerminate={() => {
        disarmedUntilGrant = false;
        releaseWheel();
      }}
      draw={(cx, canvasSize) => {
        const state = thumb();
        const w = canvasSize.width || wheelSize();
        const h = canvasSize.height || wheelSize();
        const centerX = w / 2;
        const centerY = h / 2;
        const outerRadius = Math.max(32, Math.min(w, h) / 2 - 4);
        const orbitRadius = Math.max(18, outerRadius - puckRadius - 4);

        const cardColor = token("card");
        const secondaryColor = token("secondary");
        const borderColor = token("border");
        const subtleColor = token("subtle-text");
        const mutedFgColor = token("muted-foreground");
        const fgColor = token("foreground");
        const primaryColor = token("primary");
        const primaryFgColor = token("primary-foreground");

        // 1. Outer recessed compass base disc
        cx.beginPath();
        cx.arc(centerX, centerY, outerRadius, 0, Math.PI * 2);
        cx.fillStyle = cardColor;
        cx.fill();
        cx.lineWidth = 1.5;
        cx.strokeStyle = borderColor;
        cx.stroke();

        // 2. Subtle 8-way compass ticks around outer rim
        for (let i = 0; i < 8; i++) {
          const tickAngle = (i * Math.PI) / 4;
          const isCardinal = i % 2 === 0;
          const rOuter = outerRadius - 5;
          const rInner = rOuter - (isCardinal ? 5.5 : 3.5);
          cx.beginPath();
          cx.moveTo(
            centerX + Math.cos(tickAngle) * rInner,
            centerY + Math.sin(tickAngle) * rInner,
          );
          cx.lineTo(
            centerX + Math.cos(tickAngle) * rOuter,
            centerY + Math.sin(tickAngle) * rOuter,
          );
          cx.lineWidth = isCardinal ? 1.5 : 1;
          cx.lineCap = "round";
          cx.strokeStyle = isCardinal ? subtleColor : borderColor;
          cx.stroke();
        }

        // 3. Inner stepless orbit ring
        cx.beginPath();
        cx.arc(centerX, centerY, orbitRadius, 0, Math.PI * 2);
        cx.lineWidth = 1;
        cx.strokeStyle = borderColor;
        cx.stroke();

        // 4. Active directional rim arc + outward chevron + tether
        const offsetDist = Math.hypot(state.dx, state.dy);
        const activeVector =
          state.engaged && offsetDist >= orbitRadius * WHEEL_DEADZONE_RATIO;

        if (activeVector) {
          const heading = Math.atan2(state.dy, state.dx);
          const arcSpan = 0.52;

          cx.beginPath();
          cx.arc(
            centerX,
            centerY,
            outerRadius - 1.5,
            heading - arcSpan,
            heading + arcSpan,
          );
          cx.lineWidth = 3.5;
          cx.lineCap = "round";
          cx.strokeStyle = primaryColor;
          cx.stroke();

          // Outward directional chevron tip near rim
          const tipRadius = outerRadius - 6;
          const tipX = centerX + Math.cos(heading) * tipRadius;
          const tipY = centerY + Math.sin(heading) * tipRadius;
          const wingBack = 5.5;
          const wingSpread = 4.2;
          const perpX = -Math.sin(heading);
          const perpY = Math.cos(heading);
          const baseX = tipX - Math.cos(heading) * wingBack;
          const baseY = tipY - Math.sin(heading) * wingBack;
          cx.beginPath();
          cx.moveTo(tipX, tipY);
          cx.lineTo(baseX + perpX * wingSpread, baseY + perpY * wingSpread);
          cx.lineTo(baseX - perpX * wingSpread, baseY - perpY * wingSpread);
          cx.closePath();
          cx.fillStyle = primaryColor;
          cx.fill();

          // Center anchor dot + tether line
          cx.beginPath();
          cx.arc(centerX, centerY, 3.5, 0, Math.PI * 2);
          cx.fillStyle = mutedFgColor;
          cx.fill();

          cx.beginPath();
          cx.moveTo(centerX, centerY);
          cx.lineTo(centerX + state.dx, centerY + state.dy);
          cx.lineWidth = 2;
          cx.lineCap = "round";
          cx.strokeStyle = mutedFgColor;
          cx.stroke();
        }

        // 5. Movable 44x44pt thumb puck
        const puckX = centerX + state.dx;
        const puckY = centerY + state.dy;
        cx.beginPath();
        cx.arc(puckX, puckY, puckRadius, 0, Math.PI * 2);
        cx.fillStyle = activeVector ? primaryColor : secondaryColor;
        cx.fill();
        cx.lineWidth = activeVector ? 2 : 1.5;
        cx.strokeStyle = activeVector ? cardColor : borderColor;
        cx.stroke();

        // Inner tactile center dot on puck
        cx.beginPath();
        cx.arc(puckX, puckY, 4.5, 0, Math.PI * 2);
        cx.fillStyle = activeVector ? primaryFgColor : fgColor;
        cx.fill();
      }}
    />
  );
}
