import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";

const app = resolve(import.meta.dirname, "..");
const repo = resolve(app, "../..");
const revision = "e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3";
const config = existsSync(resolve(repo, ".env"))
  ? parseEnv(readFileSync(resolve(repo, ".env"), "utf8"))
  : {};
const valid = (binary: string) => {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8" });
  return (
    result.status === 0 &&
    result.stdout.includes("nsh 0.4.0") &&
    result.stdout.includes(revision.slice(0, 7))
  );
};
let binary = [config.NSH_CLI_PATH, process.env.NSH_CLI_PATH, "nsh"].find(
  (candidate): candidate is string => Boolean(candidate && valid(candidate)),
);
if (!binary) {
  const checkout = resolve(homedir(), ".cache/super-looi/nsh", revision);
  const run = (command: string, args: string[], cwd?: string) => {
    const result = spawnSync(command, args, { cwd, stdio: "inherit" });
    if (result.status !== 0)
      throw new Error(
        `${command} failed while preparing NSH ${revision.slice(0, 7)}`,
      );
  };
  if (!existsSync(resolve(checkout, ".git"))) {
    mkdirSync(dirname(checkout), { recursive: true });
    run("git", [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "https://github.com/longbridge/nsh",
      checkout,
    ]);
    run("git", ["checkout", "--detach", revision], checkout);
  }
  const actual = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: checkout,
    encoding: "utf8",
  });
  if (actual.status !== 0 || actual.stdout.trim() !== revision)
    throw new Error("NSH cache revision mismatch");
  binary = resolve(checkout, "target/debug/nsh");
  if (!valid(binary))
    run("cargo", ["build", "--locked", "-p", "nsh-cli"], checkout);
  if (!valid(binary)) throw new Error("NSH CLI version verification failed");
}
const [command = "check", ...args] = process.argv.slice(2);
const result =
  command === "probe-ios"
    ? spawnSync(
        binary,
        ["test", resolve(app, "CompatProbe.tsx"), "--target", "ios", ...args],
        {
          cwd: app,
          stdio: ["pipe", "inherit", "inherit"],
          input:
            'await app.waitFor("Native bridge verified", {timeout:20000})\n',
        },
      )
    : spawnSync(binary, [command, app, ...args], {
        cwd: app,
        stdio: "inherit",
      });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
