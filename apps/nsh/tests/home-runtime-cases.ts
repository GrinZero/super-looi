import { HomeRuntime, type HomeVault } from "../runtime/home.js";
import { MIOT_CLIENT_ID, createMiotCredentials } from "@super-looi/home-assistant";
import { verifyMiotLoginFlow } from "./miot-login-cases.js";
import type {
  HomeControlCommand,
  HomeStateSnapshot,
} from "@super-looi/contracts";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(operation: () => unknown, text: string) {
  try {
    await operation();
  } catch (error) {
    check(String(error).includes(text), `wrong error: ${String(error)}`);
    return;
  }
  throw new Error(`expected ${text}`);
}
function vaultFixture(): HomeVault & { slots: Map<string, string> } {
  const slots = new Map<string, string>();
  return {
    slots,
    get: (key) => slots.get(key) ?? "",
    set: (key, value) => {
      slots.set(key, value);
    },
    remove: (key) => {
      slots.delete(key);
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { resolve, promise };
}
const command = (service = "turn_on"): HomeControlCommand => ({
  entity_id: "light.study_ceiling",
  domain: "light",
  service,
  service_data: {},
  timeout_ms: 0,
});
function snapshot(state = "off"): HomeStateSnapshot {
  const now = new Date().toISOString();
  return {
    entity_id: "light.study_ceiling",
    state,
    attributes: {
      friendly_name: "书房吸顶灯",
      supported_color_modes: ["brightness"],
      brightness: 128,
      access_token: "NEVER_PUBLISH_ATTRIBUTE",
      entity_picture: "/api/camera?token=NEVER_PUBLISH_ATTRIBUTE",
    },
    last_changed: now,
    last_updated: now,
  };
}
function haFixture() {
  let current = snapshot(),
    writes = 0,
    reflectWrites = false;
  let holdState: ReturnType<typeof deferred<unknown>> | undefined,
    holdWrite: ReturnType<typeof deferred<unknown>> | undefined;
  const stateStarted = deferred<void>(),
    writeStarted = deferred<void>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    let value: unknown;
    if (url.endsWith("/api/states")) value = [current];
    else if (url.includes("/api/services/")) {
      writes++;
      writeStarted.resolve();
      if (holdWrite) await holdWrite.promise;
      if (reflectWrites)
        current = snapshot(url.endsWith("turn_off") ? "off" : "on");
      value = [];
    } else if (url.endsWith("/api/states/light.study_ceiling")) {
      stateStarted.resolve();
      if (holdState) await holdState.promise;
      value = current;
    } else throw new Error(`unexpected fixture URL ${url}`);
    check(
      (init?.headers as Record<string, string>)?.Authorization ===
        "Bearer TEST_ONLY_HA_SECRET",
      "missing fixture auth",
    );
    // The standalone QuickJS host intentionally has no network Response class.
    // Supply the fetch response surface consumed by the production REST adapter.
    const body = JSON.stringify(value);
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(body),
    } as Response;
  };
  return {
    fetcher,
    stateStarted,
    writeStarted,
    get writes() {
      return writes;
    },
    reflect() {
      reflectWrites = true;
    },
    holdState() {
      holdState = deferred<unknown>();
    },
    releaseState() {
      holdState?.resolve(null);
    },
    holdWrite() {
      holdWrite = deferred<unknown>();
    },
    releaseWrite() {
      holdWrite?.resolve(null);
    },
  };
}
const registry = async () =>
  new Map([
    [
      "light.study_ceiling",
      { device_id: "fixture_light", device_name: "Fixture lamp" },
    ],
  ]);

/** Pure fixture integration tests, importable by the real QuickJS/NSH probe.
 * All network functions are injected; no real HA/MIoT account or device is used. */
