# GPT-Live、开源 SDK 与可替换的前后台

核验日期：2026-11-14。对应用户提供的 [GPT-Live WebRTC 文档](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)。

## GPT-Live 的可替换边界

该文档介绍 OpenAI 托管的 GPT-Live 语音模型／API。前台负责持续听说，把推理与工具工作委派给后端；后端模型可独立于语音模型选择。[官方介绍](https://developers.openai.com/api/docs/guides/live)

| 接入方案 | 后端 LM／Agent | 前台实时语音 provider | 运行／交付形式 |
|---|---|---|---|
| GPT-Live：Responses delegation | 配置受支持的 Responses 模型与工具 | OpenAI GPT-Live | 托管 API |
| GPT-Live：client delegation | App 自己连接任意模型、Agent 或服务 | OpenAI GPT-Live | 托管 API；App 执行后端工作 |
| OpenAI Agents SDK + 自定义 transport | App 工具／执行器接入后端模型 | 实现 transport 后连接对应语音 API | MIT 开源 SDK |

GPT-Live 的 client delegation 由 App 构造后端上下文、运行工作并返回结果，适合连接现有 App 内 Pi。`session.delegation.created` 提供委派标识，具体任务上下文由 App 从转写和应用状态构造；结果可用 `session.commentary.append` 交付给语音前台。公开配置没有把 GPT-Live 前台改为豆包／MOSS 服务的 provider 插件接口。[委派契约](https://developers.openai.com/api/docs/guides/live-delegation)

Agents SDK 允许其他 speech-to-speech API 实现 `RealtimeTransportLayer`。前台可替换能力来自这一客户端接口；后端接入由 App 工具和执行器承担。[transport 指南](https://openai.github.io/openai-agents-js/guides/voice-agents/transport/)、[SDK MIT 许可](https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/LICENSE)

## 文档列出的代码项目

- **OpenAI Live Console**：MIT 示例应用，演示 WebRTC、委派和后端工具；浏览器负责媒体，Node 服务负责配置与执行。它展示 GPT-Live 接法，没有提供统一三家语音 provider 的框架。[README](https://github.com/openai/openai-live-console/blob/main/README.md)、[LICENSE](https://github.com/openai/openai-live-console/blob/main/LICENSE)
- **Switchboard OpenAI Live Toolkit**：第三方 React Native 接入层，`package.json` 声明 MIT，面向 OpenAI GPT-Live。其 README 明确说明底层 `OpenAI.Live` 节点依赖尚未公开发布的 Switchboard 构建，WebRTC 构建仍需本地 SDK；这会引入原生 SDK、构建获取与 React Native 宿主接线成本。不能据公开外层仓库推定整个媒体实现都已作为可直接复用的开源组件交付。[包清单](https://github.com/switchboard-sdk/openai-live-toolkit/blob/main/package.json)、[构建说明](https://github.com/switchboard-sdk/openai-live-toolkit/blob/main/README.md#before-you-ship)

## 三家媒体传输能力

| 当前目标 | 本次核实的直接接入契约 |
|---|---|
| OpenAI GPT-Live | WebRTC 为推荐音频接入方式，也支持 WebSocket；WebRTC 使用音轨传音频、data channel 传事件。 |
| 豆包 Seeduplex `1.2.6.1` | 当前公开直接 API 提供 `wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`；未找到该 API 的 WebRTC／SDP 接入契约。 |
| MOSS-Live | 当前公开直接 API 为 `wss://api.mosi.cn/v1/realtime`；未找到该 API 的 WebRTC／SDP 接入契约。 |

来源：[OpenAI 连接文档](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)、[豆包接口](https://docs.volcengine.com/docs/doubao-voice/end-to-end-real-time-voice-full-duplex-version?lang=zh)、[MOSS 接口](https://platform.moss.cn/docs/reference/moss-live)。另外存在的 RTC 服务或媒体网关需要分别核对其模型、工具及连接方式，不能据此把上述直接接口视为已支持 WebRTC。

可替换性通过客户端会话接口承载，各 provider 按已支持的媒体传输实现。若为 OpenAI 增加原生 WebRTC，需要计入媒体库、音频所有权、KWS 切换和连接生命周期接线；复用现有系统 AEC 仍可让 WebSocket provider 共享设备端回声处理。

## 当前 App 的位置

本项目已把公共会话接到 `@openai/agents-realtime@0.22.0`，三家经自定义原生 transport 进入 SDK，后端由 `VoiceTaskCoordinator`／Pi 运行。当前 OpenAI 编解码仍连接 `/v1/realtime`，模型默认 `gpt-realtime`。

用户确认继续采用 **Agents SDK＋自定义 transport**，OpenAI 使用 **Realtime API（`/v1/realtime`）**，不接入 GPT-Live 的 `/v1/live/sessions`。前台语音 provider 与后端执行器继续独立替换；WebRTC／WebSocket 的评估依据各 provider 的能力进行。实际 SDK 接入见 [实现记录](openai-agents-sdk-integration-2026-11-14.md)。
