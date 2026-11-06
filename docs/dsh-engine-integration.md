# 官方 DSH 引擎接入

日期：2026-11-05。承接 [复用调研](dsh-engine-reuse-research.md)。本轮将 Hub 的生产任务入口改为官方执行引擎，删除自研 `MinimalAgentLoop`，没有 fork 或复制官方 Agent Loop。

## 已落地的执行链

```text
HTTP / Duplex / Modular LLM
        ↓ AgentExecutor
DshAgentExecutor（每任务独占 worker / session）
        ↓ @deepseek-ai/dsh-sdk-client 0.2.2-rc.1
官方 DSH sdk profile 0.2.2-rc.1
        ├─ 官方文件 / bash 工具
        ├─ 官方 MCP client → Hub 的个人记忆服务
        └─ Cordis tools/execute 扩展 → 命令退出回执
```

Node 必须为 `>=24.9.0`；当前实测 `24.14.0`，包管理器 `pnpm 9.15.9`。DSH/runtime/SDK 固定同版，MCP SDK 固定 `1.29.0`。完整依赖图写入 `pnpm-lock.yaml`，OpenTelemetry API 固定 `1.9.0` 以满足该运行时依赖的 peer 范围。原来非 Hub 的 importer、已有 package/snapshot 语义保留；没有升级移动端依赖或修改 Expo 原生产物。

`apps/hub/src/agent/executor.ts` 是产品接口。`dsh-executor.ts` 管启动、事件转换、交互、预算与退出；实际模型调用、工具选择和循环全部在官方子进程。`receipts-plugin.ts` 是 Cordis around-dispatch 扩展，调用官方 `next()`，只提取原生 bash canonical result 的退出信息，不重新执行命令，也不解析模型输出中的“完成”或 stdout 文案。

## 配置与启动

Hub 入口从仓库根 `.env` 加载配置，沿用 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`；SDK 使用 `looi` provider route，OpenAI Chat Completions 协议。模型推理仍由该网关提供。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm hub
```

可选环境变量见 `.env.example`：

- `DSH_WORKSPACE_ROOT`：默认 `data/agent-workspace`。相对路径以 Hub 进程 cwd 解析，不默认为整个代码仓库。
- `DSH_STATE_DIRECTORY`：默认 `data/dsh`，保存任务快照、独立 DSH homes 与会话历史。
- `SEED_DEMO=1`：显式开启旧演示数据；默认关闭。演示状态不构成真实执行证据。

Hub 的个人记忆和产品任务账本默认在正常服务启动时持久化；`buildApp` 的单元测试默认不保存这两项，测试可明确注入自己的执行器和临时目录。

每任务上限：180秒、12个模型步骤、32次工具调用；每次模型输出上限2048 tokens，最多同时2个worker。用户交互等待120秒后撤销。配置接口可调整这些限制；没有把 SDK 的 RPC timeout 当成停止执行的证据。超限进入关闭流程，不自动重新发起可能产生副作用的任务。

## 状态、交互与恢复 API

兼容的 `POST /api/agent/run` 仍返回 `answer / steps / toolCallsCount / durationMs`，另含 `taskId / sessionId / finishReason / runtimeExited / executions / artifacts`。该接口等待任务终态；需要审批、重连或后台查看时，使用异步接口：

| 请求 | 作用 |
| --- | --- |
| `POST /api/agent/tasks` `{prompt, taskId?, mode?}` | 入队并立即返回202；同 id 同请求不重复执行，不同请求返回409 |
| `GET /api/agent/tasks` | 任务快照列表 |
| `GET /api/agent/tasks/:id` | 状态、步骤、待审批/问题、结果或错误 |
| `POST /api/agent/tasks/:id/respond` `{requestId, answer}` | 应答当前交互；过期或错误 id 拒绝 |
| `POST /api/agent/tasks/:id/cancel` | 关闭独占worker并返回真实确认范围 |
| `POST /api/agent/tasks/:id/resume` `{prompt}` | 明确继续一个持久会话；不自动重放旧请求 |

审批答案是 `{outcome:"allowed-once"}` / `rejected` / `cancelled`。问题答案沿用官方 `{answers:[{id,selected,custom?}]}` 或 `{cancelled:true}`。没有应答或连接消失不代表同意。工具并行数设置为1，交互槽有额外并发保护。

手机与 Hub Web 的 `agent_status` 带任务 id 和交互信息。手机提供确认/拒绝、选择与补充回答弹层、停止任务按钮；Web 提供确认/问题应答及独立停止按钮。WebSocket 的 `agent_response` 与 `agent_cancel` 对应上述操作。`barge_in` 只打断口播；关闭手机连接不自动取消工作。

