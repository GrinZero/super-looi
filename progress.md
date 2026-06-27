# LOOI Phase 1 — 降级补齐进度

## 当前状态：实施中（消灭所有降级项）

### 验收标准

| # | 标准 | 实际状态 | 证据 / 剩余项 |
|---|------|----------|---------------|
| 1 | 语音记事 → 确认 | ✅ | Docker PG + pgvector 已实跑；memory add/search/getAll 通过 |
| 2 | "记住这个放这了" → 截帧+证据 | ⏳ | 服务端真实 E2E 已通过：MiniCPM-V 描述 + evidence URL + memory 写入；`demo.jpg` 可用图片已证明 observe 写入、证据图保存和明确口述位置纠偏；Android Settings 视觉诊断已证明 App 调 observe、返回 evidenceUri 并落聊天证据图，但 emulator 相机帧为纯色不可用，仍需真实设备 App 语音路径 + 可用相机帧验证 |
| 3 | "钥匙放哪" → 位置+证据截图 | ⏳ | `衣服放哪了` 检索已返回 `placementFact=衣服在桌子下` 和 evidenceUri，服务端回复确定性使用 top fact；对话页和记忆列表 evidence 图片均已在 Android 通过 Glide 加载验证；仍需实际语音检索路径验证 |
| 4 | 日历提醒推送 | ✅ | Android emulator 已创建真实系统日历事件，经 CalendarPerceiver 扫描 `emitted=1`，触发 ReminderScheduler、本地通知和 TTS；通知栏显示 `LOOI 提醒` |
| 5 | 不确定时说"我不记得" | ✅ | LLM search 无 facts prompt 明确禁止编造；根/服务端 TypeScript 通过 |
| 6 | 全程免手操作(唤醒词) | ⏳ | Android emulator 已验证 KWS native 初始化、模型绝对路径和 audio feeder 持续喂样本；还需真实唤醒词、Speaker/STT 行为验证 |
| 7 | iOS + Android 双平台 | ⏳ | Android `:app:assembleDebug` 已通过；iOS native build 仍被本机 Xcode 缺失组件阻塞；双平台设备实测未完成 |

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
  - [x] 端口修复后复测 `/api/observe/voice-visual`：真实截图返回 response、MiniCPM-V description 和 evidence URL

## Step 5: APP 端 — Voice + Camera 联动
- [x] `src/server-api/client.ts` 新增 `observeService.voiceVisual()`
- [x] `VoicePerceiver.finishListening()` 对视觉指示词 + 相机帧走联合端点
- [x] 创建 `src/camera/uploader.ts`
- [x] Camera UI 持续喂帧给 `cameraPerceiver.addFrame()`
  - [x] Android emulator 设备实测：启动日志显示后置相机打开并进入 `STREAMING`，JS 日志出现 `[CameraPerceiver] First camera frame buffered`
  - [x] Android Settings 视觉诊断入口复用 `cameraPerceiver.getLatestFrame()` 调用 `observeService.voiceVisual()`，并把 assistant `evidenceUri` 写入对话消息
  - [x] Android emulator 视觉诊断已跑通 App → server observe → evidence URL → ChatBubble 图片加载；由于 hidden camera 返回纯色/不可辨认帧，服务端返回 `remembered=false` 且不写入 memory
  - [x] `demo.jpg` 可用图片实跑 `/api/observe/voice-visual`：`记住衣服现在放在桌子下` 返回 `remembered=true`、设备可访问 evidence URL，并写入 `placementFact=衣服在桌子下`
  - [x] observe 服务端优先使用明确口述位置纠偏：视觉模型把图片误判为狗窝/毛绒玩具时，memory 和确认回复仍以用户明确的“衣服在桌子下”为事实
- [ ] "记住这个放这了" 设备端手动验证

## Step 6: APP 端 — UI 展示证据图片
- [x] `ChatMessage` 支持 `evidenceUri`
- [x] `MemoryCard` 有 evidenceUri 时展示图片缩略图
- [x] `ChatBubble` assistant 消息有 evidenceUri 时展示图片
- [x] 对话页真实图片加载验证：Android emulator 视觉诊断返回 evidence URL 后，ChatBubble 触发 Glide 远程图片加载并截图确认图片渲染
- [x] 记忆列表真实图片加载验证：`demo.jpg` evidence URL 使用设备可访问 host 写入后，Android `MemoryCard` 触发 Glide 远程加载并截图确认图片渲染
- [x] 记忆列表按 `createdAt/timestamp` 最新优先派生排序，避免最新视觉证据被旧测试记录埋在列表后面

