import {
  BodyRuntime,
  type NativeBlePort,
} from "../runtime/body.js";
import {
  VoiceRuntime,
  type VoiceAudioPort,
  type VoiceSocket,
} from "../runtime/voice.js";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const settle = (ms = 30) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function verifyBodyRuntime() {
  const slots = new Map<string, string>();
  const vault = {
    get: (key: string) => slots.get(key) ?? "",
    set: (key: string, value: string) => {
      slots.set(key, value);
    },
    remove: (key: string) => {
      slots.delete(key);
    },
  };

  // 1. Simulation mode lifecycle & controls
  const simRuntime = new BodyRuntime({ vault });
  await simRuntime.configure({
    mode: "simulation",
    autoConnect: true,
    savedDeviceId: "",
  });

  const scanned = await simRuntime.scan(20);
  check(
    scanned.candidates.length >= 2 &&
      scanned.candidates.some((item) => item.id === "sim-looi-dock-01"),
    "simulation scan did not return virtual LOOI docks",
  );

  const connectedStatus = await simRuntime.connect({
    deviceId: "sim-looi-bedroom-02",
    deviceName: "卧室的 LOOI",
  });
  check(
    connectedStatus.connected &&
      connectedStatus.isDocked &&
      connectedStatus.deviceId === "sim-looi-bedroom-02" &&
      connectedStatus.deviceName === "卧室的 LOOI",
    "simulation connect did not dock to selected candidate",
  );

  const headUpReceipt = await simRuntime.control({ action: "head_up" });
  check(
    headUpReceipt.status === "verified" &&
      headUpReceipt.headDegrees === 85 &&
      simRuntime.status().headPose === "up" &&
      simRuntime.status().headDegrees === 85,
    "head_up control did not update headPose",
  );

  const customHeadReceipt = await simRuntime.control({ action: "head_set", headDegrees: 41.5 });
  check(
    customHeadReceipt.status === "verified" &&
      customHeadReceipt.headDegrees === 41.5 &&
      simRuntime.status().headPose === "custom",
    "head_set did not retain the requested angle",
  );

  const lightOnReceipt = await simRuntime.control({ action: "light_on" });
  check(
    lightOnReceipt.status === "verified" &&
      lightOnReceipt.lightOn === true &&
      simRuntime.status().lightOn === true,
    "light_on control did not turn fill light on",
  );

  const moveReceipt = await simRuntime.control({
    action: "forward",
    durationMs: 80,
  });
  check(moveReceipt.status === "verified", "forward failed while docked");

  await simRuntime.startDrive("forward");
  check(simRuntime.status().supervisorState === "observing", "held drive did not start");
  simRuntime.renewDrive();
  await simRuntime.stop();
  check(simRuntime.status().supervisorState === "ready", "held drive did not stop on release");
  check(simRuntime.renewDrive() === false, "stopped drive still accepted a heartbeat");

  const undockedStatus = simRuntime.setSimulatedDock(false);
  check(
    !undockedStatus.isDocked,
    "setSimulatedDock(false) did not undock",
  );

  const undockedMove = await simRuntime.control({ action: "forward", durationMs: 80 });
  check(
    undockedMove.status === "verified" && !undockedMove.isDocked,
    "connected undocked body did not allow wheel motion",
  );
  const undockedHead = await simRuntime.control({ action: "head_up" });
  check(undockedHead.status === "verified" && !undockedHead.isDocked,
    "connected undocked body did not allow head control");

  simRuntime.setSimulatedDock(true);
  check(
    simRuntime.status().isDocked,
    "setSimulatedDock(true) did not restore docked state",
  );
  simRuntime.close();

  // 2. Real BLE mode via NativeBlePort mock
  const nativeEvents: Array<{
    kind: string;
    characteristic: string;
    payload: string;
  }> = [];
  const writtenCharacteristics: Array<{
    characteristic: string;
    hexPayload: string;
  }> = [];
  let writesAwaitingAck = 0;
  let maxWritesAwaitingAck = 0;
  let nativeConnectedId = "";
  let pendingConnectId = "";
  let nativePermission = "denied";
  let scanStartedWithPermission = false;
  let scanStartCount = 0;
  const mockNativeBle: NativeBlePort = {
    permission: () => nativePermission,
    requestPermission: () => {
      nativePermission = "undetermined";
      setTimeout(() => { nativePermission = "granted"; }, 20);
      return nativePermission;
    },
    startScan: () => {
      ++scanStartCount;
      scanStartedWithPermission = nativePermission === "granted";
    },
    stopScan: () => {},
    scannedDevices: () => [
      { id: "ble-dock-99", name: "LOOI-Robot-99", rssi: -46 },
      { id: "ble-stuck", name: "LOOI-Stuck", rssi: -62 },
    ],
    connect: (deviceId: string) => {
      if (deviceId === "ble-stuck") {
        pendingConnectId = deviceId;
        return;
      }
      pendingConnectId = "";
      nativeConnectedId = deviceId;
      nativeEvents.push({
        kind: "connected",
        characteristic: "",
        payload: "",
      });
    },
    disconnect: () => {
      pendingConnectId = "";
      if (nativeConnectedId) {
        nativeEvents.push({
          kind: "disconnected",
          characteristic: "",
          payload: "",
        });
        nativeConnectedId = "";
      }
    },
    subscribe: (characteristic: string) => {
      setTimeout(() => {
        if (characteristic === "dockNotify") {
          nativeEvents.push({ kind: "notification", characteristic, payload: "05" });
          nativeEvents.push({ kind: "notification", characteristic, payload: "110100" });
        }
        nativeEvents.push({ kind: "notify_ack", characteristic, payload: "" });
      }, 20);
    },
    write: (characteristic: string, hexPayload: string, withResponse: boolean) => {
      writtenCharacteristics.push({ characteristic, hexPayload });
      if (withResponse) {
        writesAwaitingAck += 1;
        maxWritesAwaitingAck = Math.max(maxWritesAwaitingAck, writesAwaitingAck);
        setTimeout(() => {
          writesAwaitingAck -= 1;
          nativeEvents.push({ kind: "write_ack", characteristic, payload: "" });
        }, 20);
      }
    },
    drainEvents: () => nativeEvents.splice(0, nativeEvents.length),
    status: () => ({
      state: nativeConnectedId ? "connected" : pendingConnectId ? "connecting" : "disconnected",
      permission: "granted",
      deviceId: nativeConnectedId,
      deviceName: nativeConnectedId ? "LOOI-Robot-99" : "",
      error: "",
    }),
  };

  const bleRuntime = new BodyRuntime({
    vault,
    nativePort: mockNativeBle,
  });
  await bleRuntime.configure({
    mode: "real_ble",
    autoConnect: true,
    savedDeviceId: "",
  });
  const bleScanned = await bleRuntime.scan(100);
  check(
    bleScanned.candidates.some((c) => c.id === "ble-dock-99"),
    "real_ble scan did not drain native candidates",
  );
  check(
    !bleScanned.scanning && bleScanned.scanCompleted && scanStartedWithPermission,
    "real_ble scan did not wait for permission and return an idle completed snapshot",
  );
  const bleConnected = await bleRuntime.connect({
    deviceId: "ble-dock-99",
    deviceName: "LOOI-Robot-99",
  });
  check(
    bleConnected.connected &&
      bleConnected.isDocked &&
      !bleConnected.connecting &&
      bleConnected.deviceName === "LOOI-Robot-99" &&
      maxWritesAwaitingAck === 1,
    "real_ble connect did not complete handshake and dock",
  );

  const turnReceipt = await bleRuntime.control({
    action: "turn_left",
    durationMs: 70,
  });
  check(
    turnReceipt.status === "verified" &&
      writtenCharacteristics.some((w) => w.hexPayload === "047a"),
    "real_ble turn_left did not write differential wheel command",
  );
  check(
    writtenCharacteristics.some((w) => w.hexPayload === "0000"),
    "real_ble pulse did not auto-stop after duration",
  );

  // Simulate undock event from hardware (dockNotify = 06)
  nativeEvents.push({
    kind: "notification",
    characteristic: "dockNotify",
    payload: "06",
  });
  await settle(40);
  check(
    !bleRuntime.status().isDocked,
    "dockNotify=06 notification did not transition BodyRuntime to undocked",
  );

  const stuckConnection = bleRuntime.connect({
    deviceId: "ble-stuck",
    deviceName: "LOOI-Stuck",
  });
  await settle(10);
  const nearbyScan = bleRuntime.scan(100);
  check(
    bleRuntime.status().connecting && bleRuntime.status().scanning,
    "scanning could not start while a dock connection was pending",
  );
  const nearbyResult = await nearbyScan;
  check(
    nearbyResult.candidates.some((c) => c.id === "ble-dock-99"),
    "concurrent scan did not find a replacement dock",
  );
  const replacement = await bleRuntime.connect({
    deviceId: "ble-dock-99",
    deviceName: "LOOI-Robot-99",
  });
  await stuckConnection;
  check(
    replacement.connected &&
      replacement.deviceId === "ble-dock-99" &&
      bleRuntime.configuration().savedDeviceId === "ble-dock-99" &&
      !bleRuntime.status().connecting,
    "replacement dock connection was overwritten by the cancelled attempt",
  );

  nativePermission = "denied";
  const scansBeforePermission = scanStartCount;
  const waitingForPermission = bleRuntime.scan(100);
  const connectDuringPermission = bleRuntime.connect({ deviceId: "ble-dock-99" });
  await Promise.all([waitingForPermission, connectDuringPermission]);
  check(
    scanStartCount === scansBeforePermission && bleRuntime.status().connected,
    "cancelled scan started after permission and interrupted the replacement connection",
  );

  const disconnecting = bleRuntime.disconnect();
  const reconnecting = bleRuntime.connect({ deviceId: "ble-dock-99" });
  await Promise.all([disconnecting, reconnecting]);
  check(
    bleRuntime.status().connected &&
      bleRuntime.status().deviceId === "ble-dock-99" &&
      !bleRuntime.status().connecting,
    "late disconnect completion cleared the new dock connection",
  );

  const forgotten = await bleRuntime.forgetSavedDock();
  check(
    !forgotten.connected &&
      forgotten.deviceId === null &&
      forgotten.deviceName === "LOOI 桌面底座" &&
      bleRuntime.configuration().savedDeviceId === "" &&
      JSON.parse(slots.get("body") || "{}").savedDeviceId === "" &&
      !nativeConnectedId,
    "forgetSavedDock did not disconnect and remove the persisted dock",
  );
  const restartedRuntime = new BodyRuntime({ vault });
  restartedRuntime.attachNativeBle(mockNativeBle);
  await settle(40);
  check(
    !restartedRuntime.status().connected && !nativeConnectedId,
    "forgotten dock reconnected on restart",
  );
  restartedRuntime.attachNativeBle(null);
  restartedRuntime.close();
  await bleRuntime.connect({ deviceId: "ble-dock-99", deviceName: "LOOI-Robot-99" });
  check(
    bleRuntime.configuration().savedDeviceId === "ble-dock-99" &&
      bleRuntime.status().connected,
    "dock could not be saved again after reconnecting",
  );

  // Switch bleRuntime (with attached nativePort) to simulation mode and verify no cross-mode state pollution
  await bleRuntime.configure({ mode: "simulation" });
  const simSwitchStatus = await bleRuntime.connect({
    deviceId: "sim-looi-bedroom-02",
    deviceName: "卧室的 LOOI",
  });
  check(
    simSwitchStatus.deviceId === "sim-looi-bedroom-02" &&
      simSwitchStatus.deviceName === "卧室的 LOOI" &&
      bleRuntime.configuration().savedDeviceId === "ble-dock-99",
    "simulation connect polluted real_ble savedDeviceId or read stale nativePort status",
  );

  // 3. VoiceRuntime control_looi_body tool execution
  const voiceBody = new BodyRuntime({ vault });
  await voiceBody.configure({
    mode: "simulation",
    autoConnect: true,
    savedDeviceId: "",
  });

  const writes: Record<string, any>[] = [];
  let reader: ((value: string | null) => void) | undefined;
  const incoming: string[] = [];
  let socketClosed = false;
  const socket: VoiceSocket = {
    read: () =>
      incoming.length
        ? Promise.resolve(incoming.shift()!)
        : socketClosed
          ? Promise.resolve(null)
          : new Promise((resolve) => {
              reader = resolve;
            }),
    write: async (value) => {
      writes.push(JSON.parse(value));
    },
    close: async () => {
      socketClosed = true;
      reader?.(null);
      reader = undefined;
    },
  };
  const pushVoiceEvent = (value: unknown) => {
    const raw = JSON.stringify(value);
    if (reader) {
      const resolve = reader;
      reader = undefined;
      resolve(raw);
    } else incoming.push(raw);
  };
  const audio: VoiceAudioPort = {
    requestPermission: () => "granted",
    start: () => {},
    setCaptureMode: () => {},
    playReadyCue: () => {},
    stop: () => {},
    enqueue: () => {},
    clearPlayback: () => {},
    setMuted: () => {},
    drainCapture: () => [],
    status: () => ({
      state: "running",
      permission: "granted",
      error: "",
      queuedPlaybackMs: 0,
      captureMode: "conversation",
      wakeWord: "",
      kwsReady: true,
    }),
  };

  let stopBodyCalls = 0;
  const voice = new VoiceRuntime({
    vault,
    audio,
    connect: async () => socket,
    onState: () => {},
    requestTask: async () => "",
    cancelTask: () => {},
    controlBody: async (action, durationMs) => {
      if (action === "stop") stopBodyCalls++;
      return await voiceBody.control(
        { action: action as any, durationMs },
        "voice_realtime",
      );
    },
  });
  voice.setWakeEnabled(false);
  voice.configure("TEST_ONLY_VOICE");
  await voice.start();

  const sessionTools = writes[0]?.session?.tools ?? [];
  check(
    sessionTools.some((t: any) => t.name === "control_looi_body"),
    "control_looi_body schema missing from voice session tools",
  );
  pushVoiceEvent({ type: "session.created" });
  await settle();

  pushVoiceEvent({
    type: "response.function_call_arguments.done",
    call_id: "body_call_1",
    name: "control_looi_body",
    arguments: JSON.stringify({ action: "head_down" }),
  });
  await settle(40);
  check(
    voiceBody.status().headPose === "down" &&
      writes.some(
        (item) =>
          item.type === "conversation.item.create" &&
          item.items?.[0]?.call_id === "body_call_1",
      ),
    "voice control_looi_body tool call did not update head pose and return tool output",
  );

  voice.interrupt("server_vad");
  await settle(20);
  check(
    stopBodyCalls === 1,
    "voice.interrupt('server_vad') did not trigger controlBody('stop')",
  );

  voice.close();
  bleRuntime.close();
  voiceBody.close();
}
