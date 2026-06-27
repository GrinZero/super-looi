# Phase 1 完整补齐方案（最终版）

> 目标：消灭所有降级项，7 条验收标准全部真实通过
> 详细技术实现：[docs/phase1-technical-roadmap.md](../../docs/phase1-technical-roadmap.md)

---

## 调研结论

| 原计划假设 | 实际情况 | 修正方案 |
|-----------|---------|---------|
| react-native-sherpa-onnx 支持 KWS + Speaker ID | ❌ 只有 STT/TTS | 自建 Expo Native Module，调 sherpa-onnx C API |
| node-llama-cpp 支持 Vision | ❌ 无多模态 API | 宿主机跑独立 llama.cpp server 进程 (Metal 加速) |
| Mem0 需要单独部署 | ❌ `mem0ai/oss` 是嵌入式 npm 库 | 直接改 vectorStore provider 为 pgvector |

---

## 架构决策

| 项 | 方案 | 部署方式 |
|----|------|----------|
| PostgreSQL + pgvector | 记忆向量存储 | **Docker compose** |
| 证据图片 | M2 Max 本地磁盘，HTTP 静态路由 | Node server 提供 |
| llama.cpp vision server | MiniCPM-V 2.6 Q4_K_M + mmproj | **宿主机**（Metal GPU） |
| Node LOOI server | Fastify + mem0ai/oss + 路由 | **宿主机**（pnpm dev） |
| 唤醒词 KWS | sherpa-onnx C API | 自建 Expo Module（设备端） |
| 声纹验证 | sherpa-onnx Speaker Embedding | 自建 Expo Module（设备端） |
| STT | react-native-sherpa-onnx (SenseVoice) | 设备端 |
| TTS | MiniMax API | 保持不变 |

---

## Step 1: Docker — PostgreSQL + pgvector

