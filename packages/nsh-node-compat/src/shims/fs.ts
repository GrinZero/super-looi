import process from "./process.js";
import { call, unsupported } from "../bridge.js";
import { Readable, Writable } from "./stream.js";
import { EventEmitter } from "./events.js";
type Path = string | URL;
type Encoding =
  | BufferEncoding
  | { encoding?: BufferEncoding | null; flag?: string; flush?: boolean }
  | null;
const path = (p: Path): string => {
  if (typeof p !== "string") {
    if (p.protocol !== "file:" || (p.hostname && p.hostname !== "localhost"))
      unsupported("non-local file URL");
    p = decodeURIComponent(p.pathname);
  }
  return p.startsWith("/") || p === "~" || p.startsWith("~/")
    ? p
    : `${process.cwd()}/${p}`;
};
const encoding = (options?: Encoding) =>
  typeof options === "string" ? options : options?.encoding;
const bytes = (data: string | Uint8Array, options?: Encoding) =>
  Array.from(
    typeof data === "string"
      ? Buffer.from(data, encoding(options) ?? "utf8")
      : data,
  );
export const constants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  COPYFILE_EXCL: 1,
  O_RDONLY: 0,
  O_NOFOLLOW: 0x20000,
};
export class Stats {
  size: number;
  mtimeMs: number;
  mtime: Date;
  ctime: Date;
  private data: any;
  constructor(data: any) {
    this.data = data;
    this.size = data.size;
    this.mtimeMs = data.mtimeMs;
    this.mtime = new Date(data.mtimeMs);
    this.ctime = this.mtime;
  }
  isDirectory() {
    return this.data.directory;
  }
  isFile() {
    return this.data.file;
  }
  isSymbolicLink() {
    return this.data.symlink;
  }
}
export class Dirent {
  name: string;
  private data: any;
  constructor(data: any) {
    this.name = data.name;
    this.data = data;
  }
  isDirectory() {
    return this.data.directory;
  }
  isFile() {
    return this.data.file;
  }
  isSymbolicLink() {
    return this.data.symlink;
  }
}
export function readFileSync(p: Path, options?: Encoding): any {
  const data = Buffer.from(call<number[]>("fs.read", { path: path(p) }));
  const enc = encoding(options);
  return enc ? data.toString(enc) : data;
}
export function writeFileSync(
  p: Path | number,
  data: string | Uint8Array,
  options?: Encoding,
) {
  if (typeof p === "number") {
    call("fs.writefd", { fd: p, data: bytes(data, options) });
    return;
  }
  return call<void>("fs.write", {
    path: path(p),
    data: bytes(data, options),
    flush: typeof options === "object" && options?.flush,
  });
}
export function appendFileSync(
  p: Path,
  data: string | Uint8Array,
  options?: Encoding,
) {
  return call<void>("fs.append", { path: path(p), data: bytes(data, options) });
}
export function statSync(p: Path) {
  return new Stats(call("fs.stat", { path: path(p) }));
}
export function lstatSync(p: Path) {
  return new Stats(call("fs.lstat", { path: path(p) }));
}
export function utimesSync(p: Path, atime: Date | string | number, mtime: Date | string | number) {
  const seconds = (value: Date | string | number) => {
    const result = value instanceof Date ? value.getTime() / 1000 : Number(value);
    if (!Number.isFinite(result)) throw new TypeError("ERR_INVALID_ARG_VALUE: invalid file timestamp");
    return result;
  };
  return call<void>("fs.utimes", { path: path(p), atime: seconds(atime), mtime: seconds(mtime) });
}
export function existsSync(p: Path) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
export function accessSync(p: Path, mode = 0) {
  statSync(p);
  if (mode & constants.X_OK) unsupported("executable files");
}
export function mkdirSync(
  p: Path,
  options?: { recursive?: boolean; mode?: number } | number,
) {
  return call<void>("fs.mkdir", {
    path: path(p),
    recursive: typeof options === "object" && options.recursive,
  });
}
export function readdirSync(
  p: Path,
  options?: { withFileTypes?: boolean },
): any[] {
  const entries = call<any[]>("fs.readdir", { path: path(p) });
  return entries.map((entry) =>
    options?.withFileTypes ? new Dirent(entry) : entry.name,
  );
}
export function rmSync(
  p: Path,
  options?: { recursive?: boolean; force?: boolean },
) {
  return call<void>("fs.rm", { path: path(p), ...options });
}
export const unlinkSync = (p: Path) => rmSync(p);
export const rmdirSync = (p: Path) => rmSync(p);
export const renameSync = (p: Path, dest: Path) =>
  call<void>("fs.rename", { path: path(p), dest: path(dest) });
export const copyFileSync = (p: Path, dest: Path) =>
  call<void>("fs.copy", { path: path(p), dest: path(dest) });
export const realpathSync = (p: Path) =>
  call<string>("fs.realpath", { path: path(p) });
export const chmodSync = (_p: Path, _mode: number) => unsupported("chmod");
export const globSync = (_pattern: string) =>
  unsupported("globSync; register precompiled resources instead");
