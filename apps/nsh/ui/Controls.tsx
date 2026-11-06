import { Text, View, Scroll, keyboardFrame, windowSize, type JSX } from "nsh";
import { Button, Input, Dialog } from "nsh/base";

/** App-owned controls: shared touch targets, focus, disabled and press states. */
export function ActionButton(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  kind?: "primary" | "quiet" | "danger";
  testID?: string;
}) {
  return (
    <Button
      testID={props.testID}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class={
        props.kind === "primary"
          ? "min-h-12 rounded-full bg-primary px-5 items-center justify-center active:opacity-70 focus:border-ring disabled:opacity-35"
          : props.kind === "danger"
            ? "min-h-12 rounded-full border border-destructive px-5 items-center justify-center active:opacity-60 disabled:opacity-35"
            : "min-h-12 rounded-full border border-border bg-card px-5 items-center justify-center active:bg-muted focus:border-ring disabled:opacity-35"
      }
    >
      <Text
        class={
          props.kind === "primary"
            ? "text-primary-foreground text-base font-semibold"
            : props.kind === "danger"
              ? "text-destructive text-base font-medium"
              : "text-foreground text-base font-medium"
        }
      >
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

/** Keep the face quiet while every answer remains available in full. */
export function ResponsePreview(props: { text: string; onOpen: () => void }) {
  return (
    <Button
      accessibilityLabel="查看完整回复"
      class="w-full rounded-xl p-2 items-center active:opacity-70"
      onPress={() => props.onOpen()}
    >
      <Text
        class="text-foreground text-base text-center"
        style={{ numberOfLines: 2 }}
      >
        {props.text}
      </Text>
      <If when={props.text.length > 40 || props.text.includes("\n")}>
        <Text class="text-muted-foreground text-xs">查看完整回复</Text>
      </If>
    </Button>
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
      animation="fade"
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
