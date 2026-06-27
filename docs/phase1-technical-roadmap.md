# Phase 1 完整技术路线（详细版）

> 消灭所有降级，7 条验收标准真实通过

---

## 一、服务器端：本地 PostgreSQL + pgvector

### 1.1 环境搭建（Docker Compose）

```yaml
# docker-compose.yml (项目根目录)
services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: looi-postgres
    restart: unless-stopped
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: looi
      POSTGRES_PASSWORD: superlooi123!
      POSTGRES_DB: looi
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./server/migrations/001_init.sql:/docker-entrypoint-initdb.d/001_init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U looi"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

```bash
# 启动
docker compose up -d

# 验证
docker exec looi-postgres psql -U looi -d looi -c "SELECT 1;"
```

### 1.2 建表 SQL

```sql
-- server/migrations/001_init.sql

CREATE EXTENSION IF NOT EXISTS vector;

-- Mem0 pgvector 后端所需表（mem0ai/oss 自动使用）
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT,
  embedding vector(1536),
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 向量检索索引（IVFFlat，数据量小时用 exact 也行）
CREATE INDEX IF NOT EXISTS memories_embedding_idx
  ON memories USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 主人档案
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL DEFAULT '主人',
  preferences JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO profiles (name) VALUES ('主人') ON CONFLICT DO NOTHING;

-- 对话历史
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id),
  messages JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 1.3 代码改动

**`server/src/config.ts`** 新增：
```typescript
database: {
  url: process.env.DATABASE_URL || "postgresql://looi:superlooi123!@localhost:5432/looi",
},
```

**`server/src/routes/memory.ts`** 改动：
```typescript
// 从
vectorStore: {
  provider: "memory",
  config: { collectionName: "looi_memories", dimension: 1536, dbPath }
}
// 改为
vectorStore: {
  provider: "pgvector",
  config: {
    connectionString: config.database.url,
    collectionName: "looi_memories",
    embeddingDimensions: 1536,
  }
}
// 删除 historyStore（或也改 PG）
```

**`.env` 新增：**
```
DATABASE_URL=postgresql://looi:superlooi123!@localhost:5432/looi
```

### 1.4 验证

```bash
curl -X POST http://localhost:8080/api/memory/add \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"我把钥匙放抽屉里了"}],"metadata":{"category":"placement"}}'

curl -X POST http://localhost:8080/api/memory/search \
  -H "Content-Type: application/json" \
  -d '{"query":"钥匙在哪"}'
# 应返回上面存入的记忆
```

---

## 二、服务器端：证据图片存储

### 2.1 文件结构

```
server/
├── data/
│   └── evidence/          # 存放证据图片，gitignore
├── src/
│   └── routes/
│       └── evidence.ts    # 新增
```

### 2.2 实现 `server/src/routes/evidence.ts`

```typescript
import { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { writeFile } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import path from "path";

const EVIDENCE_DIR = path.resolve(process.cwd(), "data", "evidence");

// 确保目录存在
if (!existsSync(EVIDENCE_DIR)) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
}

export async function evidenceRoutes(fastify: FastifyInstance) {
  // 上传证据图片
  fastify.post<{
    Body: { imageBase64: string };
  }>("/upload", async (request, reply) => {
    const { imageBase64 } = request.body;
    if (!imageBase64) {
      return reply.status(400).send({ error: "imageBase64 is required" });
    }

    const id = randomUUID();
    const filename = `${id}.jpg`;
    const filepath = path.join(EVIDENCE_DIR, filename);

    // 去掉 data URI 前缀
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    await writeFile(filepath, Buffer.from(base64Data, "base64"));

    const url = `${request.protocol}://${request.hostname}/api/evidence/${filename}`;
    return { url, filename };
  });

  // 静态文件服务
  fastify.get<{
    Params: { filename: string };
  }>("/:filename", async (request, reply) => {
    const { filename } = request.params;
    // 防路径穿越
    const safe = path.basename(filename);
    const filepath = path.join(EVIDENCE_DIR, safe);

    if (!existsSync(filepath)) {
      return reply.status(404).send({ error: "Not found" });
    }

    reply.header("Content-Type", "image/jpeg");
    reply.header("Cache-Control", "public, max-age=31536000");
    const { createReadStream } = await import("fs");
    return reply.send(createReadStream(filepath));
  });
}
```

### 2.3 注册路由

`server/src/index.ts` 加入：
```typescript
import { evidenceRoutes } from "./routes/evidence.js";
await server.register(evidenceRoutes, { prefix: "/api/evidence" });
```

### 2.4 APP 端访问

证据 URL 形如 `http://192.168.3.71:8080/api/evidence/xxxx.jpg`
APP 端直接 `<Image source={{ uri: evidenceUrl }} />` 加载。

