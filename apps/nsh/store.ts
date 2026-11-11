import { VideoAccount, type XiaomiVideoLoginState, type XiaomiVideoAuthState } from "./runtime/video-account";
import type { CameraVideoState } from "./ui/CameraVideo";
export type { XiaomiVideoLoginStep, XiaomiVideoLoginState, XiaomiVideoAuthState } from "./runtime/video-account";
import { uiMessage } from "./runtime/messages";
import { HomePowerState } from "./runtime/home-power-state";
import { bindLocale, resolveLocale, translateMessage, type LanguagePreference } from "./i18n";
import {
  cleanup,
  colorScheme,
  computed,
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
  XiaomiCameraHost,
  LooiBle,
} from "super-looi/native";
import { connect } from "websocket";
import {
  utf8Tail,
  type NativeShellOutput,
  VoiceRuntime,
  VoiceTaskCoordinator,
  MiotLoginFlow,
  type VoiceState,
  openRuntime,
  RobotFaceController,
  type BodyConfiguration,
  type BodyControlAction,
  type BodyStatusSnapshot,
  type HomeAppliance,
  type HomeConfiguration,
  type HomeConnection,
  type HomeDashboardModel,
  type HomeRoomSection,
  type HomeSourceId,
  type TileSpan,
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

export type HomeSubView = "devices" | "services" | "video_login";

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
  const voiceTaskRunning = signal(false);
  const foregroundBusy = computed(() => busy() && !voiceTaskRunning());
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
  const voiceKeyHint = signal("");
  const voiceProviderId = signal("doubao");
  const voiceId = signal("");
  let voice: VoiceRuntime | undefined;
  let voiceTaskCoordinator: VoiceTaskCoordinator | undefined;
  const stopVoiceSessionMotion = () => {
    void stopBodyNow();
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
  const localizedLlm = computed(() => {
    effectiveLocale();
    const snapshot = llmSnapshot();
    return {
      ...snapshot,
      brands: snapshot.brands.map((brand) => {
        const labels = INITIAL_LLM_SNAPSHOT.brands.find((item) => item.brandId === brand.brandId);
        return {
          ...brand,
          label: translateMessage(labels?.label ?? brand.label),
          shortLabel: translateMessage(labels?.shortLabel ?? brand.shortLabel),
          channels: brand.channels.map((channel) => {
            const channelLabels = labels?.channels.find((item) => item.providerId === channel.providerId);
            return {
              ...channel,
              protocolLabel: translateMessage(channelLabels?.protocolLabel ?? channel.protocolLabel),
              label: translateMessage(channelLabels?.label ?? channel.label),
              modelsError: translateMessage(channel.modelsError ?? ""),
            };
          }),
        };
      }),
    };
  });
  const modelRefreshCounts = signal<Record<string, number>>({});
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
    enabledSources: {
      direct_miot: false,
      external_ha: false,
      simulation: false,
    },
  });
  const homeConnection = signal<HomeConnection | undefined>(undefined);
  const homeDevices = signal<Record<string, unknown>>({});
  const homeDashboard = signal<HomeDashboardModel>({
    homeName: "我的家",
    totalAppliances: 0,
    activeAppliances: 0,
    rooms: [],
    allAppliances: [],
  });
  const homePowerState = new HomePowerState(homeDashboard(), (dashboard) => {
    if (alive) homeDashboard.set(dashboard);
  });
  const homeSubView = signal<HomeSubView>("devices");
  let cameraHost: XiaomiCameraHost | undefined;
  const xiaomiVideoAuth = signal<XiaomiVideoAuthState>({ authorized: false, account: "", cameraCount: 0 });
  const xiaomiVideoLogin = signal<XiaomiVideoLoginState>({
    step: "credentials", attempt: 0, account: "", region: "cn", error: null, busy: false, canResume: false,
    captchaImage: "", destination: "", smsCountdown: 0,
  });
  const videoAccount = new VideoAccount({
    native: () => cameraHost,
    onChange: () => {
      if (!alive) return;
      const becameAuthorized = !xiaomiVideoAuth().authorized && videoAccount.auth.authorized;
      xiaomiVideoLogin.set({ ...videoAccount.login });
      xiaomiVideoAuth.set({ ...videoAccount.auth });
      if (becameAuthorized) cameraRetry.update(value => value + 1);
    },
    onAuthorized: () => {
      homeSubView.set("services");
    },
  });
  cleanup(() => videoAccount.cancel());
  const homeSelectedRoom = signal<string>("all");
  const homeOverviewCollapsed = signal(false);
  const homeLayoutEditing = signal<string | null>(null);
  const homeInspectedApplianceId = signal<string | null>(null);
  const homeCamera = signal<{
    phase: "idle" | "loading" | "prepared" | "playing" | "error";
    sessionId: string | null;
    seconds: number;
    buffering: boolean;
    width?: number;
    height?: number;
    error?: string;
    requestedAt?: number;
    preparedAt?: number;
    progressAt?: number;
    firstTimestampMs?: number;
    frames?: number;
  }>({ phase: "idle", sessionId: null, seconds: 0, buffering: false });
  const cameraRetry = signal(0);
  let cameraKey = "";
  let cameraAttempt = 0;
  function stopHomeCamera() {
    ++cameraAttempt;
    homeCamera.set({ phase: "idle", sessionId: null, seconds: 0, buffering: false });
    void runtime?.stopHomeCamera().catch(() => {});
  }
  cleanup(stopHomeCamera);
  const homeLoggingIn = signal(false);
  const homeLoading = signal(true);
  const homeRefreshing = signal(false);
  let homePendingLoads = 0;
  const withHomeLoading = async <T,>(load: () => Promise<T>): Promise<T> => {
    homePendingLoads += 1;
    homeLoading.set(true);
    try {
      return await load();
    } finally {
      homePendingLoads -= 1;
      if (alive) homeLoading.set(homePendingLoads > 0);
    }
  };
  let homeSyncInFlight: Promise<boolean> | undefined;
  const syncHomeDashboard = async (afterCurrent = false): Promise<boolean> => {
    if (homeSyncInFlight) {
      const synced = await homeSyncInFlight;
      return afterCurrent ? syncHomeDashboard(true) : synced;
    }
    if (!alive || !runtime) return false;
    homeSyncInFlight = withHomeLoading(async () => {
      homeConfiguration.set(runtime!.homeConfiguration());
      homeConnection.set(runtime!.homeConnection());
      if (!homeConnection()?.connectionId) {
        homePowerState.replaceDashboard(
          runtime!.cachedHomeDashboard(effectiveLocale()) ?? {
            homeName: "", totalAppliances: 0, activeAppliances: 0, rooms: [], allAppliances: [],
          },
          null,
        );
      }
      try {
        const nextDashboard = await runtime!.homeDashboard(effectiveLocale());
        if (!alive) return false;
        homeConnection.set(runtime!.homeConnection());
        homePowerState.replaceDashboard(nextDashboard, runtime!.homeConnection()?.connectionId ?? null);
        const currentRoom = homeSelectedRoom();
        if (
          currentRoom !== "all" &&
          nextDashboard.rooms.length > 0 &&
          !nextDashboard.rooms.some((r: HomeRoomSection) => r.name === currentRoom)
        ) {
          homeSelectedRoom.set("all");
        }
        const inspected = homeInspectedApplianceId();
        if (
          inspected &&
          !nextDashboard.allAppliances.some((a: HomeAppliance) => a.id === inspected)
        ) {
          homeInspectedApplianceId.set(null);
        }
        return true;
      } catch {
        return false;
      }
    });
    try {
      return await homeSyncInFlight;
    } finally {
      homeSyncInFlight = undefined;
    }
  };
  effect(() => {
    const appliance = homeDashboard().allAppliances.find(
      (item) => item.id === homeInspectedApplianceId(),
    );
    const visible =
      ready() &&
      lifecycle() === "active" &&
      activeSpace() === "home" &&
      homeSubView() === "devices" &&
      appliance?.icon === "camera";
    const kind = appliance?.capabilities.visionStream?.playbackKind;
    const off = appliance?.capabilities.visionStream?.cameraOn === false;
    const key = visible
      ? JSON.stringify([
          appliance.id,
          kind,
          off,
          homeConnection()?.connectionId,
          cameraRetry(),
        ])
      : "";
    // The dashboard object is replaced by polling; its playback identity isn't.
    if (key === cameraKey) return;
    cameraKey = key;
    stopHomeCamera();
    if (!visible || !runtime) return;
    if (appliance.source !== "direct_miot" || off) {
      homeCamera.set({
        phase: "error",
        sessionId: null,
        seconds: 0,
        buffering: false,
        error: off ? "miot_camera_off" : "miot_camera_unsupported",
      });
      return;
    }
    const attempt = cameraAttempt;
    homeCamera.set({
      phase: "loading",
      sessionId: null,
      seconds: 0,
      buffering: true,
      requestedAt: Date.now(),
    });
    void runtime.startHomeCamera(appliance.deviceId).then(
      (playback) => {
        if (!alive || attempt !== cameraAttempt) return;
        homeCamera.update((state) => ({ ...state, sessionId: playback.sessionId }));
      },
      (error: unknown) => {
        if (!alive || attempt !== cameraAttempt) return;
        const message = error instanceof Error ? error.message : "";
        homeCamera.set({
          phase: "error",
          sessionId: null,
          seconds: 0,
          buffering: false,
          error:
            /^miot_camera_(unsupported|off|busy|auth|network|action|unavailable)$/.test(
              message,
            )
              ? message
              : message.startsWith("camera_") ? message : "miot_camera_network",
        });
      },
    );
  });
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
    lightBrightness: 0,
    powerStatus: null,
    powerReading: false,
    motion: { speed: 0, turn: 0 },
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
  const shellOutput = signal<{taskId:string;callId:string;command:string;text:string;status:string} | undefined>(undefined);
  const refreshInspectedTask = () => {
    const id = task()?.id;
    if (id && runtime) task.set(runtime.taskDetails(id));
  };
  const receiveShellOutput = (event: NativeShellOutput) => {
    if (!alive) return;
    const previous = shellOutput();
    const current = previous?.callId === event.callId && previous.taskId === event.taskId
      ? previous : {taskId:event.taskId,callId:event.callId,command:event.command,text:"",status:""};
    shellOutput.set({ ...current,
      ...(event.stream === "status" ? {status:event.chunk} : {text:utf8Tail(current.text + event.chunk, 16 * 1024),status:""}),
    });
  };
  const interaction = signal<
    (NonNullable<NativeStep["interaction"]> & { taskId: string }) | undefined
  >(undefined);
  const driver = new RobotFaceController({
    onStateChange: () => face.set(driver.getState()),
  });
  const face = signal(driver.getState());
  let unsubscribeTrace: (() => void) | undefined;
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
  const notifyBodyError = (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    if (text && !text.includes("cancelled") && text !== "Pulse preempted by stop: user_stop") {
      notify(text);
    }
  };
  const transientDockExpression = signal<"dock_snap" | "undock_float" | null>(null);
  let dockExpressionTimer: ReturnType<typeof setTimeout> | undefined;
  const clearDockExpression = () => {
    if (dockExpressionTimer) {
      clearTimeout(dockExpressionTimer);
      dockExpressionTimer = undefined;
    }
    if (transientDockExpression() !== null) {
      transientDockExpression.set(null);
    }
  };
  const flashDockExpression = (
    expression: "dock_snap" | "undock_float",
    durationMs: number,
  ) => {
    if (!alive) return;
    if (dockExpressionTimer) clearTimeout(dockExpressionTimer);
    transientDockExpression.set(expression);
    dockExpressionTimer = setTimeout(() => {
      dockExpressionTimer = undefined;
      if (alive) transientDockExpression.set(null);
    }, durationMs);
  };
  const syncBodyStatus = (
    next: BodyStatusSnapshot,
    options?: { suppressFeedback?: boolean },
  ) => {
    const prev = bodyStatus();
    const wasDocked = prev.connected && prev.isDocked;
    const nowDocked = next.connected && next.isDocked;
    bodyStatus.set(next);
    if (options?.suppressFeedback || !alive || lifecycle() !== "active") {
      return;
    }
    if (!wasDocked && nowDocked) {
      flashDockExpression("dock_snap", 1800);
      notify(uiMessage("dockAttachedToast"));
      voice?.playDockCue(true);
    } else if (wasDocked && !nowDocked && next.connected) {
      flashDockExpression("undock_float", 1400);
      voice?.playDockCue(false);
    }
  };
  const stopBodyNow = async () => {
    ++bodyDriveOperation;
    bodyActiveCommand.set(null);
    if (!runtime) {
      bodyStatus.update((prev) => ({ ...prev, motion: { speed: 0, turn: 0 } }));
      return;
    }
    try {
      const snap = await runtime.stopBody();
      if (alive) syncBodyStatus(snap);
    } catch {}
  };
  const stop = async () => {
    interaction.set(undefined);
    void stopBodyNow();
    try {
      if (voiceTaskCoordinator?.hasActiveTask) {
        await voiceTaskCoordinator.cancel();
        return;
      }
      const stopped = await runtime?.cancel();
      if (!alive) return;
      status.set(stopped?.confirmed ? "@looi:runtimeTaskStopped" : "@looi:runtimeStopResultUnverified");
    } catch (error) {
      if (alive) fail(error);
    }
  };
  effect(() => {
    const active = lifecycle() === "active";
    runtime?.setBodyForegroundActive(active);
    const next = !active
      ? "sleeping"
      : voiceState().phase === "speaking"
        ? "speaking"
        : voiceState().phase === "listening"
          ? "listening"
          : voiceState().phase === "connecting"
            ? "curious"
            : foregroundBusy()
              ? "thinking"
              : (transientDockExpression() ?? "neutral");
    if (!active) {
      clearDockExpression();
      homeLogin?.cancel();
      void stopBodyNow();
      if (voiceState().phase !== "idle") voice?.stop();
      else voice?.stopIdleCue();
      if (driver.getState().expression !== "sleeping") {
        driver.setExpression("sleeping");
      }
      if (lifecycle() === "background" && busy()) void stop();
    } else if (driver.getState().expression !== next) {
      driver.setExpression(next);
    }
  });
  effect(() => {
    if (!ready() || !voice) return;
    if (lifecycle() !== "active" || homeLoggingIn() || oauthFlow().running) {
      voice.stopStandby();
      if (voiceState().phase !== "idle") voice.stop();
      else voice.stopIdleCue();
    } else if (activeSpace() !== "face" && activeSpace() !== "voice") {
      voice.stopStandby();
      if (voiceState().phase !== "idle") voice.stop();
    } else if (activeSpace() === "face" && voiceState().purpose === "preview") {
      voice.endSession();
    } else if (voiceState().wakeEnabled && voiceState().phase === "idle") {
      void voice.enterStandby();
    }
  });
  effect(() => {
    if (lifecycle() !== "active" || reduceMotion()) return;
    const timer = setInterval(() => {
      if (!foregroundBusy()) driver.triggerBlink();
    }, 4800);
    return () => clearInterval(timer);
  });
  const isBodyConnected = computed(() => bodyStatus().connected);
  effect(() => {
    const cfg = bodyConfiguration();
    const watchingPairedBle =
      cfg.mode === "real_ble" &&
      cfg.autoConnect &&
      Boolean(cfg.savedDeviceId);
    if (
      !ready() ||
      lifecycle() !== "active" ||
      (!watchingPairedBle && activeSpace() !== "body" && !isBodyConnected())
    ) {
      return;
    }
    const timer = setInterval(() => {
      if (alive && runtime && !bodyStatus().scanning) {
        syncBodyStatus(runtime.bodyStatus());
      }
    }, 250);
    return () => clearInterval(timer);
  });
  effect(() => {
    if (
      !ready() ||
      lifecycle() !== "active" ||
      activeSpace() !== "home" ||
      homeLoggingIn()
    ) {
      return;
    }
    void syncHomeDashboard();
    const timer = setInterval(() => {
      if (alive && runtime && !homeLoggingIn()) {
        void syncHomeDashboard();
      }
    }, 4000);
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
      try {
        cameraHost = new XiaomiCameraHost();
        void videoAccount.initialize();
      } catch (error) {
        xiaomiVideoLogin.update(state => ({ ...state, error: String(error) }));
      }
      const opened = await openRuntime(new NodeCompat(), vault);
      if (!alive) {
        await opened.close();
        return;
      }
      runtime = opened;
      unsubscribeTrace = opened.subscribeTrace(() => {
        if (alive && activeSpace() === "tasks" && task()) refreshInspectedTask();
      });
      if (cameraHost) opened.attachNativeCamera(cameraHost);
      opened.setBodyForegroundActive(lifecycle() === "active");
      try {
        opened.attachNativeBle(new LooiBle());
      } catch {}
      bodyConfiguration.set(opened.bodyConfiguration());
      syncBodyStatus(opened.bodyStatus(), { suppressFeedback: true });
      voiceTaskCoordinator = new VoiceTaskCoordinator({
        defaultLanguage: effectiveLocale,
        isExternalBusy: () => busy(),
        runTask: async (prompt, hooks, traceContext) => {
          if (!alive || !runtime || busy() || !prompt.trim()) {
            throw new Error("@looi:runtimeATaskIsRunningTryAgainLater");
          }
          api.dismissWakeGuide();
          busy.set(true);
          shellOutput.set(undefined);
          try {
            const result = await runtime.run(
              prompt,
              action(),
              (event) => {
                if (!alive) return;
                refreshInspectedTask();
                if (event.interaction && event.taskId) {
                  interaction.set({ ...event.interaction, taskId: event.taskId });
                }
          voiceTaskRunning.set(true);
                hooks.onStep(event);
              },
              {
                agentOnly: true,
                mode: "voice",
                approvalMode: taskApprovalMode(),
                traceContext,
                onShellOutput: receiveShellOutput,
                defaultLanguage: effectiveLocale(),
              },
            );
            return { answer: result.answer, taskId: result.taskId };
          } finally {
            if (alive) {
              busy.set(false);
              interaction.set(undefined);
              recoveryCount.set(runtime.recoveryCount());
              refreshInspectedTask();
              syncBodyStatus(runtime.bodyStatus());
            }
          }
        },
        cancelRunningTask: async () => {
          interaction.set(undefined);
          void stopBodyNow();
          try {
            const stopped = await runtime?.cancel();
            if (alive) {
              status.set(
                stopped?.confirmed
              voiceTaskRunning.set(false);
                  ? "@looi:runtimeTaskStopped"
                  : "@looi:runtimeStopResultUnverified",
              );
            }
            return Boolean(stopped?.confirmed);
          } catch (error) {
            if (alive) fail(error);
            return false;
          }
        },
        onNotice: (notice) => {
          if (!alive) return;
          const task = notice.taskId ? opened.taskDetails(notice.taskId) : undefined;
          const traceContext = task?.trace ? { traceId: task.trace.traceId, parentSpanId: task.trace.spanId, traceName: "agent.run", sessionId: task.sessionId } : undefined;
          if (traceContext) opened.tracer.start("voice.notice", "span", traceContext, {
            "langfuse.observation.input": notice,
          }).end({ "langfuse.observation.output": { status: "queued" } });
          voice?.enqueueNotice({ ...notice, traceContext });
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
        onSessionEnd: stopVoiceSessionMotion,
        controlBody: async (actionName, durationMs, extra) => {
          if (!alive || !runtime) {
            throw new Error("@looi:runtimeLocalRuntimeIsNotReady");
          }
          const receipt = await runtime.controlBody(
            {
              action: actionName as BodyControlAction,
              ...(durationMs !== undefined ? { durationMs } : {}),
              ...(extra?.headDegrees !== undefined ? { headDegrees: extra.headDegrees } : {}),
              ...(extra?.brightness !== undefined ? { brightness: extra.brightness } : {}),
              ...(extra?.speed !== undefined ? { speed: extra.speed } : {}),
              ...(extra?.turn !== undefined ? { turn: extra.turn } : {}),
            },
            "voice_realtime",
        onConversationActivity: () => opened.touchVoiceConversation(),
          );
          if (alive) syncBodyStatus(runtime.bodyStatus());
          return receipt;
        },
      });
      if (wakePreferenceTouched) {
        voice.setWakeEnabled(voiceState().wakeEnabled, { autoStandby: false });
      }
      const voiceCfg = voice.configuration();
      voiceConfigured.set(voiceCfg.hasKey);
      voiceKeyHint.set(voiceCfg.keyHint ?? "");
      voiceProviderId.set(voiceCfg.providerId);
      voiceId.set(voiceCfg.voiceId);
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
      if (opened.homeConfiguration().mode === "disabled") {
        await syncHomeDashboard();
      } else {
        void withHomeLoading(async () => {
          try {
            await syncHomeDashboard();
            if (alive) {
              homeDevices.set(await opened.listHome());
            }
          } catch {}
        });
      }
      recoveryCount.set(opened.recoveryCount());
      ready.set(true);
      status.set(recoveryCount() ? "@looi:runtimePreviousTaskResultUnverified" : "@looi:runtimeStandingBy");
      if (recoveryCount())
        message.set(
          uiMessage("recoveryNotice", { count: recoveryCount() }),
        );
    } catch (error) {
      if (alive) {
        homeLoading.set(false);
        status.set("@looi:runtimeLocalStorageUnavailable");
        fail(error);
      }
    }
  })();
  cleanup(() => {
    alive = false;
    unsubscribeTrace?.();
    if (toastTimer) clearTimeout(toastTimer);
    if (dockExpressionTimer) clearTimeout(dockExpressionTimer);
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
      syncHomeDashboard();
      try {
        await Storage.setItem(LANGUAGE_PREFERENCE_KEY, value);
      } catch (error) {
        if (alive) fail(error);
      }
    },
    activeSpace: () => activeSpace(),
    openSpace(space: AppSpace) {
      if (activeSpace() === space) return;
      if (space !== "models" && oauthFlow().running) {
        api.cancelProviderOAuth();
      }
      if (space !== "home" && homeLoggingIn()) {
        api.cancelHomeLogin();
      }
      if (space !== "home" && homeSubView() === "video_login") api.cancelXiaomiVideoLogin();
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
      if (homeSubView() === "video_login") api.cancelXiaomiVideoLogin();
      activeSpace.set("face");
    },
    goBack(): boolean {
      const space = activeSpace();
      if (space === "face") return false;
      if (space === "home") {
        if (homeInspectedApplianceId() !== null) {
          api.setHomeInspectedApplianceId(null);
          return true;
        }
        if (homeSubView() === "video_login") {
          api.cancelXiaomiVideoLogin();
          return true;
        }
        if (homeSubView() === "services") {
          if (homeLoggingIn()) api.cancelHomeLogin();
          api.setHomeSubView("devices");
          return true;
        }
      }
      api.backToFace();
      return true;
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
    llm: () => localizedLlm(),
    oauth: () => ({ ...oauthFlow(), instructions: translateMessage(oauthFlow().instructions), error: translateMessage(oauthFlow().error) }),
    isProviderModelsRefreshing: (providerId: string) => (modelRefreshCounts()[providerId] ?? 0) > 0,
    async refreshProviderModels(providerId: string) {
      if (!runtime) return;
      modelRefreshCounts.set({ ...modelRefreshCounts(), [providerId]: (modelRefreshCounts()[providerId] ?? 0) + 1 });
      try {
        llmSnapshot.set(await runtime.refreshProviderModels(providerId));
      } catch {
        llmSnapshot.set(runtime.llmSnapshot());
      } finally {
        modelRefreshCounts.set({ ...modelRefreshCounts(), [providerId]: modelRefreshCounts()[providerId] - 1 });
      }
    },
    async saveProviderApiKey(
      input: Parameters<NativeRuntime["saveProviderApiKey"]>[0],
    ) {
      if (!runtime) throw new Error("@looi:runtimeLocalStorageIsNotReady");
      const snap = await runtime.saveProviderApiKey(input, action());
      llmSnapshot.set(snap);
      const refreshedVoice = voice?.refreshCredentials(canAutoStandby());
      voiceConfigured.set(refreshedVoice?.hasKey ?? false);
      voiceKeyHint.set(refreshedVoice?.keyHint ?? "");
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
        const refreshedVoice = voice?.refreshCredentials(canAutoStandby());
      voiceConfigured.set(refreshedVoice?.hasKey ?? false);
      voiceKeyHint.set(refreshedVoice?.keyHint ?? "");
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
    voiceKeyHint: () => voiceKeyHint(),
    voiceId: () => voiceId(),
    voiceProviderId: () => voiceProviderId(),
    voiceProviderLabel: () => translateMessage(voice?.configuration().providerLabel ?? "@looi:runtimeDoubao"),
    async startVoice() {
      api.dismissWakeGuide();
      try {
        await voice?.start();
      } catch (error) {
        fail(error);
      }
    },
    async previewVoice(voiceIdDraft?: string) {
      try {
        await voice?.preview({ voiceId: voiceIdDraft });
      } catch (error) {
        fail(error);
      }
    },
    async restartVoiceSession() {
      api.dismissWakeGuide();
      try {
        await voice?.restartSession();
      } catch (error) {
        fail(error);
      }
    },
    stopVoice() {
      voice?.endSession();
      void stopBodyNow();
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
      void stopBodyNow();
    },
    configureVoice(key: string) {
      if (!voice) throw new Error("@looi:runtimeVoiceIsNotReady");
      voice.configure(key);
      const nextCfg = voice.configuration();
      voiceConfigured.set(nextCfg.hasKey);
      voiceKeyHint.set(nextCfg.keyHint ?? "");
    },
    clearVoiceCredentials() {
      if (!voice) throw new Error("@looi:runtimeVoiceIsNotReady");
      voice.clearCredentials();
      const nextCfg = voice.configuration();
      voiceConfigured.set(nextCfg.hasKey);
      voiceKeyHint.set(nextCfg.keyHint ?? "");
    },
    configureVoiceId(id: string) {
      if (!voice) throw new Error("@looi:runtimeVoiceIsNotReady");
      voice.configureVoiceId(id);
      voiceId.set(voice.configuration().voiceId);
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
      foregroundBusy()
        ? status()
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
    homeDashboard: () => homeDashboard(),
    homeLoading: () => homeLoading(),
    homeRefreshing: () => homeRefreshing(),
    homeSubView: () => homeSubView(),
    setHomeSubView(view: HomeSubView) {
      if (homeSubView() === "video_login" && view !== "video_login") videoAccount.cancel();
      homeSubView.set(view);
      if (view !== "devices") {
        homeLayoutEditing.set(null);
        homeInspectedApplianceId.set(null);
      }
    },
    xiaomiVideoAuth: () => xiaomiVideoAuth(),
    xiaomiVideoLogin: () => xiaomiVideoLogin(),
    startXiaomiVideoLogin() {
      videoAccount.start(homeConfiguration().region || "cn");
      homeSubView.set("video_login");
    },
    cancelXiaomiVideoLogin() {
      videoAccount.cancel();
      homeSubView.set("services");
    },
    submitVideoCredentials: (params: { account: string; password?: string; region?: string }) => videoAccount.credentials(params),
    refreshVideoCaptcha: () => videoAccount.refreshCaptcha(),
    submitVideoCaptcha: (code: string) => videoAccount.answer(code),
    sendVideoSms: () => videoAccount.resend(),
    submitVideoTwoFactor: (code: string) => videoAccount.answer(code),
    resumeVideoLogin: () => videoAccount.resume(),
    async disconnectXiaomiVideo() {
      stopHomeCamera();
      await videoAccount.disconnect();
      cameraRetry.update(value => value + 1);
    },
    homeSelectedRoom: () => homeSelectedRoom(),
    homeOverviewCollapsed: () => homeOverviewCollapsed(),
    setHomeOverviewCollapsed: (collapsed: boolean) => homeOverviewCollapsed.set(collapsed),
    setHomeSelectedRoom(room: string) {
      homeSelectedRoom.set(room);
      const editingRoom = homeLayoutEditing();
      if (editingRoom && room !== "all" && editingRoom !== room) {
        homeLayoutEditing.set(null);
      }
    },
    homeLayoutEditing: () => homeLayoutEditing(),
    setHomeLayoutEditing(roomName: string | null) {
      homeLayoutEditing.set(roomName);
    },
    homeInspectedApplianceId: () => homeInspectedApplianceId(),
    setHomeInspectedApplianceId(id: string | null) {
      homeInspectedApplianceId.set(id);
    },
    homeCamera: () => homeCamera(),
    retryHomeCamera() {
      cameraRetry.update((value) => value + 1);
    },
    homeCameraState(event: CameraVideoState) {
      if (homeCamera().sessionId !== event.sessionId) return;
      if (event.failure || event.closed) {
        stopHomeCamera();
        homeCamera.set({ phase: "error", sessionId: null, seconds: 0, buffering: false, error: event.failure ?? "camera_session_closed" });
        return;
      }
      homeCamera.update(state => {
        const progress = event.frames > (state.frames ?? 0);
        const firstTimestampMs = state.firstTimestampMs ?? (event.frames > 0 ? event.timestampMs : undefined);
        return { ...state, width:event.width, height:event.height, frames:event.frames, firstTimestampMs,
          seconds:firstTimestampMs === undefined ? 0 : Math.max(0,(event.timestampMs-firstTimestampMs)/1000),
          phase:event.displayed === true ? "playing" : event.frames > 0 ? "prepared" : "loading",
          buffering:event.frames > 0 && !progress && Date.now()-(state.progressAt ?? Date.now()) > 2000,
          preparedAt:state.preparedAt ?? (event.frames > 0 ? Date.now() : undefined),
          progressAt:progress ? Date.now() : state.progressAt };
      });
    },
    homeLoggingIn: () => homeLoggingIn(),
    cancelHomeLogin() {
      homeLogin?.cancel();
    },
    async loginMiot(region: HomeConfiguration["region"]) {
      stopHomeCamera();
      if (!runtime || !homeLogin) throw new Error("@looi:runtimeLocalRuntimeIsNotReady");
      homeLoggingIn.set(true);
      voice?.stop();
      homeDevices.set({});
      try {
        const connection = await homeLogin.start(region, action());
        homeConnection.set(connection);
        if (connection.configured && connection.connectionId) {
          homeDevices.set(await runtime.listHome());
          homeSubView.set("devices");
        }
      } finally {
        homeLoggingIn.set(false);
        if (alive) {
          await syncHomeDashboard();
        }
      }
    },
    async logoutMiot() {
      stopHomeCamera();
      if (!runtime) throw new Error("@looi:runtimeLocalRuntimeIsNotReady");
      homeLogin?.cancel();
      await runtime.logoutMiot(action());
      await videoAccount.disconnect();
      homeDevices.set({});
      await syncHomeDashboard();
    },
    async configureHome(value: Parameters<NativeRuntime["configureHome"]>[0]) {
      stopHomeCamera();
      homeLogin?.cancel();
      if (!runtime) throw new Error("@looi:runtimeLocalRuntimeIsNotReady");
      homeDevices.set({});
      try {
        homeConfiguration.set(await runtime.configureHome(value, action()));
      } finally {
        await syncHomeDashboard();
      }
    },
    async connectHome() {
      stopHomeCamera();
      if (!runtime) throw new Error("@looi:runtimeLocalRuntimeIsNotReady");
      await withHomeLoading(async () => {
        homeDevices.set({});
        try {
          homeConnection.set(await runtime!.connectHome());
          homeDevices.set(await runtime!.listHome());
        } finally {
          await syncHomeDashboard();
        }
      });
    },
    async refreshHomeDashboard() {
      if (!runtime || homeRefreshing()) return;
      homeRefreshing.set(true);
      try {
        await withHomeLoading(async () => {
          try {
            if (!runtime!.homeConnection()?.healthy && runtime!.homeConfiguration().mode !== "disabled") {
              homeConnection.set(await runtime!.connectHome());
            }
            homeDevices.set(await runtime!.listHome());
          } catch {}
          await syncHomeDashboard();
        });
      } finally {
        if (alive) homeRefreshing.set(false);
      }
    },
    async setHomeSourceEnabled(source: HomeSourceId, enabled: boolean) {
      stopHomeCamera();
      if (!runtime) throw new Error("@looi:runtimeLocalRuntimeIsNotReady");
      await withHomeLoading(async () => {
        try {
          homeConnection.set(await runtime!.setHomeSourceEnabled(source, enabled, action()));
          if (runtime!.homeConnection()?.healthy) {
            homeDevices.set(await runtime!.listHome());
          } else {
            homeDevices.set({});
          }
        } finally {
          await syncHomeDashboard();
        }
      });
    },
    async setHomeApplianceLayout(
      applianceId: string,
      patch: { span?: TileSpan; order?: number },
    ) {
      if (!runtime) return;
      try {
        runtime.setHomeApplianceLayout(applianceId, patch);
        await syncHomeDashboard();
      } catch (error) {
        if (alive) fail(error);
      }
    },
    async reorderHomeAppliances(orders: Array<{ id: string; order: number }>) {
      if (!runtime || orders.length === 0) return;
      try {
        for (const item of orders) {
          runtime.setHomeApplianceLayout(item.id, { order: item.order });
        }
        await syncHomeDashboard();
      } catch (error) {
        if (alive) fail(error);
      }
    },
    async controlHomeAppliance(command: {
      entity_id: string;
      domain: string;
      service: string;
      service_data?: Record<string, unknown>;
    }) {
      if (!runtime) throw new Error("@looi:runtimeLocalRuntimeIsNotReady");
      const inspected = homeDashboard().allAppliances.find(
        (appliance) => appliance.id === homeInspectedApplianceId(),
      );
      if (
        command.service === "turn_off" &&
        inspected?.icon === "camera" &&
        inspected.capabilities.power?.entityId === command.entity_id
      )
        stopHomeCamera();
      try {
        const res = await homePowerState.control(
          command,
          () => runtime!.controlHomeAppliance(command, action()),
          () => syncHomeDashboard(true),
        );
        const reasonOrStatus = res?.receipt?.reason_code ?? res?.receipt?.status;
        if (reasonOrStatus === "action_accepted_no_state_criterion") {
          notify("动作已发送");
        } else if (reasonOrStatus === "action_accepted_state_unverified") {
          notify("命令已发送，等待设备状态同步");
        }
        return res;
      } catch (error) {
        if (alive) fail(error);
        return null;
      }
    },
    async controlRoomPower(roomName: string, turnOn: boolean) {
      if (!runtime) return;
      const room = homeDashboard().rooms.find((r) => r.name === roomName);
      if (!room) return;
      const targets = turnOn
        ? room.roomPowerEntities.turnOnIds
        : room.roomPowerEntities.turnOffIds;
      for (const entityId of targets) {
        const domain = entityId.split(".")[0] || "switch";
        try {
          await runtime.controlHomeAppliance(
            {
              entity_id: entityId,
              domain,
              service: turnOn ? "turn_on" : "turn_off",
              service_data: {},
            },
            action(),
          );
        } catch {}
      }
      if (alive) {
        try {
          homeDevices.set(await runtime.listHome());
        } catch {}
        await syncHomeDashboard();
      }
    },
    bodyConfiguration: () => bodyConfiguration(),
    bodyStatus: () => ({
      ...bodyStatus(),
      error: bodyStatus().error ? translateMessage(bodyStatus().error!) : null,
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
            powerStatus: { batteryPercent: 100, externalPower: true },
            powerReading: false,
            motion: { speed: 0, turn: 0 },
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
            lightOn: false,
            lightBrightness: 0,
            powerStatus: null,
            powerReading: false,
            motion: { speed: 0, turn: 0 },
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
      const modeChanged =
        next.mode !== undefined && next.mode !== bodyConfiguration().mode;
      try {
        const snap = await runtime.configureBody(next, action());
        if (alive) {
          bodyConfiguration.set(runtime.bodyConfiguration());
          syncBodyStatus(snap, { suppressFeedback: modeChanged });
        }
      } catch (error) {
        if (alive) notifyBodyError(error);
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
          syncBodyStatus(current);
          if (current.error) notify(current.error);
        }
      } catch (error) {
        if (alive) {
          syncBodyStatus(runtime.bodyStatus());
          notifyBodyError(error);
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
          syncBodyStatus({
            ...bodyStatus(),
            connected: true,
            isDocked: true,
            powerStatus: { batteryPercent: 100, externalPower: true },
            powerReading: false,
            supervisorState: "ready",
            connecting: false,
            deviceId: nextId,
            deviceName: nextName,
            error: null,
          });
        }
        return;
      }
      bodyStatus.update((prev) => ({ ...prev, connecting: true, error: null }));
      try {
        await runtime.connectBodyDevice(target);
        if (alive && operation === bodyConnectionOperation) {
          bodyConfiguration.set(runtime.bodyConfiguration());
          const current = runtime.bodyStatus();
          syncBodyStatus(current);
          if (current.error) notify(current.error);
        }
      } catch (error) {
        if (alive && operation === bodyConnectionOperation) {
          syncBodyStatus(runtime.bodyStatus());
          notifyBodyError(error);
        }
      }
    },
    async disconnectBody() {
      const operation = ++bodyConnectionOperation;
      if (!runtime) {
        bodyActiveCommand.set(null);
        syncBodyStatus({
          ...bodyStatus(),
          connected: false,
          isDocked: false,
          lightOn: false,
          lightBrightness: 0,
          powerStatus: null,
          powerReading: false,
          motion: { speed: 0, turn: 0 },
          supervisorState: "disconnected",
        });
        return;
      }
      try {
        await runtime.disconnectBody();
        if (alive && operation === bodyConnectionOperation) {
          bodyActiveCommand.set(null);
          syncBodyStatus(runtime.bodyStatus());
        }
      } catch (error) {
        if (alive && operation === bodyConnectionOperation) notifyBodyError(error);
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
        syncBodyStatus({
          ...bodyStatus(),
          connected: false,
          isDocked: false,
          lightOn: false,
          lightBrightness: 0,
          powerStatus: null,
          powerReading: false,
          motion: { speed: 0, turn: 0 },
          connecting: false,
          supervisorState: "disconnected",
          deviceId: null,
          deviceName: "LOOI 桌面底座",
          error: null,
        });
        return;
      }
      try {
        await runtime.forgetSavedDock();
        if (alive && operation === bodyConnectionOperation) {
          bodyActiveCommand.set(null);
          bodyConfiguration.set(runtime.bodyConfiguration());
          syncBodyStatus(runtime.bodyStatus());
        }
      } catch (error) {
        if (alive && operation === bodyConnectionOperation) notifyBodyError(error);
      }
    },
    setSimulatedDock(docked: boolean) {
      if (!runtime) {
        const prev = bodyStatus();
        syncBodyStatus({
          ...prev,
          isDocked: docked,
          powerStatus: prev.connected
            ? { batteryPercent: prev.powerStatus?.batteryPercent ?? 100, externalPower: docked }
            : null,
          supervisorState: docked ? "ready" : "connected_unarmed",
        });
        return;
      }
      try {
        const snap = runtime.setSimulatedDock(docked);
        if (alive) syncBodyStatus(snap);
      } catch (error) {
        if (alive) notifyBodyError(error);
      }
    },
    async refreshBodyPower() {
      if (!runtime) {
        if (bodyStatus().simulation && bodyStatus().connected) {
          bodyStatus.update((prev) => ({
            ...prev,
            powerStatus: {
              batteryPercent: prev.powerStatus?.batteryPercent ?? 100,
              externalPower: prev.isDocked,
            },
            powerReading: false,
          }));
        }
        return;
      }
      bodyStatus.update((prev) => ({ ...prev, powerReading: true }));
      try {
        const snap = await runtime.readBodyPower();
        if (alive) syncBodyStatus(snap);
      } catch (error) {
        if (alive) {
          syncBodyStatus(runtime.bodyStatus());
          notifyBodyError(error);
        }
      }
    },
    async controlBody(
      actionName: BodyControlAction,
      durationMs?: number,
      headDegrees?: number,
      extra?: { brightness?: number; speed?: number; turn?: number },
    ) {
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
        } else if (actionName === "light_on") {
          bodyStatus.update((prev) => {
            const nextBrightness =
              extra?.brightness !== undefined
                ? Math.max(1, Math.min(255, Math.round(extra.brightness)))
                : prev.lightBrightness > 0
                  ? prev.lightBrightness
                  : 128;
            return {
              ...prev,
              lightOn: true,
              lightBrightness: nextBrightness,
            };
          });
        } else if (actionName === "light_off") {
          bodyStatus.update((prev) => ({
            ...prev,
            lightOn: false,
            lightBrightness: 0,
          }));
        } else if (actionName === "light_set") {
          const nextBrightness = Math.max(
            0,
            Math.min(255, Math.round(extra?.brightness ?? 0)),
          );
          bodyStatus.update((prev) => ({
            ...prev,
            lightOn: nextBrightness > 0,
            lightBrightness: nextBrightness,
          }));
        } else if (actionName === "read_power") {
          bodyStatus.update((prev) => ({
            ...prev,
            powerStatus: prev.connected
              ? (prev.powerStatus ?? { batteryPercent: 100, externalPower: prev.isDocked })
              : null,
          }));
        }
        return;
      }
      const isWheelMove =
        actionName === "forward" ||
        actionName === "backward" ||
        actionName === "turn_left" ||
        actionName === "turn_right" ||
        actionName === "move";
      if (isWheelMove) {
        bodyActiveCommand.set(actionName);
      }
      try {
        const receipt = await runtime.controlBody({
          action: actionName,
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(headDegrees !== undefined ? { headDegrees } : {}),
          ...(extra?.brightness !== undefined ? { brightness: extra.brightness } : {}),
          ...(extra?.speed !== undefined ? { speed: extra.speed } : {}),
          ...(extra?.turn !== undefined ? { turn: extra.turn } : {}),
        });
        if (alive) {
          syncBodyStatus(runtime.bodyStatus());
          if (receipt.status !== "verified" && receipt.reason) {
            if (receipt.reason !== "Pulse preempted by stop: user_stop") notify(receipt.reason);
          }
        }
      } catch (error) {
        if (alive) notifyBodyError(error);
      } finally {
        if (alive && isWheelMove && bodyActiveCommand() === actionName) {
          bodyActiveCommand.set(null);
        }
      }
    },
    stopBody: stopBodyNow,
    async setBodyDriveVector(speed: number, turn: number) {
      const clampedSpeed = Math.max(-127, Math.min(127, Math.round(speed)));
      const clampedTurn = Math.max(-127, Math.min(127, Math.round(turn)));
      const moving = clampedSpeed !== 0 || clampedTurn !== 0;
      if (!runtime) {
        if (!bodyStatus().connected) return false;
        bodyActiveCommand.set(moving ? "move" : null);
        bodyStatus.update((prev) => ({
          ...prev,
          motion: { speed: clampedSpeed, turn: clampedTurn },
        }));
        return true;
      }
      const operation = ++bodyDriveOperation;
      bodyActiveCommand.set(moving ? "move" : null);
      try {
        const snap = await runtime.setBodyDriveVector(clampedSpeed, clampedTurn);
        if (operation !== bodyDriveOperation) {
          if (bodyActiveCommand() === null) await runtime.stopBody();
          return false;
        }
        if (alive) syncBodyStatus(snap);
        return true;
      } catch (error) {
        if (operation === bodyDriveOperation) {
          if (alive) {
            syncBodyStatus(runtime.bodyStatus());
            notifyBodyError(error);
          }
          bodyActiveCommand.set(null);
        }
        return false;
      }
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
        if (alive) syncBodyStatus(snap);
        return true;
      } catch (error) {
        if (operation === bodyDriveOperation) {
          if (alive) {
            syncBodyStatus(runtime.bodyStatus());
            notifyBodyError(error);
          }
          bodyActiveCommand.set(null);
        }
        return false;
      }
    },
    renewBodyDrive() {
      const renewed = runtime?.renewBodyDrive() ?? false;
      if (!renewed) {
        bodyActiveCommand.set(null);
        if (alive && runtime) syncBodyStatus(runtime.bodyStatus());
      }
      return renewed;
    },
    tasks: () => tasks(),
    task: () => task(),
    shellOutput: () => shellOutput(),
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
        voice?.setContextNote("", true);
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
      shellOutput.set(undefined);
      message.set("");
      status.set("@looi:runtimeAgentIsThinking");
      try {
        const result = await runtime.run(
          prompt,
          action(),
          (event) => {
            if (!alive) return;
            status.set(event.summary);
            refreshInspectedTask();
            if (event.interaction && event.taskId)
              interaction.set({ ...event.interaction, taskId: event.taskId });
          },
          { onShellOutput: receiveShellOutput, agentOnly, mode: agentOnly ? "voice" : "text", approvalMode: taskApprovalMode(), traceContext, defaultLanguage: effectiveLocale() },
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
          refreshInspectedTask();
          syncBodyStatus(runtime.bodyStatus());
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
