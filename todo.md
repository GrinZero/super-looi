# Phase 1 待解决问题

- [ ] MiniCPM-V 环境验证：当前未发现 `~/tools/llama.cpp/build/bin/llama-server`、`~/models/minicpm-v-2.6`、`cmake`、`huggingface-cli`；需先安装/下载后再跑 `server/scripts/start-vision.sh`。
- [ ] `/api/observe/voice-visual` 端到端验证：base64 图片 + transcript 返回 `response/evidenceUri/description`，且 evidence URL 可打开。
- [ ] Camera UI 设备实测：确认隐藏相机组件能持续调用 `cameraPerceiver.addFrame()`，且不会明显影响性能/权限体验。
- [ ] 原生 KWS：`expo-sherpa-kws` Swift/Kotlin 仍是 TODO，需要实现 sherpa-onnx 音频监听和事件回调。
- [ ] 原生 Speaker ID：`expo-sherpa-kws` Swift/Kotlin 仍是 TODO，需要实现声纹 embedding 注册/验证；VoicePerceiver 还需采集验证音频样本。
- [ ] 设备端 STT：`src/voice/stt.ts` 仍走 `/api/stt/transcribe`，需要改 SenseVoice 本地推理后再删除服务端 STT。
- [ ] iOS + Android 原生构建和设备冒烟测试。
