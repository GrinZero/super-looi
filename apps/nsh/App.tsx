import { t } from "./i18n";
import { Canvas, effect, host, mount, signal, Text, View, token } from "nsh";
import { Button, Input } from "nsh/base";
import { BackHandler } from "nsh/mobile";
import { createAppStore } from "./store";
import {
  ActionButton,
  LightToast,
  LiveVoiceButton,
  Panel,
  ResponsePreview,
  TextField,
  WakeGuideBar,
} from "./ui/Controls";
import { RobotFace } from "./ui/RobotFace";
import { ManagementShell } from "./ui/ManagementShell";
import { RetainedPage } from "./ui/RetainedPage";

function HomeHeaderIcon(props: { kind: "chat" | "settings"; active?: boolean }) {
  return (
    <Canvas
      class="w-6 h-6"
      draw={(cx, size) => {
        cx.clearRect(0, 0, size.width, size.height);
        cx.save();
        cx.scale(size.width / 24, size.height / 24);
        cx.strokeStyle = token(props.active ? "stage-pill-fg" : "stage-muted");
        cx.lineWidth = 1.8;
        cx.lineCap = "round";
        cx.lineJoin = "round";

        if (props.kind === "chat") {
          cx.beginPath();
          cx.moveTo(7, 4.5);
          cx.lineTo(17, 4.5);
          cx.quadraticCurveTo(20.5, 4.5, 20.5, 8);
          cx.lineTo(20.5, 14.5);
          cx.quadraticCurveTo(20.5, 18, 17, 18);
          cx.lineTo(10, 18);
          cx.lineTo(5, 21);
          cx.lineTo(5, 17.5);
          cx.quadraticCurveTo(3.5, 16.5, 3.5, 14.5);
          cx.lineTo(3.5, 8);
          cx.quadraticCurveTo(3.5, 4.5, 7, 4.5);
          cx.closePath();
          cx.stroke();
          cx.beginPath();
          cx.moveTo(8, 10);
          cx.lineTo(16, 10);
          cx.moveTo(8, 13.5);
          cx.lineTo(13.5, 13.5);
          cx.stroke();
        } else {
          cx.beginPath();
          for (let tooth = 0; tooth < 8; tooth++) {
            for (let edge = 0; edge < 4; edge++) {
              const angle = ((tooth * 4 + edge) * Math.PI) / 16 - Math.PI / 2;
              const radius = edge === 1 || edge === 2 ? 10 : 7.7;
              const x = 12 + Math.cos(angle) * radius;
              const y = 12 + Math.sin(angle) * radius;
              if (tooth === 0 && edge === 0) cx.moveTo(x, y);
              else cx.lineTo(x, y);
            }
          }
          cx.closePath();
          cx.stroke();
          cx.beginPath();
          cx.arc(12, 12, 3, 0, Math.PI * 2);
          cx.stroke();
        }
        cx.restore();
      }}
    />
  );
}

