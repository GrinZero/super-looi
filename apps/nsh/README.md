# Super LOOI NSH host

固定 NSH 0.4.0 / `e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3` 的 Rust + TSX 应用。当前交付原生宿主与兼容验证入口；`App.tsx` 仍是初始化模板，LOOI 业务、首屏、语音迁移尚未完成；Android 原生兼容宿主已通过。

```sh
pnpm --filter @super-looi/nsh build
pnpm --filter @super-looi/nsh typecheck
pnpm --filter @super-looi/nsh test
pnpm --filter @super-looi/nsh test:ios
pnpm --filter @super-looi/nsh test:android
```

脚本使用 `.env` 中可选的 `NSH_CLI_PATH`，并校验版本及 revision；没有匹配 CLI 时，在用户缓存目录构建固定源码。需要 Rust、macOS/Xcode（iOS）或 Android SDK/NDK（Android）。固定 NSH 的构建依赖需要 Rust 1.97+；本机使用 1.99.1。测试用 Rolldown 内部 crate 与固定 NSH 锁文件对齐，防止 1.2/1.3 混装造成 API 缺失。

`super-looi/native` 注册真实 `NodeCompat` class：构造时读取宿主 `System.data_dir` 并验证 FS read/write grant，JS 不接收宿主路径。同步 `request` 保留文件/SQLite 同步语义；同步 `begin` 完成资源入场，异步 `wait` 消费单次票据。Shell 和 codemode 在原生线程执行，NSH engine 等待 oneshot，不需要额外 Tokio runtime。关闭实例会取消 actor、释放 fd/watch/数据库；正常 codemode.close 先等待 VM 停止回执。

`CompatProbe.tsx` 调用同一套九组兼容与业务测试，包括 Pi 四包、实际 createAgentSession 七工具和 codemode。Rust 集成测试配置真正的 NSH engine、私有临时目录、发布态 hardening 与默认 256 MiB embedding 配额；iOS 脚本在真实模拟器中等待成功状态。标准 TSX headless `open` 没有真实数据目录，因此磁盘能力测试在显式配置的 Rust host 或移动宿主中执行。

预编译测试入口需要压缩：未压缩的完整测试包导致 iOS 开发连接反复断开；开发客户端使用 WebSocket 默认的 16 MiB frame 上限，压缩后通过。消息体过大是基于源码与对照实验的推断，未做逐字节抓包。生成物位于 `generated/`，不提交、不进入默认 App 发布入口。

Android API 34 ARM64 模拟器也通过九组测试，Release APK 编译两种 ARM ABI，当前仍为 debug 签名。尚未把模拟器结果视作真实模型网络、系统安全存储、麦克风/AEC、BLE、LOOI UI 或签名发行验收；Hub 保留至计划的全部替代门禁满足。
