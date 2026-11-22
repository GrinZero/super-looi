import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, copyFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, isAbsolute, basename } from "node:path";
import { homedir } from "node:os";

/** Prepare the pinned toolchain used by the development commands. */
export function prepareDevCli(binary, revision) {
  const patches = ["dev-inputs.patch", "ios-dev-reconnect.patch"].map(
    name => resolve(import.meta.dirname, "nsh-patches", name),
  );
  const hash = createHash("sha256");
  for (const patch of patches) hash.update(readFileSync(patch));
  const digest = hash.digest("hex").slice(0, 12);
  const source = resolve(homedir(), ".cache/super-looi/nsh", revision);
  const overlay = resolve(source, "../dev-cli", `${revision.slice(0, 7)}-${digest}`);
  const toolchain = { binary: resolve(overlay, "nsh"), source: overlay };
  if (existsSync(toolchain.binary)) return toolchain;
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { stdio: "inherit", ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed while preparing the NSH development toolchain (${result.signal ?? result.status})`);
    return result.stdout;
  };
  if (!existsSync(resolve(source, ".git"))) {
    mkdirSync(dirname(source), { recursive: true });
    run("git", ["clone", "--filter=blob:none", "--no-checkout", "https://github.com/longbridge/nsh", source]);
    run("git", ["checkout", "--detach", revision], { cwd: source });
  }
  mkdirSync(overlay, { recursive: true });
  const archive = run("git", ["archive", revision], { cwd: source, stdio: ["ignore", "pipe", "inherit"], maxBuffer: 128 * 1024 * 1024 });
  run("tar", ["-xf", "-", "-C", overlay], { input: archive, stdio: ["pipe", "inherit", "inherit"] });
  run("git", ["apply", ...patches], { cwd: overlay });
  writeFileSync(resolve(overlay, "crates/nsh-cli/.cargo_vcs_info.json"), JSON.stringify({ git: { sha1: revision } }));
  // Keep the configured CLI's existing Cargo artifacts warm.
  const target = process.env.CARGO_TARGET_DIR
    ? resolve(process.env.CARGO_TARGET_DIR)
    : isAbsolute(binary) && basename(dirname(binary)) === "debug"
      ? resolve(dirname(binary), "..")
      : resolve(source, "target");
  console.log("Preparing NSH development toolchain (first run after patch changes)");
  run("cargo", ["build", "--locked", "-p", "nsh-cli", "--target-dir", target], { cwd: overlay });
  const stagedBinary = resolve(overlay, `nsh.${process.pid}.tmp`);
  try {
    copyFileSync(resolve(target, "debug/nsh"), stagedBinary);
    run("cargo", [
      "test", "--locked", "-p", "nsh-dev", "--test", "roundtrip", "--target-dir", target,
    ], { cwd: overlay });
    renameSync(stagedBinary, toolchain.binary);
  } finally {
    rmSync(stagedBinary, { force: true });
  }
  return toolchain;
}
