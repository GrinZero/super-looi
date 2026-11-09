import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMiotCameraSession,
  discoverMiotCamera,
  MiotActionRequestError,
  parseMiotSpec,
  type MiotActionCall,
  type MiotActionResult,
  type MiotPropertyRef,
} from "../src/index.js";
import { cameraRawSpec, cameraUrn } from "./camera-fixture.js";
const capability = () =>
  discoverMiotCamera(
    {
      did: "camera-a",
      name: "Camera",
      model: "isa.camera.hlc7",
      urn: cameraUrn,
      online: true,
    },
    parseMiotSpec(cameraRawSpec, cameraUrn),
  )!;
const result = (action: MiotActionCall, code = 0, out: unknown[] = []) =>
  ({ ...action, code, out }) as MiotActionResult;
const state = (refs: MiotPropertyRef[]) =>
  refs.map((ref) => ({ ...ref, code: 0, value: ref.siid === 2 ? true : 1 }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("camera capability follows actual spec action IDs, input enum and output position", () => {
  const spec = parseMiotSpec(cameraRawSpec, cameraUrn);
  const service = spec.services.find((service) => service.siid === 9)!;
  service.siid = 17;
  service.properties.forEach((property) => (property.siid = 17));
  service.actions!.forEach((action) => (action.siid = 17));
  service.properties.find(
    (property) => property.name === "video-attribute",
  )!.valueList = [{ value: 3, description: "profile" }];
  service.actions![0]!.aiid = 4;
  service.actions![0]!.out = [2, 5];
  const cap = discoverMiotCamera(
    {
      did: "camera-a",
      name: "Camera",
      model: "isa.camera.hlc7",
      urn: cameraUrn,
      online: true,
    },
    spec,
  )!;
  assert.equal(cap.kind, "hls");
  assert.deepEqual(cap.hls?.start, {
    did: "camera-a",
    siid: 17,
    aiid: 4,
    in: [3],
  });
  assert.equal(cap.hls?.addressIndex, 1);
});

test("leaving while properties are pending prevents any start action", async () => {
  const held = deferred<ReturnType<typeof state>>();
  const actions: MiotActionCall[] = [];
  const session = createMiotCameraSession({
    capability: capability(),
    client: {
      getProperties: () => held.promise,
      callAction: async (action) => {
        actions.push(action);
        return result(action);
      },
    },
  });
  const rejected = assert.rejects(session.ready, /cancelled/);
  const closing = session.close();
  held.resolve(
    state([
      { did: "camera-a", siid: 2, piid: 1 },
      { did: "camera-a", siid: 9, piid: 9 },
    ]),
  );
  await rejected;
  await closing;
  assert.equal(actions.length, 0);
});

test("a late accepted start is stopped once and never exposes its URL after close", async () => {
  const held = deferred<MiotActionResult>();
  const entered = deferred<void>();
  const actions: MiotActionCall[] = [];
  const session = createMiotCameraSession({
    capability: capability(),
    client: {
      getProperties: async (refs) => state(refs),
      callAction: async (action) => {
        actions.push(action);
        if (action.aiid === 1) {
          entered.resolve();
          return held.promise;
        }
        return result(action);
      },
    },
  });
  await entered.promise;
  const rejected = assert.rejects(session.ready, /cancelled/);
  const closing = session.close();
  held.resolve(
    result(capability().hls!.start, 0, ["https://camera.invalid/live.m3u8"]),
  );
  await rejected;
  await closing;
  await session.close();
  assert.deepEqual(
    actions.map((action) => action.aiid),
    [1, 2],
  );
});

test("unknown dispatched start outcomes get one cleanup, while explicit rejection and busy state do not", async () => {
  for (const outcome of ["network", "rejected", "api-rejected", "busy"]) {
    const actions: MiotActionCall[] = [];
    const session = createMiotCameraSession({
      capability: capability(),
      client: {
        getProperties: async (refs) =>
          state(refs).map((item) => ({
            ...item,
            value: item.siid === 9 && outcome === "busy" ? 2 : item.value,
          })),
        callAction: async (action) => {
          actions.push(action);
          if (action.aiid === 1) {
            if (outcome === "network") throw new Error("miot_request_failed");
            if (outcome === "api-rejected")
              throw new MiotActionRequestError(-3);
            return result(action, -42);
          }
          return result(action);
        },
      },
    });
    await assert.rejects(session.ready, /miot_camera_/);
    await session.close();
    assert.deepEqual(
      actions.map((action) => action.aiid),
      outcome === "network" ? [1, 2] : outcome === "busy" ? [] : [1],
      outcome,
    );
  }
});

test("property read errors use the discovered configuration action and never infer power off", async () => {
  const actions: MiotActionCall[] = [];
  const session = createMiotCameraSession({
    capability: capability(),
    client: {
      getProperties: async (refs) =>
        refs.map((ref) => ({ ...ref, code: -704042011 })),
      callAction: async (action) => {
        actions.push(action);
        return result(
          action,
          0,
          action.aiid === 3
            ? [1]
            : action.aiid === 1
              ? ["https://camera.invalid/live.m3u8"]
              : [],
        );
      },
    },
  });
  assert.equal((await session.ready).url, "https://camera.invalid/live.m3u8");
  await session.close();
  assert.deepEqual(
    actions.map((action) => [action.siid, action.aiid]),
    [
      [9, 3],
      [9, 1],
      [9, 2],
    ],
  );
});