---

## 三、服务器端：MiniCPM-V 本地推理 (llama.cpp server)

### 3.1 架构

```
Node Server (:8080)  ──HTTP──→  llama.cpp server (:8081)
                                  ├── MiniCPM-V 2.6 Q4_K_M (~4.7GB)
                                  └── mmproj (~0.6GB)
```

两个独立进程。Node 通过 `fetch("http://localhost:8081/v1/chat/completions")` 调用。

### 3.2 环境搭建

```bash
# 编译 llama.cpp（含 Metal）
cd ~/tools
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
cmake -B build -DGGML_METAL=ON
cmake --build build --config Release -j$(nproc)

# 下载 MiniCPM-V 2.6 GGUF
mkdir -p ~/models/minicpm-v-2.6
cd ~/models/minicpm-v-2.6

# 从 openbmb/MiniCPM-V-2_6-gguf 下载：
# - ggml-model-Q4_K_M.gguf (~4.7GB)
# - mmproj-model-f16.gguf  (~0.6GB)
huggingface-cli download openbmb/MiniCPM-V-2_6-gguf \
  ggml-model-Q4_K_M.gguf mmproj-model-f16.gguf \
  --local-dir .
```

### 3.3 启动脚本 `server/scripts/start-vision.sh`

```bash
#!/bin/bash
LLAMA_CPP=~/tools/llama.cpp/build/bin/llama-server
MODEL=~/models/minicpm-v-2.6/ggml-model-Q4_K_M.gguf
MMPROJ=~/models/minicpm-v-2.6/mmproj-model-f16.gguf

$LLAMA_CPP \
  --model "$MODEL" \
  --mmproj "$MMPROJ" \
  --port 8081 \
  --host 0.0.0.0 \
  -ngl 99 \
  -c 4096 \
  --threads 8
```

### 3.4 修改 `server/src/routes/vision.ts`

