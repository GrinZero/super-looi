import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppState, PanResponder, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useLocalSearchParams } from "expo-router";
import type { UserActionRef } from "@super-looi/contracts";
import { PresenceStateManager, type InnerSpaceDestination } from "../src/shell/presence-state.js";
import { DockedLongevitySupervisor } from "../src/shell/longevity-supervisor.js";
import { RobotFaceController, KeepAwakeController } from "../src/ui/robot-face-controller.js";
import { LightToastQueue } from "../src/ui/light-toast-queue.js";
import { MemoriesConformalSpaceController } from "../src/ui/memories-space.js";
import { TasksAndRulesSpaceController } from "../src/ui/tasks-and-rules-space.js";
import { CabinSpaceController } from "../src/ui/cabin-space.js";
import { RobotFaceView } from "../src/ui/components/RobotFaceView.js";
import { LooiIcon, LooiWaveOrnament } from "../src/ui/components/LooiIcon.js";
import { ConformalDeviceShell, LightToastCapsule } from "../src/ui/components/ConformalDeviceShell.js";
import {
  ConversationSubtitleOverlay,
  QuickDrawerOverlay,
  SimLabSheet,
  type QuickDrawerDestination,
} from "../src/ui/components/QuickDrawerModal.js";
import { MemoriesSpaceView, getMemorySpaceSummary, syncMemorySpaceFromHub } from "../src/ui/spaces/MemoriesSpaceView.js";
import { TasksSpaceView, getTasksSpaceSummary } from "../src/ui/spaces/TasksSpaceView.js";
import { LocalHomeSpaceView } from "../src/ui/spaces/LocalHomeSpaceView.js";
import { createNativeLocalCenter } from "../src/runtime/native-local-center.js";
import { LocalVoiceSocket } from "../src/runtime/local-voice-socket.js";
import { CabinSpaceView } from "../src/ui/spaces/CabinSpaceView.js";
import { requestAcceptanceReport, type MobileAcceptanceReport } from "../src/runtime/acceptance-api.js";
import { AgentInteractionSheet } from "../src/ui/components/AgentInteractionSheet.js";
import { LiveVoiceClient, fetchHubMemories, type LiveVoicePhase, type LiveAgentInteraction } from "../src/runtime/live-voice-client.js";
import { LOOI_PALETTE as palette } from "../src/ui/theme.js";
import { useWakeGuide } from "../src/ui/use-wake-guide.js";
import { useHomeStatus } from "../src/runtime/use-home-status.js";

export type ActiveSpace = "face" | "memories" | "tasks_and_rules" | "home" | "cabin";
const WAKE_TAG = "super-looi-docked-presence";
const HUB_ORIGIN = process.env.EXPO_PUBLIC_HUB_URL
  ?? process.env.EXPO_PUBLIC_LOOI_SERVER_URL
  ?? "http://127.0.0.1:3000";

function trustedTap(): UserActionRef {
  const now = Date.now();
  return {
    event_id: `tap_${now}_${Math.random().toString(36).slice(2, 7)}`,
    ui_session_id: "mobile_presence",
    kind: "tap",
    captured_at: new Date(now).toISOString(),
    expires_at: new Date(now + 10_000).toISOString(),
  };
}

/** Controllers own policy; local demonstrations never claim physical execution. */
function createControllers(onChange: () => void) {
  const toasts = new LightToastQueue();
  const longevity = new DockedLongevitySupervisor(undefined, {
    onThermalChange: onChange,
    onMicroShiftUpdate: onChange,
  });
  const face = new RobotFaceController({
    emergencyStopHandler: { stop: async () => { await longevity.triggerEmergencyStop("local_simulation"); } },
    onStateChange: onChange,
  });
  const presence = new PresenceStateManager({ onStateChange: onChange });
  const memories = new MemoriesConformalSpaceController({ onCardSelected: onChange, onMorphStateChange: onChange });
  syncMemorySpaceFromHub(memories, []);
  const tasks = new TasksAndRulesSpaceController({ onMorphStateChange: onChange, onLayoutChange: onChange }, toasts);
  const cabin = new CabinSpaceController({
    onMorphStateChange: onChange,
    onSubsystemsChange: onChange,
    onVoiceProviderChange: onChange,
    onVisionProviderChange: onChange,
  });
  presence.handleDockChange(true);
  cabin.updateSubsystemStatus("bleDock", "disconnected");
  cabin.updateSubsystemStatus("hub", "disconnected");
  cabin.updateSubsystemStatus("homeAssistant", "disconnected");
  cabin.setSensorStatus({ camera: false, microphone: false, backgroundProcessing: false });
  return { presence, face, toasts, memories, tasks, cabin, longevity, keepAwake: new KeepAwakeController() };
}

