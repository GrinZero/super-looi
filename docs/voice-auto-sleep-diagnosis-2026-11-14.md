# 实时会话自动关闭核查

## 当前条件

`LiveVoiceSession` 的静默阈值为 **12,000 ms**。正常回复实际播放排空后，清除当前回复状态，记录 `silenceSince` 并恢复等待。没有正在说话、运行中的工具或待播通知时，空闲计时到期调用 `onSessionComplete`。

`user_speech_started` 和 `user_transcription_started` 都会将 `turnActivity` 设为 `user_speaking`，取消 idle 与 awaiting 计时器。只有后续话轮状态转换才恢复计时；字幕出现或服务端生成结束本身不会开始无条件倒计时。

计时结束后，`VoiceRuntime.endSession` 关闭本次云端实时连接；自动唤醒开启时返回本地 KWS 待机。

代码位置：

- `apps/nsh/runtime/voice/live-session.ts`：`IDLE_SLEEP_MS`、`handleEvent`、`tick`、`startIdleTimer`、`startAwaitingTimer`。
- `apps/nsh/runtime/voice/runtime.ts`：`endSession`。

## 对应截图的会话证据

只读核对当前开发宿主的 `runtime_observations`，定位到 trace `8f7b076c70a84642b150736b6b75c814`，服务商为豆包，模型 `1.2.6.1`。时间为 UTC+8。

| 时间 | 记录 |
|---|---|
| 12:57:29.075—12:57:31.006 | 助手回复「大厅的灯已关闭，状态已确认。」；音频 125,174 bytes，约 2,608 ms |
| 12:57:34.186 | 又开始一个用户话轮，其转写为「大厅的灯已关闭状态已确认」 |
| 12:58:39.676 | 该用户话轮在关闭收尾时结束，累计 2,904 帧上行 PCM，约 58,080 ms |
| 12:58:39.677 | 会话以 `end_session` 收尾 |

最后一个用户话轮长约 65.49 秒，文本几乎复述助手刚播出的内容。这与外放回录形成新收音／识别活动、阻止空闲计时恢复的解释吻合。

观察器在会话关闭时会强制结束当前与待转写的话轮。因此上述结束时间不能单独证明 ASR 自然结束或漏收了某个 stop 事件，`end_session` 也不能区分手动结束与自动休眠。当前聚合记录不足以确定具体未终结的活动阶段。

独立只读复核确认代码条件和上述时间、文本、帧数。后续应关联原始 VAD／转写开始与结束事件、原生播放排空及计时恢复，修正实际活动生命周期，并处理已有 AEC 回录问题。
