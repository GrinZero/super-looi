# Phase 1 待解决问题

- [ ] 视觉记忆设备端实测：App 发起 `"记住这个放这了"` 后，确认返回 `response/evidenceUri/description`，并且搜索 `"钥匙放哪了"` 能显示位置和证据图。Android Settings 视觉诊断已证明 App observe 调用、evidence URL 和对话页证据图加载；但 emulator hidden camera 返回纯色/不可辨认帧，服务端已正确 `remembered=false` 且不写入 memory。剩余：用真实可用画面/设备相机重跑，并覆盖实际语音路径与记忆检索。
- [ ] 记忆列表证据图设备端实测：对话页 ChatBubble 真实 evidence 图片已在 Android 通过 Glide 加载验证；MemoryCard 的真实图片加载还未验证。
- [ ] 原生 KWS 验证：Android emulator 已确认 native KWS 使用 app 私有目录绝对路径初始化，encoder/decoder/joiner/tokens/keywords 均存在，`@siteed/audio-studio` 持续喂 16k mono float PCM 到 `acceptWaveform()`，并已确认 STT/声纹/ASR 处理期间暂停、结束后恢复；还需真实设备/麦克风环境验证唤醒词命中。
- [ ] 原生 Speaker ID 验证：Android emulator 已通过设置页语音诊断验证 owner 录音文件 `processFile` 生成 512 维 embedding 且同文件 verify 为 pass；embedding 已分块写入 SecureStore 并可在启动/刷新时恢复到 SpeakerId manager；`VoicePerceiver.finishListening()` 已用当前命令录音文件调用 `speakerIdService.verifyFile()`，通过后才转写。还需验证非 owner 拒绝，以及 App 重启后仍可通过。
- [ ] 设备端 STT 验证：Android emulator 已确认设置页模型检查全绿，并通过设置页语音诊断验证 SenseVoice `recognizeFromFile()` 对录音 m4a 返回文本；还需 iOS 设备/模拟器验证 `recognizeFromFile()`。
- [ ] Native sherpa 构建/设备验证：`expo prebuild` 和 iOS `pod install` 已通过，`sherpa-onnx-rn` 已 autolink；Android `:app:assembleDebug` 已用 Homebrew JDK 17 通过，Android emulator 已启动到 JS 并完成 KWS 初始化；iOS simulator build 仍被本机 Xcode `DVTDownloads.framework` 缺失阻塞，修复工具链后重跑 `cd ios && xcodebuild ... build`。
- [ ] iOS + Android 设备冒烟测试。
