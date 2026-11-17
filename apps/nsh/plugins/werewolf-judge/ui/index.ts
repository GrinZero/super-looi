import type { PluginUiModule } from "../../../ui/plugins/ui-contracts";
import {
  WEREWOLF_PLUGIN_ID,
  type WerewolfCommand,
  type WerewolfPublicState,
} from "../contracts";
import { encodeQrMatrix, QrCodeCanvas } from "./QrCodeCanvas";
import { WerewolfSettingsView } from "./SettingsView";
import { readWerewolfState, WerewolfStageCapsule } from "./StageCapsule";
import { WerewolfStageCanvas, WerewolfStageCompanion } from "./StageCanvas";
import { WerewolfStageDrawer } from "./StageDrawer";

export {
  encodeQrMatrix,
  QrCodeCanvas,
  readWerewolfState,
  WerewolfSettingsView,
  WerewolfStageCanvas,
  WerewolfStageCapsule,
  WerewolfStageCompanion,
  WerewolfStageDrawer,
};

export const werewolfJudgeUiModule: PluginUiModule<
  WerewolfPublicState,
  WerewolfCommand
> = {
  pluginId: WEREWOLF_PLUGIN_ID,
  SettingsView: WerewolfSettingsView,
  StageCapsule: WerewolfStageCapsule,
  StageCompanion: WerewolfStageCompanion,
  StageDrawer: WerewolfStageDrawer,
  StageCanvas: WerewolfStageCanvas,
};
