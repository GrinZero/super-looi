# Realtime 开源会话层选型

核验日期：2026-11-14。目标是复用开源会话核心，减少 Super LOOI 对通用会话、工具续答、历史和中断流程的自有实现。应用采用 NSH Rust／QuickJS，运行能力由 App 自身承载，直接连接目标云服务。

## 结论

已有开源框架和 SDK 提供上述公共能力。缺少某家 provider 插件与缺少公共会话核心是两件事：可以复用上游核心并增加插件，不必因此重写一套统一协议。

保留端内运行形态时，优先验证 OpenAI Agents SDK 的 `RealtimeSession` 与自定义 `RealtimeTransportLayer`。需要更完整的多模型会话／媒体框架时，LiveKit Agents 是主要比较对象，但要计入其服务端运行时和媒体连接方式。下列源码核验没有找到 OpenAI Realtime、豆包现役 Seeduplex、MOSS-Live 三家都开箱即用的组合。

## 端内候选：OpenAI Agents SDK

固定源码：`openai/openai-agents-js@8aeac0eb255dbdff9adcdc65a0eae638cbcea74f`，MIT；该源码中的 `@openai/agents-realtime` package 版本为 0.22.0。

- `RealtimeSession` 已维护会话历史、工具调用、事件和 agent 配置；构造参数直接接受自定义 `RealtimeTransportLayer`，不要求重新实现公共 session。[会话实现](https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/packages/agents-realtime/src/realtimeSession.ts)
- 官方文档明确允许其他 speech-to-speech API 实现该 transport 接口。接口包含音频输入、函数结果、配置更新、手动中断和历史同步。[扩展接口](https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/packages/agents-realtime/src/transportLayer.ts)、[官方 transport 指南](https://openai.github.io/openai-agents-js/guides/voice-agents/transport/)
- package 提供 browser／react-native 条件导出；官方说明 React Native 自有原生媒体实现通过 transport 接入，浏览器默认 WebRTC 类不能直接视为原生实现。[包清单](https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/packages/agents-realtime/package.json)

对本项目的判断：这是复用 TypeScript 公共会话核心的可行接口；[后续调研](openai-agents-sdk-realtime-research-2026-11-14.md)已在项目 QuickJS runner 通过 20 项离线行为检查，使用 react-native 条件导出，无需 SDK 补丁。工作量主要是现有原生音频及 WebSocket 接线、豆包／MOSS 的 transport，以及原生实际播放进度如何回传。SDK 没有内置三家协议支持。

## 多模型框架与现成运行时

### LiveKit Agents／Pipecat／TEN

LiveKit Python 固定提交 `cbb5770c716c70009969cd7fa88e3c3662222ce9`；Node 固定提交 `1fa759cf67477f19466a68cb15e2e17de1908e04`，两者 Apache-2.0。它已有 RealtimeModel／RealtimeSession，并为模型自主听说和中断提供 DuplexModel／DuplexRealtimeAdapter，公共会话层无需重新设计。[Python 双工模型](https://github.com/livekit/agents/blob/cbb5770c716c70009969cd7fa88e3c3662222ce9/livekit-agents/livekit/agents/llm/duplex.py)、[Node 双工适配器](https://github.com/livekit/agents-js/blob/1fa759cf67477f19466a68cb15e2e17de1908e04/agents/src/llm/duplex_adapter.ts)

Python AgentSession 支持省略 room，使用自定义 AudioIO；房间服务器不是硬性条件。其 Python／native RTC 依赖、Node 的 `@livekit/rtc-node`／`@livekit/av` 依赖仍需单独评估移动端移植成本。[AudioIO 接口](https://github.com/livekit/agents/blob/cbb5770c716c70009969cd7fa88e3c3662222ce9/livekit-agents/livekit/agents/voice/agent_session.py#L889)、[Node 依赖](https://github.com/livekit/agents-js/blob/1fa759cf67477f19466a68cb15e2e17de1908e04/agents/package.json)

中文社区 Seeduplex 插件 `8eab82630381e2acd3317791f2df7f2f4592ec77` 已使用正确端点和模型，但工具结果过滤及音频 truncate 占位需要补齐。补插件与自研公共核心的维护范围不同。[具体实现](https://github.com/di-osc/livekit-plugins-chinese/blob/8eab82630381e2acd3317791f2df7f2f4592ec77/livekit-plugins/livekit-plugins-volcengine/livekit/plugins/volcengine/realtime.py)

Pipecat 固定提交 `0602125e1d814ae49a7c4e6dc3f6f1b8b3d5ed0c`，BSD-2-Clause。它已有统一帧管线、OpenAI Realtime、中断及工具往返；本次官方 services 树未找到现役 Seeduplex／MOSS-Live。新增 provider 可以复用核心，其 Python >=3.11 的管线不能直接当作 QuickJS 包加载。[OpenAI 实现](https://github.com/pipecat-ai/pipecat/blob/0602125e1d814ae49a7c4e6dc3f6f1b8b3d5ed0c/src/pipecat/services/openai/realtime/llm.py)、[运行依赖](https://github.com/pipecat-ai/pipecat/blob/0602125e1d814ae49a7c4e6dc3f6f1b8b3d5ed0c/pyproject.toml)

TEN 固定提交 `619abefc1bb0865be681aa531a4d5dfe2bece868`。其根 LICENSE 在 Apache v2 基础上增加条款，禁止在终端设备（含手机）host 框架，因而不适用于本项目当前端内路径。仓库的 `moss_tool_python` 是 usemoss.dev 检索工具，不代表支持 MOSS-Live。[实际 LICENSE](https://github.com/TEN-framework/ten-framework/blob/619abefc1bb0865be681aa531a4d5dfe2bece868/LICENSE#L10)、[MOSS 工具用途](https://github.com/TEN-framework/ten-framework/blob/619abefc1bb0865be681aa531a4d5dfe2bece868/ai_agents/agents/ten_packages/extension/moss_tool_python/README.md)

### Qwen Audio Agent

固定源码：`QwenAudio/qwen-audio-agent@02990dc159d2a6d211f4563daa5120ac9979a0bf`，Apache-2.0。

它已实现统一 Gateway Client Protocol、实时前台、后台任务调度、结果回到当前对话，以及 OpenAI／GPT-Live 和现役豆包 Seeduplex 插件。豆包模型目录明确使用 `1.2.6.1`。[项目说明](https://github.com/QwenAudio/qwen-audio-agent/blob/02990dc159d2a6d211f4563daa5120ac9979a0bf/README.md)、[豆包模型声明](https://github.com/QwenAudio/qwen-audio-agent/blob/02990dc159d2a6d211f4563daa5120ac9979a0bf/shared/realtime-models/doubao-seeduplex.mjs)

其架构明确由 Gateway 承载 Frontend Agent 和 Orchestration Runtime，客户端拥有 I/O 与展示。复用它是接入或移植现成运行时，不是直接替换一个轻量移动端包。本次 provider 检索未找到 MOSS-Live 接口实现。[运行边界](https://github.com/QwenAudio/qwen-audio-agent/blob/02990dc159d2a6d211f4563daa5120ac9979a0bf/docs/architecture/deep-dive.md)

### Micdrop

固定源码：`Godefroy/micdrop@3d9d50a20595c45f97ff3f86c44fd8024c455efc`。

其 TypeScript `Realtime` 基类集中处理话轮、打断后丢弃迟到输出、对话顺序和主动说话，现成实现是 OpenAI Realtime 和 Gemini Live。React Native 客户端连接 Node 服务端；它采用客户端控制话轮、关闭 provider VAD 的策略，不能默认适配所有全双工模型。[公共基类](https://github.com/Godefroy/micdrop/blob/3d9d50a20595c45f97ff3f86c44fd8024c455efc/packages/server/src/realtime/Realtime.ts)、[模型与话轮文档](https://github.com/Godefroy/micdrop/blob/3d9d50a20595c45f97ff3f86c44fd8024c455efc/website/src/content/docs/server/realtime.mdx)

### WaaV

固定源码：`BudEcosystem/WaaV@ddeba3a31cad7c63848b868d4a2e5e5c07119dfb`，Apache-2.0。

它是 Rust 统一语音网关，提供 OpenAI 兼容 `/v1/realtime` 和多个 speech-to-speech provider。公布的 11 家实时模型列表没有豆包 Seeduplex 或 MOSS-Live；仓库检索中的 MOSS 多为 TTS／转写模型。其交付形式是 Linux 网关，Rust 实现不等于已能作为 iOS／Android 端内库使用。[统一 API、运行方式与 provider 列表](https://github.com/BudEcosystem/WaaV/blob/ddeba3a31cad7c63848b868d4a2e5e5c07119dfb/README.md)

## MOSS 官方 SDK 的覆盖范围

官方 `@mossai/mosslive@0.1.0` 实现任务委派、队列、取消、结果回传、服务回执及连接辅助函数，支持 Pi 和自定义执行器。它可以减少 MOSS 后台委派代码，但没有提供统一三家采播生命周期的公共会话核心；包声明为服务端 Node >=22.19.0。[官方 SDK 使用入口](https://platform.moss.cn/docs/reference/moss-live)、[实时接入指南](https://platform.moss.cn/docs/scenarios/moss-live/)

## 验证方向

QuickJS 加载、受控音频事件、工具往返和中断的离线结果见上述后续调研。下一项验证是 App 自有 socket 与原生 PCM 采播的真实接线，再覆盖三家 provider。决策依据是能删除多少自有公共状态机，以及新增 transport 的规模；真实播放回执、明确打断和工具续答均需有 E2E 证据。

如选用 LiveKit，应比较其核心复用收益与端内运行移植、或引入服务端部署的成本。既有手机本地工具、KWS 与 MOSS 播放回执均需有实际接线。上述研究没有改变 App 自身承载运行能力的要求。
