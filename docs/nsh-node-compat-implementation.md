# NSH Node 兼容层实施记录（2026-11-06）

本次将 `docs/plans/nsh-node-compat-and-pi-plan.md` 推进到独立兼容包、真实 NSH 原生 class 与迁移门禁。**原方案尚未全部落地**：Phase 2 四包、实际 SDK 七工具、原生 codemode 与 Durable 集成已在 runner、NSH hardened engine 和 iOS 模拟器通过。Android 原生模拟器和双 ARM Release APK 编译也已通过；签名发行、Phase 3 业务/UI/媒体迁移与去 Hub 仍待完成。

## 实际交付

`packages/nsh-node-compat` 包含 Rust crate、JS 垫片、esbuild 插件与独立 runner。固定 NSH v0.4.0 / `e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3` 的 `quickjs-jit 0.14.1`，Pi 家族固定 1.5.0，pnpm 与 Cargo 均保留锁文件。Rust `Bridge` 同时供 `install(Ctx, data_root)` 与 NSH typed class 使用。`apps/nsh` 注册的 `NodeCompat` 从宿主 System 取得私有目录并验证读写 grant，JS 不传宿主路径；同步 request/begin、异步单消费 wait 复用同一实现。

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
| Durable Codemode | 同一 Harness 安装上游 createCodemodeExtension，实际脚本调读写工具/store/output，native sandbox 关闭回执通过；ICU Segmenter 支持 upstream search 的 word 切分 |
| Durable 强杀 | 生成请求 pending 后按 stdout checkpoint 对第一个 QuickJS 宿主发 SIGKILL；第二个宿主用相同 SQLite 恢复一次生成，requestId 去重通过。未验证副作用工具执行中强杀的 unknown/零重放业务策略 |
| pi-coding-agent 1.5.0 | SessionManager JSONL 落盘/重载与 read/write/edit/ls/find/grep/bash 通过；显式 headless 内部入口，排除 TUI/图片/下载；find/bash 注入 Operations。**不等于完整 createAgentSession 通过** |
| 实际 programmatic SDK | createAgentSession + ModelRuntime + DefaultResourceLoader + SettingsManager；七个默认工具（不注入 find/bash Operations）、JSONL 重载与正常退出通过。faux provider 驱动真实工具，不是替换会话实现 |
| 本机 codemode | upstream portable RemoteCodemodeSandbox 与精确 PRELUDE_SOURCE；Rust 独立线程/QuickJS VM，parallel tools、store/load/output、异常、heap/同步及 async 超时、取消/close、确定性 seed/UTC/replay/乱序结果、入场/帧/待处理字节预算与资源复用通过 |
| runner | 未结算 Promise 与无限 JS 循环分别在 50ms 配额后退出，无外部 timeout 强杀 |
| iOS 编译 | Rust 兼容库 `cargo check --target aarch64-apple-ios-sim --lib` 通过，使用 iPhoneSimulator 26.2 SDK；移动目标启用 bindgen，保持 VM 0.14.1。该项仅为编译检查，下方另列实际宿主运行 |
| NSH hardened engine | 八组同源测试通过；配置私有磁盘目录、发布态 hardening、默认 256 MiB embedding 堆与 2 秒单调用预算。普通 TSX headless open 不提供真实目录，不作为此磁盘门禁 |
| iOS 原生宿主运行 | iPhone 16e / iOS 26.3 模拟器，真正链接 NodeCompat class；八组测试全部通过，含 notify、SQLite 预算、原生 Shell 取消、Durable/codemode 与实际 SDK 七工具。模型/SSE 在这组中使用 fixture，真实手机网络仍待验证 |
| Android 原生宿主运行 | Android 14 / API 34 ARM64 模拟器八组全部通过；Release APK 编译 arm64-v8a / armeabi-v7a，debug 签名。未执行 32 位 ABI，未做商店签名、AAB / API 36 验证 |
| 包消费 | build 后通过公开 exports 导入 adapters / bundler / index，别名目标文件存在；这项单独在 Node 检查，不计为 QuickJS 测试 |

## SDK 平台适配与剩余实施门禁

### 完整 coding-agent SDK

仅使用透明 Node 别名构建桌面根 barrel 的审计仍单独保留：`pnpm --filter @super-looi/nsh-node-compat audit:transparent-sdk`，历史明细见 [full-sdk-audit.json](artifacts/nsh-node-compat/full-sdk-audit.json)。该路径不属于可运行的移动 SDK 模式。

