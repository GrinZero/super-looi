const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// NodeNext source imports name their emitted .js files. Metro does not perform
// TypeScript's extension substitution, so retry only a missing relative .js
// path. Resolve the original request first to preserve actual .js files,
// platform resolution, package exports, and any existing Expo resolver.
const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolveRequest = upstreamResolveRequest ?? context.resolveRequest;
  try {
    return resolveRequest(context, moduleName, platform);
  } catch (error) {
    // Metro can install multiple resolver versions in a workspace. Match the
    // specific error constructor rather than using instanceof across copies.
    const isFailedToResolve =
      error?.constructor?.name === "FailedToResolvePathError" ||
      error?.constructor?.name === "UnableToResolveError" ||
      error?.name === "FailedToResolvePathError" ||
      error?.name === "UnableToResolveError";
    if (
      /^\.\.?\//.test(moduleName) &&
      moduleName.endsWith(".js") &&
      isFailedToResolve
    ) {
      return resolveRequest(context, moduleName.slice(0, -3), platform);
    }
    throw error;
  }
};

module.exports = config;
