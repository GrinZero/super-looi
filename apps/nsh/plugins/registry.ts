import type { PluginDefinition } from "../runtime/plugins/contracts.js";
import { codexDefinition, type CodexPluginOptions } from "./codex/runtime/index.js";
import {
  visionPersonTrackerDefinition,
  type VisionPersonTrackerPluginOptions,
} from "./vision-person-tracker/runtime/index.js";
import {
  werewolfJudgeDefinition,
  type WerewolfJudgePluginOptions,
} from "./werewolf-judge/runtime/index.js";

export function createBuiltinPluginDefinitions(options: {
  codex?: CodexPluginOptions;
  visionPersonTracker?: VisionPersonTrackerPluginOptions;
  werewolfJudge?: WerewolfJudgePluginOptions;
} = {}): PluginDefinition<any, any>[] {
  return [
    codexDefinition(options.codex),
    visionPersonTrackerDefinition(options.visionPersonTracker),
    werewolfJudgeDefinition(options.werewolfJudge),
  ];
}
