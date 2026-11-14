import type { PluginManifest } from "../../runtime/plugins/shared-types.js";

export const codexManifest: PluginManifest = {
  id: "codex",
  version: "1.1.0",
  minHostApiVersion: 2,
  category: "productivity",
  icon: "code",
  name: {
    "zh-CN": "Codex",
    "en-US": "Codex",
  },
  summary: {
    "zh-CN": "代码编写、任务委派与云端执行",
    "en-US": "Code authoring, task delegation & cloud execution",
  },
  author: {
    name: "Super LOOI",
    verified: true,
  },
  permissions: ["ai.tools", "ai.intercept", "linux.exec"],
  activation: "on_demand",
};
