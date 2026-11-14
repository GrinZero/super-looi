import {
  Animated,
  Canvas,
  computed,
  createAnimatedValue,
  createMotion,
  effect,
  ErrorBoundary,
  reduceMotion,
  safeArea,
  signal,
  Text,
  token,
  View,
  windowSize,
  type JSX,
} from "nsh";
import { Button, Input } from "nsh/base";
import { t } from "../../i18n";
import type { VoiceState } from "../../generated/looi-runtime.js";
import type {
  FaceStagePosture,
  PluginStagePresentation,
  StageDrawerDetent,
} from "../../runtime/plugins/shared-types";
import {
  LightToast,
  LiveVoiceButton,
  ResponsePreview,
  WakeGuideBar,
} from "../Controls";
import { getPluginUiModule } from "../plugins/registry";
import type { PluginViewContext } from "../plugins/ui-contracts";
import {
  drawStageAmbientBackdrop,
  RobotFace,
  type FaceVisualState,
} from "../RobotFace";
import {
  computeStageLayout,
  nextCycledDrawerDetent,
  resolveSnapDrawerDetent,
  STAGE_BASE_PILL_HEIGHT,
  STAGE_BASE_PILL_WIDTH,
} from "./posture-geometry";

export type StageSlotName = "StageCanvas" | "StageCapsule" | "StageDrawer";

export interface ActiveStageLeaseView {
  readonly pluginId: string;
  readonly revision?: number;
  readonly presentation: PluginStagePresentation;
}

export interface MorphableStageProps {
  readonly active: boolean;
  readonly ready: boolean;
  readonly busy: boolean;
  readonly cutoutInsets?: { readonly left: number; readonly right: number };
  readonly faceState: FaceVisualState;
  readonly statusText: string;
  readonly toastText: string;
  readonly voiceState: VoiceState;
  readonly voiceAudioLevel: number;
  readonly voiceProviderLabel: string;
  readonly wakeGuideDismissed: boolean;
  readonly responseText: string;
  readonly composeOpen: boolean;
  readonly composeDraft: string;
  readonly activeStage: ActiveStageLeaseView | null;
  readonly getPluginViewContext: (pluginId: string) => PluginViewContext<any, any>;
  readonly onToggleVoice: () => void;
  readonly onToggleCompose: () => void;
  readonly onChangeDraft: (value: string) => void;
  readonly onSubmitDraft: () => void;
  readonly onOpenSettings: () => void;
  readonly onOpenResponse: () => void;
  readonly onExitStage: (pluginId?: string) => void;
  readonly onReportStageCrash: (
    pluginId: string,
    slot: StageSlotName,
    error: unknown,
  ) => void;
}

const FULL_POSTURE: FaceStagePosture = { kind: "full" };

function HomeHeaderIcon(props: {
  kind: "chat" | "settings" | "exit" | "chevronDown";
  active?: boolean;
}) {
  return (
    <Canvas
      class="w-5 h-5"
      style={{ pointerEvents: "none" }}
      draw={(cx, size) => {
        cx.clearRect(0, 0, size.width, size.height);
        cx.save();
        cx.scale(size.width / 24, size.height / 24);
        cx.strokeStyle = token(props.active ? "stage-pill-fg" : "stage-muted");
        cx.lineWidth = 1.85;
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
        } else if (props.kind === "settings") {
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
        } else if (props.kind === "exit") {
          cx.strokeStyle = token("stage-pill-fg");
          cx.beginPath();
          cx.moveTo(7.5, 7.5);
          cx.lineTo(16.5, 16.5);
          cx.moveTo(16.5, 7.5);
          cx.lineTo(7.5, 16.5);
          cx.stroke();
        } else {
          cx.beginPath();
          cx.moveTo(6.5, 9.5);
          cx.lineTo(12, 15);
          cx.lineTo(17.5, 9.5);
          cx.stroke();
        }
        cx.restore();
      }}
    />
  );
}

