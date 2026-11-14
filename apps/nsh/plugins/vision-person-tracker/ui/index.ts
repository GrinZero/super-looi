import type { PluginUiModule } from "../../../ui/plugins/ui-contracts";
import type {
  VisionPersonTrackerCommand,
  VisionPersonTrackerState,
} from "../contracts";
import { VisionPersonTrackerSettingsView } from "./SettingsView";

export { VisionPersonTrackerSettingsView };

export const visionPersonTrackerUiModule: PluginUiModule<
  VisionPersonTrackerState,
  VisionPersonTrackerCommand
> = {
  pluginId: "vision-person-tracker",
  SettingsView: VisionPersonTrackerSettingsView,
};
