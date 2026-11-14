import type { PluginUiModule } from "../../../ui/plugins/ui-contracts";
import type { CodexPluginCommand, CodexPluginState } from "../contracts";
import { CodexSettingsView } from "./SettingsView";

export const codexUiModule: PluginUiModule<CodexPluginState, CodexPluginCommand> = {
  pluginId: "codex",
  SettingsView: CodexSettingsView,
};
