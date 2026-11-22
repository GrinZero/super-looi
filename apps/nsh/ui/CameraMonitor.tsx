import {
  cleanup,
  computed,
  createAnimatedValue,
  effect,
  reduceMotion,
  safeAreaInsets,
  signal,
  Text,
  View,
  windowSize,
  type AnimatedValue,
} from "nsh";
import { Button, Dialog } from "nsh/base";
import { t, translateMessage } from "../i18n";
import type { createAppStore } from "../store";
import { CameraVideo, type CameraVideoState } from "./CameraVideo";
import { ActionButton, LoadingIndicator } from "./Controls";
import { ActionIcon, ApplianceIcon } from "./HomeIcons";

export interface CameraMonitorProps {
  store: ReturnType<typeof createAppStore>;
  cameraName: string;
  deviceId: string;
  statusText?: string;
  resolutionBadge?: string;
  supportsPtz?: boolean;
  ptzDisabled?: boolean;
}

type HomeCameraPlayback = ReturnType<ReturnType<typeof createAppStore>["homeCamera"]>;
type PtzDirection = "left" | "right" | "up" | "down";

const HUD_AUTO_HIDE_MS = 4000;
const HUD_SHOW_MS = 180;
const HUD_HIDE_MS = 150;

function resolvePlaybackStatusLabel(
  playback: HomeCameraPlayback,
  fallbackStatusText?: string,
): string {
  switch (playback.phase) {
    case "playing":
      return playback.buffering ? t("cameraBuffering") : t("cameraPlaying");
    case "error":
      return translateMessage(playback.error ?? "");
    case "idle":
      return fallbackStatusText ?? t("cameraStopped");
    default:
      return t("cameraWaiting");
  }
}

function resolveStatusDotClass(playback: HomeCameraPlayback): string {
  if (playback.phase === "playing" && !playback.buffering) {
    return "w-2 h-2 rounded-full shrink-0 bg-verified";
  }
  if (playback.phase === "error") {
    return "w-2 h-2 rounded-full shrink-0 bg-destructive";
  }
  if (playback.phase === "loading" || playback.phase === "prepared" || playback.buffering) {
    return "w-2 h-2 rounded-full shrink-0 bg-warning";
  }
  return "w-2 h-2 rounded-full shrink-0 bg-stage-pill-muted";
}

function resolveResolutionLabel(
  playback: HomeCameraPlayback,
  fallbackBadge?: string,
): string {
  if (playback.width && playback.height) {
    return `${playback.width} × ${playback.height}`;
  }
  return fallbackBadge ?? "";
}

function FullscreenPtzPad(props: {
  busyDirection: () => PtzDirection | null;
  disabled: () => boolean;
  onStep: (direction: PtzDirection) => void;
}) {
  const buttonClass = (direction: PtzDirection) =>
    props.busyDirection() === direction
      ? "w-10 h-10 rounded-full bg-eye-core border border-eye-core items-center justify-center transition duration-150 active:scale-[0.95] motion-reduce:active:scale-100 focus-visible:border-stage-pill-fg focus-visible:ring-2 focus-visible:ring-eye-core disabled:opacity-45"
      : "w-10 h-10 rounded-full bg-stage-tile border border-stage-pill-border items-center justify-center hover:bg-elevated-glass transition duration-150 active:scale-[0.95] motion-reduce:active:scale-100 focus-visible:border-stage-pill-fg focus-visible:ring-2 focus-visible:ring-eye-core disabled:opacity-45";

  const iconTone = (direction: PtzDirection) =>
    props.busyDirection() === direction ? "stageBg" : "stageFg";

  const renderDirectionButton = (
    direction: PtzDirection,
    icon: "move_up" | "move_down" | "move_left" | "move_right",
    accessibilityLabel: () => string,
  ) => (
    <Button
      testID={`fullscreen-cam-ptz-${direction}`}
      accessibilityLabel={accessibilityLabel()}
      hitSlop={4}
      disabled={props.disabled()}
      selected={props.busyDirection() === direction}
      onPress={() => props.onStep(direction)}
      class={buttonClass(direction)}
    >
      <ActionIcon name={icon} tone={iconTone(direction)} size={17} />
    </Button>
  );

  return (
    <View
      testID="home-camera-fullscreen-ptz"
      style={{ width: 136, height: 136 }}
      class="rounded-full bg-glass-bg border border-stage-pill-border p-1.5 items-center justify-between shrink-0"
    >
      {renderDirectionButton("up", "move_up", () => t("cameraPtzUp"))}
      <View class="w-full flex-row items-center justify-between">
        {renderDirectionButton("left", "move_left", () => t("cameraPtzLeft"))}
        <View class="w-8 h-8 rounded-full bg-stage-tile border border-stage-pill-border items-center justify-center">
          <View
            class={
              props.busyDirection() !== null
                ? "w-2.5 h-2.5 rounded-full bg-verified"
                : "w-2 h-2 rounded-full bg-stage-pill-muted"
            }
          />
        </View>
        {renderDirectionButton("right", "move_right", () => t("cameraPtzRight"))}
      </View>
      {renderDirectionButton("down", "move_down", () => t("cameraPtzDown"))}
    </View>
  );
}

