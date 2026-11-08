import type { Plugin } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
/** Select the programmatic SDK surface rather than the package's CLI/TUI
 * barrel. Every selected export still comes from the real upstream SDK. */
export function nshPiSdkPlugin(): Plugin {
  const root = dirname(
    fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
  );
  const exports = [
    [
      "createAgentSession,createAgentSessionFromServices,createAgentSessionRuntime,createAgentSessionServices",
      "core/sdk.js",
    ],
    ["AgentSession", "core/agent-session.js"],
    ["SessionManager", "core/session-manager.js"],
    ["SettingsManager", "core/settings-manager.js"],
    ["ModelRuntime", "core/model-runtime.js"],
    ["DefaultResourceLoader", "core/resource-loader.js"],
    ["loadSkills,loadSkillsFromDir,formatSkillsForPrompt", "core/skills.js"],
  ];
  return {
    name: "nsh-pi-sdk-1.5.0",
    setup(build) {
      const shim = (name: string) =>
        fileURLToPath(
          new URL(
            `./shims/${name}.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
            import.meta.url,
          ),
        );
      build.onResolve(
        { filter: /core\/http-dispatcher\.js$|^\.\/http-dispatcher\.js$/ },
        (args) =>
          args.importer.startsWith(root)
            ? { path: shim("pi-http-settings") }
            : undefined,
      );
      build.onResolve({ filter: /^@earendil-works\/pi-codemode$/ }, () => ({
        path: shim("pi-codemode-native"),
      }));
      build.onResolve({ filter: /image-resize\.js$|photon\.js$/ }, (args) =>
        args.importer.startsWith(root)
          ? { path: shim("pi-images") }
          : undefined,
      );
      build.onResolve({ filter: /^\.\/callback\.js$/ }, (args) =>
        args.importer.includes("/pi-mcp/dist/oauth/")
          ? { path: shim("mobile-oauth") }
          : undefined,
      );
      build.onResolve({ filter: /^jiti(?:\/static)?$/ }, () => ({
        path: shim("precompiled-jiti"),
      }));
      build.onResolve({ filter: /^graceful-fs$/ }, () => ({
        path: shim("fs"),
      }));
      build.onResolve({ filter: /index\.js$/ }, (args) =>
        args.importer.startsWith(root) &&
        resolve(dirname(args.importer), args.path) === join(root, "index.js")
          ? { path: "pi-sdk", namespace: "nsh-pi-sdk" }
          : undefined,
      );
      build.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({
        path: "pi-sdk",
        namespace: "nsh-pi-sdk",
      }));
      build.onLoad({ filter: /.*/, namespace: "nsh-pi-sdk" }, () => ({
        contents: exports
          .map(
            ([names, path]) =>
              `export {${names}} from ${JSON.stringify(join(root, path))};`,
          )
          .join("\n"),
        loader: "js",
        resolveDir: root,
      }));
    },
  };
}
