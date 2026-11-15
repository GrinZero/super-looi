import { cleanup, locale, mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { BackHandler } from "nsh/mobile";
import { DeviceCameraHost, LanRoomHost } from "super-looi/native";
import { RobotFaceController } from "../../packages/looi-runtime/src/ui/robot-face-controller";
import type { VoiceState } from "./generated/looi-runtime.js";
import { bindLocale, resolveLocale } from "./i18n";
import { visionPersonTrackerDefinition } from "./plugins/vision-person-tracker/runtime/index";
import { werewolfJudgeDefinition } from "./plugins/werewolf-judge/runtime/index";
import { DualLoopAiBus } from "./runtime/plugins/ai-bus";
import type {
  EffectScope,
  LanHttpRequest,
  LanHttpResponse,
  PluginContext,
  PluginDefinition,
  PluginFailure,
  PluginLanRoomCapability,
  PluginLifecycleState,
  PluginManifest,
  PluginRuntime,
  PluginStorage,
  PluginVisionCapability,
} from "./runtime/plugins/contracts";
import { createEffectScope } from "./runtime/plugins/effect-scope";
import { FaceDriverHub } from "./runtime/plugins/embodied-drivers";
import {
  PluginServiceBroker,
  validateAndSortPluginTopology,
} from "./runtime/plugins/service-registry";
import type {
  PluginSnapshot,
  PluginStagePresentation,
} from "./runtime/plugins/shared-types";
import { PluginStageManager } from "./runtime/plugins/stage-manager";
import type { createAppStore } from "./store";
import {
  clearDynamicFaceRecipe,
  registerDynamicFaceRecipe,
} from "./ui/face-recipes";
import { PluginsContextBar, PluginsSpaceView } from "./ui/PluginsSpaceView";
import "./ui/plugins/registry";
import type { PluginViewContext } from "./ui/plugins/ui-contracts";
import { RetainedPage } from "./ui/RetainedPage";
import { MorphableStage } from "./ui/stage/MorphableStage";

if (typeof globalThis.structuredClone !== "function") {
  (globalThis as { structuredClone?: <T>(value: T) => T }).structuredClone = <T,>(
    value: T,
  ): T => (value === undefined ? undefined : JSON.parse(JSON.stringify(value))) as T;
}

function createProbeVisionCapability(
  nativeCamera: DeviceCameraHost,
  defaultScope: EffectScope,
): PluginVisionCapability {
  let seqCounter = 0;
  const fallbackFaces = [
    {
      trackId: 1,
      offsetX: 0.04,
      offsetY: 0.0,
      width: 0.28,
      height: 0.34,
      confidence: 0.96,
    },
  ] as const;

  return {
    permissionStatus: () => "granted",
    requestPermission: async () => "granted",
    subscribeFrames: async (options, onFrame) => {
      const targetScope = options.scope ?? defaultScope;
      if (!targetScope.active) {
        throw new Error("[stage=vision.subscribeFrames code=ERR_PLUGIN_SCOPE_DISPOSED] Scope already disposed");
      }
      const sessionId = `probe_cam_${++seqCounter}`;
      const maxDim = options.maxDimension ?? 320;
      const maxFps = options.maxFps ?? 25;
      await nativeCamera.openSample(options.facing, maxDim, maxFps, sessionId);
      if (!targetScope.active) {
        try {
          nativeCamera.closeSession(sessionId);
        } catch {}
        throw new Error("[stage=vision.subscribeFrames code=ERR_PLUGIN_SCOPE_DISPOSED] Scope disposed while opening sample stream");
      }
      let active = true;
      let lastSeq = 0;
      let inFlight = false;
      let timerLoop: ReturnType<typeof setTimeout> | undefined;
      const intervalMs = Math.max(80, Math.round(1000 / Math.max(1, maxFps)));

      const scheduleNext = () => {
        if (!active) return;
        timerLoop = setTimeout(() => {
          emitSample();
          scheduleNext();
        }, intervalMs);
      };

      const emitSample = () => {
        if (!active || inFlight) return;
        inFlight = true;
        void nativeCamera
          .captureFrame(sessionId, maxDim, lastSeq)
          .then((raw) => {
            if (!active) return;
            lastSeq = raw.seq;
            const rawFaces = (raw as { faces?: typeof fallbackFaces; facesJson?: string }).faces;
            let faces =
              Array.isArray(rawFaces) && rawFaces.length > 0 ? rawFaces : fallbackFaces;
            const rawJson = (raw as { facesJson?: string }).facesJson;
            if (typeof rawJson === "string" && rawJson.length > 2) {
              try {
                const parsed = JSON.parse(rawJson);
                if (Array.isArray(parsed) && parsed.length > 0) faces = parsed;
              } catch {}
            }
            void onFrame({
              jpeg: raw.jpeg,
              width: raw.width,
              height: raw.height,
              facing: options.facing,
              capturedAtMs:
                typeof (raw as { capturedAtMs?: number }).capturedAtMs === "number"
                  ? (raw as { capturedAtMs: number }).capturedAtMs
                  : Date.now(),
              faces,
            });
          })
          .catch(() => {})
          .finally(() => {
            inFlight = false;
          });
      };
      const timerA = setTimeout(emitSample, 15);
      const timerB = setTimeout(emitSample, 45);
      scheduleNext();

      const stop = () => {
        if (!active) return;
        active = false;
        clearTimeout(timerA);
        clearTimeout(timerB);
        if (timerLoop !== undefined) clearTimeout(timerLoop);
        try {
          nativeCamera.closeSession(sessionId);
        } catch {}
      };
      const detach = targetScope.onDispose(stop);
      return {
        previewSessionId: sessionId,
        close: () => {
          detach();
          stop();
        },
      };
    },
    captureFrame: async (options) => {
      const sessionId = `probe_snap_${++seqCounter}`;
      const maxDim = options.maxDimension ?? 320;
      await nativeCamera.openSample(options.facing, maxDim, 25, sessionId);
      try {
        const raw = await nativeCamera.captureFrame(sessionId, maxDim, 0);
        const rawFaces = (raw as { faces?: typeof fallbackFaces }).faces;
        return {
          jpeg: raw.jpeg,
          width: raw.width,
          height: raw.height,
          facing: options.facing,
          capturedAtMs:
            typeof (raw as { capturedAtMs?: number }).capturedAtMs === "number"
              ? (raw as { capturedAtMs: number }).capturedAtMs
              : Date.now(),
          faces: Array.isArray(rawFaces) && rawFaces.length > 0 ? rawFaces : fallbackFaces,
        };
      } finally {
        try {
          nativeCamera.closeSession(sessionId);
        } catch {}
      }
    },
  };
}

function createProbeLanCapability(
  nativeLan: LanRoomHost,
  defaultScope: EffectScope,
): PluginLanRoomCapability {
  let roomCounter = 0;
  return {
    openRoom: async (options) => {
      const targetScope = options.scope ?? defaultScope;
      if (!targetScope.active) {
        throw new Error("[stage=lan.openRoom code=ERR_PLUGIN_SCOPE_DISPOSED] Scope already disposed");
      }
      const requestedId = `probe_lan_${++roomCounter}`;
      let info = await nativeLan.openRoom(requestedId);
      if (!targetScope.active) {
        try {
          nativeLan.closeRoom(info.roomId);
        } catch {}
        throw new Error("[stage=lan.openRoom code=ERR_PLUGIN_SCOPE_DISPOSED] Scope disposed while opening LAN room");
      }
      let closed = false;

      void (async () => {
        while (!closed) {
          try {
            const rawReq = await nativeLan.nextRequest(info.roomId);
            if (closed) break;
            let query: Record<string, string> = {};
            let headers: Record<string, string> = {};
            try {
              query = JSON.parse(rawReq.queryJson || "{}");
            } catch {}
            try {
              headers = JSON.parse(rawReq.headersJson || "{}");
            } catch {}
            const req: LanHttpRequest = {
              method: rawReq.method.toUpperCase() === "POST" ? "POST" : "GET",
              path: rawReq.path || "/",
              query,
              headers,
              bodyText: rawReq.bodyText ?? "",
              remoteAddr: rawReq.remoteAddr ?? "",
            };
            const res: LanHttpResponse = await options.onRequest(req);
            if (!closed) {
              nativeLan.respondRequest(
                info.roomId,
                rawReq.requestId,
                res.status,
                res.contentType || "application/json; charset=utf-8",
                res.cacheControl ?? "no-store",
                res.body ?? "",
              );
            }
          } catch {
            break;
          }
        }
      })();

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          nativeLan.closeRoom(info.roomId);
        } catch {}
      };
      const detach = targetScope.onDispose(close);

      return {
        get roomId() {
          return info.roomId;
        },
        get port() {
          return info.port;
        },
        get lanIpv4() {
          return info.lanIpv4 ?? null;
        },
        get baseUrl() {
          return info.baseUrl;
        },
        notifyRevision: (revision: number) => {
          if (!closed) nativeLan.notifyRevision(info.roomId, revision);
        },
        refreshAddresses: () => {
          if (!closed) {
            info = nativeLan.refreshAddresses(info.roomId);
          }
          return {
            lanIpv4: info.lanIpv4 ?? null,
            baseUrl: info.baseUrl,
          };
        },
        close: async () => {
          detach();
          close();
        },
      };
    },
  };
}