```typescript
import { FastifyInstance } from "fastify";
import { config } from "../config.js";

export async function visionRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: { image: string; prompt?: string };
  }>("/describe", async (request, reply) => {
    const { image, prompt } = request.body;

    if (!image) {
      return reply.status(400).send({ error: "image is required (base64)" });
    }

    const systemPrompt = prompt ||
      "你是一个视觉助手。请详细描述图片中的场景，重点描述物品的位置和环境。用简洁的中文回答。";

    const imageUrl = image.startsWith("data:")
      ? image
      : `data:image/jpeg;base64,${image}`;

    try {
      const response = await fetch(`${config.vision.serverUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "minicpm-v-2.6",
          messages: [{
            role: "user",
            content: [
              { type: "text", text: systemPrompt },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          }],
          max_tokens: 500,
          temperature: 0.3,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Vision server error ${response.status}: ${err}`);
      }

      const data = await response.json() as any;
      const description = data.choices?.[0]?.message?.content || "无法识别图片内容";
      return { description };
    } catch (error: any) {
      fastify.log.error(error, "Vision describe failed");
      return reply.status(500).send({ error: "Vision processing failed", details: error.message });
    }
  });
}
```

### 3.5 Config 改动

```typescript
vision: {
  serverUrl: process.env.VISION_SERVER_URL || "http://localhost:8081",
  enabled: process.env.VISION_ENABLED !== "false",
},
```

### 3.6 创建 `server/src/vision/scene-analyzer.ts`

```typescript
/**
 * 连续帧场景分析 — 检测场景变化
 * 用于 streaming 模式下的智能截帧
 */
export class SceneAnalyzer {
  private lastDescription: string | null = null;
  private changeThreshold = 0.3;

  /**
   * 判断新场景描述是否与上次有显著变化
   */
  hasSignificantChange(newDescription: string): boolean {
    if (!this.lastDescription) {
      this.lastDescription = newDescription;
      return true;
    }

    // 简单相似度：共有字符比例
    const overlap = this.computeOverlap(this.lastDescription, newDescription);
    const changed = overlap < (1 - this.changeThreshold);

    if (changed) {
      this.lastDescription = newDescription;
    }
    return changed;
  }

  private computeOverlap(a: string, b: string): number {
    const setA = new Set(a.split(""));
    const setB = new Set(b.split(""));
    const intersection = [...setA].filter(c => setB.has(c)).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 1 : intersection / union;
  }

  reset(): void {
    this.lastDescription = null;
  }
}
```

### 3.7 验证

```bash
# 启动 vision server
bash server/scripts/start-vision.sh &

# 测试
curl -X POST http://localhost:8080/api/vision/describe \
  -H "Content-Type: application/json" \
  -d '{"image":"<base64_of_a_test_image>"}'
# 应返回中文场景描述
```

---

## 四、服务器端：Voice + Camera 联合观测路由

### 4.1 创建 `server/src/routes/observe.ts`

```typescript
import { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { randomUUID } from "crypto";
import { writeFile } from "fs/promises";
import path from "path";

const EVIDENCE_DIR = path.resolve(process.cwd(), "data", "evidence");

export async function observeRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/observe/voice-visual
   * 联合语音+视觉观测：一步完成 vision理解 + 记忆存储 + 证据保存
   */
  fastify.post<{
    Body: { transcript: string; imageBase64: string };
  }>("/voice-visual", async (request, reply) => {
    const { transcript, imageBase64 } = request.body;

    if (!transcript || !imageBase64) {
      return reply.status(400).send({ error: "transcript and imageBase64 required" });
    }

    try {
      // 1. Vision: 描述图片
      const visionRes = await fetch(`${config.vision.serverUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "minicpm-v-2.6",
          messages: [{
            role: "user",
            content: [
              { type: "text", text: `用户说："${transcript}"。请描述画面中的场景，重点描述物品位置。` },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
            ],
          }],
          max_tokens: 300,
        }),
      });
      const visionData = await visionRes.json() as any;
      const description = visionData.choices?.[0]?.message?.content || "";

      // 2. 存证据图片
      const evidenceId = randomUUID();
      const filename = `${evidenceId}.jpg`;
      const filepath = path.join(EVIDENCE_DIR, filename);
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
      await writeFile(filepath, Buffer.from(base64Data, "base64"));
      const evidenceUri = `http://${request.hostname}/api/evidence/${filename}`;

      // 3. Memory: 合并内容存入
      const { getMemory } = await import("./memory.js");
      const mergedContent = `${transcript}（视觉补充：${description}）`;
      await getMemory().add(
        [{ role: "user", content: mergedContent }],
        {
          userId: "owner-1",
          metadata: {
            category: "placement",
            source: "voice+camera",
            timestamp: new Date().toISOString(),
            evidenceUri,
            visionDescription: description,
          },
        }
      );

      // 4. LLM: 生成确认回复
      const llmRes = await fetch(`${config.llm.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.llm.apiKey}`,
        },
        body: JSON.stringify({
          model: config.llm.model,
          messages: [
            { role: "system", content: "你是 LOOI 记忆助手。用户刚让你记住一个东西。简短确认，复述物品和位置。不超过 25 字。" },
            { role: "user", content: `用户说：${transcript}\n画面描述：${description}` },
          ],
          max_tokens: 50,
        }),
      });
      const llmData = await llmRes.json() as any;
      const response = llmData.choices?.[0]?.message?.content || "好的，我记住了。";

      return { response, evidenceUri, description };
    } catch (error: any) {
      fastify.log.error(error, "Voice-visual observe failed");
      return reply.status(500).send({ error: error.message });
    }
  });
}
```

### 4.2 注册路由

```typescript
// server/src/index.ts
import { observeRoutes } from "./routes/observe.js";
await server.register(observeRoutes, { prefix: "/api/observe" });
```

### 4.3 验证

```bash
curl -X POST http://localhost:8080/api/observe/voice-visual \
  -H "Content-Type: application/json" \
  -d '{
    "transcript": "记住这个放这了",
    "imageBase64": "<base64_of_desk_photo>"
  }'
