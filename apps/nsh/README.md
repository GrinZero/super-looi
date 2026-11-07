# Super LOOI NSH app

固定 NSH 0.4.0 / `e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`，Rust typed class + TSX。首屏提供圆眼大脸、文字对话、LIVE 语音、任务停止与连接设置。最简 Pi Agent Loop 提供文件读写、Shell 和用户问答；模型由手机直连，模型与语音 API Key 存系统安全存储。任务与会话保存在本机，支持重开恢复。

```sh
pnpm --filter @super-looi/nsh build
pnpm --filter @super-looi/nsh typecheck
pnpm --filter @super-looi/nsh test
pnpm --filter @super-looi/nsh test:voice-runtime
pnpm --filter @super-looi/nsh test:wake:ios
pnpm --filter @super-looi/nsh test:plugins
pnpm --filter @super-looi/nsh test:ios
pnpm --filter @super-looi/nsh test:android
pnpm --filter @super-looi/nsh test:live:ios
pnpm --filter @super-looi/nsh test:live:android
pnpm --filter @super-looi/nsh test:live:sdk:ios
pnpm --filter @super-looi/nsh test:live:sdk:android
pnpm --filter @super-looi/nsh test:ui:ios
pnpm --filter @super-looi/nsh test:ui:android
pnpm --filter @super-looi/nsh ios
```

在「语音」空间保存豆包 API Key 后，可开启 Hey LOOI 自动唤醒。前台待机时，Rust 音频线程把 16 kHz PCM 交给本机 sherpa-onnx KWS 工作线程；命中后沿用同一硬件音频流建立 Realtime 会话，播放就绪双音，再开始上行。会话在回复真正播完后继续聆听，12 秒无人说话便关闭 WebSocket 并回到本地待机。进入后台或米家登录时停止麦克风，返回前台后恢复已启用的自动唤醒。

移动端构建自动运行 `scripts/prepare-sherpa-kws.mjs`，固定使用 sherpa-onnx v1.12.26 与中英双语 KWS 模型，缓存于 `~/.cache/super-looi/sherpa-onnx/v1.12.26/`。iOS 真机与模拟器静态链接模型推理库；Android APK 注入对应 ABI 的两个动态库并保持 16 KB 对齐。`test:wake:ios` 在模拟器上加载真实模型，检查待机、切流与提示音。

普通 build/run/check/test/package 自动生成业务 bundle，干净 checkout 直接 ios 不依赖预生成缓存。业务与十组兼容验收 bundle 分开，验收 fixtures 和独立 Android UI 测试 APK 不进入产品入口。生成物在 `generated/` / `.nsh/`，不提交；平台专用生成测试放隐藏 `.nsh/`，避免被普通 headless 测试发现。

脚本从 `.env` 读取 `NSH_CLI_PATH` 并核验版本/revision；没有匹配 CLI 则构建固定源码。仅白名单 Android SDK/NDK/JAVA_HOME 传到构建工具，不把模型/语音 Key 导出或打进 bundle。需要 Rust 1.97+、macOS/Xcode（iOS）或 Android SDK/NDK/JDK；本机 Rust 1.99.1。Rolldown 内部 crate 固定 1.2.13，避免和 1.3 混装。

`NodeCompat` 构造从宿主 System 取得私有目录并校验 grant；JS 不传宿主路径。request/begin 同步入场，wait 单次消费；Shell/codemode 原生线程不依赖 NSH executor 提供 Tokio。`CredentialVault` 使用 iOS Keychain WhenUnlockedThisDeviceOnly，Android 使用不可导出的 Keystore AES-GCM 密钥、槽位 AAD、700/600 私有文件和进程锁。凭据目录不属于 Agent 文件命名空间。

`native/plugins.json` 注册 app 自有构建插件：模拟器用 Xcode 的 `__TEXT,__entitlements` 方式提供测试 Keychain 身份；Android Application 在标准 JNI 入口登记 JVM。app 局部 SDK overlay 在签名前增量修改 binary manifest 的 application name/allowBackup 并加入有归属标记的空闲 DEX；保留原权限、资源、组件和签名参数。原生变更由 app 自有插件处理。真机签名仍使用真实 provisioning profile，模拟器身份不能用于发行。

十组测试及凭据 CRUD 已在 iOS 26.3 / iPhone 16e 与 Android 14 / API 34 ARM64 模拟器通过。NSH hardened engine 配私有临时目录、256 MiB 配额；普通 headless open 没有真实数据目录，只验证页面交互。Android 固定 test driver 忽略 Dialog 的焦点，UI 验证采用独立系统 UiAutomation instrumentation，实际点击、中文输入和回读已通过。

当前应用不依赖 Hub 或 Expo。旧端归档于 `archive/legacy-hub-and-expo`。双端媒体/AEC、BLE 原生接线、相机与商店签名等后续工作见根目录 [todo.md](../../todo.md)。模拟器 Release 冷启动和持久化记录见 [原生网络与版本复验](../../docs/nsh-native-live-verification.md)。
