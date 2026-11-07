type Listener = (...args: any[]) => void;
export class EventEmitter {
  private handlers = new Map<string | symbol, Listener[]>();
  on(event: string | symbol, listener: Listener): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
    return this;
  }
  addListener = this.on;
  once(event: string | symbol, listener: Listener): this {
    const once: Listener & { listener?: Listener } = (...args: any[]) => {
      this.off(event, once);
      listener(...args);
    };
    once.listener = listener;
    return this.on(event, once);
  }
  off(event: string | symbol, listener: Listener): this {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter(
        (fn) => fn !== listener && (fn as any).listener !== listener,
      ),
    );
    return this;
  }
  removeListener = this.off;
  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.handlers.clear();
    else this.handlers.delete(event);
    return this;
  }
  emit(event: string | symbol, ...args: any[]): boolean {
    const listeners = [...(this.handlers.get(event) ?? [])];
    if (event === "error" && !listeners.length) throw args[0];
    for (const listener of listeners) listener(...args);
    return listeners.length > 0;
  }
  listenerCount(event: string | symbol) {
    return this.handlers.get(event)?.length ?? 0;
  }
  setMaxListeners(_count: number) {
    return this;
  }
}
export function once(emitter: EventEmitter, event: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const done = (...args: any[]) => {
      emitter.off("error", fail);
      resolve(args);
    };
    const fail = (error: Error) => {
      emitter.off(event, done);
      reject(error);
    };
    emitter.once(event, done);
    if (event !== "error") emitter.once("error", fail);
  });
}
export default EventEmitter;
