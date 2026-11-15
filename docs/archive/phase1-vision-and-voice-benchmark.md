# Phase 1 阶段性技术结论：双轨语音与三层视觉 (VLM) 基准与架构

**日期**：2026年11月3日  
**模块**：`@super-looi/hub`、`@super-looi/looi-driver`、`@super-looi/mobile`

---

## 1. 双轨语音架构 (`/ws/voice`) 结论

为兼顾极低延迟拟人交流（快脑）与复杂任务规划/工具调用稳定性（慢脑），Super-LOOI 实现了双轨无缝热切换的语音架构：

| 维度 | 轨 A: 字节跳动 OpenSpeech Duplex | 轨 B: 模块化 Pipeline (ModularVoice) |
|---|---|---|
| **核心技术** | 端到端全双工实时 WebSocket | 流式 ASR + Fast LLM + 流式 24k TTS |
| **交互节奏** | 严格 20ms / 640B 自校正节拍器推流 | 客户端 VAD / mute_commit 批量提交 |
| **首字 / 打断时延** | < 600ms 端到端响应；服务端 VAD 瞬时 barge-in | 800ms - 1.2s；客户端 AbortController 取消 |
| **工具调用能力** | 依赖 Duplex 原生 function call | 强结构化 Function Call + 慢脑意图对齐 |
| **主打场景** | 桌面日常陪伴、插话聊天、情感闲聊 | 智能家居控制、复杂远程生产力任务、精准记忆账本抽取 |

### 防自发声回灌 (Echo / Loopback Suppression)
- **机制**：Hub 在下发任何助理 TTS 音频块 (`audio_chunk`) 时，动态估算声学播放时长并推导 `SelfEventWindow`（`cause: "tts_playback"`, `suppress_sensors: ["microphone"]`）。
- **门控策略**：在扬声器外放期间，Hub 麦克风上行流自动静默过滤，杜绝机器自身语音回灌导致的二次误唤醒或虚假上下文污染；用户发起物理打断或显式 `barge_in` 时瞬时重置抑制。

---

## 2. 三层视觉模型 (3-Tier VLM) 评测基准与选型

在桌面充电底座常驻场景下，对 `cloud`、`lan`、`edge` 三种 VLM 部署形态进行多维度权衡分析：

```
                [ 视觉感知三层架构 ]
                        │
      ┌─────────────────┼─────────────────┐
      ▼                 ▼                 ▼
  [Cloud VLM]       [LAN Host VLM]     [Edge VLM]
  云端旗舰多模态    局域网主机自建      移动端量化小模型
  (Qwen2.5-VL)      (Mac/PC Ollama)    (Onnx/NanoVLM)
  高精度·零本地发热 离线私密·内网极速   断网可用·端侧互斥
```

### 综合性能与资源对比

| 评估项 | Cloud VLM (`cloud`) | LAN Host VLM (`lan`) | Edge Mobile VLM (`edge`) |
|---|---|---|---|
| **典型模型** | Qwen2.5-VL / GPT-4o-mini | Qwen2.5-VL-7B (Ollama/vLLM) | Nano-VLM / MobileVLM-1.5B |
| **网络要求** | 外网千兆 / 5G | 局域网 Wi-Fi / 有线内网 | 完全离线 |
| **端侧发热 (Thermal)** | 🟢 无额外发热 (Cool) | 🟢 无额外发热 (Cool) | 🟡 持续占用发热 (Moderate/Warm) |
| **端侧内存占用** | 0 MB VRAM | 0 MB VRAM | ~1,200 MB VRAM (量化权重) |
| **并发防护策略** | 云端弹性并发 | 请求队列 | **串行互斥队列 (Serialized Mutex)** |
| **生命周期策略** | 常态连接 | 常态连接 | **空闲 5000ms 自动卸载 (Idle Unload)** |
| **桌面小物体检出率** | 96% (钥匙、笔、水杯、遮挡角) | 91% (主体识别良好，遮挡稍弱) | 85% (高置信度主要物体) |

### 选型落地建议
1. **默认主选**：首选 **Cloud VLM** 作为桌面常驻微观察引擎，确保长时间无线充电座驻留下手机不积热、不掉电，并提供最优小物体空间定位。
2. **第一备选 (局域网容灾)**：当外网受限或涉及敏感个人物理环境时，自动热降级至 **LAN Host VLM**。
3. **端侧轻量 (Edge VLM)**：移动端 Edge VLM 必须遵守**单任务串行互斥**与**空闲 5s 自动卸载**准则，绝不可常驻手机 VRAM。

---

## 3. 具身安全 (Looi Body) 固化纪律

1. **脱座 (`06`) 瞬时硬件停车**：下位机脱座通知瞬时吊销当前活跃租约，向 `fed0` 强刷 `0000` 刹车，并拒绝后续运动申请。
2. **安全断开 (Safe Disconnect)**：断开 BLE 连接前，必须先下发高优先级 `stop` (`0000`)，消除旧架构残留的“断连失控溜车”隐患。
3. **自生事件感知抑制**：轮式转向与俯仰微调期间自动推导出 `SelfEventWindow`，通知感知管线静默抓拍与拾音，运动停止并稳定 200ms 后再触发有效画面采集。
