# Streaming Paraformer + CT-Punc 实时字幕实现计划

## 背景与问题

### 用户反馈的核心问题

1. **说话被过早打断**：VAD `minSilenceDuration` 设置过短（0.8s），加上 voice-perceiver 中过于激进的二次判定逻辑，导致刚说几句话就被判定结束
2. **说话时没有实时字幕**：当前用 SenseVoice 离线模型，必须录完整段音频才能转写。用户说话过程中 overlay 只显示"说吧，我在听。"，没有任何视觉反馈

### 为什么不能在 SenseVoice 基础上解决

- SenseVoice 是非自回归架构（non-autoregressive），设计上对完整音频段一次性推理，**架构层面不支持逐帧解码**
- 社区的"模拟流式"方案（VAD 分段 + 离线转写）体验是"说完一句出一句"，延迟 2-3 秒，不是真正的逐字实时
- 官方没有 SenseVoice streaming 版本的开发计划

### 为什么选 Streaming Paraformer

| 决策维度 | 结论 |
|----------|------|
| **同生态** | 同属阿里达摩院 FunASR 系列，sherpa-onnx 原生支持，`@siteed/sherpa-onnx.rn` 已有完整 streaming API |
| **体积** | int8 226MB，和现有 SenseVoice 228MB 几乎一样，替换不增加 app 负担 |
| **语言** | 中文 + 英文 + 方言（河南/天津/四川），满足中英混合需求 |
| **真流式** | 逐帧解码，每 100ms chunk 即可产出部分文本 |
| **验证充分** | sherpa-onnx 官方打包、有 Android APK 验证、社区广泛使用 |

### 为什么需要额外的标点模型

Streaming Paraformer 输出无标点纯文本（"你好明天去哪里"），可读性差。CT-Punc 模型是阿里同团队开源的标点恢复模型（72MB int8），对 ASR 输出做后处理补标点（"你好，明天去哪里？"）。

## 目标

用户唤醒后说话，**200-600ms 内**就能在 overlay 上看到自己说的字逐步出现；说完后带标点的完整文本进入 LLM 处理。

## 模型

| 模型 | 用途 | 大小 | 来源 |
|------|------|------|------|
| `sherpa-onnx-streaming-paraformer-bilingual-zh-en` | 流式 ASR | 226 MB (int8) | [sherpa-onnx releases](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2) |
| `sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8` | 标点恢复 | 72 MB | [punctuation-models](https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2) |
| ~~SenseVoice~~ | ~~离线 ASR~~ | ~~228 MB~~ | **移除** |

总模型变化：271MB（现有全部）→ 298MB（+72MB 标点，-228MB SenseVoice，+226MB Paraformer）

## 架构变更

### 当前流程
```
唤醒 → expo-audio 开始录音(文件) → VAD 检测说话结束 → 停止录音
     → speakerVerify(录音文件) → SenseVoice.transcribeFile(录音文件)
     → 一次性显示完整文本 → LLM 处理
```

问题：说话全程无字幕反馈，且 VAD 打断过早。

### 新流程
```
唤醒 → kwsAudioFeeder 开始流式采集音频
     → 音频 samples 同时喂给（Promise.all 并行，TurboModule/JSI 调用）:
         ├── VAD（安全超时兜底）
         ├── Streaming ASR（逐帧解码 → 实时更新 overlay 字幕）
         └── samples buffer 累积（供 speaker verification 用）
     
     → ASR isEndpoint() 触发:
         ├── 记录当前句 finalText
         ├── resetStream()（准备识别下一句）
         └── 开始等待窗口（~2s）
              ├── 用户继续说话 → 追加 transcript，重置计时器
              └── 窗口到期（VAD 确认静音 >2s）→ 回合结束:
                   ├── 合并所有句子
                   ├── addPunctuation(合并文本)
                   ├── speakerVerify(samples buffer) — 无文件 I/O
                   └── 带标点文本 → LLM 处理
```

### 关键设计决策