## Step 7: Native Module — sherpa-onnx KWS + Speaker ID + STT
- [x] 删除未实现的 `expo-sherpa-kws` scaffold，避免旧降级模块被误接回业务链路
- [x] `@siteed/sherpa-onnx.rn` 接入 Expo config plugin，确保 native autolinking 可发现
- [x] TS adapter 暴露 ASR/KWS/Speaker ID 方法
- [ ] iOS sherpa-onnx KWS + Speaker ID 设备构建验证
- [x] Android sherpa-onnx KWS + Speaker ID native debug 构建验证：`JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ./gradlew :app:assembleDebug` 通过
- [x] 添加 KWS/Speaker/SenseVoice 模型下载脚本和未提交资产目录
- [x] 设备端模型路径自检：ASR/KWS/Speaker 初始化前检查 `documentDirectory/sherpa-onnx/...` 必需文件，设置页显示缺失清单
- [x] `src/voice/stt.ts` / `src/voice/tts.ts` 从 `expo-av` 迁移到 `expo-audio`，Android 启动不再触发 `LazyKType` 崩溃
- [x] 执行模型下载并拷贝到设备 `documentDirectory/sherpa-onnx/`，确认设置页模型检查全绿
  - [x] 检查 Hugging Face CLI / `sherpa-onnx-cli` 可用性：本地 `.venv-sherpa-tools` 提供 `hf` 和 `sherpa-onnx-cli`
  - [x] 下载 SenseVoice、KWS、Speaker ID 模型到 ignored `app-models/sherpa-onnx/`：模型目录约 272MB
  - [x] 生成 KWS `keywords.txt`：`嘿魔戈 @HEY_MOGE`
  - [x] 校验本地模型文件非空：ASR `model.int8.onnx`/`tokens.txt`、KWS encoder/decoder/joiner/tokens/keywords、Speaker `model.onnx`
  - [x] 拷贝到 Android emulator app 私有目录：`run-as com.anonymous.superlooiapp du -sh files/sherpa-onnx` 为 271M
  - [x] Android KWS native 初始化验证：日志显示 `Model dir: /data/user/0/com.anonymous.superlooiapp/files/sherpa-onnx/kws/looi/`，encoder/decoder/joiner/tokens/keywords 均 `exists: true`
  - [x] 设置页模型检查全绿 UI 验证：Android emulator 截图确认 SenseVoice / KWS / Speaker 均显示“已就绪”
