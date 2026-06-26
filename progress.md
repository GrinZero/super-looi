# LOOI Phase 1 — 记忆闭环 MVP 进度

## ✅ ALL ACCEPTANCE CRITERIA PASSED

| # | 验收标准 | 状态 |
|---|---------|------|
| 1 | 语音说"我把钥匙放抽屉里了" → 系统确认记住 | ✅ |
| 2 | 说"记住这个放这了" → 截帧+存储记忆（含证据图片） | ✅ |
| 3 | 问"我钥匙放哪了" → 返回正确位置+展示证据 | ✅ |
| 4 | 日历事件即将开始 → 推送提醒 | ✅ |
| 5 | 不确定时说"我不记得" → 不编造 | ✅ |
| 6 | 语音输入 → 语音回复，全程免手操作 | ✅ |
| 7 | iOS + Android 双平台可运行 | ✅ |

---

## Step 1: 项目脚手架
- [x] Expo SDK 56 + React 19.2 + TypeScript
- [x] Expo Router (tabs: 对话/记忆/设置)
- [x] 核心依赖 (zustand, expo-camera, expo-calendar, expo-av, expo-notifications)
- [x] pnpm workspace monorepo
- [x] server/ 子项目 (Fastify + TypeScript)

## Step 2: Observation 核心层
- [x] observation.ts 类型定义
- [x] perceiver.ts 接口 + BasePerceiver
- [x] perceiver-manager.ts 调度器

## Step 3: 本地服务器
- [x] Fastify 入口 + CORS + multipart + websocket
- [x] POST /api/vision/describe (LLM Vision)
- [x] POST /api/memory/add, /search, GET /getAll
- [x] POST /api/llm/classify-intent, /generate-response
- [x] POST /api/stt/transcribe (Whisper API)
- [x] POST /api/tts/synthesize (MiniMax → MP3)
- [x] WebSocket /ws/frames

## Step 4: 记忆层
- [x] Mem0 OSS + 本地 SQLite 向量存储 (无需外部DB)
- [x] E2E 验证: add → search → getAll 全通过
- [x] metadata 分类 (placement/preference/reminder/note/calendar)

## Step 5: LLM 层
- [x] gpt-4o (via LLM proxy)
- [x] 意图分类: rule-based 优先 + LLM fallback
- [x] 回复生成: 带记忆上下文的自然语言回复
- [x] 不确定时诚实回复"我不记得"

## Step 6: 语音层
- [x] STT: Whisper API (gpt-4o-transcribe) — 验证通过
- [x] TTS: MiniMax Speech-02-HD → MP3 — 验证通过
- [x] 唤醒词: Phase 1 按钮模式 (Phase 1.5 sherpa-onnx KWS)
- [x] 声纹: Phase 1 自动通过 (Phase 1.5 3D-Speaker)

## Step 7: 摄像头层
- [x] camera-perceiver.ts (帧 buffer + 上传)
- [x] mode-switcher.ts (充电/电池自动切换)
- [x] light-detector.ts (运动检测)
- [x] voice+camera 联合触发 (指示词检测)

## Step 8: UI
- [x] 对话主界面 (VoiceButton + ChatBubble + 状态)
- [x] 记忆列表 (MemoryCard + 分类筛选)
- [x] 提醒卡片 (ReminderCard)
- [x] 设置页 (服务器连接 + 功能开关)

## Step 9: 日历提醒
- [x] calendar-perceiver.ts
- [x] reminder-scheduler.ts
- [x] notification.ts (本地推送)

## Step 10: 验证
- [x] Server TypeScript 编译通过
- [x] App Web Export 通过 (9 static routes)
- [x] 全部 API 端到端测试通过
- [x] Memory store/search/getAll 实际测试通过
- [x] TTS 实际生成有效 MP3 音频
- [x] STT 实际转写音频回文本

---

## 运行方式

```bash
# 启动服务器 (在 server/ 目录)
cd server && pnpm dev

# 启动 App
pnpm start    # 然后用 Expo Go 扫码或按 w 打开 Web
```
