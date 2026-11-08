import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { MIOT_CLIENT_ID, MiotOAuthClient, MiotTokenManager, createMiotCredentials, type MiotCredentials } from "../src/index.js";
import { PrivateStore, deferred, jsonResponse, redirectUri, uuid } from "./miot-fixtures.js";

const scope = { clientId: MIOT_CLIENT_ID, region: "cn" as const, redirectUri };
const crypto = { randomUUID: () => uuid, async sha1(value: string) { return createHash("sha1").update(value).digest("hex"); } };
const callback = (state: string, code = "test-code") => `${redirectUri}?${new URLSearchParams({ code, state })}`;
const token = { access_token: "private-access", refresh_token: "private-refresh", expires_in: 100 };

it("rechecks a native login guard across exchange, storage read/write and commit rollback", async () => {
  for (const boundary of ["request", "read", "write"] as const) {
    for (const invalidation of ["cancelled", "expired", "throws"] as const) {
      const store = new PrivateStore();
      let now = 0, invalid = false, armed = false;
      const hold = deferred<void>(), started = deferred<void>();
      const pause = async () => { started.resolve(); await hold.promise; };
      const client = new MiotOAuthClient({ redirectUri, store, crypto, now: () => now,
        fetch: (async () => { if (boundary === "request") await pause(); return jsonResponse(token); }) as typeof fetch });
      await client.tokens.install(createMiotCredentials(scope, `ha.${uuid}`, { accessToken: "original", refreshToken: "r", expiresIn: 3600 }, 0));
      const get = store.get.bind(store), set = store.set.bind(store);
      store.get = async (key) => { const result = await get(key); if (armed && boundary === "read") { armed = false; await pause(); } return result; };
      store.set = async (key, value) => { await set(key, value); if (armed && boundary === "write") { armed = false; await pause(); } };
      const session = await client.beginAuthSession();
      client.tryInterceptCallbackUrl(callback(session.state));
      armed = true;
      const exchange = client.completeAuthWithCode("test-code", () => {
        if (invalid && invalidation === "throws") throw new Error("disposed native browser");
        return !invalid || invalidation === "expired";
      });
      await started.promise;
      invalid = true;
      if (invalidation === "expired") now = session.expiresAt;
      hold.resolve();
      await assert.rejects(exchange, /miot_session_changed/, `${boundary}/${invalidation}`);
      assert.equal(await client.tokens.getAccessToken(), "original");
      assert.equal(JSON.parse([...store.values.values()][0]).accessToken, "original");
    }
  }
});

it("accepts a consumed native callback with its window closed and preserves a committed account after cancellation", async () => {
  const store = new PrivateStore();
  const client = new MiotOAuthClient({ redirectUri, store, crypto, now: () => 0,
    fetch: (async () => jsonResponse(token)) as typeof fetch });
  const session = await client.beginAuthSession();
  client.tryInterceptCallbackUrl(callback(session.state));
  let state = "consumed";
  await client.completeAuthWithCode("test-code", () => state === "consumed");
  state = "cancelled"; client.cancelAuthSession();
  assert.equal(await client.tokens.getAccessToken(), token.access_token);
  await assert.rejects(client.completeAuthWithCode("test-code", () => true), /miot_invalid_auth_code/);
});

it("uses independent secure random sessions with the default WebCrypto provider", async () => {
  const client = new MiotOAuthClient({ store: new PrivateStore(), redirectUri });
  const first = await client.beginAuthSession();
  const second = await client.beginAuthSession();
  assert.notEqual(first.deviceId, second.deviceId); assert.notEqual(first.state, second.state);
  assert.equal(second.state, createHash("sha1").update(`d=${second.deviceId}`).digest("hex"));
});

