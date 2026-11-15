import {
  HOST_PLUGIN_API_VERSION,
  type PluginManifest,
} from "../../runtime/plugins/shared-types.js";
import { WEREWOLF_PLUGIN_ID } from "./contracts.js";

export const werewolfJudgeManifest: PluginManifest = {
  id: WEREWOLF_PLUGIN_ID,
  version: "1.0.0",
  minHostApiVersion: HOST_PLUGIN_API_VERSION,
  category: "games_social",
  icon: "gamepad",
  name: {
    "zh-CN": "狼人杀 AI 法官",
    "en-US": "Werewolf AI Judge",
  },
  summary: {
    "zh-CN": "支持 6–12 人线下聚会面杀：具身环视认座发牌、黑夜声学与时序防作弊主持、本机防窥与扫码副屏双模及终局毒舌复盘。",
    "en-US": "Embodied 6–12 player offline Werewolf referee with face-aligned dealing, side-channel-safe night hosting, dual on-device/LAN QR UI, and AI MVP commentary.",
  },
  author: {
    name: "Super LOOI",
    verified: true,
  },
  permissions: [
    "face.control",
    "face.register",
    "body.motion",
    "ai.tools",
    "ai.context",
    "ai.intercept",
    "ai.proactive",
    "stage.ui",
    "network.lan_room",
  ],
  activation: "startup",
  dependencies: [
    {
      service: "vision.person-tracker",
      versionRange: "^1.0.0",
      optional: true,
    },
  ],
};
