# LOOI Phase 1 — 记忆闭环 MVP 进度

## Step 1: 项目脚手架 (Expo SDK 56 + 依赖安装)
- [x] 创建 Expo 项目 (SDK 56, TypeScript)
- [x] 配置 Expo Router (tabs layout)
- [x] 安装核心依赖 (zustand, supabase-js, expo-camera, expo-calendar)
- [x] 配置 tsconfig + 路径别名
- [x] 初始化 server/ 子项目 (Fastify + TypeScript)
- [x] 验证 App 和 Server 均可启动

## Step 2: Observation 核心层
- [x] 实现 src/core/observation.ts (类型定义)
- [x] 实现 src/core/perceiver.ts (Perceiver 接口)
- [x] 实现 Perceiver 调度器 (管理多 perceiver 生命周期)

## Step 3: 本地服务器搭建
- [x] Fastify 入口 + 路由结构
- [x] POST /api/vision/describe (图片/视频 → LLM Vision API)
- [x] WebSocket /ws/frames (实时帧流)
- [x] POST /api/llm/classify-intent + /generate-response
- [x] POST /api/stt/transcribe (Whisper 转写代理)
- [x] 验证: LLM API 正常响应 (intent + response)

## Step 4: Mem0 + Supabase 记忆层
- [x] Supabase 数据库 migration SQL 准备完成
- [x] 配置 Mem0 OSS + Supabase pgvector (lazy init)
- [x] 实现 memory routes (add/search/getAll)
- [x] 实现 memory/metadata.ts (分类标签)
- [ ] ⚠️ 需要手动执行 SQL migration (见 docs/supabase-setup.md)

## Step 5: LLM 层 (意图分类 + 回复生成)
- [x] 配置 LLM client (OpenAI-compatible proxy, gpt-4o)
- [x] 实现 intent-classifier (rule-based + LLM fallback)
- [x] 实现 response-generator (基于 facts 生成回复)
- [x] 验证: store/search/chat 意图均正确分类

## Step 6: 语音层
- [x] 降级方案: 按钮触发代替 KWS 唤醒词
- [x] 降级方案: 自动通过代替声纹验证
- [x] STT 服务 (expo-av 录音 + 服务器 Whisper API)
- [x] MiniMax TTS 集成 (流式合成 + 播放)
- [x] voice-perceiver.ts 完整流程

## Step 7: 摄像头层
- [x] camera-perceiver.ts (帧 buffer + 服务器上传)
- [x] mode-switcher.ts (电池状态监听)
- [x] light-detector.ts (帧差法运动检测)
- [x] voice+camera 联合触发 (指示词检测: hasVisualReference)

## Step 8: UI
- [x] 对话主界面 (VoiceButton + ChatBubble + 状态指示)
- [x] 记忆列表页 (MemoryCard + 分类筛选)
- [x] 提醒卡片 (ReminderCard)
- [x] 设置页 (服务器连接 + 功能开关)

## Step 9: 日历提醒
- [x] calendar-perceiver.ts (expo-calendar 轮询)
- [x] reminder-scheduler.ts (事件处理 + TTS)
- [x] notification.ts (本地推送)

## Step 10: 集成测试 + 验收
- [x] Server 编译通过 (tsc --noEmit)
- [x] App Web 编译通过 (expo export)
- [x] LLM 端到端验证通过
- [ ] ⚠️ Mem0 memory 需要 DB migration 后测试
- [ ] iOS/Android 真机测试 (需 Expo Go 或 Dev Build)

---

## 待办项 (需人工操作)

1. 在 Supabase SQL Editor 执行 `supabase/migrations/001_init.sql` 中的 SQL
2. 在 Supabase 创建 Storage bucket `evidence` (Public)
3. 在真机上测试 expo-camera 和 expo-av 权限
