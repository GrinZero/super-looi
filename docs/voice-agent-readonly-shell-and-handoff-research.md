# Voice Agent：只读 shell、异步交付与会话边界

调研日期：2026-11-12。资料范围为官方文档、官方 API 参考和本仓库源码。

## 结论

语音 Agent 直接调用查询工具，有明确的官方支持；LiveKit 与 Pipecat 也提供让长工具与语音对话分开运行的机制。让 LOOI 直接做轻量读取、耗时工作异步交付，是有依据的方向。“只读 shell 已是语音行业标准”则缺少足够证据：官方语音示例通常使用查订单、搜索等函数工具；shell 是一种可选执行接口。

对 LOOI，值得比较的改动是复用现有 shell 运行时提供直接查询，以及让长工作提交后尽快释放当前工具调用。语音交付也可以与前台任务操作界面分开。以上是候选边界；只读工具具体用途、按钮影响范围和交流的 session 定义，仍需与用户对齐。

## 1. 官方实践支持什么

OpenAI Realtime 支持在会话或单次响应中注册 `function` 工具。模型输出调用参数，应用的客户端或服务端执行，再返回 `function_call_output`。因此，查询工具可以直接属于语音 Agent，不必先启动另一个执行 Agent。[OpenAI：Realtime with tools](https://developers.openai.com/api/docs/guides/realtime-mcp)

OpenAI 的 shell 文档区分托管容器与 `environment.type="local"`。后者由应用自己的运行时执行命令，并返回 `shell_call_output`；“local”指执行器所在地，并不意味着手机系统原生提供桌面 shell。这份 shell 接口属于 Responses，不能直接当作 Realtime 已内建的 shell 工具；在 Realtime 中可以通过自定义函数连接已有执行器。[OpenAI：Shell](https://developers.openai.com/api/docs/guides/tools-shell)

作为行业实例，当前 GPT-Live 文档明确区分语音前端和后台 delegation（委派执行）：语音与委派工作独立推进，Responses delegation 支持托管 shell 与本地 shell。它使用独立的 Live 协议；这里仅将其作为解耦实践的证据，未提出更换本项目 API。[OpenAI：Delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation)

## 2. 为什么 JavaScript 的 async 不等于对话不阻塞

LiveKit 官方直接指出，普通长工具会使对话等待。其 Node.js 工具在第一次 `await ctx.update(...)` 后变为非阻塞：状态进入上下文，模型可以继续说话，后续更新和最终结果在合适的空闲时机回答。跨 Agent 切换仍需保留工具生命周期时，它另有 `AsyncToolset`。这说明阻塞来自工具循环的等待规则，不能只看函数是否声明为 `async`。[LiveKit：Async tools](https://docs.livekit.io/agents/logic/tools/async/)

Pipecat 的官方 API 采用另一种机制：`cancel_on_interruption=False` 的调用被当作异步工具，模型立即继续对话，结果稍后通过 developer 消息注入；中间进度使用 `FunctionCallResultProperties(is_final=False)`。这是可借鉴的调度方式，不是要求 LOOI 引入 Pipecat。[Pipecat：llm_service API](https://reference-server.pipecat.ai/en/latest/api/pipecat.services.llm_service.html)

LOOI 的实现应分别检查：音频采集是否继续、模型是否被工具回执挡住、发声是否被本地 busy 状态挡住、结果回来时是否抢占用户说话。它们属于不同的控制点；删除任务 UI 不会自动解除模型等待。

## 3. “只读 shell”的实际含义

只读应是执行接口的能力约束。单靠提示词说明“只能读取”，或仅检查命令以 `cat`、`ls` 开头，不能实现这个约束。例如 shell 会先执行命令替换，输出重定向也能创建或改写文件。这是 shell 语义导致的直接实现问题。[GNU Bash：Command substitution](https://www.gnu.org/s/bash/manual/html_node/Command-Substitution.html)、[Redirections](https://www.gnu.org/s/bash/manual/html_node/Redirections.html)

可比较两种接口：

| 接口 | 具体用途 | 复杂性成本 |
| --- | --- | --- |
| 受限命令接口，例如列目录、读文件、搜索和管道过滤 | 满足常见读取；由执行器限定支持的命令、参数和组合 | 要定义支持的语法；若只支持固定操作，应如实称为受限 shell，而不是完整 shell |
| 任意 shell 加执行环境只读权限 | 保留完整 shell 组合能力，让环境限制业务数据写入 | 要处理各平台执行器的权限或文件系统映射；仅切换工具名称无法获得此能力 |

这些方案是工程推断。第一步应由真实查询案例决定是否需要完整 shell；如果现有读取工具已经覆盖需求，新增 shell 的主要价值必须是减少调用轮次或支持必要的组合查询。

## 4. 本项目已有的移动执行基础

仓库的 `createBashTool` 已描述移动端 Alpine Linux `/bin/sh` 和 BusyBox 环境，并通过异步 `spawn` 执行命令。[bash.ts](../packages/looi-runtime/src/agent/tools/bash.ts)

NSH 的 Node 兼容层把 `spawn` 映射为 `shell.create`、`shell.drain`、`__nsh_shell_wait` 等主机调用；原生 `LinuxShell` 管理应用私有 guest（客户运行环境），Android 实现通过 PRoot 运行并映射 `/workspace`。因此，LOOI 的问题是如何给已有运行时提供只读执行契约，而不是从零为手机安装桌面 shell。[child_process.ts](../packages/nsh-node-compat/src/shims/child_process.ts)、[linux_shell.rs](../apps/nsh/src/linux_shell.rs)、[android.rs](../apps/nsh/src/linux_shell/android.rs)

当前读取到的 shell 请求和工具接口没有只读模式字段。复用运行时可以减少新增依赖；是否需要原生权限改动，取决于选受限命令接口还是完整 shell。

## 5. 现有流程的具体耦合

- `VoiceTaskCoordinator` 的默认快速窗口是 2,500 ms；`run_agent_task` 等待 `submit()` 回执，窗口之后才报告转后台。语音工具调用本身没有立即完成。[task-coordinator.ts](../apps/nsh/runtime/voice/task-coordinator.ts)、[run-agent-task.ts](../apps/nsh/runtime/voice/tools/run-agent-task.ts)
- store 的 coordinator 回调仍调用 `runtime.run()`，并设置全局 `busy`、`status`、`message`。`App.tsx` 由 `store.busy()` 显示右下角 `stop-task`，因此后台语音工作也触发前台任务 UI。[store.ts](../apps/nsh/store.ts#L925)、[App.tsx](../apps/nsh/App.tsx#L265)
- `LiveVoiceSession` 用 `tools.busy` 限制部分轮次恢复和状态推进。但 20 ms 的 tick 循环仍负责音频上传，不能仅凭这个 busy 条件断言麦克风采集被暂停，也不能排除同步工作或服务端响应造成的实际卡顿。[live-session.ts](../apps/nsh/runtime/voice/live-session.ts)
- Store 的 `busy` 还参与 App 切后台时取消任务、文字提交、新对话及表情与状态显示。执行器自身也有单任务互斥。分离呈现状态时，需要保留执行占用、交互问题、任务结果与取消的正确归属。[store.ts](../apps/nsh/store.ts)、[application.ts](../apps/nsh/runtime/application.ts)

这使第一步可以聚焦两个独立问题：工具何时释放对话等待，以及语音工作是否应占用全局前台任务状态。删除按钮只是表现层改动；将全局 busy 简单清零又会改变现有执行互斥，两者都不能代替明确状态的职责归属。

## 6. turn、语音 session 与任务 session

OpenAI Realtime 把 session（会话）定义为有状态的连接交互，其中包含 conversation（对话记录）和多次 responses（响应）。所以一次简短问答通常是一个 turn（轮次），并不必然是一个新的协议 session。重新建立连接与业务上开始一段新交流，可以分别决定。[OpenAI：Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)

LiveKit 同样将 session 与当前 Agent 分开；切换 Agent 时可显式携带、裁剪或总结上下文。新 Agent/任务默认的新历史，不等于必须重建语音连接。[LiveKit：Agents and handoffs](https://docs.livekit.io/agents/logic/agents-handoffs/)

本项目当前语义还存在一处反差：`LiveVoiceSession` 的静默结束阈值为 12 秒，工具忙碌、通知和播放等条件会影响结束时机。`VoiceRuntime.start()` 创建新的 `LiveVoiceSession`，只注入最新任务回执 `latestContextNote`，不恢复普通语音的完整历史；而 `MobileRuntime.run()` 每次生成新 taskId，却使用相同的 `this.conversationId` 作为执行 sessionId。[live-session.ts](../apps/nsh/runtime/voice/live-session.ts)、[runtime.ts](../apps/nsh/runtime/voice/runtime.ts)、[application.ts](../apps/nsh/runtime/application.ts#L856)

`VoiceRuntime.enqueueNotice()` 仅向当前活动语音会话投递通知；没有活动会话时只保留上下文附注，下次启动不会自动把这条完成通知加入播报队列。如果一项工作跨越多次短交流，“完成后交回来”还需要明确下一次交流的通知投递行为。[runtime.ts](../apps/nsh/runtime/voice/runtime.ts#L127)

因此，对齐时应分别决定三个生命周期，而不是新增三套管理对象：

- **语音连接**：承载音频与事件；连接何时关闭是传输层决定。
- **一段交流的上下文**：需要明确“每次新 session”是每次唤醒、一次请求，还是用户显式换话题。
- **后台工作的上下文**：需要明确独立请求是否新建执行 session，以及补充同一件事时是否关联原工作。

因此，“频繁交流分别是新 session”可以落实为业务上下文分段，并与持续可说话、后台工作继续运行同时成立。是否每次都重开语音连接，需要用户先明确所说的 session 边界。
