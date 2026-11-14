import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DualLoopAiBus } from "../runtime/plugins/ai-bus.js";
import type { PluginDefinition, PluginManifest } from "../runtime/plugins/contracts.js";
import { createEffectScope } from "../runtime/plugins/effect-scope.js";
import { PluginKernelError } from "../runtime/plugins/errors.js";
import { PluginHost } from "../runtime/plugins/host.js";
import { compareSemVer, parseSemVer, satisfiesSemVerRange } from "../runtime/plugins/semver.js";

function makeManifest(
  id: string,
  overrides: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    id,
    version: "1.0.0",
    minHostApiVersion: 2,
    category: "utilities",
    icon: "wrench",
    name: { "zh-CN": id, "en-US": id },
    summary: { "zh-CN": `${id} summary`, "en-US": `${id} summary` },
    author: { name: "Test" },
    permissions: [],
    ...overrides,
  };
}

test("SemVer parser and range matcher validate caret, tilde, compound, and prerelease rules", () => {
  assert.deepEqual(parseSemVer("1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [], raw: "1.2.3" });
  assert.ok(compareSemVer("1.2.0", "1.2.0-alpha.1") > 0);
  assert.equal(satisfiesSemVerRange("1.4.2", "^1.2.0"), true);
  assert.equal(satisfiesSemVerRange("2.0.0", "^1.2.0"), false);
  assert.equal(satisfiesSemVerRange("0.2.5", "^0.2.1"), true);
  assert.equal(satisfiesSemVerRange("0.3.0", "^0.2.1"), false);
  assert.equal(satisfiesSemVerRange("1.2.9", "~1.2.3"), true);
  assert.equal(satisfiesSemVerRange("1.3.0", "~1.2.3"), false);
  assert.equal(satisfiesSemVerRange("2.1.0", "^1.0.0 || >=2.0.0 <3.0.0"), true);

  assert.throws(
    () => parseSemVer("not-a-semver", "bad-plugin"),
    (err: unknown) => err instanceof PluginKernelError && err.code === "ERR_PLUGIN_INVALID_SEMVER",
  );
});

test("EffectScope unwinds child forked scopes and cleanups in strict LIFO order", async () => {
  const order: string[] = [];
  const root = createEffectScope("plugin:werewolf", "werewolf");
  root.onDispose(() => {
    order.push("root-1");
  });
  root.onDispose(() => {
    order.push("root-2");
  });

  const nightScope = root.fork("night-1");
  nightScope.onDispose(() => {
    order.push("night-1-a");
  });
  nightScope.onDispose(() => {
    order.push("night-1-b");
  });

  const witchScope = nightScope.fork("witch");
  witchScope.onDispose(() => {
    order.push("witch-only");
  });

  await witchScope.dispose();
  assert.deepEqual(order, ["witch-only"]);
  assert.equal(witchScope.active, false);
  assert.equal(nightScope.active, true);

  await root.dispose();
  assert.deepEqual(order, ["witch-only", "night-1-b", "night-1-a", "root-2", "root-1"]);
  // Idempotent second dispose
  await root.dispose();
  assert.equal(order.length, 5);
});

test("PluginHost migrates legacy plugin_settings table and invokes version migrate() hook", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE plugin_settings (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      configuration TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare(
    "INSERT INTO plugin_settings (id, enabled, configuration, updated_at) VALUES (?, ?, ?, ?)",
  ).run("companion-cat", 1, JSON.stringify({ legacySpeed: "fast", followDistanceCm: 45 }), "2026-01-01T00:00:00Z");

  // First boot at v1.0.0 imports legacy settings
  const defV1: PluginDefinition<{ speedMode: string }, never> = {
    manifest: makeManifest("companion-cat", { version: "1.0.0", category: "vision_motion" }),
    initialState: (storage) => ({
      speedMode: storage.get<string>("legacySpeed") ?? "normal",
    }),
    create: () => ({ async start() {} }),
  };

  const hostV1 = new PluginHost(db, [defV1]);
  assert.equal(hostV1.snapshot("companion-cat").state.speedMode, "fast");
  await hostV1.close();

  // Second boot upgrades to v2.0.0 and runs migrate(fromVersion, toVersion, storage)
  let migratedPair: [string, string] | undefined;
  const defV2: PluginDefinition<{ speedMode: string }, never> = {
    manifest: makeManifest("companion-cat", { version: "2.0.0", category: "vision_motion" }),
    migrate: (fromVer, toVer, storage) => {
      migratedPair = [fromVer, toVer];
      const legacy = storage.get<string>("legacySpeed");
      if (legacy) {
        storage.set("speedMode", legacy === "fast" ? "agile_v2" : "calm_v2");
        storage.delete("legacySpeed");
      }
    },
    initialState: (storage) => ({
      speedMode: storage.get<string>("speedMode") ?? "calm_v2",
    }),
    create: () => ({ async start() {} }),
  };

  const hostV2 = new PluginHost(db, [defV2]);
  await hostV2.startAll();
  assert.deepEqual(migratedPair, ["1.0.0", "2.0.0"]);
  assert.equal(hostV2.snapshot("companion-cat").state.speedMode, "agile_v2");
  assert.equal(hostV2.snapshot("companion-cat").version, "2.0.0");

  await hostV2.close();
  db.close();
});

test("DAG topology rejects cycles and incompatible hard SemVer ranges with structured error codes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const cycleA: PluginDefinition = {
      manifest: makeManifest("alpha-node", {
        provides: [{ id: "alpha.svc", version: "1.0.0" }],
        dependencies: [{ service: "beta.svc", versionRange: "^1.0.0" }],
      }),
      initialState: () => ({}),
      create: () => ({ async start() {} }),
    };
    const cycleB: PluginDefinition = {
      manifest: makeManifest("beta-node", {
        provides: [{ id: "beta.svc", version: "1.0.0" }],
        dependencies: [{ service: "alpha.svc", versionRange: "^1.0.0" }],
      }),
      initialState: () => ({}),
      create: () => ({ async start() {} }),
    };

    assert.throws(
      () => new PluginHost(db, [cycleA, cycleB]),
      (err: unknown) =>
        err instanceof PluginKernelError &&
        err.code === "ERR_PLUGIN_DEPENDENCY_CYCLE" &&
        err.message.includes("->"),
    );

    const providerV1: PluginDefinition = {
      manifest: makeManifest("vision-base", {
        provides: [{ id: "vision.tracker", version: "1.2.0" }],
      }),
      initialState: () => ({}),
      create: () => ({ async start() {} }),
    };
    const consumerNeedsV2: PluginDefinition = {
      manifest: makeManifest("werewolf-judge", {
        dependencies: [{ service: "vision.tracker", versionRange: "^2.0.0", optional: false }],
      }),
      initialState: () => ({}),
      create: () => ({ async start() {} }),
    };

    assert.throws(
      () => new PluginHost(db, [providerV1, consumerNeedsV2]),
      (err: unknown) =>
        err instanceof PluginKernelError && err.code === "ERR_PLUGIN_SERVICE_VERSION_MISMATCH",
    );
  } finally {
    db.close();
  }
});

