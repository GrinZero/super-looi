import { mount, signal, Text, View } from "nsh";
import { ActionButton } from "./ui/Controls";
import { HomeSpaceView } from "./ui/HomeSpaceView";
import type {
  HomeAppliance,
  HomeDashboardModel,
} from "./generated/looi-runtime.js";
import type { createAppStore } from "./store";

/** Headless render fixture only: verifies native node identity, not media. */
function Probe() {
  const inspected = signal<string | null>("direct_miot:camera-test");
  const makeAppliance = (on: boolean): HomeAppliance => ({
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
        playbackKind: "hls",
        cameraOn: true,
        streamActive: false,
        statusText: "View camera",
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
  const store = {
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
    homeSelectedRoom: () => "all",
    homeLoading: () => false,
    homeRefreshing: () => false,
    homeConnection: () => undefined,
    homeCamera: () => ({
      phase: "loading",
      url: "https://video.invalid/fixture.m3u8",
      seconds: 0,
      buffering: true,
    }),
    homeCameraEntities: () => [
      { entityId: "camera.test", deviceId: "camera-test", label: "Camera" },
    ],
  } as unknown as ReturnType<typeof createAppStore>;
  return (
    <View class="flex-1">
      <ActionButton
        label="Poll dashboard"
        onPress={() => appliance.set(makeAppliance(!appliance().isActive))}
      />
      <Text>{appliance().statusBadge}</Text>
      <HomeSpaceView store={store} />
    </View>
  );
}
mount(Probe);