> 详细 SQL: [技术路线 §一](../../docs/phase1-technical-roadmap.md#一服务器端本地-postgresql--pgvector)

**任务：**
- [ ] 创建 `docker-compose.yml`：
  ```yaml
  services:
    postgres:
      image: pgvector/pgvector:pg16
      ports:
        - "5432:5432"
      environment:
        POSTGRES_USER: looi
        POSTGRES_PASSWORD: superlooi123!
        POSTGRES_DB: looi
      volumes:
        - pgdata:/var/lib/postgresql/data
        - ./server/migrations/001_init.sql:/docker-entrypoint-initdb.d/001_init.sql
  volumes:
    pgdata:
  ```
- [ ] 创建 `server/migrations/001_init.sql`（建表 + 启用 vector 扩展）
- [ ] 修改 `server/src/routes/memory.ts`：provider `"memory"` → `"pgvector"`
- [ ] 修改 `server/src/config.ts`：加入 `database.url`
- [ ] `.env` 加入 `DATABASE_URL=postgresql://looi:superlooi123!@localhost:5432/looi`
- [ ] `docker compose up -d` → 验证 add/search/getAll

---

## Step 2: 服务器 — 证据图片存储

> 详细实现: [技术路线 §二](../../docs/phase1-technical-roadmap.md#二服务器端证据图片存储)

**任务：**
- [ ] 创建 `server/data/evidence/`（.gitignore）
- [ ] 创建 `server/src/routes/evidence.ts`：
  - POST `/api/evidence/upload` — 接收 base64 → 存文件 → 返回 URL
  - GET `/api/evidence/:filename` — 静态文件服务
- [ ] 注册路由到 `server/src/index.ts`
- [ ] 验证：上传 → URL 可在浏览器打开

---

## Step 3: 宿主机 — MiniCPM-V 本地推理

> 详细实现: [技术路线 §三](../../docs/phase1-technical-roadmap.md#三服务器端minicpm-v-本地推理-llamacpp-server)

**架构：** Node (:8080) → HTTP → llama.cpp server (:8081, 宿主机 Metal)

**任务：**
- [ ] 编译 llama.cpp（`cmake -B build -DGGML_METAL=ON`）
- [ ] 下载模型：
  - `openbmb/MiniCPM-V-2_6-gguf` → `ggml-model-Q4_K_M.gguf` (~4.7GB)
  - `mmproj-model-f16.gguf` (~0.6GB)
- [ ] 创建 `server/scripts/start-vision.sh`（`llama-server --model ... --mmproj ... --port 8081 -ngl 99`）
- [ ] 修改 `server/src/routes/vision.ts`：从 OpenAI API → 调本地 localhost:8081
- [ ] 创建 `server/src/vision/scene-analyzer.ts`
- [ ] `.env` 加入 `VISION_SERVER_URL=http://localhost:8081`
- [ ] 验证：发 base64 图片 → 返回中文场景描述

---

## Step 4: 服务器 — Voice + Camera 联合路由

> 详细实现: [技术路线 §四](../../docs/phase1-technical-roadmap.md#四服务器端voice--camera-联合观测路由)

**任务：**
- [ ] 创建 `server/src/routes/observe.ts`：
  - POST `/api/observe/voice-visual`
  - 流程：vision 描述 → 存证据图 → memory.add(合并内容) → LLM 确认回复
  - 返回 `{ response, evidenceUri, description }`
- [ ] 注册路由
- [ ] 验证：transcript + image → 完整响应

---

## Step 5: APP 端 — Voice + Camera 联动

> 详细实现: [技术路线 §五](../../docs/phase1-technical-roadmap.md#五app-端voice--camera-联动)

**任务：**
- [ ] `src/server-api/client.ts` 新增 `observeService.voiceVisual()`
- [ ] 修改 `VoicePerceiver.finishListening()`：
  - STT 后检测 `hasVisualReference(transcript)`
  - 有指示词 + 有帧 → 走联合端点
  - 否则 → 原有纯语音流程
- [ ] 创建 `src/camera/uploader.ts`（HTTP 上传 + WebSocket 帧流）
- [ ] 确保 Camera UI 组件持续喂帧给 `cameraPerceiver.addFrame()`
- [ ] 验证："记住这个放这了" → 截帧 → 确认 + evidenceUri

---

## Step 6: APP 端 — UI 展示证据图片

> 详细实现: [技术路线 §六](../../docs/phase1-technical-roadmap.md#六app-端ui-展示证据图片)

**任务：**
- [ ] `src/store/conversation.ts`：ChatMessage 加 `evidenceUri?: string`
- [ ] `src/ui/MemoryCard.tsx`：有 evidenceUri → `<Image source={{ uri }}/>` 缩略图
- [ ] `src/ui/ChatBubble.tsx`：assistant 消息含证据时展示
- [ ] 验证：记忆列表和对话页都能显示证据图

---

## Step 7: Native Module — sherpa-onnx KWS + Speaker ID + STT

> 详细实现: [技术路线 §七](../../docs/phase1-technical-roadmap.md#七native-modulesherpa-onnx-kws--speaker-id)

这是最大的工程量。

### 7a. 编译 sherpa-onnx 原生库
- [ ] iOS: `build-ios.sh` → xcframework（或用 react-native-sherpa-onnx 附带的）
- [ ] Android: 下载预编译 `libsherpa-onnx-jni.so` + `libonnxruntime.so`

### 7b. 创建 Expo Module `expo-sherpa-kws`
- [ ] 目录结构：`native-modules/expo-sherpa-kws/`
- [ ] `expo-module.config.json` + `package.json`
- [ ] TS API：`startKWS()` / `stopKWS()` / `onKeywordDetected()` / `enrollSpeaker()` / `verifySpeaker()`

### 7c. iOS 实现 (Swift)
- [ ] KWS: `SherpaOnnxCreateKeywordSpotter()` + `AVAudioEngine` tap 喂音频
- [ ] Speaker ID: `SherpaOnnxSpeakerEmbeddingExtractor` + cosine 比对
- [ ] 事件回调给 JS 层

### 7d. Android 实现 (Kotlin)
- [ ] KWS: JNI 调用 + AudioRecord 喂音频
- [ ] Speaker ID: JNI embedding 提取 + cosine 比对

### 7e. 下载模型
- [ ] KWS: `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`（int8 encoder ~5MB）
- [ ] Speaker ID: `3dspeaker_speech_eres2net_base_sv_zh-cn` (~20MB)
- [ ] 配置 keywords.txt（"嘿魔戈" → text2token 转换）

### 7f. STT 改为设备端
- [ ] 集成 `react-native-sherpa-onnx` 的 SenseVoice STT
- [ ] 重写 `src/voice/stt.ts`：本地推理，不走服务器
- [ ] 首次启动按需下载 SenseVoice 模型 (~254MB)

### 7g. 重写语音层
- [ ] `src/voice/wakeword.ts`：真实 KWS 常驻监听
- [ ] `src/voice/speaker-id.ts`：注册(3 遍) + 验证(cosine > 0.6)
- [ ] 验证完整状态机：SLEEPING → KWS 命中 → VERIFYING → LISTENING → PROCESSING → SPEAKING → SLEEPING

---

## Step 8: CalendarPerceiver → ReminderScheduler 接线

> 详细实现: [技术路线 §八](../../docs/phase1-technical-roadmap.md#八calendarperceiver--reminderscheduler-接线)

**任务：**
- [ ] 创建 `src/core/app-bootstrap.ts`：初始化所有 perceiver + 事件接线
- [ ] `app/_layout.tsx` useEffect 调用 `bootstrapApp()`
- [ ] calendarPerceiver observation → reminderScheduler → 通知 + TTS
- [ ] 验证：添加即将到来的日历事件 → 收到提醒

---

## Step 9: 测试

> 详细测试方案: [技术路线 §九](../../docs/phase1-technical-roadmap.md#九测试方案)

**任务：**
- [ ] `server/tests/memory.test.ts`
- [ ] `server/tests/llm.test.ts`
- [ ] `server/tests/vision.test.ts`
- [ ] `server/tests/observe.test.ts`
- [ ] APP 手动冒烟测试（录屏）
  - 纯语音记事 / 视觉记事 / 检索+证据 / 日历提醒
  - "Hey Moge" 唤醒 + 声纹
  - iOS + Android

---

## Step 10: 清理 + 验收

**任务：**
- [ ] 删除 `@supabase/supabase-js` 依赖
- [ ] 删除 `supabase/` 目录（SQL 已迁移到 `server/migrations/`）
- [ ] 删除 `server/src/routes/stt.ts`（STT 移到设备端）
- [ ] 更新 `.env.example`
- [ ] 更新 README（Docker + 宿主机部署说明）
- [ ] 7 条验收标准逐条确认
- [ ] commit + tag `phase1-complete`

---

## 执行顺序

```
docker compose up (PG)
        │
Step 1 ──┐
Step 2 ──┼──→ Step 4 (联合路由) ──→ Step 5 (APP联动) ──→ Step 6 (UI)
Step 3 ──┘                                                    │
(宿主机 llama.cpp)                                            ↓
                                                         Step 9 (测试)
Step 7 (Native Module: KWS + Speaker ID + STT) ──────→ Step 9
Step 8 (日历接线) ───────────────────────────────────→ Step 9
                                                              │
                                                              ↓
                                                        Step 10 (清理)
```

**并行组：**
- **Group A** (3 天): Step 1 + 2 + 3 → Step 4
- **Group B** (7 天): Step 7（Native Module，最重）
- **Group C** (1.5 天): Step 5 + 6（依赖 Group A）
- **Group D** (0.5 天): Step 8
- **Group E** (2 天): Step 9 + 10

**总计：~12-14 天（A+B 并行）**

---

## 验收矩阵

| # | 标准 | 关键依赖 |
|---|------|----------|
| 1 | 语音记事 → 确认 | Step 1 (PG) + 7f (设备端 STT) |
| 2 | "记住这个放这了" → 截帧+证据 | Step 2 + 3 + 4 + 5 |
| 3 | "钥匙放哪" → 位置+证据截图 | Step 1 + 6 |
| 4 | 日历提醒推送 | Step 8 |
| 5 | 不编造 | LLM prompt (已有) |
| 6 | 全程免手操作 | Step 7 (KWS + Speaker ID) |
| 7 | iOS + Android | Step 7 (双平台 Native Module) |