test("DAG boots providers before consumers, cascades waiting_dependency on disable, and hot-swaps optional watchers", async () => {
  const db = new DatabaseSync(":memory:");
  const events: string[] = [];
  let staleTrackerRef: { identify: () => string } | undefined;

  // Register upper plugins BEFORE foundational provider to prove topological sorting
  const werewolfDef: PluginDefinition<{ trackedUser: string }, never> = {
    manifest: makeManifest("werewolf-judge", {
      category: "games_social",
      permissions: ["stage.ui"],
      dependencies: [{ service: "vision.tracker", versionRange: "^1.1.0", optional: false }],
    }),
    initialState: () => ({ trackedUser: "none" }),
    create: (ctx) => ({
      async start() {
        events.push("start:werewolf");
        const tracker = ctx.services.get<{ identify: () => string }>("vision.tracker");
        staleTrackerRef = tracker;
        ctx.setState({ trackedUser: tracker.identify() });
        ctx.stage?.usePresentation({
          active: true,
          facePosture: { kind: "floating_top", scale: 0.34, chrome: "pill" },
          drawerDetent: "large",
        });
        ctx.scope.onDispose(() => {
          events.push("dispose:werewolf-scope");
        });
      },
    }),
  };

  const softCompanionDef: PluginDefinition<{ enhanced: boolean }, never> = {
    manifest: makeManifest("ambient-greeter", {
      category: "persona_expression",
      dependencies: [{ service: "vision.tracker", versionRange: "^1.0.0", optional: true }],
    }),
    initialState: () => ({ enhanced: false }),
    create: (ctx) => ({
      async start() {
        events.push("start:greeter");
        ctx.services.whenAvailable<{ identify: () => string }>("vision.tracker", (svc, depScope) => {
          events.push(`greeter:bound:${svc.identify()}`);
          ctx.setState({ enhanced: true });
          depScope.onDispose(() => {
            events.push("greeter:unbound");
            ctx.setState({ enhanced: false });
          });
        });
      },
    }),
  };

  const visionProviderDef: PluginDefinition = {
    manifest: makeManifest("vision-identity", {
      category: "vision_motion",
      provides: [{ id: "vision.tracker", version: "1.3.0" }],
    }),
    initialState: () => ({}),
    create: (ctx) => ({
      async start() {
        events.push("start:vision");
        ctx.services.provide("vision.tracker", {
          identify: () => "player-seat-3",
        });
      },
    }),
  };

  const host = new PluginHost(db, [werewolfDef, softCompanionDef, visionProviderDef]);
  try {
    // Before startAll, werewolf has an unsatisfied hard dependency
    assert.equal(host.snapshot("werewolf-judge").lifecycle, "waiting_dependency");

    await host.startAll();
    // Vision must start before werewolf, and werewolf must now be active with stage presentation
    assert.equal(events.indexOf("start:vision") < events.indexOf("start:werewolf"), true);
    assert.equal(host.snapshot("werewolf-judge").lifecycle, "active");
    assert.equal(host.snapshot("werewolf-judge").state.trackedUser, "player-seat-3");
    assert.equal(host.stage.activePluginId(), "werewolf-judge");

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.snapshot("ambient-greeter").state.enhanced, true);

    // Disabling foundational vision-identity suspends werewolf-judge into waiting_dependency
    // and unwinds werewolf's stage presentation + soft watcher's depScope!
    await host.setEnabled("vision-identity", false);
    assert.equal(host.snapshot("vision-identity").lifecycle, "stopped");
    assert.equal(host.snapshot("werewolf-judge").lifecycle, "waiting_dependency");
    assert.equal(host.snapshot("werewolf-judge").enabled, true);
    assert.equal(host.stage.activePluginId(), null);
    assert.equal(host.snapshot("ambient-greeter").lifecycle, "active");
    assert.equal(host.snapshot("ambient-greeter").state.enhanced, false);
    assert.ok(events.includes("dispose:werewolf-scope"));
    assert.ok(events.includes("greeter:unbound"));

    // Calling a retained service reference after provider stopped must throw ERR_PLUGIN_SERVICE_UNAVAILABLE
    assert.throws(
      () => staleTrackerRef!.identify(),
      (err: unknown) =>
        err instanceof PluginKernelError && err.code === "ERR_PLUGIN_SERVICE_UNAVAILABLE",
    );

    // Re-enabling vision-identity automatically wakes werewolf-judge and re-binds soft watcher
    await host.setEnabled("vision-identity", true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.snapshot("vision-identity").lifecycle, "active");
    assert.equal(host.snapshot("werewolf-judge").lifecycle, "active");
    assert.equal(host.stage.activePluginId(), "werewolf-judge");
    assert.equal(host.snapshot("ambient-greeter").state.enhanced, true);
  } finally {
    await host.close();
    db.close();
  }
});

