# 飞书插件实施方案

飞书插件提供三条路径：LOOI 可以读写飞书云文档，飞书用户可以在单聊或群里发起和继续 Agent 任务，LOOI 可以按用户的自然语言规则把任务结果发到飞书。插件复用 Super LOOI 的插件宿主、Pi Agent 和任务记录。首版以单个飞书企业自建应用、单台 LOOI 接收设备为试点。

## 用户体验

| 场景 | 首版行为 |
| --- | --- |
| 飞书单聊 | 绑定用户直接向 LOOI 发消息。Agent 在原单聊回复，后续消息沿用该单聊的任务上下文。 |
| 飞书群聊 | 在已启用的群里 `@LOOI` 发起任务，LOOI 在引用或话题中回结果。开启普通回复权限后，直接引用 LOOI 的任务回复也可继续。 |
| 读取和写入云文档 | 从 App 或飞书提交文档链接，读取 Docx 和 Wiki 中的 Docx。支持创建文档、追加内容、定点更新指定段落，写完返回链接。用户直接发起的文档任务遵循所选身份的资源权限。 |
| 从语音发起，结果发飞书 | 用户可说「这次把调研结果发飞书给我，别念」，也可在插件设置写长期偏好，例如「调研报告和每日摘要发给我的飞书私聊。普通问答照常说。」命中的任务结果发文字，屏幕显示投递状态。 |

## 飞书连接和文档工具

