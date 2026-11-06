import type { Plugin } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/** Opt-in, pinned 1.5.0 headless source entries. This is intentionally separate
 * from transparent Node aliases: it does not make createAgentSession portable.
 * Only TUI renderers, image processing and binary downloads are excluded. */
export function nshPiCodingToolsPlugin(): Plugin {
  const entry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  const packageRoot = dirname(entry);
  const stub = fileURLToPath(
    new URL(
      `./shims/headless-coding.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
      import.meta.url,
    ),
  );
  const allowed = new Set([
    "session-manager",
    "tools/read",
    "tools/write",
    "tools/edit",
    "tools/ls",
    "tools/find",
    "tools/grep",
    "tools/bash",
  ]);
  return {
    name: "nsh-pi-coding-tools-1.5.0",
    setup(build) {
      build.onResolve({ filter: /^pi-coding-headless\// }, (args) => {
        const path = args.path.slice("pi-coding-headless/".length);
        if (!allowed.has(path))
          return {
            errors: [{ text: `Unsupported headless Pi entry: ${path}` }],
          };
        return { path: join(packageRoot, "core", `${path}.js`) };
      });
      build.onResolve(
        {
          filter:
            /(?:renderers\/[^/]+|utils\/(?:image-process|tools-manager))\.js$/,
        },
        (args) => {
          if (!args.importer.startsWith(packageRoot)) return undefined;
          return { path: stub };
        },
      );
      build.onResolve({ filter: /^cross-spawn$/ }, () => ({
        path: fileURLToPath(
          new URL(
            `./shims/child_process.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
            import.meta.url,
          ),
        ),
      }));
    },
  };
}