interface ProbeManagedEntry {
  definition: PluginDefinition<any, any>;
  manifest: PluginManifest;
  storage: PluginStorage;
  enabled: boolean;
  lifecycle: PluginLifecycleState;
  state: Record<string, unknown>;
  lastError?: PluginFailure;
  scope?: EffectScope;
  runtime?: PluginRuntime<any, any>;
}

function createInMemoryStorage(): PluginStorage {
  const kv = new Map<string, string>();
  return {
    get: <T = unknown>(key: string): T | undefined => {
      const raw = kv.get(key);
      return raw !== undefined ? (JSON.parse(raw) as T) : undefined;
    },
    set: <T = unknown>(key: string, value: T) => {
      kv.set(key, JSON.stringify(value));
    },
    delete: (key: string) => {
      kv.delete(key);
    },
    entries: () => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of kv.entries()) out[k] = JSON.parse(v);
      return out;
    },
  };
}

function WerewolfStageProbeApp() {
  const effectiveLocale = () => resolveLocale("zh-CN", locale());
  bindLocale(effectiveLocale);

  const activeSpace = signal<"face" | "plugins">("face");
  const inspectedPluginId = signal<string | null>(null);
  const pluginBusy = signal<string | null>(null);
  const pluginUiErrors = signal<Record<string, string>>({});
  const toast = signal("");
  const composeOpen = signal(false);
  const composeDraft = signal("");

  const driver = new RobotFaceController({
    onStateChange: () => face.set(driver.getState()),
  });
  driver.attachRecipeSyncBridge((id, recipe) => {
    if (recipe) {
      registerDynamicFaceRecipe(id, recipe);
    } else {
      clearDynamicFaceRecipe(id);
    }
  });
  const face = signal(driver.getState());
  const faceHub = new FaceDriverHub();
  faceHub.attachController(driver);

  const nativeCamera = new DeviceCameraHost();
  nativeCamera.setForeground(true);
  const nativeLan = new LanRoomHost();
  nativeLan.setForeground(true);

  const definitions: PluginDefinition<any, any>[] = [
    visionPersonTrackerDefinition(),
    werewolfJudgeDefinition({
      nightIntroDelayMs: 60,
      speakerTickMs: 0,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 40))),
    }),
  ];

  const topology = validateAndSortPluginTopology(definitions.map((d) => d.manifest));
  const entries = new Map<string, ProbeManagedEntry>();
  const activeStage = signal<{
    pluginId: string;
    revision?: number;
    presentation: PluginStagePresentation;
  } | null>(null);
  const plugins = signal<PluginSnapshot[]>([]);

  let stageManager!: PluginStageManager;
  const aiBus = new DualLoopAiBus(() => stageManager?.activePluginId() ?? null);
  const services = new PluginServiceBroker(
    topology,
    async () => {},
    () => {},
  );

  const rebuildSnapshots = () => {
    const list: PluginSnapshot[] = [];
    for (const id of topology.bootOrder) {
      const entry = entries.get(id)!;
      const m = entry.manifest;
      list.push({
        id: m.id,
        name: m.name["zh-CN"],
        description: m.summary["zh-CN"],
        version: m.version,
        source: "builtin",
        category: m.category,
        manifest: m,
        enabled: entry.enabled,
        lifecycle: entry.lifecycle,
        dependencies: services.inspectDependencies(m),
        configuration: {},
        state: structuredClone(entry.state),
        lastError: entry.lastError,
        stagePresentation: stageManager?.presentationForPlugin(m.id),
      });
    }
    plugins.set(list);
  };

  stageManager = new PluginStageManager((pluginId, presentation, revision) => {
    activeStage.set(
      pluginId && presentation
        ? {
            pluginId,
            ...(revision !== undefined ? { revision } : {}),
            presentation,
          }
        : null,
    );
    aiBus.notifyStageChanged();
    rebuildSnapshots();
  });

  const mountAndStartEntry = async (entry: ProbeManagedEntry) => {
    if (!entry.enabled) return;
    if (entry.runtime && entry.scope?.active && entry.lifecycle === "active") return;
    const scope = createEffectScope(`plugin:${entry.manifest.id}`, entry.manifest.id);
    entry.scope = scope;
    const ctx: PluginContext<any> = {
      manifest: entry.manifest,
      scope,
      forkScope: (label) => scope.fork(label),
      services: services.createScopedRegistry(entry.manifest, scope),
      storage: entry.storage,
      enabled: () => entry.enabled,
      lifecycle: () => entry.lifecycle,
      ensureStarted: async () => {
        await mountAndStartEntry(entry);
      },
      getState: () => structuredClone(entry.state),
      setState: (updater) => {
        entry.state =
          typeof updater === "function"
            ? structuredClone(updater(structuredClone(entry.state)))
            : structuredClone(updater);
        rebuildSnapshots();
      },
      getAuth: () => undefined,
      setAuth: () => {},
      getLastError: () => entry.lastError,
      setLastExecution: () => {},
      setLastError: (f) => {
        entry.lastError = f;
        rebuildSnapshots();
      },
      stage: stageManager.createScopedCapability(entry.manifest, scope),
      ai: aiBus.createScopedCapability(entry.manifest, scope),
      face: faceHub.createCapability(entry.manifest, scope),
      vision: entry.manifest.permissions.includes("camera.front")
        ? createProbeVisionCapability(nativeCamera, scope)
        : undefined,
      lan: entry.manifest.permissions.includes("network.lan_room")
        ? createProbeLanCapability(nativeLan, scope)
        : undefined,
    };
    entry.runtime = entry.definition.create(ctx);
    await entry.runtime.start?.();
    entry.lifecycle = "active";
    rebuildSnapshots();
  };

  for (const id of topology.bootOrder) {
    const def = definitions.find((d) => d.manifest.id === id)!;
    const storage = createInMemoryStorage();
    entries.set(id, {
      definition: def,
      manifest: def.manifest,
      storage,
      enabled: true,
      lifecycle: "registered",
      state: structuredClone((def.initialState(storage) ?? {}) as Record<string, unknown>),
    });
  }
  rebuildSnapshots();

  let probeDisposed = false;

  void (async () => {
    for (const id of topology.bootOrder) {
      if (probeDisposed) break;
      await mountAndStartEntry(entries.get(id)!);
    }
  })();

  cleanup(() => {
    probeDisposed = true;
    for (const id of [...topology.bootOrder].reverse()) {
      const entry = entries.get(id);
      void entry?.runtime?.stop?.();
      void entry?.scope?.dispose();
    }
    try {
      nativeCamera.stopAll();
      nativeCamera.dispose();
    } catch {}
    try {
      nativeLan.stopAll();
      nativeLan.dispose();
    } catch {}
    driver.dispose();
  });

  const contexts = new Map<string, PluginViewContext<any, any>>();
  const setUiError = (id: string, err: string) => {
    pluginUiErrors.update((prev) => {
      const next = { ...prev };
      if (err) next[id] = err;
      else delete next[id];
      return next;
    });
  };

  const getPluginViewContext = <TState = Record<string, unknown>, TCommand = unknown>(
    id: string,
  ): PluginViewContext<TState, TCommand> => {
    let ctx = contexts.get(id);
    if (!ctx) {
      const snap = () => plugins().find((item) => item.id === id);
      ctx = {
        pluginId: id,
        manifest: () => snap()!.manifest!,
        state: () => (snap()?.state ?? {}) as TState,
        configuration: () => snap()?.configuration ?? {},
        enabled: () => snap()?.enabled ?? false,
        lifecycle: () => snap()?.lifecycle ?? "stopped",
        dependencies: () => snap()?.dependencies ?? [],
        busy: () => pluginBusy() === id,
        uiError: () => pluginUiErrors()[id] ?? "",
        auth: () => snap()?.auth,
        lastExecution: () => snap()?.lastExecution,
        lastError: () => snap()?.lastError,
        stagePresentation: () => snap()?.stagePresentation,
        locale: () => effectiveLocale(),
        sendCommand: async <TResult = unknown>(command: TCommand) => {
          const entry = entries.get(id);
          if (!entry) return undefined;
          pluginBusy.set(id);
          setUiError(id, "");
          try {
            await mountAndStartEntry(entry);
            const result = await entry.runtime?.handleCommand?.(command);
            return result as TResult;
          } catch (error) {
            setUiError(id, error instanceof Error ? error.message : String(error));
            return undefined;
          } finally {
            rebuildSnapshots();
            pluginBusy.set(null);
          }
        },
        configure: async (values) => {
          const entry = entries.get(id);
          if (!entry) return;
          pluginBusy.set(id);
          setUiError(id, "");
          try {
            await mountAndStartEntry(entry);
            await entry.runtime?.configure?.(values);
          } catch (error) {
            setUiError(id, error instanceof Error ? error.message : String(error));
          } finally {
            rebuildSnapshots();
            pluginBusy.set(null);
          }
        },
        refresh: async () => {
          const entry = entries.get(id);
          await entry?.runtime?.refresh?.();
          rebuildSnapshots();
        },
        beginLogin: async () => {},
        cancelLogin: async () => {},
        logout: async () => {},
        notify: (msg: string) => toast.set(msg),
        exitStage: () => {
          stageManager.exitPluginStage(id);
          rebuildSnapshots();
        },
        openStage: () => {
          activeSpace.set("face");
        },
        openPluginSettings: () => {
          activeSpace.set("plugins");
          inspectedPluginId.set(id);
        },
      };
      contexts.set(id, ctx);
    }
    return ctx as PluginViewContext<TState, TCommand>;
  };

  const storeShim = {
    plugins: () => plugins(),
    inspectedPluginId: () => inspectedPluginId(),
    setInspectedPluginId: (id: string | null) => inspectedPluginId.set(id),
    pluginBusy: () => pluginBusy(),
    effectiveLocale,
    setPluginEnabled: async (id: string, enabled: boolean) => {
      const entry = entries.get(id);
      if (!entry) return;
      pluginBusy.set(id);
      try {
        entry.enabled = enabled;
        if (enabled) {
          await mountAndStartEntry(entry);
        } else {
          stageManager.exitPluginStage(id);
          await entry.runtime?.stop?.();
          await entry.scope?.dispose();
          entry.runtime = undefined;
          entry.scope = undefined;
          entry.lifecycle = "stopped";
        }
      } finally {
        rebuildSnapshots();
        pluginBusy.set(null);
      }
    },
    pluginViewContext: getPluginViewContext,
  } as unknown as ReturnType<typeof createAppStore>;

  const voiceState = signal<VoiceState>({
    phase: "idle",
    muted: false,
    wakeEnabled: false,
    transcript: "",
    error: "",
  });

  BackHandler.on("press", () => {
    const currentStage = activeStage();
    if (activeSpace() === "face" && currentStage) {
      stageManager.exitPluginStage(currentStage.pluginId);
      return true;
    }
    if (activeSpace() === "plugins" && inspectedPluginId()) {
      inspectedPluginId.set(null);
      return true;
    }
    if (activeSpace() !== "face") {
      activeSpace.set("face");
      return true;
    }
    return false;
  });

  return (
    <View
      class={
        activeSpace() === "face" ? "flex-1 bg-stage-bg" : "flex-1 bg-background"
      }
    >
      <RetainedPage active={activeSpace() === "face"}>
        <MorphableStage
          active={activeSpace() === "face"}
          ready={true}
          busy={false}
          faceState={face()}
          statusText="陪伴待机"
          toastText={toast()}
          voiceState={voiceState()}
          voiceAudioLevel={0}
          voiceProviderLabel="豆包语音"
          wakeGuideDismissed={true}
          responseText=""
          composeOpen={composeOpen()}
          composeDraft={composeDraft()}
          activeStage={activeStage()}
          getPluginViewContext={getPluginViewContext}
          onToggleVoice={() => {}}
          onToggleCompose={() => composeOpen.set(!composeOpen())}
          onChangeDraft={(val) => composeDraft.set(val)}
          onSubmitDraft={() => composeOpen.set(false)}
          onOpenSettings={() => activeSpace.set("plugins")}
          onOpenResponse={() => {}}
          onExitStage={(id) => {
            stageManager.exitPluginStage(id);
            rebuildSnapshots();
          }}
          onReportStageCrash={(id, slot, error) => {
            stageManager.exitPluginStage(id);
            toast.set(`舞台熔断:${id}:${slot}:${String(error)}`);
          }}
        />
      </RetainedPage>
      <RetainedPage active={activeSpace() !== "face"}>
        <View class="flex-1 bg-background px-4 py-2.5 gap-2.5">
          <View class="h-11 flex-row items-center justify-between gap-3">
            <Button
              testID="back-to-face"
              onPress={() => activeSpace.set("face")}
              class="min-h-11 px-3 rounded-xl bg-muted border border-border items-center justify-center"
            >
              <Text class="text-foreground text-xs font-semibold">返回陪伴</Text>
            </Button>
            <Button
              testID="nav-plugins"
              onPress={() => {
                activeSpace.set("plugins");
                inspectedPluginId.set(null);
              }}
              class="min-h-11 px-3 rounded-xl bg-primary items-center justify-center"
            >
              <Text class="text-primary-foreground text-xs font-bold">插件</Text>
            </Button>
            <PluginsContextBar store={storeShim} />
          </View>
          <PluginsSpaceView store={storeShim} />
        </View>
      </RetainedPage>
    </View>
  );
}

mount(WerewolfStageProbeApp);