- 在 `apps/nsh/plugins/feishu/` 新增内置插件，沿用 `manifest.ts`、`runtime/`、`ui/` 和插件设置桥接。设置显示应用连接、用户文档授权、可触发的群和人员、默认收件会话、普通回复权限、规则预览和最近一次投递结果。停用插件时通过 `EffectScope` 关闭连接并停止接收新任务。复用 App 的 `Vault` 保存应用密钥和用户 OAuth 凭据，配置和投递记录放现有 SQLite。 [内置插件注册](../../apps/nsh/plugins/registry.ts) · [插件宿主契约](../../apps/nsh/runtime/plugins/contracts.ts) · [凭据接口](../../apps/nsh/runtime/vault.ts)
- App 直接调用飞书 OpenAPI。以官方 `lark-cli` 的文档读取、创建、更新作为行为参考，提供结构化 `feishu_doc_read`、`feishu_doc_create`、`feishu_doc_update`。解析 Wiki 节点后读取对象类型和标识，写入支持的 Markdown 内容并保留段落结构。新建分成创建文档、写入内容两步，保留已创建文档 ID 和实际写入结果，便于重试；修改已有文档时用块 ID 和修订版本定位变更。 [飞书 CLI 文档技能](https://github.com/larksuite/cli/blob/main/skills/lark-doc/SKILL.md) · [创建文档](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/create) · [Markdown 转换为文档块](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/document/convert)
- 发消息和收事件用应用身份。个人文档操作用当前用户授权，绑定到飞书应用、租户和用户身份；群任务可操作配置给该群的、机器人已有权限的文档。使用个人授权的文档任务在 App 或绑定用户的飞书单聊运行。群里收到个人文档请求时，提示用户转到单聊，或改用该群已配置的共享文档。身份、缺失的应用权限、资源权限不足和授权过期分别反馈。 [飞书访问凭证](https://open.feishu.cn/document/server-docs/api-call-guide/calling-process/get-access-token) · [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)

## 飞书触发 Agent

1. **接收。** 企业自建应用启用机器人并订阅 `im.message.receive_v1`。先在 NSH 验证 SDK 长连接与现有网络传输的兼容性，由 App 持有连接。回调校验应用和租户、过滤非用户消息，按 `app_id + tenant_key + message_id` 去重，持久化受理后在平台的 3 秒窗口内应答。Agent 异步运行。设置页显示连接和重连状态。飞书把同一应用的事件发给其中一个连接，试点为每个应用配置一台接收设备。 [接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive.md) · [飞书长连接](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-events.md)
2. **触发。** 单聊接受绑定用户消息，群聊只在已绑定的群和发送人范围内触发。基础模式接收用户 `@LOOI` 的消息。普通引用回复通常没有 `@`，按飞书文档需要开通接收群内用户消息的权限。启用后在入口只保留 `@LOOI`、引用 LOOI 已发任务回复或已关联话题中的用户消息，其他群消息直接丢弃。先在真实普通群和话题群分别测试 `parent_id`、`root_id`、`thread_id`，再开放该配置。 [接收权限和事件字段](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive.md) · [回复关系](https://open.feishu.cn/document/server-docs/im-v1/message/intro)
3. **执行。** 为 `AgentRuntime` 增加带飞书调用者和来源上下文的后台入口，复用 `PiAgentExecutor` 和现有 `plugin` 执行通道。现有 `runPluginBackgroundTask` 每次生成随机会话 ID，并会直接结束交互，因此需让飞书入口传入稳定的会话 ID 和工具范围。会话按应用、租户、私聊或群话题隔离，同一会话顺序执行，未完成的追问入队。飞书运行只暴露属于该来源的飞书工具和通用检索工具，使用独立上下文，避免将本机 shell、设备控制、其他插件凭据和本地私聊上下文带入飞书。 [AgentRuntime](../../apps/nsh/runtime/agent/runtime.ts) · [任务执行参数](../../packages/looi-runtime/src/agent/executor.ts) · [Pi 工具组装](../../packages/looi-runtime/src/agent/core/pi-task-runner.ts)
4. **回发。** 每条有效指令独立生成任务 ID；收到时简短确认，完成后用 `message.reply` 回到引用或话题，保存出站消息 ID 供追问使用。模型需要补充信息时把问题发回同一个会话，并将原发起人对该问题的回复关联到待处理的交互。任务状态与投递状态分别记录，发送重试只处理投递，并采用稳定的 `uuid`。飞书的 `uuid` 去重窗口为一小时，超窗且发送结果未知时，先核对上次投递结果，再决定是否重发。 [回复消息与去重窗口](https://open.feishu.cn/document/server-docs/im-v1/message/reply.md)

试点以选定 LOOI 设备保持 App 运行且在线为前提。真机分别验证前台、锁屏、暂停和进程退出，按实际结果标注可用状态。若后续要求 App 被系统挂起或关闭时也实时接单，需单独确定常在线运行位置。HTTP Webhook 能接收飞书事件，Agent 执行位置、凭据归属和经授权的能力仍需一起设计。 [飞书事件接收方式](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-events.md)

## 通过提示词配置投递

用户在「飞书插件 → 回复与通知」保存自然语言规则，App 将其解析为可以预览的消息类型和投递目标，例如「调研结果 → 我的飞书私聊」「每日摘要 → 已绑定的项目群」。首版匹配语音委派任务结果和有通知的定时摘要，消息类型取任务来源及标签，规则同时命中时按设置页顺序取第一条。未能确定类别或绑定目标时，编辑页指出哪一条需要补充。可用已配置的私聊或群，群名只用于显示，保存时绑定真实会话 ID。

运行时在**进入语音播放队列之前**选择渠道。飞书发起的任务回原会话。LOOI 本地发起的任务依次取本次明确指定、已保存规则和现有语音策略。渠道一旦决定，发送端按选定渠道交付。飞书投递使用原始结果正文，保留链接和必要的 Markdown，语音继续使用现有短摘要。命中飞书的结果即使发送失败也保留在任务记录里，由 App 显示失败阶段、飞书错误码和重试入口。语音上下文只记录投递状态，避免闲聊重连后自动补念正文。

接入点是 `VoiceTaskCoordinator` 的任务结果出口，以及 `ScheduleRuntime` 的任务结算交付。两处在各自构造播报前使用同一个投递决策函数。语音内「本次发飞书」通过现有任务委派工具写入本次偏好。普通实时语音答复如果也要按主题改走飞书，下一阶段在 Realtime 生成音频前做路由验证，覆盖仓库现用的各语音服务商。 [语音任务协调](../../apps/nsh/runtime/voice/task-coordinator.ts) · [定时任务结算](../../apps/nsh/runtime/schedule.ts) · [当前播报接线](../../apps/nsh/store.ts)

## 实施顺序与验收

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| 1. 连接验证 | 企业自建应用、App 内连接与凭据、机器人收发、用户文档授权 | 真实租户跑通单聊和群 @，记录普通群引用及话题回复在两种权限下的事件差异；iOS 和 Android 真机横屏核对锁屏、断网和恢复；读写同一份真实 Docx 并验证无权限的错误。 |
| 2. 双向 Agent 和文档 | 飞书收件、同会话追问、文档按身份执行、回发与任务记录 | 单聊读取现有 Wiki 文档并创建结果文档；已授权群中 `@LOOI` 读取共享文档，打开普通回复权限后直接引用追问；重投同一个消息只启动一次任务；在其他群引用相同内容不会继承会话。 |
| 3. 消息规则 | 设置页提示词、规则预览、单次覆盖、语音任务与定时摘要投递 | 对 LOOI 说「把调研发我飞书，别念」，确认飞书只收到一份且正文未进入 TTS；模拟飞书拒绝，任务仍显示已完成、投递显示失败；核对默认语音答复、定时勿扰和静默任务的现有行为。 |
| 4. 扩大覆盖 | 普通实时答复分流、飞书更多文档格式和操作、国际版 Lark、常在线运行方式 | 各语音服务商实测在播放前完成渠道判断；国际版用独立租户核对授权和消息事件；常在线验收按设备离线期间仍需完成的任务范围定义。 |

现有路线图中，共用消息结构和历史读取可接到 #15、#16。#17 的定时增量读取依赖历史读取和游标，可与双向 Agent 分开推进；摘要的飞书投递复用阶段 3 的投递逻辑。 [IM 插件接口 #15](https://github.com/GrinZero/super-looi/issues/15) · [飞书消息读取 #16](https://github.com/GrinZero/super-looi/issues/16) · [IM 定时增量读取 #17](https://github.com/GrinZero/super-looi/issues/17)

| 新增责任 | 用途与维护成本 |
| --- | --- |
| 飞书插件和连接配置 | 集中处理飞书特有的事件、OAuth 和资源权限。维护成本主要是长连接生命周期、文档格式和两种身份的联调。 |
| 飞书任务入口和收发记录 | 保存消息、会话、任务和投递对应关系，支持追问、去重与恢复。沿用现有执行通道和 SQLite，避免额外的常驻进程或任务系统。 |
| 投递决策函数和规则记录 | 让语音结果和定时摘要按同一套偏好选择渠道。维护成本是一种有限的规则结构、一处预览和已有交付点的接线。 |
