# NSH Node 兼容层实施记录（2026-11-06）

本次将 `docs/plans/nsh-node-compat-and-pi-plan.md` 推进到可运行的独立兼容包、真实 QuickJS 验证与迁移门禁。**原方案尚未全部落地**：Phase 1 的独立宿主与主要兼容子集已实现，Phase 2 的已选四包路径通过；完整 SDK、codemode 和 NSH 双端挂载尚未通过，Phase 3 业务/UI/媒体迁移与去 Hub 未开始。

## 实际交付

`packages/nsh-node-compat` 包含 Rust crate、JS 垫片、esbuild 插件与独立 runner。固定 NSH v0.4.0 / `e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3` 的 `quickjs-jit 0.14.1`，Pi 家族固定 1.5.0，pnpm 与 Cargo 均保留锁文件。Rust `install(Ctx, data_root)` 提供同 VM 注入入口；尚无已注册的 NSH 移动原生模块。

文件使用 cap-std 目录能力，处理 `..`、符号链接与打开时竞态；句柄保留真实文件身份，rename 后仍读原文件。相对文件路径和 path.resolve 统一虚拟 cwd。SQLite 使用 bundled rusqlite、WAL、事务、authorizer、长度/结果/进度预算；数据库放在与文件能力隔离的私有目录，禁止 ATTACH、扩展加载与外部数据库输出。

Shell 使用 Deno parser 和自有能力执行器，没有链接 Deno 默认执行器的外部进程回退。所有重定向与内置文件操作仍受沙盒控制。解析前结构总量限制防止原生栈溢出；命令选项先解析验证，未知选项不进入写入，`--` 后内容保持操作数。异步 Shell 在 Rust 作业执行，取消使用独立 token，环境 cleanup 等待 close 回执；输出仍在执行完成后交付，不能声称实时输出或硬实时取消。

Buffer/crypto/URL/压缩复用同版本原生 stdlib；额外实现 crc32、虚拟 POSIX path、文件与 Promise 包装、事件/流/readline、UTF-8 跨块解码、保留环/日期/集合/二进制的数据克隆。notify 使用有界队列，忽略读取事件，溢出或覆盖不确定时显式失败。Node API 是验证过的子集，具体限制见 [包说明](../packages/nsh-node-compat/README.md)。

## 已执行的验证

被测 bundle 由独立 Rust QuickJS 进程执行，Node 只负责编译、启动与收集退出码。

| 路径 | 实测结果与边界 |
| --- | --- |
| Node 垫片 | 文件/稳定 fd/偏移读取、中文逐行、SQLite 关闭重开/回滚/越权拒绝、Shell 管道/或分支、哈希/压缩/CRC、数据克隆通过 |
| 资源和取消 | SQLite 无限递归查询退出、原生 Shell 取消、notify 变更、未知写入选项、`--` 操作数、深括号/引号绕过、虚拟 cwd 回归通过 |
| pi-agent-core 1.5.0 | 真实 Agent 工具循环、读写、steer/followUp、事件与 abort 通过；模型使用上游 faux provider |
| pi-ai 1.5.0 | createModels/createProvider；真实 OpenAI SDK SSE 解析，7 字节 UTF-8 分块、工具参数 JSON 流通过 |
| 真实网关 | `.env` 的 LLM 三配置；Rust HTTPS → QuickJS → 上游 OpenAI SDK 流式文本通过；无 Node 请求代理，未记录凭据和回复正文 |
| pi-durable 1.5.0 | 真实 Harness + 上游 write/edit/read/bash 四工具、SQLite journal 重开/继续通过；执行 env 为本包 adapter |
| Durable 强杀 | 生成请求 pending 后按 stdout checkpoint 对第一个 QuickJS 宿主发 SIGKILL；第二个宿主用相同 SQLite 恢复一次生成，requestId 去重通过。未验证副作用工具执行中强杀的 unknown/零重放业务策略 |
| pi-coding-agent 1.5.0 | SessionManager JSONL 落盘/重载与 read/write/edit/ls/find/grep/bash 通过；显式 headless 内部入口，排除 TUI/图片/下载；find/bash 注入 Operations。**不等于完整 createAgentSession 通过** |
| runner | 未结算 Promise 与无限 JS 循环分别在 50ms 配额后退出，无外部 timeout 强杀 |
| iOS 编译 | Rust 兼容库 `cargo check --target aarch64-apple-ios-sim --lib` 通过，使用 iPhoneSimulator 26.2 SDK；移动目标启用 bindgen，保持 VM 0.14.1。未做 App 链接/embedding 或运行 |
| 包消费 | build 后通过公开 exports 导入 adapters / bundler / index，别名目标文件存在；这项单独在 Node 检查，不计为 QuickJS 测试 |

