import { effect, signal, Text, View, Scroll, windowSize } from "nsh";
import { Button } from "nsh/base";
import type { LlmBrandId } from "../generated/looi-runtime.js";
import type { createAppStore, AppSpace } from "../store";
import { ActionButton, LightToast } from "./Controls";
import { ModelsSpaceView } from "./ModelsSpaceView";
import { VoiceSpaceView } from "./VoiceSpaceView";
import { HomeSpaceView } from "./HomeSpaceView";
import { TasksSpaceView } from "./TasksSpaceView";

export function ManagementShell(props: {
  store: ReturnType<typeof createAppStore>;
}) {
  const selectedBrandId = signal<LlmBrandId>("openai");
  const homeModeTab = signal<"direct_miot" | "external_ha" | "simulation">(
    "direct_miot",
  );

  // Sync selectedBrandId only when active brand transitions
  let lastSyncedActiveBrand: LlmBrandId | null = null;
  effect(() => {
    const activeBrand = props.store.llm().active?.brandId ?? null;
    if (activeBrand && activeBrand !== lastSyncedActiveBrand) {
      lastSyncedActiveBrand = activeBrand;
      selectedBrandId.set(activeBrand);
    }
  });

  // Sync homeModeTab only when configured home mode transitions
  let lastSyncedHomeMode = "";
  effect(() => {
    const mode = props.store.homeConfiguration().mode;
    if (mode === lastSyncedHomeMode) return;
    lastSyncedHomeMode = mode;
    if (mode === "external_ha") {
      homeModeTab.set("external_ha");
    } else if (mode === "simulation") {
      homeModeTab.set("simulation");
    } else if (mode === "direct_miot") {
      homeModeTab.set("direct_miot");
    }
  });

  const cycleAppearance = () => {
    const current = props.store.appearanceMode();
    if (current === "system") props.store.setAppearance("light");
    else if (current === "light") props.store.setAppearance("dark");
    else props.store.setAppearance("system");
  };

  const appearanceLabel = () => {
    const mode = props.store.appearanceMode();
    if (mode === "light") return "外观: 日间";
    if (mode === "dark") return "外观: 夜间";
    return "外观: 自动";
  };

  const wide = () => windowSize().width >= 600;

  const renderNavButton = (space: AppSpace, label: string, testId: string) => {
    const isSelected = () => props.store.activeSpace() === space;
    return (
      <Button
        testID={testId}
        accessibilityLabel={label}
        onPress={() => props.store.openSpace(space)}
        class={
          isSelected()
            ? "min-h-11 w-11 rounded-xl bg-card border border-border items-center justify-center active:opacity-75"
            : "min-h-11 w-11 rounded-xl items-center justify-center active:opacity-75"
        }
      >
        <View class="items-center justify-center relative">
          <Text
            class={
              isSelected()
                ? "text-foreground text-xs font-bold"
                : "text-muted-foreground text-xs font-medium"
            }
          >
            {label}
          </Text>
          <If when={space === "tasks" && props.store.recoveryCount() > 0}>
            <View class="absolute -top-1 -right-1.5 w-2 h-2 rounded-full bg-destructive" />
          </If>
        </View>
      </Button>
    );
  };

  const homeModes: Array<{
    id: "direct_miot" | "external_ha" | "simulation";
    label: string;
  }> = [
    { id: "direct_miot", label: "米家直连" },
    { id: "external_ha", label: "Home Assistant" },
    { id: "simulation", label: "离线演示" },
  ];

  const renderContextPillBar = () => (
    <View class="flex-1 min-w-0 h-11 flex-row items-center">
      <If when={props.store.activeSpace() === "models"}>
        <Scroll
          horizontal={true}
          scrollbar={false}
          class="flex-1 h-11"
          contentClass="flex-row items-center gap-1 h-11 pr-1"
        >
          <Each of={props.store.llm().brands} key={(b) => b.brandId}>
            {(b) => {
              const isSelected = () => selectedBrandId() === b().brandId;
              const hasCreds = () =>
                b().configured ||
                b().channels.some((c) => c.hasApiKey || c.hasOAuth);

              return (
                <Button
                  testID={`brand-${b().brandId}`}
                  onPress={() => selectedBrandId.set(b().brandId)}
                  class={
                    isSelected()
                      ? "min-h-11 px-2.5 rounded-full bg-primary border border-transparent flex-row items-center gap-1.5 active:opacity-75"
                      : "min-h-11 px-2.5 rounded-full border border-border bg-muted flex-row items-center gap-1.5 active:opacity-75"
                  }
                >
                  <If when={hasCreds()}>
                    <View class="w-1.5 h-1.5 rounded-full bg-verified" />
                  </If>
                  <Text
                    class={
                      isSelected()
                        ? "text-primary-foreground text-xs font-semibold"
                        : "text-muted-foreground text-xs font-medium"
                    }
                    style={{ numberOfLines: 1 }}
                  >
                    {b().label}
                  </Text>
                </Button>
              );
            }}
          </Each>
        </Scroll>
      </If>

      <If when={props.store.activeSpace() === "voice"}>
        <View class="flex-row items-center gap-2 flex-1 min-w-0 h-11">
          <Text class="text-foreground text-xs font-semibold">实时语音</Text>
          <View class="px-2.5 py-1 rounded-full border border-border bg-muted flex-row items-center gap-1.5">
            <View
              class={
                props.store.voiceConfigured()
                  ? "w-1.5 h-1.5 rounded-full bg-verified"
                  : "w-1.5 h-1.5 rounded-full bg-border"
              }
            />
            <Text class="text-muted-foreground text-xs">
              {props.store.voiceConfigured()
                ? "豆包凭证就绪"
                : "尚未配置语音凭证"}
            </Text>
          </View>
        </View>
      </If>

      <If when={props.store.activeSpace() === "home"}>
        <Scroll
          horizontal={true}
          scrollbar={false}
          class="flex-1 h-11"
          contentClass="flex-row items-center gap-1.5 h-11"
        >
          <Each of={homeModes} key={(m) => m.id}>
            {(m) => {
              const active = () => homeModeTab() === m().id;
              return (
                <Button
                  onPress={() => homeModeTab.set(m().id)}
                  class={
                    active()
                      ? "min-h-11 px-3 rounded-full bg-primary border border-transparent items-center justify-center active:opacity-75"
                      : "min-h-11 px-3 rounded-full border border-border bg-muted items-center justify-center active:opacity-75"
                  }
                >
                  <Text
                    class={
                      active()
                        ? "text-primary-foreground text-xs font-semibold"
                        : "text-muted-foreground text-xs font-medium"
                    }
                  >
                    {m().label}
                  </Text>
                </Button>
              );
            }}
          </Each>
          <If when={props.store.homeConfiguration().mode !== "disabled"}>
            <Button
              testID="home-disable"
              onPress={() =>
                void props.store.configureHome({ mode: "disabled" })
              }
              class="min-h-11 px-2.5 items-center justify-center active:opacity-75"
            >
              <Text class="text-muted-foreground text-xs">停用家居</Text>
            </Button>
          </If>
        </Scroll>
      </If>

      <If when={props.store.activeSpace() === "tasks"}>
        <View class="flex-row items-center gap-2 flex-1 min-w-0 h-11">
          <Text class="text-foreground text-xs font-semibold">
            任务与审计记录
          </Text>
          <ActionButton
            label="开始新对话"
            testID="new-conversation-btn"
            compact={true}
            disabled={props.store.busy()}
            onPress={() => props.store.newConversation()}
          />
          <ActionButton
            label="刷新"
            testID="refresh-tasks-btn"
            compact={true}
            onPress={() => props.store.refreshTasks(props.store.tasks().offset)}
          />
        </View>
      </If>
    </View>
  );

  const renderActiveWorkspace = () => (
    <View class="flex-1 min-h-0">
      <If when={props.store.activeSpace() === "models"}>
        <ModelsSpaceView
          store={props.store}
          selectedBrandId={() => selectedBrandId()}
        />
      </If>
      <If when={props.store.activeSpace() === "voice"}>
        <VoiceSpaceView store={props.store} />
      </If>
      <If when={props.store.activeSpace() === "home"}>
        <HomeSpaceView
          store={props.store}
          modeTab={() => homeModeTab()}
        />
      </If>
      <If when={props.store.activeSpace() === "tasks"}>
        <TasksSpaceView store={props.store} />
      </If>
    </View>
  );

  return (
    <If
      when={wide()}
      else={
        // Handheld portrait layout
        <View class="flex-1 bg-background">
          {/* Top header */}
          <View class="min-h-12 border-b border-border px-3 py-1.5 flex-row items-center justify-between gap-2 bg-card">
            <Button
              testID="back-to-face"
              accessibilityLabel="返回桌宠主页"
              onPress={() => props.store.backToFace()}
              class="min-h-11 px-2.5 rounded-xl bg-stage-bg border border-border flex-row items-center justify-center gap-1 active:opacity-75"
            >
              <View class="w-2 h-2 rounded-full bg-eye-core" />
              <View class="w-2 h-2 rounded-full bg-eye-core" />
            </Button>
            {renderContextPillBar()}
            <Button
              testID="appearance-cycle"
              onPress={cycleAppearance}
              class="min-h-11 px-2.5 rounded-full border border-border bg-card items-center justify-center active:opacity-75"
            >
              <Text class="text-foreground text-xs font-medium">
                {appearanceLabel()}
              </Text>
            </Button>
            <Button
              testID="back-btn"
              onPress={() => props.store.backToFace()}
              class="min-h-11 px-2.5 rounded-full border border-border bg-card items-center justify-center active:opacity-75"
            >
              <Text class="text-foreground text-xs font-medium">返回</Text>
            </Button>
          </View>

          {/* Main Workspace */}
          <View class="flex-1 p-3 min-h-0">
            <If when={props.store.toast()}>
              <View class="items-center mb-2">
                <LightToast text={props.store.toast()} />
              </View>
            </If>
            {renderActiveWorkspace()}
          </View>

          {/* Bottom navigation bar */}
          <View class="min-h-14 bg-sidebar border-t border-border flex-row items-center justify-around px-2 py-1">
            {renderNavButton("models", "模型", "nav-models")}
            {renderNavButton("voice", "语音", "nav-voice")}
            {renderNavButton("home", "家居", "nav-home")}
            {renderNavButton("tasks", "任务", "nav-tasks")}
          </View>
        </View>
      }
    >
      {/* Landscape dock layout */}
      <View class="flex-1 flex-row bg-background">
        {/* 58pt Left Slim Rail */}
        <View class="w-[58px] bg-sidebar border-r border-border py-2.5 items-center justify-between">
          <Button
            testID="back-to-face"
            accessibilityLabel="返回桌宠主页"
            onPress={() => props.store.backToFace()}
            class="w-11 h-11 rounded-xl bg-stage-bg border border-border flex-row items-center justify-center gap-1.5 active:opacity-75"
          >
            <View class="w-2 h-2 rounded-full bg-eye-core" />
            <View class="w-2 h-2 rounded-full bg-eye-core" />
          </Button>

          <View class="gap-1.5 items-center">
            {renderNavButton("models", "模型", "nav-models")}
            {renderNavButton("voice", "语音", "nav-voice")}
            {renderNavButton("home", "家居", "nav-home")}
            {renderNavButton("tasks", "任务", "nav-tasks")}
          </View>

          <View
            class={
              props.store.ready()
                ? "w-2 h-2 rounded-full bg-verified"
                : "w-2 h-2 rounded-full bg-border"
            }
          />
        </View>

        {/* Right Main Workspace */}
        <View class="flex-1 min-w-0 flex flex-col">
          {/* Top 48pt Context Pill Bar */}
          <View class="min-h-12 border-b border-border px-4 py-1.5 flex-row items-center justify-between gap-3 bg-card">
            {renderContextPillBar()}
            <View class="flex-row items-center gap-2">
              <Button
                testID="appearance-cycle"
                onPress={cycleAppearance}
                class="min-h-11 px-3 rounded-full border border-border bg-card items-center justify-center active:opacity-75"
              >
                <Text class="text-foreground text-xs font-medium">
                  {appearanceLabel()}
                </Text>
              </Button>
              <Button
                testID="back-btn"
                onPress={() => props.store.backToFace()}
                class="min-h-11 px-3 rounded-full border border-border bg-card items-center justify-center active:opacity-75"
              >
                <Text class="text-foreground text-xs font-medium">返回</Text>
              </Button>
            </View>
          </View>

          {/* Bottom Workspace Body */}
          <View class="flex-1 p-3.5 min-h-0">
            <If when={props.store.toast()}>
              <View class="items-center mb-2">
                <LightToast text={props.store.toast()} />
              </View>
            </If>
            {renderActiveWorkspace()}
          </View>
        </View>
      </View>
    </If>
  );
}
