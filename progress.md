# LOOI Phase 1 — 降级补齐进度

## 当前状态：实施中（消灭所有降级项）

### 验收标准

| # | 标准 | 实际状态 | 证据 / 剩余项 |
|---|------|----------|---------------|
| 1 | 语音记事 → 确认 | ✅ | Docker PG + pgvector 已实跑；memory add/search/getAll 通过 |
| 2 | "记住这个放这了" → 截帧+证据 | ⏳ | 服务端真实 E2E 已通过：MiniCPM-V 描述 + evidence URL + memory 写入；还需 App 设备端手动验证 |
| 3 | "钥匙放哪" → 位置+证据截图 | ⏳ | 真实检索已返回视觉记忆和 evidenceUri；记忆列表/对话页真实图片加载还需设备端验证 |
| 4 | 日历提醒推送 | ⏳ | bootstrapApp 已接 CalendarPerceiver → ReminderScheduler；还需设备权限和通知实测 |
| 5 | 不确定时说"我不记得" | ✅ | LLM search 无 facts prompt 明确禁止编造；根/服务端 TypeScript 通过 |
| 6 | 全程免手操作(唤醒词) | ⏳ | JS 已接 native KWS/Speaker API 且不再自动通过；还需原生实现和验证音频采样 |
| 7 | iOS + Android 双平台 | ⏳ | Expo module 已接入 workspace；还需 native build + 设备实测 |

---

## Step 1: Docker — PostgreSQL + pgvector
- [x] 创建 `docker-compose.yml`
- [x] 创建 `server/migrations/001_init.sql`
- [x] `server/src/config.ts` 加入 `database.url`
- [x] `server/src/routes/memory.ts` 改为 pgvector provider
- [x] `.env` 确认 `DATABASE_URL`
- [x] `docker compose up -d` 后验证 add/search/getAll

## Step 2: 服务器 — 证据图片存储
- [x] `server/data/evidence/` 通过 `server/data/` gitignore 排除
- [x] 创建 `server/src/routes/evidence.ts`
- [x] 注册 `/api/evidence`
- [x] 上传图片后验证 URL 可打开

## Step 3: 宿主机 — MiniCPM-V 本地推理
- [x] 创建 `server/scripts/start-vision.sh`
- [x] 创建 `server/scripts/download-vision-model.sh`
- [x] `server/src/routes/vision.ts` 改为调用 local llama.cpp server
- [x] 创建 `server/src/vision/scene-analyzer.ts`
- [x] 编译/安装 llama.cpp
- [x] 下载 MiniCPM-V 2.6 GGUF + mmproj
- [x] 实跑 `/api/vision/describe`

## Step 4: 服务器 — Voice + Camera 联合路由
- [x] 创建 `server/src/routes/observe.ts`
- [x] 注册 `/api/observe/voice-visual`
- [x] 流程包含 vision 描述、证据图保存、memory.add、确认回复
- [x] transcript + image 端到端实跑
- [x] `memory.add(..., { infer: false })` 固定保存视觉观察，避免 Mem0 推理后丢弃非事实文本

## Step 5: APP 端 — Voice + Camera 联动
- [x] `src/server-api/client.ts` 新增 `observeService.voiceVisual()`
- [x] `VoicePerceiver.finishListening()` 对视觉指示词 + 相机帧走联合端点
- [x] 创建 `src/camera/uploader.ts`
- [x] Camera UI 持续喂帧给 `cameraPerceiver.addFrame()`
- [ ] "记住这个放这了" 设备端手动验证

## Step 6: APP 端 — UI 展示证据图片
- [x] `ChatMessage` 支持 `evidenceUri`
- [x] `MemoryCard` 有 evidenceUri 时展示图片缩略图
- [x] `ChatBubble` assistant 消息有 evidenceUri 时展示图片
- [ ] 记忆列表和对话页真实图片加载验证

