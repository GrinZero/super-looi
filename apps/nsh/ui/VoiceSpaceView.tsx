import { t, translateMessage } from "../i18n";
import {
  Canvas,
  Clipboard,
  reduceMotion,
  signal,
  Text,
  token,
  View,
  Scroll,
  windowSize,
} from "nsh";
import { Button, Input, Switch } from "nsh/base";
import type { createAppStore } from "../store";
import { ActionButton, SelectField } from "./Controls";
import {
  DOUBAO_DEFAULT_VOICE_ID,
  DOUBAO_VOICES,
  doubaoVoicePreset,
} from "./doubao-voices";

const STAGE_WAVE_RATIOS = [
  0.14, 0.14, 0.24, 0.52, 0.34, 0.82, 0.56, 1, 0.56, 0.82, 0.34, 0.52, 0.24,
  0.14, 0.14,
];

function VoiceInlineIcon(props: {
  kind: "mic" | "mic_off" | "stop" | "play" | "check";
  tone?: "foreground" | "primaryFg" | "muted";
  size?: number;
}) {
  const box = () => props.size ?? 16;
  const resolveColor = () => {
    if (props.tone === "primaryFg") return token("primary-foreground");
    if (props.tone === "muted") return token("muted-foreground");
    return token("foreground");
  };

  return (
    <Canvas
      style={{ width: box(), height: box() }}
      draw={(cx, size) => {
        cx.clearRect(0, 0, size.width, size.height);
        cx.save();
        cx.scale(size.width / 24, size.height / 24);
        const color = resolveColor();
        cx.strokeStyle = color;
        cx.fillStyle = color;
        cx.lineWidth = 2;
        cx.lineCap = "round";
        cx.lineJoin = "round";

        if (props.kind === "mic" || props.kind === "mic_off") {
          cx.beginPath();
          cx.moveTo(9, 6);
          cx.arc(12, 6, 3, Math.PI, 0, false);
          cx.lineTo(15, 11);
          cx.arc(12, 11, 3, 0, Math.PI, false);
          cx.closePath();
          cx.stroke();

          cx.beginPath();
          cx.arc(12, 11, 6.5, 0, Math.PI, false);
          cx.stroke();

          cx.beginPath();
          cx.moveTo(12, 17.5);
          cx.lineTo(12, 21);
          cx.moveTo(8.5, 21);
          cx.lineTo(15.5, 21);
          cx.stroke();

          if (props.kind === "mic_off") {
            cx.beginPath();
            cx.moveTo(4, 4);
            cx.lineTo(20, 20);
            cx.stroke();
          }
        } else if (props.kind === "stop") {
          cx.beginPath();
          cx.moveTo(8, 6.5);
          cx.lineTo(16, 6.5);
          cx.quadraticCurveTo(17.5, 6.5, 17.5, 8);
          cx.lineTo(17.5, 16);
          cx.quadraticCurveTo(17.5, 17.5, 16, 17.5);
          cx.lineTo(8, 17.5);
          cx.quadraticCurveTo(6.5, 17.5, 6.5, 16);
          cx.lineTo(6.5, 8);
          cx.quadraticCurveTo(6.5, 6.5, 8, 6.5);
          cx.closePath();
          cx.stroke();
        } else if (props.kind === "play") {
          cx.beginPath();
          cx.moveTo(8, 6);
          cx.lineTo(18, 12);
          cx.lineTo(8, 18);
          cx.closePath();
          cx.fill();
        } else if (props.kind === "check") {
          cx.lineWidth = 2.6;
          cx.beginPath();
          cx.moveTo(6, 12.5);
          cx.lineTo(10.2, 16.5);
          cx.lineTo(18, 8);
          cx.stroke();
        }
        cx.restore();
      }}
    />
  );
}

/** Top context bar for the Voice space: clean page title without duplicate provider pills. */
export function VoiceServiceBar(_props: {
  store: ReturnType<typeof createAppStore>;
}) {
  return (
    <View class="flex-1 min-w-0 h-11 flex-row items-center">
      <Text class="text-foreground text-base font-bold">{t("liveVoice")}</Text>
    </View>
  );
}

