import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BodySupervisor,
  MOVE_PAYLOADS,
  HEAD_PAYLOADS,
  headDegreesToPayload,
  createInitTimeHex,
  SimulatedBleTransport,
  CrossPlatformBleTransport,
  type NativeBleAdapter,
  type CharacteristicKey,
} from "../src/index.js";
import {
  createSelfEventWindow,
  type BodyStopRequest,
  type SelfEventWindow,
} from "@super-looi/contracts";

describe("BodySupervisor and LOOI Protocol Driver (Phase 1)", () => {
  it("does not report a connection when stopped before any dock connects", async () => {
    const transport = new SimulatedBleTransport();
    const supervisor = new BodySupervisor(transport);

    await supervisor.stop();
    assert.equal(supervisor.getState(), "disconnected");

    await supervisor.connect();
    assert.equal(supervisor.getState(), "connected_unarmed");
    await supervisor.disconnect();
    await supervisor.stop();
    assert.equal(supervisor.getState(), "disconnected");

    await supervisor.connect();
    transport.emitNotification("dockNotify", "05");
    transport.connected = false;
    await supervisor.stop();
    assert.equal(supervisor.getState(), "disconnected");
    assert.equal(supervisor.getIsDocked(), false);
    await supervisor.connect();
    assert.equal(supervisor.getState(), "connected_unarmed");
  });

  it("rebinds unexpected-disconnect safety after an explicit reconnect", async () => {
    const transport = new SimulatedBleTransport();
    const supervisor = new BodySupervisor(transport);
    await supervisor.connect();
    transport.emitNotification("dockNotify", "05");
    await supervisor.disconnect();
    await supervisor.connect();
    transport.emitNotification("dockNotify", "05");
    assert.equal(supervisor.getState(), "ready");
    transport.emitUnexpectedDisconnect();
    assert.equal(supervisor.getState(), "disconnected");
    assert.equal(supervisor.getIsDocked(), false);
    assert.equal(supervisor.getActiveLease(), null);
  });

  it("cleans up late native subscriptions and ignores their callbacks after reconnect", async () => {
    let connected = true, removed = 0, received = 0;
    let emit!: (value: string) => void;
    let finish!: (unsubscribe: () => void) => void;
    const adapter: NativeBleAdapter = {
      scanAndConnect: async () => { connected = true; },
      disconnect: async () => { connected = false; },
      isConnected: () => connected,
      writeCharacteristicWithResponse: async () => {},
      writeCharacteristicWithoutResponse: async () => {},
      monitorCharacteristic: async (_, listener) => { emit = listener; return new Promise(resolve => { finish = resolve; }); },
      onDisconnected: () => () => {},
    };
    const transport = new CrossPlatformBleTransport(adapter);
    const registering = transport.startNotifications("dockNotify", () => { received++; });
    await transport.disconnect();
    await transport.connect();
    finish(() => { removed++; });
    await registering;
    emit("05");
    assert.equal(removed, 1);
    assert.equal(received, 0);
    transport.dispose();
    await assert.rejects(() => transport.connect(), /disposed/);
    await assert.rejects(() => transport.write("drive", "0000"), /disconnected/);
    assert.equal(transport.isConnected(), false);
  });

  it("invalidates failed registrations and rejects subscriptions throughout disconnect", async () => {
    let connected = true, received = 0;
    let emit!: (value: string) => void, finishDisconnect!: () => void;
    const adapter: NativeBleAdapter = {
      scanAndConnect: async () => { connected = true; },
      disconnect: async () => { await new Promise<void>(resolve => { finishDisconnect = resolve; }); connected = false; },
      isConnected: () => connected,
      writeCharacteristicWithResponse: async () => {},
      writeCharacteristicWithoutResponse: async () => {},
      monitorCharacteristic: async (_, listener) => { emit = listener; throw new Error("registration failed"); },
      onDisconnected: () => () => {},
    };
    const transport = new CrossPlatformBleTransport(adapter);
    await assert.rejects(() => transport.startNotifications("dockNotify", () => { received++; }), /registration failed/);
    emit("05"); assert.equal(received, 0);
    const disconnecting = transport.disconnect();
    await assert.rejects(() => transport.startNotifications("dockNotify", () => { received++; }), /disconnected/);
    await assert.rejects(() => transport.write("drive", "1100"), /disconnected/);
    finishDisconnect(); await disconnecting;
    await transport.connect(); emit("05"); assert.equal(received, 0);
    transport.dispose();
  });

  it("invalidates late connects on unexpected loss and coalesces concurrent disconnects", async () => {
    let connected=false, disconnectCalls=0;
    let lost!:()=>void, finishConnect!:()=>void, finishDisconnect!:()=>void;
    const adapter:NativeBleAdapter={
      scanAndConnect:async()=>{await new Promise<void>(resolve=>{finishConnect=resolve;});connected=true;},
      disconnect:async()=>{disconnectCalls++;connected=false;},isConnected:()=>connected,
      writeCharacteristicWithResponse:async()=>{},writeCharacteristicWithoutResponse:async()=>{},
      monitorCharacteristic:async()=>()=>{},onDisconnected:listener=>{lost=listener;return()=>{};},
    };
    const transport=new CrossPlatformBleTransport(adapter);
    const opening=transport.connect();lost();finishConnect();
    await assert.rejects(()=>opening,/cancelled/);
    assert.equal(transport.isConnected(),false);
    transport.dispose();
    const other=new CrossPlatformBleTransport({...adapter,scanAndConnect:async()=>{connected=true;},disconnect:async()=>{disconnectCalls++;await new Promise<void>(resolve=>{finishDisconnect=resolve;});connected=false;}});
    await other.connect();
    const before=disconnectCalls;
    const first=other.disconnect(),second=other.disconnect();
    await assert.rejects(()=>other.connect(),/transition/);
    assert.equal(disconnectCalls,before+1);
    finishDisconnect();await Promise.all([first,second]);other.dispose();
    let attempts=0;
    const throwing = new CrossPlatformBleTransport({...adapter,disconnect:()=>{if(++attempts===1)throw new Error("sync native refusal");return Promise.resolve();}});
    await assert.rejects(()=>throwing.disconnect(), /sync native refusal/);
    await throwing.disconnect();assert.equal(attempts,2);throwing.dispose();
  });
  it("subscribes to FED9 before the device-tested three writes and neutral drive", async () => {
    const transport = new SimulatedBleTransport();
    const operations: string[] = [];
    const write = transport.write.bind(transport);
    transport.write = async (...args) => {
      operations.push(`write:${args[0]}:${args[1]}`);
      await write(...args);
    };
    const startNotifications = transport.startNotifications.bind(transport);
    transport.startNotifications = async (...args) => {
      operations.push(`notify:${args[0]}`);
      await startNotifications(...args);
    };
    const supervisor = new BodySupervisor(transport);

    const initDate = new Date("2026-06-24T00:55:42Z");
    const timeHex = createInitTimeHex(initDate);
    await supervisor.connect(initDate);

    assert.equal(transport.connected, true);
    assert.equal(transport.notificationListeners.has("dockNotify"), true);
    assert.deepEqual(operations, [
      "notify:dockNotify",
      "write:handshakeControl:03",
      `write:handshakeData:${timeHex}`,
      "write:handshakeControl:8101",
      "write:drive:0000",
    ]);

    assert.equal(transport.writtenCommands.length, 4);
    assert.deepEqual(transport.writtenCommands[0], {
      characteristic: "handshakeControl",
      payload: "03",
      options: { response: true, expectedBytes: 1 },
    });
    assert.deepEqual(transport.writtenCommands[1], {
      characteristic: "handshakeData",
      payload: timeHex,
      options: { response: true, expectedBytes: 20 },
    });
    assert.deepEqual(transport.writtenCommands[2], {
      characteristic: "handshakeControl",
      payload: "8101",
      options: { response: true, expectedBytes: 2 },
    });
    assert.deepEqual(transport.writtenCommands[3], {
      characteristic: "drive",
      payload: "0000",
      options: { response: false, expectedBytes: 2 },
    });

    // Unarmed because not yet docked
    assert.equal(supervisor.getState(), "connected_unarmed");
    assert.equal(supervisor.getIsDocked(), false);
  });

  it("does not accept body actions before activation completes", async () => {
    const transport = new SimulatedBleTransport();
    const write = transport.write.bind(transport);
    let releaseHandshake!: () => void;
    transport.write = async (...args) => {
      if (args[0] === "handshakeData") {
        await new Promise<void>((resolve) => { releaseHandshake = resolve; });
      }
      await write(...args);
    };
    const supervisor = new BodySupervisor(transport);
    const connecting = supervisor.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await assert.rejects(() => supervisor.acquireLease({ holder: "wheel", primitive: "forward", durationMs: 100 }), /activation/);
    await assert.rejects(() => supervisor.setHead("up"), /activation/);
    await assert.rejects(() => supervisor.setLight(true), /activation/);
    releaseHandshake();
    await connecting;
    assert.deepEqual(transport.writtenCommands.map(({ characteristic, payload }) => characteristic), [
      "handshakeControl", "handshakeData", "handshakeControl", "drive",
    ]);
  });

  it("retries handshake upon transient GATT errors and succeeds", async () => {
    const transport = new SimulatedBleTransport();
    const supervisor = new BodySupervisor(transport);

    // Simulate 1 transient write failure
    transport.simulateGattErrorNext(1);

    await supervisor.connect(new Date(), 2);
    assert.equal(supervisor.getState(), "connected_unarmed");
    assert.equal(transport.connected, true);
  });

  it("transitions to fault when handshake exceeds max retries", async () => {
    const transport = new SimulatedBleTransport();
    const supervisor = new BodySupervisor(transport);

    // Simulate 5 consecutive failures
    transport.simulateGattErrorNext(5);

    await assert.rejects(
      async () => {
        await supervisor.connect(new Date(), 1);
      },
      /Simulated transient GATT write failure/
    );

    assert.equal(supervisor.getState(), "fault");
  });

  it("handles unexpected BLE disconnect by revoking leases and transitioning to disconnected", async () => {
    const transport = new SimulatedBleTransport();
    const supervisor = new BodySupervisor(transport);

    await supervisor.connect();
    transport.emitNotification("dockNotify", "05");

    await supervisor.acquireLease({ holder: "worker_bg", primitive: "forward", durationMs: 1000 });
    assert.ok(supervisor.getActiveLease());

    // Unexpected disconnect fired by native layer
    transport.emitUnexpectedDisconnect();

    assert.equal(supervisor.getState(), "disconnected");
    assert.equal(supervisor.getActiveLease(), null);
    assert.equal(supervisor.getIsDocked(), false);
  });

  it("allows movement after connection without requiring the phone to be docked", async () => {
    const transport = new SimulatedBleTransport();
    const supervisor = new BodySupervisor(transport);
    await supervisor.connect();

    const lease = await supervisor.acquireLease({ holder: "test", primitive: "forward", durationMs: 500 });
    await supervisor.executePrimitive(lease);
    assert.equal(transport.writtenCommands.at(-1)?.payload, MOVE_PAYLOADS.forward);
    await supervisor.stop();
    assert.equal(supervisor.getState(), "connected_unarmed");

    transport.emitNotification("dockNotify", "05");
    assert.equal(supervisor.getIsDocked(), true);
    assert.equal(supervisor.getState(), "ready");
  });

  it("keeps one drive command active while its lease is renewed", async () => {
    const transport = new SimulatedBleTransport();
    const supervisor = new BodySupervisor(transport);
    await supervisor.connect();

    const lease = await supervisor.acquireLease({ holder: "wheel", primitive: "forward", durationMs: 60 });
    await supervisor.executePrimitive(lease);
    supervisor.renewLease(lease, 400);
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(supervisor.getState(), "observing");
    assert.ok(transport.writtenCommands.filter((command) => command.characteristic === "drive" && command.payload === MOVE_PAYLOADS.forward).length >= 3);
    await supervisor.stop();
    assert.equal(transport.writtenCommands.at(-1)?.payload, MOVE_PAYLOADS.stop);
    const stoppedAt = transport.writtenCommands.length;
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.ok(transport.writtenCommands.slice(stoppedAt).every((command) => command.payload === MOVE_PAYLOADS.stop));
  });

  it("enforces single active lease mutex", async () => {
    const transport = new SimulatedBleTransport();
    const supervisor = new BodySupervisor(transport);
    await supervisor.connect();
    transport.emitNotification("dockNotify", "05");

    const lease1 = await supervisor.acquireLease({ holder: "worker_1", primitive: "turn_left", durationMs: 1000 });
    assert.ok(lease1);
    assert.equal(supervisor.getState(), "observing");

    await assert.rejects(
      async () => {
        await supervisor.acquireLease({ holder: "worker_2", primitive: "turn_right", durationMs: 500 });
      },
      /lease mutex held by 'worker_1'/
    );

    await supervisor.stop("user_stop");
    assert.equal(supervisor.getActiveLease(), null);
    assert.equal(supervisor.getState(), "ready");
  });

  it("executes bounded pulse without inventing physical stability evidence", async () => {
    const transport = new SimulatedBleTransport();
    const supervisor = new BodySupervisor(transport);
    await supervisor.connect();
    transport.emitNotification("dockNotify", "05");

    const pulsePromise = supervisor.executePulse(
      { holder: "camera_scout", primitive: "turn_right", durationMs: 50 },
      20 // settling delay
    );

    const observation = await pulsePromise;
    assert.ok(observation.stop_command_at);
    assert.equal(observation.verified_motion_end_at, null);
    assert.equal(observation.stable_capture_at, null);
    assert.deepEqual(observation.stability_evidence_ids, []);

    // Stop command payload (0000) must have been written
    const lastCommand = transport.writtenCommands[transport.writtenCommands.length - 1];
    assert.equal(lastCommand.characteristic, "drive");
    assert.equal(lastCommand.payload, MOVE_PAYLOADS.stop);
    assert.equal(supervisor.getActiveLease(), null);
  });

  it("preempts in-flight executePulse immediately when undocked", async () => {
    const transport = new SimulatedBleTransport();
    const supervisor = new BodySupervisor(transport);
    await supervisor.connect();
    transport.emitNotification("dockNotify", "05");

    const pulsePromise = supervisor.executePulse(
      { holder: "long_pulse", primitive: "forward", durationMs: 500 },
      100
    );

    // Sudden undock 30ms later
    setTimeout(() => {
      transport.emitNotification("dockNotify", "06");
    }, 30);

    await assert.rejects(
      async () => {
        await pulsePromise;
      },
      /Pulse preempted by stop: undocked/
    );

    assert.equal(supervisor.getIsDocked(), false);
    assert.equal(supervisor.getState(), "connected_unarmed");
    assert.equal(supervisor.getActiveLease(), null);

    const nextPulse = await supervisor.executePulse(
      { holder: "after_undock", primitive: "forward", durationMs: 50 },
      0,
    );
    assert.ok(nextPulse.stop_command_at);
    assert.equal(supervisor.getState(), "connected_unarmed");
  });

  it("tracks sensor suppression window during motion and accepts external TTS windows", async () => {
    const transport = new SimulatedBleTransport();
    const supervisor = new BodySupervisor(transport);
    await supervisor.connect();
    transport.emitNotification("dockNotify", "05");

    assert.equal(supervisor.isSensorSuppressed("camera"), false);
    assert.equal(supervisor.isSensorSuppressed("microphone"), false);

    // Execute primitive -> suppresses sensors
    const lease = await supervisor.acquireLease({ holder: "look_task", primitive: "head_up", durationMs: 150 });
    await supervisor.executePrimitive(lease);

    assert.equal(supervisor.isSensorSuppressed("camera"), true);
    assert.equal(supervisor.isSensorSuppressed("microphone"), true);
    assert.equal(supervisor.isSensorSuppressed("imu"), true);

    // Check after settling expires
    const farFutureMs = Date.now() + 10_000;
    assert.equal(supervisor.isSensorSuppressed("camera", farFutureMs), false);

    // Record external TTS window
    const ttsWindow = createSelfEventWindow("tts_playback", 300, ["microphone"]);
    supervisor.recordExternalSelfEvent(ttsWindow);

    assert.equal(supervisor.isSensorSuppressed("microphone"), true);
    assert.equal(supervisor.isSensorSuppressed("camera", farFutureMs), false);

    await supervisor.stop();
  });

  it("integrates with CrossPlatformBleTransport wrapping native BLE adapter", async () => {
    const written: Array<{ charKey: CharacteristicKey; hex: string; withResponse: boolean }> = [];
    let isConnected = false;
    let disconnectCb: (() => void) | null = null;

    const mockNativeAdapter: NativeBleAdapter = {
      scanAndConnect: async () => {
        isConnected = true;
      },
      disconnect: async () => {
        isConnected = false;
        disconnectCb?.();
      },
      isConnected: () => isConnected,
      writeCharacteristicWithResponse: async (charKey, hexPayload) => {
        written.push({ charKey, hex: hexPayload, withResponse: true });
      },
      writeCharacteristicWithoutResponse: async (charKey, hexPayload) => {
        written.push({ charKey, hex: hexPayload, withResponse: false });
      },
      monitorCharacteristic: async (charKey, onData) => {
        return () => {};
      },
      onDisconnected: (callback) => {
        disconnectCb = callback;
        return () => {
          disconnectCb = null;
        };
      },
    };

    const transport = new CrossPlatformBleTransport(mockNativeAdapter);
    assert.equal(transport.isConnected(), false);

    await transport.connect();
    assert.equal(transport.isConnected(), true);

    await transport.write("drive", MOVE_PAYLOADS.forward, { response: false });
    assert.equal(written.length, 1);
    assert.equal(written[0].withResponse, false);

    await transport.disconnect();
    assert.equal(transport.isConnected(), false);
    transport.dispose();
  });

  it("safe disconnect: always sends 0000 stop before closing BLE transport", async () => {
    const transport = new SimulatedBleTransport();
    const supervisor = new BodySupervisor(transport);

    await supervisor.connect();
    transport.emitNotification("dockNotify", "05");

    transport.writtenCommands = [];
    await supervisor.disconnect();

    assert.equal(transport.writtenCommands.length, 1);
    assert.equal(transport.writtenCommands[0].characteristic, "drive");
    assert.equal(transport.writtenCommands[0].payload, MOVE_PAYLOADS.stop);
    assert.equal(transport.connected, false);
    assert.equal(supervisor.getState(), "disconnected");
  });

  it("supports candidate scanning, target connection, setHead, setLight, and getSnapshot", async () => {
    const transport = new SimulatedBleTransport();
    const supervisor = new BodySupervisor(transport);

    const candidates = await transport.scanCandidates();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].name, "LOOI 桌面底座");

    await supervisor.connect(new Date("2026-11-08T14:00:00Z"), 2, {
      deviceId: "looi-bedroom-01",
      deviceName: "卧室的 LOOI",
    });
    assert.deepEqual(transport.connectedTarget, {
      deviceId: "looi-bedroom-01",
      deviceName: "卧室的 LOOI",
    });

    // Both light and head controls work after connection, before docking.
    await supervisor.setLight(true);
    assert.equal(supervisor.getLightOn(), true);
    await supervisor.setHead("up");
    assert.equal(supervisor.getHeadPose(), "up");

    transport.simulateDock(true);
    assert.equal(supervisor.getState(), "ready");

    await supervisor.setHead("up");
    const snap = supervisor.getSnapshot();
    assert.equal(snap.state, "ready");
    assert.equal(snap.isDocked, true);
    assert.equal(snap.lightOn, true);
    assert.equal(snap.headPose, "up");
    assert.equal(snap.headDegrees, 85);
    assert.ok(snap.lastVerifiedAt);

    await supervisor.setHead("down");
    assert.equal(supervisor.getHeadPose(), "down");
    assert.equal(supervisor.getHeadDegrees(), 25);
    assert.equal(transport.writtenCommands.at(-1)?.payload, HEAD_PAYLOADS.down);

    assert.equal(headDegreesToPayload(85), HEAD_PAYLOADS.up);
    assert.equal(headDegreesToPayload(55), HEAD_PAYLOADS.center);
    assert.equal(headDegreesToPayload(25), HEAD_PAYLOADS.down);
    assert.notEqual(headDegreesToPayload(41), headDegreesToPayload(41.5));
    await supervisor.setHeadDegrees(41.5);
    assert.equal(supervisor.getHeadPose(), "custom");
    assert.equal(supervisor.getHeadDegrees(), 41.5);
    assert.equal(transport.writtenCommands.at(-1)?.payload, headDegreesToPayload(41.5));
  });
});
