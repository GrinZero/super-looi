import { uiMessage } from "./runtime/messages";
import { bindLocale, resolveLocale, translateMessage, type LanguagePreference } from "./i18n";
import {
  cleanup,
  colorScheme,
  effect,
  lifecycle,
  locale,
  reduceMotion,
  setColorScheme,
  signal,
  Storage,
} from "nsh";
import {
  CredentialVault,
  NodeCompat,
  VoiceAudio,
  MiotLoginBrowser,
  LooiBle,
} from "super-looi/native";
import { connect } from "websocket";
import {
  VoiceRuntime,
  VoiceTaskCoordinator,
  MiotLoginFlow,
  type VoiceState,
  openRuntime,
  RobotFaceController,
  type BodyConfiguration,
  type BodyControlAction,
  type BodyStatusSnapshot,
  type HomeConfiguration,
  type HomeConnection,
  type NativeRuntime,
  type NativeStep,
  type NativeTask,
  type NativeTaskPage,
  type UiAction,
  type LlmCatalogSnapshot,
  type LlmOAuthUiEvent,
} from "./generated/looi-runtime.js";
type TraceContext = { traceId: string; parentSpanId?: string; traceName: string; sessionId?: string };

export type AppSpace =
  | "face"
  | "models"
  | "voice"
  | "home"
  | "body"
  | "tasks"
  | "settings";
export type AppearancePreference = "system" | "light" | "dark";
export type TaskApprovalMode = "ask" | "local_auto" | "yolo";

const WAKE_GUIDE_DISMISSED_KEY = "wake-guide-dismissed";
const LANGUAGE_PREFERENCE_KEY = "language-preference";
const APPEARANCE_PREFERENCE_KEY = "appearance-preference";
const TASK_APPROVAL_MODE_KEY = "task-approval-mode";

export const INITIAL_LLM_SNAPSHOT: LlmCatalogSnapshot = {
  brands: [
    {
      brandId: "openai",
      label: "OpenAI / ChatGPT",
      shortLabel: "OpenAI",
      configured: false,
      channels: [
        {
          providerId: "openai",
          label: "@looi:runtimeOfficialApiChatgptSubscription",
          baseUrl: "https://api.openai.com/v1",
          protocolLabel: "OpenAI Responses",
          authTypes: ["oauth", "api_key"],
          defaultModelId: "gpt-5.4",
          hasApiKey: false,
          hasOAuth: false,
          oauthExpiresAt: null,
          models: [],
        },
      ],
    },
    {
      brandId: "kimi",
      label: "Kimi",
      shortLabel: "Kimi",
      configured: false,
      channels: [
        {
          providerId: "kimi-coding",
          label: "@looi:runtimeKimiCodeSubscription",
          baseUrl: "https://api.kimi.com/coding/v1",
          protocolLabel: "OpenAI Chat Completions",
          authTypes: ["oauth", "api_key"],
          defaultModelId: "k3.1-pro",
          hasApiKey: false,
          hasOAuth: false,
          oauthExpiresAt: null,
          models: [],
        },
        {
          providerId: "moonshotai-cn",
          label: "@looi:runtimeMoonshotPlatformChina",
          baseUrl: "https://api.moonshot.cn/v1",
          protocolLabel: "OpenAI Chat Completions",
          authTypes: ["api_key"],
          defaultModelId: "kimi-k3.1-pro",
          hasApiKey: false,
          hasOAuth: false,
          oauthExpiresAt: null,
          models: [],
        },
        {
          providerId: "moonshotai",
          label: "@looi:runtimeMoonshotPlatformGlobal",
          baseUrl: "https://api.moonshot.ai/v1",
          protocolLabel: "OpenAI Chat Completions",
          authTypes: ["api_key"],
          defaultModelId: "kimi-k3.1-pro",
          hasApiKey: false,
          hasOAuth: false,
          oauthExpiresAt: null,
          models: [],
        },
      ],
    },
    {
      brandId: "minimax",
      label: "MiniMax",
      shortLabel: "MiniMax",
      configured: false,
      channels: [
        {
          providerId: "minimax-cn",
          label: "@looi:runtimeChinaMinimaxicom",
          baseUrl: "https://api.minimaxi.com/anthropic",
          protocolLabel: "Anthropic Messages",
          authTypes: ["api_key"],
          defaultModelId: "MiniMax-M3.1-Flash",
          hasApiKey: false,
          hasOAuth: false,
          oauthExpiresAt: null,
          models: [],
        },
        {
          providerId: "minimax",
          label: "@looi:runtimeGlobalMinimaxio",
          baseUrl: "https://api.minimax.io/anthropic",
          protocolLabel: "Anthropic Messages",
          authTypes: ["api_key"],
          defaultModelId: "MiniMax-M3.1-Flash",
          hasApiKey: false,
          hasOAuth: false,
          oauthExpiresAt: null,
          models: [],
        },
      ],
    },
    {
      brandId: "xiaomi",
      label: "@looi:runtimeXiaomiMimo",
      shortLabel: "@looi:runtimeXiaomi",
      configured: false,
      channels: [
        {
          providerId: "xiaomi",
          label: "@looi:runtimePayasyougoApi",
          baseUrl: "https://api.xiaomimimo.com/v1",
          protocolLabel: "OpenAI Chat Completions",
          authTypes: ["api_key"],
          defaultModelId: "mimo-v2.6-flash",
          hasApiKey: false,
          hasOAuth: false,
          oauthExpiresAt: null,
          models: [],
        },
        {
          providerId: "xiaomi-token-plan-cn",
          label: "@looi:runtimeTokenPlanChina",
          baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
          protocolLabel: "OpenAI Chat Completions",
          authTypes: ["api_key"],
          defaultModelId: "mimo-v2.6-flash",
          hasApiKey: false,
          hasOAuth: false,
          oauthExpiresAt: null,
          models: [],
        },
        {
          providerId: "xiaomi-token-plan-sgp",
          label: "@looi:runtimeTokenPlanSingapore",
          baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
          protocolLabel: "OpenAI Chat Completions",
          authTypes: ["api_key"],
          defaultModelId: "mimo-v2.6-flash",
          hasApiKey: false,
          hasOAuth: false,
          oauthExpiresAt: null,
          models: [],
        },
        {
          providerId: "xiaomi-token-plan-ams",
          label: "@looi:runtimeTokenPlanEurope",
          baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
          protocolLabel: "OpenAI Chat Completions",
          authTypes: ["api_key"],
          defaultModelId: "mimo-v2.6-flash",
          hasApiKey: false,
          hasOAuth: false,
          oauthExpiresAt: null,
          models: [],
        },
      ],
    },
    {
      brandId: "zai",
      label: "@looi:runtimeZhipuZai",
      shortLabel: "@looi:runtimeZhipu",
      configured: false,
      channels: [
        {
          providerId: "zai-cn",
          label: "@looi:runtimeStandardApiChinaBigmodel",
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
          protocolLabel: "OpenAI Chat Completions",
          authTypes: ["api_key"],
          defaultModelId: "glm-5.3-flash",
          hasApiKey: false,
          hasOAuth: false,
          oauthExpiresAt: null,
          models: [],
        },
        {
          providerId: "zai-intl",
          label: "@looi:runtimeStandardApiGlobalZai",
          baseUrl: "https://api.z.ai/api/paas/v4",
          protocolLabel: "OpenAI Chat Completions",
          authTypes: ["api_key"],
          defaultModelId: "glm-5.3-flash",
          hasApiKey: false,
          hasOAuth: false,
          oauthExpiresAt: null,
          models: [],
        },
        {
          providerId: "zai-coding-cn",
          label: "@looi:runtimeCodingPlanChina",
          baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
          protocolLabel: "OpenAI Chat Completions",
          authTypes: ["api_key"],
          defaultModelId: "glm-5.3-flash",
          hasApiKey: false,
          hasOAuth: false,
          oauthExpiresAt: null,
          models: [],
        },
        {
          providerId: "zai",
          label: "@looi:runtimeCodingPlanGlobal",
          baseUrl: "https://api.z.ai/api/coding/paas/v4",
          protocolLabel: "OpenAI Chat Completions",
          authTypes: ["api_key"],
          defaultModelId: "glm-5.3-flash",
          hasApiKey: false,
          hasOAuth: false,
          oauthExpiresAt: null,
          models: [],
        },
      ],
    },
    {
      brandId: "custom",
      label: "@looi:runtimeCompatibleApi",
      shortLabel: "@looi:runtimeCompatible",
      configured: false,
      channels: [
        {
          providerId: "custom",
          label: "@looi:runtimeCustomCompatibleEndpoint",
          baseUrl: "",
          protocolLabel: "@looi:runtimeSelectableProtocol",
          authTypes: ["api_key"],
          defaultModelId: "",
          hasApiKey: false,
          hasOAuth: false,
          oauthExpiresAt: null,
          models: [],
        },
      ],
    },
  ],
  active: null,
  custom: { api: "openai-completions", baseUrl: "", modelId: "" },
};

