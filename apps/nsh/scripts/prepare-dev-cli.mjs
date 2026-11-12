import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, isAbsolute, basename } from "node:path";
import { homedir } from "node:os";

/** Reuse the pinned toolchain, with its dev watcher restricted to bundle inputs. */
export function prepareDevCli(binary, revision) {
  const patch = resolve(import.meta.dirname, "nsh-patches/dev-inputs.patch");
  const digest = createHash("sha256").update(readFileSync(patch)).digest("hex").slice(0, 12);
  const source = resolve(homedir(), ".cache/super-looi/nsh", revision);
  const overlay = resolve(source, "../dev-cli", `${revision.slice(0, 7)}-${digest}`);
  const patched = resolve(overlay, "nsh");
  if (existsSync(patched)) return patched;
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { stdio: "inherit", ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed while preparing NSH development watcher (${result.status})`);
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
  run("git", ["apply", patch], { cwd: overlay });
  writeFileSync(resolve(overlay, "crates/nsh-cli/.cargo_vcs_info.json"), JSON.stringify({ git: { sha1: revision } }));
  // Keep the configured CLI's existing Cargo artifacts warm.
  const target = process.env.CARGO_TARGET_DIR
    ? resolve(process.env.CARGO_TARGET_DIR)
    : isAbsolute(binary) && basename(dirname(binary)) === "debug"
      ? resolve(dirname(binary), "..")
      : resolve(source, "target");
  console.log("Preparing NSH development watcher (first run after patch changes)");
  run("cargo", ["build", "--locked", "-p", "nsh-cli", "--target-dir", target], { cwd: overlay });
  copyFileSync(resolve(target, "debug/nsh"), patched);
  return patched;
}
