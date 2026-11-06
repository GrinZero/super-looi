import assert from "node:assert/strict";
import { it } from "node:test";
import { MiotHttpClient, MiotOAuthClient } from "../src/index.js";
import { jsonResponse, lightUrn, PrivateStore, redirectUri } from "./miot-fixtures.js";

it("joins shared home/room continuation pages, discovers paginated devices and sends exact Xiaomi auth headers", async () => {
  let homesPages = 0; let devicePages = 0;
  const client = new MiotHttpClient({ region: "de", getAccessToken: async () => "private-access", fetch: (async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(url.origin, "https://de.ha.api.io.mi.com");
    assert.equal(headers.get("Authorization"), "Bearerprivate-access");
    assert.equal(headers.get("X-Client-BizId"), "haapi");
    assert.equal(headers.get("X-Client-AppId"), "2882303761520251711");
    assert.equal(init?.redirect, "error");
    const data = JSON.parse(String(init?.body));
    if (url.pathname.endsWith("/gethome")) {
      assert.equal(data.fetch_share, true);
      return jsonResponse({ homelist: [{ id: 1, name: "家", roomlist: [{ id: "study", name: "书房", dids: [] }] }],
        share_home_list: [{ id: "shared", name: "共享家", dids: ["d3"], roomlist: [] }], has_more: true, max_id: "home-page2" });
    }
    if (url.pathname.endsWith("/get_dev_room_page")) {
      homesPages++; assert.equal(data.start_id, "home-page2");
      return jsonResponse({ info: [{ id: 1, dids: ["d1"], roomlist: [{ id: "study", dids: ["d2"] }] }] });
    }
    devicePages++;
    assert.deepEqual(data.dids, []);
    assert.equal(data.get_split_device, true);
    if (!data.start_did) return jsonResponse({ list: [{ did: "d1", name: "灯1", model: "test.light.v1", spec_type: lightUrn, isOnline: true, token: "lan-secret" }], has_more: true, next_start_did: "d1" });
    assert.equal(data.start_did, "d1");
    return jsonResponse({ list: [{ did: "d2", name: "灯2", model: "test.light.v1", spec_type: lightUrn, isOnline: true },
      { did: "d3", name: "灯3", model: "test.light.v1", spec_type: lightUrn, isOnline: false }] });
  }) as typeof fetch });
  const homes = await client.listHomes();
  const devices = await client.listDevices(homes);
  assert.equal(homesPages, 1); assert.equal(devicePages, 2); assert.equal(devices.length, 3);
  assert.equal(devices[0].home, "家"); assert.equal(devices[1].room, "书房"); assert.equal(devices[2].home, "共享家");
  assert.ok(!JSON.stringify(devices).includes("lan-secret"));
});

it("rejects repeated pagination cursors without an unbounded discovery loop", async () => {
  let calls = 0;
  const client = new MiotHttpClient({ getAccessToken: async () => "token", fetch: (async () => {
    calls++; return jsonResponse({ list: [], has_more: true, next_start_did: "same" });
  }) as typeof fetch });
  await assert.rejects(client.listDevices(), /miot_invalid_pagination/); assert.equal(calls, 2);
});

it("never retries a write after HTTP failure and redacts raw upstream and token-provider errors", async () => {
  for (const kind of ["401", "body", "network", "token-provider"]) {
    let calls = 0;
    const client = new MiotHttpClient({ getAccessToken: async () => { if (kind === "token-provider") throw new Error("private-secret"); return "token"; }, fetch: (async () => {
      calls++;
      if (kind === "401") return new Response("private-secret", { status: 401 });
      if (kind === "body") return new Response(JSON.stringify({ code: -1, message: "private-secret" }));
      throw new Error("private-secret");
    }) as typeof fetch });
    await assert.rejects(client.setProperties([{ did: "lamp", siid: 2, piid: 1, value: true }]), (error: Error) => {
      assert.match(error.message, /^miot_/); assert.ok(!error.message.includes("private-secret")); return true;
    });
    assert.equal(calls, kind === "token-provider" ? 0 : 1);
  }
});

it("rejects duplicate, mismatched and nonnumeric property result codes", async () => {
  const requested = { did: "lamp", siid: 2, piid: 1 };
  for (const result of [
    [{ ...requested, code: 0, value: true }, { ...requested, code: 0, value: false }],
    [{ ...requested, did: "other", code: 0, value: true }],
    [{ ...requested, code: "0", value: true }],
  ]) {
    const client = new MiotHttpClient({ getAccessToken: async () => "token", fetch: (async () => jsonResponse(result)) as typeof fetch });
    await assert.rejects(client.getProperties([requested]), /miot_invalid_response/);
  }
});

it("bounds OAuth exchange network stalls and fails closed on malformed token responses", async () => {
  const crypto = { randomUUID: () => "12345678-1234-4234-9234-123456789abc", sha1: async () => "a".repeat(40) };
  for (const stalled of [true, false]) {
    const client = new MiotOAuthClient({ store: new PrivateStore(), redirectUri, crypto, timeoutMs: 10,
      fetch: (async (_input, init) => {
        if (!stalled) return jsonResponse({ access_token: "private-access", refresh_token: "private-refresh", expires_in: -1 });
        return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("private-secret"))));
      }) as typeof fetch });
    const session = await client.beginAuthSession();
    client.tryInterceptCallbackUrl(`${redirectUri}?code=private-code&state=${session.state}`);
    await assert.rejects(client.completeAuthWithCode("private-code"), stalled ? /miot_request_failed/ : /miot_invalid_token/);
    await assert.rejects(client.tokens.getAccessToken(), /miot_auth_required/);
  }
});