# 应返回: { response: "好的，钥匙在书桌键盘旁边", evidenceUri: "http://...", description: "..." }
```

---

## 五、APP 端：Voice + Camera 联动

### 5.1 新增 API 方法 — `src/server-api/client.ts`

```typescript
export const observeService = {
  async voiceVisual(transcript: string, imageBase64: string) {
    return fetchJSON<{ response: string; evidenceUri: string; description: string }>(
      "/api/observe/voice-visual",
      {
        method: "POST",
        body: JSON.stringify({ transcript, imageBase64 }),
      }
    );
  },
};
```

### 5.2 修改 `VoicePerceiver.finishListening()`

关键改动——在 STT 之后加入视觉判断分支：

```typescript
// src/perceivers/voice-perceiver.ts (finishListening 方法核心逻辑)

const transcript = await sttService.stopAndTranscribe();
// ...

// 新增：检测是否需要视觉辅助
if (hasVisualReference(transcript)) {
  const frame = cameraPerceiver.getLatestFrame();
  if (frame) {
    // 走联合端点
    const result = await observeService.voiceVisual(transcript, frame);
    conversationStore.addMessage({ role: "assistant", content: result.response });
    // 存 evidenceUri 到当前消息
    conversationStore.setLastEvidenceUri(result.evidenceUri);
    // TTS
    if (userStore.preferences.ttsEnabled) {
      await ttsService.speak({ text: result.response });
    }
    return; // 不走普通流程
  }
}

// 原有纯语音流程...
```

### 5.3 创建 `src/camera/uploader.ts`

```typescript
import { getServerUrl } from "../server-api/client";