test("DualLoopAiBus enforces permissions, Fail-Closed bail guards, and isolated 80ms voice waterfall budget", async () => {
  const scope = createEffectScope("plugin:test", "test-plugin");
  const bus = new DualLoopAiBus(() => "test-plugin");

  const unprivileged = bus.createScopedCapability(
    makeManifest("no-intercept", { permissions: ["ai.context"] }),
    scope,
  )!;
  assert.throws(
    () => unprivileged.interceptToolCall(() => undefined),
    (err: unknown) =>
      err instanceof PluginKernelError && err.code === "ERR_PLUGIN_PERMISSION_DENIED",
  );

  const privileged = bus.createScopedCapability(
    makeManifest("guard-plugin", { permissions: ["ai.context", "ai.intercept"] }),
    scope,
  )!;

  // Throwing inside a tool guard must Fail-Closed (`deny`), never Fail-Open
  const disposeCrashGuard = privileged.interceptToolCall(() => {
    throw Object.assign(new Error("Guard invariant broken"), { code: "ERR_WEREWOLF_SECRET" });
  });
  const denied = await bus.evaluateToolCall({
    channel: "voice",
    toolName: "reveal_roles",
    approvalMode: "yolo",
    arguments: {},
  });
  assert.equal(denied?.decision, "deny");
  if (denied?.decision === "deny") {
    assert.equal(denied.code, "ERR_WEREWOLF_SECRET");
    assert.match(denied.reason, /guard-plugin:ai\.interceptToolCall/);
  }
  disposeCrashGuard();

  // Waterfall timeout isolation: slow assembler (>80ms) is skipped without blocking or double-running fast downstream assembler
  const skipped: Array<{ pluginId: string; stage: string }> = [];
  let downstreamCalls = 0;

  privileged.useTurnAssembler(async (_draft, signal, _next) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return _next(_draft);
  });

  const fastCap = bus.createScopedCapability(
    makeManifest("fast-plugin", { permissions: ["ai.context"] }),
    scope,
  )!;
  fastCap.useTurnAssembler(async (draft, _signal, next) => {
    downstreamCalls += 1;
    return next({
      ...draft,
      contextBlocks: [
        ...draft.contextBlocks,
        { pluginId: "fast-plugin", priority: 10, text: "Front camera sees Alice smiling." },
      ],
    });
  });

  const startedAt = Date.now();
  const assembled = await bus.assembleTurn({
    channel: "voice",
    userText: "Who is in front of you?",
    budgetMs: 50,
    onAssemblerSkipped: (info) => skipped.push({ pluginId: info.pluginId, stage: info.stage }),
  });
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 200, `Expected voice waterfall to finish within budget, took ${elapsed}ms`);
  assert.equal(downstreamCalls, 1);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].pluginId, "guard-plugin");
  assert.equal(
    assembled.contextBlocks.some((b) => b.text.includes("Alice smiling")),
    true,
  );

  await scope.dispose();
});

