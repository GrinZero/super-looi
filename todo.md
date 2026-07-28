# 待办

## Mem0 Anthropic 兼容修复 follow-ups

- [ ] 在 `.env` 中补齐 `LLM_API_KEY`（anthropic）和 `EMBEDDING_API_KEY`（openai），跑一次真实 `/api/memory/add` + `/api/memory/search`，确认 mem0 事实提取（haiku 兜底模型）和 openai embedding 都能成功调用，且不再出现 temperature 400。

## 首次引导与声纹多样本 Plan follow-ups

- [x] onboarding 采用 RootLayout readiness 守卫跳转，同时首页保留模型/声纹修复入口。
- [x] 可选能力跳过策略已落地：相机、日历、LOOI 机器人都允许跳过，skip 写入 `src/setup/setup-storage.ts`。
- [x] 声纹 score trace 已落地到 MMKV `owner_speaker_verification_traces`，保留最近 100 条，不保存原始音频和完整 embedding。
- [x] 声纹模板上限默认值已设为 8，追加录入满额时返回可解释替换原因。
- [ ] React Doctor 仍提示 `SettingsScreen` 体积过大；当前设置页已分层但仍在单文件内，后续可拆到 `src/ui/settings/*`。
- [ ] React Doctor 对 `runSpeakerVerify` 的 sequential await 仍有 warning；当前判断为录音流程时序要求，`start -> wait -> stop -> verify` 不能并行。
- [ ] 真机补充 non-owner 回归样本，覆盖不同性别、距离、音量、语速和环境噪声。
- [ ] 在有足够 owner / non-owner score 日志前，不开启声纹自动自适应更新。

- 在真实 iOS 设备或模拟器上下载/安装 Streaming Paraformer 与 CT-Punc，确认 release tarball 解压后的文件名与目录结构匹配当前下载逻辑。
- 在真实 iOS 设备上运行 Streaming Paraformer 主链路，记录首字延迟、endpoint 等待窗口、多句连续输入和 CT-Punc 补标点结果。
- 在真实设备上重新录入声纹并测试 realtime samples 声纹验证，确认 owner 通过、诊断 non-owner 拒绝；当前设置页声纹录入/验证已迁移到 `kwsAudioFeeder` samples 管线，阈值暂定 0.45。
- 在真实 iOS 设备上运行一次主屏幕 live microphone 对话，确认真实自然音频下 wakeword/button trigger -> VAD -> ASR -> SSE -> TTS 行为。
- 在真实设备上运行重复 live 对话，确认自然语音 VAD 时序和音频播放完成情况，不受模拟器 CoreAudio/TTS timeout 噪声影响。
- 设备接入后，使用 `docs/home-voice-conversation-device-acceptance.md` 或 `pnpm voice:accept-device -- "<physical device name>"` 记录真机 trace id、延迟字段和播放观察结果。

## Device tool / LOOI body follow-ups

- [x] Migrate `@sourcebug/looi-sdk` into this monorepo as `packages/looi-sdk`.
- [ ] Replace hard-coded LAN IP dev server config with a less fragile Android/device development flow, or document the required `.env` update when the host IP changes.
- [ ] In Settings, scan/retry/select a real LOOI robot and capture logs for scan -> connect -> SDK handshake.
- [ ] After Settings selection, relaunch to the home screen and verify saved robot reconnect + handshake without manual selection.
- [ ] Run `POST /api/device-tools/robot/move` with the app connected to a real LOOI robot and verify physical movement/stop behavior.
- [ ] Replace placeholder audio/video/orientation executors with permission-aware native implementations.
- [ ] Add multi-device selection if more than one phone registers the same tool name.
