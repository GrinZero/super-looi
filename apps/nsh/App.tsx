import { effect, mount, signal, Text, View, windowSize } from "nsh";
import { Button, Input } from "nsh/base";
import { createAppStore } from "./store";
import {
  ActionButton,
  LightToast,
  Panel,
  ResponsePreview,
  TextField,
  WakeGuideBar,
} from "./ui/Controls";
import { RobotFace } from "./ui/RobotFace";

function App() {
  const store = createAppStore();
  const settings = signal(false),
    compose = signal(false),
    draft = signal("");
  const baseUrl = signal(""),
    model = signal(""),
    apiKey = signal(""),
    voiceKey = signal(""),
    saving = signal(false),
    configError = signal("");
  const questionAnswers = signal<Record<string, string>>({});
  const responseOpen = signal(false);

  const voiceActive = () =>
    ["connecting", "listening", "speaking"].includes(store.voiceState().phase);

  const voicePillLabel = () => {
    const phase = store.voiceState().phase;
    if (phase === "speaking") return "打断";
    if (phase === "connecting") return "连接中";
    if (phase === "listening") return "LIVE 中";
    return "LIVE 对话";
  };

  const responseText = () =>
    ["listening", "speaking"].includes(store.voiceState().phase) &&
    store.voiceState().transcript
      ? store.voiceState().transcript
      : store.message();

  const approvalLabel = () => {
    const details = store.interaction()?.details;
    switch (details?.toolName) {
      case "write":
      case "write_file":
        return details.willOverwrite ? "覆盖文件" : "新建文件";
      case "read":
      case "read_file":
        return "读取文件";
      case "bash":
        return "运行本机 Shell 命令";
      default:
        return `执行 ${String(details?.toolName ?? "本机操作")}`;
    }
  };

  const questions = () => {
    const value = store.interaction()?.details.questions;
    return Array.isArray(value)
      ? value.filter(
          (
            item,
          ): item is {
            id: string;
            question: string;
            options?: Array<{ label: string }>;
          } =>
            Boolean(
              item &&
                typeof item.id === "string" &&
                typeof item.question === "string",
            ),
        )
      : [];
  };

  effect(() => {
    store.interaction()?.id;
    questionAnswers.set({});
  });

  const openSettings = () => {
    baseUrl.set(store.configuration().baseUrl);
    model.set(store.configuration().model);
    apiKey.set("");
    voiceKey.set("");
    configError.set("");
    settings.set(true);
  };

  const toggleLiveVoice = () => {
    store.dismissWakeGuide();
    if (!store.ready()) return;
    const phase = store.voiceState().phase;
    if (phase === "speaking") {
      store.interruptVoice();
      return;
    }
    if (phase === "listening" || phase === "connecting") {
      store.stopVoice();
      return;
    }
    if (store.voiceConfigured()) {
      void store.startVoice();
      return;
    }
    openSettings();
  };

  const save = async () => {
    if (saving()) return;
    saving.set(true);
    configError.set("");
    try {
      const hasModelFields = Boolean(baseUrl().trim() && model().trim());
      const hasVoiceField = Boolean(voiceKey().trim());
      if (!hasModelFields && !hasVoiceField) {
        throw new Error("请填写对话模型配置或豆包语音 API Key");
      }
      if (hasModelFields) {
        await store.configure({
          baseUrl: baseUrl(),
          model: model(),
          apiKey: apiKey(),
        });
      }
      if (hasVoiceField) {
        store.configureVoice(voiceKey().trim());
        if (!hasModelFields) {
          store.notify("语音配置已保存");
        }
      }
      apiKey.set("");
      voiceKey.set("");
      settings.set(false);
    } catch (error) {
      configError.set(error instanceof Error ? error.message : String(error));
    } finally {
      saving.set(false);
    }
  };

  const send = () => {
    const text = draft().trim();
    if (!text || store.busy() || !store.ready()) return;
    draft.set("");
    compose.set(false);
    void store.send(text);
  };

  return (
    <View
      class="flex-1 bg-background"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
    >
      <RobotFace state={store.face()} shift={{ dx: 0, dy: 0 }} />

      <View class="flex-1 px-4 py-2.5 justify-between">
        <View class="gap-2">
          <View class="flex-row items-center justify-between gap-3">
            <View
              class="flex-row items-center gap-2 px-2 py-1"
              style={{ opacity: 0.58, minHeight: 34, maxWidth: "56%" }}
            >
              <View
                class={
                  voiceActive()
                    ? "w-1.5 h-1.5 rounded-full bg-verified"
                    : "w-1.5 h-1.5 rounded-full bg-primary"
                }
              />
              <Text
                class="text-muted-foreground text-xs"
                style={{ letterSpacing: 1, flexShrink: 1 }}
              >
                {store.status()}
              </Text>
            </View>

            <View class="flex-row items-center gap-2">
              <Button
                testID="voice-toggle"
                accessibilityLabel={
                  voiceActive() ? "结束或打断实时对话" : "开启豆包实时语音对话"
                }
                disabled={!store.ready()}
                onPress={toggleLiveVoice}
                class={
                  voiceActive()
                    ? "rounded-full border border-verified bg-live-active-bg px-3 flex-row items-center gap-1.5 active:opacity-75 disabled:opacity-40"
                    : "rounded-full border border-live-border bg-live-bg px-3 flex-row items-center gap-1.5 active:opacity-75 disabled:opacity-40"
                }
                style={{ minHeight: 34 }}
              >
                <View
                  class={
                    voiceActive()
                      ? "w-1.5 h-1.5 rounded-full bg-verified"
                      : "w-1.5 h-1.5 rounded-full bg-brand-blue"
                  }
                />
                <Text
                  class={
                    voiceActive()
                      ? "text-verified text-xs font-semibold"
                      : "text-live-text text-xs font-semibold"
                  }
                  style={{ letterSpacing: 0.6 }}
                >
                  {voicePillLabel()}
                </Text>
              </Button>

              <Button
                testID="compose"
                accessibilityLabel="向 LOOI 发送消息"
                onPress={() => compose.set(!compose())}
                class={
                  compose()
                    ? "rounded-full border border-live-border bg-live-bg px-3 items-center justify-center active:opacity-75"
                    : "rounded-full border border-ask-trigger-border bg-ask-trigger-bg px-3 items-center justify-center active:opacity-75"
                }
                style={{ minHeight: 34 }}
              >
                <Text
                  class={
                    compose()
                      ? "text-live-text text-xs font-medium"
                      : "text-muted-foreground text-xs"
                  }
                  style={{ letterSpacing: 1 }}
                >
                  对话
                </Text>
              </Button>

              <Button
                testID="connection-settings"
                accessibilityLabel="打开连接设置"
                onPress={openSettings}
                class="rounded-full border border-ask-trigger-border bg-ask-trigger-bg px-3 items-center justify-center active:opacity-75"
                style={{ minHeight: 34 }}
              >
                <Text
                  class="text-muted-foreground text-xs"
                  style={{ letterSpacing: 1 }}
                >
                  连接
                </Text>
              </Button>
            </View>
          </View>

          <If when={compose()}>
            <View class="rounded-2xl border border-live-border bg-ask-bar-bg px-3 py-1.5 flex-row items-center gap-2">
              <Input
                testID="message-input"
                value={draft()}
                onChange={(e) => draft.set(e.value)}
                onSubmit={send}
                autoCorrect={false}
                autoCapitalize="none"
                maxLength={8192}
                placeholder="直接对 LOOI 说（如：查看当前目录 / 帮我写一段脚本）"
                class="flex-1 h-9 rounded-xl border border-transparent bg-transparent px-2 text-foreground text-sm focus:border-ring"
              />
              <Button
                testID="send-message"
                disabled={!draft().trim() || !store.ready() || store.busy()}
                onPress={send}
                class="rounded-full bg-brand-blue px-3.5 items-center justify-center active:opacity-75 disabled:opacity-40"
                style={{ minHeight: 34 }}
              >
                <Text class="text-foreground text-xs font-semibold">发送</Text>
              </Button>
            </View>
          </If>

          <If when={store.toast()}>
            <View class="items-center">
              <LightToast text={store.toast()} />
            </View>
          </If>
        </View>

        <View class="items-center gap-2">
          <If when={store.busy()}>
            <View class="w-full flex-row justify-end">
              <Button
                testID="stop-task"
                accessibilityLabel="停止当前工作任务"
                onPress={() => {
                  void store.stop();
                }}
                class="rounded-full bg-agent-stop px-4 items-center justify-center active:opacity-75"
                style={{ minHeight: 44 }}
              >
                <Text class="text-foreground text-xs font-semibold">
                  停止任务
                </Text>
              </Button>
            </View>
          </If>

          <If
            when={responseText()}
            else={
              <If
                when={
                  !store.wakeGuideDismissed() &&
                  !compose() &&
                  store.voiceState().phase === "idle"
                }
              >
                <WakeGuideBar onPress={toggleLiveVoice} />
              </If>
            }
          >
            <ResponsePreview
              text={responseText()}
              onOpen={() => responseOpen.set(true)}
            />
          </If>
        </View>
      </View>

      <Panel
        open={settings()}
        title="连接设置"
        height={500}
        wide={true}
        dismissible={!saving()}
        onClose={() => {
          if (!saving()) {
            apiKey.set("");
            voiceKey.set("");
            settings.set(false);
          }
        }}
      >
        <Text class="text-muted-foreground text-sm">
          配置本机 Agent 对话使用的 LLM 模型服务与豆包实时语音 API Key。
        </Text>
        <View
          style={{
            flexDirection: windowSize().width >= 680 ? "row" : "column",
            gap: 20,
          }}
        >
          <View class="flex-1 gap-3" style={{ minWidth: 0 }}>
            <TextField
              label="模型服务地址"
              testID="model-url"
              value={baseUrl()}
              onChange={(value) => baseUrl.set(value)}
              placeholder="https://…/v1"
            />
            <TextField
              label="模型名称"
              testID="model-name"
              value={model()}
              onChange={(value) => model.set(value)}
              placeholder="服务提供的模型名称"
            />
            <Text class="text-muted-foreground text-xs">
              API Key 保存在这台设备的系统安全存储中。
            </Text>
          </View>
          <View class="flex-1 gap-3" style={{ minWidth: 0 }}>
            <TextField
              label="API Key"
              testID="model-key"
              value={apiKey()}
              onChange={(value) => apiKey.set(value)}
              masked={true}
              onSubmit={() => {
                void save();
              }}
              placeholder={
                store.configuration().hasKey
                  ? "已安全保存；同一服务可留空继续使用"
                  : "输入模型 API Key"
              }
            />
            <TextField
              label="豆包实时语音 API Key"
              testID="voice-key"
              value={voiceKey()}
              onChange={(value) => voiceKey.set(value)}
              masked={true}
              onSubmit={() => {
                void save();
              }}
              placeholder={
                store.voiceConfigured()
                  ? "已安全保存；留空保持不变"
                  : "输入豆包语音 API Key（可选）"
              }
            />
            <If when={configError()}>
              <Text class="text-destructive text-sm" role="alert">
                {configError()}
              </Text>
            </If>
            <View class="flex-row justify-end">
              <ActionButton
                label={saving() ? "正在保存…" : "保存并生效"}
                kind="primary"
                disabled={
                  saving() ||
                  store.busy() ||
                  (!(baseUrl().trim() && model().trim()) && !voiceKey().trim())
                }
                onPress={() => {
                  void save();
                }}
              />
            </View>
          </View>
        </View>
      </Panel>

      <Panel
        open={responseOpen()}
        title="LOOI 的回复"
        onClose={() => responseOpen.set(false)}
        height={500}
      >
        <View selectable={true}>
          <Text class="text-foreground text-base">{responseText()}</Text>
        </View>
      </Panel>

      <Panel
        open={Boolean(store.interaction())}
        title={
          store.interaction()?.kind === "approval"
            ? "允许这次操作？"
            : "LOOI 需要你的回答"
        }
        dismissible={false}
        onClose={() => {
          void store.stop();
        }}
      >
        <If
          when={store.interaction()?.kind === "approval"}
          else={
            <View>
              <View class="gap-4">
                <Each of={questions()} key={(question) => question.id}>
                  {(question) => (
                    <View class="gap-2">
                      <TextField
                        label={question().question}
                        value={questionAnswers()[question().id] ?? ""}
                        onChange={(value) =>
                          questionAnswers.update((previous) => ({
                            ...previous,
                            [question().id]: value,
                          }))
                        }
                      />
                      <If when={question().options?.length}>
                        <Text class="text-muted-foreground text-sm">
                          {question()
                            .options?.map((option) => option.label)
                            .join(" / ")}
                        </Text>
                      </If>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          }
        >
          <Text class="text-foreground text-lg font-semibold">
            {approvalLabel()}
          </Text>
          <Text class="text-foreground text-base">
            {String(
              store.interaction()?.details.command ??
                store.interaction()?.details.path ??
                store.interaction()?.details.toolName ??
                "本机操作",
            )}
          </Text>
          <If when={store.interaction()?.details.operation === "write"}>
            <Text class="text-muted-foreground text-sm">写入内容</Text>
            <View class="rounded-xl bg-background p-3" selectable={true}>
              <Text class="text-foreground text-sm font-mono">
                {String(store.interaction()?.details.content ?? "")}
              </Text>
            </View>
          </If>
          <Text class="text-muted-foreground text-sm">
            仅允许当前这一次；你可以拒绝或停止任务。
          </Text>
        </If>
        <View class="flex-row justify-end gap-3">
          <ActionButton
            label={
              store.interaction()?.kind === "approval" ? "拒绝" : "停止任务"
            }
            onPress={() => {
              if (store.interaction()?.kind === "approval")
                store.approve(false);
              else void store.stop();
            }}
          />
          <ActionButton
            label={
              store.interaction()?.kind === "approval" ? "允许一次" : "提交回答"
            }
            kind="primary"
            disabled={
              store.interaction()?.kind === "question" &&
              (!questions().length ||
                questions().some(
                  (question) => !questionAnswers()[question.id]?.trim(),
                ))
            }
            onPress={() => {
              if (store.interaction()?.kind === "approval") store.approve(true);
              else
                store.answer(
                  questions().map((question) => ({
                    id: question.id,
                    selected: [],
                    custom: questionAnswers()[question.id],
                  })),
                );
            }}
          />
        </View>
      </Panel>
    </View>
  );
}
mount(App);