/** Inline voice conversation stage, voice audition, and modernized credential inspector. */
export function VoiceSpaceView(props: {
  store: ReturnType<typeof createAppStore>;
}) {
  const voiceKey = signal("");
  const showPlainKey = signal(false);
  const editingKey = signal(false);
  const replacingKey = signal(false);
  const keyError = signal("");

  const editingVoice = signal(false);
  const voiceModeTab = signal<"preset" | "custom">("preset");
  const voiceIdDraft = signal("");
  const voiceError = signal("");

  const state = () => props.store.voiceState();
  const isPreviewing = () => state().purpose === "preview";
  const active = () =>
    ["connecting", "listening", "speaking"].includes(state().phase);
  const connected = () => ["listening", "speaking"].includes(state().phase);
  const inConversation = () => active() && !isPreviewing();
  const audioActive = () =>
    state().phase === "speaking" ||
    (state().phase === "listening" && !state().muted);

  const keyDrawerOpen = () => !props.store.voiceConfigured() || editingKey();
  const keyInputOpen = () => !props.store.voiceConfigured() || replacingKey();

  const voiceNeedsReconnect = () =>
    connected() &&
    !isPreviewing() &&
    state().activeVoiceId !== undefined &&
    state().activeVoiceId !== props.store.voiceId();

  const effectivePreviewVoiceId = () => {
    if (!editingVoice()) return props.store.voiceId();
    const draft = voiceIdDraft().trim();
    return draft === DOUBAO_DEFAULT_VOICE_ID ? "" : draft;
  };

  const currentTimbreSummary = () => {
    const saved = props.store.voiceId();
    if (!saved) return t("defaultVoice");
    const preset = doubaoVoicePreset(saved);
    return preset ? t(preset.name) : saved;
  };

  const stageBadgeText = () => {
    const provider = props.store.voiceProviderLabel();
    const current = state();
    if (isPreviewing()) {
      return `${provider} · ${t("voiceBadgePreviewing")}`;
    }
    if (connected()) {
      return `${provider} · ${t("voiceBadgeInCall")}`;
    }
    if (current.phase === "connecting") {
      return `${provider} · ${t("voiceBadgeConnecting")}`;
    }
    if (current.phase === "standby") {
      return `${provider} · ${t("voiceBadgeStandby")}`;
    }
    if (props.store.voiceConfigured()) {
      return `${provider} · ${t("voiceBadgeReady")}`;
    }
    return `${provider} · ${t("voiceBadgeUnconfigured")}`;
  };

  const stageDotClass = () => {
    const current = state();
    if (current.phase === "connecting" || current.phase === "permission") {
      return "w-2 h-2 rounded-full bg-warning";
    }
    if (
      connected() ||
      current.phase === "standby" ||
      props.store.voiceConfigured()
    ) {
      return "w-2 h-2 rounded-full bg-verified";
    }
    return "w-2 h-2 rounded-full bg-border";
  };

  const statusLabel = () => {
    const current = state();
    if (isPreviewing()) {
      return current.phase === "connecting"
        ? t("voicePreparingPreviewStatus")
        : t("voicePreviewingStatus");
    }
    switch (current.phase) {
      case "permission":
        return t("voiceAwaitingMicrophone");
      case "connecting":
        return t("voiceConnectingStatus");
      case "speaking":
        return t("voiceSpeakingStatus");
      case "listening":
        return current.muted ? t("voiceMicMuted") : t("voiceListeningStatus");
      case "error":
        return t("voiceSessionInterrupted");
      case "standby":
        return t("voiceWakeStandby");
      default:
        return props.store.voiceConfigured()
          ? t("voiceReadyToTalk")
          : t("voiceNeedsCredentials");
    }
  };

  const statusDetail = () => {
    const current = state();
    if (current.phase === "permission") return t("voicePermissionHint");
    if (current.phase === "connecting") return t("voiceConnectingHint");
    if (connected()) {
      return t(current.muted ? "voiceUnmuteHint" : "voiceConversationLive");
    }
    if (!props.store.voiceConfigured()) return t("voiceSaveKeyToStart");
    return t(
      current.phase === "standby" ? "voiceStartOrWake" : "voiceTapToStart",
    );
  };

  const saveKeyButtonLabel = () => {
    if (isPreviewing() && active()) return t("voiceSaveAndStopPreview");
    if (inConversation()) return t("voiceSaveAndEndCall");
    return t("voiceSaveKeyBtn");
  };

  const saveVoiceKey = () => {
    const trimmed = voiceKey().trim();
    if (!props.store.ready() || !trimmed) return;
    try {
      props.store.configureVoice(trimmed);
      voiceKey.set("");
      showPlainKey.set(false);
      keyError.set("");
      replacingKey.set(false);
      editingKey.set(false);
      props.store.notify("@looi:voiceKeySavedToast");
    } catch (cause) {
      keyError.set(
        cause instanceof Error
          ? cause.message
          : "@looi:couldNotSaveVoiceSettings",
      );
    }
  };

  const pasteKeyFromClipboard = async () => {
    try {
      const text = (await Clipboard.readText())?.trim() ?? "";
      if (!text) {
        props.store.notify("@looi:voiceClipboardEmpty");
        return;
      }
      voiceKey.set(text);
      keyError.set("");
    } catch {
      props.store.notify("@looi:voiceClipboardEmpty");
    }
  };

  const pasteSpeakerIdFromClipboard = async () => {
    try {
      const text = (await Clipboard.readText())?.trim() ?? "";
      if (!text) {
        props.store.notify("@looi:voiceClipboardEmpty");
        return;
      }
      voiceModeTab.set("custom");
      voiceIdDraft.set(text);
      voiceError.set("");
    } catch {
      props.store.notify("@looi:voiceClipboardEmpty");
    }
  };

  const saveVoiceId = () => {
    if (!props.store.ready()) return;
    const candidate = voiceIdDraft().trim();
    if (!candidate) return;
    const nextId = candidate === DOUBAO_DEFAULT_VOICE_ID ? "" : candidate;
    try {
      if (isPreviewing() && active()) props.store.stopVoice();
      props.store.configureVoiceId(nextId);
      voiceError.set("");
      editingVoice.set(false);
      props.store.notify("@looi:voiceSpeakerSavedToast");
    } catch (cause) {
      voiceError.set(
        cause instanceof Error ? cause.message : "@looi:couldNotSaveSpeakerId",
      );
    }
  };

  const handlePreviewVoice = () => {
    if (!props.store.ready() || !props.store.voiceConfigured()) return;
    if (isPreviewing() && active()) {
      props.store.stopVoice();
      return;
    }
    const candidate = effectivePreviewVoiceId();
    if (
      editingVoice() &&
      voiceModeTab() === "custom" &&
      candidate &&
      !/^[A-Za-z0-9_-]{1,256}$/.test(candidate)
    ) {
      voiceError.set("@looi:runtimeEnterAValidDoubaoSpeakerId");
      return;
    }
    voiceError.set("");
    void props.store.previewVoice(candidate);
  };

  const renderSession = (compact = false) => (
    <View
      testID="voice-session"
      class={
        compact
          ? "rounded-2xl border border-border bg-card px-5 py-6 items-center justify-between gap-4"
          : "flex-1 px-6 py-5 items-center justify-between gap-3 bg-card"
      }
    >
      {/* Top Status Capsule */}
      <View
        testID="voice-stage-badge"
        class="px-3.5 py-1.5 rounded-full bg-muted flex-row items-center gap-2"
      >
        <View class={stageDotClass()} />
        <Text class="text-foreground text-xs font-semibold">
          {stageBadgeText()}
        </Text>
      </View>

      {/* Center Waveform, Heading & Live Dialogue Turn */}
      <View class="w-full items-center justify-center gap-3 my-auto py-1">
        <View
          class="h-12 flex-row items-center justify-center gap-1.5"
          accessibilityElementsHidden={true}
        >
          <Each of={STAGE_WAVE_RATIOS} key="index">
            {(ratio) => (
              <View
                class={
                  audioActive()
                    ? "w-1 rounded-full bg-foreground"
                    : connected()
                      ? "w-1 rounded-full bg-muted-foreground"
                      : "w-1 rounded-full bg-border"
                }
                style={{
                  height:
                    audioActive() && !reduceMotion()
                      ? Math.round(
                          4 +
                            ratio() *
                              (22 + props.store.voiceAudioLevel() * 22),
                        )
                      : Math.round(4 + ratio() * 34),
                }}
              />
            )}
          </Each>
        </View>

        <Text
          testID="voice-session-status"
          class="text-foreground text-2xl font-bold text-center"
        >
          {statusLabel()}
        </Text>

        <If
          when={
            !isPreviewing() &&
            Boolean(state().userTranscript || state().transcript)
          }
          else={
            <If
              when={isPreviewing()}
              else={
                <Text class="text-muted-foreground text-xs text-center px-4">
                  {statusDetail()}
                </Text>
              }
            >
              <Text
                class="text-muted-foreground text-sm text-center px-4"
                style={{ numberOfLines: 2 }}
              >
                {`“${state().transcript || t("voicePreviewSampleText")}”`}
              </Text>
            </If>
          }
        >
          <View
            class="w-full min-w-0 px-3 py-0.5 gap-1 items-start"
            selectable={true}
            style={{ maxWidth: 400 }}
          >
            <If when={Boolean(state().userTranscript)}>
              <View class="w-full min-w-0 flex-row items-start gap-1">
                <Text class="text-muted-foreground text-sm shrink-0">
                  {t("voiceTurnYou")}
                </Text>
                <Text
                  class="flex-1 min-w-0 text-foreground text-sm"
                  style={{ numberOfLines: 2, flexShrink: 1 }}
                >
                  {state().userTranscript}
                </Text>
              </View>
            </If>
            <If when={Boolean(state().transcript)}>
              <View class="w-full min-w-0 flex-row items-start gap-1">
                <Text class="text-muted-foreground text-sm shrink-0">
                  {t("voiceTurnLooi")}
                </Text>
                <Text
                  class="flex-1 min-w-0 text-foreground text-sm"
                  style={{ numberOfLines: 2, flexShrink: 1 }}
                >
                  {state().transcript}
                </Text>
              </View>
            </If>
          </View>
        </If>

        <If when={voiceNeedsReconnect()}>
          <View class="px-3 py-1.5 rounded-full border border-border bg-muted flex-row items-center gap-2">
            <Text class="text-muted-foreground text-xs">
              {t("voiceSavedReconnectHint")}
            </Text>
            <Button
              testID="apply-voice-reconnect-btn"
              hitSlop={10}
              onPress={() => void props.store.restartVoiceSession()}
              class="px-2.5 py-1 rounded-full bg-primary items-center justify-center active:opacity-75"
            >
              <Text class="text-primary-foreground text-xs font-semibold">
                {t("voiceApplyAndReconnect")}
              </Text>
            </Button>
          </View>
        </If>

        <If when={state().error}>
          <Text role="alert" class="text-destructive text-xs text-center px-3">
            {state().error}
          </Text>
        </If>
      </View>

      {/* Bottom Action Bar */}
      <View class="w-full flex-row flex-wrap items-center justify-center gap-3">
        <If when={connected() && !isPreviewing()}>
          <Button
            testID="voice-space-mute"
            onPress={() => props.store.muteVoice(!state().muted)}
            class="min-h-12 px-7 rounded-full border border-foreground bg-card flex-row items-center justify-center gap-2 active:bg-muted focus:border-ring"
          >
            <VoiceInlineIcon
              kind={state().muted ? "mic_off" : "mic"}
              tone="foreground"
              size={16}
            />
            <Text class="text-foreground text-sm font-semibold">
              {state().muted ? t("unmute247") : t("mute")}
            </Text>
          </Button>
          <If when={state().phase === "speaking"}>
            <Button
              testID="voice-space-interrupt"
              onPress={() => props.store.interruptVoice()}
              class="min-h-12 px-5 rounded-full border border-border bg-muted flex-row items-center justify-center active:opacity-75 focus:border-ring"
            >
              <Text class="text-foreground text-sm font-medium">
                {t("interrupt")}
              </Text>
            </Button>
          </If>
        </If>

        <Button
          testID="voice-space-toggle"
          disabled={
            !props.store.ready() ||
            (!props.store.voiceConfigured() && !active())
          }
          onPress={() => {
            if (active()) props.store.stopVoice();
            else void props.store.startVoice();
          }}
          class="min-h-12 px-9 rounded-full bg-primary flex-row items-center justify-center gap-2.5 active:opacity-80 focus:border-ring disabled:opacity-35"
        >
          <VoiceInlineIcon
            kind={active() ? "stop" : "mic"}
            tone="primaryFg"
            size={16}
          />
          <Text class="text-primary-foreground text-sm font-semibold">
            {active()
              ? isPreviewing()
                ? t("voiceStopPreview")
                : t("voiceEndConversation")
              : t("voiceStartConversation")}
          </Text>
        </Button>
      </View>
    </View>
  );

  const renderConfiguration = (compact = false) => (
    <View
      testID="voice-configuration"
      class={
        compact
          ? "rounded-2xl border border-border bg-card p-4 gap-4"
          : "gap-3 bg-card"
      }
    >
      {/* Section 1: Voice Services & Modernized Key Management */}
      <View class="gap-1.5">
        <Text role="header" class="text-foreground text-sm font-bold">
          {t("voiceServiceSection")}
        </Text>

        {/* Active Provider Row (Doubao) */}
        <View
          testID="voice-current-provider"
          class="min-h-11 rounded-xl bg-muted px-3 py-2 flex-row items-center justify-between gap-2"
        >
          <View class="flex-row items-center gap-2.5 flex-1 min-w-0">
            <View
              class={
                props.store.voiceConfigured()
                  ? "w-5 h-5 rounded-full bg-verified items-center justify-center shrink-0"
                  : "w-5 h-5 rounded-full border-2 border-foreground bg-card items-center justify-center shrink-0"
              }
            >
              <If
                when={props.store.voiceConfigured()}
                else={<View class="w-2 h-2 rounded-full bg-foreground" />}
              >
                <VoiceInlineIcon kind="check" tone="primaryFg" size={12} />
              </If>
            </View>
            <Text
              class="text-foreground text-sm font-bold"
              style={{ numberOfLines: 1 }}
            >
              {props.store.voiceProviderLabel()}
            </Text>
            <View class="px-2 py-0.5 rounded-full bg-card border border-border">
              <Text
                class={
                  props.store.voiceConfigured()
                    ? "text-verified text-xs font-semibold"
                    : "text-muted-foreground text-xs"
                }
              >
                {props.store.voiceConfigured()
                  ? t("voiceConfiguredBadge")
                  : t("voiceUnconfiguredBadge")}
              </Text>
            </View>
          </View>

          <Button
            testID="edit-voice-key"
            hitSlop={6}
            onPress={() => {
              if (editingKey()) {
                editingKey.set(false);
                replacingKey.set(false);
                voiceKey.set("");
                keyError.set("");
              } else {
                editingKey.set(true);
                replacingKey.set(!props.store.voiceConfigured());
              }
            }}
            class="min-h-9 px-2 rounded-lg items-center justify-center active:bg-card"
          >
            <Text class="text-foreground text-xs font-medium">
              {editingKey() && props.store.voiceConfigured()
                ? t("voiceCollapseAction")
                : props.store.voiceConfigured()
                  ? t("voiceManageAction")
                  : t("voiceConfigureAction")}
            </Text>
          </Button>
        </View>

        {/* Modern Key Management Drawer */}
        <If when={keyDrawerOpen()}>
          <View class="rounded-xl border border-border bg-background p-3 gap-2.5">
            <If
              when={keyInputOpen()}
              else={
                <View class="gap-2.5">
                  <View class="flex-row items-center justify-between gap-2">
                    <View class="flex-1 min-w-0 gap-0.5">
                      <Text class="text-muted-foreground text-xs">
                        {t("voiceKeychainStoredLabel")}
                      </Text>
                      <Text class="text-foreground text-xs font-mono font-semibold">
                        {props.store.voiceKeyHint() || "••••••••••••"}
                      </Text>
                    </View>
                    <View class="px-2 py-0.5 rounded-full bg-muted border border-border flex-row items-center gap-1.5">
                      <View class="w-1.5 h-1.5 rounded-full bg-verified" />
                      <Text class="text-verified text-xs font-medium">
                        {t("voiceCredentialsSaved")}
                      </Text>
                    </View>
                  </View>

                  <View class="flex-row items-center justify-end gap-2 pt-2 border-t border-border">
                    <ActionButton
                      label={t("voiceClearKey")}
                      testID="clear-voice-key-btn"
                      kind="danger"
                      compact={true}
                      onPress={() => {
                        props.store.clearVoiceCredentials();
                        replacingKey.set(true);
                        editingKey.set(false);
                        props.store.notify("@looi:voiceKeyClearedToast");
                      }}
                    />
                    <ActionButton
                      label={t("voiceReplaceKey")}
                      testID="replace-voice-key-btn"
                      compact={true}
                      onPress={() => {
                        replacingKey.set(true);
                        voiceKey.set("");
                        keyError.set("");
                      }}
                    />
                  </View>
                </View>
              }
            >
              <View class="gap-2">
                <View class="flex-row items-center justify-between gap-2">
                  <Text class="text-muted-foreground text-xs font-medium">
                    API Key
                  </Text>
                  <View class="flex-row items-center gap-1.5">
                    <Button
                      testID="paste-voice-key-btn"
                      hitSlop={6}
                      onPress={() => void pasteKeyFromClipboard()}
                      class="min-h-8 px-2.5 rounded-lg border border-border bg-card items-center justify-center active:bg-muted"
                    >
                      <Text class="text-foreground text-xs font-medium">
                        {t("voicePasteKey")}
                      </Text>
                    </Button>
                    <Button
                      testID="toggle-voice-key-mask"
                      hitSlop={6}
                      onPress={() => showPlainKey.set(!showPlainKey())}
                      class="min-h-8 px-2.5 rounded-lg border border-border bg-card items-center justify-center active:bg-muted"
                    >
                      <Text class="text-muted-foreground text-xs font-medium">
                        {showPlainKey() ? t("voiceHideKey") : t("voiceShowKey")}
                      </Text>
                    </Button>
                  </View>
                </View>

                <Input
                  testID="voice-key"
                  value={voiceKey()}
                  onChange={(e) => {
                    voiceKey.set(e.value);
                    keyError.set("");
                  }}
                  masked={!showPlainKey()}
                  placeholder={t("enterProviderKey", {
                    provider: props.store.voiceProviderLabel(),
                  })}
                  autoCorrect={false}
                  autoCapitalize="none"
                  maxLength={8192}
                  onSubmit={saveVoiceKey}
                  class="h-10 rounded-xl border border-input bg-card px-3.5 text-foreground text-xs font-mono focus:border-ring"
                />

                <If when={keyError()}>
                  <Text role="alert" class="text-destructive text-xs">
                    {translateMessage(keyError())}
                  </Text>
                </If>

                <View class="flex-row items-center justify-between gap-2">
                  <Text
                    class="text-muted-foreground text-xs flex-1"
                    style={{ numberOfLines: 1 }}
                  >
                    {t("voiceKeySecurityHint")}
                  </Text>
                  <View class="flex-row items-center gap-2">
                    <If when={props.store.voiceConfigured()}>
                      <ActionButton
                        label={t("cancel")}
                        compact={true}
                        onPress={() => {
                          replacingKey.set(false);
                          editingKey.set(false);
                          voiceKey.set("");
                          showPlainKey.set(false);
                          keyError.set("");
                        }}
                      />
                    </If>
                    <ActionButton
                      label={saveKeyButtonLabel()}
                      testID="save-voice-btn"
                      kind="primary"
                      compact={true}
                      disabled={!props.store.ready() || !voiceKey().trim()}
                      onPress={saveVoiceKey}
                    />
                  </View>
                </View>
              </View>
            </If>
          </View>
        </If>

        {/* Planned Provider Row (OpenAI Realtime) */}
        <If when={props.store.voiceProviderId() !== "openai"}>
          <View
            testID="voice-planned-openai"
            class="min-h-11 rounded-xl bg-muted px-3 py-2 flex-row items-center justify-between gap-2"
          >
            <View class="flex-row items-center gap-2.5 flex-1 min-w-0">
              <View class="w-5 h-5 rounded-full border border-border bg-card shrink-0" />
              <Text
                class="text-foreground text-sm font-medium"
                style={{ numberOfLines: 1 }}
              >
                OpenAI Realtime
              </Text>
            </View>
            <View class="px-2.5 py-0.5 rounded-full bg-card border border-border">
              <Text class="text-muted-foreground text-xs">
                {t("voicePlannedService")}
              </Text>
            </View>
          </View>
        </If>
      </View>

      {/* Section 2: Voice Timbre & Inline Audition */}
      <If when={props.store.voiceProviderId() === "doubao"}>
        <View class="border-t border-border pt-2.5 gap-1.5">
          <View class="flex-row items-center justify-between gap-2">
            <Text role="header" class="text-foreground text-sm font-bold">
              {t("voiceTimbreSection")}
            </Text>
            <Button
              testID="edit-voice-id"
              hitSlop={6}
              disabled={!props.store.ready()}
              onPress={() => {
                if (editingVoice()) {
                  editingVoice.set(false);
                  voiceError.set("");
                } else {
                  const saved = props.store.voiceId();
                  voiceModeTab.set(
                    doubaoVoicePreset(saved) ? "preset" : "custom",
                  );
                  voiceIdDraft.set(saved || DOUBAO_DEFAULT_VOICE_ID);
                  voiceError.set("");
                  editingVoice.set(true);
                }
              }}
              class="min-h-9 px-2 rounded-lg flex-row items-center gap-1 active:bg-muted disabled:opacity-40"
            >
              <Text
                class="text-foreground text-xs font-medium"
                style={{ numberOfLines: 1, maxWidth: 160 }}
              >
                {editingVoice()
                  ? t("voiceCollapseAction")
                  : `${currentTimbreSummary()} >`}
              </Text>
            </Button>
          </View>

          {/* Always-visible Audition Row */}
          <View class="flex-row items-center justify-between gap-2">
            <Text
              class="text-muted-foreground text-xs flex-1"
              style={{ numberOfLines: 1 }}
            >
              {voiceNeedsReconnect()
                ? t("voiceSavedReconnectHint")
                : t("voicePreviewStaysOnPage")}
            </Text>
            <Button
              testID="preview-voice-btn"
              hitSlop={6}
              disabled={
                !props.store.ready() ||
                (!props.store.voiceConfigured() && !isPreviewing()) ||
                (!isPreviewing() && editingVoice() && !voiceIdDraft().trim())
              }
              onPress={handlePreviewVoice}
              class="min-h-9 px-3.5 rounded-full border border-foreground bg-card flex-row items-center justify-center gap-1.5 active:bg-muted focus:border-ring disabled:opacity-35"
            >
              <VoiceInlineIcon
                kind={isPreviewing() && active() ? "stop" : "play"}
                tone="foreground"
                size={12}
              />
              <Text class="text-foreground text-xs font-semibold">
                {isPreviewing() && active()
                  ? t("voiceStopPreview")
                  : inConversation()
                    ? t("voiceEndAndPreview")
                    : t("voicePreviewBtn")}
              </Text>
            </Button>
          </View>

          {/* Expandable Voice Tuning Drawer */}
          <If when={editingVoice()}>
            <View class="rounded-xl border border-border bg-background p-3 gap-2.5">
              <SelectField
                label={t("voiceOutputVoice")}
                testID="voice-preset-select"
                compact={true}
                items={[
                  ...DOUBAO_VOICES.map((voice) => ({
                    value: voice.id,
                    title: t(voice.name),
                    group: t(voice.group),
                  })),
                  {
                    value: "custom",
                    title: t("voiceUseCustomId"),
                    group: t("voiceCustomPresetGroup"),
                  },
                ]}
                value={voiceModeTab() === "custom" ? "custom" : voiceIdDraft()}
                onChange={(id) => {
                  voiceModeTab.set(id === "custom" ? "custom" : "preset");
                  voiceIdDraft.set(
                    id === "custom"
                      ? doubaoVoicePreset(props.store.voiceId())
                        ? ""
                        : props.store.voiceId()
                      : id,
                  );
                  voiceError.set("");
                }}
              />

              <If when={voiceModeTab() === "custom"}>
                <View class="gap-1.5">
                  <View class="flex-row items-center justify-between gap-2">
                    <Text class="text-muted-foreground text-xs font-medium">
                      {t("speakerId")}
                    </Text>
                    <Button
                      testID="paste-voice-id-btn"
                      hitSlop={6}
                      onPress={() => void pasteSpeakerIdFromClipboard()}
                      class="min-h-8 px-2.5 rounded-lg border border-border bg-card items-center justify-center active:bg-muted"
                    >
                      <Text class="text-foreground text-xs font-medium">
                        {t("voicePasteKey")}
                      </Text>
                    </Button>
                  </View>
                  <Input
                    testID="voice-id"
                    value={voiceIdDraft()}
                    onChange={(e) => {
                      voiceIdDraft.set(e.value);
                      voiceError.set("");
                    }}
                    placeholder={t("enterAClonedSpeakerIdEgS")}
                    autoCorrect={false}
                    autoCapitalize="none"
                    maxLength={256}
                    onSubmit={saveVoiceId}
                    class="h-10 rounded-xl border border-input bg-card px-3.5 text-foreground text-xs font-mono focus:border-ring"
                  />
                </View>
              </If>

              <If when={voiceError()}>
                <Text role="alert" class="text-destructive text-xs">
                  {translateMessage(voiceError())}
                </Text>
              </If>

              <View class="flex-row flex-wrap items-center justify-end gap-2">
                <If when={Boolean(props.store.voiceId())}>
                  <ActionButton
                    label={t("resetToDefault")}
                    testID="restore-voice-id-btn"
                    compact={true}
                    onPress={() => {
                      try {
                        props.store.configureVoiceId("");
                        voiceIdDraft.set("");
                        voiceModeTab.set("preset");
                        voiceError.set("");
                        editingVoice.set(false);
                        props.store.notify("@looi:voiceSpeakerSavedToast");
                      } catch (cause) {
                        voiceError.set(
                          cause instanceof Error
                            ? cause.message
                            : "@looi:couldNotSaveSpeakerId",
                        );
                      }
                    }}
                  />
                </If>
                <ActionButton
                  label={t("cancel")}
                  testID="cancel-voice-id"
                  compact={true}
                  onPress={() => {
                    editingVoice.set(false);
                    voiceIdDraft.set("");
                    voiceError.set("");
                  }}
                />
                <ActionButton
                  label={t("voiceSaveSelection")}
                  testID="save-voice-id-btn"
                  kind="primary"
                  compact={true}
                  disabled={
                    !props.store.ready() ||
                    !voiceIdDraft().trim() ||
                    voiceIdDraft().trim() ===
                      (props.store.voiceId() || DOUBAO_DEFAULT_VOICE_ID)
                  }
                  onPress={saveVoiceId}
                />
              </View>
            </View>
          </If>
        </View>
      </If>

      {/* Section 3: Wake-up */}
      <View class="border-t border-border pt-2.5 gap-1.5">
        <Text role="header" class="text-foreground text-sm font-bold">
          {t("voiceWakeSection")}
        </Text>
        <View class="min-h-9 flex-row items-center justify-between gap-3">
          <Text
            class="text-foreground text-sm font-medium flex-1"
            style={{ numberOfLines: 1 }}
          >
            {t("voiceAutoWake")}
          </Text>
          <Switch
            testID="wake-toggle"
            accessibilityLabel={t("voiceAutoWake")}
            checked={state().wakeEnabled}
            hitSlop={8}
            onChange={(ev) => props.store.setWakeEnabled(ev.checked)}
            class="flex-row items-center justify-center disabled:opacity-40"
            trackClass="w-11 h-6 rounded-full bg-border border border-border p-0.5 justify-center checked:bg-verified checked:border-verified"
            thumbClass="w-5 h-5 rounded-full bg-card checked:translate-x-5"
          />
        </View>
      </View>
    </View>
  );

  return (
    <If
      when={windowSize().width >= 600}
      else={
        <Scroll class="flex-1" contentClass="gap-3 pb-6">
          {renderSession(true)}
          {renderConfiguration(true)}
        </Scroll>
      }
    >
      <View class="flex-1 flex-row min-h-0 bg-card">
        <View style={{ flex: 6.3, minWidth: 0, minHeight: 0 }}>
          {renderSession(false)}
        </View>
        <View
          style={{ flex: 3.7, minWidth: 0, minHeight: 0 }}
          class="border-l border-border bg-card"
        >
          <Scroll class="flex-1" contentClass="px-5 py-3 pb-4">
            {renderConfiguration(false)}
          </Scroll>
        </View>
      </View>
    </If>
  );
}
