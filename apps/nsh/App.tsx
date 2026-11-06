import { effect, mount, signal, Text, View, windowSize } from "nsh";
import { createAppStore } from "./store";
import { ActionButton, Panel, TextField, ResponsePreview } from "./ui/Controls";
import { VoicePanel } from "./ui/VoicePanel";
import { HomePanel } from "./ui/HomePanel";
import { TasksPanel } from "./ui/TasksPanel";
import { RobotFace } from "./ui/RobotFace";

function App() {
  const store = createAppStore();
  const settings = signal(false),
    compose = signal(false),
    draft = signal("");
  const baseUrl = signal(""),
    model = signal(""),
    apiKey = signal(""),
    saving = signal(false),
    configError = signal("");
  const questionAnswers = signal<Record<string, string>>({});
  const responseOpen = signal(false);
  const tasksOpen = signal(false);
  const homeOpen = signal(false);
  const voiceOpen = signal(false);
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
      case "control_home_device":
        return "控制家居设备";
      case "remember_fact":
        return "保存待确认记忆";
      case "forget_memory":
        return "删除记忆";
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
    configError.set("");
    settings.set(true);
  };
  const save = async () => {
    if (saving()) return;
    saving.set(true);
    configError.set("");
    try {
      await store.configure({
        baseUrl: baseUrl(),
        model: model(),
        apiKey: apiKey(),
      });
      apiKey.set("");
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
      <RobotFace
        state={store.face()}
        shift={{ dx: 0, dy: 0 }}
        bottomInset={store.message() ? 120 : 72}
      />
      <View class="flex-1 px-6 py-3">
        <View class="flex-row items-center justify-between gap-3">
          <View class="gap-1">
            <Text
              class="text-foreground text-lg font-semibold"
              style={{ letterSpacing: 5 }}
            >
              LOOI
            </Text>
            <Text class="text-muted-foreground text-xs">{store.status()}</Text>
          </View>
          <View class="flex-row gap-2">
            <ActionButton
              label="任务"
              testID="task-history"
              disabled={!store.ready()}
              onPress={() => {
                store.refreshTasks();
                tasksOpen.set(true);
              }}
            />
            <ActionButton
              label="连接"
              testID="connection-settings"
              onPress={openSettings}
            />
          </View>
        </View>
        <View class="flex-1" />
        <View class="gap-3 items-center">
          <If when={store.message()}>
            <ResponsePreview
              text={store.message()}
              onOpen={() => responseOpen.set(true)}
            />
          </If>
          <View class="flex-row gap-3 items-center justify-center">
            <ActionButton
              label="家居"
              testID="home-settings"
              disabled={!store.ready() || store.busy()}
              onPress={() => homeOpen.set(true)}
            />
            <ActionButton
              label={store.voiceTask() ? "确认语音任务" : "LIVE"}
              disabled={!store.ready()}
              onPress={() => voiceOpen.set(true)}
            />
            <ActionButton
              label="对话"
              testID="compose"
              kind="primary"
              onPress={() => compose.set(true)}
            />
            <If when={store.busy()}>
              <ActionButton
                label="停止任务"
                kind="danger"
                onPress={() => {
                  void store.stop();
                }}
              />
            </If>
          </View>
          <Text class="text-muted-foreground text-xs">
            {["listening", "speaking"].includes(store.voiceState().phase)
              ? store.voiceState().muted
                ? "麦克风静音"
                : "麦克风开启"
              : "麦克风关闭"}
            　·　底座未连接　·　
            {store.configuration().hasKey ? "模型已配置" : "模型未配置"}
            {store.recoveryCount()
              ? ` · ${store.recoveryCount()} 项任务待核实`
              : ""}
          </Text>
        </View>
      </View>

      <VoicePanel
        open={voiceOpen()}
        store={store}
        onClose={() => voiceOpen.set(false)}
      />
      <HomePanel
        open={homeOpen()}
        store={store}
        onClose={() => homeOpen.set(false)}
      />
      <TasksPanel
        open={tasksOpen()}
        store={store}
        onClose={() => tasksOpen.set(false)}
        onNewConversation={() => {
          if (store.newConversation()) {
            tasksOpen.set(false);
            draft.set("");
          }
        }}
      />
      <Panel
        open={compose()}
        title="和 LOOI 聊聊"
        height={300}
        onClose={() => compose.set(false)}
      >
        <TextField
          label="你想说什么？"
          testID="message-input"
          value={draft()}
          onChange={(value) => draft.set(value)}
          onSubmit={send}
          placeholder="也可以说：记住钥匙在书架上"
        />
        <Text class="text-muted-foreground text-sm">
          记住、回忆和忘记可以在本机离线使用。
        </Text>
        <View class="flex-row justify-end gap-3">
          <ActionButton label="取消" onPress={() => compose.set(false)} />
          <ActionButton
            label="发送"
            testID="send-message"
            kind="primary"
            disabled={!draft().trim() || !store.ready() || store.busy()}
            onPress={send}
          />
        </View>
      </Panel>

      <Panel
        open={settings()}
        title="连接设置"
        height={500}
        wide={true}
        dismissible={!saving()}
        onClose={() => {
          if (!saving()) {
            apiKey.set("");
            settings.set(false);
          }
        }}
      >
        <Text class="text-muted-foreground text-sm">
          对话由手机直接连接你的模型服务。
        </Text>
        <View
          style={{
            flexDirection: windowSize().width >= 680 ? "row" : "column",
            gap: 20,
          }}
        >
          <View class="flex-1 gap-4" style={{ minWidth: 0 }}>
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
          </View>
          <View class="flex-1 gap-4" style={{ minWidth: 0 }}>
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
                  : "输入 API Key"
              }
            />
            <Text class="text-muted-foreground text-sm">
              API Key 保存在这台设备的系统安全存储中。
            </Text>
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
                  !baseUrl().trim() ||
                  !model().trim() ||
                  store.busy()
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
          <Text class="text-foreground text-base">{store.message()}</Text>
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
                (
                  store.interaction()?.details.arguments as
                    | Record<string, unknown>
                    | undefined
                )?.fact ??
                (
                  store.interaction()?.details.arguments as
                    | Record<string, unknown>
                    | undefined
                )?.query ??
                store.interaction()?.details.toolName ??
                "本机操作",
            )}
          </Text>
          <If
            when={
              store.interaction()?.details.toolName === "control_home_device"
            }
          >
            <View selectable={true}>
              <Text class="text-foreground text-sm">
                {JSON.stringify(
                  store.interaction()?.details.arguments,
                  null,
                  2,
                )}
              </Text>
              <Text class="text-muted-foreground text-sm">
                {store.homeConfiguration().mode === "simulation"
                  ? "仅演示设备，不会控制真实家居。"
                  : "将操作当前连接中的设备；结果以实际回读为准。"}
              </Text>
            </View>
          </If>
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