function PluginStageSlotBoundary(props: {
  pluginId: string;
  slot: StageSlotName;
  onCrash: (pluginId: string, slot: StageSlotName, error: unknown) => void;
  children: JSX.Element;
}) {
  let reported = false;
  return (
    <ErrorBoundary
      fallback={(error) => {
        if (!reported) {
          reported = true;
          const id = props.pluginId;
          const slot = props.slot;
          void Promise.resolve().then(() => {
            props.onCrash(id, slot, error);
          });
        }
        return <View style={{ pointerEvents: "none" }} />;
      }}
    >
      {props.children}
    </ErrorBoundary>
  );
}

function serializeStageLeaseIdentity(stage: ActiveStageLeaseView | null): string {
  if (!stage) return "";
  if (stage.revision !== undefined) {
    return `${stage.pluginId}#rev:${stage.revision}`;
  }
  const p = stage.presentation;
  return `${stage.pluginId}#${p.active ? "1" : "0"}:${p.drawerDetent}:${
    p.allowUserSwipeCollapse === false ? "0" : "1"
  }:${p.hideDefaultDock ? "1" : "0"}:${JSON.stringify(p.facePosture)}`;
}

/**
 * Landscape Morphable First-Screen Stage Compositor:
 * Keeps a single persistent `<RobotFace />` mounted across all 5 `FaceStagePosture`s,
 * hosts isolated plugin `StageCanvas` / `StageCapsule` / 4-detent `StageDrawer` slots,
 * and enforces an unblockable top-right host safety & exit bar.
 */
