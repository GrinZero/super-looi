# Super LOOI NSH app

固定 NSH 0.5.0 / `f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1`，Rust typed class + TSX。桌宠主页提供圆眼表情、文字对话、LIVE 语音、任务停止与连接入口；管理空间分为模型、语音、家居、底座、任务与设置。Pi Agent Loop 提供文件读写、Shell、用户问答与家居工具；模型由手机直连，模型与语音凭证存系统安全存储。任务与会话保存在本机，支持重开恢复。

应用图标使用 [`assets/brand/super-looi-app-icon.png`](../../assets/brand/super-looi-app-icon.png)；`nsh.json` 的 `icon` 字段供 NSH 打包时生成 iOS `AppIcon` asset catalog 和 Android launcher 图标。[iOS 模拟器桌面截图](../../docs/artifacts/app-icon/ios-home.png)展示安装后的图标。

## 模拟器开发

模拟器开发使用 `pnpm --filter @super-looi/nsh exec node --import tsx scripts/nsh.ts dev --target ios --release`。启动脚本为固定 NSH CLI 应用依赖监听补丁，首次编译后缓存；只有入口、已导入文件、主题和应用配置变化触发重建。业务源码由 esbuild 增量编译为独立的 `generated/looi-runtime.dev.js`；测试探针和普通 build/check/test 的生成物不会覆盖该文件。相同内容不会重复写入，压缩开发模式在业务产物变化后整页重载。

## 真机运行与打包

根目录安装依赖并执行 `pnpm build` 后，使用连接的手机运行开发版本：

```sh
# Android：序列号由 adb devices 查看。
pnpm --filter @super-looi/nsh exec node --import tsx scripts/nsh.ts run --target android --device "<ADB_SERIAL>"
# iPhone：设备标识由 xcrun devicectl list devices 查看。
pnpm ios --device "<IPHONE_UDID>"
```

iPhone 在根目录 `.env` 配置 `IOS_SIGN_IDENTITY` 与 `IOS_PROVISIONING_PROFILE`。脚本会打包签名，再通过 `devicectl` 安装和运行；无设备参数的 `pnpm ios` / `pnpm mobile` 会提示指定真机。Android 运行使用 NSH 开发宿主。

生成带项目图标的应用包：

```sh
pnpm --filter @super-looi/nsh exec node --import tsx scripts/nsh.ts package --target android
pnpm --filter @super-looi/nsh exec node --import tsx scripts/nsh.ts package --target ios --sign "<SIGN_IDENTITY>" --profile "/absolute/path/to/profile.mobileprovision"
```

Linux Shell 的构建依赖和平台实现见 [Linux Shell 说明](../../docs/nsh-linux-shell.md)。

## 构建与验证命令

```sh
pnpm --filter @super-looi/nsh build
pnpm --filter @super-looi/nsh typecheck
pnpm --filter @super-looi/nsh test
pnpm --filter @super-looi/nsh test:voice-runtime
pnpm --filter @super-looi/nsh test:wake:ios
pnpm --filter @super-looi/nsh test:plugins
pnpm --filter @super-looi/nsh test:ios --device "<IPHONE_UDID>"
pnpm --filter @super-looi/nsh test:android --device "<ADB_SERIAL>"
pnpm --filter @super-looi/nsh test:live:ios
pnpm --filter @super-looi/nsh test:live:android
pnpm --filter @super-looi/nsh test:live:sdk:ios
pnpm --filter @super-looi/nsh test:live:sdk:android
pnpm --filter @super-looi/nsh test:ui:ios
pnpm --filter @super-looi/nsh test:ui:android
pnpm --filter @super-looi/nsh ios --device "<IPHONE_UDID>"
```

在「语音」空间保存当前 Realtime 服务的 API Key 后，Hey LOOI 自动唤醒默认开启（仍可在「会话控制」手动关闭）。默认服务为豆包 Duplex V3；在根目录 `.env` 设置 `VOICE_PROVIDER=openai` 后构建，可使用 OpenAI Realtime 协议适配器。前台待机时，Rust 音频线程把 16 kHz PCM 交给本机 sherpa-onnx KWS 工作线程；命中后沿用同一硬件音频流建立 Realtime 会话，播放就绪双音，再开始上行。会话在回复真正播完后继续聆听，12 秒无人说话便关闭 WebSocket 并回到本地待机。进入后台或米家登录时停止麦克风，返回前台后恢复已启用的自动唤醒。

移动端构建自动运行 `scripts/prepare-sherpa-kws.mjs`，固定使用 sherpa-onnx v1.12.26 与中英双语 KWS 模型，缓存于 `~/.cache/super-looi/sherpa-onnx/v1.12.26/`。iOS 真机与模拟器静态链接模型推理库；Android APK 注入对应 ABI 的两个动态库并保持 16 KB 对齐。`test:wake:ios` 在模拟器上加载真实模型，检查待机、切流与提示音。

