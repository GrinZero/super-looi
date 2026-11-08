import { createNshCodemodeSandbox } from "../src/adapters/codemode.js";
import { assert, equal } from "./assert.js";
import { call } from "../src/bridge.js";
const sandbox = createNshCodemodeSandbox({
  timeoutMs: 2000,
  tools: [
    { name: "sum", execute: (args: any) => args.a + args.b },
    {
      name: "fail",
      execute: () => {
        throw new Error("tool failed");
      },
    },
  ],
});
const result = await sandbox.execute(
  `const a = await tools.sum({a:20,b:22}); text(a); console.log("computed"); store("answer",a); return {answer:a, seed:load("seed")};`,
  { store: { seed: "retained" } },
);
assert(result.ok, JSON.stringify(result));
equal(result.value, { answer: 42, seed: "retained" });
equal(result.storeWrites.set, { answer: 42 });
equal(
  result.calls.map((call) => call.name),
  ["sum"],
);
assert(
  result.output.some((item) => item.type === "text" && item.text === "42"),
);
const parallel = await sandbox.execute(
  `const results = await Promise.all([tools.sum({a:1,b:2}), tools.sum({a:3,b:4})]); return results;`,
);
assert(parallel.ok, JSON.stringify(parallel));
equal(parallel.value, [3, 7]);
const caught = await sandbox.execute(
  `try { await tools.fail({}); } catch (e) { return e.message; }`,
);
assert(caught.ok);
equal(caught.value, "tool failed");
const isolation = await sandbox.execute(
  `return [typeof process,typeof fetch,typeof require,typeof __nsh_compat,typeof setTimeout];`,
);
assert(isolation.ok);
equal(isolation.value, Array(5).fill("undefined"));
const thrown = await sandbox.execute(`throw new Error("script failure")`);
assert(!thrown.ok && thrown.error.kind === "script");
const parse = await sandbox.execute(`return (((`);
assert(!parse.ok && parse.error.kind === "script");
const stalled = await sandbox.execute(`await new Promise(()=>{});`);
assert(!stalled.ok, "stalled script must fail");
const timed = await sandbox.execute(`while(true) {}`);
assert(!timed.ok && timed.error.kind === "timeout", JSON.stringify(timed));
await sandbox.close();
const replay = async () => {
  const sandbox = createNshCodemodeSandbox({ timeoutMs: 2000 });
  let fingerprint = "";
  let run: ReturnType<typeof sandbox.start>;
  const calls: any[] = [];
  run = sandbox.start(
    `const before={now:Date.now(),random:Math.random(),tz:new Date().getTimezoneOffset()}; const answer=await tools.echo(before); return {before,answer,after:Date.now(),date:new Date(2000,0,1).toISOString(),weak:typeof WeakRef};`,
    {
      startedAt: 1700000000000,
      seed: 42,
      tools: [{ name: "echo" }],
      timeoutMs: 2000,
      onStarted(value) {
        fingerprint = value;
      },
      onCall(call) {
        calls.push(call);
        run.deliver(1, 1700000001234, call.id, {
          ok: true,
          value: { echo: call.args },
        });
      },
    },
  );
  const result = await run.result;
  assert(result.ok, JSON.stringify(result));
  equal((result.value as any).after, 1700000001234);
  equal((result.value as any).date, "2000-01-01T00:00:00.000Z");
  equal((result.value as any).weak, "undefined");
  await sandbox.close();
  return {
    fingerprint,
    calls,
    value: result.value,
    output: result.output,
    storeWrites: result.storeWrites,
    during: result.during,
  };
};
equal(await replay(), await replay(), "native deterministic replay");
console.log(
  "PASS pi-codemode@1.5.0: upstream portable sandbox/prelude, native isolated VM, tools/parallel/errors/store/output, time budget and deterministic replay (no Wasm or external service)",
);

