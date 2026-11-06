import * as fs from "./fs.js";
import { call, unsupported } from "../bridge.js";
export const readFile = async (...args: Parameters<typeof fs.readFileSync>) =>
  fs.readFileSync(...args);
export const writeFile = async (...args: Parameters<typeof fs.writeFileSync>) =>
  fs.writeFileSync(...args);
export const appendFile = async (
  ...args: Parameters<typeof fs.appendFileSync>
) => fs.appendFileSync(...args);
export const stat = async (...args: Parameters<typeof fs.statSync>) =>
  fs.statSync(...args);
export const lstat = async (...args: Parameters<typeof fs.lstatSync>) =>
  fs.lstatSync(...args);
export const access = async (...args: Parameters<typeof fs.accessSync>) =>
  fs.accessSync(...args);
export const mkdir = async (...args: Parameters<typeof fs.mkdirSync>) =>
  fs.mkdirSync(...args);
export const readdir = async (...args: Parameters<typeof fs.readdirSync>) =>
  fs.readdirSync(...args);
export const rm = async (...args: Parameters<typeof fs.rmSync>) =>
  fs.rmSync(...args);
export const unlink = async (...args: Parameters<typeof fs.unlinkSync>) =>
  fs.unlinkSync(...args);
export const rmdir = async (...args: Parameters<typeof fs.rmdirSync>) =>
  fs.rmdirSync(...args);
export const rename = async (...args: Parameters<typeof fs.renameSync>) =>
  fs.renameSync(...args);
export const copyFile = async (...args: Parameters<typeof fs.copyFileSync>) =>
  fs.copyFileSync(...args);
export const realpath = async (...args: Parameters<typeof fs.realpathSync>) =>
  fs.realpathSync(...args);
export const chmod = async (...args: Parameters<typeof fs.chmodSync>) =>
  fs.chmodSync(...args);
export const watch = fs.watch;
export async function open(path: string, flags = "r") {
  const fd = fs.openSync(path, flags);
  return {
    fd,
    async read(
      buffer: Uint8Array,
      offset = 0,
      length = buffer.byteLength,
      position: number | null = null,
    ) {
      return {
        bytesRead: fs.readSync(fd, buffer, offset, length, position),
        buffer,
      };
    },
    async write(data: string | Uint8Array) {
      if (flags !== "a") unsupported("non-append file-handle write");
      fs.appendFileSync(path, data);
      return {
        bytesWritten:
          typeof data === "string" ? Buffer.byteLength(data) : data.length,
        buffer: data,
      };
    },
    async readFile(options?: Parameters<typeof fs.readFileSync>[1]) {
      return fs.readFileSync(path, options);
    },
    async stat() {
      return fs.fstatSync(fd);
    },
    async close() {
      fs.closeSync(fd);
    },
  };
}
export default {
  readFile,
  writeFile,
  appendFile,
  stat,
  lstat,
  access,
  mkdir,
  readdir,
  rm,
  unlink,
  rmdir,
  rename,
  copyFile,
  realpath,
  chmod,
  watch,
  open,
};

export async function mkdtemp(prefix: string) {
  const path = prefix + call<string>("uuid");
  fs.mkdirSync(path);
  return path;
}
export async function opendir(path: string) {
  const entries = fs.readdirSync(path, { withFileTypes: true });
  let i = 0;
  return {
    async read() {
      return entries[i++] ?? null;
    },
    async close() {},
    async *[Symbol.asyncIterator]() {
      yield* entries;
    },
  };
}
export const statfs = async (_path: string) => unsupported("statfs");
