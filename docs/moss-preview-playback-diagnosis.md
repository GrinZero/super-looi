# MOSS 试听接入修复与完整播放验收

## 根因与修复

试听入口曾把固定试音文本通过 `session.commentary.append` 作为进度／结果提交。该路径实测只返回 2 秒 PCM，音频关联字段为空，最终 `playback_timeout`。这些事件说明该试听路径没有形成可正常确认播放的语音话轮；此前据此认定 MOSS 服务无法完成试听，结论过早。原始对照事件保存在 [events.json](artifacts/moss-preview-playback/events.json)。

最终实现按 [MOSS 官网实时接入流程](https://platform.moss.cn/docs/scenarios/moss-live/) 建立真实语音话轮：

1. 等待会话配置确认，指定所选 Voice ID，通过 `mic_state` 开启服务端输入。
2. 按实时速度上传 App 内置的 16 kHz 单声道 PCM16 问候语「你好，请说一句问候语。」，随后持续发送静音。
3. 会话指令要求模型只完整朗读试音文本，工具列表为空。试听不读取或上传真实麦克风音频。
4. 本地播放器实际播完每段后回传 `playback.chunk.completed`；收到 `response.audio.done` 且原生队列排空后回传 `playback.completed`。
5. 保持连接至 `response.ended`，再结束试听并恢复原来的唤醒状态。

仍使用 `moss-live-1.0` 和用户选中的音色，没有替换为 TTS 模型。独立 TTS 路径的真实请求返回 HTTP 402 `insufficient_credits`，未纳入最终产品代码。

## 模块与资源

`LiveVoiceSession` 继续拥有连接、播放和取消生命周期；协议适配器只编码服务端麦克风启用事件；`store` 通过 `previewInput` 提供本地资源。没有新增会话类、原生传输类或依赖。

内置问候语为 `apps/nsh/assets/moss-preview-greeting.pcm`，71040 字节、2.22 秒，按 640 字节／20 ms 分帧。它用于触发真实用户语音话轮，代价是一份约 71 KB 的静态资源及预置输入、读取位置和收尾标记三个字段。开发时一次性生成并打包，产品运行不调用开发机 CLI 或代理进程。

默认暖暖的 Voice ID 与 UI 共用 `voice-defaults.ts` 中的常量；停止试听与服务错误继续保留实际失败阶段、错误码和 run 标识。

## 真实横屏验收

2026-11-14，在 iPhone 16e / iOS 26.3 的现有开发宿主直接点击试听，App 直连 MOSS-Live。每轮等自动结束后再开始下一轮，未手动结束这三轮。

| 音色／轮次 | 音频帧 | 24 kHz PCM 字节 | 音频时长 | cancelled |
| --- | ---: | ---: | ---: | --- |
| 暖暖，第 1 轮 | 42 | 180480 | 3760 ms | false |
| 暖暖，第 2 轮 | 42 | 180480 | 3760 ms | false |
| 木木，第 3 轮 | 35 | 157440 | 3280 ms | false |

三轮最终模型文本均为「你好，我是 LOOI。我们可以开始聊天了。」，会话正常结束，页面自动恢复「等待唤醒」及「试听／开始对话」入口。结束时恢复暖暖，自动唤醒保持开启。完整会话记录见 [completed-sessions.json](artifacts/moss-preview-playback/completed-sessions.json)。

## 自动回归

- 运行时用例覆盖 3 秒音频、三段播放回执、原生排空、整轮回执与等待服务端终态；预置输入加载期间停止后，迟到输入不会建连。
- 官网协议回归覆盖 attach_session、change_voice、媒体采样率协商、真实 action/data 格式、播放回执及工具结果续答；修正旧测试中不存在的 session.attach／voice.select 等事件名。
- 12 项失败／试听测试、完整语音运行时回归、3 项协议测试、全量类型检查、App 构建与独立 review 通过。
