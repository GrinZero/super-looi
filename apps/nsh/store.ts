import {
  cleanup,
  colorScheme,
  effect,
  lifecycle,
  reduceMotion,
  setColorScheme,
  signal,
} from "nsh";
import {
  CredentialVault,
  NodeCompat,
  VoiceAudio,
  MiotLoginBrowser,
} from "super-looi/native";
import { connect } from "websocket";
import {
  VoiceRuntime,
  MiotLoginFlow,
  type VoiceState,
  openRuntime,
  RobotFaceController,
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

export type AppSpace = "face" | "models" | "voice" | "home" | "tasks";
export type AppearancePreference = "system" | "light" | "dark";

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
          label: "官方 API / ChatGPT 订阅",
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
          label: "Kimi Code (会员订阅)",
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
          label: "Moonshot 开放平台 (国内)",
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
          label: "Moonshot 开放平台 (国际)",
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
          label: "国内站 (minimaxi.com)",
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
          label: "国际站 (minimax.io)",
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
      label: "小米 MiMo",
      shortLabel: "小米",
      configured: false,
      channels: [
        {
          providerId: "xiaomi",
          label: "普通按量 API",
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
          label: "Token Plan (国内)",
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
          label: "Token Plan (新加坡)",
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
          label: "Token Plan (欧洲)",
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
      label: "智谱 / Z.AI",
      shortLabel: "智谱",
      configured: false,
      channels: [
        {
          providerId: "zai-cn",
          label: "标准 API (国内 BigModel)",
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
          label: "标准 API (国际 Z.AI)",
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
          label: "Coding Plan 专属 (国内)",
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
          label: "Coding Plan 专属 (国际)",
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
      label: "+ 兼容 API",
      shortLabel: "兼容",
      configured: false,
      channels: [
        {
          providerId: "custom",
          label: "自定义兼容端点",
          baseUrl: "",
          protocolLabel: "可切换协议",
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
  const ready = signal(false),
    busy = signal(false),
    status = signal("陪伴待机"),
    message = signal(""),
    toast = signal(""),
    wakeGuideDismissed = signal(false);
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
    transcript: "",
    error: "",
  });
  const voiceConfigured = signal(false);
  const voiceTask = signal("");
  let voice: VoiceRuntime | undefined;
  let pendingVoice:
    | {
        resolve: (value: string) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let voiceExecuting = false;
  const cancelVoiceTask = () => {
    if (pendingVoice) {
      clearTimeout(pendingVoice.timer);
      pendingVoice.reject(new Error("语音任务已取消"));
      pendingVoice = undefined;
    }
    voiceTask.set("");
    if (voiceExecuting) {
      void runtime?.cancel().catch(() => {});
      voiceExecuting = false;
    }
  };
  const configuration = signal({ baseUrl: "", model: "", hasKey: false });
  const activeSpace = signal<AppSpace>("face");
  const appearancePreference = signal<AppearancePreference>("system");
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
  let homeLogin: MiotLoginFlow | undefined;
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
    if (!runtime) throw new Error("本机运行时尚未就绪");
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
    status.set("暂时无法完成");
  };
  const stop = async () => {
    interaction.set(undefined);
    try {
      const stopped = await runtime?.cancel();
      if (!alive) return;
      status.set(stopped?.confirmed ? "任务已停止" : "停止结果待核实");
    } catch (error) {
      if (alive) fail(error);
    }
  };
  effect(() => {
    const next =
      lifecycle() !== "active"
        ? "sleeping"
        : busy()
          ? "thinking"
          : voiceState().phase === "speaking"
            ? "speaking"
            : voiceState().phase === "listening"
              ? "listening"
              : voiceState().phase === "connecting"
                ? "curious"
                : "neutral";
    if (lifecycle() !== "active") {
      homeLogin?.cancel();
      runtime?.cancelProviderOAuth();
      voice?.stop();
      if (driver.getState().expression !== "sleeping") {
        driver.setExpression("sleeping");
      }
      void stop();
    } else if (driver.getState().expression !== next) {
      driver.setExpression(next);
    }
  });
  effect(() => {
    if (lifecycle() !== "active" || reduceMotion()) return;
    const timer = setInterval(() => {
      if (!busy()) driver.triggerBlink();
    }, 4800);
    return () => clearInterval(timer);
  });
  void (async () => {
    try {
      const vault = new CredentialVault();
      const opened = await openRuntime(new NodeCompat(), vault);
      if (!alive) {
        await opened.close();
        return;
      }
      runtime = opened;
      voice = new VoiceRuntime({
        vault,
        audio: new VoiceAudio(),
        connect,
        onState: (state) => {
          if (!alive) return;
          voiceState.set(state);
          if (state.phase !== "listening" && state.phase !== "speaking") {
            driver.updateAudioLevel(0);
            face.set(driver.getState());
          }
          if (state.phase === "error" && state.error) {
            notify(state.error);
          }
        },
        onAudioLevel: (level) => {
          if (alive) {
            driver.updateAudioLevel(level);
            face.set(driver.getState());
          }
        },
        requestTask: async (prompt) => {
          if (!alive || voiceExecuting || busy()) {
            throw new Error("已有任务，请稍后");
          }
          voiceExecuting = true;
          try {
            const success = await api.send(prompt, true);
            if (!success) throw new Error("任务未完成");
            return message();
          } finally {
            voiceExecuting = false;
          }
        },
        cancelTask: cancelVoiceTask,
      });
      voiceConfigured.set(voice.configuration().hasKey);
      voiceState.set(voice.snapshot());
      configuration.set(opened.configuration());
      llmSnapshot.set(opened.llmSnapshot());
      homeLogin = new MiotLoginFlow({
        runtime: opened,
        browser: () => new MiotLoginBrowser(),
        active: () => alive && lifecycle() === "active",
        onRunning: (value) => {
          if (alive) homeLoggingIn.set(value);
        },
      });
      homeConfiguration.set(opened.homeConfiguration());
      homeConnection.set(opened.homeConnection());
      recoveryCount.set(opened.recoveryCount());
      ready.set(true);
      status.set(recoveryCount() ? "上次任务结果待核实" : "陪伴待机");
      if (recoveryCount())
        message.set(
          `有 ${recoveryCount()} 项任务的执行结果无法确认，尚未自动重放。请先核实已产生的更改。`,
        );
    } catch (error) {
      if (alive) {
        status.set("本机存储不可用");
        fail(error);
      }
    }
  })();
  cleanup(() => {
    alive = false;
    if (toastTimer) clearTimeout(toastTimer);
    homeLogin?.cancel();
    runtime?.cancelProviderOAuth();
    voice?.close();
    driver.dispose();
    void runtime?.close().catch(() => {});
  });

  const api = {
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
    setAppearance(mode: AppearancePreference) {
      setColorScheme(mode);
      appearancePreference.set(mode);
    },
    llm: () => llmSnapshot(),
    oauth: () => oauthFlow(),
    async saveProviderApiKey(
      input: Parameters<NativeRuntime["saveProviderApiKey"]>[0],
    ) {
      if (!runtime) throw new Error("本机存储尚未就绪");
      const snap = await runtime.saveProviderApiKey(input, action());
      llmSnapshot.set(snap);
      configuration.set(runtime.configuration());
      status.set("陪伴待机");
      notify("模型配置已保存并生效");
    },
    async selectActiveModel(
      providerId: string,
      modelId: string,
      addCustomModel?: boolean,
    ) {
      try {
        if (!runtime) throw new Error("本机存储尚未就绪");
        const snap = await runtime.selectActiveModel(
          { providerId, modelId, addCustomModel },
          action(),
        );
        llmSnapshot.set(snap);
        configuration.set(runtime.configuration());
        notify(`已切换至 ${modelId}`);
      } catch (error) {
        fail(error);
      }
    },
    async removeProviderCredential(providerId: string) {
      try {
        if (!runtime) throw new Error("本机存储尚未就绪");
        const snap = await runtime.removeProviderCredential(
          providerId,
          action(),
        );
        llmSnapshot.set(snap);
        configuration.set(runtime.configuration());
        notify("已移除该服务商凭证");
      } catch (error) {
        fail(error);
      }
    },
    async startProviderOAuth(providerId: string) {
      if (!runtime) {
        fail(new Error("本机存储尚未就绪"));
        return;
      }
      oauthFlow.set({
        running: true,
        providerId,
        kind: "progress",
        userCode: "",
        url: "",
        instructions: "正在发起授权...",
        error: "",
      });
      try {
        const snap = await runtime.startProviderOAuth(
          providerId,
          action(),
          (ev: LlmOAuthUiEvent) => {
            if (!alive) return;
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
        if (!alive) return;
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
        status.set("陪伴待机");
        notify("账号授权成功");
      } catch (error) {
        if (!alive) return;
        const text = error instanceof Error ? error.message : String(error);
        const isCancelled = text.includes("取消") || text.includes("abort");
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
      if (!runtime) throw new Error("本机运行时尚未就绪");
      runtime.submitProviderOAuthCallback(callbackUrl);
    },
    cancelProviderOAuth() {
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
    voiceState: () => voiceState(),
    voiceConfigured: () => voiceConfigured(),
    voiceTask: () => voiceTask(),
    async startVoice() {
      wakeGuideDismissed.set(true);
      try {
        await voice?.start();
      } catch (error) {
        fail(error);
      }
    },
    stopVoice() {
      voice?.stop();
    },
    muteVoice(value: boolean) {
      voice?.mute(value);
    },
    interruptVoice() {
      voice?.interrupt();
    },
    configureVoice(key: string) {
      if (!voice) throw new Error("语音尚未就绪");
      voice.configure(key);
      voiceConfigured.set(voice.configuration().hasKey);
    },
    async confirmVoiceTask(allowed: boolean): Promise<void> {
      const pending = pendingVoice,
        prompt = voiceTask();
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingVoice = undefined;
      voiceTask.set("");
      if (!allowed) {
        pending.reject(new Error("用户拒绝"));
        return;
      }
      voiceExecuting = true;
      try {
        const success = await api.send(prompt, true);
        if (success) pending.resolve(message());
        else pending.reject(new Error("任务未完成"));
      } finally {
        voiceExecuting = false;
      }
    },
    ready: () => ready(),
    busy: () => busy(),
    toast: () => toast(),
    notify,
    wakeGuideDismissed: () => wakeGuideDismissed(),
    dismissWakeGuide() {
      wakeGuideDismissed.set(true);
    },
    status: () =>
      busy()
        ? status()
        : voiceTask()
          ? "语音任务待确认"
          : voiceState().phase === "connecting"
            ? "LIVE 连接中"
            : voiceState().phase === "speaking"
              ? "LOOI 说话中"
              : voiceState().phase === "listening"
                ? voiceState().muted
                  ? "语音已静音"
                  : "实时聆听中"
                : status(),
    message: () => message(),
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
      if (!runtime || !homeLogin) throw new Error("本机运行时尚未就绪");
      voice?.stop();
      homeDevices.set({});
      try {
        const connection = await homeLogin.start(region, action());
        homeConnection.set(connection);
        if (connection.configured && connection.connectionId)
          homeDevices.set(await runtime.listHome());
      } finally {
        if (alive) {
          homeConfiguration.set(runtime.homeConfiguration());
          homeConnection.set(runtime.homeConnection());
        }
      }
    },
    async logoutMiot() {
      if (!runtime) throw new Error("本机运行时尚未就绪");
      homeLogin?.cancel();
      await runtime.logoutMiot(action());
      homeDevices.set({});
      homeConfiguration.set(runtime.homeConfiguration());
      homeConnection.set(runtime.homeConnection());
    },
    async configureHome(value: Parameters<NativeRuntime["configureHome"]>[0]) {
      homeLogin?.cancel();
      if (!runtime) throw new Error("本机运行时尚未就绪");
      homeDevices.set({});
      try {
        homeConfiguration.set(await runtime.configureHome(value, action()));
      } finally {
        homeConnection.set(runtime.homeConnection());
      }
    },
    async connectHome() {
      if (!runtime) throw new Error("本机运行时尚未就绪");
      homeDevices.set({});
      homeConnection.set(await runtime.connectHome());
      homeDevices.set(await runtime.listHome());
      homeConnection.set(runtime.homeConnection());
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
        notify("新对话已开始");
        status.set("陪伴待机");
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    interaction: () => interaction(),
    async configure(value: { baseUrl: string; model: string; apiKey: string }) {
      if (!runtime) throw new Error("本机存储尚未就绪");
      await runtime.configure(value);
      configuration.set(runtime.configuration());
      llmSnapshot.set(runtime.llmSnapshot());
      status.set("陪伴待机");
      notify("模型已配置");
    },
    async send(prompt: string, agentOnly = false) {
      if (busy() || !runtime || !prompt.trim()) return false;
      wakeGuideDismissed.set(true);
      busy.set(true);
      message.set("");
      status.set("Agent 思考中");
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
          { agentOnly, mode: agentOnly ? "voice" : "text" },
        );
        if (alive) {
          message.set(result.answer);
          status.set(result.runtimeExited ? "陪伴待机" : "任务结果待核实");
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
