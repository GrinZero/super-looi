import { signal, Text, View, Scroll, windowSize } from "nsh";
import type { createAppStore } from "../store";
import { ActionButton, TextField } from "./Controls";

export function VoiceSpaceView(props: {
  store: ReturnType<typeof createAppStore>;
}) {
  const voiceKey = signal("");
  const saving = signal(false);

  const active = () =>
    ["connecting", "listening", "speaking"].includes(
      props.store.voiceState().phase,
    );

  const phaseDescription = () => {
    switch (props.store.voiceState().phase) {
      case "connecting":
        return "LIVE 连接中…";
      case "listening":
        return props.store.voiceState().muted ? "已静音" : "聆听中…";
      case "speaking":
        return "说话中…";
      case "permission":
        return "等待麦克风权限…";
      case "error":
        return "连接异常";
      case "standby":
        return windowSize().width < 600
          ? "本地待机 · 听 Hey LOOI"
          : "待机监听唤醒词（本地离线 KWS）";
      default:
        return "待机（未占用麦克风）";
    }
  };

  const saveVoiceKey = () => {
    const raw = voiceKey().trim();
    if (!raw) return;
    saving.set(true);
    try {
      props.store.configureVoice(raw);
      voiceKey.set("");
      props.store.notify("语音配置已保存");
    } catch (cause) {
      props.store.notify(
        cause instanceof Error ? cause.message : "保存语音配置失败",
      );
    } finally {
      saving.set(false);
    }
  };

  const renderLeftCard = () => (
    <View class="gap-3">
      <If when={props.store.voiceTask()}>
        <View class="rounded-2xl border border-warning bg-card p-3.5 gap-2.5">
          <View class="flex-row items-center gap-2 border-b border-border pb-2">
            <View class="w-2 h-2 rounded-full bg-warning" />
            <Text class="text-foreground text-sm font-semibold">
              待确认语音任务
            </Text>
          </View>
          <View class="rounded-xl bg-background p-2.5" selectable={true}>
            <Text class="text-foreground font-mono text-sm">
              {props.store.voiceTask()}
            </Text>
          </View>
          <View class="flex-row justify-end gap-2">
            <ActionButton
              label="拒绝"
              kind="danger"
              compact={true}
              onPress={() => props.store.confirmVoiceTask(false)}
            />
            <ActionButton
              label="执行"
              kind="primary"
              compact={true}
              onPress={() => props.store.confirmVoiceTask(true)}
            />
          </View>
        </View>
      </If>

      <View class="rounded-2xl border border-border bg-card p-3.5 gap-3">
        <View class="border-b border-border pb-2">
          <Text class="text-foreground text-sm font-semibold">
            豆包实时语音凭证
          </Text>
        </View>

        <TextField
          label="API Key"
          testID="voice-key"
          value={voiceKey()}
          onChange={(v) => voiceKey.set(v)}
          masked={true}
          placeholder={
            props.store.voiceConfigured()
              ? "留空保持现有凭证"
              : "输入豆包实时语音 API Key"
          }
          onSubmit={saveVoiceKey}
        />

        <View class="flex-row justify-end">
          <ActionButton
            label={saving() ? "保存中…" : "保存凭证"}
            testID="save-voice-btn"
            kind="primary"
            compact={true}
            disabled={saving() || !voiceKey().trim()}
            onPress={saveVoiceKey}
          />
        </View>
      </View>
    </View>
  );

  const renderRightCard = () => (
    <View class="rounded-2xl border border-border bg-card p-3.5 gap-3">
      <View class="flex-row items-center justify-between border-b border-border pb-2">
        <Text class="text-foreground text-sm font-semibold">
          会话控制
        </Text>
        <If when={active()}>
          <View class="flex-row items-center gap-1.5">
            <View class="w-1.5 h-1.5 rounded-full bg-verified" />
            <Text class="text-verified text-xs font-semibold">通话中</Text>
          </View>
        </If>
      </View>

      <View class="rounded-xl border border-border bg-muted px-3 py-2 flex-row items-center justify-between">
        <Text class="text-muted-foreground text-xs">当前状态</Text>
        <Text class="text-foreground text-xs font-semibold">
          {phaseDescription()}
        </Text>
      </View>

      <ActionButton
        label={props.store.voiceState().wakeEnabled ? "关闭 Hey LOOI 自动唤醒" : "开启 Hey LOOI 自动唤醒"}
        testID="wake-toggle"
        kind="quiet"
        compact={true}
        disabled={!props.store.voiceConfigured()}
        onPress={() => props.store.setWakeEnabled(!props.store.voiceState().wakeEnabled)}
      />
      <Text class="text-muted-foreground text-xs">
        前台待机时仅在本地检测唤醒词；进入后台后停止麦克风。
      </Text>

      <ActionButton
        label={active() ? "结束实时语音" : "开启 LIVE 语音"}
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
            label={props.store.voiceState().muted ? "解除静音" : "麦克风静音"}
            compact={true}
            onPress={() => props.store.muteVoice(!props.store.voiceState().muted)}
          />
          <If when={props.store.voiceState().phase === "speaking"}>
            <ActionButton
              label="打断"
              compact={true}
              onPress={() => props.store.interruptVoice()}
            />
          </If>
        </View>
      </If>

      <If when={props.store.voiceState().transcript}>
        <View class="gap-1 rounded-xl border border-border bg-muted p-2.5">
          <Text class="text-muted-foreground text-xs font-medium">实时转写</Text>
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
