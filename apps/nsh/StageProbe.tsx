import { cleanup, mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { BackHandler } from "nsh/mobile";
import type { VoiceState } from "./generated/looi-runtime.js";
import type {
  FaceStagePosture,
  PluginManifest,
  PluginStagePresentation,
  StageDrawerDetent,
} from "./runtime/plugins/shared-types";
import type { FaceVisualState } from "./ui/RobotFace";
import {
  registerPluginUiModule,
  unregisterPluginUiModule,
} from "./ui/plugins/registry";
import type { PluginViewContext } from "./ui/plugins/ui-contracts";
import {
  MorphableStage,
  type ActiveStageLeaseView,
} from "./ui/stage/MorphableStage";

const REFEREE_PLUGIN_ID = "games.werewolf-referee";
const CRASH_CANVAS_PLUGIN_ID = "test.crash-canvas";
const CRASH_DRAWER_PLUGIN_ID = "test.crash-drawer";

const REFEREE_MANIFEST: PluginManifest = {
  id: REFEREE_PLUGIN_ID,
  version: "1.2.0",
  minHostApiVersion: 2,
  category: "games_social",
  icon: "sparkles",
  name: { "zh-CN": "狼人杀裁判", "en-US": "Werewolf Referee" },
  summary: { "zh-CN": "桌面移动主持与身份核验", "en-US": "Mobile tabletop referee" },
  author: { name: "LOOI Studio", verified: true },
  permissions: ["stage.ui", "face.control", "body.motion"],
};

function StageProbeApp() {
  const activeStage = signal<ActiveStageLeaseView | null>(null);
  const roundPhase = signal("天黑请闭眼");
  const selectedSeat = signal<number | null>(null);
  const crashDrawerTrigger = signal(false);
  const toastText = signal("");
  const lastCrashLog = signal("");
  const staleResponseText = signal("");
  const settingsOpenedCount = signal(0);
  const composeOpen = signal(false);
  const composeDraft = signal("");
  let revisionSeq = 0;
  const faceState = signal<FaceVisualState>({
    expression: "neutral",
    gaze: { x: 0, y: 0 },
    blinkProgress: 0,
  });
  const voiceState = signal<VoiceState>({
    phase: "idle",
    muted: false,
    wakeEnabled: false,
    transcript: "",
    error: "",
  });

  registerPluginUiModule({
    pluginId: REFEREE_PLUGIN_ID,
    StageCapsule: (p) => (
      <View class="flex-row items-center gap-2">
        <Text class="text-stage-pill-fg text-xs font-semibold">
          {`阶段：${String((p.ctx.state() as { phase?: string }).phase ?? "")}`}
        </Text>
      </View>
    ),
    StageCanvas: (p) => (
      <View class="flex-1 justify-end items-end pb-2">
        <View
          class="rounded-2xl border border-stage-pill-border bg-elevated-glass p-3 gap-2"
          style={{ pointerEvents: "auto" }}
        >
          <Text class="text-stage-fg text-xs font-bold">座位选择画布</Text>
          <View class="flex-row items-center gap-2">
            <Button
              testID="seat-pick-3"
              onPress={() => void p.ctx.sendCommand({ pickSeat: 3 })}
              class="h-11 px-3 rounded-xl bg-eye-core items-center justify-center"
            >
              <Text class="text-stage-bg text-xs font-bold">查验 3 号</Text>
            </Button>
            <Text class="text-stage-pill-muted text-xs">
              {`已选：${String((p.ctx.state() as { seat?: number | null }).seat ?? "无")}`}
            </Text>
          </View>
        </View>
      </View>
    ),
    StageDrawer: (p) => (
      <View class="flex-1 justify-between">
        <View class="flex-row items-center justify-between">
          <Text class="text-stage-fg text-sm font-bold">
            {`狼人杀控制台 · 档位:${p.detent()}`}
          </Text>
          <Button
            testID="referee-next-phase"
            onPress={() => void p.ctx.sendCommand({ nextPhase: "预言家请睁眼" })}
            class="h-11 px-3 rounded-xl border border-stage-pill-border bg-stage-pill-bg items-center justify-center"
          >
            <Text class="text-stage-pill-fg text-xs font-semibold">下一环节</Text>
          </Button>
        </View>
      </View>
    ),
  });

  registerPluginUiModule({
    pluginId: CRASH_CANVAS_PLUGIN_ID,
    StageCanvas: () => {
      throw new Error("boom_in_stage_canvas");
    },
  });

  registerPluginUiModule({
    pluginId: CRASH_DRAWER_PLUGIN_ID,
    StageDrawer: () => (
      <View class="p-2">
        <Text class="text-stage-fg text-xs">
          {(() => {
            if (crashDrawerTrigger()) {
              throw new Error("boom_in_stage_drawer_reactive");
            }
            return "抽屉正常运行中";
          })()}
        </Text>
      </View>
    ),
  });

  cleanup(() => {
    unregisterPluginUiModule(REFEREE_PLUGIN_ID);
    unregisterPluginUiModule(CRASH_CANVAS_PLUGIN_ID);
    unregisterPluginUiModule(CRASH_DRAWER_PLUGIN_ID);
  });

  const makeCtx = (pluginId: string): PluginViewContext<any, any> => ({
    pluginId,
    manifest: () => ({ ...REFEREE_MANIFEST, id: pluginId }),
    state: () => ({ phase: roundPhase(), seat: selectedSeat() }),
    configuration: () => ({}),
    enabled: () => true,
    lifecycle: () => "active",
    dependencies: () => [],
    busy: () => false,
    uiError: () => lastCrashLog(),
    auth: () => undefined,
    lastExecution: () => undefined,
    lastError: () => undefined,
    stagePresentation: () => activeStage()?.presentation,
    locale: () => "zh-CN",
    sendCommand: async (cmd: any) => {
      if (cmd && typeof cmd === "object") {
        if ("pickSeat" in cmd) selectedSeat.set(Number(cmd.pickSeat));
        if ("nextPhase" in cmd) roundPhase.set(String(cmd.nextPhase));
      }
      // Simulate runtime.sync() re-reading a fresh deep-cloned activeStage with unchanged revision
      const current = activeStage();
      if (current) {
        activeStage.set(JSON.parse(JSON.stringify(current)));
      }
      return undefined as any;
    },
    configure: async () => {},
    refresh: async () => {},
    beginLogin: async () => {},
    cancelLogin: async () => {},
    logout: async () => {},
    notify: (msg) => toastText.set(msg),
    exitStage: () => activeStage.set(null),
  });

  const setPosture = (
    facePosture: FaceStagePosture,
    drawerDetent: StageDrawerDetent = "peek",
    allowUserSwipeCollapse = true,
  ) => {
    revisionSeq += 1;
    const presentation: PluginStagePresentation = {
      active: true,
      facePosture,
      drawerDetent,
      allowUserSwipeCollapse,
      hideDefaultDock: true,
    };
    activeStage.set({
      pluginId: REFEREE_PLUGIN_ID,
      revision: revisionSeq,
      presentation,
    });
  };

  BackHandler.on("press", () => {
    if (activeStage() !== null) {
      activeStage.set(null);
      return true;
    }
    return false;
  });

  return (
    <View class="flex-1 bg-stage-bg">
      <MorphableStage
        active={true}
        ready={true}
        busy={false}
        faceState={faceState()}
        statusText={`陪伴待机 · 设置点击:${settingsOpenedCount()}`}
        toastText={toastText()}
        voiceState={voiceState()}
        voiceAudioLevel={0}
        voiceProviderLabel="豆包"
        wakeGuideDismissed={false}
        responseText={staleResponseText()}
        composeOpen={composeOpen()}
        composeDraft={composeDraft()}
        activeStage={activeStage()}
        getPluginViewContext={makeCtx}
        onToggleVoice={() => {}}
        onToggleCompose={() => composeOpen.set(!composeOpen())}
        onChangeDraft={(v) => composeDraft.set(v)}
        onSubmitDraft={() => composeOpen.set(false)}
        onOpenSettings={() => settingsOpenedCount.update((n) => n + 1)}
        onOpenResponse={() => {}}
        onExitStage={() => activeStage.set(null)}
        onReportStageCrash={(pluginId, slot, error) => {
          const reason = error instanceof Error ? error.message : String(error);
          lastCrashLog.set(`${pluginId}:${slot}:${reason}`);
          activeStage.set(null);
          toastText.set(`舞台熔断恢复:${pluginId}:${slot}:${reason}`);
        }}
      />

      {/* Compact bottom-left test driver strip sitting safely away from top-right host controls */}
      <View
        class="absolute left-3 top-14 gap-1"
        style={{ zIndex: 50, pointerEvents: "box-none" }}
      >
        <View class="flex-row flex-wrap gap-1" style={{ pointerEvents: "auto", maxWidth: 280 }}>
          <Button
            testID="probe-floating-top"
            onPress={() =>
              setPosture({ kind: "floating_top", scale: 0.32, chrome: "pill" }, "peek")
            }
            class="px-2 py-1 rounded bg-stage-pill-bg"
          >
            <Text class="text-stage-pill-fg text-xs">浮顶</Text>
          </Button>
          <Button
            testID="probe-docked-right"
            onPress={() =>
              setPosture({ kind: "docked_corner", corner: "top_right", scale: 0.28 }, "medium")
            }
            class="px-2 py-1 rounded bg-stage-pill-bg"
          >
            <Text class="text-stage-pill-fg text-xs">右上角标</Text>
          </Button>
          <Button
            testID="probe-split-left"
            onPress={() =>
              setPosture({ kind: "split_left", widthRatio: 0.38 }, "closed")
            }
            class="px-2 py-1 rounded bg-stage-pill-bg"
          >
            <Text class="text-stage-pill-fg text-xs">左分屏</Text>
          </Button>
          <Button
            testID="probe-minimized-locked"
            onPress={() =>
              setPosture({ kind: "minimized_pill" }, "large", false)
            }
            class="px-2 py-1 rounded bg-stage-pill-bg"
          >
            <Text class="text-stage-pill-fg text-xs">极简大抽屉锁</Text>
          </Button>
          <Button
            testID="probe-crash-canvas"
            onPress={() =>
              activeStage.set({
                pluginId: CRASH_CANVAS_PLUGIN_ID,
                presentation: {
                  active: true,
                  facePosture: { kind: "split_left", widthRatio: 0.4 },
                  drawerDetent: "closed",
                },
              })
            }
            class="px-2 py-1 rounded bg-stage-pill-bg"
          >
            <Text class="text-stage-pill-fg text-xs">画布抛错</Text>
          </Button>
          <Button
            testID="probe-mount-drawer-crashable"
            onPress={() => {
              revisionSeq += 1;
              crashDrawerTrigger.set(false);
              activeStage.set({
                pluginId: CRASH_DRAWER_PLUGIN_ID,
                revision: revisionSeq,
                presentation: {
                  active: true,
                  facePosture: { kind: "floating_top", scale: 0.3 },
                  drawerDetent: "medium",
                },
              });
            }}
            class="px-2 py-1 rounded bg-stage-pill-bg"
          >
            <Text class="text-stage-pill-fg text-xs">挂载可崩抽屉</Text>
          </Button>
          <Button
            testID="probe-trigger-drawer-crash"
            onPress={() => crashDrawerTrigger.set(true)}
            class="px-2 py-1 rounded bg-stage-pill-bg"
          >
            <Text class="text-stage-pill-fg text-xs">触发抽屉崩</Text>
          </Button>
          <Button
            testID="probe-toggle-stale-response"
            onPress={() =>
              staleResponseText.set(
                staleResponseText() ? "" : "历史任务回复：不遮挡插件抽屉",
              )
            }
            class="px-2 py-1 rounded bg-stage-pill-bg"
          >
            <Text class="text-stage-pill-fg text-xs">切换历史回复</Text>
          </Button>
        </View>
      </View>
    </View>
  );
}

mount(StageProbeApp);
