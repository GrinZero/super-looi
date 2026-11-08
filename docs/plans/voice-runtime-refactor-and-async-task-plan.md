# `VoiceRuntime` 模块化重构与 `run_agent_task` 异步协同升级方案

## 1. 问题诊断与复杂度审视

### 1.1 `apps/nsh/runtime/voice/runtime.ts` 的现有耦合痛点

当前 [`VoiceRuntime`](../../apps/nsh/runtime/voice/runtime.ts) 单文件 672 行，在一个应用级长生命周期实例上挂载了 27 个可变字段，混合了四种生命周期完全不同的状态：

1. **跨会话持久配置态**：`Vault` 读写容错、多厂商 `apiKeys` 与 `"model"` 槽位回退、豆包 `voiceId` 校验、`wakeEnabled` 开关持久化。
2. **设备级唤醒与权限态**：麦克风权限轮询（`permission`）与本地 sherpa-onnx KWS 60ms 监听循环（`standby`）。
3. **单次 WebSocket 会话控制态**：连接超时、串行有界发送队列（`writeQueue` / `writes`）、响应取消账本（`cancelledResponses` / `discardOutput`）、回合活动状态（`turnActivity`）与 12s 自动休眠定时器（`idleTimer` / `awaitingTimer`）、会话语言跟随。
4. **20ms 实时声学缓冲与截断记账态**：16kHz 采集帧环形队列、24kHz 下行 PCM 4800B 切片与 30s 溢出保护、原生 4.5s 播放队列背压、RMS 峰值电平计算、打断截断所需的已播毫秒账本（`playedByItem`）。

**直接修改痛点**：
- 由于单次连接状态直接挂在全局单例 `this` 上，`endSession()` 与 `stop()` 各复制了一份 20 行的手动字段重置逻辑，且所有内部异步回调必须携带 `generation` 编号防御旧连接污染新连接。
- [`VoiceRuntime.endSession()`](../../apps/nsh/runtime/voice/runtime.ts) 无条件调用 `cancelTask()`，且 [`store.ts`](../../apps/nsh/store.ts) 通过单工锁阻塞语音任务，导致超过 10 秒的 Coding 或多步 Agent 任务无法在语音会话挂断后存活，也无法在对话空闲窗口（`WHEN_IDLE`）主动回推结果。

### 1.2 设计模式取舍审视（拒绝过度设计与浅模块拆分）

| 候选模式 / 实体 | 具体用途 | 复杂度成本与取舍结论 |
| :--- | :--- | :--- |
| **GoF State 类族（按 7 个 `phase` 拆分子类）** | 将 `idle`、`standby`、`listening`、`speaking` 拆成独立类 | **不引入**。`listening` 与 `speaking` 共享同一条 WebSocket、写队列和 PCM 播放缓冲池，拆成独立类会导致 20 个共享状态字段跨类传递（浅模块），增加阅读跳转却不隐藏任何复杂性。 |
| **通用进程内 `EventBus`（事件总线）** | 用发布订阅解耦协议、音频、工具回调 | **不引入**。`endSession()` 依赖“等待当前 PCM 帧写完后再发 `session.close`、同步结束 Langfuse 根 Span 后再关 Socket”的严格异步时序，隐式事件总线会破坏确定性顺序。 |
| **Disposable Session Object（一次性会话实例 `LiveVoiceSession`）** | 每次 `start()` 实例化独立对象承载单次 WebSocket 连接全生命周期，挂断即 `dispose()` 并丢弃引用 | **引入**。直接消除 20 个字段的重复重置代码与跨方法传递的 `generation` 校验；旧连接滞后的 `write` 拒绝或晚到工具回执因持有已销毁实例引用而自然失效。 |
| **内聚声学缓冲管道（`VoiceAudioPipeline`）** | 封装上下行 PCM 队列、30s 上限、RMS 计算与打断已播时长记账 | **引入**。纯同步内存计算，零定时器与网络依赖；隐藏 6 个声学记账结构与采样率字节换算（`pcm.length / 48`），消除 3 处重复清空代码，支持独立测试。 |
| **凭证配置存储（`VoiceCredentialStore`）** | 封装 `"voice"` 与 `"model"` 槽位解析、旧字段兼容与格式校验 | **引入**。将跨会话持久化逻辑与实时连接逻辑物理隔离，保持窄接口。 |
| **自适应快路径 + 后台晋升协调器（`VoiceTaskCoordinator`）** | 统一协调短任务同步直返、长任务超时转后台、状态查询/取消及 `WHEN_IDLE` 通知回推 | **引入**。把任务计时晋升、步骤快照与通知去重收敛在单一模块内，避免向 `store.ts` 散落定时器和状态位。 |