/**
 * Isolated inside `<Dialog>` so `safeAreaInsets()` reads the modal window's insets
 * rather than the underlying ManagementShell page insets.
 */
function CameraFullscreenContent(props: {
  sessionList: () => string[];
  cameraName: () => string;
  playback: () => HomeCameraPlayback;
  statusText: () => string | undefined;
  resolutionBadge: () => string | undefined;
  supportsPtz: () => boolean;
  ptzDisabled: () => boolean;
  ptzBusy: () => PtzDirection | null;
  effectiveHudVisible: () => boolean;
  hudMounted: () => boolean;
  hudOpacity: AnimatedValue;
  onVideoState: (event: CameraVideoState) => void;
  onToggleHud: () => void;
  onRetry: () => void;
  onPanTilt: (direction: PtzDirection) => void;
  onClose: () => void;
}) {
  const modalInsets = safeAreaInsets();
  const compactControls = () => windowSize().width < 520;

  const statusLine = () => {
    const pb = props.playback();
    const status = resolvePlaybackStatusLabel(pb, props.statusText());
    const res = resolveResolutionLabel(pb, props.resolutionBadge());
    return res ? `${status} · ${res}` : status;
  };

  const liveActivityLabel = () => {
    if (props.ptzBusy() !== null) return t("cameraPtzMoving");
    const pb = props.playback();
    if (pb.phase === "loading") return t("cameraConnecting");
    if (pb.buffering) return t("cameraBuffering");
    return "";
  };

  const hudActionButtonClass =
    "min-h-11 min-w-11 px-3.5 rounded-full bg-glass-bg border border-stage-pill-border flex-row items-center justify-center gap-1.5 hover:bg-elevated-glass transition duration-150 active:scale-[0.95] motion-reduce:active:scale-100 focus-visible:border-stage-pill-fg focus-visible:ring-2 focus-visible:ring-eye-core";

  return (
    <View class="flex-1 w-full h-full relative bg-stage-bg">
      {/* Native full-screen video surface (single live session handoff) */}
      <Each of={props.sessionList()} key={(id) => id}>
        {(id) => (
          <CameraVideo
            testID="home-camera-fullscreen-video"
            sessionId={id()}
            class="absolute inset-0"
            onState={(event) => props.onVideoState(event)}
          />
        )}
      </Each>

      {/* Canvas touch target to toggle HUD controls */}
      <Button
        testID="home-camera-fullscreen-canvas"
        accessibilityLabel={
          props.effectiveHudVisible()
            ? t("cameraHideControls")
            : t("cameraShowControls")
        }
        onPress={() => props.onToggleHud()}
        class="absolute inset-0 bg-transparent"
      />

      {/* Centered recovery card if the session disconnects or errors while fullscreen */}
      <If when={!props.playback().sessionId}>
        <View
          class="absolute inset-0 items-center justify-center p-6"
          style={{ pointerEvents: "box-none" }}
        >
          <View class="rounded-2xl border border-stage-pill-border bg-stage-panel px-6 py-5 items-center gap-3 max-w-sm">
            <ApplianceIcon kind="camera" active={false} size="lg" />
            <If when={props.playback().phase === "loading"}>
              <LoadingIndicator stage={true} label={t("cameraConnecting")} />
            </If>
            <If when={Boolean(props.playback().error)}>
              <Text
                testID="home-camera-fullscreen-error"
                class="text-stage-fg text-sm text-center"
              >
                {translateMessage(props.playback().error ?? "")}
              </Text>
            </If>
            <If
              when={
                props.playback().phase !== "loading" && !props.playback().error
              }
            >
              <Text class="text-stage-muted text-sm text-center">
                {props.statusText() ?? t("cameraStopped")}
              </Text>
            </If>
            <Button
              testID="home-camera-fullscreen-center-retry"
              accessibilityLabel={t("cameraReconnect")}
              hitSlop={4}
              onPress={() => props.onRetry()}
              class="min-h-11 px-4 rounded-full bg-eye-core flex-row items-center justify-center gap-1.5 transition duration-150 active:scale-[0.95] motion-reduce:active:scale-100 focus-visible:ring-2 focus-visible:ring-stage-pill-fg"
            >
              <ActionIcon name="refresh" tone="stageBg" size={16} />
              <Text class="text-stage-bg text-sm font-semibold">
                {t("cameraReconnect")}
              </Text>
            </Button>
          </View>
        </View>
      </If>

      {/* Auto-hiding HUD overlay */}
      <View
        testID="home-camera-fullscreen-hud"
        accessibilityElementsHidden={!props.effectiveHudVisible()}
        class="absolute inset-0 flex-col justify-between"
        style={{
          display: props.hudMounted() ? "flex" : "none",
          opacity: props.hudOpacity,
          pointerEvents: props.effectiveHudVisible() ? "box-none" : "none",
          paddingTop: Math.max(12, modalInsets().top + 8),
          paddingBottom: Math.max(12, modalInsets().bottom + 8),
          paddingLeft: Math.max(16, modalInsets().left + 12),
          paddingRight: Math.max(16, modalInsets().right + 12),
        }}
      >
        {/* Top Floating Bar: Camera Name & Status + Reconnect & Exit Fullscreen */}
        <View
          class="flex-row items-center justify-between gap-3"
          style={{ pointerEvents: "box-none" }}
        >
          <View
            class="min-h-11 px-3.5 py-1.5 rounded-full bg-glass-bg border border-stage-pill-border flex-row items-center gap-2.5 shrink"
            style={{
              maxWidth: Math.min(380, Math.round(windowSize().width * 0.54)),
            }}
          >
            <View class={resolveStatusDotClass(props.playback())} />
            <View class="flex-1 min-w-0">
              <Text
                testID="home-camera-fullscreen-title"
                class="text-stage-fg text-xs font-semibold"
                style={{ numberOfLines: 1 }}
              >
                {props.cameraName()}
              </Text>
              <Text
                testID="home-camera-fullscreen-status"
                class="text-stage-muted text-xs"
                style={{ numberOfLines: 1, fontVariant: ["tabular-nums"] }}
              >
                {statusLine()}
              </Text>
            </View>
          </View>

          <View
            class="flex-row items-center gap-2 shrink-0"
            style={{ pointerEvents: "box-none" }}
          >
            <Button
              testID="home-camera-fullscreen-retry"
              accessibilityLabel={t("cameraReconnect")}
              hitSlop={4}
              onPress={() => props.onRetry()}
              class={hudActionButtonClass}
            >
              <ActionIcon name="refresh" tone="stageFg" size={16} />
              <If when={!compactControls()}>
                <Text class="text-stage-fg text-xs font-semibold">
                  {t("cameraReconnect")}
                </Text>
              </If>
            </Button>

            <Button
              testID="home-camera-fullscreen-close"
              accessibilityLabel={t("cameraExitFullscreen")}
              hitSlop={4}
              onPress={() => props.onClose()}
              class={hudActionButtonClass}
            >
              <ActionIcon name="minimize" tone="stageFg" size={16} />
              <If when={!compactControls()}>
                <Text class="text-stage-fg text-xs font-semibold">
                  {t("cameraExitFullscreen")}
                </Text>
              </If>
            </Button>
          </View>
        </View>

        {/* Bottom Floating Row: Live Activity Pill + Optional Fullscreen PTZ D-Pad */}
        <View
          class="flex-row items-end justify-between gap-3"
          style={{ pointerEvents: "box-none" }}
        >
          <View class="flex-1 items-start" style={{ pointerEvents: "box-none" }}>
            <If when={Boolean(props.playback().sessionId && liveActivityLabel())}>
              <View class="min-h-10 px-3.5 py-1.5 rounded-full bg-glass-bg border border-stage-pill-border items-center justify-center">
                <LoadingIndicator
                  inline={true}
                  stage={true}
                  label={liveActivityLabel()}
                />
              </View>
            </If>
          </View>

          <If when={props.supportsPtz()}>
            <FullscreenPtzPad
              busyDirection={props.ptzBusy}
              disabled={() => props.ptzDisabled() || props.ptzBusy() !== null}
              onStep={(direction) => props.onPanTilt(direction)}
            />
          </If>
        </View>
      </View>
    </View>
  );
}