it("creates an isolated OAuth session, strictly intercepts callbacks and preserves the numeric client_id losslessly", async () => {
  const store = new PrivateStore();
  let requests = 0;
  const client = new MiotOAuthClient({ store, redirectUri, crypto, now: () => 1000, region: "sg", fetch: (async (input, init) => {
    requests++;
    const url = new URL(String(input));
    assert.equal(url.origin, "https://sg.ha.api.io.mi.com");
    assert.equal(url.pathname, "/app/v2/ha/oauth/get_token");
    const data = url.searchParams.get("data")!;
    assert.match(data, /"client_id":2882303761520251711,/);
    assert.equal(JSON.parse(data).device_id, `ha.${uuid}`);
    assert.equal(JSON.parse(data).code, "test-code");
    assert.equal(JSON.parse(data).redirect_uri, redirectUri);
    assert.equal(init?.redirect, "error");
    return jsonResponse(token);
  }) as typeof fetch });
  const session = await client.beginAuthSession();
  const authorize = new URL(session.authorizationUrl);
  assert.equal(authorize.origin, "https://account.xiaomi.com");
  assert.equal(authorize.searchParams.get("client_id"), MIOT_CLIENT_ID);
  assert.equal(session.state, createHash("sha1").update(`d=ha.${uuid}`).digest("hex"));
  for (const url of ["https://evil.test/?code=leak", callback(session.state).replace("homeassistant.local", "homeassistant.local.evil.test"), callback(session.state).replace("/super_looi_test", "/other")]) {
    assert.deepEqual(client.tryInterceptCallbackUrl(url), { intercepted: false });
  }
  await assert.rejects(client.completeAuthWithCode("test-code"), /miot_invalid_auth_code/);
  assert.deepEqual(client.tryInterceptCallbackUrl(callback(session.state)), { intercepted: true, code: "test-code" });
  await client.completeAuthWithCode("test-code");
  await assert.rejects(client.completeAuthWithCode("test-code"), /miot_invalid_auth_code/);
  assert.equal(requests, 1);
  assert.equal(await client.tokens.getAccessToken(), token.access_token);
  const saved = JSON.parse([...store.values.values()][0]);
  assert.equal(saved.refreshAt, 71_000); assert.equal(saved.expiresAt, 101_000);
  assert.equal(saved.region, "sg");
  await client.logout();
  assert.equal(store.values.size, 0);
  await assert.rejects(client.tokens.getAccessToken(), /miot_auth_required/);
});

it("rejects mismatched/duplicate state, expired, denied and duplicate-code callbacks without a token request", async () => {
  let now = 0;
  let requests = 0;
  const client = new MiotOAuthClient({ store: new PrivateStore(), redirectUri, crypto, now: () => now,
    fetch: (async () => { requests++; return jsonResponse(token); }) as typeof fetch });
  for (const mode of ["wrong", "duplicate", "expired", "denied", "code", "fragment"]) {
    now = 0;
    const session = await client.beginAuthSession();
    let url = callback(session.state);
    if (mode === "wrong") url = callback("wrong");
    if (mode === "duplicate") url += `&state=${session.state}`;
    if (mode === "expired") now = session.expiresAt;
    if (mode === "denied") url = `${redirectUri}?state=${session.state}&error=private-vendor-error`;
    if (mode === "code") url += "&code=another";
    if (mode === "fragment") url += "#fragment";
    const result = client.tryInterceptCallbackUrl(url);
    assert.equal(result.intercepted, true);
    assert.ok("error" in result, mode);
    assert.ok(!JSON.stringify(result).includes("private-vendor-error"));
    await assert.rejects(client.completeAuthWithCode("test-code"), /miot_invalid_auth_code/);
  }
  assert.equal(requests, 0);
});

it("does not persist an in-flight exchange after logout, and consumes each code before sending", async () => {
  const response = deferred<Response>();
  const store = new PrivateStore();
  let requests = 0;
  const client = new MiotOAuthClient({ store, redirectUri, crypto, fetch: (async () => { requests++; return response.promise; }) as typeof fetch });
  const session = await client.beginAuthSession();
  client.tryInterceptCallbackUrl(callback(session.state));
  const exchange = client.completeAuthWithCode("test-code");
  await assert.rejects(client.completeAuthWithCode("test-code"), /miot_invalid_auth_code/);
  await client.logout();
  response.resolve(jsonResponse(token));
  await assert.rejects(exchange, /miot_session_changed/);
  assert.equal(requests, 1); assert.equal(store.values.size, 0);
});

