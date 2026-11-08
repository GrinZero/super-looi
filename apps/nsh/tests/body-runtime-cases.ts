import {
  BodyRuntime,
  NshNativeBleAdapter,
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
      lightOnReceipt.lightBrightness === 128 &&
      simRuntime.status().lightOn === true &&
      simRuntime.status().lightBrightness === 128,
    "light_on control did not turn fill light on at default brightness 128",
  );

  const lightSetReceipt = await simRuntime.control({
    action: "light_set",
    brightness: 192,
  });
  check(
    lightSetReceipt.status === "verified" &&
      lightSetReceipt.lightOn === true &&
      lightSetReceipt.lightBrightness === 192 &&
      simRuntime.status().lightBrightness === 192,
    "light_set did not apply custom brightness 192",
  );

  const lightZeroReceipt = await simRuntime.control({
    action: "light_set",
    brightness: 0,
  });
  check(
    lightZeroReceipt.status === "verified" &&
      lightZeroReceipt.lightOn === false &&
      lightZeroReceipt.lightBrightness === 0 &&
      simRuntime.status().lightOn === false,
    "light_set(0) did not turn fill light off",
  );

  const simPowerStatus = await simRuntime.readPowerStatus();
  check(
    simPowerStatus.powerStatus?.batteryPercent === 100 &&
      simPowerStatus.powerStatus?.externalPower === true,
    "simulation readPowerStatus did not report 100% external power while docked",
  );

  const moveReceipt = await simRuntime.control({
    action: "forward",
    durationMs: 80,
  });
  check(moveReceipt.status === "verified", "forward failed while docked");

  const vectorPulseReceipt = await simRuntime.control({
    action: "move",
    speed: 84,
    turn: -42,
    durationMs: 70,
  });
  check(
    vectorPulseReceipt.status === "verified" &&
      vectorPulseReceipt.speed === 84 &&
      vectorPulseReceipt.turn === -42,
    "2D move pulse failed while docked",
  );

  const diagSnap1 = await simRuntime.setDriveVector(90, 45);
  check(
    diagSnap1.supervisorState === "observing" &&
      diagSnap1.motion.speed === 90 &&
      diagSnap1.motion.turn === 45,
    "setDriveVector did not start continuous 2D motion",
  );
  const diagSnap2 = await simRuntime.setDriveVector(-60, -80);
  check(
    diagSnap2.supervisorState === "observing" &&
      diagSnap2.motion.speed === -60 &&
      diagSnap2.motion.turn === -80,
    "setDriveVector did not smoothly update held 2D motion vector",
  );
  await simRuntime.stop();
  check(
    simRuntime.status().supervisorState === "ready" &&
      simRuntime.status().motion.speed === 0 &&
      simRuntime.status().motion.turn === 0,
    "setDriveVector did not clear motion and return to ready on stop",
  );

  // Concurrent stop() + immediate re-drag setDriveVector() must serialize without throwing 'stopping'
  await simRuntime.setDriveVector(70, 20);
  const inFlightStop = simRuntime.stop();
  const redragSnap = await simRuntime.setDriveVector(55, -35);
  await inFlightStop;
  check(
    redragSnap.supervisorState === "observing" &&
      redragSnap.motion.speed === 55 &&
      redragSnap.motion.turn === -35,
    "immediate setDriveVector after stop() raced on transient stopping state",
  );
  await simRuntime.stop();

  await simRuntime.startDrive("forward");
  check(simRuntime.status().supervisorState === "observing", "held drive did not start");
  simRuntime.renewDrive();
  await simRuntime.stop();
  check(simRuntime.status().supervisorState === "ready", "held drive did not stop on release");
  check(simRuntime.renewDrive() === false, "stopped drive still accepted a heartbeat");

  const undockedStatus = simRuntime.setSimulatedDock(false);
  const undockedPowerSnap = await simRuntime.readPowerStatus();
  check(
    !undockedStatus.isDocked &&
      undockedPowerSnap.powerStatus?.externalPower === false,
    "setSimulatedDock(false) did not undock and clear external power",
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
  await simRuntime.disconnect();
  let disconnectedDriveErr = "";
  try {
    await simRuntime.setDriveVector(40, 10);
  } catch (err) {
    disconnectedDriveErr = err instanceof Error ? err.message : String(err);
  }
  check(
    disconnectedDriveErr === "@looi:body_not_connected",
    `expected normalized @looi:body_not_connected on disconnected setDriveVector, got: ${disconnectedDriveErr}`,
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
    read: (characteristic: string) => {
      nativeEvents.push({ kind: "read_result", characteristic, payload: "4c01" });
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

  const readEvents = [{ kind: "connected", characteristic: "", payload: "" }];
  const readAdapter = new NshNativeBleAdapter({
    ...mockNativeBle,
    status: () => ({ state: "connected", permission: "granted", deviceId: "ble-dock-99", deviceName: "LOOI-Robot-99", error: "" }),
    read: (characteristic) => { readEvents.push({ kind: "read_result", characteristic, payload: "4c01" }); },
    drainEvents: () => readEvents.splice(0, readEvents.length),
  });
  check(await readAdapter.readCharacteristic("power") === "4c01", "FED8 native read result did not reach the adapter");
  readAdapter.dispose();

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
      writtenCharacteristics.some((w) => w.hexPayload === "007f"),
    "real_ble turn_left did not write pure turn command",
  );
  check(
    writtenCharacteristics.some((w) => w.hexPayload === "0000"),
    "real_ble pulse did not auto-stop after duration",
  );

  const bleVectorReceipt = await bleRuntime.control({
    action: "move",
    speed: 80,
    turn: -40,
    durationMs: 70,
  });
  check(
    bleVectorReceipt.status === "verified" &&
      writtenCharacteristics.some((w) => w.hexPayload === "50d8"),
    "real_ble 2D move did not encode signed (80, -40) as 50d8",
  );

  const bleBrightnessReceipt = await bleRuntime.control({
    action: "light_set",
    brightness: 200,
  });
  check(
    bleBrightnessReceipt.status === "verified" &&
      bleBrightnessReceipt.lightBrightness === 200 &&
      writtenCharacteristics.some(
        (w) => w.characteristic === "light" && w.hexPayload === "c8",
      ),
    "real_ble light_set(200) did not write c8 to FED2",
  );

  const [powerReadA, powerReadB] = await Promise.all([
    bleRuntime.readPowerStatus(),
    bleRuntime.control({ action: "read_power" }),
  ]);
  check(
    powerReadA.powerStatus?.batteryPercent === 76 &&
      powerReadA.powerStatus?.externalPower === true &&
      powerReadB.status === "verified" &&
      powerReadB.powerStatus?.batteryPercent === 76,
    "real_ble concurrent power reads did not coalesce and parse 4c01 (76% + externalPower)",
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
    controlBody: async (action, durationMs, extra) => {
      if (action === "stop") stopBodyCalls++;
      return await voiceBody.control(
        {
          action: action as any,
          durationMs,
          ...(extra?.headDegrees !== undefined ? { headDegrees: extra.headDegrees } : {}),
          ...(extra?.brightness !== undefined ? { brightness: extra.brightness } : {}),
          ...(extra?.speed !== undefined ? { speed: extra.speed } : {}),
          ...(extra?.turn !== undefined ? { turn: extra.turn } : {}),
        },
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

  pushVoiceEvent({
    type: "response.function_call_arguments.done",
    call_id: "body_call_2",
    name: "control_looi_body",
    arguments: JSON.stringify({ action: "light_set", brightness: "204" }),
  });
  await settle(100);
  check(
    voiceBody.status().lightOn === true &&
      voiceBody.status().lightBrightness === 204 &&
      writes.some(
        (item) =>
          item.type === "conversation.item.create" &&
          item.items?.[0]?.call_id === "body_call_2",
      ),
    "voice control_looi_body light_set did not update brightness to 204",
  );

  pushVoiceEvent({
    type: "response.function_call_arguments.done",
    call_id: "body_call_3",
    name: "control_looi_body",
    arguments: JSON.stringify({
      action: "move",
      speed: "64",
      turn: "-32",
      duration_ms: "60",
    }),
  });
  await settle(160);
  check(
    writes.some(
      (item) =>
        item.type === "conversation.item.create" &&
        item.items?.[0]?.call_id === "body_call_3",
    ),
    "voice control_looi_body 2D move did not return verified tool output",
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