export default function SuperLooiScreen() {
  const params = useLocalSearchParams<{ space?: string; overlay?: string }>() ?? {};
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const narrowWakeBar = width < 600 || fontScale > 1.3;
  const mounted = useRef(false);
  const [, render] = useReducer((value: number) => value + 1, 0);
  const refresh = useCallback(() => { if (mounted.current) render(); }, []);
  const [controllers] = useState(() => createControllers(refresh));
  const { presence, face, toasts, memories, tasks, cabin, longevity, keepAwake } = controllers;
  const [localCenter] = useState(() => createNativeLocalCenter(HUB_ORIGIN));
  const runtimeVoiceMode = localCenter.preferences.voiceMode;
  const runtimeRevision = localCenter.revision;
  useHomeStatus(HUB_ORIGIN, cabin, localCenter, runtimeRevision);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const { visible: wakeGuideVisible, dismiss: dismissWakeGuide } = useWakeGuide();
  const [simLabVisible, setSimLabVisible] = useState(false);
  const [subtitle, setSubtitle] = useState("");
  const [voicePhase, setVoicePhase] = useState<LiveVoicePhase>("disconnected");
  const [askVisible, setAskVisible] = useState(false);
  const [askInput, setAskInput] = useState("");
  const liveVoiceRef = useRef<LiveVoiceClient | null>(null);
  const [activeAgentTask, setActiveAgentTask] = useState<string | null>(null);
  const [agentInteraction, setAgentInteraction] = useState<{ taskId: string; request: LiveAgentInteraction } | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [acceptanceRunning, setAcceptanceRunning] = useState(false);
  const [acceptanceReport, setAcceptanceReport] = useState<MobileAcceptanceReport | null>(null);
  const [acceptanceError, setAcceptanceError] = useState<string | null>(null);
  const acceptanceAbort = useRef<AbortController | null>(null);
  const sceneTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const acceptanceBusy = useRef(false);
  const wakeOperations = useRef<Promise<void>>(Promise.resolve());
  const smoothGaze = useRef({ x: 0, y: 0 });
  const snapshot = presence.getSnapshot();
  const activeSpace: ActiveSpace = snapshot.innerSpace === "none" ? "face" : snapshot.innerSpace;
  const privacyPaused = snapshot.captureMode === "off";
  // Reapplying the same expression would interrupt the controller's closed blink frame.
  if (face.getState().expression !== snapshot.faceExpression) face.setExpression(snapshot.faceExpression);
  face.setBodyState(snapshot.bodyState);
  const faceState = face.getState();
  const overlayOpen = drawerVisible || simLabVisible;
  const canSwipeOpenDrawerRef = useRef(false);
  useEffect(() => {
    canSwipeOpenDrawerRef.current = !faceState.isEmergencyStopAvailable && !privacyPaused && !overlayOpen;
  }, [faceState.isEmergencyStopAvailable, privacyPaused, overlayOpen]);
  const microShift = longevity.getPixelMicroShift();
  const activeToast = toasts.getActiveToast();
  const visibleToast = snapshot.faceExpression === "speaking" && activeToast?.priority !== "urgent" ? null : activeToast;

  const notify = useCallback((message: string) => {
    toasts.enqueueToast(message, { durationMs: 3000 });
    refresh();
  }, [toasts, refresh]);
  const closeDrawer = useCallback(() => setDrawerVisible(false), []);
  const scheduleScene = useCallback((callback: () => void, delayMs: number) => {
    const timer = setTimeout(() => {
      sceneTimers.current.delete(timer);
      if (mounted.current) callback();
    }, delayMs);
    sceneTimers.current.add(timer);
  }, []);
  const clearScene = useCallback(() => {
    sceneTimers.current.forEach(clearTimeout);
    sceneTimers.current.clear();
    face.updateAudioLevel(0);
    face.setGaze(0, 0);
    toasts.updateUserSpeechState(false);
    if (presence.getSnapshot().bodyState === "observing" || presence.getSnapshot().bodyState === "manual") {
      presence.setBodyState("connected_unarmed");
    }
    void longevity.triggerEmergencyStop("scene_transition_local_simulation");
    setSubtitle("");
  }, [face, longevity, presence, toasts]);

  useEffect(() => {
    mounted.current = true;
    const ticker = setInterval(() => {
      const target = presence.getSnapshot().innerSpace === "memories" ? memories.getMiniRobotAvatar().gazeVector : face.getState().gaze;
      if (!longevity.getPolicy().activeLookEnabled && presence.getSnapshot().bodyState === "observing") {
        sceneTimers.current.forEach(clearTimeout);
        sceneTimers.current.clear();
        face.setGaze(0, 0);
        presence.setBodyState("connected_unarmed");
        presence.setFaceExpression("neutral");
        void longevity.triggerEmergencyStop("thermal_local_simulation");
      }
      const dx = target.x - smoothGaze.current.x;
      const dy = target.y - smoothGaze.current.y;
      if (Math.hypot(dx, dy) <= 0.004) {
        if (dx !== 0 || dy !== 0) smoothGaze.current = target;
        return;
      }
      smoothGaze.current = {
        x: smoothGaze.current.x + dx * 0.32,
        y: smoothGaze.current.y + dy * 0.32,
      };
      refresh();
    }, 100);
    const shiftTimer = setInterval(() => {
      if (presence.getSnapshot().isDocked && AppState.currentState === "active") longevity.tickMicroShift();
    }, 60_000);
    // Blink transitions are transient work; idle gaze no longer repaints the tree.
    const blinkFrames = new Set<ReturnType<typeof setTimeout>>();
    const blinkTimer = setInterval(() => {
      if (presence.getSnapshot().faceExpression !== "sleeping" && AppState.currentState === "active") {
        face.triggerBlink();
        refresh();
        for (const delay of [45, 90, 145, 195]) {
          const frame = setTimeout(() => { blinkFrames.delete(frame); refresh(); }, delay);
          blinkFrames.add(frame);
        }
      }
    }, 4_200);
    const subscription = AppState.addEventListener("change", (state) => {
      setForeground(state === "active");
      if (state !== "active") {
        void liveVoiceRef.current?.stop();
        setAskVisible(false);
        sceneTimers.current.forEach(clearTimeout);
        sceneTimers.current.clear();
        face.dispose();
        face.updateAudioLevel(0);
        face.setGaze(0, 0);
        toasts.updateUserSpeechState(false);
        setSubtitle("");
        if (presence.getSnapshot().captureMode !== "off") presence.setFaceExpression("neutral");
        if (presence.getSnapshot().bodyState === "observing") presence.setBodyState("connected_unarmed");
        void longevity.triggerEmergencyStop("background_local_simulation");
      }
    });
    return () => {
      mounted.current = false;
      clearInterval(ticker);
      clearInterval(shiftTimer);
      clearInterval(blinkTimer);
      blinkFrames.forEach(clearTimeout);
      sceneTimers.current.forEach(clearTimeout);
      sceneTimers.current.clear();
      acceptanceAbort.current?.abort();
      face.dispose();
      toasts.clear();
      subscription.remove();
      void longevity.triggerEmergencyStop("unmount_local_simulation");
    };
  }, [face, longevity, memories, presence, refresh, toasts]);

  useEffect(() => {
    if (!activeToast) return;
    const toastId = activeToast.id;
    const expiryTimer = setInterval(() => {
      if (toasts.getActiveToast()?.id !== toastId) refresh();
    }, 100);
    return () => clearInterval(expiryTimer);
  }, [activeToast?.id, refresh, toasts]);

  useEffect(() => {
    const unsubscribe = localCenter.subscribe(() => {
      if (localCenter.preferences.voiceMode === "local") syncMemorySpaceFromHub(memories, localCenter.memories.list());
      refresh();
    });
    void localCenter.initialize().catch(() => notify("本机存储未就绪，请打开家居连接设置检查"));
    return unsubscribe;
  }, [localCenter, memories, notify, refresh]);

  useEffect(() => {
    let disposed = false;
    syncMemorySpaceFromHub(memories, []);
    refresh();
    const abort = new AbortController();
    (runtimeVoiceMode === "local" ? localCenter.initialize().then(() => localCenter.memories.list()) : fetchHubMemories(HUB_ORIGIN, abort.signal))
      .then((items) => {
        if (disposed || !mounted.current) return;
        syncMemorySpaceFromHub(memories, items);
        if (runtimeVoiceMode === "hub") cabin.updateSubsystemStatus("hub", "connected");
        refresh();
      })
      .catch(() => {});
    const client = new LiveVoiceClient({
      hubOrigin: HUB_ORIGIN,
      ...(runtimeVoiceMode === "local" ? { wsFactory: () => new LocalVoiceSocket(localCenter, (url, key) => new WebSocket(url, undefined, { headers: { "X-Api-Key": key } }) as unknown as import("../src/runtime/live-voice-client.js").WebSocketAdapter) } : {}),
      onPhaseChange: (phase) => {
        if (disposed || !mounted.current) return;
        setVoicePhase(phase);
        if (phase === "connecting") {
          presence.setFaceExpression("curious");
          if (runtimeVoiceMode === "hub") cabin.updateSubsystemStatus("hub", "connecting");
        } else if (phase === "listening") {
          presence.setFaceExpression("listening");
          if (runtimeVoiceMode === "hub") cabin.updateSubsystemStatus("hub", "connected");
          cabin.setSensorStatus({ microphone: true });
        } else if (phase === "thinking") {
          presence.setFaceExpression("thinking");
        } else if (phase === "speaking") {
          presence.setFaceExpression("speaking");
        } else {
          if (presence.getSnapshot().captureMode !== "off") {
            presence.setFaceExpression("neutral");
          }
          face.updateAudioLevel(0);
          cabin.setSensorStatus({ microphone: false });
        }
        refresh();
      },
      onUserTranscript: (text, isFinal) => {
        if (disposed || !mounted.current) return;
        setSubtitle(`你：${text}`);
        toasts.updateUserSpeechState(!isFinal);
        refresh();
      },
      onAssistantTranscript: (text) => {
        if (disposed || !mounted.current) return;
        setSubtitle(text);
        refresh();
      },
      onAgentStatus: (status) => {
        if (disposed || !mounted.current) return;
        if (status.taskId) setActiveAgentTask(status.taskId);
        if (status.interaction && status.taskId) setAgentInteraction({ taskId: status.taskId, request: status.interaction });
        if (status.phase === "done" || status.phase === "error") {
          setAgentInteraction(null);
          setActiveAgentTask(null);
        }
        if (status.memories) {
          syncMemorySpaceFromHub(memories, status.memories);
        }
        if (status.phase === "thinking" || status.phase === "tool_start") {
          presence.setFaceExpression("thinking");
          setSubtitle(`Agent · ${status.summary}`);
        } else if (status.phase === "tool_end" || status.phase === "done") {
          notify(status.summary);
          if (client.getPhase() === "thinking") {
            presence.setFaceExpression("listening");
          }
        }
        refresh();
      },
      onAudioLevel: (level) => {
        if (disposed || !mounted.current) return;
        face.updateAudioLevel(level);
        refresh();
      },
      onError: (message) => {
        if (disposed || !mounted.current) return;
        notify(message);
      },
    });
    liveVoiceRef.current = client;
    return () => {
      disposed = true;
      abort.abort();
      void client.stop();
      liveVoiceRef.current = null;
    };
  }, [cabin, face, memories, notify, presence, refresh, toasts, localCenter, runtimeVoiceMode, runtimeRevision]);

  useEffect(() => {
    const requested = keepAwake.updatePolicy(snapshot.isDocked && foreground, snapshot.captureMode);
    // Serialize acquisition/release so an in-flight activation cannot outlive cleanup.
    const enqueueWake = (active: boolean) => {
      wakeOperations.current = wakeOperations.current.then(() => active ? activateKeepAwakeAsync(WAKE_TAG) : deactivateKeepAwake(WAKE_TAG)).catch(() => {
        if (active && mounted.current) notify("系统常亮请求未获确认，可在维修舱查看策略");
      });
    };
    enqueueWake(requested);
    return () => enqueueWake(false);
  }, [foreground, keepAwake, notify, snapshot.captureMode, snapshot.isDocked]);

  const returnToFace = useCallback(() => {
    presence.navigateInnerSpace("none");
    void memories.closeMemoriesTimeline();
    void tasks.closeTasksAndRules();
    void cabin.closeCabinSpace();
    face.setGaze(0, 0);
    refresh();
  }, [presence, memories, tasks, cabin, face, refresh]);
  const navigate = useCallback((destination: Exclude<InnerSpaceDestination, "none">) => {
    if (!presence.navigateInnerSpace(destination, trustedTap())) return;
    setDrawerVisible(false);
    if (destination === "memories") void memories.openMemoriesTimeline();
    else void memories.closeMemoriesTimeline();
    if (destination === "tasks_and_rules") void tasks.openTasksAndRules();
    else void tasks.closeTasksAndRules();
    if (destination === "cabin") void cabin.openCabinSpace();
    else void cabin.closeCabinSpace();
    refresh();
  }, [presence, memories, tasks, cabin, refresh]);
  const openDrawer = useCallback(() => {
    if (presence.getSnapshot().captureMode === "off") return;
    dismissWakeGuide();
    setDrawerVisible(true);
  }, [dismissWakeGuide, presence]);
  const resumePrivacy = useCallback(() => {
    presence.resumePrivacy(presence.getSnapshot().isDocked ? "docked_context" : "foreground_explicit");
    notify("已恢复感知策略，真实相机与麦克风仍待接入");
  }, [notify, presence]);
  const openDrawerRef = useRef(openDrawer);
  useEffect(() => {
    openDrawerRef.current = openDrawer;
  }, [openDrawer]);

  useEffect(() => {
    if (params.space === "face") {
      setDrawerVisible(false);
      setSimLabVisible(false);
      returnToFace();
    } else if (params.space === "memories" || params.space === "tasks_and_rules"
      || params.space === "home" || params.space === "cabin") {
      setSimLabVisible(false);
      navigate(params.space);
    }
    if (params.overlay === "quick") {
      setSimLabVisible(false);
      openDrawer();
    } else if (params.overlay === "lab") {
      setDrawerVisible(false);
      setSimLabVisible(true);
    }
  }, [params.space, params.overlay, navigate, openDrawer, returnToFace]);

  const gestures = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => canSwipeOpenDrawerRef.current
      && gesture.dy < -18 && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.2,
    onPanResponderTerminationRequest: () => !canSwipeOpenDrawerRef.current,
    onPanResponderRelease: (_, gesture) => {
      if (canSwipeOpenDrawerRef.current && (gesture.dy < -20 || gesture.vy < -0.28)) openDrawerRef.current();
    },
  }), []);

  const selectDrawer = useCallback((destination: QuickDrawerDestination) => {
    setDrawerVisible(false);
    if (destination === "sim_lab") { setSimLabVisible(true); return; }
    if (destination === "privacy_pause") {
      void liveVoiceRef.current?.stop();
      setAskVisible(false);
      clearScene();
      toasts.clear();
      returnToFace();
      presence.setBodyState("connected_unarmed");
      void longevity.triggerEmergencyStop("privacy_local_simulation");
      presence.pausePrivacy();
      cabin.setSensorStatus({ camera: false, microphone: false, backgroundProcessing: false });
      refresh();
      return;
    }
    navigate(destination);
  }, [cabin, clearScene, longevity, navigate, presence, refresh, returnToFace, toasts]);

  const emergencyStop = useCallback(() => {
    clearScene();
    presence.setFaceExpression("alarmed");
    presence.setBodyState("connected_unarmed");
    // The visible stop and local queue purge happen synchronously before any await.
    const result = face.triggerLocalEmergencyStop();
    toasts.clear();
    toasts.enqueueToast("本地仿真运动已停止，实体底座尚未接入", { color: palette.alertCoral, priority: "urgent" });
    refresh();
    void result.then(() => refresh());
    scheduleScene(() => presence.setFaceExpression("neutral"), 3_000);
  }, [clearScene, face, presence, refresh, scheduleScene, toasts]);

  const runAcceptance = useCallback(async () => {
    if (acceptanceBusy.current) return;
    acceptanceBusy.current = true;
    setAcceptanceRunning(true);
    setAcceptanceReport(null);
    setAcceptanceError(null);
    notify("正在向 Hub 请求运行 48 项核心验收");
    const abort = new AbortController();
    acceptanceAbort.current = abort;
    const timeout = setTimeout(() => abort.abort(), 30_000);
    cabin.updateSubsystemStatus("hub", "connecting");
    try {
      const report = await requestAcceptanceReport(HUB_ORIGIN, abort.signal);
      if (!mounted.current) return;
      cabin.updateSubsystemStatus("hub", "connected");
      setAcceptanceReport(report);
      toasts.enqueueToast(`Hub 验收完成 ${report.passedCases}/${report.totalCases}，得分 ${report.totalScore}/${report.maxScore}，打开维修舱查看`, {
        color: report.success ? palette.confirmGreen : palette.cautionAmber,
      });
    } catch (error) {
      if (!mounted.current) return;
      cabin.updateSubsystemStatus("hub", "disconnected");
      const detail = error instanceof Error ? error.message : "未知连接错误";
      const message = `验收结果待核实：${detail}。请确认 Hub 已启动及 EXPO_PUBLIC_HUB_URL 配置`;
      setAcceptanceError(message);
      toasts.enqueueToast("Hub 验收未完成，结果待核实，请在维修舱检查连接", { color: palette.cautionAmber });
    } finally {
      clearTimeout(timeout);
      acceptanceBusy.current = false;
      if (acceptanceAbort.current === abort) acceptanceAbort.current = null;
      if (mounted.current) { setAcceptanceRunning(false); refresh(); }
    }
  }, [cabin, notify, refresh, toasts]);

  const toggleLiveVoice = useCallback(async () => {
    const client = liveVoiceRef.current;
    if (!client || privacyPaused) return;
    dismissWakeGuide();
    if (client.getPhase() === "speaking") {
      client.bargeIn();
      notify("已打断播报，继续听你说");
      return;
    }
    if (client.isActive()) {
      await client.stop();
      setAskVisible(false);
      setSubtitle("");
      notify("实时语音对话已关闭");
      return;
    }
    try {
      clearScene();
      await client.start();
      notify("LIVE 全双工对话已开启 · 直接说话或输入指令");
    } catch (err) {
      const detail = err instanceof Error ? err.message : "连接失败";
      notify(`语音通道未就绪：${detail}`);
    }
  }, [clearScene, dismissWakeGuide, notify, privacyPaused]);

  const submitPrompt = useCallback(async () => {
    const text = askInput.trim();
    const client = liveVoiceRef.current;
    if (!text || !client || privacyPaused) return;
    setAskInput("");
    setAskVisible(false);
    dismissWakeGuide();
    try {
      if (runtimeVoiceMode === "local") {
        const revision = localCenter.revision;
        const answer = await localCenter.executeText(text);
        if (revision !== localCenter.revision) return;
        setSubtitle(answer);
        syncMemorySpaceFromHub(memories, localCenter.memories.list());
        if (client.isActive()) client.speakText(answer);
        refresh();
        return;
      }
      if (!client.isActive()) {
        await client.start();
      }
      setSubtitle(`你：${text}`);
      client.sendTextPrompt(text);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "发送失败";
      notify(`发送失败：${detail}`);
    }
  }, [askInput, dismissWakeGuide, notify, privacyPaused, runtimeVoiceMode, localCenter, memories, refresh]);

  const miniGaze = smoothGaze.current;
  const sensors = cabin.getSensorsState();
  const memorySummary = getMemorySpaceSummary(memories);
  const taskSummary = getTasksSpaceSummary(tasks);
  const homeConnection = cabin.getSubsystems().homeAssistant.status;
  const liveActive = voicePhase !== "disconnected" && voicePhase !== "error";
  const statusLabel = privacyPaused
    ? "安心休眠"
    : voicePhase === "listening"
      ? "实时聆听中"
      : voicePhase === "thinking"
        ? "Agent 思考中"
        : voicePhase === "speaking"
          ? "LOOI 说话中"
          : "陪伴待机";
  return (
    <View style={styles.root}>
      {activeSpace === "face" ? (
        <View style={styles.stage}>
          <View style={StyleSheet.absoluteFill} {...gestures.panHandlers}>
          <RobotFaceView mode="fullscreen" {...faceState} drawerOpen={overlayOpen} blinkProgress={privacyPaused ? 1 : faceState.blinkProgress} microShift={microShift} onPress={privacyPaused ? resumePrivacy : openDrawer} />
          </View>
          <View pointerEvents="none" style={[styles.horizonGlow, overlayOpen && styles.hidden]} />
          {!overlayOpen ? <View pointerEvents="box-none" style={[styles.cornerRow, { top: insets.top + 10, left: insets.left + 14, right: insets.right + 14 }]}>
            <Pressable accessibilityRole="button" accessibilityLabel={privacyPaused ? "恢复感知策略" : "打开快捷功能抽屉"}
              accessibilityHint={privacyPaused ? "感知已暂停，轻触恢复" : sensors.camera || sensors.microphone ? "陪伴中，打开功能与状态" : "陪伴待机，相机与麦克风未接入"}
              hitSlop={8} onPress={privacyPaused ? resumePrivacy : openDrawer} style={({ pressed }) => [styles.ambientPresence, pressed && styles.pressed]}>
              <View style={[styles.presenceDot, privacyPaused && styles.pausedDot, liveActive && styles.liveActiveDot]} />
              <Text style={styles.statusText}>{statusLabel}</Text>
            </Pressable>
            {!privacyPaused && (
              <View style={styles.rightControls}>
                <Pressable accessibilityRole="button" accessibilityLabel={liveActive ? "实时语音对话控制" : "开启实时语音对话"} hitSlop={8}
                  onPress={() => { void toggleLiveVoice(); }}
                  style={({ pressed }) => [styles.livePill, liveActive && styles.livePillActive, pressed && styles.pressed]}>
                  <View style={[styles.liveDot, liveActive && styles.liveDotOn]} />
                  <Text style={[styles.livePillText, liveActive && styles.livePillTextActive]}>
                    {voicePhase === "speaking" ? "打断" : liveActive ? "LIVE 中" : "LIVE 对话"}
                  </Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="向 Personal Agent 发送指令" hitSlop={8}
                  onPress={() => setAskVisible((v) => !v)}
                  style={({ pressed }) => [styles.askTrigger, askVisible && styles.livePillActive, pressed && styles.pressed]}>
                  <Text style={[styles.labText, askVisible && styles.livePillTextActive]}>对话</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="打开仿真演练台" hitSlop={8} onPress={() => setSimLabVisible(true)} style={({ pressed }) => [styles.labTrigger, pressed && styles.pressed]}><View style={styles.labDot} /><Text style={styles.labText}>LAB</Text></Pressable>
              </View>
            )}
          </View> : null}
          {!overlayOpen && !privacyPaused && askVisible ? (
            <View style={[styles.askBar, { top: insets.top + 56, left: insets.left + 16, right: insets.right + 16 }]}>
              <TextInput
                value={askInput}
                onChangeText={setAskInput}
                placeholder="直接对 LOOI 说（如：记住我钥匙在抽屉 / 查看当前目录）"
                placeholderTextColor={palette.textMuted}
                style={styles.askInput}
                returnKeyType="send"
                onSubmitEditing={() => { void submitPrompt(); }}
              />
              <Pressable accessibilityRole="button" accessibilityLabel="发送给 LOOI" onPress={() => { void submitPrompt(); }}
                style={({ pressed }) => [styles.askSendBtn, pressed && styles.pressed]}>
                <Text style={styles.askSendText}>发送</Text>
              </Pressable>
            </View>
          ) : null}
          <View pointerEvents="none" style={[styles.faceToast, { top: insets.top + (askVisible ? 112 : 62) }]}><LightToastCapsule toast={visibleToast} /></View>
          {privacyPaused ? (
            <Pressable accessibilityRole="button" accessibilityLabel="恢复感知策略" onPress={resumePrivacy} style={({ pressed }) => [styles.privacyCard, { bottom: insets.bottom + 20 }, pressed && styles.pressed]}>
              <LooiIcon name="shield" size={24} color={palette.textSecondary} />
              <View style={styles.privacyCopy}><Text style={styles.privacyTitle}>隐私暂停，安心休眠</Text><Text style={styles.privacyDetail}>相机与麦克风已关闭 / 短时缓冲已清空 / 隐私纪元 {snapshot.privacyEpoch.capture_epoch}</Text><Text style={styles.privacyDetail}>轻触恢复感知策略</Text></View>
            </Pressable>
          ) : faceState.isEmergencyStopAvailable ? (
            <Pressable accessibilityRole="button" hitSlop={12} onPress={emergencyStop} style={({ pressed }) => [styles.emergencyButton, { bottom: insets.bottom + 18 }, pressed && styles.pressed]}>
              <LooiIcon name="stop" size={24} color={palette.bgDeep} /><Text style={styles.emergencyText}>{"立即停止运动 (<100ms)"}</Text>
            </Pressable>
          ) : !subtitle && wakeGuideVisible && (
            <Pressable accessibilityRole="button" accessibilityLabel="说 Hey LOOI 唤醒我，轻触开启实时对话" hitSlop={{ top: 10, bottom: 10, left: 16, right: 16 }} onPress={() => { void toggleLiveVoice(); }}
              pointerEvents={overlayOpen ? "none" : "auto"} accessibilityElementsHidden={overlayOpen} importantForAccessibility={overlayOpen ? "no-hide-descendants" : "auto"}
              style={({ pressed }) => [styles.wakeGuide, { bottom: insets.bottom + 12, left: insets.left + 12, right: insets.right + 12 }, pressed && styles.pressed, overlayOpen && styles.hidden]}>
              <LooiWaveOrnament bars={7} size={narrowWakeBar ? 19 : 26} color="#2B88FF" style={styles.wakeWave} />
              <View style={styles.wakeFrame}>
                <View pointerEvents="none" style={styles.wakeParenLeft} />
                <Text style={[styles.guideText, narrowWakeBar && styles.narrowGuideText]}>说 <Text style={styles.wakeName}>Hey LOOI</Text> 唤醒我{narrowWakeBar ? "\n" : " · "}<Text style={styles.wakeHint}>轻触开启 LIVE 对话</Text></Text>
                <View pointerEvents="none" style={styles.wakeParenRight} />
              </View>
              <LooiWaveOrnament bars={7} size={narrowWakeBar ? 19 : 26} color="#2B88FF" style={styles.wakeWave} />
            </Pressable>
          )}
          <ConversationSubtitleOverlay visible={!!subtitle && !privacyPaused && !overlayOpen} text={subtitle} mode={voicePhase === "listening" || voicePhase === "thinking" ? "listening" : "speaking"} />
        </View>
      ) : (
        <ConformalDeviceShell activeSpace={activeSpace} onNavigate={navigate} onReturnToFace={returnToFace} isDocked={snapshot.isDocked} deskFreshnessNotice={tasks.getDeskFreshnessNotice()?.replace(/ · /g, " / ") ?? undefined} miniGaze={miniGaze} faceState={faceState} microShift={microShift} toast={visibleToast}>
          {activeSpace === "memories" && <MemoriesSpaceView controller={memories} canCorrect={runtimeVoiceMode === "local"} onChange={refresh} onNotify={notify} onForget={async (id) => { const items = await localCenter.forgetMemory(id); syncMemorySpaceFromHub(memories, items); refresh(); }} onCorrect={async (id, location) => { const items = await localCenter.correctMemory(id, location); syncMemorySpaceFromHub(memories, items); refresh(); }} />}
          {activeSpace === "tasks_and_rules" && <TasksSpaceView controller={tasks} onChange={refresh} onNotify={notify} />}
          {activeSpace === "home" && <LocalHomeSpaceView center={localCenter} controller={cabin} hubOrigin={HUB_ORIGIN} onNotify={notify} />}
          {activeSpace === "cabin" && <CabinSpaceView realHome controller={cabin} supervisor={longevity} onChange={refresh} onNotify={notify} acceptanceRunning={acceptanceRunning} acceptanceReport={acceptanceReport} acceptanceError={acceptanceError} onRunAcceptance={() => { void runAcceptance(); }} />}
        </ConformalDeviceShell>
      )}
      {activeAgentTask ? <Pressable accessibilityRole="button" accessibilityLabel="停止当前工作任务" style={[styles.agentStop, { bottom: insets.bottom + 16 }]} onPress={() => liveVoiceRef.current?.cancelAgentTask(activeAgentTask)}><Text style={styles.askSendText}>停止任务</Text></Pressable> : null}
      {agentInteraction ? <AgentInteractionSheet key={agentInteraction.request.id} interaction={agentInteraction.request} onAnswer={answer => {
        liveVoiceRef.current?.respondToAgent(agentInteraction.taskId, agentInteraction.request.id, answer);
        setAgentInteraction(null);
      }} /> : null}
      <QuickDrawerOverlay visible={drawerVisible} onClose={closeDrawer} onSelect={selectDrawer}
        {...memorySummary} {...taskSummary}
        homeStatus={homeConnection === "connected" ? "家居网关已连接" : homeConnection === "connecting" ? "网关连接中" : "网关离线"}
        verifiedCount={acceptanceReport?.passedCases}
        verificationStatus={acceptanceRunning ? "running" : acceptanceError ? "failed" : "unverified"} />
      <SimLabSheet visible={simLabVisible} onClose={() => setSimLabVisible(false)} isDocked={snapshot.isDocked} acceptanceRunning={acceptanceRunning}
        onSpeakingTest={() => {
          setSimLabVisible(false);
          returnToFace();
          clearScene();
          presence.setFaceExpression("speaking");
          toasts.updateUserSpeechState(true);
          setSubtitle("正在为你留心书桌上的钥匙与水杯位置 · 演示模式");
          notify("我会安静陪着你 · 演示模式");
          for (let index = 0; index < 20; index += 1) scheduleScene(() => { face.updateAudioLevel([0.2, 0.55, 0.8, 0.4][index % 4]); refresh(); }, index * 150);
          scheduleScene(() => { clearScene(); presence.setFaceExpression("neutral"); refresh(); }, 3_100);
        }}
        onRememberFrame={() => {
          setSimLabVisible(false);
          returnToFace();
          notify("仿真画面记录请求：相机尚未接入，未创建观察事实");
        }}
        onMicroObservation={() => {
          setSimLabVisible(false);
          returnToFace();
          clearScene();
          if (!presence.getSnapshot().isDocked || !longevity.getPolicy().activeLookEnabled || presence.getSnapshot().captureMode === "off") { notify("当前策略不允许主动观察，请检查底座、隐私与热压力"); return; }
          presence.setBodyState("observing");
          presence.setFaceExpression("curious");
          longevity.queueMotionCommand(`simulated_look_${Date.now()}`);
          face.setGaze(-0.6, 0.25);
          notify("正在演示有界微观察，未驱动实体底座");
          scheduleScene(() => { face.setGaze(0.6, -0.15); refresh(); }, 1_200);
          scheduleScene(() => { clearScene(); void longevity.triggerEmergencyStop("simulation_completed"); presence.setBodyState("connected_unarmed"); presence.setFaceExpression("neutral"); notify("仿真微观察结束，未生成未经核验的发现"); }, 3_400);
        }}
        onToggleDock={() => {
          setSimLabVisible(false);
          returnToFace();
          clearScene();
          const docked = !presence.getSnapshot().isDocked;
          presence.handleDockChange(docked);
          presence.setBodyState("connected_unarmed");
          presence.setFaceExpression("neutral");
          if (docked) { tasks.handleDock(); longevity.handleBleReconnect(); }
          else { tasks.handleUndock(Date.now()); longevity.handleBleDisconnect(); }
          notify(docked ? "仿真归座，旧运动指令不会重放" : `仿真离座，${tasks.getDeskFreshnessNotice()?.replace(/ · /g, " / ")}`);
        }}
        onEmergencyStop={() => {
          setSimLabVisible(false);
          returnToFace();
          emergencyStop();
        }}
        onRunAcceptance={() => {
          setSimLabVisible(false);
          returnToFace();
          void runAcceptance();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.bgDeep },
  agentStop: { position: "absolute", right: 20, minHeight: 44, paddingHorizontal: 16, borderRadius: 22, backgroundColor: "#713E48", justifyContent: "center", zIndex: 30 },
  stage: { flex: 1 },
  cornerRow: { position: "absolute", flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12 },
  ambientPresence: { minHeight: 44, minWidth: 44, flexDirection: "row", gap: 7, alignItems: "center", paddingHorizontal: 7, opacity: 0.58, maxWidth: "65%" },
  presenceDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: palette.presenceCyan, boxShadow: "0 0 7px 1px rgba(40, 213, 255, 0.38)" },
  pausedDot: { backgroundColor: palette.textMuted, boxShadow: "none" },
  liveActiveDot: { backgroundColor: palette.confirmGreen, boxShadow: "0 0 8px 2px rgba(74, 222, 128, 0.55)" },
  statusText: { fontSize: 11, letterSpacing: 1, color: palette.textSecondary, flexShrink: 1 },
  rightControls: { flexDirection: "row", alignItems: "center", gap: 8 },
  livePill: { minHeight: 34, paddingHorizontal: 11, borderRadius: 17, borderWidth: 1, borderColor: "rgba(43, 136, 255, 0.45)", backgroundColor: "rgba(18, 30, 52, 0.65)", flexDirection: "row", alignItems: "center", gap: 6 },
  livePillActive: { borderColor: palette.confirmGreen, backgroundColor: "rgba(16, 48, 36, 0.78)" },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#2B88FF" },
  liveDotOn: { backgroundColor: palette.confirmGreen },
  livePillText: { color: "#8EC5FF", fontSize: 11, fontWeight: "600", letterSpacing: 0.6 },
  livePillTextActive: { color: palette.confirmGreen },
  askTrigger: { minHeight: 34, paddingHorizontal: 10, borderRadius: 17, borderWidth: 1, borderColor: palette.lineSubtle, backgroundColor: "rgba(255, 255, 255, 0.04)", alignItems: "center", justifyContent: "center" },
  askBar: { position: "absolute", zIndex: 25, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: "rgba(43, 136, 255, 0.45)", backgroundColor: "rgba(10, 16, 28, 0.92)" },
  askInput: { flex: 1, minHeight: 36, color: palette.textPrimary, fontSize: 14, paddingHorizontal: 6 },
  askSendBtn: { minHeight: 34, paddingHorizontal: 14, borderRadius: 16, backgroundColor: "#2B88FF", alignItems: "center", justifyContent: "center" },
  askSendText: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
  labTrigger: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 4, opacity: 0.58 },
  labDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: palette.textSecondary },
  labText: { color: palette.textSecondary, fontSize: 11, letterSpacing: 1 },
  faceToast: { position: "absolute", alignSelf: "center", maxWidth: "80%" },
  horizonGlow: { position: "absolute", bottom: 0, alignSelf: "center", width: 440, maxWidth: "78%", height: 28, borderRadius: 14, backgroundColor: "transparent", experimental_backgroundImage: "radial-gradient(ellipse at 50% 100%, rgba(43, 136, 255, 0.32) 0%, rgba(43, 136, 255, 0.10) 48%, rgba(43, 136, 255, 0) 75%)" },
  wakeGuide: { position: "absolute", flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 12, minHeight: 52 },
  wakeFrame: { minHeight: 44, flexShrink: 1, justifyContent: "center", paddingHorizontal: 20, paddingVertical: 5 },
  wakeParenLeft: { position: "absolute", left: 0, top: 0, bottom: 0, width: 12, borderLeftWidth: 2, borderTopLeftRadius: 22, borderBottomLeftRadius: 22, borderColor: "rgba(43, 136, 255, 0.55)" },
  wakeParenRight: { position: "absolute", right: 0, top: 0, bottom: 0, width: 12, borderRightWidth: 2, borderTopRightRadius: 22, borderBottomRightRadius: 22, borderColor: "rgba(43, 136, 255, 0.55)" },
  wakeWave: { opacity: 0.6, flexShrink: 1 },
  guideText: { color: palette.textSecondary, fontSize: 18, textAlign: "center", lineHeight: 27 },
  narrowGuideText: { fontSize: 14, lineHeight: 22 },
  wakeName: { color: "#2B88FF", fontWeight: "500" },
  wakeHint: { fontSize: 12, color: palette.textMuted },
  hidden: { opacity: 0 },
  emergencyButton: { position: "absolute", zIndex: 20, alignSelf: "center", minHeight: 58, paddingHorizontal: 25, flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 32, backgroundColor: palette.alertCoral, shadowColor: palette.alertCoral, shadowOpacity: 0.32, shadowRadius: 18, shadowOffset: { width: 0, height: 0 } },
  emergencyText: { fontSize: 18, fontWeight: "700", color: palette.bgDeep },
  pressed: { opacity: 0.78, transform: [{ scale: 0.97 }] },
  privacyCard: { position: "absolute", alignSelf: "center", maxWidth: "85%", minHeight: 90, padding: 18, flexDirection: "row", alignItems: "center", gap: 14, borderRadius: 24, borderWidth: 1, borderColor: palette.lineSubtle, backgroundColor: palette.surfaceGlass },
  privacyCopy: { flexShrink: 1, gap: 6 },
  privacyTitle: { color: palette.textPrimary, fontSize: 18, fontWeight: "600" },
  privacyDetail: { color: palette.textSecondary, fontSize: 13, lineHeight: 19 },
});