/**
 * Displays a live camera monitor with tap-to-fullscreen viewing.
 * Keeps a single native `CameraVideo` surface mounted at any moment so entering
 * and exiting fullscreen rebinds the existing decoder session with zero reconnect.
 */
export function CameraMonitor(props: CameraMonitorProps) {
  const fullscreen = signal(false);
  const hudVisible = signal(true);
  const hudMounted = signal(true);
  const hudInteractionTick = signal(0);
  const hudOpacity = createAnimatedValue(1);

  const playback = () => props.store.homeCamera();
  const ptzBusy = (): PtzDirection | null =>
    typeof props.store.homeCameraPtzBusy === "function"
      ? props.store.homeCameraPtzBusy()
      : null;

  const sessionId = computed(() => playback().sessionId);
  const canEnterFullscreen = computed(() => Boolean(sessionId()));
  const inlineSessionList = computed(() => {
    const id = sessionId();
    return id && !fullscreen() ? [id] : [];
  });
  const fullscreenSessionList = computed(() => {
    const id = sessionId();
    return fullscreen() && id ? [id] : [];
  });
  const isPlayingLive = computed(
    () =>
      canEnterFullscreen() &&
      playback().phase === "playing" &&
      !playback().buffering,
  );
  const hudPinned = computed(() => !isPlayingLive() || ptzBusy() !== null);
  const effectiveHudVisible = computed(() => hudVisible() || hudPinned());

  const openFullscreen = () => {
    if (!playback().sessionId) return;
    hudVisible.set(true);
    hudMounted.set(true);
    hudInteractionTick.update((n) => n + 1);
    fullscreen.set(true);
  };

  const closeFullscreen = () => {
    fullscreen.set(false);
  };

  const bumpHudActivity = () => {
    hudVisible.set(true);
    hudMounted.set(true);
    hudInteractionTick.update((n) => n + 1);
  };

  const toggleHud = () => {
    if (hudPinned()) {
      bumpHudActivity();
      return;
    }
    if (hudVisible()) {
      hudVisible.set(false);
    } else {
      bumpHudActivity();
    }
  };

  const handleRetry = () => {
    bumpHudActivity();
    props.store.retryHomeCamera();
  };

  const handlePanTilt = (direction: PtzDirection) => {
    bumpHudActivity();
    if (typeof props.store.panTiltHomeCamera === "function") {
      void props.store.panTiltHomeCamera(props.deviceId, direction);
    }
  };

  const handleVideoState = (event: CameraVideoState) => {
    if (typeof props.store.homeCameraState === "function") {
      props.store.homeCameraState(event);
    }
  };

  // Close fullscreen if the parent space/subview switches while RetainedPage keeps this mounted.
  effect(() => {
    const activeSpace =
      typeof props.store.activeSpace === "function"
        ? props.store.activeSpace()
        : "home";
    const subView =
      typeof props.store.homeSubView === "function"
        ? props.store.homeSubView()
        : "devices";
    if ((activeSpace !== "home" || subView !== "devices") && fullscreen()) {
      fullscreen.set(false);
    }
  });

  // Auto-hide HUD after 4 seconds of inactivity while video is actively playing.
  effect(() => {
    const isOpen = fullscreen();
    const visible = hudVisible();
    const pinned = hudPinned();
    hudInteractionTick();
    if (!isOpen || !visible || pinned) return;
    const timer = setTimeout(() => {
      hudVisible.set(false);
    }, HUD_AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  });

  // Drive native HUD fade-in / fade-out without disturbing video frames.
  let hudMotionInitialized = false;
  effect(() => {
    const isOpen = fullscreen();
    const visible = effectiveHudVisible();
    if (!isOpen) {
      hudMotionInitialized = false;
      hudMounted.set(true);
      hudOpacity.set(1);
      return;
    }
    if (!hudMotionInitialized || reduceMotion()) {
      hudMotionInitialized = true;
      hudMounted.set(visible);
      hudOpacity.set(visible ? 1 : 0);
      return;
    }
    if (visible) {
      hudMounted.set(true);
      void hudOpacity.timing(1, {
        duration: HUD_SHOW_MS,
        easing: "easeOut",
      });
      return;
    }
    void hudOpacity
      .timing(0, {
        duration: HUD_HIDE_MS,
        easing: "easeIn",
      })
      .then(({ finished }) => {
        if (finished && fullscreen() && !effectiveHudVisible()) {
          hudMounted.set(false);
        }
      });
  });

  cleanup(() => {
    fullscreen.set(false);
  });

  return (
    <View class="rounded-2xl border border-border bg-card p-3 gap-2">
      <View
        class={
          canEnterFullscreen()
            ? "w-full rounded-xl overflow-hidden bg-stage-bg items-center justify-center relative"
            : "w-full rounded-xl overflow-hidden bg-secondary items-center justify-center relative"
        }
        style={{ aspectRatio: "16 / 9", minHeight: 156, maxHeight: 196 }}
      >
        <Each of={inlineSessionList()} key={(id) => id}>
          {(id) => (
            <CameraVideo
              testID="home-camera-video"
              sessionId={id()}
              class="absolute inset-0"
              onState={(event) => handleVideoState(event)}
            />
          )}
        </Each>

        <If when={canEnterFullscreen() && !fullscreen()}>
          <Button
            testID="home-camera-fullscreen-trigger"
            accessibilityLabel={`${props.cameraName} ${t("cameraEnterFullscreen")}`}
            onPress={() => openFullscreen()}
            class="absolute inset-0 items-end justify-end p-2.5 transition-opacity duration-150 active:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <View
              style={{ pointerEvents: "none" }}
              class="w-9 h-9 rounded-lg bg-glass-bg border border-stage-pill-border items-center justify-center"
            >
              <ActionIcon name="maximize" tone="stageFg" size={16} />
            </View>
          </Button>
        </If>

        <If when={canEnterFullscreen() && fullscreen()}>
          <View class="items-center gap-2 p-4">
            <ApplianceIcon kind="camera" active={true} size="lg" />
            <Text class="text-stage-muted text-xs">
              {t("cameraFullscreenTitle")}
            </Text>
          </View>
        </If>

        <If when={!canEnterFullscreen()}>
          <View class="items-center gap-3 p-4">
            <ApplianceIcon kind="camera" active={false} size="lg" />
            <If when={playback().phase === "loading"}>
              <LoadingIndicator label={t("cameraConnecting")} />
            </If>
            <If when={Boolean(playback().error)}>
              <Text class="text-muted-foreground text-sm">
                {translateMessage(playback().error ?? "")}
              </Text>
            </If>
            <If when={playback().phase !== "loading" && !playback().error}>
              <Text class="text-muted-foreground text-sm">
                {props.statusText ?? t("cameraNoLiveStream")}
              </Text>
            </If>
          </View>
        </If>
      </View>

      <View class="flex-row items-center justify-between gap-3">
        <View class="flex-1 gap-1">
          <Text
            testID="home-camera-status"
            class="text-foreground text-sm font-semibold"
          >
            {resolvePlaybackStatusLabel(playback(), props.statusText)}
          </Text>
          <If when={Boolean(playback().width && playback().height)}>
            <Text
              class="text-muted-foreground text-xs"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {`${playback().width} × ${playback().height}`}
            </Text>
          </If>
          <If when={!playback().width && Boolean(props.resolutionBadge)}>
            <Text class="text-muted-foreground text-xs">
              {props.resolutionBadge}
            </Text>
          </If>
        </View>
        <ActionButton
          testID="home-camera-retry"
          label={t("cameraReconnect")}
          kind="quiet"
          onPress={() => handleRetry()}
        />
      </View>

      <Dialog
        testID="home-camera-fullscreen-dialog"
        open={fullscreen()}
        presentation="fullScreen"
        statusBar={{ hidden: true, animated: true }}
        android={{ statusBarTranslucent: true }}
        animation={reduceMotion() ? "none" : "fade"}
        accessibilityLabel={`${props.cameraName} ${t("cameraFullscreenTitle")}`}
        closeOnEscape={true}
        closeOnSwipe={false}
        closeOnBackdropPress={false}
        onOpenChange={(e) => {
          if (!e.open) closeFullscreen();
        }}
        class="flex-1 w-full h-full bg-stage-bg relative"
      >
        <CameraFullscreenContent
          sessionList={fullscreenSessionList}
          cameraName={() => props.cameraName}
          playback={playback}
          statusText={() => props.statusText}
          resolutionBadge={() => props.resolutionBadge}
          supportsPtz={() => Boolean(props.supportsPtz)}
          ptzDisabled={() => Boolean(props.ptzDisabled)}
          ptzBusy={ptzBusy}
          effectiveHudVisible={effectiveHudVisible}
          hudMounted={() => hudMounted()}
          hudOpacity={hudOpacity}
          onVideoState={handleVideoState}
          onToggleHud={toggleHud}
          onRetry={handleRetry}
          onPanTilt={handlePanTilt}
          onClose={closeFullscreen}
        />
      </Dialog>
    </View>
  );
}
