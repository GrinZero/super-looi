# Phase 1 待解决问题

- [ ] Camera UI 设备实测：确认隐藏相机组件能持续调用 `cameraPerceiver.addFrame()`，且不会明显影响性能/权限体验。
- [ ] 视觉记忆设备端实测：App 发起 `"记住这个放这了"` 后，确认返回 `response/evidenceUri/description`，并且搜索 `"钥匙放哪了"` 能显示位置和证据图。
- [ ] 原生 KWS 验证：`src/voice/wakeword.ts` 已改走 `@siteed/sherpa-onnx.rn` KWS adapter，`src/voice/kws-audio-feeder.ts` 已用 `@siteed/audio-studio` 采集 16k mono float PCM 并调用 `wakewordService.acceptSamples()`；还需设备验证唤醒词，以及唤醒后 feeder 停止、STT 完成后恢复监听。
- [ ] 原生 Speaker ID 验证：设置页已有 owner 声纹录入入口，embedding 已分块写入 SecureStore 并可在启动/刷新时恢复到 SpeakerId manager；`VoicePerceiver.finishListening()` 已用当前命令录音文件调用 `speakerIdService.verifyFile()`，通过后才转写。还需设备验证 owner 通过/非 owner 拒绝，以及 App 重启后仍可通过。
- [ ] 设备端 STT 验证：`scripts/download-sherpa-models.sh` 已成功下载 SenseVoice/KWS/Speaker 到 ignored `app-models/sherpa-onnx/`，App 会在初始化前自检 `documentDirectory/sherpa-onnx/...` 必需文件且设置页会显示缺失清单；当前 `adb devices -l` 无在线设备，还需拷贝到设备文档目录、确认设置页模型检查全绿，并在 iOS/Android 上验证 `recognizeFromFile()`。
- [ ] Native sherpa 构建/设备验证：`expo prebuild` 和 iOS `pod install` 已通过，`sherpa-onnx-rn` 已 autolink；Android `:app:assembleDebug` 已用 Homebrew JDK 17 通过，仍需 Android 设备冒烟测试；iOS simulator build 仍被本机 Xcode `DVTDownloads.framework` 缺失阻塞，修复工具链后重跑 `cd ios && xcodebuild ... build`。
- [ ] iOS + Android 设备冒烟测试。