function App() {
  const store = createAppStore();
  BackHandler.on("press", () => store.goBack());
  const missingCutout = signal({ left: 0, right: 0 });
  host.on<{ left: number; right: number }>("super-looi/display-cutout", (insets) => {
    if (missingCutout().left !== insets.left || missingCutout().right !== insets.right)
      missingCutout.set(insets);
  });
  const compose = signal(false),
    draft = signal("");
  const questionAnswers = signal<Record<string, string>>({});
  const responseOpen = signal(false);

  const voiceActive = () =>
    ["connecting", "listening", "speaking"].includes(store.voiceState().phase);

  const responseText = () =>
    ["listening", "speaking"].includes(store.voiceState().phase) &&
    store.voiceState().transcript
      ? store.voiceState().transcript
      : store.message();

  const showingRecoveryNotice = () => store.recoveryNoticeVisible() && responseText() === store.message();

  const approvalLabel = () => {
    const details = store.interaction()?.details;
    if (typeof details?.title === "string") return details.title;
    switch (details?.toolName) {
      case "edit":
      case "write":
      case "write_file":
        return details.willOverwrite ? t("overwriteFile") : t("createFile");
      case "read":
      case "read_file":
        return t("readFile");
      case "bash":
        return t("runALocalShellCommand");
      default:
        return t("executeAction", { action: String(details?.toolName ?? t("localAction")) });
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
    store.openSpace("voice");
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
      class={
        store.activeSpace() === "face"
          ? "flex-1 bg-stage-bg"
          : "flex-1 bg-background"
      }
      style={{
        paddingLeft: store.activeSpace() === "face" ? missingCutout().left : 0,
        paddingRight: store.activeSpace() === "face" ? missingCutout().right : 0,
      }}
    >
      <RetainedPage active={store.activeSpace() === "face"}>
        <View
          class="flex-1 justify-between"
          style={{
            paddingTop: "env(safe-area-inset-top)",
            paddingBottom: "env(safe-area-inset-bottom)",
            paddingLeft: "env(safe-area-inset-left)",
            paddingRight: "env(safe-area-inset-right)",
          }}
        >
          <RobotFace
            active={store.activeSpace() === "face"}
            state={store.face()}
            shift={{ dx: 0, dy: 0 }}
          />

          <View class="flex-1 px-4 py-2.5 justify-between">
            <View class="gap-2">
              <View class="flex-row items-center justify-between gap-3">
                <View
                  class="flex-1 min-w-0 flex-row items-center gap-2 px-2 py-1"
                  style={{ opacity: 0.85, minHeight: 38, flexShrink: 1 }}
                >
                  <View
                    class={
                      voiceActive()
                        ? "w-1.5 h-1.5 rounded-full bg-verified"
                        : "w-1.5 h-1.5 rounded-full bg-eye-core"
                    }
                  />
                  <Text
                    class="text-stage-muted text-xs font-medium"
                    style={{ letterSpacing: 1, flexShrink: 1 }}
                  >
                    {store.status()}
                  </Text>
                </View>

                <View class="flex-row items-center gap-2">
                  <LiveVoiceButton
                    phase={store.voiceState().phase}
                    muted={store.voiceState().muted}
                    audioLevel={store.voiceAudioLevel()}
                    accessibilityLabel={
                      store.voiceState().phase === "speaking"
                        ? t("interruptPlayback")
                        : voiceActive()
                          ? t("endLiveVoice")
                          : t("startProviderVoice", { provider: store.voiceProviderLabel() })
                    }
                    disabled={!store.ready()}
                    onPress={toggleLiveVoice}
                  />

                  <Button
                    testID="compose"
                    accessibilityLabel={t("sendAMessageToLooi")}
                    selected={compose()}
                    onPress={() => compose.set(!compose())}
                    class="w-11 h-11 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75 focus:border-stage-pill-fg"
                  >
                    <HomeHeaderIcon kind="chat" active={compose()} />
                  </Button>

                  <Button
                    testID="connection-settings"
                    accessibilityLabel={t("openConnectionsAndSettings")}
                    onPress={() => store.openSpace("models")}
                    class="w-11 h-11 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75 focus:border-stage-pill-fg"
                  >
                    <HomeHeaderIcon kind="settings" />
                  </Button>
                </View>
              </View>

              <If when={store.toast()}>
                <View class="items-center">
                  <LightToast text={store.toast()} stage={true} />
                </View>
              </If>
            </View>

            <View
              class="items-center gap-2"
              style={{ marginBottom: "env(keyboard-inset-height)" }}
            >
              <If
                when={responseText()}
                else={
                  <If
                    when={
                      !compose() &&
                      !store.wakeGuideDismissed() &&
                      !voiceActive()
                    }
                  >
                    <WakeGuideBar active={store.voiceState().phase === "standby"} onPress={toggleLiveVoice} />
                  </If>
                }
              >
                <ResponsePreview
                  text={responseText()}
                  actionLabel={showingRecoveryNotice() ? t("reviewPendingTasks") : undefined}
                  onOpen={() => showingRecoveryNotice() ? store.openSpace("tasks") : responseOpen.set(true)}
                />
              </If>

              <If when={compose()}>
                <View class="w-full rounded-2xl border border-stage-pill-border bg-ask-bar-bg px-3 py-1.5 flex-row items-center gap-2">
                  <Input
                    testID="message-input"
                    accessibilityLabel={t("sendAMessageToLooi")}
                    value={draft()}
                    onChange={(e) => draft.set(e.value)}
                    onSubmit={send}
                    autoCorrect={false}
                    autoCapitalize="none"
                    maxLength={8192}
                    placeholder={t("askLooiEgListFilesOrWrite")}
                    class="flex-1 h-10 rounded-xl border border-transparent bg-transparent px-2 text-stage-fg text-sm placeholder:text-stage-pill-muted focus:border-ring"
                  />
                  <Button
                    testID="send-message"
                    disabled={!draft().trim() || !store.ready() || store.busy()}
                    onPress={send}
                    class="rounded-full bg-eye-core px-4 items-center justify-center active:opacity-75 disabled:opacity-40"
                    style={{ minHeight: 44 }}
                  >
                    <Text class="text-stage-bg text-xs font-bold">{t("send")}</Text>
                  </Button>
                </View>
              </If>
            </View>
          </View>
        </View>
      </RetainedPage>
      <RetainedPage active={store.activeSpace() !== "face"}>
        <ManagementShell store={store} cutoutInsets={missingCutout()} />
      </RetainedPage>

      {/* Global View Response Modal */}
      <Panel
        open={responseOpen()}
        title={t("looisReply")}
        onClose={() => responseOpen.set(false)}
        height={500}
      >
        <View selectable={true}>
          <Text class="text-foreground text-base">{responseText()}</Text>
        </View>
      </Panel>

      {/* Global Interactive Security & Question Modal */}
      <Panel
        open={Boolean(store.interaction())}
        title={
          store.interaction()?.kind === "approval"
            ? t("allowThisAction")
            : t("looiNeedsYourAnswer")
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
                store.interaction()?.details.message ??
                store.interaction()?.details.path ??
                store.interaction()?.details.toolName ??
                t("localAction"),
            )}
          </Text>
          <If when={store.interaction()?.details.operation === "write"}>
            <Text class="text-muted-foreground text-sm">{t("contentToWrite")}</Text>
            <View class="rounded-xl bg-background p-3" selectable={true}>
              <Text class="text-foreground text-sm font-mono">
                {String(store.interaction()?.details.content ?? "")}
              </Text>
            </View>
          </If>
          <Text class="text-muted-foreground text-sm">
            {t("allowThisActionOnceYouCanDecline")}</Text>
        </If>
        <View class="flex-row justify-end gap-3 pt-2">
          <ActionButton
            label={
              store.interaction()?.kind === "approval" ? t("decline") : t("stopTask")
            }
            onPress={() => {
              if (store.interaction()?.kind === "approval")
                store.approve(false);
              else void store.stop();
            }}
          />
          <ActionButton
            label={
              store.interaction()?.kind === "approval" ? t("allowOnce") : t("submitAnswer")
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