- [x] 调研 RN sherpa 候选包并记录接入风险到 `docs/phase1-native-sherpa-options.md`
- [x] 引入 `@siteed/sherpa-onnx.rn` 并创建 `src/voice/sherpa-adapter.ts` 统一 ASR/KWS/Speaker 调用
- [x] `src/voice/wakeword.ts` 接 `@siteed/sherpa-onnx.rn` KWS adapter，支持由音频采集层喂 PCM 样本
- [x] 设置页唤醒词开关从 Phase 1.5 禁用态改为 Phase 1 正式可切换，并加入 root anti-regression 门禁防止回退
- [x] `src/voice/speaker-id.ts` 接 `@siteed/sherpa-onnx.rn` SpeakerId，支持样本/文件 embedding 注册与验证
- [x] VoicePerceiver 使用当前命令录音文件做 owner 声纹验证，通过后才转写和处理命令
- [x] 设置页提供本次会话 owner 声纹录入入口，录音文件写入 SpeakerId manager
- [x] 设置页提供 Android 设备端语音诊断入口，复用真实 `processFile`/`verifySpeaker`/`recognizeFromFile` 路径输出声纹 + STT 结果
- [x] 声纹注册 embedding 分块写入 SecureStore，启动/刷新 enrollment 时自动恢复到 SpeakerId manager
- [x] Android emulator 声纹文件 smoke：录音 m4a 经 SpeakerId `processFile` 提取 512 维 embedding，两次同文件 verify 返回 `speaker=pass`
- [x] 声纹注册跨 App 重启设备验证：force-stop/restart 后日志显示 `[SpeakerId] Restored owner embedding from SecureStore: dims=512` 和 `enrolled=true`
- [x] 设置页新增“验证已注册声纹”诊断，不重新 enroll，仅 `refreshEnrollmentStatus()` 后用新录音 `verifyFile()`；Android emulator 验证结果 `enrolled=yes | speaker=pass`
- [x] 常驻 KWS 音频采集 feeder：使用 `@siteed/audio-studio` 采集 16k mono float PCM 并调用 `wakewordService.acceptSamples()`
- [x] `@siteed/audio-studio` Expo config plugin 已用最小权限接入，提供麦克风权限并关闭后台录音/通知/蓝牙/电话权限
- [x] KWS feeder 已处理运行中偏好切换、float PCM payload fallback、队列上限，避免静默断流和无限堆积
- [x] STT 录音/声纹验证/ASR 期间统一暂停 KWS feeder，并在完整处理结束后恢复；root anti-regression 锁定互斥恢复路径
- [ ] 常驻 KWS 音频采集 feeder 设备验证：Android emulator 已确认持续 `acceptWaveform` 和 STT 互斥恢复；还需真实唤醒词命中后恢复监听
- [x] `src/voice/stt.ts` 接设备端 SenseVoice ASR adapter，移除服务器 STT HTTP 调用
- [x] Android emulator 设备端 STT smoke：SenseVoice ASR 初始化完成，`recognizeFromFile()` 对录音 m4a 返回文本 `没。`
- [x] `expo-file-system` 直接依赖已声明，用于设备端模型文件自检
- [x] `pnpm exec expo prebuild --clean --no-install` 生成 iOS/Android 原生工程通过
- [x] `cd ios && pod install` 通过，已 autolink/install `sherpa-onnx-rn (1.3.1)` 并生成 `SherpaOnnxSpec`
- [x] Android `:app:assembleDebug` 通过；本机已安装 Homebrew `openjdk@17`，并自动安装 Android SDK/NDK/CMake 依赖
- [ ] iOS simulator `xcodebuild` 被本机 Xcode `IDESimulatorFoundation`/`DVTDownloads.framework` 缺失阻塞，未进入 native 编译

## Step 8: CalendarPerceiver → ReminderScheduler 接线
- [x] 创建 `src/core/app-bootstrap.ts`
- [x] `app/_layout.tsx` 调用 `bootstrapApp()`
- [x] calendar observation 接到 `reminderScheduler.processCalendarObservation()`
- [x] Expo 56 下 CalendarPerceiver 改用 `expo-calendar/legacy`，并在无本地日历源时跳过 `getEventsAsync([])`，Android 启动不再报 deprecated legacy API / empty calendarIds 错误
- [x] `ReminderScheduler.processCalendarObservation()` 返回 `ReminderResult`，包含 response、notificationId、TTS 是否完成，便于设备端诊断和防回退
- [x] 设置页新增日历提醒诊断，直接触发 calendar observation 并复用正式 ReminderScheduler、notification、TTS 链路
- [x] Android emulator 日历提醒诊断：系统通知栏显示 `LOOI 提醒`，UI 返回 `notification=a345d875-... | spoke=yes | response=...`
- [x] TTS 播放完成等待增加超时释放，避免提醒链路因播放器状态不回调而永久卡在 speaking/running
- [x] `CalendarPerceiver.checkNow()` 支持设备端主动扫描并返回 emit 数，便于真实系统日历事件诊断
- [x] 设置页真实日历事件诊断创建本地 calendar event，再由 CalendarPerceiver 读取系统日历并 emit observation，不再只直接注入 observation
- [x] Android emulator 真实系统日历事件实测：`event=2 | emitted=1 | observed=日历事件：「Phase 1 真实日历提醒诊断」将在 1 分钟后开始，地点：本机测试`
- [x] Android emulator 真实日历事件触发后通知栏显示 `LOOI 提醒`，日志显示 `[ReminderScheduler] Calendar reminder sent ... spoke=true`
- [x] 修复 TTS hex 转 base64 大音频栈溢出：分块 `String.fromCharCode`，真实日历事件提醒不再出现 `Maximum call stack size exceeded`

## Step 9: 测试
- [x] `server/tests/memory.test.ts`
  - [x] 单测锁定 Mem0 查询过滤条件始终包含 `user_id: owner-1`，并保留 metadata `category` 过滤，防止跨用户/跨类别检索回退