export function MorphableStage(props: MorphableStageProps) {
  // User-driven drawer detent override; resets only when plugin pushes a new presentation revision or exits stage.
  const userDetentOverride = signal<StageDrawerDetent | null>(null);
  let lastStageIdentity = "";

  effect(() => {
    const nextIdentity = serializeStageLeaseIdentity(props.activeStage);
    if (nextIdentity !== lastStageIdentity) {
      lastStageIdentity = nextIdentity;
      userDetentOverride.set(null);
    }
  });

  const effectiveInsets = computed(() => {
    const sa = safeArea();
    const cutout = props.cutoutInsets;
    return {
      top: sa.top,
      bottom: sa.bottom,
      left: sa.left + (cutout?.left ?? 0),
      right: sa.right + (cutout?.right ?? 0),
    };
  });

  const activePluginIds = computed(() => {
    const stage = props.activeStage;
    return stage && stage.presentation.active ? [stage.pluginId] : [];
  });

  const activeUiModule = computed(() => {
    const stage = props.activeStage;
    if (!stage || !stage.presentation.active) return undefined;
    return getPluginUiModule(stage.pluginId);
  });

  const hasStageDrawer = computed(() =>
    Boolean(activeUiModule()?.StageDrawer),
  );

  const hasStageCapsule = computed(() =>
    Boolean(activeUiModule()?.StageCapsule),
  );

  const effectivePosture = computed<FaceStagePosture>(() => {
    const stage = props.activeStage;
    if (!stage || !stage.presentation.active) return FULL_POSTURE;
    return stage.presentation.facePosture;
  });

  const effectiveDrawerDetent = computed<StageDrawerDetent>(() => {
    const stage = props.activeStage;
    if (!stage || !stage.presentation.active || !hasStageDrawer()) {
      return "closed";
    }
    return userDetentOverride() ?? stage.presentation.drawerDetent;
  });

  const allowUserSwipeCollapse = computed(() => {
    const stage = props.activeStage;
    if (!stage) return true;
    return stage.presentation.allowUserSwipeCollapse !== false;
  });

  const layout = computed(() =>
    computeStageLayout({
      viewport: windowSize(),
      insets: effectiveInsets(),
      posture: effectivePosture(),
      drawerDetent: effectiveDrawerDetent(),
      hasDrawer: hasStageDrawer(),
      hasCapsule: hasStageCapsule(),
    }),
  );

  // Prevent glass-on-glass text ghosting when StageDrawer rises across the StageCapsule band
  const capsuleOccludedByDrawer = computed(() => {
    const m = layout();
    if (m.drawer.visibleHeight <= 0) return false;
    const drawerTopY = windowSize().height - m.drawer.visibleHeight;
    return drawerTopY <= m.capsule.top + 36;
  });

  // Persistent native animated channels for single-instance RobotFace & Pill Chrome
  const faceTx = createAnimatedValue(0);
  const faceTy = createAnimatedValue(0);
  const faceScale = createAnimatedValue(1);
  const pillTx = createAnimatedValue(0);
  const pillTy = createAnimatedValue(0);
  const pillScale = createAnimatedValue(1);
  const pillOpacity = createAnimatedValue(0);

  let faceInitialized = false;
  let lastFaceTarget = {
    tx: 0,
    ty: 0,
    scale: 1,
    pillTx: 0,
    pillTy: 0,
    pillScale: 1,
    pillOpacity: 0,
  };

  effect(() => {
    const m = layout().face;
    const instant = !faceInitialized || !props.active || reduceMotion();
    const changed =
      !faceInitialized ||
      Math.abs(m.translateX - lastFaceTarget.tx) > 0.25 ||
      Math.abs(m.translateY - lastFaceTarget.ty) > 0.25 ||
      Math.abs(m.scale - lastFaceTarget.scale) > 0.002 ||
      Math.abs(m.pillTranslateX - lastFaceTarget.pillTx) > 0.25 ||
      Math.abs(m.pillTranslateY - lastFaceTarget.pillTy) > 0.25 ||
      Math.abs(m.pillScale - lastFaceTarget.pillScale) > 0.002 ||
      Math.abs(m.pillOpacity - lastFaceTarget.pillOpacity) > 0.01;

    if (!changed) return;
    lastFaceTarget = {
      tx: m.translateX,
      ty: m.translateY,
      scale: m.scale,
      pillTx: m.pillTranslateX,
      pillTy: m.pillTranslateY,
      pillScale: m.pillScale,
      pillOpacity: m.pillOpacity,
    };
    faceInitialized = true;

    if (instant) {
      faceTx.set(m.translateX);
      faceTy.set(m.translateY);
      faceScale.set(m.scale);
      pillTx.set(m.pillTranslateX);
      pillTy.set(m.pillTranslateY);
      pillScale.set(m.pillScale);
      pillOpacity.set(m.pillOpacity);
      return;
    }

    const springCfg = { stiffness: 280, damping: 30, mass: 1 };
    void faceTx.spring(m.translateX, springCfg);
    void faceTy.spring(m.translateY, springCfg);
    void faceScale.spring(m.scale, springCfg);
    void pillTx.spring(m.pillTranslateX, springCfg);
    void pillTy.spring(m.pillTranslateY, springCfg);
    void pillScale.spring(m.pillScale, springCfg);
    void pillOpacity.timing(m.pillOpacity, { duration: 180, easing: "easeOut" });
  });

  // 4-detent drawer FLIP animated Y & gesture pan channel:
  // Layout sets exact resting height once per detent change (keeping native & headless hit-test bounds exact),
  // while FLIP delta + pan animate purely via GPU translateY -> 0 with zero per-frame layout passes.
  const drawerFlipTy = createAnimatedValue(0);
  const drawerPanY = createAnimatedValue(0);
  const drawerVisualTy = Animated.add(drawerFlipTy, drawerPanY);

  let drawerInitialized = false;
  let lastVisibleDrawerHeight = 0;
  let panStartDetent: StageDrawerDetent = "peek";
  let pendingInitialFlipTy: number | undefined;
  let pendingPanVelocityY: number | undefined;

  effect(() => {
    const nextHeight = layout().drawer.visibleHeight;
    const instant = !drawerInitialized || !props.active || reduceMotion();
    if (
      Math.abs(nextHeight - lastVisibleDrawerHeight) <= 0.5 &&
      pendingInitialFlipTy === undefined &&
      drawerInitialized
    ) {
      pendingPanVelocityY = undefined;
      return;
    }
    const deltaFromPrevious =
      pendingInitialFlipTy ?? nextHeight - lastVisibleDrawerHeight;
    pendingInitialFlipTy = undefined;
    lastVisibleDrawerHeight = nextHeight;
    drawerInitialized = true;
    drawerPanY.set(0);

    if (instant || nextHeight === 0) {
      pendingPanVelocityY = undefined;
      drawerFlipTy.set(0);
    } else {
      // Invert: start from previous visual top edge and spring smoothly to 0
      drawerFlipTy.set(deltaFromPrevious);
      const velocity = pendingPanVelocityY;
      pendingPanVelocityY = undefined;
      void drawerFlipTy.spring(0, {
        stiffness: 320,
        damping: 32,
        mass: 1,
        ...(velocity !== undefined ? { velocity } : {}),
      });
    }
  });

  const voiceActive = () =>
    ["connecting", "listening", "speaking"].includes(props.voiceState.phase);

  const liveVoiceTranscriptActive = () =>
    ["listening", "speaking"].includes(props.voiceState.phase) &&
    Boolean(props.voiceState.transcript);

  const showResponsePreview = () => {
    if (!props.responseText) return false;
    const stage = props.activeStage;
    if (stage && stage.presentation.active && !liveVoiceTranscriptActive()) {
      if (stage.presentation.hideDefaultDock) return false;
      if (effectiveDrawerDetent() !== "closed") return false;
    }
    return true;
  };

  const showWakeGuide = () => {
    if (props.composeOpen || props.wakeGuideDismissed || voiceActive()) {
      return false;
    }
    const stage = props.activeStage;
    if (stage && stage.presentation.active) {
      if (stage.presentation.hideDefaultDock) return false;
      if (effectiveDrawerDetent() !== "closed") return false;
    }
    return true;
  };

  return (
    <View
      testID="morphable-stage"
      accessibilityDescription={`posture:${effectivePosture().kind};detent:${effectiveDrawerDetent()}`}
      class="flex-1 relative overflow-hidden"
    >
      {/* Layer 0: Full-screen static OLED dot matrix & horizon glow */}
      <Canvas
        testID="stage-backdrop"
        class="absolute inset-0"
        style={{ zIndex: 0, pointerEvents: "none" }}
        draw={(cx, size) => {
          cx.clearRect(0, 0, size.width, size.height);
          if (!props.active) return;
          drawStageAmbientBackdrop(cx, size, token, effectiveInsets());
        }}
      />

      {/* Layer 10: Plugin StageCanvas (isolated per active pluginId) */}
      <Each of={activePluginIds()} key={(id) => id}>
        {(pluginIdAccessor) => {
          const pluginId = pluginIdAccessor();
          const viewCtx = props.getPluginViewContext(pluginId);
          const CanvasSlot = computed(
            () => getPluginUiModule(pluginId)?.StageCanvas,
          );
          return (
            <If when={Boolean(CanvasSlot())}>
              {() => {
                const Comp = CanvasSlot()!;
                const canvasMotion = createMotion({
                  enter: "fadeIn",
                  duration: 180,
                });
                return (
                  <View
                    testID="stage-canvas-region"
                    class="absolute"
                    style={{
                      zIndex: 10,
                      top: layout().canvas.top,
                      right: layout().canvas.right,
                      bottom: layout().canvas.bottom,
                      left: layout().canvas.left,
                      opacity: canvasMotion.opacity,
                      pointerEvents: "box-none",
                    }}
                  >
                    <PluginStageSlotBoundary
                      pluginId={pluginId}
                      slot="StageCanvas"
                      onCrash={props.onReportStageCrash}
                    >
                      <Comp ctx={viewCtx} />
                    </PluginStageSlotBoundary>
                  </View>
                );
              }}
            </If>
          );
        }}
      </Each>

      {/* Layer 14: Optional Pill Chrome Frame synchronized 1:1 with morphed RobotFace */}
      <View
        class="absolute inset-0 items-center justify-center"
        style={{ zIndex: 14, pointerEvents: "none" }}
      >
        <View
          testID="stage-face-pill"
          class="rounded-full border border-stage-pill-border bg-elevated-glass"
          style={{
            width: STAGE_BASE_PILL_WIDTH,
            height: STAGE_BASE_PILL_HEIGHT,
            opacity: pillOpacity,
            pointerEvents: "none",
            transform: [
              { translateX: pillTx },
              { translateY: pillTy },
              { scale: pillScale },
            ],
          }}
        />
      </View>

      {/* Layer 15: Single persistent RobotFace instance — NEVER unmounted across postures */}
      <View
        testID="stage-face-layer"
        class="absolute inset-0"
        style={{
          zIndex: 15,
          pointerEvents: "none",
          transform: [
            { translateX: faceTx },
            { translateY: faceTy },
            { scale: faceScale },
          ],
        }}
      >
        <RobotFace
          active={props.active}
          state={props.faceState}
          shift={{ dx: 0, dy: 0 }}
          skipBackdrop={true}
          insets={effectiveInsets()}
        />
      </View>

      {/* Layer 25: Plugin StageCapsule & 4-Detent StageDrawer */}
      <Each of={activePluginIds()} key={(id) => id}>
        {(pluginIdAccessor) => {
          const pluginId = pluginIdAccessor();
          const viewCtx = props.getPluginViewContext(pluginId);
          const CapsuleSlot = computed(
            () => getPluginUiModule(pluginId)?.StageCapsule,
          );
          const DrawerSlot = computed(
            () => getPluginUiModule(pluginId)?.StageDrawer,
          );
          return (
            <View
              class="absolute inset-0"
              style={{ zIndex: 25, pointerEvents: "box-none" }}
            >
              <If when={Boolean(CapsuleSlot()) && !capsuleOccludedByDrawer()}>
                {() => {
                  const Comp = CapsuleSlot()!;
                  const capsuleMotion = createMotion({
                    enter: "fadeIn",
                    duration: 180,
                  });
                  return (
                    <View
                      testID="stage-capsule-region"
                      class="absolute items-center"
                      style={{
                        top: layout().capsule.top,
                        left: layout().capsule.left,
                        right: layout().capsule.right,
                        opacity: capsuleMotion.opacity,
                        pointerEvents: "box-none",
                      }}
                    >
                      <PluginStageSlotBoundary
                        pluginId={pluginId}
                        slot="StageCapsule"
                        onCrash={props.onReportStageCrash}
                      >
                        <View
                          class="rounded-full border border-stage-pill-border bg-elevated-glass px-3.5 py-1.5"
                          style={{ pointerEvents: "auto" }}
                        >
                          <Comp ctx={viewCtx} />
                        </View>
                      </PluginStageSlotBoundary>
                    </View>
                  );
                }}
              </If>

              <If when={Boolean(DrawerSlot()) && effectiveDrawerDetent() !== "closed"}>
                {() => {
                  const Comp = DrawerSlot()!;
                  return (
                    <View
                      testID="stage-drawer"
                      accessibilityDescription={`detent:${effectiveDrawerDetent()}`}
                      class="absolute bottom-0 rounded-t-3xl border-t border-x border-stage-pill-border bg-ask-bar-bg"
                      style={{
                        left: effectiveInsets().left + 12,
                        right: effectiveInsets().right + 12,
                        height: layout().drawer.visibleHeight,
                        pointerEvents: "auto",
                        transform: [{ translateY: drawerVisualTy }],
                      }}
                    >
                      {/* Seamless bottom continuation skirt: anchors drawer bottom edge to screen bottom during upward drags & large->peek FLIP springs */}
                      <View
                        class="absolute bg-ask-bar-bg border-x border-stage-pill-border"
                        style={{
                          left: -1,
                          right: -1,
                          top: Math.max(0, layout().drawer.visibleHeight - 2),
                          height: layout().drawer.maxHeight + 96,
                          pointerEvents: "none",
                        }}
                      />

                      <View
                        class="flex-1 min-h-0 rounded-t-3xl overflow-hidden"
                        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
                      >
                        {/* Grabber Header Bar (pan across full header; semantic Button for keyboard/accessibility) */}
                        <View
                          pan={{ y: drawerPanY }}
                          onPanStart={() => {
                            panStartDetent = effectiveDrawerDetent();
                          }}
                          onPanEnd={(ev) => {
                            if (ev.cancelled) {
                              drawerPanY.set(0);
                              if (!reduceMotion() && Math.abs(ev.translation.y) > 0.5) {
                                drawerFlipTy.set(ev.translation.y);
                                void drawerFlipTy.spring(0, {
                                  stiffness: 320,
                                  damping: 32,
                                  mass: 1,
                                  velocity: ev.velocity.y,
                                });
                              }
                              return;
                            }
                            const metrics = layout().drawer;
                            const oldHeight = metrics.visibleHeight;
                            const snapped = resolveSnapDrawerDetent({
                              startDetent: panStartDetent,
                              translationY: ev.translation.y,
                              velocityY: ev.velocity.y,
                              drawer: metrics,
                              allowUserSwipeCollapse: allowUserSwipeCollapse(),
                            });
                            const newHeight =
                              snapped === "large"
                                ? metrics.largeHeight
                                : snapped === "medium"
                                  ? metrics.mediumHeight
                                  : snapped === "peek"
                                    ? metrics.peekHeight
                                    : 0;
                            drawerPanY.set(0);
                            if (snapped === effectiveDrawerDetent()) {
                              if (reduceMotion()) {
                                drawerFlipTy.set(0);
                              } else {
                                drawerFlipTy.set(ev.translation.y);
                                void drawerFlipTy.spring(0, {
                                  stiffness: 320,
                                  damping: 32,
                                  mass: 1,
                                  velocity: ev.velocity.y,
                                });
                              }
                              return;
                            }
                            if (newHeight === 0) {
                              pendingInitialFlipTy = undefined;
                              pendingPanVelocityY = undefined;
                              drawerFlipTy.set(0);
                            } else {
                              pendingInitialFlipTy =
                                newHeight - oldHeight + ev.translation.y;
                              pendingPanVelocityY = ev.velocity.y;
                            }
                            userDetentOverride.set(snapped);
                          }}
                          class="flex-row items-center justify-between px-3 h-9 border-b border-stage-pill-border shrink-0"
                        >
                          <View class="w-11 h-9" style={{ pointerEvents: "none" }} />
                          <Button
                            testID="stage-drawer-grabber"
                            accessibilityLabel={t("pluginStageDrawerHandle")}
                            hitSlop={{ top: 8, bottom: 8, left: 16, right: 16 }}
                            onPress={() => {
                              userDetentOverride.set(
                                nextCycledDrawerDetent(
                                  effectiveDrawerDetent(),
                                  allowUserSwipeCollapse(),
                                ),
                              );
                            }}
                            class="flex-1 h-9 rounded-lg border border-transparent items-center justify-center active:opacity-75 focus:border-stage-pill-fg"
                          >
                            <View class="w-10 h-1.5 rounded-full bg-stage-pill-border" />
                          </Button>
                          <View class="w-11 items-end justify-center">
                            <If when={allowUserSwipeCollapse()}>
                              <Button
                                testID="stage-drawer-collapse"
                                accessibilityLabel={t("pluginStageDrawerCollapse")}
                                hitSlop={8}
                                onPress={() => userDetentOverride.set("closed")}
                                class="w-9 h-8 rounded-full border border-transparent items-center justify-center active:opacity-75 focus:border-stage-pill-fg"
                              >
                                <HomeHeaderIcon kind="chevronDown" />
                              </Button>
                            </If>
                          </View>
                        </View>

                        <View class="flex-1 min-h-0 px-3.5 py-1.5">
                          <PluginStageSlotBoundary
                            pluginId={pluginId}
                            slot="StageDrawer"
                            onCrash={props.onReportStageCrash}
                          >
                            <Comp
                              ctx={viewCtx}
                              detent={effectiveDrawerDetent}
                            />
                          </PluginStageSlotBoundary>
                        </View>
                      </View>
                    </View>
                  );
                }}
              </If>
            </View>
          );
        }}
      </Each>

      {/* Layer 40: Unblockable Host Safety Top Bar & Bottom Ambient/Compose Dock */}
      <View
        class="absolute inset-0 justify-between"
        style={{
          zIndex: 40,
          pointerEvents: "box-none",
          paddingTop: effectiveInsets().top + 10,
          paddingBottom: effectiveInsets().bottom + 10,
          paddingLeft: effectiveInsets().left + 16,
          paddingRight: effectiveInsets().right + 16,
        }}
      >
        <View class="gap-2" style={{ pointerEvents: "box-none" }}>
          <View
            class="flex-row items-center justify-between gap-3"
            style={{ pointerEvents: "box-none" }}
          >
            <View
              class="flex-1 min-w-0 flex-row items-center gap-2 px-2 py-1"
              style={{
                opacity: 0.85,
                minHeight: 38,
                flexShrink: 1,
                pointerEvents: "none",
              }}
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
                style={{ letterSpacing: 1, flexShrink: 1, numberOfLines: 1 }}
              >
                {props.statusText}
              </Text>
            </View>

            <View
              class="flex-row items-center gap-2"
              style={{ pointerEvents: "auto" }}
            >
              <If
                when={Boolean(
                  props.activeStage && props.activeStage.presentation.active,
                )}
              >
                <Button
                  testID="exit-plugin-stage"
                  accessibilityLabel={t("pluginExitStageLabel")}
                  onPress={() => props.onExitStage(props.activeStage?.pluginId)}
                  class="h-11 px-3.5 rounded-full border border-stage-pill-border bg-elevated-glass flex-row items-center gap-1.5 active:opacity-75 focus:border-stage-pill-fg"
                >
                  <HomeHeaderIcon kind="exit" active={true} />
                  <Text class="text-stage-pill-fg text-xs font-semibold">
                    {t("pluginExitStage")}
                  </Text>
                </Button>
              </If>

              <LiveVoiceButton
                phase={props.voiceState.phase}
                muted={props.voiceState.muted}
                audioLevel={props.voiceAudioLevel}
                accessibilityLabel={
                  props.voiceState.phase === "speaking"
                    ? t("interruptPlayback")
                    : voiceActive()
                      ? t("endLiveVoice")
                      : t("startProviderVoice", {
                          provider: props.voiceProviderLabel,
                        })
                }
                disabled={!props.ready}
                onPress={props.onToggleVoice}
              />

              <Button
                testID="compose"
                accessibilityLabel={t("sendAMessageToLooi")}
                selected={props.composeOpen}
                onPress={props.onToggleCompose}
                class="w-11 h-11 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75 focus:border-stage-pill-fg"
              >
                <HomeHeaderIcon kind="chat" active={props.composeOpen} />
              </Button>

              <Button
                testID="connection-settings"
                accessibilityLabel={t("openConnectionsAndSettings")}
                onPress={props.onOpenSettings}
                class="w-11 h-11 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75 focus:border-stage-pill-fg"
              >
                <HomeHeaderIcon kind="settings" />
              </Button>
            </View>
          </View>

          <If when={props.toastText}>
            <View class="items-center" style={{ pointerEvents: "none" }}>
              <LightToast text={props.toastText} stage={true} />
            </View>
          </If>
        </View>

        <View
          class="items-center gap-2"
          style={{
            marginBottom: "env(keyboard-inset-height)",
            pointerEvents: "box-none",
          }}
        >
          <If
            when={showResponsePreview()}
            else={
              <If when={showWakeGuide()}>
                <View style={{ pointerEvents: "auto" }}>
                  <WakeGuideBar
                    active={props.voiceState.phase === "standby"}
                    onPress={props.onToggleVoice}
                  />
                </View>
              </If>
            }
          >
            <View style={{ pointerEvents: "auto" }}>
              <ResponsePreview
                text={props.responseText}
                onOpen={props.onOpenResponse}
              />
            </View>
          </If>

          <If when={props.composeOpen}>
            <View
              class="w-full rounded-2xl border border-stage-pill-border bg-ask-bar-bg px-3 py-1.5 flex-row items-center gap-2"
              style={{ pointerEvents: "auto" }}
            >
              <Input
                testID="message-input"
                accessibilityLabel={t("sendAMessageToLooi")}
                value={props.composeDraft}
                onChange={(e) => props.onChangeDraft(e.value)}
                onSubmit={props.onSubmitDraft}
                autoCorrect={false}
                autoCapitalize="none"
                maxLength={8192}
                placeholder={t("askLooiEgListFilesOrWrite")}
                class="flex-1 h-10 rounded-xl border border-transparent bg-transparent px-2 text-stage-fg text-sm placeholder:text-stage-pill-muted focus:border-ring"
              />
              <Button
                testID="send-message"
                disabled={
                  !props.composeDraft.trim() || !props.ready || props.busy
                }
                onPress={props.onSubmitDraft}
                class="rounded-full bg-eye-core px-4 items-center justify-center active:opacity-75 disabled:opacity-40"
                style={{ minHeight: 44 }}
              >
                <Text class="text-stage-bg text-xs font-bold">
                  {t("send")}
                </Text>
              </Button>
            </View>
          </If>
        </View>
      </View>
    </View>
  );
}
