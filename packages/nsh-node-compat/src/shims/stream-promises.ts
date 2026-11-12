import type { EventEmitter } from "./events.js";

interface Stream extends EventEmitter {
  readable?: boolean;
  readableEnded?: boolean;
  writable?: boolean;
  writableFinished?: boolean;
  destroyed?: boolean;
  closed?: boolean;
  errored?: Error | null;
  destroy(error?: Error): unknown;
  write?(chunk: unknown): boolean;
  end?(): unknown;
}
export interface FinishedOptions {
  readable?: boolean;
  writable?: boolean;
  error?: boolean;
  cleanup?: boolean;
  signal?: AbortSignal;
}
export interface PipelineOptions {
  signal?: AbortSignal;
  end?: boolean;
}
type Source = Iterable<unknown> | AsyncIterable<unknown>;
type Stage = Stream | Source | ((...args: any[]) => unknown);

function abortError(signal?: AbortSignal) {
  return Object.assign(
    new Error("The operation was aborted", { cause: signal?.reason }),
    { name: "AbortError", code: "ABORT_ERR" },
  );
}
function prematureClose() {
  return Object.assign(new Error("Premature close"), {
    code: "ERR_STREAM_PREMATURE_CLOSE",
  });
}
function isStream(value: unknown): value is Stream {
  return !!value && typeof (value as Stream).on === "function";
}
function isSource(value: unknown): value is Source {
  return value != null && (
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function" ||
    typeof (value as Iterable<unknown>)[Symbol.iterator] === "function"
  );
}

// Stream state belongs to the existing shims; this observer only owns listeners.
function watch(stream: Stream, options: FinishedOptions) {
  const readable = options.readable ?? typeof stream.readable === "boolean";
  const writable = options.writable ?? typeof stream.writable === "boolean";
  let readDone = !readable || stream.readableEnded === true;
  let writeDone = !writable || stream.writableFinished === true;
  let settled = false;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const cleanup = () => {
    stream.off("end", onEnd);
    stream.off("finish", onFinish);
    stream.off("close", onClose);
    if (options.error !== false) stream.off("error", onError);
    options.signal?.removeEventListener("abort", onAbort);
  };
  const settle = (error?: unknown) => {
    if (settled) return;
    settled = true;
    options.signal?.removeEventListener("abort", onAbort);
    if (options.cleanup) cleanup();
    if (error !== undefined) reject(error);
    else resolve();
  };
  const check = () => {
    if (readDone && writeDone) settle();
  };
  const onEnd = () => {
    readDone = true;
    check();
  };
  const onFinish = () => {
    writeDone = true;
    check();
  };
  const onError = (error: unknown) => settle(error);
  const onClose = () => {
    if (readDone && writeDone) settle();
    else settle(prematureClose());
  };
  const onAbort = () => settle(abortError(options.signal));
  stream.on("end", onEnd).on("finish", onFinish).on("close", onClose);
  if (options.error !== false) stream.on("error", onError);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  else if (stream.errored && options.error !== false) onError(stream.errored);
  else if (stream.closed || stream.destroyed) onClose();
  else check();
  return { promise, cleanup };
}

export async function finished(
  stream: Stream,
  options: FinishedOptions = {},
): Promise<void> {
  return watch(stream, options).promise;
}