it("coalesces refresh at 70% lifetime, restores private credentials and preserves region isolation", async () => {
  let now = 10_000;
  const store = new PrivateStore();
  let refreshes = 0;
  const refresh = async (credentials: Readonly<MiotCredentials>) => {
    refreshes++; assert.equal(credentials.refreshToken, "r1");
    return { accessToken: "a2", refreshToken: "r2", expiresIn: 100 };
  };
  const manager = new MiotTokenManager({ scope, store, now: () => now, refresh });
  await manager.install(createMiotCredentials(scope, `ha.${uuid}`, { accessToken: "a1", refreshToken: "r1", expiresIn: 100 }, now));
  now = 79_999;
  assert.equal(await manager.getAccessToken(), "a1"); assert.equal(refreshes, 0);
  const restored = new MiotTokenManager({ scope, store, now: () => now, refresh });
  assert.equal(await restored.getAccessToken(), "a1");
  now = 80_000;
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => restored.getAccessToken())), Array(20).fill("a2"));
  assert.equal(refreshes, 1);
  const otherRegion = new MiotTokenManager({ scope: { ...scope, region: "sg" }, store, now: () => now, refresh });
  await assert.rejects(otherRegion.getAccessToken(), /miot_auth_required/);
});

it("prevents refresh and delayed credential writes from resurrecting a logged-out account", async () => {
  const store = new PrivateStore();
  const refreshed = deferred<{ accessToken: string; refreshToken: string; expiresIn: number }>();
  let now = 0;
  const manager = new MiotTokenManager({ scope, store, now: () => now, refresh: () => refreshed.promise });
  await manager.install(createMiotCredentials(scope, `ha.${uuid}`, { accessToken: "old", refreshToken: "r", expiresIn: 10 }, now));
  now = 9000;
  const request = manager.getAccessToken();
  await new Promise((resolve) => setImmediate(resolve));
  await manager.clear();
  refreshed.resolve({ accessToken: "late", refreshToken: "late-r", expiresIn: 10 });
  await assert.rejects(request, /miot_session_changed/);
  assert.equal(store.values.size, 0);

  const writing = deferred<void>();
  const started = deferred<void>();
  store.set = async (key, value) => { started.resolve(); await writing.promise; store.values.set(key, value); };
  const install = manager.install(createMiotCredentials(scope, `ha.${uuid}`, { accessToken: "new", refreshToken: "new-r", expiresIn: 10 }, now));
  await started.promise;
  const clearing = manager.clear();
  writing.resolve();
  await assert.rejects(install, /miot_session_changed/);
  await clearing;
  assert.equal(store.values.size, 0);
  await assert.rejects(manager.getAccessToken(), /miot_auth_required/);
});

it("fails closed on refresh/storage errors and malformed stored tokens without leaking credentials", async () => {
  const store = new PrivateStore();
  const manager = new MiotTokenManager({ scope, store, now: () => 9000, refresh: async () => { throw new Error("private-secret"); } });
  await manager.install(createMiotCredentials(scope, `ha.${uuid}`, { accessToken: "expired", refreshToken: "r", expiresIn: 10 }, 0));
  await assert.rejects(manager.getAccessToken(), /^Error: miot_token_refresh_failed$/);
  for (const key of store.values.keys()) store.values.set(key, "not-json-private");
  const corrupted = new MiotTokenManager({ scope, store, refresh: async () => { throw new Error(); } });
  await assert.rejects(corrupted.getAccessToken(), /^Error: miot_invalid_credentials$/);
  store.get = async () => { throw new Error("private-secret"); };
  const failing = new MiotTokenManager({ scope, store, refresh: async () => { throw new Error(); } });
  await assert.rejects(failing.getAccessToken(), /^Error: miot_credential_store_failed$/);
});

