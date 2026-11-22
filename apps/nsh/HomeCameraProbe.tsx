import { cleanup, locale, mount, signal, Text, View } from "nsh";
import { bindLocale, resolveLocale } from "./i18n";
import { ActionButton } from "./ui/Controls";
import type { CameraVideoState } from "./ui/CameraVideo";
import { HomeSpaceView } from "./ui/HomeSpaceView";
import type {
  HomeAppliance,
  HomeDashboardModel,
} from "./generated/looi-runtime.js";
import type { createAppStore } from "./store";

/** Headless render fixture only: verifies native node identity, fullscreen handoff, and HUD controls. */
function Probe() {
  bindLocale(() => resolveLocale("system", locale()));
  const activeSpace = signal<"face" | "models" | "home">("home");
  const inspected = signal<string | null>("direct_miot:camera-test");
  const cameraState = signal<{
    phase: "idle" | "loading" | "prepared" | "playing" | "error";
    sessionId: string | null;
    seconds: number;
    buffering: boolean;
    width?: number;
    height?: number;
    frames?: number;
    error?: string;
  }>({
    phase: "loading",
    sessionId: "test-session",
    seconds: 0,
    buffering: true,
  });
  const ptzBusy = signal<"left" | "right" | "up" | "down" | null>(null);
  const retryCount = signal(0);
  const lastPtz = signal("none");
  const heartbeatCount = signal(0);
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const stopHeartbeat = () => {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };
  cleanup(stopHeartbeat);

  const makeAppliance = (on: boolean, resolutionBadge?: string): HomeAppliance => ({
    id: "direct_miot:camera-test",
    deviceId: "camera-test",
    source: "direct_miot",
    sourceLabel: "米家",
    name: "Camera",
    room: "Room",
    archetype: "vision_security",
    icon: "camera",
    defaultSpan: "2x2",
    span: "2x2",
    order: 0,
    online: true,
    isActive: on,
    statusBadge: on ? "On" : "Off",
    conciseSubtitle: "Camera",
    entityIds: ["camera.test"],
    capabilities: {
      telemetry: [],
      power: {
        entityId: "switch.test",
        domain: "switch",
        isOn: on,
        controllable: true,
      },
      visionStream: {
        playbackKind: "native",
        cameraOn: true,
        streamActive: false,
        statusText: "View camera",
        resolutionBadge,
        supportsPtz: true,
        ptzActions: [],
        featureToggles: [],
      },
    },
  });

  const appliance = signal(makeAppliance(true));
  const dashboard = (): HomeDashboardModel => ({
    homeName: "Test",
    totalAppliances: 1,
    activeAppliances: 1,
    rooms: [
      {
        id: "Room",
        name: "Room",
        totalCount: 1,
        activeCount: 1,
        navSummary: "",
        environment: [],
        appliances: [appliance()],
        roomPowerEntities: { turnOnIds: [], turnOffIds: [] },
      },
    ],
    allAppliances: [appliance()],
  });

  const applyVideoState = (event: CameraVideoState) => {
    if (cameraState().sessionId !== event.sessionId) return;
    cameraState.update((state) => ({
      ...state,
      width: event.width,
      height: event.height,
      frames: event.frames,
      seconds: (state.seconds ?? 0) + 0.25,
      phase: event.displayed === true ? "playing" : "loading",
      buffering: false,
    }));
  };

  const startPlayingWithHeartbeat = () => {
    stopHeartbeat();
    heartbeatCount.set(0);
    cameraState.set({
      phase: "playing",
      sessionId: "test-session",
      seconds: 12,
      buffering: false,
      width: 1920,
      height: 1080,
      frames: 10,
    });
    heartbeatTimer = setInterval(() => {
      const nextTick = heartbeatCount() + 1;
      heartbeatCount.set(nextTick);
      applyVideoState({
        sessionId: "test-session",
        frames: 10 + nextTick * 6,
        width: 1920,
        height: 1080,
        timestampMs: 12000 + nextTick * 250,
        error: 0,
        displayed: true,
        closed: false,
        failure: null,
      });
    }, 250);
  };

  const store = {
    activeSpace: () => activeSpace(),
    homeDashboard: dashboard,
    homeInspectedApplianceId: () => inspected(),
    setHomeInspectedApplianceId: (id: string | null) => inspected.set(id),
    homeConfiguration: () => ({
      mode: "direct_miot",
      region: "cn",
      haUrl: "",
      hasToken: false,
      hasMiotAccount: true,
    }),
    homeSubView: () => "devices",
    homeOverviewCollapsed: () => false,
    homeSelectedRoom: () => "all",
    homeLoading: () => false,
    homeRefreshing: () => false,
    homeConnection: () => undefined,
    homeCamera: () => cameraState(),
    homeCameraPtzBusy: () => ptzBusy(),
    retryHomeCamera: () => retryCount.update((n) => n + 1),
    panTiltHomeCamera: async (
      _did: string,
      direction: "left" | "right" | "up" | "down",
    ) => {
      lastPtz.set(direction);
      ptzBusy.set(direction);
      await new Promise((resolve) => setTimeout(resolve, 150));
      ptzBusy.set(null);
    },
    homeCameraState: applyVideoState,
    homeCameraEntities: () => [
      { entityId: "camera.test", deviceId: "camera-test", label: "Camera" },
    ],
  } as unknown as ReturnType<typeof createAppStore>;

  return (
    <View class="flex-1">
      <View class="flex-row flex-wrap items-center gap-1 p-1">
        <ActionButton
          label="Poll dashboard"
          compact={true}
          onPress={() => appliance.set(makeAppliance(!appliance().isActive))}
        />
        <ActionButton
          label="Queue poll"
          compact={true}
          onPress={() => {
            setTimeout(() => {
              appliance.set(makeAppliance(!appliance().isActive, "Polled"));
            }, 200);
          }}
        />
        <ActionButton
          label="Set playing"
          compact={true}
          onPress={() => startPlayingWithHeartbeat()}
        />
        <ActionButton
          label="Set error"
          compact={true}
          onPress={() => {
            stopHeartbeat();
            cameraState.set({
              phase: "error",
              sessionId: null,
              seconds: 0,
              buffering: false,
              error: "camera_session_closed",
            });
          }}
        />
        <ActionButton
          label="Queue disconnect"
          compact={true}
          onPress={() => {
            setTimeout(() => {
              stopHeartbeat();
              cameraState.set({
                phase: "error",
                sessionId: null,
                seconds: 0,
                buffering: false,
                error: "camera_session_closed",
              });
            }, 150);
          }}
        />
        <ActionButton
          label="Queue space switch"
          compact={true}
          onPress={() => {
            setTimeout(() => {
              activeSpace.set("models");
            }, 150);
          }}
        />
        <Text>{appliance().statusBadge}</Text>
        <Text testID="probe-camera-metrics">{`retry=${retryCount()} ptz=${lastPtz()} hb=${heartbeatCount()}`}</Text>
      </View>
      <HomeSpaceView store={store} />
    </View>
  );
}
mount(Probe);
