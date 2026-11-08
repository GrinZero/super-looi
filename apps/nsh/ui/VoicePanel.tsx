import { t, translateMessage, formatDate } from "../i18n";
import { effect, signal, Text, View } from "nsh";
import type { createAppStore } from "../store";
import { ActionButton, Panel, TextField } from "./Controls";

export function VoicePanel(props: {
  open: boolean;
  store: ReturnType<typeof createAppStore>;
  onClose: () => void;
}) {
  const key = signal(""),
    error = signal("");
  effect(() => {
    if (!props.open) {
      key.set("");
      error.set("");
    }
  });
  const active = () =>
    ["connecting", "listening", "speaking"].includes(
      props.store.voiceState().phase,
    );
  return (
    <Panel
      open={props.open}
      title={t("liveVoice")}
      height={520}
      onClose={props.onClose}
    >
      <If
        when={props.store.voiceTask()}
        else={
          <View class="gap-4">
            <Text class="text-muted-foreground text-sm">
              {t("connectDirectlyToDoubaoMicrophoneAccessIs")}</Text>
            <TextField
              label={t("doubaoVoiceApiKey")}
              masked={true}
              value={key()}
              onChange={(value) => key.set(value)}
              placeholder={
                props.store.voiceConfigured()
                  ? t("savedSecurelyLeaveBlankToKeep")
                  : t("enterVoiceApiKey")
              }
            />
            <ActionButton
              label={t("saveVoiceSettings")}
              disabled={!key().trim() || active()}
              onPress={() => {
                try {
                  props.store.configureVoice(key());
                  key.set("");
                  error.set("");
                } catch (cause) {
                  error.set(
                    cause instanceof Error ? cause.message : String(cause),
                  );
                }
              }}
            />
            <View class="flex-row gap-2">
              <ActionButton
                label={active() ? t("endVoice") : t("startVoice")}
                testID="voice-start"
                kind="primary"
                disabled={!props.store.voiceConfigured()}
                onPress={() => {
                  if (active()) props.store.stopVoice();
                  else void props.store.startVoice();
                }}
              />
              <If when={active()}>
                <ActionButton
                  label={props.store.voiceState().muted ? t("unmute") : t("mute")}
                  onPress={() =>
                    props.store.muteVoice(!props.store.voiceState().muted)
                  }
                />
              </If>
            </View>
            <If when={props.store.voiceState().phase === "speaking"}>
              <ActionButton
                label={t("interruptPlayback")}
                onPress={() => props.store.interruptVoice()}
              />
            </If>
          </View>
        }
      >
        <View class="gap-4">
          <Text class="text-foreground text-base">
            {t("runThisVoiceRequestWithTheLocal")}</Text>
          <View selectable={true}>
            <Text class="text-foreground text-base">
              {props.store.voiceTask()}
            </Text>
          </View>
          <View class="flex-row gap-2">
            <ActionButton
              label={t("declineTask")}
              onPress={() => {
                void props.store.confirmVoiceTask(false);
              }}
            />
            <ActionButton
              label={t("runThisTask")}
              kind="primary"
              onPress={() => {
                void props.store.confirmVoiceTask(true);
                props.onClose();
              }}
            />
          </View>
        </View>
      </If>
      <If when={translateMessage(error() || props.store.voiceState().error)}>
        <Text role="alert" class="text-destructive text-sm">
          {translateMessage(error() || props.store.voiceState().error)}
        </Text>
      </If>
      <If when={props.store.voiceState().transcript}>
        <View selectable={true}>
          <Text class="text-foreground text-base">
            {props.store.voiceState().transcript}
          </Text>
        </View>
      </If>
    </Panel>
  );
}
