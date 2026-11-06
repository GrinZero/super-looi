import { cleanup, effect, lifecycle, reduceMotion, signal } from "nsh";
import { CredentialVault, NodeCompat } from "super-looi/native";
import {
  openRuntime,
  RobotFaceController,
  type NativeRuntime,
  type NativeStep,
  type UiAction,
} from "./generated/looi-runtime.js";

/** One owner for the surface. Credentials stay in the native vault/runtime. */
export function createAppStore() {
  const ready = signal(false),
    busy = signal(false),
    status = signal("本机正在启动"),
    message = signal("");
  const configuration = signal({ baseUrl: "", model: "", hasKey: false });
  const recoveryCount = signal(0);
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
      driver.setExpression("sleeping");
      void stop();
    } else driver.setExpression(busy() ? "thinking" : "neutral");
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
      configuration.set(opened.configuration());
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
    driver.dispose();
    void runtime?.close().catch(() => {});
  });

  return {
    ready: () => ready(),
    busy: () => busy(),
    status: () => status(),
    message: () => message(),
    face: () => face(),
    configuration: () => configuration(),
    recoveryCount: () => recoveryCount(),
    interaction: () => interaction(),
    async configure(value: { baseUrl: string; model: string; apiKey: string }) {
      if (!runtime) throw new Error("本机存储尚未就绪");
      await runtime.configure(value);
      configuration.set(runtime.configuration());
      status.set("模型已配置");
      message.set("");
    },
    async send(prompt: string) {
      if (busy() || !runtime || !prompt.trim()) return false;
      busy.set(true);
      message.set("");
      status.set("正在思考");
      try {
        const result = await runtime.run(prompt, action(), (event) => {
          if (!alive) return;
          status.set(event.summary);
          if (event.interaction && event.taskId)
            interaction.set({ ...event.interaction, taskId: event.taskId });
        });
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
}
