import { Text, View, Scroll, keyboardFrame, windowSize, type JSX } from "nsh";
import { Button, Input, Dialog } from "nsh/base";

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

const WAVE_RATIOS = [0.34, 0.56, 0.84, 1, 0.78, 0.52, 0.34];

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
export function WakeGuideBar(props: { onPress: () => void }) {
  const narrow = () => windowSize().width < 440;
  return (
    <Button
      testID="wake-guide"
      accessibilityLabel="说 Hey LOOI 唤醒我，或轻触开启 LIVE 对话"
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
          说 <Text class="text-stage-fg font-medium">Hey LOOI</Text> 唤醒我
          {"  ·  "}
          <Text class="text-stage-muted text-xs">轻触开启 LIVE 对话</Text>
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
      accessibilityLabel="查看完整回复"
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
          <Text class="text-stage-muted text-xs">轻触查看完整回复</Text>
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
          ? "rounded-full border border-stage-pill-border bg-elevated-glass px-4 py-2 flex-row items-center gap-2"
          : "rounded-full border border-border bg-card px-4 py-2 flex-row items-center gap-2"
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
            <ActionButton label="关闭" onPress={() => props.onClose()} />
          </If>
        </View>
        <Scroll testID="panel-content" class="flex-1" style={{ minHeight: 0 }}>
          <View class="gap-4">{props.children}</View>
        </Scroll>
      </View>
    </Dialog>
  );
}