export async function uploadEvidenceFrame(base64: string): Promise<string> {
  const res = await fetch(`${getServerUrl()}/api/evidence/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageBase64: base64 }),
  });
  const data = await res.json();
  return data.url;
}

// WebSocket 帧流（streaming 模式）
export class FrameStreamer {
  private ws: WebSocket | null = null;

  connect(): void {
    const url = getServerUrl().replace("http", "ws");
    this.ws = new WebSocket(`${url}/ws/frames`);
  }

  sendFrame(base64: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(base64);
    }
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
}
```

---

## 六、APP 端：UI 展示证据图片

### 6.1 修改 `src/ui/MemoryCard.tsx`

```typescript
import { Image } from "react-native";

// 在卡片内容区域加入：
{memory.metadata?.evidenceUri && (
  <Image
    source={{ uri: memory.metadata.evidenceUri }}
    style={{ width: "100%", height: 120, borderRadius: 8, marginTop: 8 }}
    resizeMode="cover"
  />
)}
```

### 6.2 修改 `src/ui/ChatBubble.tsx`

assistant 消息如果有关联证据，气泡下方展示缩略图。需要在 `ChatMessage` 类型中加入 `evidenceUri?: string` 字段。

### 6.3 修改 `src/store/conversation.ts`

```typescript
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  evidenceUri?: string;  // 新增
  timestamp: number;
}
```

---

## 七、Native Module：sherpa-onnx KWS + Speaker ID

这是最复杂的部分。分为独立的 Expo Module。

### 7.1 架构概览

```
native-modules/
└── expo-sherpa-kws/                  # Expo Module
    ├── src/
    │   └── index.ts                  # TS API
    ├── ios/
    │   ├── ExpoSherpaKwsModule.swift # Swift 实现
    │   └── sherpa-onnx.xcframework/  # 预编译框架（pod install 下载）
    ├── android/
    │   ├── src/main/java/.../ExpoSherpaKwsModule.kt
    │   ├── src/main/jniLibs/arm64-v8a/
    │   │   ├── libsherpa-onnx-jni.so
    │   │   └── libonnxruntime.so
    │   └── CMakeLists.txt
    ├── expo-module.config.json
    └── package.json
```

### 7.2 模型清单

| 能力 | 模型 | 来源 | 大小 |
|------|------|------|------|
| KWS | sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20 | [GitHub Release](https://github.com/k2-fsa/sherpa-onnx/releases) | ~38MB（含 int8 encoder ~4.4MB） |
| Speaker ID | 3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k | [sherpa-onnx models](https://k2-fsa.github.io/sherpa/onnx/speaker-identification/index.html) | ~20MB |

运行时只加载 int8 encoder (~4.4MB) + decoder (~743KB) + joiner (~85KB) ≈ **~5.2MB 用于 KWS**。

### 7.3 KWS keywords 配置

sherpa-onnx KWS 使用 `phone+ppinyin` 格式的 keywords.txt。需要用 `sherpa-onnx-cli text2token` 从原始关键词生成：

```bash
# 原始关键词
echo "嘿魔戈 @HEY_MOGE" > keywords_raw.txt

# 转换为 token 格式
sherpa-onnx-cli text2token \
  --tokens tokens.txt \
  --tokens-type phone+ppinyin \
  --lexicon en.phone \
  keywords_raw.txt keywords.txt
```

### 7.4 iOS 实现要点

**关键 C API 调用链：**

```swift
// ExpoSherpaKwsModule.swift

import SherpaOnnx  // xcframework 中的 C header

class KeywordSpotterWrapper {
  private var spotter: OpaquePointer?
  private var stream: OpaquePointer?

  func initialize(modelDir: String) {
    var config = SherpaOnnxKeywordSpotterConfig()
    // 配置 transducer 模型路径
    config.model_config.transducer.encoder = "\(modelDir)/encoder-int8.onnx"
    config.model_config.transducer.decoder = "\(modelDir)/decoder-fp32.onnx"
    config.model_config.transducer.joiner = "\(modelDir)/joiner-int8.onnx"
    config.model_config.tokens = "\(modelDir)/tokens.txt"
    config.keywords_file = "\(modelDir)/keywords.txt"
    config.model_config.num_threads = 2
    config.model_config.provider = "coreml" // 或 "cpu"
    config.keywords_threshold = 0.25
    config.keywords_score = 3.0

    spotter = SherpaOnnxCreateKeywordSpotter(&config)
    stream = SherpaOnnxCreateKeywordStream(spotter)
  }

  func feedAudio(samples: [Float], sampleRate: Int32) {
    // 喂入音频数据
    samples.withUnsafeBufferPointer { ptr in
      SherpaOnnxOnlineStreamAcceptWaveform(stream, sampleRate, ptr.baseAddress, Int32(samples.count))
    }

    // 尝试解码
    while SherpaOnnxIsKeywordStreamReady(spotter, stream) == 1 {
      SherpaOnnxDecodeKeywordStream(spotter, stream)
    }

    // 检查结果
    let result = SherpaOnnxGetKeywordResult(spotter, stream)
    if let keyword = result?.pointee.keyword {
      let detected = String(cString: keyword)
      if !detected.isEmpty {
        // 触发回调！
        onKeywordDetected(detected)
        SherpaOnnxResetKeywordStream(spotter, stream)
      }
    }
  }
}
```

**音频采集：** 用 `AVAudioEngine` 的 tap 持续获取 PCM 数据喂给 KWS。

```swift
let audioEngine = AVAudioEngine()
let inputNode = audioEngine.inputNode
let format = inputNode.outputFormat(forBus: 0)

inputNode.installTap(onBus: 0, bufferSize: 1600, format: format) { buffer, time in
  // 转换为 Float32 16kHz mono → 喂给 KWS
  let samples = convertToFloat16k(buffer)
  self.kwsWrapper.feedAudio(samples: samples, sampleRate: 16000)
}
```

### 7.5 Speaker ID 实现要点

```swift
class SpeakerVerifier {
  private var extractor: OpaquePointer?
  private var enrolledEmbedding: [Float]?  // 从 SecureStore 加载

  func initialize(modelPath: String) {
    var config = SherpaOnnxSpeakerEmbeddingExtractorConfig()
    config.model = modelPath
    config.num_threads = 2
    extractor = SherpaOnnxCreateSpeakerEmbeddingExtractor(&config)
  }

  func extractEmbedding(samples: [Float], sampleRate: Int32) -> [Float] {
    let stream = SherpaOnnxSpeakerEmbeddingExtractorCreateStream(extractor)
    samples.withUnsafeBufferPointer { ptr in
      SherpaOnnxOnlineStreamAcceptWaveform(stream, sampleRate, ptr.baseAddress, Int32(samples.count))
    }
    SherpaOnnxSpeakerEmbeddingExtractorInputFinished(stream)
    SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding(extractor, stream)

    let dim = SherpaOnnxSpeakerEmbeddingExtractorDim(extractor)
    let embPtr = SherpaOnnxSpeakerEmbeddingExtractorGetEmbedding(extractor, stream)
    let embedding = Array(UnsafeBufferPointer(start: embPtr, count: Int(dim)))

    SherpaOnnxDestroyOnlineStream(stream)
    return embedding
  }

  func verify(samples: [Float]) -> Bool {
    guard let enrolled = enrolledEmbedding else { return false }
    let current = extractEmbedding(samples: samples, sampleRate: 16000)
    let similarity = cosineSimilarity(enrolled, current)
    return similarity > 0.6
  }

  private func cosineSimilarity(_ a: [Float], _ b: [Float]) -> Float {
    let dot = zip(a, b).reduce(Float(0)) { $0 + $1.0 * $1.1 }
    let normA = sqrt(a.reduce(Float(0)) { $0 + $1 * $1 })
    let normB = sqrt(b.reduce(Float(0)) { $0 + $1 * $1 })
    return dot / (normA * normB + 1e-8)
  }
}
```

### 7.6 Android 实现要点

Android 侧使用 JNI。sherpa-onnx 官方提供了 `SherpaOnnxSpeakerIdentification` 示例 app，可以直接参考其 Kotlin API：

```kotlin
// ExpoSherpaKwsModule.kt

class KeywordSpotterWrapper(private val modelDir: String) {
  private external fun createKeywordSpotter(config: String): Long
  private external fun feedAudio(handle: Long, samples: FloatArray, sampleRate: Int)
  private external fun getResult(handle: Long): String?
  private external fun reset(handle: Long)

  companion object {
    init { System.loadLibrary("sherpa-onnx-jni") }
  }
}
```

实际 sherpa-onnx Android 示例里有完整的 JNI 封装，可直接复用。

### 7.7 TS API 层

```typescript
// native-modules/expo-sherpa-kws/src/index.ts
import { NativeModule, EventEmitter } from "expo-modules-core";

interface SherpaKwsModule extends NativeModule {
  startKWS(modelDir: string, keywordsFile: string): Promise<void>;
  stopKWS(): Promise<void>;
  enrollSpeaker(audioPath: string): Promise<boolean>;
  verifySpeaker(audioPath: string): Promise<{ passed: boolean; score: number }>;
}

const module = requireNativeModule<SherpaKwsModule>("ExpoSherpaKws");
const emitter = new EventEmitter(module);

export function startKeywordListening(modelDir: string, keywordsFile: string) {
  return module.startKWS(modelDir, keywordsFile);
}

export function stopKeywordListening() {
  return module.stopKWS();
}

export function onKeywordDetected(callback: (keyword: string) => void) {
  return emitter.addListener("onKeywordDetected", callback);
}

export function enrollSpeaker(audioPath: string) {
  return module.enrollSpeaker(audioPath);
}

export function verifySpeaker(audioPath: string) {
  return module.verifySpeaker(audioPath);
}
```

### 7.8 STT：使用 react-native-sherpa-onnx

STT 不需要自建——直接用 `react-native-sherpa-onnx` 的现有能力：

```typescript
// src/voice/stt.ts (重写)
import { createSTT } from "react-native-sherpa-onnx";

const stt = createSTT({
  modelDir: "sensevoice-small",  // 按需下载到设备
  modelType: "sensevoice",
});

export class STTService {
  async startRecording() {
    await stt.startLiveCapture({ sampleRate: 16000 });
  }

  async stopAndTranscribe(): Promise<string> {
    const result = await stt.stopLiveCapture();
    return result.text;
  }
}
```

### 7.9 重写 `src/voice/wakeword.ts`

```typescript
import { startKeywordListening, stopKeywordListening, onKeywordDetected } from "expo-sherpa-kws";
import { Asset } from "expo-asset";

export class WakewordService {
  private listeners: Array<() => void> = [];
  private subscription: any = null;

  async start(): Promise<void> {
    const modelDir = await this.getModelDir();
    const keywordsFile = `${modelDir}/keywords.txt`;

    await startKeywordListening(modelDir, keywordsFile);

    this.subscription = onKeywordDetected((keyword) => {
      console.log(`[Wakeword] Detected: ${keyword}`);
      for (const listener of this.listeners) {
        listener();
      }
    });
  }

  async stop(): Promise<void> {
    await stopKeywordListening();
    this.subscription?.remove();
  }

  onWakeword(callback: () => void): () => void {
    this.listeners.push(callback);
    return () => { this.listeners = this.listeners.filter(l => l !== callback); };
  }

  private async getModelDir(): Promise<string> {
    // 模型文件路径（首次下载后缓存到本地）
    return `${FileSystem.documentDirectory}models/kws-zipformer-zh-en`;
  }
}

export const wakewordService = new WakewordService();
```

### 7.10 重写 `src/voice/speaker-id.ts`

```typescript
import { enrollSpeaker, verifySpeaker } from "expo-sherpa-kws";
import * as SecureStore from "expo-secure-store";

export class SpeakerIdService {
  get isEnrolled(): boolean {
    // 检查 SecureStore 中是否有 embedding
    return SecureStore.getItem("speaker_enrolled") === "true";
  }

  /**
   * 注册流程：引导用户说三遍 "Hey Moge"
   * 录三段音频 → 分别提取 embedding → 取平均 → 存储
   */
  async enroll(audioPath: string): Promise<boolean> {
    const result = await enrollSpeaker(audioPath);
    if (result) {
      await SecureStore.setItemAsync("speaker_enrolled", "true");
    }
    return result;
  }

  /**
   * 验证：KWS 命中后，取那段音频做声纹比对
   */
  async verify(audioPath?: string): Promise<boolean> {
    if (!this.isEnrolled) return true; // 未注册时直接通过
    if (!audioPath) return true;

    const { passed, score } = await verifySpeaker(audioPath);
    console.log(`[SpeakerID] Verify score: ${score}, passed: ${passed}`);
    return passed;
  }
}

export const speakerIdService = new SpeakerIdService();
```

---

## 八、CalendarPerceiver → ReminderScheduler 接线

### 8.1 创建 `src/core/app-bootstrap.ts`

```typescript
import { perceiverManager } from "./perceiver-manager";
import { voicePerceiver } from "../perceivers/voice-perceiver";
import { calendarPerceiver } from "../perceivers/calendar-perceiver";
import { cameraPerceiver } from "../perceivers/camera-perceiver";
import { reminderScheduler } from "../reminder/reminder-scheduler";
import { setupNotifications, requestNotificationPermissions } from "../reminder/notification";
import { useUserStore } from "../store/user";

export async function bootstrapApp() {
  // 通知权限
  setupNotifications();
  await requestNotificationPermissions();

  // 注册所有 Perceivers
  perceiverManager.register(voicePerceiver);
  perceiverManager.register(calendarPerceiver);
  perceiverManager.register(cameraPerceiver);

  // 统一 Observation 处理
  perceiverManager.onObservation(async (observation) => {
    const { source } = observation.metadata;

    if (source === "calendar") {
      await reminderScheduler.processCalendarObservation(observation);
    }
    // voice 和 camera 的处理已在各自 perceiver 内部完成
  });

  // 启动
  const prefs = useUserStore.getState().preferences;
  if (prefs.calendarEnabled) {
    await perceiverManager.start("calendar");
  }
  // voice perceiver 在 KWS 就绪后启动
  await perceiverManager.start("voice");
}
```

### 8.2 在 `app/_layout.tsx` 中调用

```typescript
import { bootstrapApp } from "@/src/core/app-bootstrap";

useEffect(() => {
  bootstrapApp().catch(console.error);
}, []);
```

---

## 九、测试方案

### 9.1 服务器端测试 (`server/tests/`)

使用 vitest：

```bash
pnpm add -D vitest
```

| 文件 | 测试内容 |
|------|----------|
| `memory.test.ts` | add → search 找得回；category filter；evidenceUri 存取 |
| `llm.test.ts` | 意图分类准确率（"放...了"→store, "在哪"→search）；无 facts 时回复"不记得" |
| `vision.test.ts` | 发图片 → 返回非空中文描述（需 llama.cpp server 运行） |
| `observe.test.ts` | voice-visual 联合端点全流程 |

### 9.2 APP 端冒烟测试（手动 + 录屏）

| 场景 | 预期 |
|------|------|
| 说 "我把钥匙放抽屉里了" | 确认 + PG 有记录 |
| 说 "记住这个放这了"（对着桌面） | 截帧 + vision 描述 + 证据存储 |
| 说 "钥匙放哪了" | 正确回答 + 展示证据图 |
| 日历 15 分钟后有事件 | 推送通知 + TTS |
| 问一个没记过的东西 | "我不记得" |
| "Hey Moge" 唤醒 | KWS 触发 → 声纹通过 → STT |
| 非主人说 "Hey Moge" | 声纹不通过 → 忽略 |
| iOS + Android | 双平台跑通 |

---

## 十、部署与运维

### 10.1 M2 Max 上需要运行的服务

| 服务 | 部署方式 | 端口 | 说明 |
|------|----------|------|------|
| PostgreSQL + pgvector | Docker compose | 5432 | 记忆向量存储 |
| llama.cpp vision server | **宿主机** | 8081 | 需要 Metal GPU 加速 |
| Node LOOI server | **宿主机** (pnpm dev) | 8080 | 开发阶段直跑，后期 Dockerfile |

```bash
# 1. 启动 PostgreSQL (Docker)
docker compose up -d

# 2. 启动 llama.cpp vision server (宿主机，Metal)
bash server/scripts/start-vision.sh

# 3. 启动 Node server (宿主机)
cd server && pnpm dev
```

开发阶段建议用 tmux/screen 管三个终端，或者用 pm2 管理 vision server：

```bash
pm2 start server/scripts/start-vision.sh --name looi-vision
```

### 10.2 最终 .env

```env
# LLM (fact 提取 + 对话生成)
LLM_BASE_URL=https://llmproxy-dev.devops.moego.pet
LLM_API_KEY=sk-xxx
LLM_MODEL=gpt-4o
EMBEDDING_MODEL=text-embedding-3-small

# Database
DATABASE_URL=postgresql://looi:superlooi123!@localhost:5432/looi

# Vision (本地 llama.cpp server)
VISION_SERVER_URL=http://localhost:8081

# MiniMax TTS
MINIMAX_API_KEY=sk-xxx
MINIMAX_GROUP_ID=xxx

# Server
PORT=8080
HOST=0.0.0.0
```

### 10.3 清理

- 删除 `@supabase/supabase-js` 依赖（server + app）
- 删除 `supabase/` 目录
- 删除 `server/src/routes/stt.ts`（STT 移到设备端）
- 更新 README

---

## 时间估算

| Step | 内容 | 预计天数 | 并行组 |
|------|------|----------|--------|
| 1 | PG + pgvector | 0.5 | A |
| 2 | 证据图片路由 | 0.5 | A |
| 3 | MiniCPM-V llama.cpp | 1 | A |
| 4 | 联合观测路由 | 0.5 | A (依赖 1-3) |
| 5 | APP 联动 | 1 | C (依赖 4) |
| 6 | UI 证据展示 | 0.5 | C |
| 7a-c | Native Module 编译+桥接 | 4-5 | B |
| 7d-f | 集成到 VoicePerceiver | 2 | B |
| 8 | 日历接线 | 0.5 | D |
| 9 | 测试 | 1.5 | E |
| 10 | 清理验收 | 0.5 | E |

**总计：~12-14 天（A+B 并行，C 等 A 完成后跟进）**
