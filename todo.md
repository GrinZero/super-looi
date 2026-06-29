# 待办

- 在真实 iOS 设备或模拟器上下载/安装 Streaming Paraformer 与 CT-Punc，确认 release tarball 解压后的文件名与目录结构匹配当前下载逻辑。
- 在真实 iOS 设备上运行 Streaming Paraformer 主链路，记录首字延迟、endpoint 等待窗口、多句连续输入和 CT-Punc 补标点结果。
- 在真实设备上重新录入声纹并测试 realtime samples 声纹验证，确认 owner 通过、诊断 non-owner 拒绝；当前设置页声纹录入/验证已迁移到 `kwsAudioFeeder` samples 管线，阈值暂定 0.45。
- 在真实 iOS 设备上运行一次主屏幕 live microphone 对话，确认真实自然音频下 wakeword/button trigger -> VAD -> ASR -> SSE -> TTS 行为。
- 在真实设备上运行重复 live 对话，确认自然语音 VAD 时序和音频播放完成情况，不受模拟器 CoreAudio/TTS timeout 噪声影响。
- 设备接入后，使用 `docs/home-voice-conversation-device-acceptance.md` 或 `pnpm voice:accept-device -- "<physical device name>"` 记录真机 trace id、延迟字段和播放观察结果。

## Device tool / LOOI body follow-ups

- [x] Migrate `@sourcebug/looi-sdk` into this monorepo as `packages/looi-sdk`.
- [ ] Replace placeholder audio/video/orientation executors with permission-aware native implementations.
- [ ] Add multi-device selection if more than one phone registers the same tool name.
