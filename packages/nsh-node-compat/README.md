# @super-looi/nsh-node-compat

NSH v0.4.0 同版本 QuickJS 的独立兼容包与验证宿主。实际 Pi 1.5.0 programmatic SDK 七工具、Durable 与本机隔离 codemode 已通过。当前是经过测试的 Node API 子集，手机 App 迁移和双端宿主仍在进行，见 [实施记录](../../docs/nsh-node-compat-implementation.md)。

```sh
pnpm install --frozen-lockfile
pnpm --filter @super-looi/nsh-node-compat build
pnpm --filter @super-looi/nsh-node-compat test
pnpm --filter @super-looi/nsh-node-compat test:rust
pnpm --filter @super-looi/nsh-node-compat exec tsx scripts/check-exports.ts
```

iOS 兼容库的交叉编译检查（macOS / Xcode）：

```sh
rustup target add aarch64-apple-ios-sim
cargo check --locked --manifest-path packages/nsh-node-compat/rust/Cargo.toml --target aarch64-apple-ios-sim --lib
```

这项已在 iPhoneSimulator 26.2 SDK 通过；仅检查 Rust lib，不构成 NSH App 链接或运行验收。移动目标启用 bindgen 生成固定 VM 缺失的 bindings；Android 配置同样启用，但尚未实际编译。

需要 Rust/Cargo 和本机 C 编译器；Cargo.lock 固定 `quickjs-jit = 0.14.1`，SQLite 编译进宿主。`test` 使用 Node/esbuild 编译 bundle，再交给 Rust QuickJS 进程执行；不在 Node 中执行被测 bundle。另有真正 SIGKILL 后重启的 Durable 验证。

`.env` 配置 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 后运行：

```sh
pnpm --filter @super-looi/nsh-node-compat verify:live
```

这会产生一次真实网关请求。runner 只收到这三个配置，临时凭据文件权限为 0600、结束即删除，网络限定同一 origin，禁止重定向。它的最小 Fetch 设施用于测试；移动产品应使用 NSH 自带的网络对象。

单独重跑实际移动 SDK 与 codemode 验证：

```sh
pnpm --filter @super-looi/nsh-node-compat verify:full-sdk
pnpm --filter @super-looi/nsh-node-compat verify:codemode
```

`audit:transparent-sdk` 单独检查仅使用 Node 别名的桌面根 barrel，保留其真实失败状态；移动 SDK 模式显式选择真实 upstream programmatic exports，并适配桌面设施。它没有承诺桌面 CLI/TUI 能在手机中运行。

消费接口：

- `@super-looi/nsh-node-compat`：`installNodeCompatGlobals()`、同步桥接、SQLite、Shell。
- `@super-looi/nsh-node-compat/bundler`：`nshNodeCompatPlugin()` / `getNshNodeCompatAliases()`；同时处理裸模块与 `node:`，缺失模块直接构建失败。
- `@super-looi/nsh-node-compat/pi-coding-bundler`：显式启用 Pi 1.5.0 headless 内部入口；只限 SessionManager 与七工具。关闭 TUI、图片处理和二进制下载；find/bash 使用注入 Operations，grep 使用 Rust 搜索。不能由此导出完整 SDK。
- `@super-looi/nsh-node-compat/pi-sdk-bundler`：`nshPiSdkPlugin()`，实际 createAgentSession / AgentSession / ModelRuntime / SettingsManager / SessionManager / DefaultResourceLoader 与 skills；组合 codemode、coding-tools 和 Node 插件使用。七个默认工具在真 QuickJS 执行；图片处理明确拒绝，扩展只接受预编译注册，OAuth 需宿主注册深链适配器，没有本机 TCP 回调。
- `@super-looi/nsh-node-compat/codemode-bundler` / `adapters/codemode`：`nshCodemodePlugin()` 解析精确 upstream PRELUDE_SOURCE；`createNshCodemodeSandbox()` 实现上游 portable Remote 协议，但每个 VM 都在本机 Rust 线程内，没有 Wasm 或外部服务。该 adapter 的虚拟 prelude 导入必须经过插件打包。
- `@super-looi/nsh-node-compat/adapters/pi-durable-env`：`NshExecutionEnv`，复用上游文件契约并替换 Shell；`namespace` 必须在同一文件空间内保持一致。
- `@super-looi/nsh-node-compat/adapters/chord-sqlite`：复用 Chord 的队列/事务封装，底层为本包 SQLite 垫片。

宿主可以在同版本 QuickJS `Ctx` 调用 Rust `nsh_node_compat::install(&ctx, app_data_root)`，或用 NSH 原生 class 暴露 `Bridge::request/begin/wait/close`，通过 `@super-looi/nsh-node-compat/native-host` 的 `installNshNativeCompat(host)` 安装相同协议。`apps/nsh` 已注册真实 class，八组测试在 NSH hardened engine（256 MiB）及 iOS 模拟器通过；Android 与业务 App 迁移仍待完成。不能直接在 Expo/Hermes 使用。`files/` 是文件能力根，`sqlite/` 是独立私有数据库目录，`/workspace`、`/home`、`/tmp` 是文件能力根内的虚拟目录。JS 不能借 `node:fs` 读取 SQLite 文件；数据库迁出/备份需由可信宿主完成。

文件上限 16 MiB、目录上限 10,000 条、文件句柄 256、数据库连接 32、watcher 32（每个原生队列 1,024 条，溢出显式失败）。SQLite 单操作约 1 秒、结果最多 10,000 行/16 MiB；Shell 默认 1 秒、最大 30 秒、输出 1 MiB，解析前限制结构字符，未知命令返回 127，未实现参数在操作前拒绝。Shell 支持有限的管道、重定向、与或、变量、子命令与常用内置命令，**不是任意 Bash、系统进程或 Git/Python/npm 环境**。spawn 输出目前在执行完成后交付，取消为合作式；阻塞文件系统 I/O 不具备硬实时抢占保证。

Codemode 同时最多 4 个 VM，默认堆 32 MiB、最大 64 MiB、栈 256 KiB；每次执行/继续最多 250ms 并有 interrupt 预算。桥接输入帧最多 4 MiB，4 个同步 admission permit，单 VM 待处理/乱序结果各 8 MiB，输出消息最多 4096 条/16 MiB；stop 有独立控制入场。确定性模式固定 seed / 虚拟 UTC 时钟，fingerprint 包含 VM/平台/prelude/适配实现及预算。不同 fingerprint 不保证跨平台 replay 一致。Intl.Segmenter 提供 ICU grapheme/word/sentence；当前 locale 为 und，其他 locale 明确拒绝。

未覆盖的 API 会拒绝，例如 `watchFile`、`statfs`、chmod、运行期 require、任意可执行文件与完整 Windows path 语义。异步 FS 包装当前仍在调用线程执行原生同步 I/O；桥接使用 JSON 拷贝，没有“零开销／零拷贝”承诺。native notify 已在 macOS runner 与 iOS 模拟器原生 class 实测，Android 待验收。