Modular LLM 注入同一个执行器；其状态回调关联当前任务。Duplex 转写兜底只在 Duplex 路径生效，避免一份转写重复执行。Modular 的默认 ASR/TTS 仍是既有测试实现，本轮没有把它们改成新的真实语音服务。

`POST /api/tasks` 对已注册 workspace 的生产力任务实际调用 DSH；默认注册 `default` workspace。未注册工作区明确拒绝。旧高危命令 ActionGrant 仅在显式批准、匹配原命令/任务/工作区且未过期时消费一次；旧 approve 路由会继续对应命令。官方运行时自己的审批走新的 `respond`，两者不是同一个授权。

生产力任务的恢复使用 `POST /api/tasks/:id/resume`，同步产品任务账本。不能从 agent 的恢复路由单独恢复它并遗留旧账本。Hub 重启后原 running/awaiting/cancelling 任务均转 unknown，撤销旧 grants；后续只由显式恢复发起新一轮，不静默重试副作用。

## 完成与取消的判定

`finishReason=completed` 只代表模型活动完成。生产力 runner 还要求：

1. 指定命令有匹配原命令、callId、官方 tool/call 与成功 tool/result 的 canonical bash 退出回执；exitCode必须0，未超时/中断。
2. 通用任务至少有真实命令退出回执或观察到的工作区文件读回。文件探针使用真实路径、大小、SHA256，拒绝工作区外路径和不可读文件。
3. 模型拒绝执行、零工具调用、非零退出或无验证证据，都不会签发成功回执。

文件 SHA只证明文件读回状态，既有输入文件不因此变成本任务新产物；通用自然语言任务的预期产物和业务验收规则仍需单独声明，不能把任意观察文件当成业务目标已满足。

命令回执来自同用户的受信 DSH worker，使用私有 loopback capability、关联 SDK 事件并拒绝冲突回执。它提升执行可追溯性，**不构成对恶意 shell/同用户进程的操作系统隔离证明**。模型完成一般对话的状态也不代表每条内部命令都成功；调用方应按 `executions` 或生产力任务验证结果解释。

取消先撤销产品工具 capability，停止等待交互，调用官方 SDK `close()`。只有运行时退出且没有未确认 shell 操作时才确认 cancelled；无法核实 shell、后台或远端进程时返回 unknown。取消与成功通过关闭后的终态检查仲裁，不能同时发 done 和确认取消。已经结束的任务不被重写为取消成功。

## 验证证据

真实 `.env` 模型验证：[`runtime-verification.json`](artifacts/dsh-integration/runtime-verification.json)。`pnpm --filter @super-looi/hub verify:dsh` 在临时目录、独立记忆存储中执行；不操作实际家居或LOOI。8项包括 bash真实退出、文件SHA读回、MCP记忆写入、跨进程session恢复、记忆重载、原生用户问题、原生审批拒绝及长命令取消。最后一项诚实返回 `runtimeExited=true / state=unknown`。

自动化回归包括：幂等/恢复、错误终态、审批与问题匹配、取消关闭竞态、入队到启动之间的abort、零工具/非零退出不得验证成功、重启任务未知态与去重。全仓 typecheck、test（contracts 5、driver 11、Hub 82、mobile 126，共224项）、build 均通过。React Doctor 相对调研提交 `a4983bc` 的3个改动文件无新增诊断；全量旧代码评分不作为本次通过依据。

iOS `iPhone 17 Pro` 模拟器复用已有开发构建，实际渲染了 [问题弹层](artifacts/dsh-integration/ios-question.png) 与 [审批弹层](artifacts/dsh-integration/ios-approval.png)。使用临时开发路由进行组件显示核验，核验后已删除该路由、回到首页；没有修改原生代码。此证据是显示核验，原生问答/审批协议另由真实模型探针验证。

## 后续边界

- 正式对不可信项目/多人服务开放前，需要专用执行身份或容器，以及 Hub 身份与任务级授权。过滤环境变量和独立目录不会阻止同用户进程读取 Hub `.env`。
- 外部 SSH/job 的终止证据尚未接入；没有此证据时保持 unknown。
- 个人记忆 `forget` 当前不会级联删除已存在的 DSH会话、附件和备份；敏感证据自动外发前需补 outbound manifest 与删除链路。
- JSON账本由单Hub进程拥有；跨进程高可用、租约与数据库事务未实现，不应同时启动两个Hub写同一状态目录。
- 家居和本体工具继续使用现有服务。本轮接入记忆MCP，不新增未经硬件验证的设备执行器。
