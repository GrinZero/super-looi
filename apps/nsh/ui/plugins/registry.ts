import { signal } from "nsh";
import { codexUiModule } from "../../plugins/codex/ui";
import { visionPersonTrackerUiModule } from "../../plugins/vision-person-tracker/ui";
import { werewolfJudgeUiModule } from "../../plugins/werewolf-judge/ui";
import type { PluginUiModule } from "./ui-contracts";

const uiModules = signal<Record<string, PluginUiModule>>({
  [codexUiModule.pluginId]: codexUiModule,
  [visionPersonTrackerUiModule.pluginId]: visionPersonTrackerUiModule,
  [werewolfJudgeUiModule.pluginId]: werewolfJudgeUiModule,
});

export function registerPluginUiModule(module: PluginUiModule): void {
  uiModules.update((current) => ({
    ...current,
    [module.pluginId]: module,
  }));
}

export function unregisterPluginUiModule(pluginId: string): void {
  uiModules.update((current) => {
    const next = { ...current };
    delete next[pluginId];
    return next;
  });
}

export function getPluginUiModule(pluginId: string): PluginUiModule | undefined {
  return uiModules()[pluginId];
}