const ordering = createNshCodemodeSandbox();
let orderedRun: ReturnType<typeof ordering.start>;
const ids: number[] = [];
orderedRun = ordering.start(
  `const a=tools.echo(1); const b=tools.echo(2); const first=await a; text(Date.now()); const second=await b; text(Date.now()); return [first,second];`,
  {
    startedAt: 1000,
    seed: 7,
    tools: [{ name: "echo" }],
    timeoutMs: 2000,
    onCall(call) {
      ids.push(call.id);
      if (ids.length === 2) {
        orderedRun.deliver(2, 1002, ids[1], { ok: true, value: 2 });
        orderedRun.deliver(1, 1001, ids[0], { ok: true, value: 1 });
      }
    },
  },
);
const ordered = await orderedRun.result;
assert(ordered.ok, JSON.stringify(ordered));
equal(ordered.value, [1, 2]);
equal(ordered.output, [
  { type: "text", text: "1001" },
  { type: "text", text: "1002" },
]);
await ordering.close();
const cancelSandbox = createNshCodemodeSandbox({
  tools: [
    {
      name: "wait",
      execute: (_args, ctx) =>
        new Promise((resolve) =>
          ctx.signal.addEventListener("abort", () => resolve("stopped"), {
            once: true,
          }),
        ),
    },
  ],
});
const abort = new AbortController();
const pending = cancelSandbox.execute("await tools.wait({})", {
  signal: abort.signal,
});
setTimeout(() => abort.abort(), 10);
const cancelled = await pending;
assert(!cancelled.ok && cancelled.error.kind === "aborted");
await cancelSandbox.close();
const memory = createNshCodemodeSandbox({ memoryLimitBytes: 2 * 1024 * 1024 });
const oom = await memory.execute("return new Array(10000000).fill('memory')");
assert(!oom.ok, "memory budget must stop allocations");
await memory.close();
console.log(
  "PASS native codemode: out-of-order deterministic replies, cancellation/close receipts and heap budget",
);

const asyncBudget = createNshCodemodeSandbox({ timeoutMs: 2000 });
const asyncLoop = await asyncBudget.execute(
  "await Promise.resolve();while(true){}",
);
assert(
  !asyncLoop.ok && asyncLoop.error.kind === "timeout",
  JSON.stringify(asyncLoop),
);
await asyncBudget.close();

// Native admission happens synchronously, before retaining inputs in futures.
const nativeStep = globalThis.__nsh_codemode_step!;
const rawId = call<string>("codemode.create");
const oversized = JSON.parse(
  await nativeStep(
    JSON.stringify({
      id: rawId,
      action: "deliver",
      padding: "x".repeat(4 * 1024 * 1024),
    }),
  ),
);
assert(
  oversized.error?.includes("input frame limit"),
  JSON.stringify(oversized),
);
const queued = Array.from({ length: 12 }, () =>
  nativeStep(JSON.stringify({ id: rawId, action: "deliver" })),
);
// Cleanup has reserved admission even while all data-plane permits are used.
const stopping = nativeStep(JSON.stringify({ id: rawId, action: "stop" }));
const admitted = (await Promise.all(queued)).map((value) => JSON.parse(value));
assert(
  admitted.some((value) => value.error?.includes("input admission")),
  "saturated ingress must reject before queuing raw frames",
);
assert(
  !JSON.parse(await stopping).error,
  "stop must remain available under saturation",
);

const earlySandbox = createNshCodemodeSandbox();
let earlyRun: ReturnType<typeof earlySandbox.start>;
const earlyIds: number[] = [];
earlyRun = earlySandbox.start(
  "return await Promise.all([tools.echo(1),tools.echo(2),tools.echo(3),tools.echo(4)])",
  {
    startedAt: 1000,
    seed: 1,
    tools: [{ name: "echo" }],
    timeoutMs: 3000,
    onCall(message) {
      earlyIds.push(message.id);
      if (earlyIds.length === 4) {
        for (let i = 1; i < 4; i++)
          earlyRun.deliver(i + 1, 1000 + i, earlyIds[i], {
            ok: true,
            value: "x".repeat(3 * 1024 * 1024),
          });
      }
    },
  },
);
const overflow = await earlyRun.result;
assert(
  !overflow.ok && overflow.error.message.includes("early result limit"),
  JSON.stringify(overflow).slice(0, 500),
);
await earlySandbox.close();
const reused = createNshCodemodeSandbox();
const reusedResult = await reused.execute("return 42");
assert(
  reusedResult.ok && reusedResult.value === 42,
  "capacity must be reusable after bridge overflow",
);
await reused.close();
console.log(
  "PASS native codemode resource bounds: async interrupt, frame/admission limits, reserved stop, early reply byte limit and capacity reuse",
);
