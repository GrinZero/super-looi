import { cleanup, effect, lifecycle, reduceMotion, signal } from "nsh";
import { CredentialVault, NodeCompat, VoiceAudio, MiotLoginBrowser } from "super-looi/native";
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
} from "./generated/looi-runtime.js";

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
      homeLogin = new MiotLoginFlow({
        runtime: opened,
        browser: () => new MiotLoginBrowser(),
        active: () => alive && lifecycle() === "active",
        onRunning: (value) => { if (alive) homeLoggingIn.set(value); },
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
    voice?.close();
    driver.dispose();
    void runtime?.close().catch(() => {});
  });

  const api = {
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
    cancelHomeLogin() { homeLogin?.cancel(); },
    async loginMiot(region: HomeConfiguration["region"]) {
      if (!runtime || !homeLogin) throw new Error("本机运行时尚未就绪");
      voice?.stop();
      homeDevices.set({});
      try {
        const connection = await homeLogin.start(region, action());
        homeConnection.set(connection);
        if (connection.configured && connection.connectionId) homeDevices.set(await runtime.listHome());
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