export async function verifyHomeRuntime(): Promise<void> {
  await verifyMiotLoginFlow();
  await verifyLoginRollback();
  const vault = vaultFixture();
  let networkCalls = 0;
  const local = new HomeRuntime({
    vault,
    fetch: async () => {
      networkCalls++;
      throw new Error("unexpected network");
    },
  });
  check(
    local.configuration().mode === "disabled",
    "home must default disabled",
  );
  check((await local.list()).total === 0, "disabled home exposed devices");
  await local.configure({ mode: "simulation" });
  const demo = await local.list();
  check(
    demo.simulation === true &&
      demo.total === 1 &&
      String(demo.instruction).includes("演示"),
    "simulation must be explicit",
  );
  const id = String(demo.connectionId);
  const applied = await local.control(command(), {
    connectionId: id,
    requestId: "demo_1",
  });
  check(
    applied.simulation && applied.receipt.status === "verified",
    "simulated readback failed",
  );
  await rejects(
    () => local.control(command(), { connectionId: id, requestId: "demo_1" }),
    "already_consumed",
  );
  const toggle = await local.control(command("toggle"), {
    connectionId: id,
    requestId: "demo_toggle",
  });
  check(toggle.receipt.status === "rejected", "toggle must stay forbidden");
  const gas = await local.control(
    { ...command(), domain: "gas", entity_id: "gas.fixture" },
    { connectionId: id, requestId: "demo_gas" },
  );
  check(gas.receipt.status === "rejected", "high risk device passed");
  const pending = local.control(command("turn_off"), {
    connectionId: id,
    requestId: "demo_queued",
  });
  await local.configure({ mode: "disabled" });
  check(
    (await pending).receipt.status === "unknown",
    "queued stale action must not confirm completion",
  );
  await rejects(
    () =>
      local.control(command(), {
        connectionId: id,
        requestId: "old_connection",
      }),
    "connection_changed",
  );
  check(
    networkCalls === 0 && vault.slots.size === 1 && vault.slots.has("home"),
    "simulation networked or used an unapproved credential slot",
  );
  local.close();
  await rejects(() => local.list(), "closed");

  const fixture = haFixture(),
    secrets = vaultFixture();
  const runtime = new HomeRuntime({
    vault: secrets,
    fetch: fixture.fetcher,
    registry,
  });
  await rejects(
    () =>
      runtime.configure({
        mode: "external_ha",
        haUrl: "http://fixture.invalid",
        haToken: "x",
      }),
    "https_url_required",
  );
  await rejects(
    () =>
      runtime.configure({
        mode: "external_ha",
        haUrl: "https://fixture.invalid?token=LEAK",
        haToken: "x",
      }),
    "https_url_required",
  );
  await runtime.configure({
    mode: "external_ha",
    haUrl: "https://fixture.invalid",
    haToken: "TEST_ONLY_HA_SECRET",
  });
  const connection = await runtime.connect();
  check(
    connection.healthy &&
      connection.entityCount === 1 &&
      !connection.simulation,
    "HA fixture discovery failed",
  );
  const devices = await runtime.list();
  check(
    !JSON.stringify(devices).includes("NEVER_PUBLISH_ATTRIBUTE"),
    "HA sensitive attributes leaked",
  );
  check(
    !JSON.stringify(runtime.configuration()).includes("TEST_ONLY_HA_SECRET"),
    "public configuration leaked token",
  );
  const ack = await runtime.control(command(), {
    connectionId: connection.connectionId!,
    requestId: "ack_only",
  });
  check(
    ack.receipt.status === "unverified" && fixture.writes === 1,
    "HTTP ack was mistaken for a device readback",
  );
  fixture.reflect();
  const verified = await runtime.control(command(), {
    connectionId: connection.connectionId!,
    requestId: "real_readback",
  });
  check(
    verified.receipt.status === "verified" &&
      verified.receipt.outcome === "applied",
    "fresh readback was not preserved",
  );
  const noop = await runtime.control(command(), {
    connectionId: connection.connectionId!,
    requestId: "fresh_noop",
  });
  check(
    noop.receipt.outcome === "noop" && fixture.writes === 2,
    "fresh noop dispatched another write",
  );
  await runtime.configure({
    mode: "external_ha",
    haUrl: "https://different-fixture.invalid",
  });
  check(
    !runtime.configuration().hasToken,
    "token was reused at a different service",
  );
  const missing = await runtime.connect();
  check(
    !missing.healthy &&
      missing.error === "home_not_configured" &&
      missing.entityCount === 0,
    "real failure fell back to simulation",
  );
  runtime.close();

  const readOnlyFixture = haFixture();
  const readOnly = new HomeRuntime({
    vault: vaultFixture(),
    fetch: readOnlyFixture.fetcher,
    registry: async () => {
      throw new Error("registry down");
    },
  });
  await readOnly.configure({
    mode: "external_ha",
    haUrl: "https://fixture.invalid",
    haToken: "TEST_ONLY_HA_SECRET",
  });
  const readonlyConnection = await readOnly.connect();
  const denied = await readOnly.control(command(), {
    connectionId: readonlyConnection.connectionId!,
    requestId: "unidentified",
  });
  check(
    denied.receipt.status === "rejected" && readOnlyFixture.writes === 0,
    "unidentified discovery allowed control",
  );
  readOnly.close();

  // Pause immediately before a service write. Switching config must forbid it,
  // even if the old transport ignores AbortSignal and resolves much later.
  const staleFixture = haFixture();
  const stale = new HomeRuntime({
    vault: vaultFixture(),
    fetch: staleFixture.fetcher,
    registry,
  });
  await stale.configure({
    mode: "external_ha",
    haUrl: "https://fixture.invalid",
    haToken: "TEST_ONLY_HA_SECRET",
  });
  const staleConnection = await stale.connect();
  staleFixture.holdState();
  const old = stale.control(command(), {
    connectionId: staleConnection.connectionId!,
    requestId: "before_dispatch",
  });
  await staleFixture.stateStarted.promise;
  await stale.configure({ mode: "simulation" });
  staleFixture.releaseState();
  check(
    (await old).receipt.status === "unknown" && staleFixture.writes === 0,
    "stale preflight still dispatched a command",
  );
  const freshConnection = await stale.connect();
  await rejects(
    () =>
      stale.control(command(), {
        connectionId: staleConnection.connectionId!,
        requestId: "before_dispatch",
      }),
    "connection_changed",
  );
  check(freshConnection.simulation, "old discovery overwrote new mode");
  stale.close();

  for (const afterDispatch of [false, true]) {
    const fixture = haFixture(),
      controller = new AbortController();
    const cancellable = new HomeRuntime({
      vault: vaultFixture(),
      fetch: fixture.fetcher,
      registry,
    });
    await cancellable.configure({
      mode: "external_ha",
      haUrl: "https://fixture.invalid",
      haToken: "TEST_ONLY_HA_SECRET",
    });
    const connection = await cancellable.connect();
    if (afterDispatch) fixture.holdWrite();
    else fixture.holdState();
    const pending = cancellable.control(command(), {
      connectionId: connection.connectionId!,
      requestId: "task_cancel",
      signal: controller.signal,
    });
    await (afterDispatch
      ? fixture.writeStarted.promise
      : fixture.stateStarted.promise);
    controller.abort();
    fixture.releaseState();
    fixture.releaseWrite();
    check(
      (await pending).receipt.status === "unknown",
      "cancelled task falsely confirmed home control",
    );
    check(
      fixture.writes === (afterDispatch ? 1 : 0),
      "task cancellation dispatched or retried a write",
    );
    check(
      cancellable.connection().connectionId === null,
      "cancelled connection remained usable",
    );
    cancellable.close();
  }

  const bodyEntered = deferred<void>(),
    bodyReleased = deferred<unknown>();
  let bodyAborted = false;
  const bodyRuntime = new HomeRuntime({
    vault: vaultFixture(),
    registry,
    fetch: async (_input, init) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          bodyAborted = true;
        },
        { once: true },
      );
      return {
        ok: true,
        status: 200,
        json: async () => {
          bodyEntered.resolve();
          await bodyReleased.promise;
          return [snapshot()];
        },
      } as Response;
    },
  });
  await bodyRuntime.configure({
    mode: "external_ha",
    haUrl: "https://fixture.invalid",
    haToken: "TEST_ONLY_HA_SECRET",
  });
  const bodyConnection = bodyRuntime.connect();
  await bodyEntered.promise;
  await bodyRuntime.configure({ mode: "disabled" });
  bodyReleased.resolve(null);
  await rejects(() => bodyConnection, "connection_changed");
  check(
    bodyAborted && bodyRuntime.connection().entityCount === 0,
    "response-body cancellation stopped after headers",
  );
  bodyRuntime.close();

  // Close after native dispatch: completion is unknown, not verified or replayed.
  const closingFixture = haFixture();
  const closing = new HomeRuntime({
    vault: vaultFixture(),
    fetch: closingFixture.fetcher,
    registry,
  });
  await closing.configure({
    mode: "external_ha",
    haUrl: "https://fixture.invalid",
    haToken: "TEST_ONLY_HA_SECRET",
  });
  const closingConnection = await closing.connect();
  closingFixture.holdWrite();
  closingFixture.reflect();
  const dispatched = closing.control(command(), {
    connectionId: closingConnection.connectionId!,
    requestId: "after_dispatch",
  });
  await closingFixture.writeStarted.promise;
  closing.close();
  closingFixture.releaseWrite();
  check(
    (await dispatched).receipt.status === "unknown" &&
      closingFixture.writes === 1,
    "closed write was confirmed or retried",
  );

  const noAuth = new HomeRuntime({
    vault: vaultFixture(),
    fetch: async () => {
      throw new Error("unauthorized MIoT request");
    },
  });
  await noAuth.configure({ mode: "direct_miot" });
  const miot = await noAuth.connect();
  check(
    miot.error === "miot_auth_required" &&
      !miot.healthy &&
      miot.entityCount === 0,
    "unauthorized MIoT pretended to connect",
  );
  const login = await noAuth.beginMiotLogin();
  check(
    login.authorizationUrl.startsWith("https://account.xiaomi.com/"),
    "OAuth entry not provided",
  );
  check(
    noAuth.interceptMiotCallback(
      `${login.redirectUri}?state=wrong&code=fixture`,
    ).intercepted,
    "callback was not intercepted",
  );
  await rejects(() => noAuth.finishMiotLogin("fixture"), "invalid_auth_code");
  noAuth.close();

  // The native home slot is one encrypted envelope; configuration commits and
  // OAuth credential commits always merge the latest envelope synchronously.
  const authVault = vaultFixture(),
    exchange = deferred<unknown>();
  let tokenRequests = 0;
  const authenticating = new HomeRuntime({
    vault: authVault,
    fetch: async () => {
      tokenRequests++;
      await exchange.promise;
      return {
        ok: true,
        json: async () => ({
          code: 0,
          result: {
            access_token: "FIXTURE_MIOT_ACCESS",
            refresh_token: "FIXTURE_MIOT_REFRESH",
            expires_in: 3600,
          },
        }),
      } as Response;
    },
  });
  const authSession = await authenticating.beginMiotLogin();
  const callback = authenticating.interceptMiotCallback(
    `${authSession.redirectUri}?state=${authSession.state}&code=fixture_code`,
  );
  check(
    callback.intercepted && "code" in callback,
    "valid OAuth callback failed",
  );
  const completing = authenticating.finishMiotLogin("fixture_code");
  await authenticating.configure({ mode: "simulation" });
  exchange.resolve(null);
  await rejects(() => completing, "miot_request_failed");
  check(
    tokenRequests === 1 && !authVault.get("home").includes("FIXTURE_MIOT"),
    "stale OAuth write resurrected credentials",
  );
  check(
    new HomeRuntime({ vault: authVault }).configuration().mode === "simulation",
    "persisted configuration did not restore",
  );
  authenticating.close();

  const failing = new HomeRuntime({
    vault: vaultFixture(),
    fetch: async () => {
      throw new Error("TEST_ONLY_HA_SECRET must never escape");
    },
  });
  await failing.configure({
    mode: "external_ha",
    haUrl: "https://fixture.invalid",
    haToken: "TEST_ONLY_HA_SECRET",
  });
  const failure = await failing.connect();
  check(
    failure.error === "ha_connection_failed" &&
      JSON.stringify(failure.diagnostics).includes("must never escape") &&
      !JSON.stringify(failure).includes("SECRET") &&
      !failure.simulation,
    "raw network error leaked or simulation fallback occurred",
  );
  failing.close();

  // Multi-source aggregation, rich appliance dashboard, and Bento layout persistence
  const multiFixture = haFixture();
  multiFixture.reflect();
  const multiVault = vaultFixture();
  const multi = new HomeRuntime({
    vault: multiVault,
    fetch: multiFixture.fetcher,
    registry,
  });
  await multi.configure({
    mode: "external_ha",
    haUrl: "https://fixture.invalid",
    haToken: "TEST_ONLY_HA_SECRET",
    enabledSources: { external_ha: true, simulation: true },
  });
  const multiConn = await multi.connect();
  check(
    multiConn.healthy &&
      Boolean(multiConn.sources?.external_ha.healthy) &&
      Boolean(multiConn.sources?.simulation.healthy),
    "multi-source connection failed to activate both HA and simulation",
  );
  const dash = await multi.dashboard("zh-CN");
  check(
    dash.rooms.some((r) => r.name === "大厅") &&
      dash.allAppliances.some((a) => a.name === "电饭煲" && a.span === "2x1") &&
      dash.allAppliances.some((a) => a.name === "大厅监控" && a.span === "2x2"),
    "dashboard failed to aggregate multi-room complex appliances",
  );
  const riceCooker = dash.allAppliances.find((a) => a.name === "电饭煲")!;
  multi.setApplianceLayout(riceCooker.id, { span: "2x2", order: 1 });
  const dashAfter = await multi.dashboard("zh-CN");
  const updatedCooker = dashAfter.allAppliances.find((a) => a.id === riceCooker.id)!;
  check(
    updatedCooker.span === "2x2" && updatedCooker.order === 1 && multiVault.slots.size === 1,
    "Bento layout customization failed or used an extra vault slot",
  );
  // Control a complex simulation appliance (Rice Cooker cancel button -> 保温)
  const cancelRes = await multi.control(
    {
      entity_id: "button.rice_cooker_cancel",
      domain: "button",
      service: "press",
      service_data: {},
      timeout_ms: 0,
    },
    { connectionId: multiConn.connectionId!, requestId: "cooker_cancel_1" },
  );
  check(
    cancelRes.receipt.status === "verified",
    "complex appliance button action failed verification",
  );
  multi.close();
}

