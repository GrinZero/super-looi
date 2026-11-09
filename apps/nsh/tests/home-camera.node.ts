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
async function fixture(hold: "properties" | "start") {
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
        if (hold === "properties") {
          entered.resolve();
          await released.promise;
        }
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
        if (body.params.aiid === 1 && hold === "start") {
          entered.resolve();
          await released.promise;
        }
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
  await runtime.connect();
  return { runtime, entered, released, actions };
}

test("runtime exit during property reads prevents camera start", async () => {
  const f = await fixture("properties");
  const ready = f.runtime.startCamera("camera-a");
  const rejected = assert.rejects(ready, /cancelled/);
  await f.entered.promise;
  const closing = f.runtime.stopCamera();
  f.released.resolve();
  await rejected;
  await closing;
  assert.equal(f.actions.length, 0);
  f.runtime.close();
});

test("changing account after dispatch cleans a late start with the original client despite generation invalidation", async () => {
  const f = await fixture("start");
  const ready = f.runtime.startCamera("camera-a");
  const rejected = assert.rejects(ready, /cancelled/);
  await f.entered.promise;
  await f.runtime.configure({ mode: "disabled", region: "us" });
  f.released.resolve();
  await rejected;
  await f.runtime.stopCamera();
  assert.deepEqual(
    f.actions.map((action) => action.aiid),
    [1, 2],
  );
  assert.equal(f.actions[1]?.authorization, "BearerORIGINAL_ACCOUNT_TOKEN");
  f.runtime.close();
});