新增 `nshPiSdkPlugin` 选择 upstream 实际 programmatic exports，隔离 CLI/TUI barrel。显式适配为：平台 HTTP 全局 dispatcher 设置拒绝（请求本身使用宿主 fetch）；jiti 仅加载已注册预编译扩展；OAuth 使用宿主深链回调而非本机 TCP；photon 图片处理明确拒绝；内置 renderers 退出非可视 agent 路径；fd/rg 使用沙盒 Rust 命令。`verify:full-sdk` 同时执行该模式构建与实际 createAgentSession 七工具测试，已通过。默认凭据、图片、NSH 原生网络与深链仍须在手机宿主验证。

### Portable codemode

安装包的实际 portable 入口导出 `InlineCodemodeSandbox` / `RemoteCodemodeSandbox`，没有方案所写的 `InProcessCodemodeSandbox`。Inline 要求 WebAssembly，当前 NSH 原生 QuickJS 没有提供；因此实现本机 Rust/QuickJS actor 适配 Remote 协议。每个脚本使用全新 VM，不安装 FS/网络/loader/宿主 globals，只通过上游 prelude 的工具消息桥接。

`pnpm --filter @super-looi/nsh-node-compat verify:codemode` 已通过。资源预算、确定性 fingerprint 与局限见包 README；stop 等待 VM 真正销毁后回执。固定 stdlib 的原生 AbortSignal.any 会用不可追踪 Rust 闭包形成引用环，本包换成 JS 回调，并以真实 runner 退出验证 GC 可回收。

### NSH 手机应用与 Hub 移除

已通过 NSH 原生 class、hardened engine 与 iOS 模拟器真实运行。原生 class 使用官方 [native_module / module / class 注册](https://github.com/longbridge/nsh/blob/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3/crates/nsh-cli/src/templates/mixed/lib.rs)，没有直接修改 Expo prebuild。`apps/nsh/App.tsx` 已迁为本机大脸、文字/离线记忆、完整回复与审批界面，系统凭据与双端 UI 证据见 [移动基础记录](nsh-mobile-foundation.md)；媒体与完整业务迁移仍未完成。签名发行、真实模型网络、PCM/AEC、安全凭据、BLE/相机及任务/审批/记忆数据迁入仍待完成。证据见 [native-host-audit.json](artifacts/nsh-node-compat/native-host-audit.json) 与 [iOS 日志](artifacts/nsh-node-compat/ios-native-probe.log)、[Android 日志](artifacts/nsh-node-compat/android-native-probe.log)。

Hub 与 Expo 旧端已归档到 `archive/legacy-hub-and-expo` 并移出工作区。当前应用采用 NSH 最简 Agent Loop；签名发行、真机媒体与硬件接线见根目录 `todo.md`。

## 独立审查

主 agent 完成全部代码。独立子 agent 发现并复现了宿主 cwd、文件句柄身份、SQL 原生预算、Promise 超时、取消回执、Shell 栈溢出/参数/`--`、watch 队列与公开 exports 等问题；主 agent 修复并补回归后复审通过。六组 QuickJS、真正 SIGKILL 恢复、runner deadline、typecheck 与包导出检查通过。全仓 pnpm build / typecheck / test 通过：原有 307 项 JS 测试与新增六组 QuickJS、强杀恢复、deadline 全部通过；Cargo test 通过。原有四个未提交语音文件保留在工作树。

后续 SDK/codemode 阶段扩展至八组真 QuickJS，并再次通过全仓 build/typecheck/test（原有 307 项 JS 测试）、Cargo test。独立复审复现并推动修复 async continuation 超时误分类、原生入站/乱序结果字节预算与 AbortSignal.any 引用环；资源拒绝后的关闭回执和容量复用、SDK 七工具/恢复/正常退出已复验通过。NSH CLI 首次源码构建触发 stable Rust 更新时暂用已安装的 `RUSTUP_TOOLCHAIN=1.94.0` 执行这些检查。

原生 Bridge 阶段，复审又复现丢弃 stop wait 导致 VM 容量不释放，以及丢弃 Shell wait 过早释放实际线程容量。stop 改为同步入队，actor 在销毁 VM 后释放槽位；Shell worker 与消费者共享容量 lease，消费者丢弃先取消、线程退出才最终释放。五项 Rust 测试（含暂停真实 16 worker 的取消测试）与原独立复现均通过；随后八组测试在 NSH engine / iOS 中通过。
