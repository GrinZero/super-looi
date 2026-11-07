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
        return props.store.voiceState().muted ? "实时语音（已静音）" : "实时聆听中…";
      case "speaking":
        return "LOOI 说话中…";
      case "permission":
        return "等待麦克风权限…";
      case "error":
        return "语音连接异常";
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
      props.store.notify("豆包实时语音 API Key 已安全保存并生效");
    } catch (cause) {
      props.store.notify(
        cause instanceof Error ? cause.message : "保存语音配置失败",
      );
    } finally {
      saving.set(false);
    }
  };

  const renderLeftCard = () => (
    <View class="gap-3.5">
      <If when={props.store.voiceTask()}>
        <View class="rounded-2xl border border-warning bg-card p-4 gap-3">
          <View class="flex-row items-center gap-2 border-b border-border pb-2">
            <View class="w-2 h-2 rounded-full bg-warning" />
            <Text class="text-foreground text-sm font-semibold">
              语音提出的待审批任务
            </Text>
          </View>
          <Text class="text-muted-foreground text-xs">
            语音助手请求执行以下 Agent 任务。设备控制或文件改动仍会在此后要求单次确认：
          </Text>
          <View class="rounded-xl bg-background p-3" selectable={true}>
            <Text class="text-foreground font-mono text-sm">
              {props.store.voiceTask()}
            </Text>
          </View>
          <View class="flex-row justify-end gap-2">
            <ActionButton
              label="拒绝任务"
              kind="danger"
              compact={true}
              onPress={() => props.store.confirmVoiceTask(false)}
            />
            <ActionButton
              label="执行这项任务"
              kind="primary"
              compact={true}
              onPress={() => props.store.confirmVoiceTask(true)}
            />
          </View>
        </View>
      </If>

      <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
        <View class="flex-row items-center justify-between border-b border-border pb-2.5">
          <View class="gap-0.5">
            <Text class="text-foreground text-sm font-semibold">
              豆包端到端实时语音凭证
            </Text>
            <Text class="text-muted-foreground text-xs font-mono">
              16kHz PCM 麦克风采集 · 24kHz 全双工低延迟流式回放
            </Text>
          </View>
          <If when={props.store.voiceConfigured()}>
            <View class="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full bg-muted">
              <View class="w-1.5 h-1.5 rounded-full bg-verified" />
              <Text class="text-verified text-xs font-medium">已配置凭证</Text>
            </View>
          </If>
        </View>

        <Text class="text-muted-foreground text-xs">
          实时语音通道与对话大模型（LLM）配置相互独立；API Key 单独加密存储于系统钥匙串
          “voice” 槽位中。
        </Text>

        <TextField
          label="豆包实时语音 API Key"
          testID="voice-key"
          value={voiceKey()}
          onChange={(v) => voiceKey.set(v)}
          masked={true}
          placeholder={
            props.store.voiceConfigured()
              ? "已安全保存于系统钥匙串；留空继续使用"
              : "输入豆包实时语音 API Key"
          }
          onSubmit={saveVoiceKey}
        />

        <View class="flex-row justify-end pt-1">
          <ActionButton
            label={saving() ? "正在保存…" : "保存语音凭证"}
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
    <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
      <View class="flex-row items-center justify-between border-b border-border pb-2.5">
        <Text class="text-foreground text-sm font-semibold">
          会话控制与隐私保护
        </Text>
        <If when={active()}>
          <View class="flex-row items-center gap-1.5">
            <View class="w-1.5 h-1.5 rounded-full bg-verified" />
            <Text class="text-verified text-xs font-semibold">通话中</Text>
          </View>
        </If>
      </View>

      <View class="rounded-xl border border-border bg-muted p-3 gap-2">
        <View class="flex-row items-center justify-between">
          <Text class="text-muted-foreground text-xs">当前状态</Text>
          <Text class="text-foreground text-xs font-semibold">
            {phaseDescription()}
          </Text>
        </View>
        <Text class="text-muted-foreground text-xs">
          隐私声明：仅在主动开启 LIVE 对话时请求麦克风权限；切到后台或中断后自动释放麦克风，杜绝静默监听。
        </Text>
      </View>

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
            label={props.store.voiceState().muted ? "解除静音 (开麦)" : "麦克风静音"}
            compact={true}
            onPress={() => props.store.muteVoice(!props.store.voiceState().muted)}
          />
          <If when={props.store.voiceState().phase === "speaking"}>
            <ActionButton
              label="打断说话"
              compact={true}
              onPress={() => props.store.interruptVoice()}
            />
          </If>
        </View>
      </If>

      <If when={props.store.voiceState().transcript}>
        <View class="gap-1.5 rounded-xl border border-border bg-muted p-3">
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
      <View class="flex-1 flex-row gap-3.5 min-h-0">
        <View style={{ flex: 7, minWidth: 0, minHeight: 0 }}>
          <Scroll class="flex-1" contentClass="gap-3 pb-4">
            {renderLeftCard()}
          </Scroll>
        </View>
        <View style={{ flex: 5, minWidth: 0, minHeight: 0 }}>
          <Scroll class="flex-1" contentClass="gap-3 pb-4">
            {renderRightCard()}
          </Scroll>
        </View>
      </View>
    </If>
  );
}
