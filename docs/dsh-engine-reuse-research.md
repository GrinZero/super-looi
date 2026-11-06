# 官方 DSH 执行引擎复用调研

调研日期：2026-11-05（Asia/Taipei）。官方源码快照：`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。本报告把源码事实、发行包验证、接入建议分开记录；读到源码不代表已安装或已与本项目联调。

## 1. 结论与推荐边界

建议由 Hub 通过官方 TypeScript SDK 启动完整 DSH 子进程，替换本项目手写 `MinimalAgentLoop`。保留 React Native / Expo、实时语音、个人记忆与设备服务，把它们作为产品层；DSH 负责模型—工具执行循环、文件与 shell 工具、任务内上下文和会话持久化。官方 SDK 是进程外客户端，不是可嵌入的简化 ReAct 循环。SDK 构造参数也不提供直接传入 Hub 工具函数的 `tools` 回调。[R1][R2]

```text
Mobile（React Native / Expo、音频、BLE）
                ↕ 现有 Hub HTTP / WebSocket
Hub（任务账本、语音桥、事件映射、记忆与设备服务）
                ↕ 官方 SDK / stdio JSON-RPC
DSH worker（sdk profile + 本项目 patch + 官方工具）
                ↕ Cordis 工具插件调用 Hub 窄 API，或 MCP
