# 文档索引

## 当前实现与使用

| 主题 | 入口 |
| --- | --- |
| 构建、真机运行与服务连接 | [NSH 应用说明](../apps/nsh/README.md) |
| 模块关系与源码调用路径 | [架构图](arch/index.html) |
| 手机运行时、数据归属与验证记录 | [NSH 运行时](nsh-runtime.md) |
| 界面、主题与交互规范 | [NSH 设计说明](../apps/nsh/DESIGN.md) |
| Pi 会话、工具、Skills、MCP 与压缩 | [Pi 运行时](pi-runtime.md) |
| QuickJS 的 Node API 与 SDK 适配 | [Node 兼容包](../packages/nsh-node-compat/README.md) |
| Linux 执行环境 | [Linux Shell](nsh-linux-shell.md) · [验证记录](nsh-linux-shell-verification.md) |
| 家居能力与卡片布局 | [家居能力说明](home-device-capabilities.md) |
| 蓝牙底座初始化 | [真机对照记录](looi-ble-live-verification.md) |
| 中英界面与对话语言 | [双语说明](nsh-bilingual-integration.md) |
| 表情与外观设计 | [72 种表情](super-looi-72-expressions-design.md) · [工业设计](super-looi-industrial-design.md) |
| 路由与绘制性能 | [导航性能](navigation-performance.md) |

## 调研、计划与未解决问题

| 主题 | 入口 |
| --- | --- |
| 功能缺口与设备验收 | [当前待办](../todo.md) |
| 实施方案 | [计划目录](plans/) |
| Agent 记忆与上下文 | [机制调研](agent-memory-context-research.md) |
| 语音委派与多任务 | [社区架构](voice-agent-community-architecture-research.md) · [只读 Shell 与委派](voice-agent-readonly-shell-and-handoff-research.md) |
| Agents SDK 会话层 | [接入记录](openai-agents-sdk-integration-2026-11-14.md) · [SDK／GPT-Live 边界](gpt-live-and-realtime-sdk-boundaries-2026-11-14.md) |
| 回声与自动休眠 | [AEC 与轮次](voice-duplex-aec-and-turn-taking.md) · [可移植音频处理](realtime-portability-and-aec-research.md) · [自动休眠诊断](voice-auto-sleep-diagnosis-2026-11-14.md) |
| MOSS 播放与建连 | [试听修复](moss-preview-playback-diagnosis.md) · [主页 E2E](moss-home-realtime-e2e-2026-11-14.md) · [TLS 诊断](moss-live-tls-diagnosis.md) |
| 相机预览与取帧 | [原生接入方案](plans/xiaomi-camera-native-integration-plan.md) · [协议验证](xiaomi-camera-community-verification.md) |
| Codex Cloud | [CLI 兼容性](codex-cloud-cli-compatibility-research.md) · [登录诊断](codex-linux-login-diagnosis.md) |
| 开发宿主 | [开发传输限制](nsh-dev-transport-research.md) |
| 狼人杀体验与舞台 | [玩法方案](plans/werewolf-game-plugin-plan.md) · [恢复方案](plans/werewolf-resilience-and-recovery-plan.md) |

## 历史资料

[历史索引](archive/README.md) 收录旧 Hub／Expo 设计、阶段报告、NSH 迁移过程与对应附件；[历史计划](plans/archive/) 保留已完成或被后续方案承接的实施步骤。`artifacts/` 中仍被现行文档展示或验证脚本写入的证据保留在原位置。
