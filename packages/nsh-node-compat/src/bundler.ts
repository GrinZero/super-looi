import { fileURLToPath } from "node:url";
import type { Plugin } from "esbuild";
const shimNames: Record<string, string> = {
  http: "http",
  url: "url",
  crypto: "crypto",
  buffer: "buffer",
  "timers/promises": "timers-promises",
  perf_hooks: "perf_hooks",
  util: "util",
  assert: "assert",
  "assert/strict": "assert",
  tty: "tty",
  "stream/web": "stream-web",
  module: "module",
  zlib: "zlib",
  path: "path",
  fs: "fs",
  "fs/promises": "fs-promises",
  sqlite: "sqlite",
  child_process: "child_process",
  os: "os",
  process: "process",
  events: "events",
  stream: "stream",
  "stream/promises": "stream-promises",
  string_decoder: "string_decoder",
  readline: "readline",
  "readline/promises": "readline",
};
const native = new Set(["buffer", "crypto", "url"]);
const builtins = new Set([
  "assert",
  "assert/strict",
  "async_hooks",
  "cluster",
  "console",
  "constants",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "perf_hooks",
  "punycode",
  "querystring",
  "repl",
  "stream/promises",
  "stream/web",
  "timers",
  "timers/promises",
  "tls",
  "tty",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
]);
export function getNshNodeCompatAliases(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(shimNames).flatMap(([name, file]) => {
      const path = fileURLToPath(
        new URL(
          `./shims/${file}.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
          import.meta.url,
        ),
      );
      return [
        [name, path],
        [`node:${name}`, path],
      ];
    }),
  );
}
/** Unknown Node modules fail the build. No blanket empty stubs and no desktop
 * native SDK/TUI substitution: unsupported reachable imports stay reviewable. */
export function nshNodeCompatPlugin(): Plugin {
  return {
    name: "nsh-node-compat",
    setup(build) {
      const aliases = getNshNodeCompatAliases();
      build.onResolve({ filter: /^__nsh_native\// }, (args) => ({
        path: args.path.slice("__nsh_native/".length),
        external: true,
      }));
      build.onResolve({ filter: /^(node:)?[a-z_]+(?:\/[a-z_]+)?$/ }, (args) => {
        const name = args.path.replace(/^node:/, "");
        if (aliases[args.path]) return { path: aliases[args.path] };
        if (native.has(name)) return { path: name, external: true };
        if (args.path.startsWith("node:") || builtins.has(name))
          return {
            errors: [
              {
                text: `NSH sandbox has no implementation for ${args.path} (imported by ${args.importer})`,
              },
            ],
          };
        return undefined;
      });
    },
  };
}