export function openSync(p: Path, flags: string | number = "r") {
  let nofollow = false;
  if (typeof flags === "number") {
    nofollow = Boolean(flags & constants.O_NOFOLLOW);
    if ((flags & ~constants.O_NOFOLLOW) !== 0)
      unsupported(`numeric open flag ${flags}`);
    flags = "r";
  }
  if (!["r", "w", "wx", "a"].includes(flags)) unsupported(`open flag ${flags}`);
  return call<number>("fs.open", { path: path(p), flags, nofollow });
}
export function readSync(
  fd: number,
  buffer: Uint8Array,
  offset = 0,
  length = buffer.byteLength - offset,
  position: number | null = null,
) {
  if (offset < 0 || length < 0 || offset + length > buffer.byteLength)
    throw new RangeError("invalid read buffer range");
  const data = call<number[]>("fs.readfd", { fd, offset: position, length });
  buffer.set(data, offset);
  return data.length;
}
export function closeSync(fd: number) {
  call<void>("fs.close", { fd });
}
export function fstatSync(fd: number) {
  return new Stats(call("fs.fstat", { fd }));
}
export function createReadStream(
  p: Path,
  options?: {
    start?: number;
    end?: number;
    highWaterMark?: number;
    encoding?: BufferEncoding;
  },
) {
  const stream = new Readable();
  queueMicrotask(() => {
    try {
      const fd = openSync(p);
      try {
        let position = options?.start ?? 0;
        const chunkSize = options?.highWaterMark ?? 65536;
        while (!stream.destroyed) {
          const length = Math.min(
            chunkSize,
            (options?.end ?? Infinity) - position + 1,
          );
          if (length <= 0) break;
          const b = Buffer.alloc(length);
          const n = readSync(fd, b, 0, length, position);
          if (!n) break;
          stream.push(b.subarray(0, n));
          position += n;
        }
        if (!stream.destroyed) stream.push(null);
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      stream.destroy(e as Error);
    }
  });
  return stream;
}
export function createWriteStream(
  p: Path,
  options?: { flags?: string },
): Writable {
  if (options?.flags !== "a") writeFileSync(p, "");
  class FileWriter extends Writable {
    override write(data: string | Uint8Array) {
      appendFileSync(p, data);
      return true;
    }
  }
  return new FileWriter();
}
export function watch(
  p: Path,
  options?:
    | { recursive?: boolean; persistent?: boolean }
    | ((event: string, filename: string) => void),
  listener?: (event: string, filename: string) => void,
) {
  const callback = typeof options === "function" ? options : listener;
  const id = call<number>("fs.watch", {
    path: path(p),
    recursive: typeof options === "object" && options.recursive,
  });
  let closed = false;
  const watcher = Object.assign(new EventEmitter(), {
    close() {
      if (!closed) {
        closed = true;
        clearInterval(timer);
        call("fs.watch.close", { id });
        watcher.emit("close");
      }
    },
    unref() {
      return watcher;
    },
    ref() {
      return watcher;
    },
  });
  if (callback) watcher.on("change", callback);
  const timer = setInterval(() => {
    if (closed) return;
    const events = call<Array<{ event: string; path: string; error?: string }>>(
      "fs.watch.poll",
      { id },
    );
    for (const event of events) {
      if (closed) break;
      if (event.error) {
        watcher.emit("error", new Error(event.error));
        watcher.close();
      } else {
        const root = path(p).replace(/\/$/, "");
        const filename = event.path.startsWith(root + "/")
          ? event.path.slice(root.length + 1)
          : event.path.split("/").at(-1)!;
        watcher.emit("change", event.event, filename);
      }
    }
  }, 50);
  return watcher;
}
export const watchFile = (_p: Path, ..._args: unknown[]) =>
  unsupported("watchFile");
export const unwatchFile = (_p: Path) => {};

type FsCallback<T = void> = (error: Error | null, result?: T) => void;

// The native bridge is synchronous; Node callbacks still run after the caller returns.
function complete<T>(operation: () => T, callback: FsCallback<T>): void {
  queueMicrotask(() => {
    let result: T;
    try { result = operation(); }
    catch (error) { callback(error as Error); return; }
    callback(null, result);
  });
}

export const stat = (p: Path, callback: FsCallback<Stats>) => complete(() => statSync(p), callback);
export const realpath = (p: Path, callback: FsCallback<string>) => complete(() => realpathSync(p), callback);
export const utimes = (p: Path, atime: Date | string | number, mtime: Date | string | number, callback: FsCallback) =>
  complete(() => utimesSync(p, atime, mtime), callback);
export function mkdir(p: Path, options: Parameters<typeof mkdirSync>[1] | FsCallback, callback?: FsCallback): void {
  const done = typeof options === "function" ? options : callback!;
  complete(() => mkdirSync(p, typeof options === "function" ? undefined : options), done);
}
export function rmdir(p: Path, callback: FsCallback): void {
  complete(() => rmdirSync(p), callback);
}

export default {
  constants,
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
  lstatSync,
  utimesSync,
  existsSync,
  accessSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
  rmdirSync,
  renameSync,
  copyFileSync,
  realpathSync,
  chmodSync,
  globSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  createReadStream,
  createWriteStream,
  watch,
  watchFile,
  unwatchFile,
  stat,
  realpath,
  utimes,
  mkdir,
  rmdir,
};

export function mkdtempSync(prefix: string) {
  for (let i = 0; i < 20; i++) {
    const candidate = prefix + call<string>("uuid").slice(0, 6);
    try {
      mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    }
  }
  throw Object.assign(
    new Error("Could not create a unique temporary directory"),
    { code: "EEXIST" },
  );
}
