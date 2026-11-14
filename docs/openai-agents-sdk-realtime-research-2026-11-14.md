# OpenAI Agents SDK 端内 Realtime 接入调研

核验日期：2026-11-14。研究对象：`@openai/agents-realtime@0.22.0`；固定源码 `openai/openai-agents-js@8aeac0eb255dbdff9adcdc65a0eae638cbcea74f`，对应 `v0.22.0`，MIT。

实际接入与验证结果见 [接入记录](openai-agents-sdk-integration-2026-11-14.md)。

## 结论与采用边界

**建议采用 SDK 的 `RealtimeSession` 作为公共会话核心，以其 transport 接口承接三家服务，取代继续扩展自有公共会话协议的方向。** 官方明确允许其他 speech-to-speech（语音到语音）API 实现 `RealtimeTransportLayer`。现有 QuickJS 宿主的隔离探针已通过 20 项离线行为检查，无需修改 SDK 源码。[官方 transport 指南](https://openai.github.io/openai-agents-js/guides/voice-agents/transport/)

能交给 SDK 的是工具注册、分派、同连接调用去重、对话历史修订和调用快照。原生采播、实际播放账本、MOSS 播放回执、App 待机与唤醒、跨连接任务仍有独立职责。豆包与 MOSS 需要实现自定义 transport；SDK 没有内置这两家协议，适配工作涉及握手就绪、二进制音频、取消和工具续答顺序。

接入后的产品运行位置仍在 App，App 直接连接选定的 provider（服务商）；使用 SDK 不要求增加网关服务，也不要求让豆包／MOSS 请求经过 OpenAI。`RealtimeAgent` 是工具与指令配置，语音模型由 transport 连接；现有 Pi 任务执行器保留。

## 已运行的 QuickJS 探针

使用项目现有 `qjs_runner`、`quickjs-jit@0.14.2` 和 `nshNodeCompatPlugin`，从临时目录安装正式发布包。实际执行的是桌面原生 QuickJS runner，未使用 Node 执行探针逻辑；WebSocket、麦克风和播放器由受控 fixture（测试替身）提供。它证明已检查的 SDK 行为可在该 VM 与兼容层运行，三家真实云服务、手机原生采播及其联动还需接线验证。

| 导出条件 | 打包 | QuickJS 执行结果 |
|---|---|---|
| `browser, import` | 成功 | 创建 `RealtimeAgent` 时失败：`EventTarget is not defined`，栈位于 `BrowserEventEmitter` |
| `react-native, import` | 成功，1,489,918 bytes，371 个输入模块 | 20 项检查通过，进程退出码 0 |

`react-native` 条件会选择 SDK 的可移植事件发射器，避开浏览器 `EventTarget`；本次没有新增该全局 polyfill（兼容实现）。正式构建应针对 SDK 的条件导出处理，避免未经验证地改变整个 App 的包解析方式。[React Native shim 源码](https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/packages/agents-core/src/shims/shims-react-native.ts)

检查内容及观测：

| 行为 | 结果 |
|---|---|
| 自定义 transport 建连、工具配置、PCM 输入 | Session 把配置和 640-byte 输入交给 transport |
| 本地历史修订 | 相同 `itemId` 的转写更新覆盖旧内容，没有新增重复消息 |
| MOSS 原始 VAD（语音活动检测）通知 | 向 raw event 通道注入 `input.speech.started`，Session 未自行中断音频 |
| 音频结束与播放排空 | `audio_done` 立即触发 `audio_stopped`，此时模拟原生队列仍有 100 ms |
| 手动中断 | `session.interrupt()` 委派给 transport，音频中断事件可回到调用方 |
| 工具执行与重复通知 | `2+3` 返回 5；重复 `callId` 不重复执行工具 |
| 慢工具与音频并发 | 工具 Promise 未完成时音频继续流动；Promise 完成后才提交工具结果 |
| `backgroundResult` | 提交结果时 `startResponse=false`，没有独立后台任务生命周期 |
| 工具错误 | 默认返回泛化错误；配置 `tool.errorFunction` 后保留 stage、code、reason 和底层 cause |
| 传输错误 | 原始 Error 对象经过 Session 事件转发，未被替换成“超时” |
| 主动消息与关闭 | 主动消息委派给 transport；关闭后迟到工具结果不再写回该连接 |
| 内置 OpenAI WebSocket 注入 | `createWebSocket` + `skipOpenEventListeners` 可接受受控 socket；发出 `session.update` 和 base64 音频输入 |
| OpenAI WebSocket 静音 | 内置 `mute()` 明确抛出不支持；需由 App 停止音频输入 |

完整断言与结果保存在 [probe.ts](artifacts/openai-agents-sdk/probe.ts)、[results.json](artifacts/openai-agents-sdk/results.json)、[execution.json](artifacts/openai-agents-sdk/execution.json)；初次失败栈见 [browser-error.log](artifacts/openai-agents-sdk/browser-error.log)。官方运行环境说明没有列出 QuickJS，本次证据限于上述已执行路径。[运行环境说明](https://openai.github.io/openai-agents-js/guides/troubleshooting/)

### 复现

在已安装仓库开发依赖的根目录执行。SDK 依赖、bundle 和运行状态都写入临时目录；仓库依赖与 lockfile 不变。

```sh
probe_dir=$(mktemp -d -t looi-agents-sdk)
cp docs/artifacts/openai-agents-sdk/package.json docs/artifacts/openai-agents-sdk/pnpm-lock.yaml "$probe_dir/"
pnpm --dir "$probe_dir" install --frozen-lockfile --ignore-scripts
cargo build --locked --manifest-path packages/nsh-node-compat/rust/Cargo.toml --bin qjs_runner
pnpm exec node --import tsx docs/artifacts/openai-agents-sdk/build.ts "$probe_dir" react-native
packages/nsh-node-compat/rust/target/debug/qjs_runner "$probe_dir/probe-react-native.mjs" "$probe_dir/state" 10000
```

将构建参数换为 `browser` 并运行 `probe-browser.mjs`，可复现 `EventTarget` 失败。1.49 MB 是这个包含兼容层和探针的独立压缩 JS bundle 大小，不能当成实际 App 的增量包体。

## 公共核心如何替换现有代码

调用方直接使用 SDK 提供的有状态会话类。一个 `RealtimeSession` 对应当前连接，transport 持有该连接的供应商协议状态；继续由 `VoiceRuntime` 决定唤醒、试听和待机。无需再为 SDK 包一套工具调度器。

```ts
const agent = new RealtimeAgent({ name: "LOOI", instructions, tools });
const session = new RealtimeSession(agent, { transport, tracingDisabled: true });
session.on("audio", onAudio);
session.on("history_updated", onHistory);
session.on("error", onError);
await session.connect({ apiKey });
```

| 现有模块／职责 | 采用 SDK 后的归属与收益 |
|---|---|
| `voice/tools/index.ts` 注册、名称分派、同连接 call 去重 | 由 `RealtimeAgent` 的工具定义与 `RealtimeSession` 执行；删除重复公共调度逻辑 |
| 对话历史、相同消息的转写修订 | SDK 本地 history 与 `item_update`；transport 生成稳定 itemId |
| `LiveVoiceSession` 内协议握手、工具回执和取消时序 | 归各 provider transport，供应商差异集中在连接边界 |
| `VoiceAudioPipeline` 的采播节拍、队列、播放身份与进度 | 保留；它掌握真实播放状态，SDK 没有对应信息 |
| `VoiceRuntime` 的 KWS、麦克风权限、前后台、12 秒待机与试听 | 保留 App 生命周期；这些决策由产品交互决定 |
| `VoiceTaskCoordinator`、Pi 执行与任务改口／取消 | 保留任务生命周期及空闲通知；SDK 接收工具请求与回执 |
| Langfuse 观测 | 将 SDK 事件接入现有记录，继续记录原生播放和供应商原始失败 |

SDK 的工具调用去重可能重新发送已缓存结果，transport 仍需保证重复回执不会重复触发续答。它阻止旧连接的工具结果写入新连接，这能替代相应的公共竞态处理。[会话与调用实现](https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/packages/agents-realtime/src/realtimeSession.ts)

## 三家 transport 的具体接法

### OpenAI

优先复用内置 `OpenAIRealtimeWebSocket`，用 `createWebSocket` 接 App 自有原生 socket。原生连接函数返回时已经建连，可采用 `skipOpenEventListeners`；事件监听、读循环、鉴权头和关闭仍由接入代码接好。本次探针验证了注入与序列化，未验证真实 TLS／鉴权。[官方 WebSocket 扩展说明](https://openai.github.io/openai-agents-js/guides/voice-agents/transport/)

`react-native` shim 的环境判断沿用 browser 实现；内置 WebSocket 因而要求临时 `ek_` key，或显式设置 `useInsecureApiKey` 才接受 App 自有的常规 API key。原生 socket 注入不会绕过这项客户端检查。探针使用虚构的 `ek_offline_fixture`，真实凭证路径需按 App 的现有凭证模型接入。[连接前检查](https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/packages/agents-realtime/src/openaiRealtimeWebsocket.ts)

其默认打断使用“首次音频至当前的墙钟时长”，并以已收到的音频时长封顶，估算 `conversation.item.truncate` 的位置。现有播放器可能缓存数秒，接入时应使用原生实际已播进度。源码提供受保护的 `_interrupt(elapsedTime, cancelOngoingResponse)` 扩展点，可在子类里连接已有播放账本，避免 fork 上游。静音也由 App 控制采集或上传。[WebSocket 中断实现](https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/packages/agents-realtime/src/openaiRealtimeWebsocket.ts#L741)

### 豆包

实现 `RealtimeTransportLayer`，复用现有 Seeduplex 编解码和原生 WebSocket。`sendFunctionCallOutput(call, output, startResponse)` 是统一工具结果出口：豆包按自身协议提交结果并由服务端续答，不必发送 OpenAI `response.create`。`startResponse=false` 仅代表客户端不主动请求回复，无法据此断言服务端不会自动说话。

### MOSS

同样实现自定义 transport，复用现有编解码；不从 OpenAI transport 继承后仅替换 URL。内置 OpenAI transport 会在自身 VAD 语义下处理打断，而 MOSS 的活动通知和明确停播是不同事件。

| MOSS／原生事件 | 接入处理 |
|---|---|
| `input.speech.started/stopped` | 更新收音活动；不映射成 `audio_interrupted` |
| `response.audio.context` + binary | 保存 run／turn／chunk 关联，再交 PCM 给原生播放器 |
| `response.audio.stop`／`response.interrupted` | 中断对应原生音频队列，向 Session 发 `audio_interrupted`，保留原因 |
| `response.audio.done` | 可发 SDK `audio_done`，只表示该轮生成音频结束 |
| 原生片段播完／整轮排空 | transport 根据已有账本发送 `playback.chunk.completed`／`playback.completed` |
| `response.ended` | 发 `turn_done`；失败状态另发 error 并记录底层码与原因 |
| 工具结果 | transport 提交结果，收到 MOSS 服务确认后再按其规则续答 |

Session 的普通工具结果通过 `transport.sendFunctionCallOutput` 提交，因此 MOSS 的“等待确认再续答”可在 transport 内异步实现，无需修改 Session。原生播放回执与服务终态仍共同决定何时结束试听或回待机。[工具提交实现](https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/packages/agents-realtime/src/realtimeSession.ts#L1369)、[已有 MOSS 实测](moss-home-realtime-e2e-2026-11-14.md)

## 接口中需要保留的细节

### 音频事件没有完整播放账本

标准 `audio` 的字段是 `{ data: ArrayBuffer, responseId }`，没有 turn／chunk／item 身份；`audio_done`、`audio_interrupted` 没有参数，也没有向 SDK 回传实际播放完成的标准方法。因此已有音频账本必须留在 transport 与原生桥接边界，播放进度不能从 `audio_stopped` 推导。多个音频片段如何归属、被打断后如何清队列，都应由掌握这些身份的实现处理。[事件契约](https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/packages/agents-realtime/src/transportLayerEvents.ts#L99)

`connect()` 返回 Promise，而 `sendAudio`、工具结果提交、`close()` 等接口返回 void，没有通用 flush（排空）接口。transport 需维护发送顺序，正常关闭前完成最终播放回执；异步写入失败通过 error 事件进入现有执行记录。[transport 契约](https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/packages/agents-realtime/src/transportLayer.ts#L58)

### Session 仍有 OpenAI 数据形状

供应商适配需遵守的几个已核实约定：

- `turn_started` 的 response ID 从 `providerData.response.id` 提取，并非顶层 `responseId`；工具通知必须带非空 `responseId`。
- raw `*` 事件对 OpenAI 用户转写完成有特殊处理；MOSS 转写修订应直接生成标准 `item_update`。
- session config 包含 OpenAI 形状的 audio、turnDetection、tracing 等字段；transport 只转换本 provider 支持的配置。采用现有 Langfuse 时可禁用 SDK tracing。
- 若使用文本 output guardrail，Session 会发 OpenAI `response.cancel`；MCP 续答在缺少 `requestResponse` 时会退到 `response.create`。自定义 transport 的 `sendEvent`／`requestResponse` 需要转换相应语义。当前产品无需为了接入而增加这两项能力。
- `turn_done` 不提供标准 completed／cancelled／failed 结果状态；`agent_end` 不能当作工具或会话成功。失败原因通过 error、历史状态及现有诊断事件保留。

这些是适配成本，没有发现当前所需普通工具／音频路径必须 fork SDK 的证据。[Session 源码](https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/packages/agents-realtime/src/realtimeSession.ts)

### 后台任务与错误处理

`backgroundResult` 只是包装工具返回内容。Session 仍先等待 `execute()` 完成，再以 `startResponse=false` 交给 transport。它没有持久任务、跨连接交付、任务查询／改口／取消或 WHEN_IDLE 通知队列。探针还确认关闭后旧工具结果被丢弃，因此不能用它替换 `VoiceTaskCoordinator`。[包装定义](https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/packages/agents-realtime/src/tool.ts#L22)

默认 `tool()` 错误处理返回固定泛化文本，会丢失项目要求的失败原因。接入应为项目工具配置 `errorFunction`，序列化 stage、底层 code、message 和 cause，同时写入既有追踪；只移除凭据。探针已验证该回调拿到原始错误。`RealtimeSession.toolErrorFormatter` 在本类中用于工具审批拒绝文本，不能替代普通执行错误的 `errorFunction`。[默认工具错误实现](https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/packages/agents-core/src/tool.ts#L1745)

## 依赖成本与下一项验证

研究安装了 `@openai/agents-realtime@0.22.0`、其公共 core 和 Zod，临时目录共解析 29 个包。正式采用时只需要实时入口及实际使用的直接依赖；没有理由额外引入完整 `@openai/agents` 聚合入口。收益是减少自有通用调度、历史和调用竞态代码；成本是依赖升级、SDK 条件导出接线、三家 transport 及原生播放扩展的维护。它不消除 provider 语义差异，但给出了可复用且已能运行的公共核心。

下一项有决策价值的验证是把 SDK 接进现有 App 原生音频／socket，先跑 MOSS 已保存的长回复、讲话活动与明确打断、家居工具和后台任务回播，再用相同场景覆盖豆包与 OpenAI。验收要同时看到实际播放进度、工具回执、最终服务状态及待机恢复；仅 bundle 成功或模拟事件通过不能替代这次 E2E。正式测试可复用上游已发布的 `@openai/agents-realtime/testing` 中的 `ScriptedRealtimeTransport`，减少自有事件脚本设施。[测试入口清单](https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/packages/agents-realtime/package.json)
