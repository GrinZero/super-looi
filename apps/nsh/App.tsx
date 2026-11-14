import { t } from "./i18n";
import { effect, host, mount, signal, Text, View } from "nsh";
import { BackHandler } from "nsh/mobile";
import { createAppStore } from "./store";
import { ActionButton, Panel, TextField } from "./ui/Controls";
import { ManagementShell } from "./ui/ManagementShell";
import { RetainedPage } from "./ui/RetainedPage";
import { MorphableStage } from "./ui/stage/MorphableStage";

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

  const responseText = () =>
    ["listening", "speaking"].includes(store.voiceState().phase) &&
    store.voiceState().transcript
      ? store.voiceState().transcript
      : store.message();

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
    >
      <RetainedPage active={store.activeSpace() === "face"}>
        <MorphableStage
          active={store.activeSpace() === "face"}
          ready={store.ready()}
          busy={store.busy()}
          cutoutInsets={missingCutout()}
          faceState={store.face()}
          statusText={store.status()}
          toastText={store.toast()}
          voiceState={store.voiceState()}
          voiceAudioLevel={store.voiceAudioLevel()}
          voiceProviderLabel={store.voiceProviderLabel()}
          wakeGuideDismissed={store.wakeGuideDismissed()}
          responseText={responseText()}
          composeOpen={compose()}
          composeDraft={draft()}
          activeStage={store.activeStage()}
          getPluginViewContext={(id) => store.pluginViewContext(id)}
          onToggleVoice={toggleLiveVoice}
          onToggleCompose={() => compose.set(!compose())}
          onChangeDraft={(value) => draft.set(value)}
          onSubmitDraft={send}
          onOpenSettings={() => store.openSpace("models")}
          onOpenResponse={() => responseOpen.set(true)}
          onExitStage={(id) => store.exitPluginStage(id)}
          onReportStageCrash={(id, slot, error) =>
            store.reportPluginStageCrash(id, slot, error)
          }
        />
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
