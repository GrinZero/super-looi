import {
  RemoteCodemodeSandbox,
  type CodemodeRemote,
  type CodemodeRemoteExchange,
  type CodemodeRemoteMessage,
  type CodemodeRemoteReply,
  type CodemodeRemoteRequest,
  type RemoteCodemodeSandboxOptions,
} from "@earendil-works/pi-codemode/portable";
import { call, unsupported } from "../bridge.js";
// Source module resolved by nshCodemodePlugin. This is the unmodified upstream
// prelude; it is evaluated only in the dedicated native sandbox VM.
import { PRELUDE_SOURCE } from "pi-codemode-native/prelude";
declare global {
  var __nsh_codemode_step: ((request: string) => Promise<string>) | undefined;
}
async function step(
  id: string,
  action: string,
  args: Record<string, unknown> = {},
) {
  if (!globalThis.__nsh_codemode_step) unsupported("native codemode host");
  const result = JSON.parse(
    await globalThis.__nsh_codemode_step(
      JSON.stringify({ id, action, ...args }),
    ),
  ) as { value?: CodemodeRemoteMessage[]; error?: string };
  if (result.error) throw new Error(result.error);
  // JSON has no undefined. Native bridge omits optional fields after this hop.
  return result.value!.map((message) => {
    for (const [key, value] of Object.entries(message))
      if (value === null) delete (message as any)[key];
    return message;
  });
}
/** All "remote" work is performed by a native actor in the current app process. */
export class NshCodemodeRemote implements CodemodeRemote {
  private active = new Map<string, Promise<void>>();
  private closed = false;
  private cleanupErrors: unknown[] = [];
  async execute(
    request: CodemodeRemoteRequest,
    exchange: CodemodeRemoteExchange,
  ): Promise<void> {
    if (this.closed) return;
    const id = call<string>("codemode.create");
    let stopping = false,
      terminal = false;
    let deliveries = Promise.resolve();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    this.active.set(id, finished);
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      call("codemode.cancel", { id });
      try {
        await step(id, "stop");
      } catch (error) {
        this.cleanupErrors.push(error);
      } finally {
        this.active.delete(id);
        finish();
      }
    };
    const fail = async (error: unknown) => {
      if (!terminal && !stopping) {
        terminal = true;
        await exchange([
          {
            type: "failure",
            error: { kind: "sandbox", message: String(error) },
          },
        ]).catch(() => null);
      }
      await stop();
    };
    const dispatch = (messages: CodemodeRemoteMessage[]) => {
      for (const message of messages) {
        if (stopping || terminal) break;
        if (
          message.type === "done" ||
          message.type === "crash" ||
          message.type === "failure"
        ) {
          terminal = true;
          void exchange([message])
            .catch(() => null)
            .then(stop);
          break;
        }
        // One call per exchange: the upstream client indexes its waiter by that id.
        void exchange([message])
          .then(async (reply: CodemodeRemoteReply) => {
            if (stopping || terminal || reply === null) return;
            if (reply.type === "stop") {
              await stop();
              return;
            }
            deliveries = deliveries
              .then(async () => {
                if (!stopping && !terminal)
                  dispatch(await step(id, "deliver", { message: reply }));
              })
              .catch(fail);
            await deliveries;
          })
          .catch(fail);
      }
    };
    try {
      dispatch(
        await step(id, "start", { ...request, prelude: PRELUDE_SOURCE }),
      );
      await finished;
    } catch (error) {
      await fail(error);
    }
  }
  blockNewRuns() {
    this.closed = true;
  }
  async waitForIdle() {
    await Promise.all([...this.active.values()]);
    if (this.cleanupErrors.length)
      throw new AggregateError(
        this.cleanupErrors,
        "Native codemode cleanup failed",
      );
  }
  cancelAll() {
    for (const id of this.active.keys()) call("codemode.cancel", { id });
  }
}
export class NshCodemodeSandbox extends RemoteCodemodeSandbox {
  private native: NshCodemodeRemote;
  constructor(options: Omit<RemoteCodemodeSandboxOptions, "remote"> = {}) {
    const native = new NshCodemodeRemote();
    super({ ...options, remote: () => native });
    this.native = native;
  }
  override async close() {
    this.native.blockNewRuns();
    this.native.cancelAll();
    await super.close();
    await this.native.waitForIdle();
  }
}
export function createNshCodemodeSandbox(
  options: Omit<RemoteCodemodeSandboxOptions, "remote"> = {},
) {
  return new NshCodemodeSandbox(options);
}
