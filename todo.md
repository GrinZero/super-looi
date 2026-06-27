# Phase 1 待解决问题

- [ ] MiniCPM-V 环境验证：确认 llama.cpp 已编译、模型已下载，`server/scripts/start-vision.sh` 可启动。
- [ ] `/api/observe/voice-visual` 端到端验证：base64 图片 + transcript 返回 `response/evidenceUri/description`，且 evidence URL 可打开。
- [ ] Camera UI 设备实测：确认隐藏相机组件能持续调用 `cameraPerceiver.addFrame()`，且不会明显影响性能/权限体验。
- [ ] 原生 KWS：`src/voice/wakeword.ts` 仍是按钮模拟，需要接 `expo-sherpa-kws` 真正常驻监听。
- [ ] 原生 Speaker ID：`src/voice/speaker-id.ts` 仍是自动通过，需要接声纹注册和验证。
- [ ] 设备端 STT：`src/voice/stt.ts` 仍走 `/api/stt/transcribe`，需要改 SenseVoice 本地推理后再删除服务端 STT。
- [ ] iOS + Android 原生构建和设备冒烟测试。