1. **音频流复用**：kwsAudioFeeder 已有 `subscribeSamples` 机制（输出 16kHz mono float32），streaming ASR 直接订阅同一路音频流，无需额外开麦克风，**无需 resample**（Paraformer 要求 16kHz，与 KWS/VAD 一致）
2. **分层端点策略（非简单取先到者）**：
   - ASR `isEndpoint()` 触发 → 记录当前句 finalText + `resetStream()` 开始识别下一句 → **但不立即 finalize 回合**
   - 开始等待窗口（~2s）：若用户继续说话（ASR 有新产出），追加 transcript 并重置计时器
   - 等待窗口到期（VAD 确认静音 >2s）→ 真正 finalize：合并所有句子 + `addPunctuation()` + 发 LLM
   - **理由**：避免用户说"帮我查一下明天天气，还有后天的也查一下"时在"天气"后被截断
   - VAD 作为安全兜底（超时 30s 强制结束）
3. **去掉 expo-audio 录音**：Speaker verification 改用 `speakerIdService.verifySamples(buffer)` 直接接收 samples buffer，不再需要文件 I/O。在 `subscribeSamples` 回调中同时累积 samples 到 buffer，回合结束时用该 buffer 做声纹验证。这消除了麦克风冲突风险。
4. **标点只在回合 finalize 时调用**：对合并后的完整多句文本调用一次 `addPunctuation()`，不在中间 partial results 或单次 endpoint 片段上加标点（CT-Punc 对不完整句子鲁棒性未验证，完整文本效果更好）

## 调研结论（2026-06-28 确认）

### API 可用性（`@siteed/sherpa-onnx.rn` v1.3.1）

| API | TS 层 | Native iOS 层 | 状态 |
|-----|-------|---------------|------|
| `createAsrOnlineStream()` | ✅ AsrService.ts | ✅ | 可用 |
| `acceptWaveform(sampleRate, samples)` | ✅ | ✅ | 可用 |
| `isEndpoint()` | ✅ | ✅ | 可用 |
| `getResult()` → `{text, tokens, timestamps}` | ✅ | ✅ | 可用 |
| `resetStream()` | ✅ | ✅ | 可用 |
| `finishInput()` | ✅ | ✅ | 可用 |
| **initAsr(modelType:"paraformer", streaming:true)** | ✅ 类型允许 | ❌ **switch 未覆盖** | **需 pnpm patch** |
| `initPunctuation()` / `addPunctuation(text)` | ✅ PunctuationService.ts | ✅ | 可用 |
| `speakerIdService.processSamples(rate, samples)` | ✅ | ✅ | 可用（可替代 verifyFile） |

**阻塞项**：`ios/handlers/SherpaOnnxASRHandler.swift` 第 108-128 行，online ASR 的 `switch modelType` 只处理了 `transducer/zipformer/zipformer2`。需通过 `pnpm patch @siteed/sherpa-onnx.rn` 添加 `case "paraformer"` 分支（~15 行 Swift），底层 `sherpaOnnxOnlineParaformerModelConfig(encoder:decoder:)` 已存在。

### 采样率兼容性

全链路 **16kHz mono**，无需 resample：
- `kwsAudioFeeder`: `KWS_SAMPLE_RATE = 16000`，`subscribeSamples` 输出 `(samples: number[], sampleRate: 16000)`
- Streaming Paraformer: 要求 16kHz
- VAD: 16kHz
- Speaker ID: 16kHz

### Partial Result 行为

- 默认 `decodingMethod: "greedy_search"`，partial results **基本 monotonic**（只追加，不修正）
- Paraformer 使用 chunked attention：可能出现一个字横跨 chunk boundary 时延迟一帧才输出，表现为"停顿一下出两个字"，**不是文字跳动**
- UI 层直接用 `getResult().text` 替换当前显示即可，无需 diff 处理

### Endpoint 配置（native 默认值）

```
enableEndpoint: true
rule1MinTrailingSilence: 2.4s  // 主规则：尾部静音超过此值 → endpoint
rule2MinTrailingSilence: 1.2s  // 短规则：配合 rule3
rule3MinUtteranceLength: 20.0s // 长语句门槛：超过此长度用更短静音阈值
```

这些值对我们的场景合理：2.4s 静音才触发 endpoint，用户正常句间停顿 (<1.5s) 不会被打断。

### Bridge 并发模型

