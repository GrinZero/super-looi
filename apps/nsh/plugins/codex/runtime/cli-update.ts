import fs from "node:fs";
import { Buffer } from "node:buffer";
import { PluginKernelError } from "../../../runtime/plugins/errors.js";

const registry = "https://registry.npmjs.org/@openai%2fcodex";
const stableVersion = /^(\d+)\.(\d+)\.(\d+)$/;

export const installedBin = "/root/.looi-codex/current";
export const bundledBin = "/usr/local/bin";

export function versionIsNewer(candidate: string, installed: string): boolean {
  const left = stableVersion.exec(candidate);
  const right = stableVersion.exec(installed);
  if (!left || !right) return false;
  for (let part = 1; part <= 3; part++) {
    const difference = Number(left[part]) - Number(right[part]);
    if (difference) return difference > 0;
  }
  return false;
}

async function npmManifest(tag: string, signal?: AbortSignal) {
  const stage = "codex.update.registry";
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(`${registry}/${tag}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) {
    throw new PluginKernelError({ stage, code: response.status, reason: await response.text() || response.statusText });
  }
  return response.json();
}

export async function latestCliVersion(): Promise<string> {
  const { version } = await npmManifest("latest");
  if (typeof version !== "string" || !stableVersion.test(version)) {
    throw new PluginKernelError({ stage: "codex.update.registry", code: "ERR_CODEX_VERSION", reason: "npm latest did not return a stable Codex version" });
  }
  return version;
}

export async function cliArchive(version: string, signal?: AbortSignal): Promise<{ url: string; sha512: string }> {
  const { dist } = await npmManifest(`${version}-linux-arm64`, signal);
  const url = `https://registry.npmjs.org/@openai/codex/-/codex-${version}-linux-arm64.tgz`;
  const integrity = typeof dist?.integrity === "string" && /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(dist.integrity);
  if (dist?.tarball !== url || !integrity) {
    throw new PluginKernelError({ stage: "codex.update.registry", code: "ERR_CODEX_ARCHIVE", reason: "npm metadata did not identify the official Linux ARM64 archive and SHA-512 digest" });
  }
  return { url, sha512: Buffer.from(integrity[1]!, "base64").toString("hex") };
}

export async function downloadCliArchive(url: string, destination: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok) {
    throw new PluginKernelError({ stage: "codex.update.download", code: response.status, reason: await response.text() || response.statusText });
  }
  if (!response.body) {
    throw new PluginKernelError({ stage: "codex.update.download", code: "ERR_CODEX_ARCHIVE_BODY", reason: "npm returned an empty archive response" });
  }
  const reader = response.body.getReader();
  try {
    fs.writeFileSync(destination, "");
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      fs.appendFileSync(destination, chunk.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Alpine's BusyBox extracts the archive staged through the App's workspace mount.
// Both executables switch together only after the staged CLI runs in the guest.
export const installCliScript = String.raw`
set -eu
stage=prepare
trap 'status=$?; if [ "$status" -ne 0 ]; then printf "[stage=codex.update.%s code=%s] Command failed\n" "$stage" "$status" >&2; fi' EXIT
base=/root/.looi-codex
mkdir -p "$base"
current=$base/current
old=$(readlink "$current" || :)
for directory in "$base"/install.*; do
  if [ -d "$directory" ] && [ "$directory/bin" != "$old" ]; then rm -rf "$directory"; fi
done
staging=$(mktemp -d "$base/install.XXXXXX")
cleanup() {
  status=$?
  if [ "$(readlink "$current")" != "$staging/bin" ]; then rm -rf "$staging"; fi
  if [ "$status" -ne 0 ]; then printf '[stage=codex.update.%s code=%s] Command failed\n' "$stage" "$status" >&2; fi
}
trap cleanup EXIT
trap 'exit 143' TERM
stage=digest
printf '%s  %s\n' "$2" "$1" | sha512sum -c
stage=extract
vendor=package/vendor/aarch64-unknown-linux-musl/bin
mkdir "$staging/bin"
tar -xzf "$1" -C "$staging/bin" --strip-components=4 "$vendor/codex" "$vendor/codex-code-mode-host"
chmod 755 "$staging/bin/codex" "$staging/bin/codex-code-mode-host"
stage=version
actual=$("$staging/bin/codex" --version)
if [ "$actual" != "codex-cli $3" ]; then
  printf 'Expected codex-cli %s, received %s\n' "$3" "$actual" >&2
  exit 1
fi
stage=activate
ln -s "$staging/bin" "$staging/next"
mv -Tf "$staging/next" "$current"
case "$old" in "$base"/install.*/bin) rm -rf "${"$"}{old%/bin}" ;; esac
printf '%s\n' "$actual"
`;
