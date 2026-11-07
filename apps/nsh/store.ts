import { cleanup, effect, lifecycle, reduceMotion, signal } from "nsh";
import { CredentialVault, NodeCompat, VoiceAudio } from "super-looi/native";
import { connect } from "websocket";
import {
  VoiceRuntime,
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
    status = signal("本机正在启动"),
    message = signal("");
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
  });
  const homeConnection = signal<HomeConnection | undefined>(undefined);
  const homeDevices = signal<Record<string, unknown>>({});
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
    message.set(error instanceof Error ? error.message : String(error));
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
    if (lifecycle() !== "active") {
      voice?.stop();
      driver.setExpression("sleeping");
      void stop();
    } else
      driver.setExpression(
        busy()
          ? "thinking"
          : voiceState().phase === "speaking"
            ? "speaking"
            : voiceState().phase === "listening"
              ? "listening"
              : "neutral",
      );
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
          if (alive) voiceState.set(state);
        },
        requestTask: (prompt) =>
          new Promise((resolve, reject) => {
            if (!alive || pendingVoice || voiceExecuting || busy()) {
              reject(new Error("已有任务，请稍后"));
              return;
            }
            voiceTask.set(prompt);
            pendingVoice = {
              resolve,
              reject,
              timer: setTimeout(() => cancelVoiceTask(), 60000),
            };
          }),
        cancelTask: cancelVoiceTask,
      });
      voiceConfigured.set(voice.configuration().hasKey);
      voiceState.set(voice.snapshot());
      configuration.set(opened.configuration());
      homeConfiguration.set(opened.homeConfiguration());
      homeConnection.set(opened.homeConnection());
      recoveryCount.set(opened.recoveryCount());
      ready.set(true);
      status.set(recoveryCount() ? "上次任务结果待核实" : "本机就绪");
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
    voice?.close();
    driver.dispose();
    void runtime?.close().catch(() => {});
  });

  const api = {
    voiceState: () => voiceState(),
    voiceConfigured: () => voiceConfigured(),
    voiceTask: () => voiceTask(),
    async startVoice() {
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
    status: () =>
      busy()
        ? status()
        : voiceTask()
          ? "语音任务待确认"
          : voiceState().phase === "connecting"
            ? "语音连接中"
            : voiceState().phase === "speaking"
              ? "正在说话"
              : voiceState().phase === "listening"
                ? voiceState().muted
                  ? "语音已静音"
                  : "正在聆听"
                : status(),
    message: () => message(),
    face: () => face(),
    configuration: () => configuration(),
    recoveryCount: () => recoveryCount(),
    homeConfiguration: () => homeConfiguration(),
    homeConnection: () => homeConnection(),
    homeDevices: () => homeDevices(),
    async configureHome(value: Parameters<NativeRuntime["configureHome"]>[0]) {
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
        message.set("新对话已开始，原任务记录仍保留。");
        status.set("本机就绪");
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
      status.set("模型已配置");
      message.set("");
    },
    async send(prompt: string, agentOnly = false) {
      if (busy() || !runtime || !prompt.trim()) return false;
      busy.set(true);
      message.set("");
      status.set("正在思考");
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
          { agentOnly },
        );
        if (alive) {
          message.set(result.answer);
          status.set(result.runtimeExited ? "本机就绪" : "任务结果待核实");
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
