import { MiotLoginFlow, type LoginBrowser } from "../runtime/miot-login.js";
import type { HomeConnection } from "../runtime/home.js";
import type { UserActionRef } from "@super-looi/contracts";

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function rejects(promise: Promise<unknown>) { try { await promise; } catch { return; } throw new Error("login unexpectedly succeeded"); }
const action = { event_id: "tap", ui_session_id: "fixture", kind: "tap", captured_at: new Date().toISOString(), expires_at: new Date(Date.now() + 10000).toISOString() } as UserActionRef;
const connection = { mode: "direct_miot", simulation: false, configured: true, healthy: true, connectionId: "fixture", lastVerifiedAt: null, error: null, entityCount: 0 } as HomeConnection;
const session = (attempt: number) => ({ authorizationUrl: "fixture", redirectUri: "fixture", expiresAt: Date.now() + 10000, attempt });

export async function verifyMiotLoginFlow() {
  for (const invalidate of ["none", "background", "native-cancel", "native-throws"]) {
    let active = true, state = "idle", cancelCalls = 0, takes = 0, commits = 0;
    const started = deferred<void>(), resume = deferred<void>();
    const running: boolean[] = [];
    const browser: LoginBrowser = {
      open() { state = "callback"; },
      status() { if (state === "throws") throw new Error("native disposed"); return state; },
      takeCallback() { takes++; state = "consumed"; return "fixture-callback"; },
      cancel() { state = "cancelled"; },
    };
    const flow = new MiotLoginFlow({ browser: () => browser, active: () => active, onRunning: (value) => running.push(value), runtime: {
      beginMiotLogin: async () => session(1),
      async finishMiotLogin(attempt, callback, valid) {
        check(attempt === 1 && callback === "fixture-callback" && valid(), "valid consumed callback rejected");
        started.resolve(); await resume.promise;
        if (!valid()) throw new Error("cancelled at commit");
        commits++; return connection;
      },
      cancelMiotLogin() { cancelCalls++; },
    } });
    const result = flow.start("cn", action);
    await started.promise;
    await rejects(flow.start("cn", action));
    if (invalidate === "background") active = false;
    if (invalidate === "native-cancel") state = "cancelled";
    if (invalidate === "native-throws") state = "throws";
    resume.resolve();
    if (invalidate === "none") {
      check((await result).healthy && commits === 1 && cancelCalls === 0, "successful commit cancelled its account");
    } else { await rejects(result); check(commits === 0 && cancelCalls === 1, "invalid native session committed"); }
    check(takes === 1 && running.join() === "true,false", "login callback replay or running state leak");
  }

  // Old begin completion must not open a browser or cancel a replacement attempt.
  const oldBegin = deferred<ReturnType<typeof session>>();
  let begins = 0, opens = 0, cancels = 0;
  const flow = new MiotLoginFlow({ active: () => true, onRunning() {}, browser: () => {
    let state = "idle";
    return { open() { opens++; state = "callback"; }, status: () => state,
      takeCallback() { state = "consumed"; return "fixture"; }, cancel() { state = "cancelled"; } };
  }, runtime: {
    beginMiotLogin: async () => ++begins === 1 ? oldBegin.promise : session(2),
    finishMiotLogin: async (attempt, _callback, valid) => { check(attempt === 2 && valid(), "stale attempt finished"); return connection; },
    cancelMiotLogin() { cancels++; },
  } });
  const old = flow.start("cn", action);
  flow.cancel();
  const replacement = flow.start("sg", action);
  oldBegin.resolve(session(1));
  await rejects(old);
  check((await replacement).healthy && opens === 1 && cancels === 1, "old login altered its replacement");
}