- `@siteed/sherpa-onnx.rn` 使用 **TurboModule (JSI)**，非旧 async bridge
- JSI 调用几乎零开销，native 推理在 native 线程池并行执行
- 每 100ms chunk 的处理预算：VAD ~1ms + ASR ~15ms (RTF 0.15) = ~16ms，远小于 100ms 间隔
- `Promise.all([feedVad(chunk), feedAsr(chunk)])` 足够，**无需下沉到 native 层**

### CT-Punc 鲁棒性

- 官方无最小长度限制文档，示例全为完整句子
- CT-Transformer 是 token classification 架构（每 token 预测后跟标点），对不完整句子理论上末尾不加标点或加逗号
- **缓解**：只在回合 finalize 时对完整多句合并文本调用，不对单次 endpoint 片段独立调用

### Speaker Verification 可用 samples

- `SpeakerIdService.processSamples(sampleRate, samples)` 已实现
- 项目中 `src/voice/speaker-id.ts` 已有 `verifySamples(audioSamples: number[])` 方法
- 当前 `voice-perceiver.ts` 用的 `verifyFile(audioUri)` 可直接替换为 `verifySamples(buffer)`
- **结论**：去掉 expo-audio 录音，用 samples buffer 做声纹验证

## 前置步骤：pnpm patch

**在 Step 1 之前**，需要 patch `@siteed/sherpa-onnx.rn` 的 native handler 以支持 online paraformer：

```bash
pnpm patch @siteed/sherpa-onnx.rn
```

改动文件：`ios/handlers/SherpaOnnxASRHandler.swift`

在 `initOnlineAsr` 方法的 switch 中添加：
```swift
case "paraformer":
    let encoderFile = modelFiles["encoder"] ?? "encoder.onnx"
    let decoderFile = modelFiles["decoder"] ?? "decoder.onnx"
    let encoderPath = (modelDir as NSString).appendingPathComponent(encoderFile)
    let decoderPath = (modelDir as NSString).appendingPathComponent(decoderFile)
    for (label, path) in [("encoder", encoderPath), ("decoder", decoderPath), ("tokens", tokensPath)] {
        if !FileManager.default.fileExists(atPath: path) {
            return ["success": false, "error": "Model file not found: \(label) at \(path)"]
        }
    }
    paraformerConfig = sherpaOnnxOnlineParaformerModelConfig(
        encoder: encoderPath, decoder: decoderPath
    )
```

同时修正 TS 类型中的文档注释（`interfaces.ts` L527），将 `'paraformer'` 从 "Offline only" 列表移到 "Both modes" 列表。

完成后 `pnpm patch-commit` 生成 patches 目录。

## 实现步骤

### Step 1: 模型下载与配置

**改动文件**: `sherpa-models.ts`, `sherpa-model-download.ts`

1. `sherpa-models.ts` 新增常量：
   - `DEFAULT_STREAMING_ASR_MODEL_DIR = "sherpa-onnx/asr/streaming-paraformer"`
   - `DEFAULT_STREAMING_ASR_ENCODER = "encoder.int8.onnx"`
   - `DEFAULT_STREAMING_ASR_DECODER = "decoder.int8.onnx"`
   - `DEFAULT_PUNCT_MODEL_DIR = "sherpa-onnx/punctuation"`
   - `DEFAULT_PUNCT_MODEL_FILE = "model.int8.onnx"`
2. 扩展 `SherpaModelKind` union type
3. `sherpa-model-download.ts` 新增下载函数，从 GitHub releases 下载两个模型
4. `checkAllSherpaModelReadiness` 返回结果新增 `streamingAsr` 和 `punctuation` 字段

### Step 2: 新增 Streaming ASR 服务

**新建**: `src/voice/streaming-stt.ts`

```typescript
// 核心 API：
class StreamingSTTService {
  async init(): Promise<void>          // 初始化 streaming paraformer
  async createStream(): Promise<void>  // 创建新的 online stream
  async acceptSamples(samples: number[], sampleRate: number): Promise<StreamingResult>
  async isEndpoint(): Promise<boolean>
  async resetStream(): Promise<void>   // endpoint 后重置 stream
  async release(): Promise<void>
}

type StreamingResult = {
  text: string;        // 当前累积文本
  isEndpoint: boolean; // 是否检测到句尾
}
```