test("PluginHost handles 3-tier A->B->C wake-up, #private service proxies, ensureStarted races, and offline configure", async () => {
  const db = new DatabaseSync(":memory:");

  class PrivateCounterService {
    #secretCount = 41;
    increment(): number {
      this.#secretCount += 1;
      return this.#secretCount;
    }
  }

  let finishSlowStart!: () => void;
  const pluginA: PluginDefinition<{ note: string }, never> = {
    manifest: makeManifest("tier-a", {
      provides: [{ id: "svc.a", version: "1.0.0" }],
    }),
    initialState: (storage) => ({ note: storage.get<string>("note") ?? "init" }),
    create: (ctx) => ({
      async configure(values) {
        if (values.note !== undefined) {
          ctx.setState({ note: values.note });
        }
      },
      async start() {
        await new Promise<void>((resolve) => {
          finishSlowStart = resolve;
        });
        if (!ctx.enabled()) return;
        ctx.services.provide("svc.a", new PrivateCounterService());
      },
    }),
  };

  const pluginB: PluginDefinition = {
    manifest: makeManifest("tier-b", {
      provides: [{ id: "svc.b", version: "1.0.0" }],
      dependencies: [{ service: "svc.a", versionRange: "^1.0.0" }],
    }),
    initialState: () => ({}),
    create: (ctx) => ({
      async start() {
        const a = ctx.services.get<PrivateCounterService>("svc.a");
        const val = a.increment();
        ctx.services.provide("svc.b", { doubled: () => val * 2 });
      },
    }),
  };

  const pluginC: PluginDefinition<{ result: number }, never> = {
    manifest: makeManifest("tier-c", {
      dependencies: [{ service: "svc.b", versionRange: "^1.0.0" }],
    }),
    initialState: () => ({ result: 0 }),
    create: (ctx) => ({
      async start() {
        const b = ctx.services.get<{ doubled: () => number }>("svc.b");
        ctx.setState({ result: b.doubled() });
      },
    }),
  };

  const host = new PluginHost(db, [pluginC, pluginB, pluginA]);
  try {
    // Offline configure when disabled must persist and update state without throwing ERR_PLUGIN_DISABLED
    await host.setEnabled("tier-a", false);
    const savedDisabled = await host.configure("tier-a", false, { note: "saved-while-disabled" });
    assert.equal(savedDisabled.enabled, false);
    assert.equal(savedDisabled.state.note, "saved-while-disabled");

    // Re-enabling tier-a while slow start runs, then racing setEnabled(false) must serialize cleanly
    const enablePromise = host.setEnabled("tier-a", true);
    await new Promise((resolve) => setImmediate(resolve));
    const disablePromise = host.setEnabled("tier-a", false);
    finishSlowStart();
    await enablePromise;
    await disablePromise;
    assert.equal(host.snapshot("tier-a").lifecycle, "stopped");
    assert.equal(host.snapshot("tier-b").lifecycle, "waiting_dependency");
    assert.equal(host.snapshot("tier-c").lifecycle, "waiting_dependency");

    // Enabling tier-a to completion wakes the entire 3-tier chain A -> B -> C before setEnabled resolves
    const enableAgain = host.setEnabled("tier-a", true);
    await new Promise((resolve) => setImmediate(resolve));
    finishSlowStart();
    await enableAgain;

    assert.equal(host.snapshot("tier-a").lifecycle, "active");
    assert.equal(host.snapshot("tier-b").lifecycle, "active");
    assert.equal(host.snapshot("tier-c").lifecycle, "active");
    assert.equal(host.snapshot("tier-c").state.result, 84);
  } finally {
    await host.close();
    db.close();
  }
});