普通 build/run/check/test/package 自动生成业务 bundle，干净 checkout 直接 ios 不依赖预生成缓存。业务与十组兼容验收 bundle 分开，验收 fixtures 和独立 Android UI 测试 APK 不进入产品入口。生成物在 `generated/` / `.nsh/`，不提交；平台专用生成测试放隐藏 `.nsh/`，避免被普通 headless 测试发现。

脚本从 `.env` 读取 `NSH_CLI_PATH` 并核验版本/revision；没有匹配 CLI 则构建固定源码。仅白名单 Android SDK/NDK/JAVA_HOME 传到构建工具，不把模型/语音 Key 导出或打进 bundle。需要 Rust 1.97+、macOS/Xcode（iOS）或 Android SDK/NDK/JDK；本机 Rust 1.99.1。Rolldown 内部 crate 固定 1.2.13，避免和 1.3 混装。

`NodeCompat` 构造从宿主 System 取得私有目录并校验 grant；JS 不传宿主路径。request/begin 同步入场，wait 单次消费；Shell/codemode 原生线程不依赖 NSH executor 提供 Tokio。`CredentialVault` 使用 iOS Keychain WhenUnlockedThisDeviceOnly，Android 使用不可导出的 Keystore AES-GCM 密钥、槽位 AAD、700/600 私有文件和进程锁。凭据目录不属于 Agent 文件命名空间。

`native/plugins.json` 注册 app 自有构建插件：模拟器用 Xcode 的 `__TEXT,__entitlements` 方式提供测试 Keychain 身份；Android Application 在标准 JNI 入口登记 JVM。app 局部 SDK overlay 在签名前增量修改 binary manifest 的 application name/allowBackup 并加入有归属标记的空闲 DEX；保留原权限、资源、组件和签名参数。原生变更由 app 自有插件处理。真机签名仍使用真实 provisioning profile，模拟器身份不能用于发行。

十组测试及凭据 CRUD 已在 iOS 26.3 / iPhone 16e 与 Android 14 / API 34 ARM64 模拟器通过。NSH hardened engine 配私有临时目录、256 MiB 配额。`App.tsx` 整页测试在 `tests/app_ui.rs` 中通过 Rust `Headless` 配置私有临时目录；普通 TSX headless `open()` 不提供数据目录，`App.test.tsx` 仅测试不依赖原生存储的国际化格式化。Android 固定 test driver 忽略 Dialog 的焦点，UI 验证采用独立系统 UiAutomation instrumentation，实际点击、中文输入和回读已通过。

当前应用不依赖 Hub 或 Expo。旧端归档于 `archive/legacy-hub-and-expo`。LOOI 底座已通过 iOS / Android 原生 BLE 桥接接入；双端媒体/AEC、相机与商店签名等后续工作见根目录 [todo.md](../../todo.md)。模拟器 Release 冷启动和持久化记录见 [原生网络与版本复验](../../docs/nsh-native-live-verification.md)。

## 家居连接

在管理空间「家居」的服务绑定面板中配置：

- **米家直连**：选择账号所属地区，在登录页完成小米账号授权，再刷新设备。手机直接访问 MIoT 服务。
- **Home Assistant**：填写手机可访问的 **HTTPS** 实例地址，以及在 Home Assistant「个人资料 → 安全」创建的长期访问令牌，点击连接。地址和令牌在应用内保存。
- **离线演示**：启用演示设备后即可体验房间分类与设备卡片；操作改变本地演示状态。

如需在本机部署 Home Assistant，可运行 `docker compose -f docker-compose.home.yml up -d`，并为手机提供可访问的 HTTPS 入口。使用 HA 接入米家时，在 HA 中添加 Xiaomi Home 集成。米家直连与 HA 的设备由应用聚合到家居空间。

## 开发观测

在根目录 `.env` 设置 `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY` 与 `LANGFUSE_SECRET_KEY`。Android 真机开发运行（`run --target android --device <serial>`）会检查 Langfuse 健康端点：服务运行时自动开启上报，本机地址自动通过 ADB 转发对应端口；服务不可用时关闭本次启动的上报。其他平台的开发运行通过 `LOOI_DEBUG_TELEMETRY=1` 开启。开发运行将语音会话、模型请求与工具执行通过 OTLP 发送到 Langfuse；语音发起的 Agent 任务通过 Trace Context（追踪上下文）关联。

本地 Langfuse 可通过 `docker compose -f docker-compose.langfuse.yml up -d` 启动，`LANGFUSE_BASE_URL` 需填写手机可访问的地址，并符合 `nsh.json` 的网络能力配置。通过上面的 Android 开发运行命令或 `pnpm ios --device "<IPHONE_UDID>"` 启动。显式执行 `scripts/nsh.ts package` 的发布打包不包含开发观测凭证。
