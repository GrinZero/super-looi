# Rust Agent Harness 调研

检索日期：2026-11-16。这里的 Pi 指 Mario Zechner 的 Pi coding agent。比较对象是能承载模型调用、工具执行循环、会话和上下文管理的执行框架。

## 结论

有多个 Rust 实现，甚至有直接移植 Pi 的项目。对 Super LOOI，优先研究 **bigfish1913/pi-rust（rpi）**；若继续保留 App 自有会话与任务体系、只替换执行循环，再比较 **yoagent**。**Goose GDK** 是需要自定义状态机时的候选。这个顺序依据接口与职责匹配程度，不是性能排名。

| 项目 | 定位与已核实能力 | 接入的主要成本 |
| --- | --- | --- |
| [rpi](https://github.com/bigfish1913/pi-rust) | 库优先的 Pi Rust 重实现；loop、事件、取消、会话树、JSONL、压缩与恢复分层提供 | 接入 harness 的配置和存储语义；较完整的工具依赖链 |
| [yoagent](https://github.com/yologdev/yoagent) | 可嵌入 loop；工具、事件、steer、follow-up、abort、扩展钩子 | 宿主要整合会话持久化与压缩后的历史 |
| [Goose GDK](https://goose-docs.ai/docs/gdk/reference/) | 可组合 Rust 状态机、类型化工具、模型连接、独立压缩组件 | 引入 operation/effect 概念；宿主实现存储；GDK 仍为 alpha |
| [pi-rs](https://github.com/lassejlv/pi-rs) | 整套 Pi 移植，目标覆盖 CLI、格式、RPC 与扩展 API；内嵌 QuickJS | 需要裁剪终端与 JS/Node 兼容层，核实具体 API 的兼容范围 |
| [Rig](https://rig.rs/docs/architecture) | 通用 Rust agent 框架，提供工具循环、钩子、可序列化运行状态和可选记忆组件 | 接入它自己的消息、运行和记忆模型，映射现有 Pi 行为 |

## rpi：最贴近完整 Pi Harness

当前源码版本为 **0.24.2**、MIT、最低 Rust 1.88；workspace 包含 11 个产品 crate。`rpi-ai` 提供模型协议，`rpi-agent` 提供循环、工具、队列、事件与取消；`rpi-harness` 提供会话树、JSONL、压缩与恢复；`rpi-runtime` 提供可嵌入的模型和凭据解析。可以进程内调用，无须启动 CLI。[README](https://github.com/bigfish1913/pi-rust)、[版本与依赖](https://github.com/bigfish1913/pi-rust/blob/main/Cargo.toml)

`AgentTool::execute` 接收取消令牌和部分结果回调；harness 提供 `events()`、`watch_session()`、`request_abort()` 等宿主接口。`RuntimeConfig` 允许 App 注入模型配置、`AuthStore` 与 `ValueSource`，不要求使用开发机的配置目录或登录态；OAuth 交互和凭据保存由宿主负责。[Agent API](https://github.com/bigfish1913/pi-rust/blob/main/crates/rpi-agent/README.md)、[Harness API](https://github.com/bigfish1913/pi-rust/blob/main/crates/rpi-harness/README.md)、[可复用 runtime](https://github.com/bigfish1913/pi-rust/blob/main/docs/architecture/reusable-runtime.md)

它的复杂度有明确来源：`rpi-harness` 会依赖 `rpi-tools`，后者包含图像、文件、shell 等实现，并非只有一个循环；workspace 的 Tokio 配置也打开了 `process` 和 `fs`。因此“只引用库”不等于依赖已经为移动端裁剪。若只用 `rpi-agent`，依赖更少，但会话和压缩的整合就归宿主承担。[Harness manifest](https://github.com/bigfish1913/pi-rust/blob/main/crates/rpi-harness/Cargo.toml)、[Tools manifest](https://github.com/bigfish1913/pi-rust/blob/main/crates/rpi-tools/Cargo.toml)

**选用价值：**保留 Pi 式职责拆分，减少重新实现会话、压缩和恢复的工作。成本是接入它的持久化语义，并适配移动端工具与依赖。

## yoagent：更聚焦执行循环

当前源码版本为 **0.27.9**、MIT、最低 Rust 1.86。`agent_loop()` 可以独立使用，`Agent` 包装器增加历史和队列；源码有 `steer`、`follow_up`、`abort`、`with_tools`、`with_compaction_strategy` 和扩展接口。支持多个原生模型协议以及 WASM。[README](https://github.com/yologdev/yoagent)、[Agent 源码](https://github.com/yologdev/yoagent/blob/main/src/agent.rs)、[manifest](https://github.com/yologdev/yoagent/blob/main/Cargo.toml)

需要注意一个具体整合边界：`Session::append_new` 要求传入历史是当前分支的追加扩展；自动压缩会改写消息，可能触发 `HistoryDiverged`。源码建议在该会话跟踪方式下关闭自动上下文管理，或由宿主重建分支。因此，拥有 session 和 compaction 两个模块，不能直接理解成两者已组成完整的持久化 harness。[Session 源码](https://github.com/yologdev/yoagent/blob/main/src/session.rs)

默认 `native` feature 同时打开文件、子进程和 reqwest 的默认 TLS。关闭它是 WASM 的配置方式，也会去掉原生 HTTPS 所需的 TLS 配置，不能直接当作移动端适配办法。[feature 定义](https://github.com/yologdev/yoagent/blob/main/Cargo.toml)

**选用价值：**App 可以继续掌握状态、工具和存储，只交出工具循环。成本是自行协调压缩、持久化和执行记录，不能直接获得完整 Pi 的会话行为。

## Goose GDK 与 Rig

Goose 已提供可嵌入 GDK。`goose-agent` 使用 `StateMachine`、`InferenceRunner` 和 `ToolOperation`；App 提供会话类型、`SessionLoader` 和 `EffectHandler`。`goose-context-management` 独立提供压缩，存储由 App 实现。Rust 可直接使用完整状态机；Python/Kotlin bindings 当前只覆盖部分能力。官方将 GDK 标为 alpha。[官方 API](https://goose-docs.ai/docs/gdk/reference/)

**选用价值：**能逐步控制推理、工具和副作用，适合重新设计 agent 生命周期。成本是多一套状态机和 operation 抽象；若仅替换现有 Pi loop，这些抽象的收益较小。

Rig 已具备真正的 agent loop，并非单纯 LLM client。`AgentRun` 是可序列化、可逐步驱动的状态机；记忆层提供 `ConversationMemory`、窗口策略和 `CompactingMemory`，持久化后端由应用接入。向量库等集成通过可选 feature 引入。[架构](https://rig.rs/docs/architecture)、[可持久化运行](https://rig.rs/docs/concepts/runs)、[记忆与压缩](https://rig.rs/docs/concepts/memory)

**选用价值：**适合同时需要多模型、检索和结构化输出的通用应用。成本是迁移到它的消息、运行和记忆接口；当前需求只强调“类似 Pi”，rpi 的结构更直接。

## 其他 Pi Rust 实现

- [yannelli/pi-rust](https://github.com/yannelli/pi-rust)：整套 Pi Rust port，内嵌 JS 引擎运行扩展；需要按其公开差异列表核实兼容能力。
- [nowa/ri](https://github.com/nowa/ri)：含 harness、会话和压缩；README 指出尚未发布 crates.io，使用 Git 依赖。
- [Dicklesworthstone/pi_agent_rust](https://github.com/Dicklesworthstone/pi_agent_rust)：有进程内 SDK，不能仅归类成 CLI。但其许可证标题是 **MIT with OpenAI/Anthropic Rider**，包含针对特定主体的附加限制，不能标作普通 MIT。[SDK](https://github.com/Dicklesworthstone/pi_agent_rust/blob/main/src/sdk.rs)、[LICENSE](https://github.com/Dicklesworthstone/pi_agent_rust/blob/main/LICENSE)

## 与 Super LOOI 的关系

仓库当前依赖 `@earendil-works/pi-ai`、`pi-agent-core`、`pi-coding-agent` 1.5.0；模型解析、任务执行和会话管理都有直接 Pi 接口依赖。[依赖声明](../packages/looi-runtime/package.json)、[会话接入](../packages/looi-runtime/src/agent/core/pi-session.ts)、[任务执行](../packages/looi-runtime/src/agent/core/pi-task-runner.ts)

迁移 Rust 的具体收益是把模型网络调用、工具循环和会话执行放进原生宿主，减少这些路径对 Node 兼容层的需求。现有 TypeScript 工具、事件、任务与会话格式仍要对接 Rust 接口；若还需要原样运行 TS 扩展，QuickJS 兼容工作仍然存在。这是结合当前代码与候选接口得出的工程判断。

建议先评估 rpi 是否能承接现有 `PiTaskRunner` 的职责，再决定是否迁移；若发现主要需求只是执行循环，则比较 yoagent。设备工具应调用 App 自有能力，凭据由 App 提供，模型连接直接从 App 发往目标服务。

本次完成文档、manifest 与关键源码调研，未进行候选库的 iOS/Android 构建或真机集成；移动端适配及现有 Pi 1.5.0 会话格式的兼容性仍待验证。
