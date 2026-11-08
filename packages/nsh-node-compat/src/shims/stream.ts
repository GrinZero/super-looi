import { EventEmitter } from "./events.js";
export class Readable extends EventEmitter implements AsyncIterable<Buffer> {
  private chunks: Buffer[] = [];
  private waiters: Array<() => void> = [];
  private ended = false;
  destroyed = false;
  readable = true;
  push(chunk: Uint8Array | string | null) {
    if (chunk === null) {
      this.ended = true;
      this.emit("end");
    } else {
      const data = Buffer.from(chunk);
      if (!this.listenerCount("data")) this.chunks.push(data);
      this.emit("data", data);
    }
    this.waiters.splice(0).forEach((fn) => fn());
    return true;
  }
  destroy(error?: Error) {
    this.destroyed = true;
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
    return this;
  }
  pause() {
    return this;
  }
  pipe<T extends Writable>(destination: T): T {
    this.on("data", (chunk) => destination.write(chunk));
    this.on("end", () => destination.end());
    return destination;
  }
  async *[Symbol.asyncIterator]() {
    while (!this.ended || this.chunks.length) {
      if (this.chunks.length) yield this.chunks.shift()!;
      else await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
  static from(
    chunks: Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>,
  ) {
    const stream = new Readable();
    queueMicrotask(async () => {
      try {
        for await (const chunk of chunks) stream.push(chunk);
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
  write(
    _data: Uint8Array | string,
    _encoding?: unknown,
    callback?: () => void,
  ) {
    callback?.();
    return true;
  }
  end(data?: Uint8Array | string) {
    if (data !== undefined) this.write(data);
    this.emit("finish");
    return this;
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}
export class PassThrough extends Readable {
  write(chunk: Uint8Array | string) {
    return this.push(chunk);
  }
  end(chunk?: Uint8Array | string) {
    if (chunk !== undefined) this.push(chunk);
    this.push(null);
    return this;
  }
}
export default { Readable, Writable, PassThrough };