async function verifyLoginRollback() {
  for (const prior of [false, true]) {
    for (const change of ["cancel", "configuration", "later-writer"]) {
      const vault = vaultFixture();
      const bootstrap = new HomeRuntime({ vault });
      const initial = await bootstrap.beginMiotLogin();
      bootstrap.close();
      const key = `super-looi.miot.cn.${MIOT_CLIENT_ID}.${encodeURIComponent(initial.redirectUri)}`;
      const credential = (accessToken: string) => JSON.stringify(createMiotCredentials(
        { clientId: MIOT_CLIENT_ID, region: "cn", redirectUri: initial.redirectUri },
        "ha.00000000-0000-0000-0000-000000000001",
        { accessToken, refreshToken: "fixture-refresh", expiresIn: 3600 }, Date.now()));
      const original = credential("ORIGINAL_ACCOUNT");
      if (prior) {
        const saved = JSON.parse(vault.get("home")); saved.credentials[key] = original;
        vault.set("home", JSON.stringify(saved));
      }
      const home = new HomeRuntime({ vault, fetch: (async () => ({
        ok: true, json: async () => ({ code: 0, result: {
          access_token: "ATTEMPTED_ACCOUNT", refresh_token: "fixture-refresh", expires_in: 3600,
        } }),
      } as Response)) as typeof fetch });
      const session = await home.beginMiotLogin();
      home.interceptMiotCallback(`${session.redirectUri}?state=${session.state}&code=fixture`);
      const set = vault.set.bind(vault);
      let armed = true;
      let mutation: Promise<void> = Promise.resolve();
      vault.set = (slot, value) => {
        set(slot, value);
        if (armed && value.includes("ATTEMPTED_ACCOUNT")) {
          armed = false;
          mutation = Promise.resolve().then(async () => {
            if (change === "cancel") home.suspend();
            else if (change === "configuration") await home.configure({ mode: "simulation" });
            else {
              home.close();
              const newer = new HomeRuntime({ vault });
              await newer.configure({ mode: "simulation" });
              const current = JSON.parse(vault.get("home"));
              current.credentials[key] = credential("LATER_ACCOUNT");
              current.credentials.unrelated = "KEEP_ME";
              set("home", JSON.stringify(current));
              newer.close();
            }
          });
        }
      };
      await rejects(() => home.finishMiotLogin("fixture", () => true), "miot_session_changed");
      await mutation;
      const saved = JSON.parse(vault.get("home"));
      const value = saved.credentials[key];
      check(!JSON.stringify(saved).includes("ATTEMPTED_ACCOUNT"), "cancelled native account remained in secure slot");
      if (change === "later-writer") {
        check(JSON.parse(value).accessToken === "LATER_ACCOUNT" && saved.credentials.unrelated === "KEEP_ME", "rollback overwrote a later writer");
      } else check(value === (prior ? original : undefined), "rollback did not restore the previous account");
      if (change !== "cancel") check(saved.config.mode === "simulation", "rollback restored an obsolete configuration");
      home.close();
    }
  }
}
