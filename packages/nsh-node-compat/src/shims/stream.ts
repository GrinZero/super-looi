import { EventEmitter } from "./events.js";
import promises from "./stream-promises.js";
export { promises };
export class Readable extends EventEmitter implements AsyncIterable<Buffer> {
  private chunks: Buffer[] = [];
  private waiters: Array<() => void> = [];
  private ended = false;
  private flowing = false;
  destroyed = false;
  readable = true;
  readableEnded = false;
  closed = false;
  errored: Error | null = null;
  private finishReading() {
    if (
      this.ended && !this.chunks.length && !this.readableEnded && !this.destroyed
    ) {
      this.readableEnded = true;
      this.readable = false;
      this.emit("end");
    }
  }
  push(chunk: Uint8Array | string | null) {
    if (this.destroyed) return false;
    if (chunk === null) {
      this.ended = true;
      this.finishReading();
    } else {
      const data = Buffer.from(chunk);
      if (!this.flowing && !this.listenerCount("data")) this.chunks.push(data);
      this.emit("data", data);
    }
    this.waiters.splice(0).forEach((fn) => fn());
    return true;
  }
  destroy(error?: Error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.closed = true;
    this.readable = false;
    this.errored = error ?? null;
    this.ended = true;
    this.waiters.splice(0).forEach((fn) => fn());
    if (error) this.emit("error", error);
    this.emit("close");
    return this;
  }
  setEncoding(_encoding: string) {
    return this;
  }
  resume() {
    this.flowing = true;
    queueMicrotask(() => {
      while (this.flowing && this.chunks.length && !this.destroyed)
        this.emit("data", this.chunks.shift()!);
      this.finishReading();
    });
    return this;
  }
  pause() {
    this.flowing = false;
    return this;
  }
  pipe<T extends Writable>(destination: T): T {
    this.on("data", (chunk) => destination.write(chunk));
    this.on("end", () => destination.end());
    return destination;
  }
  async *[Symbol.asyncIterator]() {
    while (!this.ended || this.chunks.length) {
      if (this.errored) throw this.errored;
      if (this.destroyed) return;
      if (this.chunks.length) yield this.chunks.shift()!;
      else await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.errored) throw this.errored;
    this.finishReading();
  }
  static from(
    chunks: Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>,
  ) {
    const stream = new Readable();
    queueMicrotask(async () => {
      try {
        for await (const chunk of chunks) {
          if (stream.destroyed) break;
          stream.push(chunk);
        }
        stream.push(null);
      } catch (e) {
        stream.destroy(e as Error);
      }
    });
    return stream;
  }
}
export class Writable extends EventEmitter {
  destroyed = false;
  writable = true;
  writableEnded = false;
  writableFinished = false;
  closed = false;
  errored: Error | null = null;
  write(
    _data: Uint8Array | string,
    _encoding?: unknown,
    callback?: () => void,
  ) {
    callback?.();
    return true;
  }
  end(data?: Uint8Array | string) {
    if (this.writableEnded || this.destroyed) return this;
    if (data !== undefined) this.write(data);
    this.writableEnded = true;
    this.writableFinished = true;
    this.writable = false;
    this.emit("finish");
    return this;
  }
  destroy(error?: Error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.closed = true;
    this.writable = false;
    this.errored = error ?? null;
    if (error) this.emit("error", error);
    this.emit("close");
    return this;
  }
}
export class PassThrough extends Readable {
  writable = true;
  writableEnded = false;
  writableFinished = false;
  override destroy(error?: Error) {
    this.writable = false;
    return super.destroy(error);
  }
  write(chunk: Uint8Array | string) {
    return this.push(chunk);
  }
  end(chunk?: Uint8Array | string) {
    if (this.writableEnded || this.destroyed) return this;
    if (chunk !== undefined) this.push(chunk);
    this.writableEnded = true;
    this.writableFinished = true;
    this.writable = false;
    this.emit("finish");
    this.push(null);
    return this;
  }
}
export default { Readable, Writable, PassThrough, promises };
