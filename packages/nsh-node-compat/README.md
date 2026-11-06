# @super-looi/nsh-node-compat

NSH v0.4.0 同版本 QuickJS 的独立兼容包与验证宿主。当前交付的是经过测试的 Node API 子集，**不是完整 Node.js，也未完成手机 App 迁移**。完整 SDK / codemode / 双端宿主门禁尚未通过，见 [实施记录](../../docs/nsh-node-compat-implementation.md)。

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

以下命令保留失败状态，不能将默认测试通过当作它们通过：

```sh
pnpm --filter @super-looi/nsh-node-compat verify:full-sdk
pnpm --filter @super-looi/nsh-node-compat verify:codemode
```

消费接口：

- `@super-looi/nsh-node-compat`：`installNodeCompatGlobals()`、同步桥接、SQLite、Shell。
- `@super-looi/nsh-node-compat/bundler`：`nshNodeCompatPlugin()` / `getNshNodeCompatAliases()`；同时处理裸模块与 `node:`，缺失模块直接构建失败。
- `@super-looi/nsh-node-compat/pi-coding-bundler`：显式启用 Pi 1.5.0 headless 内部入口；只限 SessionManager 与七工具。关闭 TUI、图片处理和二进制下载；find/bash 使用注入 Operations，grep 使用 Rust 搜索。不能由此导出完整 SDK。
- `@super-looi/nsh-node-compat/adapters/pi-durable-env`：`NshExecutionEnv`，复用上游文件契约并替换 Shell；`namespace` 必须在同一文件空间内保持一致。
- `@super-looi/nsh-node-compat/adapters/chord-sqlite`：复用 Chord 的队列/事务封装，底层为本包 SQLite 垫片。

宿主先在同版本 QuickJS `Ctx` 调用 Rust `nsh_node_compat::install(&ctx, app_data_root)`，再执行带 polyfill 引导的 bundle。现有代码**尚未注册到 NSH mobile native module / embedding 宿主**，不能直接在 Expo/Hermes 中使用。`files/` 是文件能力根，`sqlite/` 是独立私有数据库目录，`/workspace`、`/home`、`/tmp` 是文件能力根内的虚拟目录。JS 不能借 `node:fs` 读取 SQLite 文件；数据库迁出/备份需由可信宿主完成。

文件上限 16 MiB、目录上限 10,000 条、文件句柄 256、数据库连接 32、watcher 32（每个原生队列 1,024 条，溢出显式失败）。SQLite 单操作约 1 秒、结果最多 10,000 行/16 MiB；Shell 默认 1 秒、最大 30 秒、输出 1 MiB，解析前限制结构字符，未知命令返回 127，未实现参数在操作前拒绝。Shell 支持有限的管道、重定向、与或、变量、子命令与常用内置命令，**不是任意 Bash、系统进程或 Git/Python/npm 环境**。spawn 输出目前在执行完成后交付，取消为合作式；阻塞文件系统 I/O 不具备硬实时抢占保证。

未覆盖的 API 会拒绝，例如 `watchFile`、`statfs`、chmod、运行期 require、任意可执行文件与完整 Windows path 语义。异步 FS 包装当前仍在调用线程执行原生同步 I/O；桥接使用 JSON 拷贝，没有“零开销／零拷贝”承诺。native notify 仅在当前 macOS 宿主实测，手机端仍需单独验收。
