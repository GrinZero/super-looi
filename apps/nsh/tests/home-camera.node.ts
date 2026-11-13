import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeRuntime } from "../runtime/home.js";
import {
  createMiotCredentials,
  MIOT_CLIENT_ID,
} from "@super-looi/home-assistant";
import {
  cameraRawSpec,
  cameraUrn,
} from "../../../packages/home-assistant/test/camera-fixture.js";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
async function fixture() {
  const callbackId = "00000000-0000-0000-0000-000000000001";
  const scope = {
    region: "cn" as const,
    clientId: MIOT_CLIENT_ID,
    redirectUri: `http://homeassistant.local:8123/api/webhook/${callbackId}`,
  };
  const credentials = createMiotCredentials(
    scope,
    "ha.test-device",
    {
      accessToken: "ORIGINAL_ACCOUNT_TOKEN",
      refreshToken: "TEST_REFRESH",
      expiresIn: 7200,
    },
    Date.now(),
  );
  let raw = JSON.stringify({
    version: 1,
    config: { mode: "direct_miot", region: "cn", haUrl: "", callbackId },
    credentials: {
      [`super-looi.miot.cn.${MIOT_CLIENT_ID}.${encodeURIComponent(scope.redirectUri)}`]:
        JSON.stringify(credentials),
    },
  });
  const entered = deferred<void>(),
    released = deferred<void>();
  const actions: Array<{ siid: number; aiid: number; authorization: string }> =
    [];
  const runtime = new HomeRuntime({
    vault: {
      get: () => raw,
      set: (_key, value) => {
        raw = value;
      },
      remove() {},
    },
    fetch: async (input, init) => {
      const url = String(input);
      let value: any;
      if (url.includes("miot-spec.org")) value = cameraRawSpec;
      else if (url.endsWith("/homeroom/gethome"))
        value = { code: 0, result: { homelist: [] } };
      else if (url.endsWith("/home/device_list_page"))
        value = {
          code: 0,
          result: {
            list: [
              {
                did: "camera-a",
                name: "Camera",
                model: "isa.camera.hlc7",
                spec_type: cameraUrn,
                isOnline: true,
              },
            ],
          },
        };
      else if (url.endsWith("/miotspec/prop/get")) {

        const body = JSON.parse(String(init!.body));
        value = {
          code: 0,
          result: body.params.map((ref: any) => ({
            ...ref,
            code: 0,
            value: ref.siid === 2 ? true : 1,
          })),
        };
      } else if (url.endsWith("/miotspec/action")) {
        const body = JSON.parse(String(init!.body));
        actions.push({
          ...body.params,
          authorization: (init!.headers as Record<string, string>)
            .Authorization,
        });

        value = {
          code: 0,
          result: {
            ...body.params,
            code: 0,
            out:
              body.params.aiid === 1
                ? ["https://camera.invalid/live.m3u8"]
                : [],
          },
        };
      } else throw Error("unexpected fixture request");
      return new Response(JSON.stringify(value));
    },
  });
  const closed: string[] = [];
  const ptzCalls: Array<{ did: string; direction: string }> = [];
  let stopped = 0;
  runtime.attachCamera({
    refreshCaptcha: async () => "", resendTicket: async () => "", cancelLogin() {},
    initialize: async () => '{"state":"ready"}', login: async () => '', submit: async () => '', resumeLogin: async () => '', logout: async () => {},
    openPreview: async () => { entered.resolve(); await released.promise; return "native-session"; },
    closePreview: id => { closed.push(id); },
    panTilt: async (did, direction) => { ptzCalls.push({ did, direction }); },
    beginCapture: () => "capture-request", cancelCapture: () => {},
    captureDevice: async () => ({data:"/9j/test",mimeType:"image/jpeg",width:640,height:360,receivedAt:"1700000000000"}),
    stopAll: () => { stopped++; },
  });
  await runtime.connect();
  return { runtime, entered, released, actions, closed, ptzCalls, stopped: () => stopped };
}

test("leaving detail before native dispatch prevents opening a preview", async () => {
  const f = await fixture();
  const ready = f.runtime.startCamera("camera-a");
  const rejected = assert.rejects(ready, /cancelled/);
  const closing = f.runtime.stopCamera();
  await rejected;
  await closing;
  assert.equal(f.closed.length, 0);
  assert.equal(f.actions.length, 0);
  f.runtime.close();
});

test("changing home connection releases a native preview that opens late", async () => {
  const f = await fixture();
  const ready = f.runtime.startCamera("camera-a");
  const rejected = assert.rejects(ready, /cancelled/);
  await f.entered.promise;
  await f.runtime.configure({ mode: "disabled", region: "us" });
  f.released.resolve();
  await rejected;
  await f.runtime.stopCamera();
  assert.deepEqual(f.closed, ["native-session"]);
  assert.ok(f.stopped() > 0);
  assert.equal(f.actions.length, 0);
  f.runtime.close();
});

test("camera capture works without detail and rejects devices outside the connection", async () => {
  const f = await fixture();
  const connectionId = f.runtime.connection().connectionId!;
  const frame = await f.runtime.captureCamera("camera-a", connectionId);
  assert.equal(frame.mimeType,"image/jpeg");
  await assert.rejects(f.runtime.captureCamera("missing",connectionId),/camera_device_not_in_connection/);
  await assert.rejects(f.runtime.captureCamera("camera-a","old-connection"),/camera_device_not_in_connection/);
  await f.runtime.panTiltCamera("camera-a", "right");
  assert.deepEqual(f.ptzCalls, [{ did: "camera-a", direction: "right" }]);
  await assert.rejects(f.runtime.panTiltCamera("missing", "left"), /camera_device_not_in_connection/);
  f.runtime.close();
});
