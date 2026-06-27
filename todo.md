# Phase 1 待解决问题

- [ ] Camera UI 设备实测：确认隐藏相机组件能持续调用 `cameraPerceiver.addFrame()`，且不会明显影响性能/权限体验。
- [ ] 视觉记忆设备端实测：App 发起 `"记住这个放这了"` 后，确认返回 `response/evidenceUri/description`，并且搜索 `"钥匙放哪了"` 能显示位置和证据图。
- [ ] 原生 KWS 验证：`src/voice/wakeword.ts` 已改走 `@siteed/sherpa-onnx.rn` KWS adapter；还需实现麦克风 PCM feeder 调用 `wakewordService.acceptSamples()` 并设备验证唤醒词。
- [ ] 原生 Speaker ID 验证：设置页已有 owner 声纹录入入口，embedding 已分块写入 SecureStore 并可在启动/刷新时恢复到 SpeakerId manager；`VoicePerceiver.finishListening()` 已用当前命令录音文件调用 `speakerIdService.verifyFile()`，通过后才转写。还需设备验证 owner 通过/非 owner 拒绝，以及 App 重启后仍可通过。
- [ ] 设备端 STT 验证：已添加 `scripts/download-sherpa-models.sh` 下载 SenseVoice/KWS/Speaker 模型；还需执行下载、确认设备运行时模型路径，并在 iOS/Android 上验证 `recognizeFromFile()`。
- [ ] Native sherpa 设备构建：`expo prebuild` 和 iOS `pod install` 已通过，`sherpa-onnx-rn` 已 autolink；Android build 被本机缺 JDK 17/Gradle Foojay `IBM_SEMERU` error 阻塞，iOS simulator build 被本机 Xcode `DVTDownloads.framework` 缺失阻塞。修复工具链后重跑 `cd android && ./gradlew :app:assembleDebug`、`cd ios && xcodebuild ... build`。
- [ ] iOS + Android 原生构建和设备冒烟测试。