**为什么这样设计**：
- 封装 sherpa-onnx 原生的 `createAsrOnlineStream` / `acceptAsrOnlineWaveform` / `getAsrOnlineResult` / `isAsrOnlineEndpoint` / `resetAsrOnlineStream`
- 每次 `acceptSamples` 后自动调用 `getResult()`，合并为一次调用，减少 bridge 开销
- `init()` 单独调用一次，`createStream()` 每次新会话调用

### Step 3: 新增标点服务

**新建**: `src/voice/punctuation.ts`

```typescript
class PunctuationService {
  async init(): Promise<void>
  async addPunctuation(text: string): Promise<string>
  async release(): Promise<void>
}
```

**为什么这样设计**：
- CT-Punc 模型初始化一次，常驻内存
- `addPunctuation` 是同步推理（72MB 模型对短文本很快，<50ms），不会阻塞主流程
- 只在 endpoint 时调用，不用于 partial results

### Step 4: 改造 voice-perceiver

**改动文件**: `src/perceivers/voice-perceiver.ts`

核心变更：
1. `startListeningVad()` → `startListeningStreaming()`: 同时订阅 samples 喂给 VAD 和 streaming ASR（`Promise.all` 并行）
2. 新增 samples buffer 累积：在 `subscribeSamples` 回调中同时向 buffer 追加数据（供 speaker verification 用）
3. 新增 `drainStreamingSamples()`: 和现有 `drainVadSamples()` 并行，把音频喂给 streaming ASR 并更新 `currentTranscript`
4. **分层端点判定**：
   - ASR `isEndpoint()` → 记录句 finalText + `resetStream()` + 启动等待计时器（~2s）
   - 等待窗口内 ASR 有新 text 产出 → 追加 transcript + 重置计时器
   - 等待窗口到期（或 VAD 确认静音 >2s）→ 触发 `finishListening()`
5. `finishListening()` 中：
   - 合并所有 endpoint 产出的句子
   - 调用 `addPunctuation(合并文本)`
   - 调用 `speakerIdService.verifySamples(samplesBuffer)` — 无文件 I/O
   - 带标点文本 → LLM 处理

**VAD 的角色**：
- 安全超时兜底（30s 无 endpoint 强制结束）
- 不再作为"说话结束"的主判定信号

### Step 5: UI 适配

**改动文件**: `src/ui/ConversationOverlay.tsx`

- `currentTranscript` 从"一次性出现"变为"逐步增长"
- 不需要额外动画——React Native 的 Text 组件天然支持内容增长时的重绘
- 可能需要调整 `numberOfLines` 限制或添加 `ellipsizeMode`，避免文本溢出

### Step 6: 录音策略调整

**改动文件**: `src/voice/stt.ts`, `src/voice/speaker-id.ts`, `src/perceivers/voice-perceiver.ts`

- **移除 expo-audio 录音**：不再需要 `startRecording()` / `stopRecording()` 和文件落盘
- Speaker verification 改为 `verifySamples(samplesBuffer)`（`speaker-id.ts` 已有此方法）
- voice-perceiver 中 `speakerIdService.verifyFile(audioUri)` → `speakerIdService.verifySamples(buffer)`
- 移除 `transcribeFile()` 和 `stopAndTranscribe()` 方法
- 移除 `sherpa-adapter.ts` 中的离线 ASR 配置

### Step 7: 清理 SenseVoice

- 删除 `app-models/sherpa-onnx/asr/sensevoice/` 目录及其 gitkeep
- 移除 `sherpa-model-download.ts` 中 SenseVoice 下载逻辑
- 移除 `sherpa-adapter.ts` 中 `sense_voice` 相关配置

## 文件变更清单

