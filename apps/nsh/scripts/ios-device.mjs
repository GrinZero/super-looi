import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

/** NSH 0.4's dev host only supports simulators. Device runs use its iOS package. */
export async function runIosDevice({ binary, app, entry, device, env, config, probe }) {
  const identity = config.IOS_SIGN_IDENTITY ?? process.env.IOS_SIGN_IDENTITY;
  const profile = config.IOS_PROVISIONING_PROFILE ?? process.env.IOS_PROVISIONING_PROFILE;
  if (!identity || !profile) throw new Error("Set IOS_SIGN_IDENTITY and IOS_PROVISIONING_PROFILE in .env for iPhone device builds");
  const invoke = (command, args) => {
    const result = spawnSync(command, args, { cwd: app, env, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`iPhone device command failed: ${command}`);
  };
  const out = resolve(app, ".nsh/ios-device");
  invoke(binary, ["package", entry ?? app, "--target", "ios", "--out", out,
    "--sign", identity, "--profile", resolve(profile)]);
  invoke("xcrun", ["devicectl", "device", "install", "app", "--device", device, resolve(out, "Super LOOI.app")]);
  const args = ["devicectl", "device", "process", "launch", "--device", device, "--terminate-existing", "--console", "com.superlooi.app"];
  if (!probe) { invoke("xcrun", args); return; }
  await new Promise((resolve, reject) => {
    const child = spawn("xcrun", args, { cwd: app, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", verified = false, failed = false;
    const timer = setTimeout(() => { failed = true; child.kill("SIGTERM"); }, probe.timeout);
    const read = bytes => {
      process.stdout.write(bytes);
      output = (output + bytes.toString()).slice(-65536);
      if (!verified && output.includes(probe.success)) {
        verified = true;
        // --console forwards SIGTERM to the app, ending the probe after receipt.
        child.kill("SIGTERM");
      }
      if (output.includes("Native bridge failed:") || output.includes("Linux Shell failed:")) {
        failed = true; child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", read); child.stderr.on("data", read);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => {
      clearTimeout(timer);
      if (verified && !failed) resolve();
      else reject(new Error("iPhone probe did not produce its completion receipt"));
    });
  });
}
