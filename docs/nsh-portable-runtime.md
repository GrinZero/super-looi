# NSH 业务运行时迁移记录

`@super-looi/runtime` 从 Hub 与 Expo 提取 Agent、任务、记忆、ContextPack、视觉策略、48 项验收和纯 UI 状态机。旧路径暂时 re-export 同一实现，便于持续回归；四个原始未提交语音文件保持原状。NSH 页面与音频尚未接线，不能据此删除旧应用。

## 已验证的本机闭环

九组同源套件在 Rust QuickJS runner、NSH hardened engine、iOS 26.3 / iPhone 16e 和 Android 14 / API 34 ARM64 模拟器通过。新增业务套件执行真实 Pi Agent：模型 fixture 发起 write_file 和带重定向的 bash，工具实际读写沙盒文件，生成回读/文件证据，再从 SQLite 重开任务状态。模型没有访问真实网络。

`SqliteRuntimeStore` 接收宿主数据库连接，不依赖 Node 进程。WAL / synchronous FULL 下，记忆快照与追加删除日志在同一事务中提交；任务快照独立更新，未完成任务重启后标记 unknown，不自动重放。会话仍沿用 Pi 文件日志。每份快照上限 2 MiB；超限显式失败。存储失败后记忆服务拒绝继续读写，要求重开，避免把未落盘状态显示为成功。

恢复旧备份先验证嵌套结构和安全整数，再合并当前删除代次、capture epoch、墓碑与推断抑制。墓碑重新撤回派生事实并使上下文失效；旧备份无法撤销用户的推断拒绝。ContextPack 注册原子核对来源 revision、status 与 epoch，删除与异步组装交错时整包拒绝，不返回过期正文。

## 审批边界

原生执行器配置 `approvalUiSessionId`，允许一次的应答必须带当前会话中 30 秒内的 tap/gesture；缺失、语音来源、过期、跨会话与已用 event_id 均拒绝。`requireApprovalForAllWrites` 还对全部 bash 调用审批，因为重定向与参数无法通过危险命令正则可靠分类。测试实际尝试这些拒绝路径，并验证两个不同 UI 动作才执行文件写入和 Shell 写入。

旧 Hub 的 Pi 执行器默认配置保留历史行为，未配置 UI session 时不获得这项新门禁。TaskSupervisor 的 grant 路径另有 fresh UI 校验、跨 grant 动作绑定与单次消费，快照保存绑定关系；返回 grant 的副本防止调用方修改内部授权。

## 验收含义

原先 C02/C05、D05、H01–H06 的常量通过项已替换成真实软件行为断言，包括电视语音审批拒绝、仅关相机、墓碑恢复、轻通知/说话延迟、便携态、三链路状态和降载策略。视觉模型与温控输入仍使用明确的策略 fixture；48/48 不等于真实麦克风/AEC、相机模型、蓝牙底座或手机热管理已验收。

全仓 build/typecheck/test 通过，315 项 JS 测试、九组 QuickJS、强杀恢复与 NSH 原生集成通过。独立只读审查发现的审批旁路、Shell 绕行、动作重放、损坏 epoch、上下文删除竞态与推断恢复问题均由主 agent 修复并复验。双端日志见 [iOS](artifacts/nsh-node-compat/ios-native-probe.log) 和 [Android](artifacts/nsh-node-compat/android-native-probe.log)。

剩余工作为 NSH 本机应用接线、安全凭据、真实网络、媒体与硬件、UI、离线 Release 和商店签名；Hub / Expo 归档与删除继续受完整替代门禁约束。
