import { EventEmitter } from "./events.js";
import { statSync } from "./fs.js";
import { unsupported } from "../bridge.js";
import { killSandboxProcess } from "./child_process.js";
let cwd = "/workspace";
const output = () =>
  Object.assign(new EventEmitter(), {
    isTTY: false,
    columns: 80,
    rows: 24,
    write: (data: unknown) => {
      globalThis.__nsh_print?.(String(data));
      return true;
    },
  });
const process = Object.assign(new EventEmitter(), {
  features: {},
  getBuiltinModule: (_name: string) => undefined,
  env: {} as Record<string, string | undefined>,
  argv: ["nsh", "/app/main.mjs"],
  execPath: "/app/nsh",
  platform: "nsh",
  arch: "arm64",
  pid: 1,
  versions: { nsh: "0.4.0" },
  version: "nsh/0.4.0",
  stdout: output(),
  stderr: output(),
  stdin: Object.assign(new EventEmitter(), { isTTY: false }),
  cwd: () => cwd,
  chdir: (path: string) => {
    if (!path.startsWith("/")) unsupported("relative process.chdir");
    if (!statSync(path).isDirectory()) throw new Error("ENOTDIR");
    cwd = path;
  },
  nextTick: (fn: (...args: any[]) => void, ...args: any[]) =>
    queueMicrotask(() => fn(...args)),
  exit: (_code = 0): never => unsupported("process.exit"),
  kill: killSandboxProcess,
  hrtime: Object.assign(
    (previous?: [number, number]): [number, number] => {
      const now = Date.now();
      const delta = previous
        ? now - previous[0] * 1000 - previous[1] / 1e6
        : now;
      return [Math.floor(delta / 1000), (delta % 1000) * 1e6];
    },
    { bigint: () => BigInt(Date.now()) * 1000000n },
  ),
});
export default process;
export const env = process.env;
export const nextTick = process.nextTick;
export const platform = process.platform;
export const argv = process.argv;
export const stdout = process.stdout;
export const stderr = process.stderr;