| 文件 | 变更类型 | 描述 |
|------|----------|------|
| `patches/@siteed__sherpa-onnx.rn@1.3.1.patch` | **新建** | pnpm patch：native handler 支持 online paraformer |
| `src/voice/sherpa-models.ts` | 修改 | 新增 streaming-asr 和 punctuation 模型常量，移除 sensevoice 常量 |
| `src/voice/sherpa-model-download.ts` | 修改 | 替换下载逻辑：sensevoice → streaming paraformer + ct-punc |
| `src/voice/sherpa-adapter.ts` | 修改 | ASR config 改为 streaming paraformer |
| `src/voice/streaming-stt.ts` | **新建** | 流式 ASR 服务封装 |
| `src/voice/punctuation.ts` | **新建** | 标点恢复服务封装 |
| `src/perceivers/voice-perceiver.ts` | 修改 | 核心流程改造：并行喂音频给 ASR+VAD，分层端点判定，samples buffer 声纹验证 |
| `src/voice/stt.ts` | 修改 | 移除 transcribeFile 和录音功能 |
| `src/voice/speaker-id.ts` | 微调 | 确认 verifySamples 可直接使用 |
| `src/ui/ConversationOverlay.tsx` | 微调 | 适配实时增长的 transcript（直接替换 text，无需 diff） |
| `app-models/sherpa-onnx/asr/sensevoice/` | **删除** | 移除旧模型文件 |

## 验收标准

### 功能验收

| # | 场景 | 预期结果 | 通过条件 |
|---|------|----------|----------|
| 1 | 唤醒后说一句中文（如"明天天气怎么样"） | 字幕逐字出现在 overlay 上 | 第一个字在 **600ms 内**出现 |
| 2 | 说话过程中短暂停顿（<1.5s） | 不被打断，字幕继续追加 | 停顿 1 秒不触发结束 |
| 3 | 说完后停顿 >1.5s | ASR endpoint 触发，文本补标点后进入处理 | 带标点的完整文本出现在对话记录中 |
| 4 | 中英混合说话（"帮我搜一下 React Native"） | 中英文都正确识别 | 英文单词基本完整 |
| 5 | 说较长一段话（10-15 秒） | 全程有实时字幕，不被 timeout 打断 | 安全超时 30s 内不触发 |
| 6 | 模型未下载时首次启动 | 自动下载 streaming paraformer + ct-punc | 下载进度正确显示，下载完成后功能可用 |
| 7 | 声纹验证仍正常工作 | 非主人说话被拒绝 | 和之前一致的 speaker verification 行为 |

### 性能验收

| 指标 | 目标 | 测量方式 |
|------|------|----------|
| 首字延迟 | < 600ms（从开始说话到第一个字出现） | console.log 时间戳差 |
| ASR RTF | < 0.2（iOS 真机） | 处理时间 / 音频时长 |
| 标点延迟 | < 100ms（对一句话补标点） | addPunctuation 耗时 |
| 内存占用 | < 400MB 增量（模型加载后） | Xcode Instruments |
| 模型加载时间 | < 3s（streaming paraformer init） | console.log |

### 回归验收

| # | 确认项 |
|---|--------|
| 1 | 唤醒词检测正常（kwsAudioFeeder 不受影响） |
| 2 | Speaker verification 正常（改用 verifySamples，无文件依赖） |
| 3 | TTS 播报正常 |
| 4 | 对话流程完整（唤醒 → 实时字幕 → 回合结束 → 标点 → 声纹验证 → LLM → 回复 → TTS） |
| 5 | overlay 自动隐藏逻辑不受影响 |
| 6 | 多句连续输入不被提前截断（"查天气，还有后天的也查"完整送入 LLM） |

## 风险与缓解

| 风险 | 影响 | 缓解方案 |
|------|------|----------|
| Streaming Paraformer 准确率低于 SenseVoice | 中英混合场景识别错误多 | 先验证准确率是否可接受；如不行可考虑换 transducer 模型 |
| `@siteed/sherpa-onnx.rn` 上游更新覆盖 patch | patch 失效需重做 | patch 改动极小（~15 行），同时向上游提 PR，合并后删除 patch |
| CT-Punc 对短文本效果差 | 标点错误（逗号句号位置不对） | 只在回合 finalize 时对完整合并文本调用；<3 字的文本不加标点 |
| 模型加载慢导致首次唤醒延迟 | 用户等待 | app 启动时预加载 streaming ASR（和唤醒词一起） |
| 等待窗口策略导致响应变慢 | 用户说完后多等 2s 才进 LLM | 可调节窗口时长；结合 VAD 能量检测缩短窗口 |
