# NSH 领域迁移软件验收

2026-11-07。用户确认当前只有模拟器，先完成软件验收。Pi 1.5.0、NSH 0.4.0 的基础版本矩阵见 `nsh-native-live-verification.md`。

## 本阶段实现

家居运行时默认关闭，演示模式需要显式选择。HA 使用 HTTPS 与系统安全存储；不同地址不复用令牌。无法识别设备元数据时只读；服务 ACK 不代表设备已生效。MIoT OAuth 核心已接入，移动登录界面仍待完成。

Agent 家居控制经过单次 UI 审批。下发前在同一个 SQLite 数据库保存 intent，完成后保存领域回执。取消使连接代际失效并中止请求；预读后不能继续派发，已经发出的操作无法确认时保留 unknown。任务列表、取消结果与恢复计数均合并领域 unknown；原会话不得继续，新对话保留旧证据。

任务面板提供每页十项的列表和只读详情，展示执行步骤、文件、命令及家居操作证据。新对话更换 session，不删除旧任务。

原生 VoiceAudio 支持显式权限、16kHz PCM 采集、24kHz PCM 播放、有界队列、静音及背压。iOS 原生通知处理后台/中断/路由变化，Android 原生线程检查锁存的失焦状态。重新获得焦点不会恢复旧音频。Android manifest 和 Application 均由 app 自有插件合并；没有修改 Expo prebuild 产物。

## 已执行验证

- 真 QuickJS：家居 fixture、实际 Agent 审批与演示控制、SQLite 回执重开、intent-only 中断边界、unknown 会话阻断、新对话隔离均通过。
- 独立 Sol 复审：取消穿透、领域 unknown、原生生命周期与队列清理问题修复后通过。
- 原生音频七项 Rust 测试及 iOS Simulator / Android ARM64 实际交叉检查通过。
- 双端模拟器兼容探针：新增家居 fixture、系统凭据 CRUD、原生静音 PCM enqueue/clear/stop 均通过。Android 还运行了 Agent 家居证据重开测试；后续统一最终代码再次复验。
- 双端十二套原生探针全部通过；新增语音 fixture 覆盖权限、握手、PCM、打断旧响应、重复工具与迟到连接隔离。
- NSH 十项测试通过，含七项音频 Rust 测试、两项真实 engine 测试和界面测试。
- Android manifest 插件测试验证保留既有权限、增量添加录音/音频设置权限、重复合并无重复节点。

全仓 `pnpm build`、`pnpm typecheck`、`pnpm test` 通过：323 项 JavaScript 测试和 10 项 NSH 测试。软件通过不等同物理设备验收。

## 尚未完成

MIoT 登录界面、实时语音真实服务、BLE 桥及旧数据迁移继续推进。双端家居/任务界面已通过实际输入验收。实时语音协议及共享 Agent 的 UI 确认流程已通过 fixture；取消后只在服务确认取消时恢复输出，无确认则四秒后结束会话，实际服务双端原生测试确认使用 `response.canceled`（单个 l），实现已兼容该事件。双端各接收 247808 字节合成 PCM 并确认取消，未开启麦克风或写入产品凭据；证据见 `artifacts/nsh-node-compat/voice-native-audit.json`。合成语音输入至实际 Agent 查询本机记忆再生成原生 PCM 回复已在双端通过（iOS 55296 字节，Android 75776 字节，各一次工具调用）；产品 UI 确认单独由 fixture 和审查覆盖。真实麦克风与 AEC 效果仍未验收。静音输出验证不代表麦克风、外放 AEC、物理 BLE 或底座验收。Hub/Expo 删除门禁仍未满足。
