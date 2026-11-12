# 以 Pi SDK 承载 Agent 运行时

## 目标与职责

主应用使用 Pi 1.5.0 的 `createAgentSession()` 创建执行会话。`AgentSession` 负责模型轮次、消息持久化、上下文投影、压缩、重试、消息队列与扩展生命周期；`DefaultResourceLoader` 按 Pi 约定发现 Skills、规则、提示模板和扩展。MCP、工具发现和 codemode 使用官方扩展工厂接入。

App 持有凭据和设备连接，直接访问目标云服务。`PiAgentExecutor` 保留任务准入与 SQLite 任务快照；`PiTaskRunner` 将 Pi 事件映射为任务进度、观测和执行回执。审批及设备能力通过 Pi 扩展、工具接口接入。会话历史以 Pi JSONL 为唯一来源。

## 接口与取舍

- 采用官方会话工厂与资源加载器，替换裸 `Agent` 组装及手动消息追加。独立复用压缩函数需要自行维护检查时机、恢复与排队，增加与上游重复的状态，因此不采用。
- 模型访问通过官方 `ModelRuntime` 连接 App 的凭据和已注册 Provider。保留测试注入的流接口，用于可重复地验证模型、压缩及工具交互；产品凭据来自 App。
- 文件工具采用 Pi 标准工具及参数。Shell 使用 Pi 工具的宿主接口连接现有手机 Shell，保留 stdout/stderr、退出码、取消和超时回执；App 问答、家居与底座作为标准自定义工具。
- 资源配置复用 Pi 的 `settings.json`、Skills、规则和扩展目录。增加宿主扩展的用途是连接任务审批、语言策略、网络搜索及执行观测；成本是这些产品行为与 Pi 扩展事件之间的一层适配，不另建插件协议。
- 执行中输入使用 Pi 的 steering / follow-up 队列。任务完成以会话稳定结束为准，涵盖自动重试和后续轮次。
- 长期个人事实的提取、纠正、遗忘和检索仍是独立产品能力，不混入会话压缩。

## 实施步骤

- [x] Step 1：核对 Pi SDK、现有调用方、兼容层和测试，确定状态归属。
- [ ] Step 2：迁移官方会话、模型运行时和事件桥接。
  - [ ] 接通 `AgentSession`、Settings 与资源加载，移除手动会话同步。
  - [ ] 将审批、语言、搜索与观测接入 Pi 扩展生命周期。
  - [ ] 保留 App 凭据与 Shell 执行回执的归属。
- [ ] Step 3：接通标准生态入口。
  - [ ] 标准文件工具、Skills、规则与提示模板。
  - [ ] 扩展、MCP、工具发现及 codemode 的官方注册入口。
  - [ ] 压缩、重试和执行中消息队列。
- [ ] Step 4：行为验证、独立 review 与交付。
  - [ ] 验证资源加载、压缩恢复、错误重试、排队、审批、取消、历史恢复和工具回执。
  - [ ] 执行 runtime / NSH 类型检查、相关回归、应用构建与真实 QuickJS 宿主验证。
  - [ ] 仅在可用真机上安装开发包并覆盖横屏；无设备时记录未执行项。
  - [ ] 独立子 agent review，修复发现，更新架构、进度与待办，隔离提交。

## 依据

- [Pi SDK](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/sdk.md)
- [扩展接口](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/extensions.md)
- [MCP 与 codemode 官方示例](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/examples/sdk/14-codemode-mcp.ts)