export async function pipeline(
  ...args: Array<Stage | Stage[] | PipelineOptions>
): Promise<unknown> {
  let options: PipelineOptions = {};
  const last = args[args.length - 1];
  if (
    last && typeof last === "object" && !Array.isArray(last) &&
    !isStream(last) && !isSource(last)
  ) {
    options = args.pop() as PipelineOptions;
  }
  const stages = (
    args.length === 1 && Array.isArray(args[0]) ? args[0] : args
  ) as Stage[];
  if (stages.length < 2) throw new TypeError("pipeline requires at least two stages");

  const controller = new AbortController();
  const streams = new Set<Stream>();
  const cleanups: Array<() => void> = [];
  const completions: Promise<unknown>[] = [];
  let rejectFailure!: (error: unknown) => void;
  let failed = false;
  let consumerFinished = false;
  let completeConsumer!: () => void;
  const consumerDone = new Promise<void>((resolve) => {
    completeConsumer = resolve;
  });
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  // Attach a handler before a pre-aborted signal or a synchronous stage can fail.
  failure.catch(() => {});
  const fail = (error: unknown) => {
    if (failed || consumerFinished) return;
    failed = true;
    rejectFailure(error);
    controller.abort(error);
    for (const stream of streams) {
      if (!stream.destroyed) stream.destroy(error as Error);
    }
  };
  const observe = (stream: Stream, index: number) => {
    if (streams.has(stream)) return;
    streams.add(stream);
    stream.on("error", fail);
    const onClose = () => {
      if (!failed && !consumerFinished && (
        (index < stages.length - 1 && stream.readableEnded !== true) ||
        (index > 0 && stream.writableFinished !== true)
      )) fail(prematureClose());
    };
    stream.on("close", onClose);
    cleanups.push(() => stream.off("close", onClose));
    cleanups.push(() => stream.off("error", fail));
    const observer = watch(stream, {
      readable: index < stages.length - 1 && typeof stream.readable === "boolean",
      writable: index > 0 && typeof stream.writable === "boolean" &&
        (index < stages.length - 1 || options.end !== false),
    });
    cleanups.push(observer.cleanup);
    completions.push(
      observer.promise.catch((error) => {
        if (!consumerFinished) fail(error);
      }),
    );
  };
  // Observe all concrete endpoints before any producer can start emitting.
  stages.forEach((stage, index) => {
    if (isStream(stage)) observe(stage, index);
  });
  const onAbort = () => fail(abortError(options.signal));
  options.signal?.addEventListener("abort", onAbort, { once: true });

  async function pump(source: Source, destination: Stream, end: boolean) {
    for await (const chunk of source) {
      if (failed || consumerFinished) return;
      let onDrain!: () => void;
      // Register before write: shims and custom writers can emit synchronously.
      const drain = new Promise<void>((resolve) => {
        onDrain = resolve;
      });
      destination.once("drain", onDrain);
      try {
        if (!destination.write!(chunk))
          await Promise.race([drain, failure, consumerDone]);
      } finally {
        destination.off("drain", onDrain);
      }
    }
    if (!failed && !consumerFinished && end) destination.end!();
  }

  async function run() {
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    if (failed) return failure;
    let source: unknown = stages[0];
    if (typeof source === "function") source = source({ signal: controller.signal });
    if (isStream(source)) observe(source, 0);
    if (!isSource(source)) throw new TypeError("pipeline source must be iterable");
    const pumps: Promise<unknown>[] = [];
    let value: unknown;
    const finishConsumer = (result?: unknown) => {
      if (failed) return;
      value = result;
      // A function destination may intentionally stop reading early.
      consumerFinished = true;
      controller.abort();
      for (const stream of streams) {
        if (!stream.destroyed && stream.readableEnded !== true) stream.destroy();
      }
      completeConsumer();
    };
    for (let index = 1; index < stages.length; index++) {
      const stage = stages[index];
      const terminal = index === stages.length - 1;
      if (typeof stage === "function") {
        const result = stage(source, { signal: controller.signal });
        if (terminal) {
          if (isSource(result)) {
            pumps.push((async () => {
              for await (const _chunk of result) {
                if (failed) break;
              }
            })().then(() => finishConsumer()));
          } else {
            pumps.push(Promise.resolve(result).then(finishConsumer));
          }
        } else {
          if (!isSource(result)) throw new TypeError("pipeline transform must return an iterable");
          source = result;
        }
      } else {
        if (!isStream(stage) || !stage.write || !stage.end)
          throw new TypeError("pipeline destination must be writable");
        pumps.push(pump(source as Source, stage, !terminal || options.end !== false));
        if (!terminal) {
          if (!isSource(stage)) throw new TypeError("pipeline transform must be readable");
          source = stage;
        }
      }
    }
    await Promise.race([Promise.all([...pumps, ...completions]), consumerDone]);
    return value;
  }
  try {
    return await Promise.race([
      run().catch((error) => {
        fail(error);
        throw error;
      }),
      failure,
    ]);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    cleanups.forEach((cleanup) => cleanup());
  }
}

export default { pipeline, finished };
