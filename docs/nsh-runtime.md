# NSH 手机运行时

应用以 NSH Rust／QuickJS 和 TSX 运行在 iOS／Android 手机内。当前框架固定为 NSH 0.5.0，Pi 固定为 1.5.0；构建配置见 [应用说明](../apps/nsh/README.md)。手机直接连接模型、实时语音、米家或用户配置的 Home Assistant，应用持有登录流程、凭据与执行状态。

## 模块与数据归属

| 模块 | 职责与入口 |
| --- | --- |
| App 与 store | 横屏界面、页面状态与用户操作，见 [App.tsx](../apps/nsh/App.tsx) 和 [store.ts](../apps/nsh/store.ts) |
| MobileRuntime | 组合任务、存储、家居、语音及底座运行时，见 [application.ts](../apps/nsh/runtime/application.ts) |
| Pi 会话 | 模型与工具轮次、消息队列、压缩及 JSONL 会话，见 [Pi 运行时](pi-runtime.md) |
| SQLite | 任务快照与执行观测等本机数据，见 [存储实现](../packages/looi-runtime/src/storage/sqlite.ts) |
| NodeCompat | QuickJS 所需的 Node API 子集、文件与 SQLite 桥接、codemode 宿主，见 [兼容包说明](../packages/nsh-node-compat/README.md) |
| CredentialVault | iOS Keychain／Android Keystore 支持的凭据存储，见 [credentials.rs](../apps/nsh/src/credentials.rs) |
| Linux Shell | Android PRoot／iOS iSH 的 Alpine 执行环境，见 [Linux Shell](nsh-linux-shell.md) |

Agent 的 `/workspace` 与 `/home/agent` 映射到应用自己的文件空间。Pi JSONL 保存消息、工具结果和压缩检查点；SQLite 保存任务状态与观测。跨会话个人事实的写入、纠正、遗忘与检索仍由产品层另行接通，具体待办见 [todo.md](../todo.md#agent-记忆与上下文管理)。

## 宿主与兼容边界

`NodeCompat` 从 NSH System 取得应用私有目录，JS 通过原生桥接访问文件与数据库。凭据目录与 Agent 文件命名空间分离。原生能力及打包调整由 [native/plugins.json](../apps/nsh/native/plugins.json) 注册的应用插件完成。

Pi SDK 使用 `nshPiSdkPlugin` 选择程序接口并适配手机宿主。扩展采用预编译注册；MCP 首次浏览器授权还需 App deep link（深层链接）回调。支持的 API、资源预算、图片处理与桌面入口限制以 [兼容包说明](../packages/nsh-node-compat/README.md) 为准。App 的开发工具执行路径以 Linux Shell 说明为准，兼容包内置 Shell 的 API 子集单独记录。

## 验证入口与历史证据

构建、开发真机安装和定向验证命令统一在 [应用说明](../apps/nsh/README.md#构建与验证命令)；独立 QuickJS／Rust 检查在 [兼容包说明](../packages/nsh-node-compat/README.md)。设备调试使用横屏开发包。

| 已有证据 | 记录 |
| --- | --- |
| 2026-11-06 兼容层、SDK 与 codemode 初次接入 | [实施记录](archive/nsh-node-compat-implementation.md) |
| 2026-11-07 双端模拟器模型请求、工具循环与阶段 Release 冷启动／持久化 | [原生验证](archive/nsh-native-live-verification.md)；对应记录基于 NSH 0.4.0 |
| 2026-11-07 家居、语音和登录浏览器迁移 | [领域迁移记录](archive/nsh-domain-migration.md) |
| Android Linux 真机执行与 iOS 设备目标构建 | [Linux Shell 验证](nsh-linux-shell-verification.md) |
| OpenAI Agents SDK 会话层、QuickJS 与真实豆包云端音频 | [接入记录](openai-agents-sdk-integration-2026-11-14.md) |

真机采播与 AEC、底座物理动作、相机取帧、MCP 首次授权及发行事项由 [todo.md](../todo.md) 跟踪。历史 Hub／Expo 源码保存在 `archive/legacy-hub-and-expo` 分支，迁移过程文档见 [历史资料索引](archive/README.md)。
