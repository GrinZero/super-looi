# MOSS 试听半句截断：空播放标识与服务端超时

2026-11-14，在已有 iPhone 16e / iOS 26.3 横屏 NSH 开发宿主直接点击「语音 → MOSS-Live → 试听」。请求由 App 直连 MOSS，使用当前保存的凭据。

## 实测结论

MOSS 接受 `session.commentary.append` 后，每轮只下发 **2 秒音频**，没有 `response.audio.done`，随后发出 `response.audio.stop`，原因为 `playback_timeout`。音频结束后至服务报错约有 15 秒无声等待。该等待不能作为成功播放后的正常收尾。此前 [语音页 E2E 报告](voice-preview-e2e-2026-11-13.md) 中 MOSS 约 20–22 秒自然结束的现象，应归为本问题，不能视作完整试听通过。

服务下发的 `response.audio.started` 与每条 `response.audio.context` 有 `run_id`，但 `turn_id` 和 `chunk_id` 都是空字符串。App 的回执编码要求有效标识，因此没有发送片段完成回执。实验中保留并原样回传空字符串，服务立即以 `invalid_public_request` 拒绝。

[官方协议](https://platform.moss.cn/docs/reference/moss-live/) 允许会话级 `session.commentary.append`，要求音频 context 携带回执关联标识，并在实际播放完成时原样回传。结合空标识、空回执被拒和下表对照，证据指向 MOSS 会话级主动播报的播放回执协议缺陷。

## 同一 App 内的对照

下表每行是一轮实际控件操作；原始消息及毫秒时间见 [events.json](artifacts/moss-preview-playback/events.json)。其中省略了 session.update 的指令正文，二进制帧只保存字节数。

| 轮次 | 改变的条件 | 原始 PCM 字节 | 服务终态 |
| --- | --- | ---: | --- |
| 1 | 原实现，24 kHz，client 播放计时 | 96000 | playback_timeout |
| 2 | 持续发送合成静音，仍为 client 模式 | 96000 | playback_timeout |
| 3 | 按原值回传空 turn_id／chunk_id | 19200 | invalid_public_request |
| 4 | 请求并确认 playback=server | 96000 | playback_timeout |
| 5 | 移除 media.configure，默认 48 kHz | 192000 | playback_timeout |
| 6 | server 模式 + mic_state 开启 + 合成静音 | 96000 | playback_timeout |
| 7 | 明确选择木木，确认 voice_changed，再试听 | 96000 | playback_timeout |

第 1、2、4、6、7 轮为 24 kHz 单声道 PCM16，96000 字节恰好 2 秒；第 5 轮 48 kHz 的 192000 字节也恰好 2 秒。第 3 轮因请求被拒提前停止。上述七轮均返回空播放标识。另一次官方快照模型 `moss-live-1.0-2026-11-02` 请求在 WebSocket 握手阶段收到 HTTP 503，无法作为有效的模型对照；无自动重试或模型切换。

木木请求明确发送 `change_voice`，并收到匹配的 `voice_changed`，排除了未指定音色是截断主因。该轮 run 为 `run-b24e1e1b-dc0b-4afc-b6e6-170be89cf585`。

## App 侧修正

- 默认显示「暖暖」时，凭据模块现在返回暖暖的实际 Voice ID；UI 与运行时共用 `voice-defaults.ts` 的同一常量，握手会发送 `change_voice`。此前 UI 显示默认值，但运行时返回空串，没有指定音色。
- 试听遇到 `response.audio.stop` 或 `response.interrupted` 时结束试听并显示失败；保留服务原始 reason 为错误码，以及 responseId／turnId。既有错误格式化器原来遇到 message 后丢弃这两个定位标识。
- 开始／结束试听的状态交接与播放队列收尾沿用当前工作区已有修正。状态修正不等于服务已输出完整音频。

沿用协议适配器承载 MOSS 行为，凭据模块解析默认音色，UI 与凭据模块引用同一个纯数据文件。该文件只有一个常量，用于共享实际默认值，并避免 UI 导入后端凭据模块后把应用运行时带入页面编译环境；没有新增依赖或替代语音模型。所有临时探针、采样率／计时／模型实验配置均已撤回。

## 验证

12 项失败链路测试、完整语音运行时回归、横屏错误状态 UI 回归、全量类型检查及 App 构建通过；独立 review 通过。新增用例先复现默认音色未传入、错误详情丢失标识及错误码，再验证修正结果。最终实测页面收到服务停止事件后，显示 `code=playback_timeout responseId=run-c13e7a74-da8b-4f98-9fb6-0488d3a935e7 turnId=`，恢复「试听」和「开始对话」入口。

完整播放验收仍未通过，需 MOSS 修复该主动播报流的标识／回执闭环后重测。
