import { t } from "../i18n";
import { signal, Text, View, Scroll, windowSize } from "nsh";
import type { createAppStore } from "../store";
import { ActionButton, TextField } from "./Controls";

export function VoiceSpaceView(props: {
  store: ReturnType<typeof createAppStore>;
}) {
  const voiceKey = signal("");
  const voiceIdDraft = signal("");
  const saving = signal(false);

  const active = () =>
    ["connecting", "listening", "speaking"].includes(
      props.store.voiceState().phase,
    );

  const saveVoiceKey = () => {
    const raw = voiceKey().trim();
    if (!raw) return;
    saving.set(true);
    try {
      props.store.configureVoice(raw);
      voiceKey.set("");
      props.store.notify("@looi:voiceSettingsSaved");
    } catch (cause) {
      props.store.notify(
        cause instanceof Error ? cause.message : "@looi:couldNotSaveVoiceSettings",
      );
    } finally {
      saving.set(false);
    }
  };

  const saveVoiceId = () => {
    if (!props.store.ready() || !voiceIdDraft().trim()) return;
    try {
      props.store.configureVoiceId(voiceIdDraft());
      voiceIdDraft.set("");
    } catch (cause) {
      props.store.notify(cause instanceof Error ? cause.message : "@looi:couldNotSaveSpeakerId");
    }
  };

  const renderLeftCard = () => (
    <View class="gap-3">
      <View class="rounded-2xl border border-border bg-card p-3.5 gap-3">
        <View class="border-b border-border pb-2">
          <Text class="text-foreground text-sm font-semibold">
            {t("providerVoiceCredentials", { provider: props.store.voiceProviderLabel() })}</Text>
        </View>

        <TextField
          label="API Key"
          testID="voice-key"
          value={voiceKey()}
          onChange={(v) => voiceKey.set(v)}
          masked={true}
          placeholder={
            props.store.voiceConfigured()
              ? t("leaveBlankToKeepCurrentCredentials")
              : t("enterProviderKey", { provider: props.store.voiceProviderLabel() })
          }
          onSubmit={saveVoiceKey}
        />

        <View class="flex-row justify-end">
          <ActionButton
            label={saving() ? t("saving229") : t("saveCredentials")}
            testID="save-voice-btn"
            kind="primary"
            compact={true}
            disabled={saving() || !voiceKey().trim()}
            onPress={saveVoiceKey}
          />
        </View>
      </View>

      <If when={props.store.voiceProviderId() === "doubao"}>
        <View class="rounded-2xl border border-border bg-card p-3.5 gap-3">
          <View class="border-b border-border pb-2">
            <Text class="text-foreground text-sm font-semibold">{t("doubaoVoice")}</Text>
          </View>
          <Text class="text-muted-foreground text-xs">
            {t("current")}{props.store.voiceId() || t("defaultVoice")}
          </Text>
          <TextField
            label={t("speakerId")}
            testID="voice-id"
            value={voiceIdDraft()}
            onChange={(value) => voiceIdDraft.set(value)}
            placeholder={t("enterAClonedSpeakerIdEgS")}
            onSubmit={saveVoiceId}
          />
          <View class="flex-row justify-end gap-2">
            <If when={Boolean(props.store.voiceId())}>
              <ActionButton
                label={t("resetToDefault")}
                testID="restore-voice-id-btn"
                compact={true}
                onPress={() => {
                  props.store.configureVoiceId("");
                  voiceIdDraft.set("");
                }}
              />
            </If>
            <ActionButton
              label={t("saveSpeakerId")}
              testID="save-voice-id-btn"
              kind="primary"
              compact={true}
              disabled={!props.store.ready() || !voiceIdDraft().trim() || voiceIdDraft().trim() === props.store.voiceId()}
              onPress={saveVoiceId}
            />
          </View>
          <Text class="text-muted-foreground text-xs">{t("theNewVoiceAppliesToTheNext")}</Text>
        </View>
      </If>
    </View>
  );

  const renderRightCard = () => (
    <View class="rounded-2xl border border-border bg-card p-3.5 gap-3">
      <View class="flex-row items-center justify-between border-b border-border pb-2">
        <Text class="text-foreground text-sm font-semibold">
          {t("sessionControls")}</Text>
        <If when={active()}>
          <View class="flex-row items-center gap-1.5">
            <View class="w-1.5 h-1.5 rounded-full bg-verified" />
            <Text class="text-verified text-xs font-semibold">{t("connected")}</Text>
          </View>
        </If>
      </View>

      <ActionButton
        label={props.store.voiceState().wakeEnabled ? t("disableHeyLooiWakeup") : t("enableHeyLooiWakeup")}
        testID="wake-toggle"
        kind="quiet"
        compact={true}
        onPress={() => props.store.setWakeEnabled(!props.store.voiceState().wakeEnabled)}
      />

      <ActionButton
        label={active() ? t("endLiveVoice") : t("startLiveVoice")}
        testID="voice-space-toggle"
        kind={active() ? "danger" : "primary"}
        compact={true}
        disabled={!props.store.voiceConfigured() && !active()}
        onPress={() => {
          if (active()) {
            props.store.stopVoice();
          } else {
            void props.store.startVoice();
          }
        }}
      />

      <If when={active()}>
        <View class="flex-row gap-2 pt-1 border-t border-border">
          <ActionButton
            label={props.store.voiceState().muted ? t("unmute247") : t("muteMicrophone")}
            compact={true}
            onPress={() => props.store.muteVoice(!props.store.voiceState().muted)}
          />
          <If when={props.store.voiceState().phase === "speaking"}>
            <ActionButton
              label={t("interrupt")}
              compact={true}
              onPress={() => props.store.interruptVoice()}
            />
          </If>
        </View>
      </If>

      <If when={props.store.voiceState().transcript}>
        <View class="gap-1 rounded-xl border border-border bg-muted p-2.5">
          <Text class="text-muted-foreground text-xs font-medium">{t("liveTranscript")}</Text>
          <Text class="text-foreground text-sm font-medium">
            {props.store.voiceState().transcript}
          </Text>
        </View>
      </If>
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
      <View class="flex-1 flex-row gap-3 min-h-0">
        <View style={{ flex: 7, minWidth: 0, minHeight: 0 }}>
          <Scroll class="flex-1" contentClass="gap-3 pb-2">
            {renderLeftCard()}
          </Scroll>
        </View>
        <View style={{ flex: 5, minWidth: 0, minHeight: 0 }}>
          <Scroll class="flex-1" contentClass="gap-3 pb-2">
            {renderRightCard()}
          </Scroll>
        </View>
      </View>
    </If>
  );
}
