# Pi SessionManager 接入

## 行为

会话消息采用 Pi 1.5.0 的 `SessionManager` 写入 `/home/agent/sessions/<timestamp>_<sessionId>.jsonl`。用户消息、模型消息与工具结果在 `message_end`（消息结束）时追加；任务失败或取消不撤销已保存消息。后续任务按 session ID 和工作目录查找文件，并通过 `buildSessionContext()` 恢复活动分支。

旧 `<sessionId>.json` 不读取、不迁移；同 ID 的下一轮普通请求创建新的 JSONL。显式恢复任务必须存在对应的 JSONL。

## 职责与取舍

`PiTaskRunner` 拥有单次执行的 `SessionManager`，直接接入消息事件。删除 `SessionTranscriptStore`，避免增加只透传 Pi API 的包装类。`PiAgentExecutor` 仅提供会话目录，继续负责任务准入和会话互斥；SQLite 继续保存任务快照和观测。

runtime 增加与现有 Pi 包一致的 `@earendil-works/pi-coding-agent@1.5.0` 直接依赖，用于标准会话格式、消息追加和上下文重建。代价是引入该包的依赖；NSH 使用现有 SDK bundler（打包适配器）选择程序接口，并接入现有 headless（无终端界面）适配器排除桌面工具下载模块，复用现有 QuickJS 的文件系统适配。

## 实施步骤

- [x] 替换自定义 JSON 会话存储，按消息结束事件持久化。
- [x] 更新搜索引用测试与 QuickJS 执行器验证，覆盖新会话和恢复。
- [x] 验证多轮、重启、失败／取消已结束消息及旧格式断开。
- [x] 类型检查、构建、独立 review，更新架构说明并提交。