- [x] `server/tests/llm.test.ts`
  - [x] search 回复改为确定性使用 top retrieved fact，优先 `metadata.placementFact`，无 facts 时固定返回不记得，防止 LLM 编造位置
- [x] `server/tests/vision.test.ts`
- [x] `server/tests/evidence.test.ts`
- [x] `server/tests/observe.test.ts`
  - [x] 覆盖明确口述位置纠偏：`记住衣服现在放在桌子下` 即使视觉描述偏成狗窝/毛绒玩具，也写入 `位置事实：衣服在桌子下`
- [x] `server/tests/anti-regression.test.ts`：确认服务器不再暴露 `/api/stt/transcribe` 回退转写入口
- [x] `pnpm test`：root anti-regression 门禁，锁定设备端 STT、声纹先验、视觉证据、证据图片 UI、memory owner/category 过滤和 `infer:false`，防止已消灭降级项被接回
- [x] `pnpm exec tsc --noEmit`
- [x] `npx -y react-doctor@latest . --verbose --scope changed`：100/100，无问题
- [x] `pnpm exec expo config --type public`
- [x] `cd server && pnpm build`
- [x] `cd server && pnpm test`
  - [x] vision server 默认端口改为 `8082`，避免 Expo/Metro 占用 `8081` 时视觉 E2E 打到错误服务；真实截图经 `/api/vision/describe` 返回中文描述
  - [x] observe 路由拒绝不可用视觉描述写入 memory：纯色/无法识别画面仍保存 evidence，但返回 `remembered=false`
- [x] `pnpm exec expo prebuild --clean --no-install`：新增 `expo-file-system` 直接依赖、`expo-audio` 迁移后重新生成原生工程通过
- [x] `cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ./gradlew :app:assembleDebug`
- [x] Android emulator 启动日志验证：JS bundle 正常加载，Sherpa JNI 加载，KWS 初始化完成且持续接收音频样本
- [x] Android emulator 设置页语音诊断：`[Settings] Voice smoke succeeded ... speaker=pass | stt=没。`，且日志显示 `[STT] Paused KWS feeder for recording` 后到识别完成前无 `acceptWaveform`，随后 `[STT] Resumed KWS feeder after recording`
- [x] Android emulator 设置页已注册声纹验证：重启 App 后恢复 SecureStore embedding，`[Settings] Speaker verify succeeded ... enrolled=yes | speaker=pass`，并确认 KWS feeder 暂停/恢复
- [x] Android emulator 设置页视觉诊断：`[Settings] Visual smoke succeeded ... remembered=no ... evidence=... description=...纯色...`，并确认 ChatBubble evidence 图片加载
- [x] Android emulator 设置页日历诊断：`[Settings] Calendar smoke succeeded: notification=... | spoke=yes | response=...`，并通过系统通知栏截图确认 `LOOI 提醒`
- [x] Android emulator 真实系统日历事件诊断：设置页创建系统日历事件，CalendarPerceiver 扫描 emit，正式 ReminderScheduler 发本地通知并 TTS，通知栏截图确认 `LOOI 提醒`
- [x] `demo.jpg` 服务端 E2E：observe 返回 `记住了，衣服在桌子下。`，search top memory 带 `placementFact=衣服在桌子下`，`/api/llm/generate-response` 返回 `我记得：衣服在桌子下`
- [x] Android emulator 记忆列表 evidence 图验证：`Glide Finished loading BitmapDrawable from REMOTE for http://192.168.3.71:8080/api/evidence/5c690078-...jpg`
- [x] `npx -y react-doctor@latest . --verbose --scope changed`：退出码 0；对 `selectedCategory` 给出 derived-state 警告，经代码检查属于用户选择 filter state，不是可从其它 state 推导的值，未改动
- [x] `npx -y react-doctor@latest . --verbose --scope changed`：退出码 0；对 `SettingsScreen` 给出大组件维护性警告，本次未做无关拆分
- [ ] APP 手动冒烟测试：纯语音、视觉记事、检索+证据、日历提醒、KWS+声纹、iOS+Android

## Step 10: 清理 + 验收
- [x] 删除 `@supabase/supabase-js` 依赖
- [x] 删除 `supabase/` 目录（如存在）
- [x] 删除 `server/src/routes/stt.ts`，服务器不再注册 Whisper-compatible STT 回退路由
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
