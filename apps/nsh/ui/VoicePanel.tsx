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
      title="实时语音"
      height={520}
      onClose={props.onClose}
    >
      <If
        when={props.store.voiceTask()}
        else={
          <View class="gap-4">
            <Text class="text-muted-foreground text-sm">
              手机直连豆包。开启时才申请麦克风权限；离开应用或音频中断后需要再次开启。
            </Text>
            <TextField
              label="豆包语音 API Key"
              masked={true}
              value={key()}
              onChange={(value) => key.set(value)}
              placeholder={
                props.store.voiceConfigured()
                  ? "已安全保存，留空继续使用"
                  : "输入语音服务 API Key"
              }
            />
            <ActionButton
              label="保存语音配置"
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
                label={active() ? "结束语音" : "开启语音"}
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
                  label={props.store.voiceState().muted ? "开麦" : "静音"}
                  onPress={() =>
                    props.store.muteVoice(!props.store.voiceState().muted)
                  }
                />
              </If>
            </View>
            <If when={props.store.voiceState().phase === "speaking"}>
              <ActionButton
                label="打断播放"
                onPress={() => props.store.interruptVoice()}
              />
            </If>
          </View>
        }
      >
        <View class="gap-4">
          <Text class="text-foreground text-base">
            语音提出了这个任务，是否交给本机
            Agent？设备控制或文件写入仍会单独请你允许。
          </Text>
          <View selectable={true}>
            <Text class="text-foreground text-base">
              {props.store.voiceTask()}
            </Text>
          </View>
          <View class="flex-row gap-2">
            <ActionButton
              label="拒绝任务"
              onPress={() => {
                void props.store.confirmVoiceTask(false);
              }}
            />
            <ActionButton
              label="执行这项任务"
              kind="primary"
              onPress={() => {
                void props.store.confirmVoiceTask(true);
                props.onClose();
              }}
            />
          </View>
        </View>
      </If>
      <If when={error() || props.store.voiceState().error}>
        <Text role="alert" class="text-destructive text-sm">
          {error() || props.store.voiceState().error}
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