test("DualLoopAiBus enforces monotonic tool guard severity and stage_persona idle isolation", async () => {
  let activeStagePlugin: string | null = null;
  const scope = createEffectScope("plugin:bus", "bus");
  const bus = new DualLoopAiBus(() => activeStagePlugin);

  const p1 = bus.createScopedCapability(
    makeManifest("allow-plugin", { permissions: ["ai.context", "ai.intercept"] }),
    scope,
  )!;
  const p2 = bus.createScopedCapability(
    makeManifest("ask-plugin", { permissions: ["ai.context", "ai.intercept"] }),
    scope,
  )!;

  // Upstream "allow" must NOT skip downstream "ask"
  p1.interceptToolCall(() => ({ decision: "allow" }));
  p2.interceptToolCall(() => ({ decision: "ask", promptPayload: { operation: "codex_exec" } }));

  const decision = await bus.evaluateToolCall({
    channel: "task",
    toolName: "codex_exec",
    approvalMode: "ask",
    arguments: {},
  });
  assert.equal(decision?.decision, "ask");

  // stage_persona must NOT leak when no stage plugin is in the foreground (`activeStagePlugin === null`)
  p1.usePersonaOverlay({ mode: "stage_persona", instructions: "You are the Werewolf Judge." });
  p2.usePersonaOverlay({ mode: "append_rules", instructions: "Always speak politely." });

  assert.equal(bus.renderAmbientInstructions().includes("Werewolf Judge"), false);
  assert.equal(bus.renderAmbientInstructions().includes("Always speak politely."), true);

  // Entering foreground stage activates stage_persona and places it ahead of background overlays
  activeStagePlugin = "allow-plugin";
  const draft = await bus.assembleTurn({ channel: "task", userText: "Start game" });
  assert.equal(draft.contextBlocks[0]?.pluginId, "allow-plugin");
  assert.equal(draft.contextBlocks[0]?.text, "You are the Werewolf Judge.");
  assert.equal(draft.contextBlocks[1]?.pluginId, "ask-plugin");

  await scope.dispose();
});

