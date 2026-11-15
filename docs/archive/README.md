# 历史资料

本目录保留各次交付时的设计、实现与验证记录，文中的版本、待办和完成范围对应当时的代码。当前使用与架构入口见 [文档索引](../README.md)。旧 Hub／Expo 源码保存在 `archive/legacy-hub-and-expo` 分支。

## Hub／Expo 设计与阶段交付

- [设计 v2](design-v2/)：PRD、技术架构、UI 规范、验收场景与契约参考。
- [Phase 1：视觉与语音](phase1-vision-and-voice-benchmark.md)
- [Phase 2：记忆与共形 UI](phase2-memory-ledger-and-conformal-ui.md)
- [Phase 3：远程生产力](phase3-remote-productivity-dsh.md)
- [Phase 4：家居与维修舱](phase4-smart-home-and-cabin.md)
- [Phase 5：验收与长稳](phase5-acceptance-and-longevity-report.md)
- Phase 6：[基础组件](phase6-layer1-components.md)、[共形空间](phase6-conformal-spaces.md)、[Hub 控制台](phase6-hub-console.md)
- Phase 7：[移动基础](phase7-mobile-foundation-report.md)、[UI v3](phase7-ui-v3-report.md)、[横屏精修](mobile-presence-landscape-polish.md)
- [Phase 8：交互审阅](phase8-rsi-interaction-report.md)
- Phase 9：[Bento 交付](phase9-zero-scroll-bento-report.md)、[独立审查](phase9-independent-review.md)
- [Phase 11：实时语音与个人 Agent](phase-11-live-voice-and-personal-agent.md)

## 引擎与家居迁移

- DSH：[复用调研](dsh-engine-reuse-research.md)、[接入记录](dsh-engine-integration.md)。现行任务内核见 [Pi 运行时](../pi-runtime.md)。
- 家居：[H1](home-assistant-runtime-h1.md)、[H2](home-assistant-runtime-h2.md)、[H3/H4](local-control-center-delivery.md)、[开发机 HA 联调](home-assistant-xiaomi-setup.md)、[旧 Mobile 凭据诊断](live-voice-missing-local-key-diagnosis.md)。现行连接见 [应用说明](../../apps/nsh/README.md#家居连接)。
- NSH：[兼容层实施](nsh-node-compat-implementation.md)、[业务提取](nsh-portable-runtime.md)、[应用基础](nsh-mobile-foundation.md)、[原生验证](nsh-native-live-verification.md)、[领域迁移](nsh-domain-migration.md)。现行边界与验证入口见 [NSH 运行时](../nsh-runtime.md)。

## 历史计划与附件

- [历史计划目录](../plans/archive/)：双语、Pi 生态、SessionManager、家居修复与语音页重设计。
- [历史附件](artifacts/)：Phase 6／7／9／11、旧本机控制中心、DSH 探针与集成截图。
