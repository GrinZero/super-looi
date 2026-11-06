import { call, unsupported } from "../bridge.js";
import { EventEmitter } from "./events.js";
import { Readable, Writable } from "./stream.js";
interface Options {
  cwd?: string;
  encoding?: string;
  timeout?: number;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  shell?: boolean | string;
  maxBuffer?: number;
  stdio?: unknown;
  detached?: boolean;
}
export interface ShellResult {
  status: number;
  stdout: string;
  stderr: string;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function command(file: string, args: string[], options: Options) {
  if (
    file === "bash" ||
    file === "sh" ||
    file === "/bin/bash" ||
    file === "/bin/sh"
  ) {
    const index = args.findIndex((arg) => arg === "-c" || arg === "-lc");
    if (index < 0 || !args[index + 1])
      unsupported("shell invocation without -c");
    return args[index + 1];
  }
  if (options.shell) return [file, ...args].join(" ");
  return [file, ...args].map(quote).join(" ");
}
export function runShell(command: string, options: Options = {}): ShellResult {
  options.signal?.throwIfAborted();
  return call<ShellResult>("shell", {
    command,
    cwd: options.cwd ?? "/workspace",
    timeout: options.timeout,
    env: options.env,
  });
}
export function spawnSync(
  file: string,
  args: string[] = [],
  options: Options = {},
) {
  const result = runShell(command(file, args, options), options);
  return {
    ...result,
    signal: null,
    pid: 0,
    output: [null, result.stdout, result.stderr],
  };
}
declare global {
  var __nsh_shell_wait: ((request: string) => Promise<string>) | undefined;
}
export function spawn(
  file: string,
  args: string[] = [],
  options: Options = {},
) {
  const script = command(file, args, options);
  if (!globalThis.__nsh_shell_wait) unsupported("asynchronous shell host");
  const id = call<string>("shell.create");
  let settled = false;
  const child = Object.assign(new EventEmitter(), {
    stdout: new Readable(),
    stderr: new Readable(),
    stdin: new Writable(),
    pid: 0,
    exitCode: null as number | null,
    killed: false,
    kill(_signal?: string | number) {
      if (settled) return false;
      child.killed = true;
      call("shell.cancel", { id });
      return true;
    },
  });
  const abort = () => child.kill();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) child.kill();
  queueMicrotask(async () => {
    try {
      if (!globalThis.__nsh_shell_wait) unsupported("asynchronous shell host");
      const response = JSON.parse(
        await globalThis.__nsh_shell_wait(
          JSON.stringify({
            id,
            command: script,
            cwd: options.cwd ?? "/workspace",
            timeout: options.timeout,
            env: options.env,
          }),
        ),
      ) as { value?: ShellResult; error?: string };
      if (response.error && !response.error.startsWith("ABORT_ERR"))
        throw new Error(response.error);
      const result = response.value;
      if (result?.stdout) child.stdout.push(result.stdout);
      if (result?.stderr) child.stderr.push(result.stderr);
      child.stdout.push(null);
      child.stderr.push(null);
      const cancelled = child.killed || response.error?.startsWith("ABORT_ERR");
      child.exitCode = cancelled ? null : result!.status;
      settled = true;
      child.emit("exit", child.exitCode, cancelled ? "SIGTERM" : null);
      child.emit("close", child.exitCode, cancelled ? "SIGTERM" : null);
    } catch (error) {
      settled = true;
      child.emit("error", error);
      child.emit("close", -1, null);
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  });
  return child;
}
export function execFileSync(
  file: string,
  args: string[] = [],
  options: Options = {},
) {
  const result = spawnSync(file, args, options);
  if (result.status !== 0)
    throw Object.assign(new Error(result.stderr), result);
  return options.encoding ? result.stdout : Buffer.from(result.stdout);
}
export function execSync(cmd: string, options: Options = {}) {
  return execFileSync("sh", ["-c", cmd], options);
}
export function execFile(
  file: string,
  args: string[] = [],
  options: Options = {},
  callback?: (error: Error | null, stdout: string, stderr: string) => void,
) {
  const child = spawn(file, args, options);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
  child.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
  child.on("close", (status: number) =>
    callback?.(status ? new Error(stderr) : null, stdout, stderr),
  );
  return child;
}
export function exec(
  cmd: string,
  options: Options = {},
  callback?: (error: Error | null, stdout: string, stderr: string) => void,
) {
  return execFile("sh", ["-c", cmd], options, callback);
}
export default { spawn, spawnSync, execFile, execFileSync, exec, execSync };