## Step 7: Native Module — sherpa-onnx KWS + Speaker ID + STT
- [x] 删除未实现的 `expo-sherpa-kws` scaffold，避免旧降级模块被误接回业务链路
- [x] `@siteed/sherpa-onnx.rn` 接入 Expo config plugin，确保 native autolinking 可发现
- [x] TS adapter 暴露 ASR/KWS/Speaker ID 方法
- [ ] iOS sherpa-onnx KWS + Speaker ID 设备构建验证
- [ ] Android sherpa-onnx KWS + Speaker ID 设备构建验证
- [x] 添加 KWS/Speaker/SenseVoice 模型下载脚本和未提交资产目录
- [ ] 执行模型下载并确认设备运行时路径
- [x] 调研 RN sherpa 候选包并记录接入风险到 `docs/phase1-native-sherpa-options.md`
- [x] 引入 `@siteed/sherpa-onnx.rn` 并创建 `src/voice/sherpa-adapter.ts` 统一 ASR/KWS/Speaker 调用
- [x] `src/voice/wakeword.ts` 接 `@siteed/sherpa-onnx.rn` KWS adapter，支持由音频采集层喂 PCM 样本
- [x] `src/voice/speaker-id.ts` 接 `@siteed/sherpa-onnx.rn` SpeakerId，支持样本/文件 embedding 注册与验证
- [x] VoicePerceiver 使用当前命令录音文件做 owner 声纹验证，通过后才转写和处理命令
- [x] 设置页提供本次会话 owner 声纹录入入口，录音文件写入 SpeakerId manager
- [x] 声纹注册 embedding 分块写入 SecureStore，启动/刷新 enrollment 时自动恢复到 SpeakerId manager
- [ ] 声纹注册跨 App 重启设备验证
- [ ] 常驻 KWS 音频采集 feeder：采集麦克风 PCM 并调用 `wakewordService.acceptSamples()`
- [x] `src/voice/stt.ts` 接设备端 SenseVoice ASR adapter，移除服务器 STT HTTP 调用
- [x] `pnpm exec expo prebuild --clean --no-install` 生成 iOS/Android 原生工程通过
- [x] `cd ios && pod install` 通过，已 autolink/install `sherpa-onnx-rn (1.3.1)` 并生成 `SherpaOnnxSpec`
- [ ] Android `:app:assembleDebug` 被本机 JDK/Gradle Foojay `IBM_SEMERU` toolchain error 阻塞，未进入 native 编译
- [ ] iOS simulator `xcodebuild` 被本机 Xcode `IDESimulatorFoundation`/`DVTDownloads.framework` 缺失阻塞，未进入 native 编译

## Step 8: CalendarPerceiver → ReminderScheduler 接线
- [x] 创建 `src/core/app-bootstrap.ts`
- [x] `app/_layout.tsx` 调用 `bootstrapApp()`
- [x] calendar observation 接到 `reminderScheduler.processCalendarObservation()`
- [ ] 设备日历事件 + 本地通知 + TTS 实测

## Step 9: 测试
- [x] `server/tests/memory.test.ts`
- [x] `server/tests/llm.test.ts`
- [x] `server/tests/vision.test.ts`
- [x] `server/tests/evidence.test.ts`
- [x] `server/tests/observe.test.ts`
- [x] `pnpm exec tsc --noEmit`
- [x] `cd server && pnpm build`
- [x] `cd server && pnpm test`
- [ ] APP 手动冒烟测试：纯语音、视觉记事、检索+证据、日历提醒、KWS+声纹、iOS+Android

## Step 10: 清理 + 验收
- [x] 删除 `@supabase/supabase-js` 依赖
- [x] 删除 `supabase/` 目录（如存在）
- [ ] 删除 `server/src/routes/stt.ts`（等设备端 STT 完成后）
- [x] 更新 `.env.example`
- [x] 更新 README（Docker + 宿主机部署说明）
- [ ] 7 条验收标准逐条确认
- [ ] commit + tag `phase1-complete`

---

## 运行方式

```bash
# 1. 启动 PostgreSQL (Docker)
docker compose up -d

# 2. 启动 llama.cpp vision server (宿主机 Metal)
bash server/scripts/start-vision.sh

# 3. 启动 Node server
cd server && pnpm dev

# 4. 启动 App
pnpm start
```
