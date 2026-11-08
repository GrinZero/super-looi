import { EventEmitter } from "./events.js";

export class Server extends EventEmitter {
  private _port = 1455;
  private _listening = false;
  private _closed = false;

  constructor(requestListener?: (...args: any[]) => void) {
    super();
    if (requestListener) {
      this.on("request", requestListener);
    }
  }

  listen(...args: any[]): this {
    if (typeof args[0] === "number") {
      this._port = args[0];
    } else if (
      typeof args[0] === "object" &&
      args[0] !== null &&
      typeof args[0].port === "number"
    ) {
      this._port = args[0].port;
    }

    const last = args[args.length - 1];
    const callback = typeof last === "function" ? last : undefined;

    this._listening = true;
    this._closed = false;

    queueMicrotask(() => {
      if (this._listening && !this._closed) {
        if (callback) {
          callback();
        }
        this.emit("listening");
      }
    });

    return this;
  }

  address(): { address: string; family: string; port: number } {
    return {
      address: "127.0.0.1",
      family: "IPv4",
      port: this._port,
    };
  }

  close(cb?: (err?: Error) => void): this {
    this._listening = false;
    this._closed = true;
    if (cb) {
      queueMicrotask(() => cb());
    }
    this.emit("close");
    return this;
  }

  closeAllConnections(): this {
    return this;
  }

  closeIdleConnections(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  ref(): this {
    return this;
  }
}

export function createServer(
  requestListener?: (...args: any[]) => void,
): Server {
  return new Server(requestListener);
}

export const STATUS_CODES: Record<number, string> = {};
export const METHODS: readonly string[] = ["GET", "POST"];

const http = {
  Server,
  createServer,
  STATUS_CODES,
  METHODS,
};

export default http;
