import { unsupported } from "../bridge.js";
export function createRequire(_url: string) {
  return Object.assign(
    (_name: string): never =>
      unsupported("runtime require; prebundle dependencies"),
    {
      resolve: (_name: string): never =>
        unsupported("runtime require.resolve; prebundle dependencies"),
      cache: {},
    },
  );
}
export default { createRequire };
