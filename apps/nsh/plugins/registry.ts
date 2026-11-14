import type { PluginDefinition } from "../runtime/plugins/contracts.js";
import { codexDefinition, type CodexPluginOptions } from "./codex/runtime/index.js";

export function createBuiltinPluginDefinitions(options: {
  codex?: CodexPluginOptions;
} = {}): PluginDefinition<any, any>[] {
  return [codexDefinition(options.codex)];
}
