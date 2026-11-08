import { t, translateMessage, formatDate } from "../i18n";
import { signal, Text, View, Scroll, keyboardFrame, reduceMotion, windowSize, type JSX } from "nsh";
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
      class="w-11 h-20 items-center justify-center disabled:opacity-40"
      trackClass="w-11 h-full items-center justify-center"
      indicatorClass="w-2 h-full rounded-full bg-border items-center"
      rangeClass="w-2 rounded-full bg-foreground"
      thumbClass="w-5 h-5 rounded-full bg-foreground border-2 border-card active:scale-110 focus:border-ring"
    />
  );
}
