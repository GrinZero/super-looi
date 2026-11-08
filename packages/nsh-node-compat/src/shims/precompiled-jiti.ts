import { unsupported } from "../bridge.js";
const modules = new Map<string, unknown>();
export function registerPrecompiledModule(path: string, exports: unknown) {
  modules.set(path, exports);
  return () => modules.delete(path);
}
export function createJiti(_file: string, _options?: unknown) {
  const load = (path: string) => {
    if (!modules.has(path))
      return unsupported(`unregistered precompiled extension ${path}`);
    return modules.get(path);
  };
  return Object.assign(load, {
    async import(path: string, options?: { default?: boolean }) {
      const result = load(path) as any;
      return options?.default ? (result?.default ?? result) : result;
    },
    resolve(path: string) {
      if (!modules.has(path))
        unsupported(`unregistered precompiled extension ${path}`);
      return path;
    },
  });
}
export default createJiti;
