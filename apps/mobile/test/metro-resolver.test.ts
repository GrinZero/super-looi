import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const config = require("../metro.config.js");
// Use the installed Expo resolver without adding a direct Metro dependency.
const expoRequire = createRequire(require.resolve("expo/metro-config"));
const metro = expoRequire("metro-resolver");
const mobileRoot = path.resolve(import.meta.dirname, "..");

function makeContext(originModulePath: string, resolveRequest = metro.resolve) {
  return {
    originModulePath,
    assetExts: new Set(config.resolver.assetExts),
    sourceExts: config.resolver.sourceExts,
    preferNativePlatform: true,
    mainFields: config.resolver.resolverMainFields,
    disableHierarchicalLookup: false,
    nodeModulesPaths: config.resolver.nodeModulesPaths,
    doesFileExist: existsSync,
    fileSystemLookup(filePath: string) {
      try {
        const stat = statSync(filePath);
        return { exists: true, type: stat.isDirectory() ? "d" : "f", realPath: realpathSync(filePath) };
      } catch {
        return { exists: false };
      }
    },
    getPackage(packageJsonPath: string) {
      return JSON.parse(readFileSync(packageJsonPath, "utf8"));
    },
    getPackageForModule() { return null; },
    redirectModulePath: (modulePath: string) => modulePath,
    unstable_enablePackageExports: false,
    resolveRequest,
  };
}

describe("Metro NodeNext relative extension substitution", () => {
  it("resolves the shared home runtime through its React Native source entry on both mobile platforms", () => {
    for (const platform of ["ios", "android"]) {
      for (const useExports of [false, true]) {
        const origin = path.join(mobileRoot, "app/index.tsx");
        const context = {
          ...makeContext(origin),
          unstable_enablePackageExports: useExports,
          unstable_conditionNames: config.resolver.unstable_conditionNames,
          unstable_conditionsByPlatform: config.resolver.unstable_conditionsByPlatform,
        };
        const result = config.resolver.resolveRequest(context, "@super-looi/home-assistant", platform);
        assert.equal(result.type, "sourceFile");
        assert.ok(result.filePath.endsWith("/packages/home-assistant/src/index.ts"), result.filePath);
        const queue = [result.filePath];
        const visited = new Set<string>();
        while (queue.length) {
          const filename = queue.pop()!;
          if (visited.has(filename)) continue;
          visited.add(filename);
          const source = readFileSync(filename, "utf8");
          for (const [, specifier] of source.matchAll(/from\s+["'](\.{1,2}\/[^"']+\.js)["']/g)) {
            const resolved = config.resolver.resolveRequest(makeContext(filename), specifier, platform);
            assert.equal(resolved.type, "sourceFile");
            assert.ok(resolved.filePath.endsWith(".ts"));
            queue.push(resolved.filePath);
          }
        }
        assert.ok(visited.size >= 8, "the entry and transitive runtime modules must resolve from source");
      }
    }
  });

  it("resolves the three components' actual relative .js source dependencies", () => {
    for (const component of ["LooiIcon", "RobotFaceView", "QuickDrawerModal"]) {
      const origin = path.join(mobileRoot, "src/ui/components", `${component}.tsx`);
      const source = readFileSync(origin, "utf8");
      const imports = [...source.matchAll(/from\s+["'](\.{1,2}\/[^"']+\.js)["']/g)];
      assert.ok(imports.length > 0, `${component} must exercise real relative imports`);
      for (const [, specifier] of imports) {
        const context = makeContext(origin);
        // Verify the original regression using real Metro, then the fix.
        assert.throws(() => metro.resolve(context, specifier, "ios"), metro.FailedToResolvePathError);
        const result = config.resolver.resolveRequest(context, specifier, "ios");
        assert.equal(result.type, "sourceFile");
        assert.match(result.filePath, /\.tsx?$/);
        assert.equal(result.filePath.replace(/\.tsx?$/, ""), path.resolve(path.dirname(origin), specifier.slice(0, -3)));
      }
    }
  });

  it("keeps existing .js files first and lets Metro select platform-specific fallbacks", () => {
    const fixtureRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "looi-metro-")));
    try {
      for (const filename of ["existing.js", "existing.ts", "existing.ios.ts", "platform.ios.ts", "platform.ts", "native.ios.js"]) {
        writeFileSync(path.join(fixtureRoot, filename), "export default true;\n");
      }
      const context = makeContext(path.join(fixtureRoot, "entry.ts"));
      assert.equal(config.resolver.resolveRequest(context, "./existing.js", "ios").filePath,
        path.join(fixtureRoot, "existing.js"));
      assert.equal(config.resolver.resolveRequest(context, "./platform.js", "ios").filePath,
        path.join(fixtureRoot, "platform.ios.ts"));
      assert.equal(config.resolver.resolveRequest(context, "./native.js", "ios").filePath,
        path.join(fixtureRoot, "native.ios.js"));
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("leaves external package resolution intact and never retries non-relative or non-.js requests", () => {
    const origin = path.join(mobileRoot, "src/ui/components/LooiIcon.tsx");
    const calls: string[] = [];
    const context = makeContext(origin, (ctx: object, specifier: string, platform: string) => {
      calls.push(specifier);
      return metro.resolve({ ...ctx, resolveRequest: metro.resolve }, specifier, platform);
    });
    assert.deepEqual(config.resolver.resolveRequest(context, "react", "ios"),
      metro.resolve(makeContext(origin), "react", "ios"));
    assert.deepEqual(calls, ["react"]);
    for (const specifier of ["missing-looi-package/icon.js", "/missing-looi-file.js", "./missing.mjs", "./missing.cjs"]) {
      calls.length = 0;
      assert.throws(() => config.resolver.resolveRequest(context, specifier, "ios"));
      assert.deepEqual(calls, [specifier]);
    }
  });

  it("propagates unrelated resolver errors unchanged without attempting a fallback", () => {
    const origin = path.join(mobileRoot, "src/ui/components/LooiIcon.tsx");
    const error = new Error("Invalid package configuration");
    const calls: string[] = [];
    const context = makeContext(origin, (_ctx: unknown, specifier: string) => {
      calls.push(specifier);
      throw error;
    });
    assert.throws(() => config.resolver.resolveRequest(context, "../theme.js", "ios"),
      (received: unknown) => received === error);
    assert.deepEqual(calls, ["../theme.js"]);
  });
});
