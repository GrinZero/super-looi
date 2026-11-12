import streams, { Readable, Writable, PassThrough, promises } from "node:stream";
import api, { pipeline, finished } from "node:stream/promises";
import bare from "stream/promises";
import fs from "node:fs";
import { assert, equal } from "./assert.js";

async function rejects(promise: Promise<unknown>, expected: unknown) {
  try { await promise; } catch (error) {
    if (typeof expected === "string") equal((error as { code: string }).code, expected);
    else assert(error === expected, "original error must propagate");
    return;
  }
  throw new Error("expected rejection");
}

assert(api === bare && api === promises && api === streams.promises);
fs.mkdirSync("/workspace/streams", { recursive: true });
const text = "hello 世界\n".repeat(20000);
fs.writeFileSync("/workspace/streams/input", text);
await pipeline(
  fs.createReadStream("/workspace/streams/input", { highWaterMark: 1024 }),
  new PassThrough(),
  fs.createWriteStream("/workspace/streams/output"),
);
equal(fs.readFileSync("/workspace/streams/output", "utf8"), text);

const transformed = "/workspace/streams/transformed";
await pipeline([
  Readable.from(["a", "b"]),
  async function* (source) {
    for await (const chunk of source) yield chunk.toString().toUpperCase();
  },
  fs.createWriteStream(transformed),
]);
equal(fs.readFileSync(transformed, "utf8"), "AB");
equal(await pipeline(
  async function* ({ signal }) { assert(!signal.aborted); yield "value"; },
  async (source) => { let value = ""; for await (const chunk of source) value += chunk; return value; },
), "value");
equal((await pipeline(
  Readable.from(["a", "b"]),
  async (source) => { for await (const chunk of source) return chunk; },
)).toString(), "a");
const earlyTransform = new PassThrough();
equal((await pipeline(
  Readable.from(["a", "b", "c", "d"]),
  earlyTransform,
  async (source) => { for await (const chunk of source) return chunk; },
)).toString(), "a");
await new Promise((resolve) => setTimeout(resolve, 1));
equal(earlyTransform.listenerCount("drain"), 0);
await pipeline(Readable.from(["a", "b"]), async function* (source) {
  for await (const chunk of source) { yield chunk; return; }
});

const openWriter = fs.createWriteStream("/workspace/streams/open");
await pipeline(["first"], openWriter, { end: false });
assert(!openWriter.writableEnded);
openWriter.end("second");
equal(fs.readFileSync("/workspace/streams/open", "utf8"), "firstsecond");

// End-of-input alone must not report completion while data is still buffered.
const buffered = new Readable();
buffered.push("queued");
buffered.push(null);
let readFinished = false;
const reading = finished(buffered, { cleanup: true }).then(() => { readFinished = true; });
await Promise.resolve();
assert(!readFinished);
const chunks = [];
for await (const chunk of buffered) chunks.push(chunk.toString());
await reading;
equal(chunks, ["queued"]);
equal(buffered.listenerCount("end"), 0);
await finished(buffered, { cleanup: true });
const resumed = Readable.from(["discarded"]);
resumed.resume();
await finished(resumed, { cleanup: true });

const duplex = new PassThrough();
let duplexDone = false;
const both = finished(duplex, { cleanup: true }).then(() => { duplexDone = true; });
duplex.end("duplex");
await Promise.resolve();
assert(!duplexDone);
for await (const _chunk of duplex) { /* consume readable side */ }
await both;
const writable = new Writable();
writable.end();
await finished(writable, { cleanup: true });

const closed = new Readable();
const closedDone = finished(closed, { cleanup: true });
closed.destroy();
await rejects(closedDone, "ERR_STREAM_PREMATURE_CLOSE");
await rejects(finished(closed, { cleanup: true }), "ERR_STREAM_PREMATURE_CLOSE");

const original = new Error("producer failed");
const failedSource = Readable.from((async function* () { yield "first"; throw original; })());
const failedDestination = new Writable();
await rejects(pipeline(failedSource, failedDestination), original);
assert(failedSource.destroyed && failedDestination.destroyed);
equal(failedSource.listenerCount("error"), 0);

const writeError = new Error("write failed");
class FailingWriter extends Writable {
  override write() { this.destroy(writeError); return false; }
}
const destroyedSource = new Readable();
const writeFailure = pipeline(destroyedSource, new FailingWriter());
destroyedSource.push("trigger");
await rejects(writeFailure, writeError);
assert(destroyedSource.destroyed);
const openSource = new Readable();
const closedSink = new Writable();
const earlyClose = pipeline(openSource, closedSink, { end: false });
closedSink.destroy();
openSource.push("discarded");
openSource.push(null);
await rejects(earlyClose, "ERR_STREAM_PREMATURE_CLOSE");

// A false write return must delay the next write until drain.
let writes = 0;
let drained = false;
class SlowWriter extends Writable {
  override write() {
    writes++;
    if (writes === 1) {
      setTimeout(() => { drained = true; this.emit("drain"); }, 1);
      return false;
    }
    assert(drained);
    return true;
  }
}
await pipeline(["one", "two"], new SlowWriter());
equal(writes, 2);

const controller = new AbortController();
const pending = new Readable();
const sink = new Writable();
const cancelled = pipeline(pending, sink, { signal: controller.signal });
controller.abort();
await rejects(cancelled, "ABORT_ERR");
assert(pending.destroyed && sink.destroyed);
equal(pending.listenerCount("error"), 0);
await rejects(pipeline(new Readable(), new Writable(), { signal: controller.signal }), "ABORT_ERR");

const observeController = new AbortController();
const observed = new Readable();
const observation = finished(observed, { signal: observeController.signal, cleanup: true });
observeController.abort();
await rejects(observation, "ABORT_ERR");
assert(!observed.destroyed, "finished abort only stops waiting");
equal(observed.listenerCount("error"), 0);

const retained = new Writable();
const retainedDone = finished(retained);
retained.end();
await retainedDone;
assert(retained.listenerCount("error") > 0);
retained.emit("error", new Error("late stream error"));
console.log("PASS stream/promises: imports, file pipeline, transforms, finished, errors, drain and abort");