记忆 / Home Assistant / LOOI 的产品服务
```

建议以 **`@deepseek-ai/dsh` + `@deepseek-ai/dsh-sdk-client` 同版本 `0.2.2-rc.1`** 作为下一轮 PoC 候选：本轮已在隔离目录通过启动及真实模型读取临时文件的闭环，但审批、shell 写入、插件和取消尚未联调，不能视为生产依赖已锁定。具体证据见第10节。

这是接入建议，尚未替换运行代码。当前 `DshWorkspaceRunner` 的模拟执行不能当成已接入官方 DSH 的证据。

## 2. 可复用的官方入口

以下行为按固定源码快照核查，发行包是否包含同一能力需单独确认。[R1][R3][R4][R5]

| 方式 | 官方边界 | 本项目用途判断 |
| --- | --- | --- |
| TypeScript SDK + `sdk` profile | `@deepseek-ai/dsh-sdk-client` 启动子进程，stdio JSON-RPC，无 Web 服务；全量 base 工具、策略、持久化 | 首选：适配现有 TypeScript Hub，支持持续会话、事件和产品回调 |
| `headless --json` | 每次进程运行一个任务，输出 NDJSON，支持持久 session 继续；没有实时人工审批应答通道 | 备选：批处理或任务 worker，运行时交互比 SDK 少 |
| `dsh web` | 持续 Web 服务和客户端传输 | 适用于直接复用官方 Web 或遥控现有 DSH；自有 Hub 产品不必同时维护第二个 Web 面 |
| `sdk-minimal` | 独立最小组成，持久 shell / 图片读取 / working_directory，默认 danger-full-access；缺少 base 的文本文件工具、skills、managed credentials 等 | 不因名字“minimal”直接选用；本项目更适合 `sdk` 后裁剪 |

DSH Go 是第三方 Flutter / Dart 客户端：Android 内安装 Ubuntu / Node / DSH，也连接远端 DSH。`packages/dsh_client` 封装 Web HTTP 调用与 `/api/remote.mux` WebSocket，包括事件重同步与重连。该 Dart 客户端不能直接成为 React Native 依赖；可以借鉴其传输和任务交互边界。我们复用的是同一个官方引擎。[G1][G2]

## 3. 源码接口与 npm 发行必须分开

固定源码中 `DeepSeekHarnessOptions` 的关键字段为：`profile`（默认 `sdk`）、`patches`、`dshHome`、`processCwd`、`env`、`dshBin`、`cwd`、`provider`、`model`、`reasoningEffort`、`maxTokens`、`approvalRequests`、`onUserQuestion` 及握手 / 请求 / 关闭超时。[R2]

- `cwd` 是 SDK 创建 Session 的工作目录；`processCwd` 是子进程工作目录，两者不能混为一谈。
- `dshBin` 指向 CLI module；省略时解析 SDK 同版本 `@deepseek-ai/dsh`，不要依赖机器上浮动的全局 `dsh`。
- `env` 一旦传入就替换整个子进程环境；不是自动与父环境合并。应由 Hub 显式保留必要 PATH / HOME 等和所需模型凭据，避免把 Hub 的 HA 等无关凭据全部继承给 shell worker。**还要注意 CLI 启动会加载工作目录 `.env` 和 DSH_HOME 的 `.env`**：仅过滤 `env` 不够，`processCwd` 与 `dshHome` 要使用没有 Hub 混合密钥文件的专用目录，再以 SDK `cwd` 指定目标 workspace；执行身份也应无法读取 Hub 的凭据文件。[R11]
- 自定义 profile 必须保留 SDK JSON-RPC server，否则初始化没有对端响应；自定义插件不能向 stdout 打普通日志。
- `sdk` profile 关闭 HMR，patch / 插件变更通过关闭并重启 worker 生效。共享 `dshHome` 也会共享 profile 修改和持久化。[R1][R2][R3]

**npm 类型差异已由主 agent 检查真实 tarball，安装 / 启动探针另行记录：**

| SDK 发行版本 | `approvalRequests` / `onUserQuestion` / `onRequest` | `RunResult.finishReason` | `resumeSession` | 本轮判断 |
| --- | --- | --- | --- | --- |
| `0.2.1-rc.5` | 无 | 无 | 有 | 可做旧版无模型启动 smoke；不满足这里提出的原生审批桥接接口 |
| `0.2.2-rc.1` | 有 | 有 | 有 | 有审批能力的候选；本轮另行完成该版启动与真实文件读取探针，审批行为待验 |

注册表元数据证据见 [registry-snapshot.json](artifacts/dsh-research/registry-snapshot.json)。上面的完整字段清单是固定 master 源码契约；rc.1 与 master 是否全部同构也应核查，不能把文档示例直接当已验证代码。

## 4. 复用现有 `.env` 模型配置

本项目当前 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 是自建循环的配置，并非同名即被官方 SDK 自动识别。源码的自定义 OpenAI 兼容网关由 `@deepseek-ai/dsh-llm-pi-ai` adapter 的 `providers` 路由配置承载：[R6]

| 当前值 | DSH 接入映射建议 |
| --- | --- |
| `LLM_BASE_URL` | 显式 route 的 `baseURL` |
| `LLM_API_KEY` | route 的 `apiKeyEnv: LLM_API_KEY`，由受控子进程环境或凭据 seam 解析 |
| `LLM_MODEL` | route 的 `models[].id` 与 SDK 的 `model` |
| OpenAI Chat Completions 协议 | route 的 `api: openai-completions`；不能只设置 endpoint 就假定协议兼容 |
| 模型上下文容量与输出上限 | 根据真实网关能力填写；不要继承未知模型的大容量默认值 |

Hub 需要生成不含密钥值的 profile patch，再以 `provider` 选择该 route。固定源码的未知 route 要求 `api`、`baseURL` 和非空 `models`。本轮按该映射生成的 JSON 格式 Cordis patch 已在 rc.1 真实模型只读任务中通过；具体模板见第10节探针脚本。其他网关协议、模型能力和鉴权仍须逐路验证。patch 对目标 plugin 的 `config` 是整段替换，不是深度合并，应保留所需字段。[R6][R7]

## 5. 个人记忆与设备工具怎么接

SDK 启动子进程，不能直接使用 Hub 进程里的 `PersonalMemoryStore` 实例。两条官方扩展路径可选：[R2][R8][R9]

1. **Cordis 原生插件**：插件导出 `apply(ctx)`，通过 `ctx.tools.register(defineTool(...))` 注册 schema 与 execute；execute 调用 Hub 认证后的窄接口。源码工具有校验、规范输出、取消 signal 和执行策略扩展点。只新增记忆 / 家居 / 本体工具；文件与 shell 继续用官方工具。
2. **MCP 服务**：把 Hub 能力作为 MCP server，由官方 `@deepseek-ai/dsh-mcp-client` 接入；支持 stdio 与 Streamable HTTP，工具自动注册为 `mcp__<server>__<tool>`。适合希望其他 agent 也复用同一服务的情况，但本项目目前没有现成 MCP server，需要实现这层。

建议第一阶段先接通官方文件 / shell 任务与语音回传，再增加最小记忆插件；若明确要跨引擎通用，再优先选择 MCP。工具服务仍校验 task / session 授权与调用身份，不把 HA token 或任意控制设备的通用服务接口交给 shell。工具命名可用 `looi_memory_recall` 等明确名字；不要预设所有模型允许带点的函数名。

## 6. 会话、事件、审批、取消和恢复

以下高级 SDK 行为在本次 master 快照已确认；选定发行包需逐项验证。[R1][R2][R10]

| 主题 | 官方事实 | Hub 必须补的产品语义 |
| --- | --- | --- |
| 创建 / 执行 | `session()` 建句柄，`run()` 返回 `sessionId / finalResponse / events / notifications` 等；普通输入覆盖“接收回执到下一次整个 agent idle” | task 与 session 显式映射；同 session 串行，避免插话混入任务结果 |
| 结果判断 | `finalResponse` 是活动区间最后提交的根会话回复，非输入独占响应；工具成功不等于任务完成 | 结合终态 / 产物 / 执行回执，不能只看最后一句话 |
| 事件 | `session.event`、`session.status`、`subagent.started / finished`；运行时通知含所有 session，SDK做树过滤 | 转换成现有 `agent_status`；保存序列并支持客户端重连快照 |
| 审批 | `approvalRequests: true`，先 `client.start()` / `client.onRequest()`，再 `harness.start()`；只 `allowed-once` 授一次操作 | 关联请求与用户响应；缺应答器时保持拒绝，不能默许 |
| 用户问题 | `onUserQuestion` 是另一条回调，不等同审批；取消问题不等于取消任务 | 复用手机 / 语音问答呈现，保持问题 id 与原始答案 |
| 超时 / 取消 | 没有独立 runtime cancellation request；RPC 超时仅停止本地等待，模型或工具可能继续 | 拦截后续产品动作、关闭独占 worker 并确认进程退出；远程任务仍需独立 job 停止回执 |
| 关闭 | `close()` 经过 shutdown / stdin EOF / SIGTERM / SIGKILL 并确认拥有的子进程退出 | 不把它等同所有外部 shell、后台 job、SSH 或设备动作已经停止 |
| 重启恢复 | `resumeSession(savedId)` 从原持久存储恢复；`session(id)` 不执行持久恢复；外部进程不恢复 | 保存 dshHome / sessionId / workspace / taskId；恢复后重读真实状态，不自动重放有副作用的任务 |

建议重要长任务使用独占 worker / session；手机的持续陪伴会话另行管理。用户打断语音播放与“停止工作任务”应有不同事件。进程隔离本身不等于权限隔离；工作区写权限仍依赖官方 sandbox 及运行身份。

资源预算需要由产品显式补齐：原循环默认 `maxSteps=6`；SDK `maxTokens` 是每次模型请求的输出上限，`requestTimeoutMs` 只限制本地 RPC 等待。两者都不是全任务步数、费用或执行截止。executor 应保存任务 deadline / 工具次数 / 总token预算，达到预算时进入停止流程并核实退出，不能超时后直接重试。[R1][R2]

完整 SDK base 还包括调度、subagents、插件管理、遥测等产品功能。按本项目需求裁剪这些组成，明确日志 / 附件持久化目录及删除范围；不能声称 DSH Session 日志已经替代个人长期记忆。固定源码 base 包含 `session-log-deepseek` 与 `session-telemetry-otel`，应逐项核对所选版本默认值并明确配置。[R3][R7]

## 7. 接入工作的推荐顺序

1. **锁定发行组合**：分别记录 SDK 和 runtime 的版本、integrity、Node 要求；先隔离安装、启动与关闭，不修改 Hub。
2. **最小真实任务**：指定临时 workspace 与独立 dshHome，验证 SDK 读文件 → shell 执行 → 写产物 → 最终回复。记录真实进程 / 文件证据。
3. **替换主调用链**：定义产品自己的 executor 接口，移除对具体 `MinimalAgentLoop` 的依赖；统一 HTTP、Duplex 工具调用、文本输入与 ModularVoice 入口。保留现有 UI / 音频路径。
4. **打通状态与生命周期**：task ↔ worker ↔ session 关联、串行队列、事件映射、审批和问答、取消与退出确认、重启恢复。
5. **增加记忆和设备工具**：插件或 MCP 接已有服务；每条工具都有真实执行回执、调用范围与取消规则。
6. **修订旧文档**：Phase 11 手写循环标为原型；Phase 3 模拟 runner 与官方实联分开验收，避免继续称“DSH 已接入”。

## 8. 验证清单与边界

| 验证 | 通过证据 |
| --- | --- |
| npm 实包与源码差异 | 包版本 / 类型声明 / 依赖锁 / 实际 profile 清单 |
| 初始化 / 关闭 | 独立 home、workspace，握手成功且子进程退出，无遗留监听端口 |
| 模型路由与工具循环 | 使用 `.env` 网关；真实 read / shell / write 产物，非 mock LLM 证明 |
| 会话隔离 | 并发两个任务不会串 history / cwd / finalResponse |
| 审批与用户问题 | 允许一次 / 拒绝 / 超时 / 断连分别可观察，无自动批准 |
| 取消 | 长运行 shell / 已发布后台 job / 远端任务分别确认终态，不以 RPC 超时当停止 |
| 恢复 | 重启后原 session 恢复；缺失 session 明确失败，未静默新建 |
| 故障与重连 | 模型超时、worker 崩溃、手机重连、重复请求不自动重复副作用 |
| 记忆与删除 | 工具读写原有记忆服务；删除时可控 DSH 附件 / 会话副本范围明确 |

本轮属于研究：上述清单中启动/关闭及 rc.1 真实模型文件读取有独立证据；审批、写入、设备、完整取消与恢复验收仍待实施。不能把一条只读任务成功外推为全部工具已经接通。

## 9. 本仓库的具体替换位置（代码核对，未实施）

| 现有位置 | 核实到的行为 | 迁移建议 |
| --- | --- | --- |
| [`apps/hub/src/app.ts`](../apps/hub/src/app.ts) | `buildApp` 创建一个共享 `MinimalAgentLoop`；HTTP `/api/agent/run`、语音工具 `run_agent_task`、语音转写 followup、Duplex 文本输入都调用它 | 依赖改为产品自己的 `AgentExecutor` 接口；统一 submit / observe / cancel / resume，避免四条入口各自管理任务 |
| [`apps/hub/src/agent/agent-loop.ts`](../apps/hub/src/agent/agent-loop.ts) | 自写 Chat Completions 工具循环；共享内存 history；signal 传给模型请求却没传给 `execFile`；步数耗尽仍返回“已完成”式文案 | 官方 SDK 接入层替换循环；每个任务独立 session；任务错误/步数限制不能伪装成功；取消以真实退出证据为准 |
| [`apps/hub/src/productivity/dsh-runner.ts`](../apps/hub/src/productivity/dsh-runner.ts) | 固定 `processId: 1001`、构造 exit 0 与成功输出、通过 map 模拟终止，没有启动官方 DSH | 不在其静态成功返回上再套 SDK；改为真正 worker 事件/进程管理，对接原 TaskSupervisor 的回执语义 |
| [`apps/hub/src/productivity/task-supervisor.ts`](../apps/hub/src/productivity/task-supervisor.ts) | task/event/grant/receipt 都是进程内 Map | 保留产品契约，增加持久存储和 task → worker/session/home/workspace 映射；仅 DSH session 落盘不足以恢复 Hub 任务 |
| [`apps/hub/src/voice/modular-engine.ts`](../apps/hub/src/voice/modular-engine.ts) | 默认 ASR / LLM / TTS 是固定结果或模拟音频；provider 注册时没有把官方 DSH 接入 | 本轮不扩展语音链路，但迁移不能以现有文档“Modular已接真实Agent”的描述作为事实 |
| [`apps/hub/src/agent/personal-memory.ts`](../apps/hub/src/agent/personal-memory.ts) | Hub 现有记忆服务和系统提示摘要 | 数据继续由 Hub 拥有，插件通过受控API读写；不让子进程直接共享可写 JSON 文件 |

推荐拟建模块（名称是设计建议，尚无代码）：`agent/executor.ts` 定义产品接口，`agent/dsh-executor.ts` 封装 SDK，`agent/dsh-worker-manager.ts` 管理进程/队列/持久映射；单独 package 承载 `looi` 工具插件。第一阶段不要求改手机框架或原生构建。

`agent_status` 只保留界面需要的摘要；详细 SDK 原事件按 task/session 关联保存。审批挂起不能映射为完成，`finishReason=error`、传输异常、无最终回复、等待中与成功要分别处理。旧版 rc.5 没有 `finishReason` 字段，必须按所选版本的事件契约解释，而不是强行读取新字段。

明确把“打断口播”和“取消工作”拆成协议事件：当前 `barge_in` 会触发 `agentAbort.abort()`，但 SDK `run` 没有同样的 signal 取消选项。工作任务运行中关闭手机连接不应被静默等同任务已取消。采用每重要任务独占 worker，可避免关闭一个进程影响其他任务；持久恢复不自动重放未确认的副作用。

## 10. 本轮隔离探针

实验仅在系统临时目录安装包、创建独立 DSH_HOME / workspace，没有修改仓库依赖、`.env`、运行代码或用户 `~/.dsh`。

- Node `v24.14.0` / pnpm `9.15.9`，macOS。使用 `pnpm add --ignore-scripts --save-exact` 安装，关闭依赖生命周期脚本；此结果不验证需要 native build 的全部工具。
- npm registry 快照及两个 SDK tarball 类型差异保存在 [`registry-snapshot.json`](artifacts/dsh-research/registry-snapshot.json)。`0.2.2-rc.1` runtime 声明 Node `>=24.9.0`；当前实验环境满足。rc.5 的包 manifest 未声明 engines，不应据此承诺支持任意 Node。
- rc.5 安装完成（561 个包），OpenTelemetry transitive peer 出现 `@opentelemetry/api` 范围告警；正式锁定依赖前需要处理，不能只记录顶层两个版本。
- `0.2.1-rc.5` 官方 SDK + runtime：初始化成功（约2.6秒）、Session cwd 与独立 workspace 一致、缺失会话恢复明确拒绝、`close()` 成功；总约3.1秒。没有发出模型请求，不能称为 ReAct 工具闭环验收。证据：[`probe-rc5-result.json`](artifacts/dsh-research/probe-rc5-result.json)。


- `0.2.2-rc.1` 在全新目录安装完成（592个包），相同四项无模型检查通过，握手约0.94秒。证据：[`probe-rc1-result.json`](artifacts/dsh-research/probe-rc1-result.json)。从旧 rc.5 临时项目原地升级时曾保留大量旧自动 peer 版本；全新安装消除了官方包版本冲突，仍有同类 OTel peer 告警。因此 PoC 应使用专门 worker 依赖目录与审核后的锁文件，不仅更换顶层版本。
- **真实模型只读闭环通过**：读取仓库 `.env`（没有打印或复制密钥），把模型 API key 仅放入受控子进程环境、baseURL / model 配成独立 provider，启动官方 rc.1 引擎。随机标记只写在临时 `proof-input.txt`，没有放进提示词；模型调用官方 `read` 工具读取（从成功 Session 的持久化 tool/call 核对工具名），第二个模型步骤返回相同标记，`finishReason=completed`，可观察到 `tool/call` 和 `tool/result`。证据：[`probe-rc1-model-result.json`](artifacts/dsh-research/probe-rc1-model-result.json)。
- 第一轮模型尝试 `finishReason=error`，没有工具事件，底层错误未捕获，原因未确认。一次只读任务的人工重试在新 session 通过；没有修改应用重试逻辑，也没有重放写入操作。真实写入/命令、审批/问答、成功任务的跨进程历史恢复、后台/远端进程终止仍未验证。
- 探针只走无图像文件读取，不需要 native postinstall 的事实不代表正式 worker 可以始终 `--ignore-scripts`。后续按启用的工具审核构建脚本，记录完整 lockfile、Node、pnpm、profile与插件配置；本轮结果保存了 rc.1 实验 lockfile 的 SHA256供比对，不把临时锁文件直接作为生产锁。

复跑入口（在全新临时目录执行，脚本会生成独立 home/workspace；前置安装仓库 Hub 的 dotenv 依赖）：

```sh
pnpm add --ignore-scripts --save-exact @deepseek-ai/dsh@0.2.2-rc.1 @deepseek-ai/dsh-sdk-client@0.2.2-rc.1
# 将本报告同目录 artifacts/dsh-research/ 中两个脚本复制到该临时目录后：
node runtime-smoke.mjs
node model-read-probe.mjs /absolute/path/to/super-looi
```

脚本：[`runtime-smoke.mjs`](artifacts/dsh-research/runtime-smoke.mjs)、[`model-read-probe.mjs`](artifacts/dsh-research/model-read-probe.mjs)。模型探针会向 `.env` 指定的提供方发起少量真实请求；只对临时文件做只读任务。输出仅含检查结果/事件类型/工具名，不包含完整模型上下文和凭据；完整Session数据由DSH保存在该临时home。归档探针在失败时返回非零退出码，缺少模型配置时返回2。

### 下一轮实施的最小完成标准

先完成一个“官方执行器 + 一个 workspace + 一项文件/命令任务 + 原手机状态回传”，再接记忆插件。PoC 不能继续由静态 `DshWorkspaceRunner` 报完成。上线前补审批与用户问题回调、隔离启动目录、Hub任务持久化、单任务预算、取消退出证据及日志/记忆副本删除；这些是产品接入工作，核心执行循环继续由官方引擎维护。

## 来源

[R1] [TypeScript SDK 客户端](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sdk/client/README.md)。
[R2] [SDK 启动与结果类型](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sdk/client/src/types.ts)。
[R3] [sdk profile](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/bundle/sdk-app/README.md)。
[R4] [headless profile](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/bundle/headless/README.md)。
[R5] [sdk-minimal profile](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/bundle/sdk-minimal/README.md)。
[R6] [多提供商 / 自定义网关 adapter](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm-pi-ai/README.md)。
[R7] [base 组成与 patch 覆盖](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/bundle/base/README.md)。
[R8] [官方工具注册契约](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/cookbook/adding-a-tool.md)。
[R9] [官方 MCP 客户端](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/mcp/mcp-client/README.md)。
[R10] [SDK 协议与生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sdk/protocol/README.md)。

[G1] [DSH Go README](https://github.com/ccch1mneyyy/dsh-Go/blob/main/README.md)（移动项目维护者说明，动态 main，访问于调研日）。
[G2] [DSH Go dsh_client](https://github.com/ccch1mneyyy/dsh-Go/blob/main/packages/dsh_client/README.md)（客户端传输 / API 边界，动态 main）。

[R11] [CLI 环境分层加载](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/boot/app-boot/src/index.ts)（`loadLayeredEnv`，继承环境 > processCwd/.env > DSH_HOME/.env）。
