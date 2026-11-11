# 语音主 Agent、后台任务与观察者的社区架构证据

检索日期：2026-11-11（Asia/Taipei）。

本文核对实时交互、并行任务、完成事件、长期观察与共享上下文的公开实现。证据类型区分为源码实现、官方示例和研究原型；涉及 Super-LOOI 的对应关系属于架构分析。

## 结论与阅读顺序

已有接近本次设想的开源实现。主参考是 **Qwen Audio Agent** 的前台语音、后台持久协调会话、多任务与结果投递；**LiveKit** 提供异步子模型委派和旁路观察、纠正注入的具体示例；**DeepSeek Super-agent** 与 **OpenClaw** 可补充短等待命令、多任务消息和长期事件驱动。下文的来源分别证明这些能力，不能把一个项目的能力归到另一个项目。

建议先对照 Qwen 的运行时与后台会话边界，再决定导演的职责。导演需要解决的具体问题是跨对话跟进目标和观察遗漏；任务记录、消息投递与播报时机已有普通代码的实现范式。增加导演会话的成本在于模型调用、独立上下文维护，以及它与语音主 Agent 的决策协调。

## Qwen Audio Agent：最接近的完整语音与多任务参考

核对源码提交：[`a9f4478da8df400d04facbb099ac2933ce8b11bc`](https://github.com/QwenAudio/qwen-audio-agent/tree/a9f4478da8df400d04facbb099ac2933ce8b11bc)。项目提供 Web、桌面与远程手机入口，实时语音前台包括豆包、OpenAI 和 Gemini；后台可以接 Pi、DeepSeek Harness 等 Agent。2026-11-10 的 v2.1.0 增加执行中调整任务和完成后续接。[项目与版本说明](https://github.com/QwenAudio/qwen-audio-agent/blob/a9f4478da8df400d04facbb099ac2933ce8b11bc/README_ZH.md)

核心是三个逻辑组件：前台 Agent 处理交流与轻量工具；编排运行时用代码管理任务和事件；后台 Agent 使用自身模型与工具执行。后台通过适配器接 ACP、A2A 或自定义协议，三个组件不要求是三个进程。[架构总览](https://github.com/QwenAudio/qwen-audio-agent/blob/a9f4478da8df400d04facbb099ac2933ce8b11bc/docs/architecture/overview.zh.md)

### 任务接口与持久协调

- 前台用 `spawn_thinking` 提交工作，立即拿到受理结果；`update_agent_task` 补充要求或续接成果，另有状态查询和取消接口。[前台任务工具源码](https://github.com/QwenAudio/qwen-audio-agent/blob/a9f4478da8df400d04facbb099ac2933ce8b11bc/server/src/frontend/tools/features/agent-task-tools.mjs)
- ACP 后台为每个 owner 和后端维护一个持久协调 Session。协调器可以派出多个独立项目 Session，随后结束当前轮次；用户调整和最终结果整理再进入协调队列。任务准入默认各有一个活动名额，但派发独立工作后可释放准入名额，项目继续运行。因此“默认准入为 1”和“后台只能做一件事”并不等价。[详细架构第 2、4、7、8 节](https://github.com/QwenAudio/qwen-audio-agent/blob/a9f4478da8df400d04facbb099ac2933ce8b11bc/docs/architecture/deep-dive.zh.md)
- 调度器独立维护全局、owner 与执行通道的名额。调度由代码负责，无需让模型轮询空闲状态。[TaskScheduler 源码](https://github.com/QwenAudio/qwen-audio-agent/blob/a9f4478da8df400d04facbb099ac2933ce8b11bc/server/src/task/task-scheduler.mjs)

### 结果触达与上下文回流

`SessionTaskCoordinator` 订阅 TaskManager 的事件；任务的所有权留在 TaskManager，关闭前台观察者不会取消工作。完成结果进入播报管理器，由会话呈现状态决定何时投递。[会话任务协调器](https://github.com/QwenAudio/qwen-audio-agent/blob/a9f4478da8df400d04facbb099ac2933ce8b11bc/server/src/orchestration/session-task-coordinator.mjs)

`AnnouncementManager` 把任务目标和结果形成关联到任务 ID 的上下文投递，再触发实时模型表达。它分别维护待投递结果、当前批次和交付状态。[结果播报源码](https://github.com/QwenAudio/qwen-audio-agent/blob/a9f4478da8df400d04facbb099ac2933ce8b11bc/server/src/voice/announcement/announcement-manager.mjs)

它对应本次设想中的持久“办事助理”和语音结果回流。要让这个助理同时观察每轮对话并提出纠正，还需要增加观察触发和反馈职责；下面的 LiveKit 示例对此有直接参考。

## LiveKit：异步子模型委派和后台观察者

### 对话继续，子模型后台执行

官方称为 **Subagent delegation / Talker-Reasoner**（子 Agent 委派／交流者与推理者）：低延迟主模型处理对话，独立上下文里的子模型进行分析；异步工具先用 `ctx.update()` 交回控制，结果完成后在主会话空闲时形成后续回应。上下文分开是为了避免每轮交流都携带推理历史。[子 Agent 委派文档与 Python/Node.js 示例](https://docs.livekit.io/agents/logic/patterns/subagent-delegation/)

进展更新会进入聊天上下文，由模型自然表达；直接播放填充音频是另一条通道。可取消的异步工具还可向模型提供运行任务查询与按 ID 取消。若要跨 Agent handoff 保留工具及后续结果，需要把工具放到会话级 `AsyncToolset`。[异步工具契约](https://docs.livekit.io/agents/logic/tools/async/)

### 独立 LLM 观察并注入纠正

官方 Observer（观察者）示例已经包含完整的“监听 → 分析 → 注入”代码：监听 `conversation_item_added`，调用独立 LLM，然后复制当前 Agent 的聊天上下文，用 `update_chat_ctx` 注入提示，影响后续回复。示例是对用户发言做规则分析，既没有让观察者直接发声，也没有展示双方相互审查；把它扩为事实纠错或目标跟进，是本项目需要明确的行为。[官方 Observer 示例，2026-04-16](https://livekit.com/blog/observer-pattern-voice-agent-guardrails)

这里值得复用的是旁路监听和反馈机制。观察频率决定模型费用与反馈延迟；若每轮运行分析，就增加每轮的模型请求。它本身不解决跨 App 重启的长期任务持久化。

## OpenAI：Chat-Supervisor 与独立的会话控制通道

官方 `openai-realtime-agents` 的 **Chat-Supervisor** 示例让实时模型处理基础交流，通过 `getNextResponseFromSupervisor` 调用文本模型做复杂工具执行和回答。代码读取实时会话里的消息历史，把最近用户信息补给 Supervisor，返回下一段回应。这证明语音与复杂推理可以分工，但该示例的工具调用仍然等待 Supervisor 返回，不代表已实现多项长期后台任务。[示例说明](https://github.com/openai/openai-realtime-agents/tree/94c9e9116b581052655cff7b756cc5e02771cda1)、[Supervisor 源码](https://github.com/openai/openai-realtime-agents/blob/94c9e9116b581052655cff7b756cc5e02771cda1/src/app/agentConfigs/chatSupervisor/supervisorAgent.ts)

当前 GPT-Live 官方文档还提供客户端自有后端委派、会话上下文补充及结果表达；sideband（旁路连接）可接收会话事件、更新指令和处理工具。它是应用连接同一个语音会话的通道，并不会自动创建导演模型。自有后端和额外模型的状态仍由应用管理。[Delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation)、[Server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls)

这些机制可作协议适配参考；OpenAI 的具体事件名称不直接适用于豆包。

## DeepSeek Super-agent：主会话保持响应，独立 Worker 持续推进任务

核对源码提交：[`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4)。该仓库是 DeepSeek 团队公开的研究原型，面向单个 GitHub 仓库，可接收 GitHub 与飞书消息。公开版本与设计文章的覆盖面并不完全相同。[项目说明](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/README.md)

已经实现的机制：

- 主会话使用 `dsh-superagent-router`，每个 Ticket（工作项）有独立的 Executor Session 与工作目录；Worker 可以接收后续消息继续同一工作项。Router 使用较小的工具集，主会话和 Worker 的前台命令默认在 5 秒后转为后台任务。[执行语义](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/003-execution.md)
- `Sessions` 对主会话设置 `noWait`：拒绝命令位置的 `sleep`、超过 30 秒的 Shell 等待参数，以及超过 5 秒的 job 等待。其目的是让新消息和完成事件及时进入主会话；这限制了阻塞时间，没有证明命令在语义上一定简单。[主会话工具集与等待约束源码](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/sessions.ts#L61)
- Worker 的后台命令或子 Agent 完成后，可唤起对应 Executor；普通进度保留在 Ticket，问题和需要主会话处理的报告由 `Notices` 转为主会话消息，正在执行时在下一步接收。`Runtime`、`Engine`、`Store` 和 `Effects` 负责生命周期、状态与外部执行。[架构与模块入口](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/007-architecture.md)、[消息转发源码](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/notices.ts)

与当前设想的对应关系：主 Agent 保持响应、任务有独立上下文、跟进消息定向投递、完成结果自动回传，都已有实现。它的主入口是文本和代码协作；不能据此认定已经实现实时语音、双模型持续互相纠正，或“只允许简单命令”的完整语义约束。

## OpenClaw：并行子任务、完成后唤起父会话、事件与定时任务分工

核对源码提交：[`7d0d6bfa0521b30df2d3feaf2c0dd2c9b7c9fd39`](https://github.com/openclaw/openclaw/tree/7d0d6bfa0521b30df2d3feaf2c0dd2c9b7c9fd39)。

已经实现的机制：

- `sessions_spawn` 创建独立子会话；支持干净的 `isolated` 上下文或在创建时 `fork` 当前对话。父会话可以继续运行。`sessions_send` 区分 `steer`（指导正在运行的任务）、`followup`（开始或排队下一轮）和 `notify`（只排入下轮上下文）。这三种操作分别表达“改变当前工作”“继续工作”和“提供信息”。[工具契约](https://docs.openclaw.ai/tools/subagents/tool-reference)
- 完成结果交回请求方；顶层请求方通过后续 Agent 调用处理，嵌套父 Agent 通过内部注入处理。`completionTarget: "parent"` 允许父会话私下审阅，再自行决定对外表达。投递有单独的完成状态，避免把“子任务执行完”混同于“用户已收到结果”。[完成消息语义](https://docs.openclaw.ai/tools/subagents/announce)、[完成投递源码](https://github.com/openclaw/openclaw/blob/7d0d6bfa0521b30df2d3feaf2c0dd2c9b7c9fd39/src/agents/subagents/announce/subagent-announce-completion-delivery.ts)
- `sessions_yield` 结束当前模型轮次，之后由完成事件继续会话；文档明确使用事件交接来等待子任务，避免靠重复查询历史或 Shell 等待检测完成。[等待与继续的工具契约](https://docs.openclaw.ai/tools/subagents/tool-reference#tool-sessions_yield)
- 当前的 Heartbeat 已迁移到普通 automation jobs：周期观察使用带计划、提示词、上下文和投递设置的任务；后台命令与任务完成等即时事件走普通会话执行，不依赖周期监控。[当前 Heartbeat 迁移与调度语义](https://docs.openclaw.ai/gateway/heartbeat)

与当前设想的对应关系：多任务与跟进消息、父会话收到完成事件再表达、周期观察与即时完成分开，均有直接参考。`fork` 是创建时复制上下文，`notify` 是一次上下文投递；两者都不表示两个 LLM 始终共享同一份实时模型上下文。周期观察也不要求额外常驻一个导演 LLM。

## Letta：后台反思与跨 Agent 共享持久知识

当前官方 Dreaming 通过后台子 Agent 回看近期对话、整理经验并更新记忆；可在若干步骤后或上下文压缩时触发，也能让主 Agent 在另一个后台对话中审阅和修改记忆提案。这直接覆盖“另一个模型观察经历并反馈”的一部分。[Memory & dreaming](https://docs.letta.com/configuration/memory#dreaming)

当前共享记忆使用多个 Agent 挂载同一 Git 仓库；各自读写、提交和同步文件。旧版多个 Agent 挂载同一 memory block 的 API 仍存在，官方已经建议迁往共享记忆仓库。这覆盖共享知识和工作资料，不能等同于双边逐轮即时注入。[共享记忆语义](https://docs.letta.com/concepts/shared-memory)

与当前设想的对应关系：Letta 可参考后台反思和共享持久知识。现有资料没有证明 Dreaming 本身承担通用长期任务调度，或持续监督实时语音输出。旧的 LettaBot 仓库已归档，项目把新开发指向 Letta Code 的 Channels 与 Remote Environments；不宜把 LettaBot 当成当前接入路线。[归档项目说明](https://github.com/letta-ai/lettabot/blob/99c3b5dd73550fe0a4eac2ee31b1c3229ca9e550/README.md)

## 可以直接对照的职责边界

| 讨论中的能力 | 一手实现依据 | 需要区分的边界 |
| --- | --- | --- |
| 语音前台、持久办事助理与独立任务 | Qwen 前台工具、持久协调 Session、项目 Session | 编排运行时负责调度，后台协调模型负责分派与整理 |
| 主 Agent 直接调用少量工具，保持快速响应 | DeepSeek Router 工具集、短等待与后台命令 | 快速返回不等于任务语义简单 |
| 多项后台任务和独立工作上下文 | DeepSeek Ticket/Executor；OpenClaw 子会话 | 任务并发与上下文共享是两个设计问题 |
| 任务完成后主动交给主 Agent 表达 | Qwen AnnouncementManager；LiveKit 异步工具；OpenClaw completion delivery | 任务完成、父 Agent 处理和对外送达是不同事件 |
| 长期跟进 | DeepSeek 持久 Ticket 与事件；OpenClaw automation jobs | 长期目标存在，不要求 LLM 持续空转 |
| 旁路观察对话并注入反馈 | LiveKit Observer 示例 | 示例监听用户发言并单向注入规则提示；任务调度与双方事实纠错需要另行定义 |
| 回看经历并整理长期知识 | Letta Dreaming、记忆审阅 | 记忆反思与通用导演职责不同 |
| 双向传递信息 | OpenClaw steer/followup/notify；Letta 共享记忆 | 消息、上下文快照、持久知识不能混称实时共享上下文 |

## Super-LOOI 的设计取舍

语音主 Agent 将后台任务统一交给持久协调 Agent；持久协调 Agent 保存长期目标，分派和跟进独立任务，并汇总结果交回语音侧。语音主 Agent 只对接这一个 Agent，独立任务的通信留在协调层内部。语音侧可直接使用简单工具，工具调用不增加 Agent 对接关系。观察与反馈由持久协调 Agent 承担，其触发频率和上下文预算继续按实际交互确定。

以下是基于上述证据的项目判断：

1. 以前台语音、代码编排、持久后台协调会话与独立任务作为讨论骨架。先核对 Qwen 的工具和生命周期，再映射现有 VoiceRuntime、VoiceTaskCoordinator 与 Pi 执行器。
2. 导演的长期办事与观察反馈使用同一个持久协调会话。对话和任务事件可唤起它，具体任务继续在独立上下文中执行。增加独立观察模型会增加调用与上下文同步成本，需要具体的观察延迟或职责冲突来支持这一拆分。
3. 语音侧简单命令的目标包括短响应时间和明确操作范围。DeepSeek 的短等待机制只解决前者，工具范围需要根据实际调用需求定义。
4. Qwen 的 Node Gateway、ACP 进程和网络接入形态与当前手机内 NSH 宿主不同。先参考接口和消息语义，保留现有手机内 Pi 工具执行与原生能力；整体引入框架将增加 Node 宿主、后端进程和协议适配工作，应在具体复用收益明确后再比较。