/** One owner for the surface. Credentials stay in the native vault/runtime. */
export function createAppStore() {
  const languagePreference = signal<LanguagePreference>("system");
  const effectiveLocale = () => resolveLocale(languagePreference(), locale());
  bindLocale(effectiveLocale);
  const ready = signal(false),
    busy = signal(false),
    status = signal("@looi:runtimeStandingBy"),
    message = signal(""),
    toast = signal(""),
    wakeGuideDismissed = signal(true);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const notify = (text: string) => {
    if (!alive) return;
    if (toastTimer) clearTimeout(toastTimer);
    toast.set(text);
    if (text) {
      toastTimer = setTimeout(() => {
        if (alive) toast.set("");
      }, 3200);
    }
  };
  const voiceState = signal<VoiceState>({
    phase: "idle",
    muted: false,
    wakeEnabled: true,
    transcript: "",
    error: "",
  });
  const voiceAudioLevel = signal(0);
  const voiceConfigured = signal(false);
  const voiceProviderId = signal("doubao");
  const voiceId = signal("");
  const voiceTask = signal("");
  let voice: VoiceRuntime | undefined;
  let voiceTaskCoordinator: VoiceTaskCoordinator | undefined;
  const stopVoiceSessionMotion = () => {
    voiceTask.set("");
    void runtime?.stopBody().catch(() => {});
  };
  const configuration = signal({ baseUrl: "", model: "", hasKey: false });
  const activeSpace = signal<AppSpace>("face");
  const appearancePreference = signal<AppearancePreference>("system");
  const taskApprovalMode = signal<TaskApprovalMode>("ask");
  let languagePreferenceTouched = false;
  let appearancePreferenceTouched = false;
  let taskApprovalModeTouched = false;
  let wakePreferenceTouched = false;
  let wakeGuideTouched = false;
  const llmSnapshot = signal<LlmCatalogSnapshot>(INITIAL_LLM_SNAPSHOT);
  const oauthFlow = signal<{
    running: boolean;
    providerId: string;
    kind: "idle" | "device_code" | "auth_url" | "awaiting_callback" | "progress";
    userCode: string;
    url: string;
    instructions: string;
    error: string;
  }>({
    running: false,
    providerId: "",
    kind: "idle",
    userCode: "",
    url: "",
    instructions: "",
    error: "",
  });
  let oauthAttempt = 0;

  const homeConfiguration = signal<HomeConfiguration>({
    mode: "disabled",
    haUrl: "",
    region: "cn",
    hasToken: false,
    hasMiotAccount: false,
  });
  const homeConnection = signal<HomeConnection | undefined>(undefined);
  const homeDevices = signal<Record<string, unknown>>({});
  const homeLoggingIn = signal(false);
  const canAutoStandby = () =>
    ready() &&
    lifecycle() === "active" &&
    (activeSpace() === "face" || activeSpace() === "voice") &&
    !homeLoggingIn() &&
    !oauthFlow().running;
  let homeLogin: MiotLoginFlow | undefined;
  const bodyConfiguration = signal<BodyConfiguration>({
    mode: "real_ble",
    savedDeviceId: "",
    savedDeviceName: "LOOI 桌面底座",
    autoConnect: true,
  });
  const bodyStatus = signal<BodyStatusSnapshot>({
    mode: "real_ble",
    simulation: false,
    permission: "undetermined",
    supervisorState: "disconnected",
    connected: false,
    isDocked: false,
    lightOn: false,
    headPose: "center",
    headDegrees: 55,
    deviceId: null,
    deviceName: "LOOI 桌面底座",
    autoConnect: true,
    scanning: false,
    scanCompleted: false,
    connecting: false,
    candidates: [],
    lastVerifiedAt: null,
    error: null,
  });
  const bodyActiveCommand = signal<BodyControlAction | null>(null);
  let bodyDriveOperation = 0;
  let bodyConnectionOperation = 0;
  const recoveryCount = signal(0);
  const tasks = signal<NativeTaskPage>({ total: 0, offset: 0, items: [] });
  const task = signal<NativeTask | undefined>(undefined);
  const interaction = signal<
    (NonNullable<NativeStep["interaction"]> & { taskId: string }) | undefined
  >(undefined);
  const driver = new RobotFaceController({
    onStateChange: () => face.set(driver.getState()),
  });
  const face = signal(driver.getState());
  let runtime: NativeRuntime | undefined,
    alive = true,
    sequence = 0;
  const action = (): UiAction => {
    if (!runtime) throw new Error("@looi:runtimeLocalRuntimeIsNotReady");
    const now = Date.now();
    return {
      event_id: `tap_${now}_${++sequence}`,
      ui_session_id: runtime.uiSessionId,
      kind: "tap",
      captured_at: new Date(now).toISOString(),
      expires_at: new Date(now + 10000).toISOString(),
    };
  };
  const fail = (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    message.set(text);
    notify(text);
    status.set("@looi:runtimeCouldNotCompleteTheRequest");
  };
  const stop = async () => {
    voiceTaskCoordinator?.markExternallyCancelled();
    interaction.set(undefined);
    void runtime?.stopBody().catch(() => {});
    try {
      const stopped = await runtime?.cancel();
      if (!alive) return;
      status.set(stopped?.confirmed ? "@looi:runtimeTaskStopped" : "@looi:runtimeStopResultUnverified");
    } catch (error) {
      if (alive) fail(error);
    }
  };
  effect(() => {
    const next =
      lifecycle() !== "active"
        ? "sleeping"
        : voiceState().phase === "speaking"
          ? "speaking"
          : voiceState().phase === "listening"
            ? "listening"
            : voiceState().phase === "connecting"
              ? "curious"
              : busy()
                ? "thinking"
                : "neutral";
    if (lifecycle() !== "active") {
      homeLogin?.cancel();
      void runtime?.stopBody().catch(() => {});
      if (voiceState().phase !== "idle") voice?.stop();
      if (driver.getState().expression !== "sleeping") {
        driver.setExpression("sleeping");
      }
      if (busy()) void stop();
    } else if (driver.getState().expression !== next) {
      driver.setExpression(next);
    }
  });
  effect(() => {
    if (!ready() || !voice) return;
    if (lifecycle() !== "active" || homeLoggingIn() || oauthFlow().running) {
      if (voiceState().phase !== "idle") voice.stop();
    } else if (activeSpace() !== "face" && activeSpace() !== "voice") {
      if (voiceState().phase === "standby" || voiceState().phase === "permission") voice.stop();
    } else if (voiceState().wakeEnabled && voiceState().phase === "idle") {
      void voice.enterStandby();
    }
  });
  effect(() => {
    if (lifecycle() !== "active" || reduceMotion()) return;
    const timer = setInterval(() => {
      if (!busy()) driver.triggerBlink();
    }, 4800);
    return () => clearInterval(timer);
  });
  effect(() => {
    if (
      !ready() ||
      lifecycle() !== "active" ||
      (!bodyStatus().connected && activeSpace() !== "body")
    ) {
      return;
    }
    const timer = setInterval(() => {
      if (alive && runtime && !bodyStatus().scanning) {
        bodyStatus.set(runtime.bodyStatus());
      }
    }, 250);
    return () => clearInterval(timer);
  });
  void (async () => {
    try {
      const [savedLanguage, savedAppearance, savedWakeGuide, savedTaskApprovalMode] =
        await Promise.all([
          Storage.getItem(LANGUAGE_PREFERENCE_KEY),
          Storage.getItem(APPEARANCE_PREFERENCE_KEY),
          Storage.getItem(WAKE_GUIDE_DISMISSED_KEY),
          Storage.getItem(TASK_APPROVAL_MODE_KEY),
        ]);
      if (!alive) return;
      if (
        !languagePreferenceTouched &&
        (savedLanguage === "zh-CN" || savedLanguage === "en-US")
      ) {
        languagePreference.set(savedLanguage);
      }
      if (
        !appearancePreferenceTouched &&
        (savedAppearance === "system" ||
          savedAppearance === "light" ||
          savedAppearance === "dark")
      ) {
        setColorScheme(savedAppearance);
        appearancePreference.set(savedAppearance);
      }
      if (!wakeGuideTouched) {
        wakeGuideDismissed.set(savedWakeGuide === "true");
      }
      if (
        !taskApprovalModeTouched &&
        (savedTaskApprovalMode === "ask" ||
          savedTaskApprovalMode === "local_auto" ||
          savedTaskApprovalMode === "yolo")
      ) {
        taskApprovalMode.set(savedTaskApprovalMode);
      }
      const vault = new CredentialVault();
      const opened = await openRuntime(new NodeCompat(), vault);
      if (!alive) {
        await opened.close();
        return;
      }
      runtime = opened;
      try {
        opened.attachNativeBle(new LooiBle());
      } catch {}
      bodyConfiguration.set(opened.bodyConfiguration());
      bodyStatus.set(opened.bodyStatus());
      voiceTaskCoordinator = new VoiceTaskCoordinator({
        defaultLanguage: effectiveLocale,
        runTask: async (prompt, hooks, traceContext) => {
          if (!alive || !runtime || busy() || !prompt.trim()) {
            throw new Error("@looi:runtimeATaskIsRunningTryAgainLater");
          }
          api.dismissWakeGuide();
          busy.set(true);
          message.set("");
          status.set("@looi:runtimeAgentIsThinking");
          try {
            const result = await runtime.run(
              prompt,
              action(),
              (event) => {
                if (!alive) return;
                status.set(event.summary);
                if (event.interaction && event.taskId) {
                  interaction.set({ ...event.interaction, taskId: event.taskId });
                }
                hooks.onStep(event);
              },
              {
                agentOnly: true,
                mode: "voice",
                approvalMode: taskApprovalMode(),
                traceContext,
                defaultLanguage: effectiveLocale(),
              },
            );
            if (alive) {
              message.set(result.answer);
              status.set(
                result.runtimeExited
                  ? "@looi:runtimeStandingBy"
                  : "@looi:runtimeTaskResultUnverified",
              );
            }
            return { answer: result.answer, taskId: result.taskId };
          } catch (error) {
            if (alive) {
              const text = error instanceof Error ? error.message : String(error);
              message.set(text);
              status.set("@looi:runtimeCouldNotCompleteTheRequest");
            }
            throw error;
          } finally {
            if (alive) {
              busy.set(false);
              interaction.set(undefined);
              recoveryCount.set(runtime.recoveryCount());
              bodyStatus.set(runtime.bodyStatus());
            }
          }
        },
        cancelRunningTask: async () => {
          interaction.set(undefined);
          void runtime?.stopBody().catch(() => {});
          const stopped = await runtime?.cancel();
          if (alive) {
            status.set(
              stopped?.confirmed
                ? "@looi:runtimeTaskStopped"
                : "@looi:runtimeStopResultUnverified",
            );
          }
          return Boolean(stopped?.confirmed);
        },
        onNotice: (notice) => {
          if (alive) voice?.enqueueNotice(notice);
        },
        onContextNote: (note) => {
          if (alive) voice?.setContextNote(note);
        },
      });
      voice = new VoiceRuntime({
        vault,
        defaultLanguage: effectiveLocale,
        tracer: opened.tracer,
        audio: new VoiceAudio(),
        connect,
        onState: (state) => {
          if (!alive) return;
          const previousError = voiceState().error;
          voiceState.set(state);
          if (state.phase !== "listening" && state.phase !== "speaking") {
            voiceAudioLevel.set(0);
            driver.updateAudioLevel(0);
            face.set(driver.getState());
          }
          if (state.error && state.error !== previousError) {
            notify(state.error);
          }
        },
        onAudioLevel: (level) => {
          if (alive) {
            voiceAudioLevel.set(level);
            driver.updateAudioLevel(level);
            face.set(driver.getState());
          }
        },
        taskBridge: voiceTaskCoordinator,
        cancelTask: stopVoiceSessionMotion,
        controlBody: async (actionName, durationMs) => {
          if (!alive || !runtime) {
            throw new Error("@looi:runtimeLocalRuntimeIsNotReady");
          }
          const receipt = await runtime.controlBody(
            {
              action: actionName as BodyControlAction,
              ...(durationMs !== undefined ? { durationMs } : {}),
            },
            "voice_realtime",
          );
          if (alive) bodyStatus.set(runtime.bodyStatus());
          return receipt;
        },
      });
      if (wakePreferenceTouched) {
        voice.setWakeEnabled(voiceState().wakeEnabled, { autoStandby: false });
      }
      voiceConfigured.set(voice.configuration().hasKey);
      voiceProviderId.set(voice.configuration().providerId);
      voiceId.set(voice.configuration().voiceId);
      voiceState.set(voice.snapshot());
      configuration.set(opened.configuration());
      llmSnapshot.set(opened.llmSnapshot());
      homeLogin = new MiotLoginFlow({
        runtime: opened,
        browser: () => {
          const browser = new MiotLoginBrowser();
          return {
            open: (authorization: string, redirect: string) => browser.open(authorization, redirect, effectiveLocale()),
            status: () => browser.status(),
            takeCallback: () => browser.takeCallback(),
            cancel: () => browser.cancel(),
          };
        },
        active: () => alive && lifecycle() === "active",
        onRunning: (value) => {
          if (alive) homeLoggingIn.set(value);
        },
      });
      homeConfiguration.set(opened.homeConfiguration());
      homeConnection.set(opened.homeConnection());
      recoveryCount.set(opened.recoveryCount());
      ready.set(true);
      status.set(recoveryCount() ? "@looi:runtimePreviousTaskResultUnverified" : "@looi:runtimeStandingBy");
      if (recoveryCount())
        message.set(
          uiMessage("recoveryNotice", { count: recoveryCount() }),
        );
    } catch (error) {
      if (alive) {
        status.set("@looi:runtimeLocalStorageUnavailable");
        fail(error);
      }
    }
  })();
  cleanup(() => {
    alive = false;
    if (toastTimer) clearTimeout(toastTimer);
    voiceTaskCoordinator?.markExternallyCancelled();
    homeLogin?.cancel();
    runtime?.cancelProviderOAuth();
    voice?.close();
    driver.dispose();
    void runtime?.close().catch(() => {});
  });

  const api = {
    languagePreference: () => languagePreference(),
    effectiveLocale,
    async setLanguagePreference(value: LanguagePreference) {
      languagePreferenceTouched = true;
      languagePreference.set(value);
      try {
        await Storage.setItem(LANGUAGE_PREFERENCE_KEY, value);
      } catch (error) {
        if (alive) fail(error);
      }
    },
    activeSpace: () => activeSpace(),
    openSpace(space: AppSpace) {
      if (space !== "models" && oauthFlow().running) {
        api.cancelProviderOAuth();
      }
      if (space !== "home" && homeLoggingIn()) {
        api.cancelHomeLogin();
      }
      activeSpace.set(space);
      if (space === "tasks" && ready()) {
        api.refreshTasks(0);
      }
    },
    backToFace() {
      if (oauthFlow().running) {
        api.cancelProviderOAuth();
      }
      if (homeLoggingIn()) {
        api.cancelHomeLogin();
      }
      activeSpace.set("face");
    },
    appearance: () => colorScheme(),
    appearanceMode: () => appearancePreference(),
    taskApprovalMode: () => taskApprovalMode(),
    setTaskApprovalMode(mode: TaskApprovalMode) {
      taskApprovalModeTouched = true;
      taskApprovalMode.set(mode);
      void Storage.setItem(TASK_APPROVAL_MODE_KEY, mode).catch((error) => {
        if (alive) fail(error);
      });
    },
    setAppearance(mode: AppearancePreference) {
      appearancePreferenceTouched = true;
      setColorScheme(mode);
      appearancePreference.set(mode);
      void Storage.setItem(APPEARANCE_PREFERENCE_KEY, mode).catch((error) => {
        if (alive) fail(error);
      });
    },
    llm: () => ({ ...llmSnapshot(), brands: llmSnapshot().brands.map(brand => {
      const labels = INITIAL_LLM_SNAPSHOT.brands.find(item => item.brandId === brand.brandId);
      return { ...brand, label: translateMessage(labels?.label ?? brand.label), shortLabel: translateMessage(labels?.shortLabel ?? brand.shortLabel), channels: brand.channels.map(channel => ({ ...channel, protocolLabel: translateMessage(labels?.channels.find(item => item.providerId === channel.providerId)?.protocolLabel ?? channel.protocolLabel), label: translateMessage(labels?.channels.find(item => item.providerId === channel.providerId)?.label ?? channel.label), modelsError: translateMessage(channel.modelsError ?? "") })) };
    }) }),
    oauth: () => ({ ...oauthFlow(), instructions: translateMessage(oauthFlow().instructions), error: translateMessage(oauthFlow().error) }),
    async refreshProviderModels(providerId: string) {
      if (!runtime) return;
      try {
        llmSnapshot.set(await runtime.refreshProviderModels(providerId));
      } catch {
        llmSnapshot.set(runtime.llmSnapshot());
      }
    },
    async saveProviderApiKey(
      input: Parameters<NativeRuntime["saveProviderApiKey"]>[0],
    ) {
      if (!runtime) throw new Error("@looi:runtimeLocalStorageIsNotReady");
      const snap = await runtime.saveProviderApiKey(input, action());
      llmSnapshot.set(snap);
      voiceConfigured.set(voice?.refreshCredentials(canAutoStandby()).hasKey ?? false);
      if (input.providerId !== "custom") {
        await api.refreshProviderModels(input.providerId);
      }
      configuration.set(runtime.configuration());
      status.set("@looi:runtimeStandingBy");
      notify("@looi:runtimeModelSettingsSavedAndApplied");
    },
    async selectActiveModel(
      providerId: string,
      modelId: string,
      addCustomModel?: boolean,
    ) {
      try {
        if (!runtime) throw new Error("@looi:runtimeLocalStorageIsNotReady");
        const snap = await runtime.selectActiveModel(
          { providerId, modelId, addCustomModel },
          action(),
        );
        llmSnapshot.set(snap);
        configuration.set(runtime.configuration());
        notify(uiMessage("switchedModel", { model: modelId }));
      } catch (error) {
        fail(error);
      }
    },
    async removeProviderCredential(providerId: string) {
      try {
        if (!runtime) throw new Error("@looi:runtimeLocalStorageIsNotReady");
        const snap = await runtime.removeProviderCredential(
          providerId,
          action(),
        );
        llmSnapshot.set(snap);
        voiceConfigured.set(voice?.refreshCredentials(canAutoStandby()).hasKey ?? false);
        configuration.set(runtime.configuration());
        notify("@looi:runtimeProviderCredentialsRemoved");
      } catch (error) {
        fail(error);
      }
    },
    async startProviderOAuth(providerId: string) {
      if (!runtime) {
        fail(new Error("@looi:runtimeLocalStorageIsNotReady"));
        return;
      }
      const attempt = ++oauthAttempt;
      oauthFlow.set({
        running: true,
        providerId,
        kind: "progress",
        userCode: "",
        url: "",
        instructions: "@looi:runtimeStartingAuthorization",
        error: "",
      });
      try {
        const snap = await runtime.startProviderOAuth(
          providerId,
          action(),
          (ev: LlmOAuthUiEvent) => {
            if (!alive || attempt !== oauthAttempt) return;
            const current = oauthFlow();
            if (ev.kind === "device_code") {
              oauthFlow.set({
                ...current,
                running: true,
                providerId,
                kind: "device_code",
                userCode: ev.userCode,
                url: ev.verificationUri,
                instructions: "",
                error: "",
              });
            } else if (ev.kind === "auth_url") {
              oauthFlow.set({
                ...current,
                running: true,
                providerId,
                kind: "auth_url",
                url: ev.url,
                instructions: ev.instructions ?? "",
                error: "",
              });
            } else if (ev.kind === "awaiting_callback") {
              oauthFlow.set({
                ...current,
                running: true,
                providerId,
                kind: "awaiting_callback",
                // Retain previous url from auth_url
                instructions: ev.message,
                error: "",
              });
            } else if (ev.kind === "progress") {
              oauthFlow.set({
                ...current,
                running: true,
                providerId,
                kind: "progress",
                instructions: ev.message,
                error: "",
              });
            }
          },
        );
        if (!alive || attempt !== oauthAttempt) return;
        llmSnapshot.set(snap);
        configuration.set(runtime.configuration());
        oauthFlow.set({
          running: false,
          providerId: "",
          kind: "idle",
          userCode: "",
          url: "",
          instructions: "",
          error: "",
        });
        status.set("@looi:runtimeStandingBy");
        notify("@looi:runtimeAccountAuthorized");
      } catch (error) {
        if (!alive || attempt !== oauthAttempt) return;
        const text = error instanceof Error ? error.message : String(error);
        const isCancelled = text === "@looi:runtimeSigninCancelled" || text.includes("abort");
        if (isCancelled) {
          oauthFlow.set({
            running: false,
            providerId: "",
            kind: "idle",
            userCode: "",
            url: "",
            instructions: "",
            error: "",
          });
        } else {
          oauthFlow.set({
            ...oauthFlow(),
            running: false,
            error: text,
          });
          fail(error);
        }
      }
    },
    submitProviderOAuthCallback(callbackUrl: string) {
      try {
        if (!runtime) throw new Error("@looi:runtimeLocalRuntimeIsNotReady");
        runtime.submitProviderOAuthCallback(callbackUrl);
        oauthFlow.set({ ...oauthFlow(), error: "" });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        oauthFlow.set({ ...oauthFlow(), error: text });
        notify(text);
      }
    },
    cancelProviderOAuth() {
      ++oauthAttempt;
      try {
        runtime?.cancelProviderOAuth();
      } catch {}
      oauthFlow.set({
        running: false,
        providerId: "",
        kind: "idle",
        userCode: "",
        url: "",
        instructions: "",
        error: "",
      });
    },
    voiceState: () => ({ ...voiceState(), error: translateMessage(voiceState().error) }),
    voiceAudioLevel: () => voiceAudioLevel(),
    voiceConfigured: () => voiceConfigured(),
    voiceId: () => voiceId(),
    voiceProviderId: () => voiceProviderId(),
    voiceProviderLabel: () => translateMessage(voice?.configuration().providerLabel ?? "@looi:runtimeDoubao"),
    voiceTask: () => voiceTask(),
    async startVoice() {
      api.dismissWakeGuide();
      try {
        await voice?.start();
      } catch (error) {
        fail(error);
      }
    },
    stopVoice() {
      voice?.endSession();
      void runtime?.stopBody().catch(() => {});
    },
    setWakeEnabled(enabled: boolean) {
      wakePreferenceTouched = true;
      if (!voice) {
        voiceState.update((previous) => ({ ...previous, wakeEnabled: enabled }));
        return;
      }
      try {
        voice.setWakeEnabled(enabled, {
          autoStandby: canAutoStandby(),
        });
      }
      catch (error) { fail(error); }
    },
    muteVoice(value: boolean) {
      voice?.mute(value);
    },
    interruptVoice() {
      voice?.interrupt();
      void runtime?.stopBody().catch(() => {});
    },
    configureVoice(key: string) {
      if (!voice) throw new Error("@looi:runtimeVoiceIsNotReady");
      voice.configure(key);
      voiceConfigured.set(voice.configuration().hasKey);
    },
    configureVoiceId(id: string) {
      if (!voice) throw new Error("@looi:runtimeVoiceIsNotReady");
      voice.configureVoiceId(id);
      voiceId.set(voice.configuration().voiceId);
    },
    async confirmVoiceTask(allowed: boolean): Promise<void> {
      const prompt = voiceTask();
      if (!prompt) return;
      voiceTask.set("");
      if (!allowed) return;
      await api.send(prompt, true);
    },
    ready: () => ready(),
    busy: () => busy(),
    toast: () => translateMessage(toast()),
    notify,
    wakeGuideDismissed: () => wakeGuideDismissed(),
    dismissWakeGuide() {
      if (wakeGuideTouched && wakeGuideDismissed()) return;
      wakeGuideTouched = true;
      wakeGuideDismissed.set(true);
      void Storage.setItem(WAKE_GUIDE_DISMISSED_KEY, "true").catch(fail);
    },
    status: () => translateMessage(
      busy()
        ? status()
        : voiceTask()
          ? "@looi:runtimeVoiceTaskAwaitingApproval"
          : voiceState().phase === "connecting"
            ? "@looi:runtimeConnectingLive"
            : voiceState().phase === "speaking"
              ? "@looi:runtimeLooiIsSpeaking"
              : voiceState().phase === "listening"
                ? voiceState().muted
                  ? "@looi:runtimeVoiceMuted"
                  : "@looi:runtimeListeningLive"
                : status()),
    message: () => translateMessage(message()),
    face: () => face(),
    configuration: () => configuration(),
    recoveryCount: () => recoveryCount(),
    homeConfiguration: () => homeConfiguration(),
    homeConnection: () => homeConnection(),
    homeDevices: () => homeDevices(),
    homeLoggingIn: () => homeLoggingIn(),
    cancelHomeLogin() {
      homeLogin?.cancel();
    },
    async loginMiot(region: HomeConfiguration["region"]) {
      if (!runtime || !homeLogin) throw new Error("@looi:runtimeLocalRuntimeIsNotReady");
      homeLoggingIn.set(true);
      voice?.stop();
      homeDevices.set({});
      try {
        const connection = await homeLogin.start(region, action());
        homeConnection.set(connection);
        if (connection.configured && connection.connectionId)
          homeDevices.set(await runtime.listHome());
      } finally {
        homeLoggingIn.set(false);
        if (alive) {
          homeConfiguration.set(runtime.homeConfiguration());
          homeConnection.set(runtime.homeConnection());
        }
      }
    },
    async logoutMiot() {
      if (!runtime) throw new Error("@looi:runtimeLocalRuntimeIsNotReady");
      homeLogin?.cancel();
      await runtime.logoutMiot(action());
      homeDevices.set({});
      homeConfiguration.set(runtime.homeConfiguration());
      homeConnection.set(runtime.homeConnection());
    },
    async configureHome(value: Parameters<NativeRuntime["configureHome"]>[0]) {
      homeLogin?.cancel();
      if (!runtime) throw new Error("@looi:runtimeLocalRuntimeIsNotReady");
      homeDevices.set({});
      try {
        homeConfiguration.set(await runtime.configureHome(value, action()));
      } finally {
        homeConnection.set(runtime.homeConnection());
      }
    },
    async connectHome() {
      if (!runtime) throw new Error("@looi:runtimeLocalRuntimeIsNotReady");
      homeDevices.set({});
      homeConnection.set(await runtime.connectHome());
      homeDevices.set(await runtime.listHome());
      homeConnection.set(runtime.homeConnection());
    },
    bodyConfiguration: () => bodyConfiguration(),
    bodyStatus: () => ({
      ...bodyStatus(),
      error: bodyStatus().error
        ? translateMessage(
            bodyStatus().error!.startsWith("@looi:")
              ? bodyStatus().error!
              : `@looi:${bodyStatus().error}`,
          )
        : null,
    }),
    bodyActiveCommand: () => bodyActiveCommand(),
    async configureBody(next: Partial<BodyConfiguration>) {
      if (!runtime) {
        const merged: BodyConfiguration = {
          ...bodyConfiguration(),
          ...next,
        };
        bodyConfiguration.set(merged);
        if (merged.mode === "simulation") {
          const defaultCandidates = [
            { id: "sim-looi-dock-01", name: "LOOI 桌面底座", rssi: -42 },
            { id: "sim-looi-bedroom-02", name: "卧室的 LOOI", rssi: -65 },
          ];
          bodyStatus.update((prev) => ({
            ...prev,
            mode: "simulation",
            simulation: true,
            permission: "granted",
            supervisorState: "ready",
            connected: true,
            isDocked: true,
            deviceId: merged.savedDeviceId || defaultCandidates[0].id,
            deviceName: merged.savedDeviceName || defaultCandidates[0].name,
            autoConnect: merged.autoConnect,
            scanning: false,
            scanCompleted: true,
            connecting: false,
            candidates: defaultCandidates,
            error: null,
          }));
        } else {
          bodyStatus.update((prev) => ({
            ...prev,
            mode: merged.mode,
            simulation: false,
            connected: false,
            isDocked: false,
            autoConnect: merged.autoConnect,
            scanning: false,
            scanCompleted: false,
            connecting: false,
            candidates: [],
            error: null,
          }));
        }
        return;
      }
      try {
        const snap = await runtime.configureBody(next, action());
        if (alive) {
          bodyConfiguration.set(runtime.bodyConfiguration());
          bodyStatus.set(snap);
        }
      } catch (error) {
        if (alive) fail(error);
      }
    },
    async scanBodyDevices(durationMs = 8000) {
      if (bodyStatus().scanning || runtime?.bodyStatus().scanning) return;
      if (!runtime) {
        if (bodyStatus().mode === "simulation") {
          bodyStatus.update((prev) => ({
            ...prev,
            scanning: false,
            scanCompleted: true,
            candidates: [
              { id: "sim-looi-dock-01", name: "LOOI 桌面底座", rssi: -42 },
              { id: "sim-looi-bedroom-02", name: "卧室的 LOOI", rssi: -65 },
            ],
          }));
        }
        return;
      }
      bodyStatus.update((prev) => ({ ...prev, scanning: true, error: null }));
      try {
        await runtime.scanBodyDevices(durationMs);
        if (alive) {
          const current = runtime.bodyStatus();
          bodyStatus.set(current);
          if (current.error) notify(current.error);
        }
      } catch (error) {
        if (alive) {
          bodyStatus.set(runtime.bodyStatus());
          fail(error);
        }
      }
    },
    async connectBodyDevice(target?: { deviceId?: string; deviceName?: string }) {
      if (!target?.deviceId && bodyStatus().connecting) return;
      const operation = ++bodyConnectionOperation;
      if (!runtime) {
        if (bodyStatus().mode === "simulation") {
          const nextId = target?.deviceId || bodyStatus().deviceId || "sim-looi-dock-01";
          const nextName = target?.deviceName || bodyStatus().deviceName || "LOOI 桌面底座";
          bodyConfiguration.update((prev) => ({
            ...prev,
            savedDeviceId: nextId,
            savedDeviceName: nextName,
          }));
          bodyStatus.update((prev) => ({
            ...prev,
            connected: true,
            isDocked: true,
            supervisorState: "ready",
            connecting: false,
            deviceId: nextId,
            deviceName: nextName,
            error: null,
          }));
        }
        return;
      }
      bodyStatus.update((prev) => ({ ...prev, connecting: true, error: null }));
      try {
        await runtime.connectBodyDevice(target);
        if (alive && operation === bodyConnectionOperation) {
          bodyConfiguration.set(runtime.bodyConfiguration());
          const current = runtime.bodyStatus();
          bodyStatus.set(current);
          if (current.error) notify(current.error);
        }
      } catch (error) {
        if (alive && operation === bodyConnectionOperation) {
          bodyStatus.set(runtime.bodyStatus());
          fail(error);
        }
      }
    },
    async disconnectBody() {
      const operation = ++bodyConnectionOperation;
      if (!runtime) {
        bodyActiveCommand.set(null);
        bodyStatus.update((prev) => ({
          ...prev,
          connected: false,
          isDocked: false,
          supervisorState: "disconnected",
        }));
        return;
      }
      try {
        await runtime.disconnectBody();
        if (alive && operation === bodyConnectionOperation) {
          bodyActiveCommand.set(null);
          bodyStatus.set(runtime.bodyStatus());
        }
      } catch (error) {
        if (alive && operation === bodyConnectionOperation) fail(error);
      }
    },
    async forgetSavedDock() {
      const operation = ++bodyConnectionOperation;
      if (!runtime) {
        bodyActiveCommand.set(null);
        bodyConfiguration.update((prev) => ({
          ...prev,
          savedDeviceId: "",
          savedDeviceName: "LOOI 桌面底座",
        }));
        bodyStatus.update((prev) => ({
          ...prev,
          connected: false,
          isDocked: false,
          connecting: false,
          supervisorState: "disconnected",
          deviceId: null,
          deviceName: "LOOI 桌面底座",
          error: null,
        }));
        return;
      }
      try {
        await runtime.forgetSavedDock();
        if (alive && operation === bodyConnectionOperation) {
          bodyActiveCommand.set(null);
          bodyConfiguration.set(runtime.bodyConfiguration());
          bodyStatus.set(runtime.bodyStatus());
        }
      } catch (error) {
        if (alive && operation === bodyConnectionOperation) fail(error);
      }
    },
    setSimulatedDock(docked: boolean) {
      if (!runtime) {
        bodyStatus.update((prev) => ({
          ...prev,
          isDocked: docked,
          supervisorState: docked ? "ready" : "connected_unarmed",
        }));
        return;
      }
      try {
        const snap = runtime.setSimulatedDock(docked);
        if (alive) bodyStatus.set(snap);
      } catch (error) {
        if (alive) fail(error);
      }
    },
    async controlBody(actionName: BodyControlAction, durationMs?: number, headDegrees?: number) {
      if (!runtime) {
        if (actionName === "head_set" && headDegrees !== undefined) {
          bodyStatus.update((prev) => ({
            ...prev,
            headPose: headDegrees === 85 ? "up" : headDegrees === 55 ? "center" : headDegrees === 25 ? "down" : "custom",
            headDegrees,
          }));
          return;
        }
        if (
          actionName === "head_up" ||
          actionName === "head_center" ||
          actionName === "head_down"
        ) {
          const pose =
            actionName === "head_up"
              ? "up"
              : actionName === "head_down"
                ? "down"
                : "center";
          const deg = pose === "up" ? 85 : pose === "down" ? 25 : 55;
          bodyStatus.update((prev) => ({
            ...prev,
            headPose: pose,
            headDegrees: deg,
          }));
        } else if (actionName === "light_on" || actionName === "light_off") {
          bodyStatus.update((prev) => ({
            ...prev,
            lightOn: actionName === "light_on",
          }));
        }
        return;
      }
      const isWheelMove =
        actionName === "forward" ||
        actionName === "backward" ||
        actionName === "turn_left" ||
        actionName === "turn_right";
      if (isWheelMove) {
        bodyActiveCommand.set(actionName);
      }
      try {
        const receipt = await runtime.controlBody({
          action: actionName,
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(headDegrees !== undefined ? { headDegrees } : {}),
        });
        if (alive) {
          bodyStatus.set(runtime.bodyStatus());
          if (receipt.status !== "verified" && receipt.reason) {
            if (receipt.reason !== "Pulse preempted by stop: user_stop") notify(receipt.reason);
          }
        }
      } catch (error) {
        if (alive) fail(error);
      } finally {
        if (alive && isWheelMove && bodyActiveCommand() === actionName) {
          bodyActiveCommand.set(null);
        }
      }
    },
    async stopBody() {
      ++bodyDriveOperation;
      bodyActiveCommand.set(null);
      if (!runtime) return;
      try {
        const snap = await runtime.stopBody();
        if (alive) bodyStatus.set(snap);
      } catch {}
    },
    async startBodyDrive(action: "forward" | "backward" | "turn_left" | "turn_right") {
      if (!runtime) return false;
      const operation = ++bodyDriveOperation;
      bodyActiveCommand.set(action);
      try {
        const snap = await runtime.startBodyDrive(action);
        if (operation !== bodyDriveOperation) {
          if (bodyActiveCommand() === null) await runtime.stopBody();
          return false;
        }
        if (alive) bodyStatus.set(snap);
        return true;
      } catch (error) {
        if (operation === bodyDriveOperation) {
          if (alive) fail(error);
          bodyActiveCommand.set(null);
        }
        return false;
      }
    },
    renewBodyDrive() {
      const renewed = runtime?.renewBodyDrive() ?? false;
      if (!renewed) {
        bodyActiveCommand.set(null);
        if (alive && runtime) bodyStatus.set(runtime.bodyStatus());
      }
      return renewed;
    },
    tasks: () => tasks(),
    task: () => task(),
    refreshTasks(offset = 0) {
      if (!runtime) return;
      try {
        tasks.set(runtime.taskPage(offset));
        recoveryCount.set(runtime.recoveryCount());
        task.set(undefined);
      } catch (error) {
        fail(error);
      }
    },
    inspectTask(id: string) {
      if (!runtime) return;
      try {
        task.set(runtime.taskDetails(id));
      } catch (error) {
        fail(error);
      }
    },
    closeTask() {
      task.set(undefined);
    },
    newConversation() {
      if (!runtime || busy()) return false;
      try {
        runtime.newConversation(action());
        message.set("");
        notify("@looi:runtimeNewConversationStarted");
        status.set("@looi:runtimeStandingBy");
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    interaction: () => interaction(),
    async configure(value: { baseUrl: string; model: string; apiKey: string }) {
      if (!runtime) throw new Error("@looi:runtimeLocalStorageIsNotReady");
      await runtime.configure(value);
      configuration.set(runtime.configuration());
      llmSnapshot.set(runtime.llmSnapshot());
      status.set("@looi:runtimeStandingBy");
      notify("@looi:runtimeModelConfigured");
    },
    async send(prompt: string, agentOnly = false, traceContext?: TraceContext) {
      if (busy() || !runtime || !prompt.trim()) return false;
      api.dismissWakeGuide();
      busy.set(true);
      message.set("");
      status.set("@looi:runtimeAgentIsThinking");
      try {
        const result = await runtime.run(
          prompt,
          action(),
          (event) => {
            if (!alive) return;
            status.set(event.summary);
            if (event.interaction && event.taskId)
              interaction.set({ ...event.interaction, taskId: event.taskId });
          },
          { agentOnly, mode: agentOnly ? "voice" : "text", approvalMode: taskApprovalMode(), traceContext, defaultLanguage: effectiveLocale() },
        );
        if (alive) {
          message.set(result.answer);
          status.set(result.runtimeExited ? "@looi:runtimeStandingBy" : "@looi:runtimeTaskResultUnverified");
        }
        return true;
      } catch (error) {
        if (alive) fail(error);
        return false;
      } finally {
        if (alive) {
          busy.set(false);
          interaction.set(undefined);
          recoveryCount.set(runtime.recoveryCount());
          bodyStatus.set(runtime.bodyStatus());
        }
      }
    },
    approve(allowed: boolean) {
      const current = interaction();
      if (!current || !runtime) return;
      try {
        runtime.respond(current.taskId, current.id, {
          outcome: allowed ? "allowed-once" : "rejected",
          userAction: allowed ? action() : undefined,
        });
        interaction.set(undefined);
      } catch (error) {
        fail(error);
      }
    },
    answer(
      answers: Array<{ id: string; selected: string[]; custom?: string }>,
    ) {
      const current = interaction();
      if (!current || !runtime) return;
      try {
        runtime.respond(current.taskId, current.id, { answers });
        interaction.set(undefined);
      } catch (error) {
        fail(error);
      }
    },
    stop,
  };
  return api;
}
