# NSH 手机应用基础落地

`apps/nsh/App.tsx` 已替换计数器模板。主 agent 直接实现主题、控件、圆眼 Canvas、文字输入、完整回复、审批/问答和本机应用 store；旧 Hub / Expo 继续保留，完整迁移尚未完成。

## 接线与真实验证

业务 bundle 与兼容验收 bundle 分离。App 启动绑定真实 NodeCompat、SQLite 记忆/任务和 Pi 执行器；“记住／回忆／忘记”在本机执行，普通对话需要配置模型。进程重启将未完成任务置 unknown 并提示待核实，不自动重放。模型服务地址只接受 HTTPS；更换服务 origin 必须重新提供 Key，界面只读取已配置标记。

iPhone 16e / iOS 26.3 横屏真实 UI 已完成设置打开/关闭、中文输入、记住→回忆→忘记。初版横屏弹窗内容溢出已修为有界滚动、固定可见关闭按钮、键盘避让和宽屏双栏设置；长回复可展开完整阅读。Android 14 / API 34 ARM64 也经独立系统 UiAutomation 完成实际点击、中文输入及同一离线记忆闭环。

固定 NSH Android TestAgent 的 `type/key` 从底层 `host.getRootView().findFocus()` 取焦点，漏掉 Dialog 窗口，不能据它的输入失败判定业务失败。独立 `com.superlooi.nsh.uitest` instrumentation APK 使用 Android 系统输入/可访问性 API验证真实窗口；它不进入产品 APK，不调用 app 的业务私有方法。`pnpm --filter @super-looi/nsh test:ui:android` 自动构建测试 APK、启动当前设备上的开发宿主，结束只停止自己创建的进程组。

截图：[iOS 首页](artifacts/nsh-node-compat/ios-face.png)、[iOS 连接](artifacts/nsh-node-compat/ios-settings.png)、[Android 首页](artifacts/nsh-node-compat/android-face.png)、[Android 离线记忆](artifacts/nsh-node-compat/android-offline-memory.png)。

## 系统安全存储与构建插件

CredentialVault 的 iOS Keychain WhenUnlockedThisDeviceOnly 与 Android Keystore AES-GCM 写入、重开、更新、删除已在真实模拟器运行。Android 加密密钥不导出，AAD 绑定槽位，700/600 文件位于 NodeCompat 文件根之外，进程锁覆盖密钥初始化及 CRUD。验证只用保留的 probe 槽，不读取/修改 model 凭据。

app 自有 `native/plugins.json` 注册两个构建适配：iOS 模拟器按 Xcode Simulated.xcent 约定嵌入 `__TEXT,__entitlements`；Android Application 通过标准 JNI 登记 JVM。模拟器身份仅用于开发宿主，真机仍需真实签名配置。Android 局部 SDK overlay 在原签名之前执行插件，不改全局 SDK、NSH 源码或 Expo prebuild。

Android manifest 按 binary XML 增量修改 application name/allowBackup，其他权限、图标/资源、组件、intent-filter 保留；有归属和 hash 的空闲 classesN.dex 支持重复应用。真实 aapt2 回归覆盖资源引用、附加权限/服务/元数据、已有 classes2.dex 和二次应用。`.env` 仅工具链白名单进入构建环境，SDK 路径切换会刷新受控 symlink。

## 停止与审批

当前严格本机模式的写文件、Shell 和记忆修改要求当前 UI 会话的新鲜动作。审批显示明确动作；覆盖文件可审阅完整写入内容，记住与删除不混用描述。缺失、语音来源、过期、跨会话和动作重放仍拒绝。

补查修复了旧 Pi 取消的虚假退出回执：等待 Agent idle 超时不再硬编码 runtimeExited=true；非配合工具保留 unknown/false，close 有界失败，停止后的新工具被阻止。真实上游 Agent + 非配合工具回归及双端 QuickJS 原生业务套件通过。全仓 build/typecheck/test 通过，316 项 JS 测试与九组 QuickJS、NSH 集成均通过。软件退出回执不代表物理底座停止延迟，后者仍需独立硬件证据。

独立只读审查发现的并发凭据写入、manifest/DEX 保留、长回复截断、审批信息和干净启动 bundle 生成问题均已修复。兼容与业务已有九组原生套件，48 项为软件契约，不能替代真实传感器验收。

## 仍在推进

手机真实 fetch/SSE、Agent UI 全工具/取消/重启、语音双工 PCM/AEC、家居/相机/BLE、源事件审计与删除后的派生会话保留策略、离线 Release 和商店签名继续推进。LIVE 按钮尚不可用，麦克风和底座保持未连接；没有用模拟数据冒充这些能力。当前“忘记”为墓碑级逻辑撤回，不声称数据库页/WAL或历史会话的取证擦除。

参考：[NSH 固定 Android TestAgent](https://github.com/longbridge/nsh/blob/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3/crates/nsh-platform-android/java/com/longbridge/nsh/TestAgent.java)、[Apple Keychain entitlement 诊断](https://developer.apple.com/forums/thread/114456)、[Android Keystore 参数](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec)、[security-framework 3.7.0](https://docs.rs/security-framework/3.7.0/security_framework/passwords/index.html)。
