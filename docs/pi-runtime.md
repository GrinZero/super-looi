# Pi 运行时与生态接入

Super-LOOI 使用 Pi 1.5.0 的 `createAgentSession()` 创建执行会话。`AgentSession` 管理模型与工具轮次、自动压缩、错误重试、执行中输入及扩展生命周期。App 的 `PiTaskRunner` 将这些事件接入任务记录、执行预算、原生交互与 observation（执行观测）。

## 资源与工具

App 内部的 Agent 目录为 `/home/agent`，工作区为 `/workspace`；这些路径映射到 App 自己的数据目录。`DefaultResourceLoader` 按 Pi 的规则加载资源：

| 入口 | 用途 |
| --- | --- |
| `/home/agent/settings.json`、`/workspace/.pi/settings.json` | 工具选择、压缩、重试及扩展设置 |
| `AGENTS.md`、`SYSTEM.md`、`APPEND_SYSTEM.md` | 项目规则及系统提示 |
| `skills/*/SKILL.md` | 先提供技能名称与说明，正文按需读取；支持 `/skill:名称` |
| `prompts/*.md` | 标准提示模板、参数展开及 `/模板名` |
| `extensions/` 与扩展工厂 | 官方事件、工具、命令和会话状态接口 |
| Agent 目录 `mcp.json` | 官方 MCP 服务配置与工具暴露方式 |

项目资源放在 `/workspace/.pi/`，个人资源放在 `/home/agent/` 下相应目录。文件工具使用 Pi 标准 `read`、`write`、`edit`；`bash` 使用 Pi 的参数与输出处理，通过 `BashOperations` 在手机 Shell 执行。App 的提问、家居与底座能力按标准自定义工具注册。`ls`、`find`、`grep` 可通过 Pi 设置启用。

MCP、`tool_search` 和 `codemode` 使用官方扩展工厂。MCP 的 `exposure: "deferred"` 让模型通过工具搜索按需启用工具；codemode 通过标准工具管线调用嵌套工具，因此保留审批与执行观测。NSH 将 codemode 的 VM（虚拟机）接口接到 Rust QuickJS，资源发现、工具定义和调度仍由 Pi 提供。

移动端扩展通过现有预编译模块注册器或扩展工厂加载，采用 Pi 的扩展 API。扩展的 `select`、`confirm`、`input` 和 `editor` 映射到 App 原生交互，通知进入任务记录；终端自定义组件需要对应的原生界面适配。MCP OAuth 的令牌保存及刷新使用 App 数据目录；首次浏览器授权仍需接通 App 的 deep link（深层链接）回调注册和授权界面。

## 会话与记忆

| 数据 | 所有者与保存方式 |
| --- | --- |
| 对话、工具结果、扩展条目、分支和压缩检查点 | Pi `SessionManager`，保存为 `/home/agent/sessions/` 下的 JSONL |
| 当前模型上下文 | Pi 按活动分支和压缩检查点投影，保留摘要与最近消息 |
| 任务状态、审批、Shell 回执和执行观测 | App SQLite |
| 模型凭据与云服务连接 | App 凭据库及原生能力，手机直接连接服务 |
| 跨会话的个人事实 | 需要产品层的记住、纠正、遗忘和检索接口；会话压缩不承担这些职责 |

同一 `sessionId` 的后续任务恢复 Pi 活动分支。语音 `manage_agent_task` 的 `steer` 将补充要求加入当前执行，`follow_up` 将消息加入后续队列；两者直接调用 Pi 接口，任务在会话稳定结束及扩展清理完成后结束。

## 验证入口

- `pnpm --filter @super-looi/runtime test`：资源、工具、原生交互适配、扩展命令、压缩恢复、重试、排队、取消及生命周期。
- `pnpm --filter @super-looi/nsh-node-compat test looi-ecosystem`：真实 Rust QuickJS 中的规则、技能、模板、预编译扩展、codemode、压缩恢复、MCP 工具发现及 OAuth 刷新。
- `pnpm --filter @super-looi/nsh test:voice-runtime`：语音任务受理、执行中补充要求、状态查询与结果交付。