it("refreshes through the official token endpoint with the original redirect URI", async () => {
  let now = 0;
  const calls: string[] = [];
  const client = new MiotOAuthClient({ redirectUri, store: new PrivateStore(), crypto, now: () => now,
    fetch: (async (input) => { calls.push(new URL(String(input)).searchParams.get("data")!); return jsonResponse(token); }) as typeof fetch });
  const session = await client.beginAuthSession(); client.tryInterceptCallbackUrl(callback(session.state));
  await client.completeAuthWithCode("test-code");
  now = 70_000;
  await client.tokens.getAccessToken();
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1]).refresh_token, token.refresh_token);
  assert.equal(JSON.parse(calls[1]).redirect_uri, redirectUri);
  assert.match(calls[1], /"client_id":2882303761520251711,/);
});

it("cancels a login while secure storage is saving and restores a previously logged-in account", async () => {
  const store = new PrivateStore();
  const writing = deferred<void>();
  const started = deferred<void>();
  const client = new MiotOAuthClient({ redirectUri, store, crypto, now: () => 0,
    fetch: (async () => jsonResponse(token)) as typeof fetch });
  await client.tokens.install(createMiotCredentials(scope, `ha.${uuid}`, { accessToken: "original", refreshToken: "original-r", expiresIn: 100 }, 0));
  const session = await client.beginAuthSession(); client.tryInterceptCallbackUrl(callback(session.state));
  const originalSet = store.set.bind(store);
  store.set = async (key, value) => { started.resolve(); await writing.promise; await originalSet(key, value); };
  const exchange = client.completeAuthWithCode("test-code");
  await started.promise;
  client.cancelAuthSession();
  writing.resolve();
  await assert.rejects(exchange, /miot_session_changed/);
  assert.equal(await client.tokens.getAccessToken(), "original");
  assert.equal(JSON.parse([...store.values.values()][0]).accessToken, "original");
});

it("rejects a refreshed token when logout occurs between persistence and the caller resuming", async () => {
  let now = 0;
  const store = new PrivateStore();
  const manager = new MiotTokenManager({ scope, store, now: () => now,
    refresh: async () => ({ accessToken: "new", refreshToken: "new-r", expiresIn: 10 }) });
  await manager.install(createMiotCredentials(scope, `ha.${uuid}`, { accessToken: "old", refreshToken: "old-r", expiresIn: 10 }, 0));
  let clearing: Promise<void> | undefined;
  store.set = async (key, value) => {
    store.values.set(key, value);
    queueMicrotask(() => queueMicrotask(() => { clearing = manager.clear(); }));
  };
  now = 9000;
  await assert.rejects(manager.getAccessToken(), /miot_session_changed/);
  await clearing;
  assert.equal(store.values.size, 0);
  await assert.rejects(manager.getAccessToken(), /miot_auth_required/);
});

it("keeps cancellation results consistent with the committed account across storage completion schedules", async () => {
  for (let microtasks = 1; microtasks <= 6; microtasks++) {
    const store = new PrivateStore();
    const client = new MiotOAuthClient({ store, redirectUri, crypto, now: () => 0, fetch: (async () => jsonResponse(token)) as typeof fetch });
    await client.tokens.install(createMiotCredentials(scope, `ha.${uuid}`, { accessToken: "original", refreshToken: "r", expiresIn: 100 }, 0));
    const originalSet = store.set.bind(store);
    store.set = async (key, value) => {
      await originalSet(key, value);
      if (JSON.parse(value).accessToken === token.access_token) {
        let remaining = microtasks;
        const cancel = () => { if (--remaining === 0) client.cancelAuthSession(); else queueMicrotask(cancel); };
        queueMicrotask(cancel);
      }
    };
    const session = await client.beginAuthSession(); client.tryInterceptCallbackUrl(callback(session.state));
    let committed = true;
    try { await client.completeAuthWithCode("test-code"); }
    catch (error) { committed = false; assert.equal((error as Error).message, "miot_session_changed"); }
    const expected = committed ? token.access_token : "original";
    assert.equal(await client.tokens.getAccessToken(), expected, `schedule ${microtasks}`);
    assert.equal(JSON.parse([...store.values.values()][0]).accessToken, expected);
  }
});