---

## 2. 双协议主动播报（`WHEN_IDLE`）实测依据

针对后台任务完成后在无未决 `call_id` 状态下主动触发语音播报的场景，基于仓库凭证对豆包 Duplex V3（`wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`，模型 `1.2.6.1`）实测结果如下：

1. **豆包 Duplex V3**：
   - 单独发送 `response.create` 返回 `45000000: unknown event name`。
   - 单独发送无 `call_id` 的 `conversation.item.create`（`role: "user"`）不触发服务端生成响应（`audioBytes = 0`）。
   - 发送 `session.update`（将最新后台任务回执写入 `instructions` 供后续追问）配合 `{ "type": "speech_text_buffer.commit", "text": "<口语播报文本>" }`，服务端依次返回 `session.updated` -> `response.output_audio.started` -> 24kHz PCM 音频流（实测单句返回 240,054 字节，约 5.0 秒）-> `response.output_audio.done` -> `response.done`。注意该路径不返回 `response.output_text.done`，客户端需在发出 `speech_text_buffer.commit` 时同步更新本地字幕 `transcript`。
2. **OpenAI Realtime**：
   - 支持可选 `session.update` 更新上下文后，发送 `conversation.item.create`（`item: { type: "message", role: "user", content: [{ type: "input_text", text }] }`）+ `response.create` 触发模型自然口语汇报。

上述协议差异统一收敛在 [`RealtimeProtocolAdapter.encodeProactiveSpeech`](../../packages/looi-runtime/src/voice/realtime-protocol.ts) 接口内部，会话层无需感知厂商分支。

---

## 3. 模块边界与接口设计

### 3.1 `apps/nsh/runtime/voice/` 拆分结构

```text
apps/nsh/runtime/voice/
├── runtime.ts           # 外观与设备级监督器：管理 idle / permission / standby 及当前活跃 LiveVoiceSession 槽位
├── credentials.ts       # VoiceCredentialStore：Vault 凭据、model 槽位回退、voiceId 与 wakeEnabled 持久化
├── audio-pipeline.ts    # VoiceAudioPipeline：纯同步上下行 PCM 缓冲、背压切片、RMS 与截断毫秒账本
├── live-session.ts      # LiveVoiceSession：单次 WebSocket 会话实例、写队列、回合门控、WHEN_IDLE 播报队列
├── task-coordinator.ts  # VoiceTaskCoordinator：短任务快路径直返、长任务后台晋升、状态查询与完成通知生成
├── prompts.ts           # 实时语音系统提示词与后台上下文附注拼装
├── protocol.ts          # RealtimeProtocolAdapter 重导出与默认构造
├── types.ts             # 对外端口、状态快照与任务协调契约定义
└── tools/
    ├── index.ts             # 会话级工具注册与去重分发
    ├── run-agent-task.ts    # 支持快路径直返与 running_in_background 晋升的任务提交工具
    ├── manage-agent-task.ts # 后台任务进度查询（status）与主动中止（cancel）工具
    ├── control-looi-body.ts # 低延迟底座动作控制工具
    └── types.ts             # 工具上下文契约
```

### 3.2 `run_agent_task` 升级契约对比与选型

