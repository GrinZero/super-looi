# `PiAgentExecutor` 模块化重构方案（Phase 1：纯结构解耦）

## 1. 问题诊断与复杂度审视

### 1.1 `packages/looi-runtime/src/agent/pi-executor.ts` 的现有耦合痛点

当前 [`PiAgentExecutor`](../../packages/looi-runtime/src/agent/pi-executor.ts) 单文件 1,147 行，在一个执行器类内部混合了 5 类生命周期、依赖与修改原因完全不同的职责：

1. **任务准入与并发调度态（Executor Admission & Concurrency）**：`run()` 中的任务幂等校验、同 `sessionId` 并发互斥与未知状态（`unknown`）阻断、工作区一致性校验、`workers` 并发容量控制与 `close()` 统一回收。
2. **会话持久化与模型网关解析（Session Transcript & Model Stream Resolution）**：`loadSessionMessages()` / `saveSessionMessages()` 的原子 JSON 文件读写，以及 `createModelAndStream()` 对 `modelsRegistry`、环境变量与默认 OpenAI Gateway Provider 的三路分支组装。
3. **人机交互挂起与 UI 防重放门控（Interaction & Approval Replay Gate）**：`waitForInteraction()` 的挂起 Promise 与超时取消、`respond()` 的应答校验，以及 `consumedApprovalActions` 的 31 秒滑动窗口防重放账本。
4. **本地工作区工具集与子进程管理（Workspace Coding Tools & Shell Lifecycle）**：`buildTools()` 280 行内联实现的 `read_file`、`write_file`、`bash`（含 `/bin/sh` 进程组派生、`StringDecoder` 双流 UTF-8 尾部截断、超时与 `SIGTERM` 清理追踪）以及文件 SHA-256 产物账本（`recordArtifact`）。
5. **单次任务执行生命周期（Single-Task Runner Lifecycle）**：`execute()` 与 `cancel()` 围绕裸 `interface Worker` 维护的 `Agent` 实例、步数/工具预算熔断、Langfuse Span 追踪、截止时间定时器与优雅停止宽限期（`stopGraceMs`）。

### 1.2 设计模式取舍审视（遵循 Deep Module 原则）

| 候选模式 / 模块 | 具体用途 | 复杂度成本与取舍结论 |
| :--- | :--- | :--- |
| **一次性任务运行器（`PiTaskRunner`，Disposable Task Object 模式）** | 替代裸 `interface Worker`，每次 `run()` 实例化独立的 `PiTaskRunner` 承载单次任务的 `Agent` 循环、Shell 句柄集合、交互挂起槽位、预算计数、Langfuse 追踪与 `cancel()` 宽限期收敛 | **引入**。直接消除跨私有方法传递 `(task, worker, executions, artifactsMap, emit)` 的胶水参数，将单次任务的瞬态生命周期物理封装在独立对象内。 |
| **交互与审批防重放门控（`InteractionGate` + `ApprovalActionReplayGuard`）** | 封装单任务的 `awaiting_approval` / `awaiting_input` 挂起、超时自动取消及跨任务的 `UserActionRef` 31 秒防重放校验 | **引入**。把 Promise 结算定时器、信号解绑与 UI 令牌防重放校验收敛到内聚模块，为 Phase 2 区分 UI 物理审批与 Realtime 语音问答提供清晰接缝。 |
| **内聚工作区工具集与产物账本（`createWorkspaceCodingTools` + `WorkspaceArtifactTracker`）** | 封装 `read_file`、`read`、`write_file`、`bash`、`ask_user_question` 及工作区产物 SHA-256 采集 | **引入**。将 `node:child_process` 进程组管理、`StringDecoder` 流解码和符号链接安全扫描从执行器主逻辑剥离，为 Phase 2 按任务 Profile 切换工具集扫清障碍。 |
| **会话消息存储与模型流解析器（`SessionTranscriptStore` + `resolvePiModelAndStream`）** | 封装 `${sessionId}.json` 原子读写与 `Model<Api>` / `StreamFn` 解析 | **引入**。将文件 I/O 与 `pi-ai` Provider 构造细节从调度类中隔离，保持窄接口。 |
| **多层抽象 Factory / 进程内 EventBus** | 为工具或步骤事件引入发布订阅总线或抽象工厂类层次 | **不引入**。`beforeToolCall` 审批拦截与 `cancel()` 的 `waitForIdle()` 依赖严格同步/异步返回链，引入事件总线会削弱确定性并产生浅模块样板代码。 |

---

## 2. 模块边界与目录结构

```text
packages/looi-runtime/src/agent/
├── executor.ts          # 对外接口契约（AgentExecutor / AgentTask / AgentRunOptions 等，保持不变）
├── pi-executor.ts       # PiAgentExecutor 外观与准入调度器：管理任务准入、会话互斥、活跃 PiTaskRunner 映射与统一关闭
├── pi-task-runner.ts    # PiTaskRunner：单次任务的 Agent 生命周期、预算熔断、Langfuse 追踪、错误脱敏与优雅停止
├── workspace-tools.ts   # createWorkspaceCodingTools & WorkspaceArtifactTracker：文件读写、Shell 子进程监督与产物哈希采集
├── interaction-gate.ts  # InteractionGate & ApprovalActionReplayGuard：交互挂起/超时结算与 UI 审批令牌防重放校验
├── session-store.ts     # SessionTranscriptStore：会话历史 JSON 原子加载与持久化
└── model-resolver.ts    # resolvePiModelAndStream：模型规格与 StreamFn 三路解析
```

---

## 3. 实施与验证步骤

### Step 1：提取底层职责模块
- 创建 [`session-store.ts`](../../packages/looi-runtime/src/agent/session-store.ts) 与 [`model-resolver.ts`](../../packages/looi-runtime/src/agent/model-resolver.ts)。
- 创建 [`interaction-gate.ts`](../../packages/looi-runtime/src/agent/interaction-gate.ts)，封装 `ApprovalActionReplayGuard`（跨任务 31s 防重放窗口）与单任务 `InteractionGate`（挂起、超时、取消结算）。
- 创建 [`workspace-tools.ts`](../../packages/looi-runtime/src/agent/workspace-tools.ts)，封装 `WorkspaceArtifactTracker`、Shell 进程组生命周期跟踪与内置工具构造。

### Step 2：实现 `PiTaskRunner` 并收敛 `PiAgentExecutor`
- 创建 [`pi-task-runner.ts`](../../packages/looi-runtime/src/agent/pi-task-runner.ts)，收敛单次任务的 `Agent` 组装、`beforeToolCall`/`afterToolCall`、步数/工具预算、Langfuse 观测与 `cancel()` 逻辑。
- 重构 [`pi-executor.ts`](../../packages/looi-runtime/src/agent/pi-executor.ts) 为准入控制与 `PiTaskRunner` 调度器，对外导出符号与行为保持 100% 兼容。
- 同步更新 [`docs/arch/architecture.js`](../../docs/arch/architecture.js) 并重生成 `docs/arch/sources.js`。

### Step 3：回归验证与独立 Review
- 运行 `@super-looi/runtime` 单测（`agent-approval`、`agent-conversation`、`agent-shell`、`agent-stop`、`langfuse-telemetry`、`llm-providers`）、`@super-looi/nsh-node-compat` QuickJS 套件与全仓 `pnpm typecheck`。
- 调用子 agent 进行独立代码审查，确认无回归后更新 `progress.md` 并提交。
