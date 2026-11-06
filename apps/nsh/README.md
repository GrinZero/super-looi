# Super LOOI NSH app

固定 NSH 0.4.0 / `e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`，Rust typed class + TSX。首页已从计数器模板迁为单 Canvas 圆眼大脸、本机文字对话、完整回复、审批/问答和连接设置。中文记住/回忆/忘记可离线使用；模型配置由手机直连服务，API Key 存系统安全存储。真实模型手机网络仍在验证，LIVE 暂不可用，麦克风/底座状态保持未连接。

```sh
pnpm --filter @super-looi/nsh build
pnpm --filter @super-looi/nsh typecheck
pnpm --filter @super-looi/nsh test
pnpm --filter @super-looi/nsh test:ios
pnpm --filter @super-looi/nsh test:android
pnpm --filter @super-looi/nsh test:ui:ios
pnpm --filter @super-looi/nsh test:ui:android
pnpm --filter @super-looi/nsh ios
```

普通 build/run/check/test/package 自动生成业务 bundle，干净 checkout 直接 ios 不依赖预生成缓存。业务与九组兼容验收 bundle 分开，验收 fixtures 和独立 Android UI 测试 APK 不进入产品入口。生成物在 `generated/` / `.nsh/`，不提交；平台专用生成测试放隐藏 `.nsh/`，避免被普通 headless 测试发现。

脚本从 `.env` 读取 `NSH_CLI_PATH` 并核验版本/revision；没有匹配 CLI 则构建固定源码。仅白名单 Android SDK/NDK/JAVA_HOME 传到构建工具，不把模型/语音 Key 导出或打进 bundle。需要 Rust 1.97+、macOS/Xcode（iOS）或 Android SDK/NDK/JDK；本机 Rust 1.99.1。Rolldown 内部 crate 固定 1.2.13，避免和 1.3 混装。

`NodeCompat` 构造从宿主 System 取得私有目录并校验 grant；JS 不传宿主路径。request/begin 同步入场，wait 单次消费；Shell/codemode 原生线程不依赖 NSH executor 提供 Tokio。`CredentialVault` 使用 iOS Keychain WhenUnlockedThisDeviceOnly，Android 使用不可导出的 Keystore AES-GCM 密钥、槽位 AAD、700/600 私有文件和进程锁。凭据目录不属于 Agent 文件命名空间。

`native/plugins.json` 注册 app 自有构建插件：模拟器用 Xcode 的 `__TEXT,__entitlements` 方式提供测试 Keychain 身份；Android Application 在标准 JNI 入口登记 JVM。app 局部 SDK overlay 在签名前增量修改 binary manifest 的 application name/allowBackup 并加入有归属标记的空闲 DEX；保留原权限、资源、组件和签名参数。未修改 NSH、全局 SDK 或 Expo prebuild。真机签名仍使用真实 provisioning profile，模拟器身份不能用于发行。

九组测试及凭据 CRUD 已在 iOS 26.3 / iPhone 16e 与 Android 14 / API 34 ARM64 模拟器通过。NSH hardened engine 配私有临时目录、256 MiB 配额；普通 headless open 没有真实数据目录，只验证页面交互。iOS 真 UI 完成离线记忆闭环。Android 固定 test driver 忽略 Dialog 的焦点，UI 验证采用独立系统 UiAutomation instrumentation，实际点击、中文输入和回读已通过。

双端媒体/AEC、真实模型网络、家居/相机/BLE、未知任务恢复界面、源事件审计与删除保留策略、离线 Release / 商店签名仍是迁移门禁。Hub / Expo 保留至完整替代。详见 [移动基础记录](../../docs/nsh-mobile-foundation.md)。