比较两种调用契约：
- **方案 A（纯异步投递）**：每次 `run_agent_task` 均在 10ms 内返回 `{ status: "started", taskId }`，结果一律走后续主动播报。缺点是 1~2 秒即可完成的家居开关或记忆写入会被拆成“正在执行”+“执行完毕”两轮语音，延迟与音频开销翻倍。
- **方案 B（自适应快路径 + 后台晋升，采用）**：
  - `taskCoordinator.submit(prompt, { waitMs: 2500, traceContext })` 启动独立于语音会话的任务：
    - 若在 `2500ms` 窗口内完成：直接通过当前 `call_id` 返回 `{ status: "completed", taskId, answer }`，单轮直接作答。
    - 若超过 `2500ms` 仍在运行：立即通过当前 `call_id` 返回 `{ status: "running_in_background", taskId, latestSummary }`，释放当前语音轮次；模型告知用户已转入后台处理，会话可继续闲聊或在静默 12 秒后正常退回本地 `standby` 待机（**`endSession()` 不再取消已转入后台的任务**）。
  - 搭配轻量工具 `manage_agent_task({ action: "status" | "cancel", task_id? })`，支持对话中随时读取最新步骤摘要（`latestSummary`）或取消后台任务。
  - 当后台任务产生待审批交互（`interaction`）或最终结束（`completed` / `failed`）时：
    - 更新语音上下文附注（`contextNotes`），确保用户后续追问结果细节时模型有据可查；
    - 生成精简口语通知投入 `VoiceRuntime.enqueueNotice(...)`：
      - 若当前处于活跃 LIVE 会话：由 `LiveVoiceSession` 的回合门控在安全空闲窗口（`phase === "listening" && turnActivity === "waiting_user" && !responseInProgress && !discardOutput && !tools.busy && audioPipeline.isDrained`）自动调用 `encodeProactiveSpeech` 开口汇报；
      - 若当前已退回 `standby` / `idle`：不主动在无唤醒时外放重连云端，仅保留最新上下文附注供下次唤醒对话备查，同时前台状态栏、任务空间与表情（后台运行且非语音态显示 `"thinking"`）实时反映进度。

---

## 4. 分阶段实施与验证步骤

### Step 1：`VoiceRuntime` 纯结构解耦重构（保持行为 100% 兼容）
- 提取 `credentials.ts`、`audio-pipeline.ts`、`live-session.ts`，收敛 `runtime.ts` 为设备级状态协调器。
- 预置 `LiveVoiceSession` 的空闲窗口门控钩子，不改变任何存量对外 API。
- 运行 `pnpm --filter @super-looi/nsh test` 与 `pnpm --filter @super-looi/nsh typecheck`，确认既有豆包、唤醒、OpenAI、Langfuse 追踪与底座测试全部零回归通过后独立提交。

### Step 2：双协议主动播报、`VoiceTaskCoordinator` 与 `run_agent_task` 异步升级
- 在 [`packages/looi-runtime/src/voice/realtime-protocol.ts`](../../packages/looi-runtime/src/voice/realtime-protocol.ts) 新增 `encodeProactiveSpeech`（豆包 `session.update` + `speech_text_buffer.commit`；OpenAI `session.update` + `conversation.item.create` + `response.create`）。
- 实现 `task-coordinator.ts`、`manage-agent-task.ts`，升级 `run-agent-task.ts` 与 `prompts.ts`。
- 更新 [`apps/nsh/store.ts`](../../apps/nsh/store.ts) 与 [`apps/nsh/scripts/build-runtime.ts`](../../apps/nsh/scripts/build-runtime.ts)：接入 `VoiceTaskCoordinator`，解除语音 `endSession()` 对后台长任务的强制取消，并修正并发状态下语音表情（`speaking` / `listening`）高于后台 `thinking` 的优先级。
- 新增 `apps/nsh/tests/voice-async-task-cases.ts`，覆盖：
  1. `<2.5s` 快任务单轮同步返回且不重复触发主动播报；
  2. `>2.5s` 慢任务自动晋升 `running_in_background`、`manage_agent_task` 查询进度与取消；
  3. 语音 12s 自动休眠（`endSession`）不中断后台任务；
  4. 说话/播报途中完成的后台任务严格等待 `WHEN_IDLE` 排空后再触发主动播报（覆盖豆包与 OpenAI 双协议路径）及审批交互提醒。

### Step 3：全量验证与独立复审
- 执行全仓 `typecheck`、`test` 与 NSH `build`，实测豆包 Duplex V3 协议帧序列。
- 调用独立子 agent 对模块边界、状态生命周期、错误处理与测试覆盖做代码复审，闭环后提交。
