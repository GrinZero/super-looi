# OpenAI Agents SDK 接入

## 目标与边界

使用 `@openai/agents-realtime@0.22.0` 的 `RealtimeSession`、`RealtimeAgent` 和工具执行，替换 App 自有工具分派、调用去重与本连接对话历史。App 保持直接连接三家语音云服务；原生播放账本、唤醒待机、试听和 Pi 任务生命周期继续由现有模块承载。

用户确认的 API 路径为 **Agents SDK＋自定义 transport＋OpenAI Realtime API（`/v1/realtime`）**，不迁移 GPT-Live。前台语音 provider 与 Pi 后端独立替换；WebRTC／WebSocket 按各 provider 的实际支持评估，该传输选择与是否采用 GPT-Live 分开决定。

## 接口选择

采用一个实现 SDK `RealtimeTransportLayer` 的原生连接适配器，复用现有三家协议编解码。它负责连接、发送顺序、原始事件到 SDK 事件的转换和供应商工具回执。`LiveVoiceSession` 保留原生音频、交互状态和通知空闲窗口。

另一方案是 OpenAI 使用 SDK 内置 WebSocket，并另建原生 EventTarget socket 包装及真实播放进度子类，豆包／MOSS 单独接 transport。当前三家已有同一 App socket 和播放账本，首个方案可以直接保留已实测的 OpenAI truncate 与握手配置，避免同时替换两种连接机制。代价是继续维护已有 OpenAI wire 编解码；工具与历史核心均统一复用 SDK。

SDK 条件导出通过针对 `@openai/agents-core/_shims` 的构建适配选择 React Native shim，不改变其他依赖的全局导出条件。新增依赖用于替换公共核心，避免在 SDK 外再维护工具注册器与去重表。

## 实施与验收

- [x] Step 1：锁定依赖并完成构建适配。
  - [x] 保存已有工作区改动基线，确认原生测试设备与可执行检查。
  - [x] 安装实时 SDK 所需依赖；App 与 QuickJS 验证共用 shim 选择。
- [x] Step 2：接入 SDK transport 和工具。
  - [x] 原生连接、握手、读写队列与工具回执进入 transport；三家事件转换为 SDK 事件。
  - [x] 三个业务工具返回 Promise 与结构化结果，错误保留 stage/code/message/cause。
  - [x] 删除自有工具分派与去重；保留任务生命周期、播放回执和自然全双工语义。
- [x] Step 3：连接历史与产品生命周期。
  - [x] 使用 SDK history 更新 App 对话上下文。
  - [x] 验证试听、待机、明确打断、原生排空、最终回执与关闭顺序。
- [x] Step 4：验证、独立审查和交付。
  - [x] 运行三家现有语音与后台任务用例、类型检查、QuickJS 运行与 App 构建。
  - [x] 核对测试设备并记录缺口：无连接真机；已完成真实豆包云端流与计时音频端口，三家横屏真机及 MOSS／OpenAI 云端验收见 todo.md。
  - [x] 主 agent 修复独立审查问题，更新架构文档、进度和证据，隔离提交。