## 未通过的实施门禁

### 完整 coding-agent SDK

仅使用透明 Node 别名构建根入口的 `createAgentSession`，仍有 **100 项构建错误**。可复现命令是 `pnpm --filter @super-looi/nsh-node-compat verify:full-sdk`；机器可读明细见 [full-sdk-audit.json](artifacts/nsh-node-compat/full-sdk-audit.json)。该命令返回非零，没有把错误替换成空模块。

实际依赖图还包括 worker_threads、undici 的原生网络/HTTP/诊断接口、动态扩展与桌面运行期模块；仅把 pi-tui/jiti/photon 换个名字并不能让 SDK 成为纯移动端代码。headless 插件是一个单独、显式的兼容模式，没有重定向完整 SDK 根入口。下一步需要做上游 SDK 边界裁剪或真实移动端适配，并运行同一套 createAgentSession 验收；不能将工具测试当作 SDK 验收。

### Portable codemode

安装包的实际 portable 入口导出 `InlineCodemodeSandbox` / `RemoteCodemodeSandbox`，没有方案所写的 `InProcessCodemodeSandbox`。Inline 的无 node:* 导入不代表没有运行时要求：它要求调用者提供 `CodemodeWasmModule`，并运行在支持 WebAssembly 的宿主上。当前 NSH 同版本原生 QuickJS 不提供 WebAssembly。

`pnpm --filter @super-looi/nsh-node-compat verify:codemode` 会在真实 QuickJS 中加载 portable 入口后明确返回失败。要继续，需实现本机 Rust/QuickJS sandbox 协议适配，或选择符合产品范围的 Remote 服务；没有执行任意脚本的安全假实现，也没有引入新服务作为隐藏依赖。

### NSH 手机应用与 Hub 移除

当前是独立 CLI/Ctx 验证包，已通过 iOS 模拟器目标的 Rust lib 编译检查；没有 NSH iOS/Android embedding、签名发行、UI、PCM/AEC、SecureStore、BLE/相机或任务/审批/记忆数据迁入的证据。官方固定版本的混合模板实际采用 [native_module / module / class 注册](https://github.com/longbridge/nsh/blob/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3/crates/nsh-cli/src/templates/mixed/lib.rs)，不能把方案里的 `#[nsh::module]` 示意代码视为已挂载。

Phase 3 按原方案放在兼容验证之后；上述门禁未过，因此保留 Hub 与现有手机业务路径。本轮没有修改 Expo prebuild 产物，也没有把 CLI 成功当作真机验收。后续必须补双端宿主、凭据/媒体/领域工具、持久任务与 unknown 回执、UI 和全部 Hub 职责替代后，才能删除 Hub。

## 独立审查

主 agent 完成全部代码。独立子 agent 发现并复现了宿主 cwd、文件句柄身份、SQL 原生预算、Promise 超时、取消回执、Shell 栈溢出/参数/`--`、watch 队列与公开 exports 等问题；主 agent 修复并补回归后复审通过。六组 QuickJS、真正 SIGKILL 恢复、runner deadline、typecheck 与包导出检查通过。全仓 pnpm build / typecheck / test 通过：原有 307 项 JS 测试与新增六组 QuickJS、强杀恢复、deadline 全部通过；Cargo test 通过。原有四个未提交语音文件保留在工作树。
