# 主屏幕语音对话进度

更新时间：2026-06-28 13:11:25 CST

## Mem0 Anthropic 兼容修复（temperature 400 + embedding 分离）

更新时间：2026-07-29 CST

- [x] 定位 mem0 `AnthropicLLM` 始终发送 `temperature`，Claude Sonnet 5 / Opus 5+ 会 400 拒绝。
- [x] `server/src/config.ts` 新增 `llm.memoryModel`（`MEM0_LLM_MODEL` 覆盖）和独立 `embedding.*` 配置块。
- [x] `server/src/routes/memory.ts` 新增 `DEFAULT_MEMORY_MODEL` 兜底表，anthropic 下 mem0 事实提取默认走 `claude-haiku-4-5-20251001`（仍接受 temperature）。
- [x] embedder 配置改为始终使用独立 `config.embedding.*`（provider/baseURL/apiKey/model），不再复用 `config.llm.*`，因为 Anthropic 无 embeddings 接口。
- [x] 修正默认模型 id 笔误：`claude-haiku-4-5` -> `claude-haiku-4-5-20251001`。
- [x] `pnpm-workspace.yaml` 补充 `allowBuilds`（`better-sqlite3`/`esbuild`/`protobufjs`/`@google/genai`/`@siteed/sherpa-onnx.rn`）并将 `trustPolicy` 改为 `'off'`，解除 pnpm 对这些包的构建脚本拦截。
- [x] 补充测试：`server/tests/memory.test.ts` 新增用例验证 anthropic 兜底模型、显式 `MEM0_LLM_MODEL` 覆盖、embedder 与 llm provider 相互独立。
- [x] 校验：`pnpm --dir server exec tsc --noEmit`、`pnpm --dir server test`（28/28 通过）、`pnpm test`（anti-regression 通过）、`pnpm install --frozen-lockfile`。
- [ ] 真实 `LLM_API_KEY`/`EMBEDDING_API_KEY` 尚未在 `.env` 中配置，无法做端到端 mem0 add/search 真实调用验收。

## TTS 长回复分段不中断修复

更新时间：2026-07-01 CST

- [x] 定位当前 `speakSentences()` 为“播放完一句再合成下一句”，播放完成回调或超时会阻塞后续分段合成。
- [x] 增加服务端 `/api/tts/stream`，以 MiniMax `stream: true` 请求 TTS，并向客户端输出 chunked `audio/mpeg`。
- [x] 服务端支持直接音频流透传，也支持从 SSE/NDJSON JSON 片段中提取 hex audio 后转 MP3 bytes。
- [x] 客户端 `ttsService.speak()` 优先播放 `/api/tts/stream` URL，使单句音频不再等待完整合成后才开始播放。
- [x] 保留旧整段 MiniMax 合成作为流式播放失败时的兜底。
- [x] 增加 anti-regression 检查，避免 TTS 主链路回退为纯整段合成。
- [x] 运行 pnpm 优先的聚焦验证：`pnpm exec tsc --noEmit`、`pnpm --dir server test`、`pnpm test`。

## Server-side LLM -> TTS 编排迁移

更新时间：2026-07-01 CST

- [x] 调研业界方案，确认目标应从客户端按句 TTS 转向服务端 `LLM stream -> TTS stream` 编排。
- [x] 审计当前 `.env`，确认现有 provider 只有 MiniMax HTTP TTS，未配置 ElevenLabs/Deepgram/Google 等增量文本 WebSocket TTS。
- [ ] 将 LLM SSE 协议扩展为 `token` + `tts` + `done`，由 server 负责切句和发出音频入口。
- [ ] 客户端移除本地句子切分/TTS 队列，改为消费 server 的 `tts` 事件播放。
- [ ] 保留 MiniMax HTTP streaming 作为 provider v1；后续接入真正 WebSocket TTS 时只替换 server provider。
- [ ] 运行 pnpm 优先验证。

## Device tools WebSocket 迁移

更新时间：2026-06-30 CST

- [x] 确认现有短轮询日志来自 `/api/device-tools/poll` 每 1.5 秒访问一次。
- [x] 服务端新增 device tools WebSocket 通道，移除 HTTP poll/result/registration 执行通道。
- [x] 客户端 device tools 改为 WebSocket-only，断线后自动重连。
- [x] 更新测试和文档，验证 robot move 调用仍能收到客户端执行结果。

## TTS 字幕同步修复

更新时间：2026-06-30 CST

- [x] 确认主链路仍走 SSE 流式 LLM：客户端消费 `/api/llm/generate-response-stream` token，服务端逐 token 写入 SSE。
- [x] 将 TTS 句子开始回调从“合成前”调整为“播放器开始播放后”。
- [x] TTS 开启时，首屏字幕改为跟随已开始播放的句子显示，不再跟随首 token 立即展示。
- [x] 非流式兜底和 conversation smoke 诊断链路同步采用播放开始后显示字幕。

## 首次引导与语音初始化 Plan

更新时间：2026-06-30 CST

- [x] 新增 `docs/onboarding-voice-setup-plan.md`，覆盖首进 onboarding、模型下载、声纹录入、权限/设备能力、首页修复入口、设置页重组。
- [x] 将声纹数据结构从裸 `embeddings: number[][]` 调整为 `templates: StoredSpeakerTemplate[]`，包含来源、时长、质量、prompt 等元数据。
- [x] 明确第一版只支持手动追加录入，不实现验证通过后的自动自适应更新。
- [x] 补充 score trace 策略，用于后续阈值审计和 non-owner 回归分析，不保存原始音频。
- [x] 补充可验收需求矩阵、阶段门禁和验收标准。
- [x] 同步更新 `docs/speaker-id-multi-enrollment.md`，使声纹专项方案与 onboarding plan 保持一致。

## 首次引导与声纹多样本实施

更新时间：2026-06-30 CST

- [x] 读取 `docs/onboarding-voice-setup-plan.md` 与 `docs/speaker-id-multi-enrollment.md`，确认验收范围。
- [x] 检查当前 worktree，确认已有改动集中在设备工具、设置页、首页、声纹与文档。
- [x] Phase 1：声纹服务 v2 数据结构与本地多模板验证。
  - [x] `StoredSpeakerEmbedding` 升级为 v2 `templates[] + centroid`。
  - [x] v1 MMKV / SecureStore payload 自动迁移为 v2。
  - [x] `enroll()` 支持多样本并写入模板 metadata。
  - [x] `appendEnrollmentSample()` 支持设置页手动追加。
  - [x] 验证改为 `max(centroidScore, bestTemplateScore)` 本地判定。
  - [x] 验证 score trace 只记录分数、模板 ID、阈值和来源。
  - [x] 验证通过后不自动写入模板或修改 centroid。
- [x] Phase 2：setup readiness 与 onboarding。
  - [x] 新增 setup storage，记录 onboarding completion 与可选能力 skip。
  - [x] 新增 setup readiness，冷启动聚合模型、声纹、权限、机器人状态。
  - [x] 新增 onboarding route，覆盖模型、声纹、权限、完成步骤。
  - [x] 模型步骤接入检查、下载进度、失败重试。
  - [x] 声纹步骤实现 3-5 段录音、质量反馈、重录和完成注册。
  - [x] 权限步骤支持麦克风必需，相机/日历/机器人可跳过。
- [x] Phase 3：首页与设置页验收面。
  - [x] 首页显示模型/声纹未就绪修复入口，并跳回对应 onboarding 步骤。
  - [x] 首页快捷入口改为清晰动作。
  - [x] 设置页重组为健康摘要、常用设置、高级诊断。
  - [x] 高级诊断默认折叠。
  - [x] 设置页支持追加录入并展示样本数。
- [ ] Phase 4：验证与验收。
  - [x] `pnpm exec tsc --noEmit`
  - [x] `pnpm test`
  - [x] `pnpm --dir server test`
  - [x] React Doctor 检查 React 变更；剩余 warning 为 SettingsScreen 体积和录音诊断时序误报。
  - [x] iOS build-only smoke：`pnpm exec expo run:ios --device generic --no-bundler --output ./output/onboarding-ios-build-smoke`，构建成功 0 error / 23 warning。
  - [x] 修复模型包解压后安装逻辑：不再依赖固定顶层目录，按文件名递归查找流式 ASR / KWS / 标点模型产物。
  - [x] 解压阶段补充模拟进度回调，避免下载完成后长时间无进度反馈。
  - [x] 声纹录入卡片补充推荐朗读短句，覆盖正常、轻声、快语速、日常和远场，中英混合但不声称官方固定文本。
  - [x] 定位 Android 首页约 3 秒闪烁为后台隐藏 `CameraView` + 周期 `takePictureAsync` 导致，移除首页自动相机 feeder 止血。
  - [ ] iOS 模拟器首进流程交互 smoke。
  - [ ] 逐项审计 R1-R12 和声纹专项验收标准。

## Streaming Paraformer + CT-Punc 实施

更新时间：2026-06-29 00:00:00 CST

- [x] 读取 `.claude/plans/streaming-paraformer.md` 和当前 voice/model 代码。
- [x] 确认当前主链路仍是 expo-audio 文件录音 + SenseVoice 离线转写。
- [x] 确认 `kwsAudioFeeder.subscribeSamples` 可复用 16kHz mono float samples。
- [x] 确认 `@siteed/sherpa-onnx.rn` JS 层已有 online ASR 与 punctuation API。
- [x] Step 0：补 `@siteed/sherpa-onnx.rn` iOS online paraformer patch。
  - [x] 使用 `pnpm patch` 创建补丁工作区。
  - [x] 在 iOS `SherpaOnnxASRHandler.swift` 增加 `case "paraformer"`。
  - [x] 修正 TS 类型文档注释并提交 pnpm patch。
- [x] Step 1：模型下载与就绪检查。
  - [x] 新增 streaming paraformer 与 CT-Punc 模型常量。
  - [x] 扩展模型 readiness 结果。
  - [x] 替换下载逻辑为 streaming ASR + punctuation。
  - [x] 更新设置页模型状态显示。
- [x] Step 2：新增 Streaming ASR 服务。
  - [x] 封装初始化、stream 创建、samples 接收、endpoint、reset、release。
- [x] Step 3：新增 punctuation 服务。
  - [x] 封装 CT-Punc 初始化、补标点、release。
- [x] Step 3.5：清理旧 SenseVoice。
  - [x] 删除 `app-models/sherpa-onnx/asr/sensevoice/` 旧目录内容。
  - [x] 从下载逻辑和手工下载脚本移除 SenseVoice。
- [x] Step 4：改造 `voice-perceiver`。
  - [x] 用 `kwsAudioFeeder` 采样替代主链路录音文件。
  - [x] 并行喂 VAD 与 streaming ASR。
  - [x] 实时更新 `currentTranscript`。
  - [x] 用 ASR endpoint + 等待窗口 finalize 回合。
  - [x] 改用 `speakerIdService.verifySamples(samplesBuffer)`。
- [x] Step 5：UI 与回归检查。
  - [x] 调整 overlay 文本行数。
  - [x] 更新 anti-regression 检查。
  - [x] 运行 `pnpm test` / TypeScript 相关检查。
  - [x] 运行 React Doctor；剩余 warning 为 settings 既有大组件和依赖顺序 await，不在本次改动中拆分。

- [x] 查看 `.claude/plans/home-voice-conversation.md` 和当前工作树。
- [x] 拆分执行责任：
  - [x] 服务端 Phase 2 + Phase 7 交给 worker `Erdos`。
  - [x] 客户端 UI、store、历史页 Phase 3 + Phase 5 + Phase 7 交给 worker `Noether`。
- [x] Phase 1：VAD 集成
  - [x] 增加 VAD 模型就绪检查和下载支持。
  - [x] 增加 sherpa-onnx VAD service 封装。
  - [x] 监听录音期间把实时 PCM 样本送入 VAD。
  - [x] 由 VAD 语音结束和安全超时触发 `finishListening()`。
  - [x] 按已安装的 `@siteed/sherpa-onnx.rn` 包确认 VAD API 形态，并使用公开 `VAD` service。
  - [x] 在设置页增加 VAD 模型状态和诊断入口。
  - [x] 把内置 WAV VAD smoke 抽成共享的 `src/voice/vad-diagnostic.ts`。
  - [x] 增加开机可选 VAD smoke：`EXPO_PUBLIC_LOOI_RUN_VAD_SMOKE_ON_BOOT=1`。
  - [x] 修正 VAD 模型下载 URL，改为已发布的 Sherpa `asr-models/silero_vad.onnx` 资源。
- [x] Phase 2：服务端迁移到 pi-ai SSE LLM
  - [x] 查看当前服务端 LLM 路由和 pi-ai 参考实现。
  - [x] 添加 `@earendil-works/pi-ai`，移除直接 `openai` 依赖。
  - [x] 用 `@earendil-works/pi-ai` 替换 OpenAI SDK 调用。
  - [x] 新增 `/api/llm/generate-response-stream`。
  - [x] 保持非流式 LLM 路由兼容。
  - [x] 从 intent classification 中移除 LLM 预检；模糊输入按规则返回 `chat`，降低延迟。
  - [x] 缩短 chat streaming prompt 和上下文窗口，提高首 token 速度。
  - [x] 在等待模型流之前先发一个短的 streaming prelude token，让字幕/TTS 启动更稳定。
- [x] Phase 3：主屏幕字幕覆层
  - [x] 增加对话字幕覆层 UI。
  - [x] 集成到主屏幕。
  - [x] 暴露 streaming text 和 current transcript 状态。
- [x] Phase 4：按句流式 TTS
  - [x] 增加句子切分和队列播放支持。
  - [x] 把 LLM streaming token 接到 TTS 句子播放。
- [x] Phase 5：图片浮层
  - [x] 增加图片 modal。
  - [x] 从 store/SSE done event 显示 evidence image。
- [x] Phase 6：唤醒词到对话的编排
  - [x] 录音前 touch/续接 session。
  - [x] 持久化用户和 assistant 消息。
  - [x] 流式响应接入字幕，并保留非流式降级。
  - [x] 在错误或 SSE 中断时恢复 UI 状态。
- [x] Phase 7：服务端 session 和对话历史页
  - [x] 增加服务端 session 存储和路由。
  - [x] 在 LLM 上下文中使用 session history。
  - [x] 把关闭 session 的摘要写入 Mem0 长期记忆。
  - [x] 把 conversation tab 改成历史查看器。
  - [x] 增加客户端 session API 方法和类型。
- [ ] 验证
  - [x] 使用 pnpm 跑 app TypeScript/test 检查。
  - [x] 使用 pnpm 跑服务端 build/test。
  - [x] 对变更的 React 文件跑 React Doctor。
  - [x] VAD 诊断变更后重跑 React Doctor；剩余警告是既有 SettingsScreen 体积和顺序 await 债务，不阻塞本功能。
  - [x] shared VAD diagnostic boot-smoke patch 后跑 TypeScript 和 React Doctor。
  - [x] 运行服务端 `/health`、`/api/session/touch`、`/api/session/list`、`/api/session/:id/messages`、`/api/llm/generate-response-stream` smoke。
  - [x] HTTP smoke 测得 SSE 首 token 约 1714ms，并确认 5 分钟内 touch 会复用同一 session。
  - [x] iOS 模拟器 Expo build-only smoke：`output/ios-build-smoke/superlooiapp.app`。
  - [x] VAD 诊断变更后重跑 iOS build-only smoke；构建 0 error、0 warning。
  - [x] 按所有验收标准做审计。
  - [x] 在 iOS 模拟器使用已下载模型运行开机 VAD smoke；日志显示 `speech=yes | segments=1 | first=0.07-0.84s`。
  - [x] 增加并运行开机 conversation smoke；证明内置 WAV ASR -> session -> SSE -> streaming subtitle state -> sentence TTS start。
  - [x] 确认 iOS 模拟器 smoke 中首个 SSE token 后 18-21ms 内启动 TTS。
  - [x] 稳定 iOS 模拟器 smoke 中 ASR 后首个 SSE token <= 2s；prelude-token run 测得 `firstTokenAfterAsrMs=204`。
  - [x] 再次确认 iOS 模拟器 smoke 中首个 SSE token 后 TTS <= 3s；prelude-token run 测得 `firstTtsAfterTokenMs=2272`。
  - [x] 禁用 Mem0 sqlite history store，同时保留 pgvector memory storage，避免 `better-sqlite3` ABI 失败。
  - [x] 运行 closed-session summary memory smoke；session 成功关闭并生成摘要，服务端日志无 `better-sqlite3` 或 background-task 错误。
  - [x] 增加可重复 conversation boot smoke：`EXPO_PUBLIC_LOOI_CONVERSATION_SMOKE_REPEAT`。
  - [x] 在 iOS 模拟器运行 3 次 conversation boot smoke；每次完成 ASR -> session -> SSE -> subtitle state -> TTS start，并持久化 assistant 消息。
  - [x] 增加可选 live voice acceptance trace：`EXPO_PUBLIC_LOOI_TRACE_LIVE_VOICE_ACCEPTANCE=1`，记录真实麦克风 wakeword/VAD/STT/SSE/TTS 证据。
  - [x] 增加可选开机 live voice acceptance runner：`EXPO_PUBLIC_LOOI_RUN_LIVE_VOICE_ACCEPTANCE_ON_BOOT=1`，无需手动点 UI 即可触发真实语音流水线。
  - [x] 尝试一次 iOS 模拟器 live voice run，使用 boot runner 和 macOS `say` 音频；录音/session 路径正常，但音量太低导致 VAD 未检测到语音，声纹验证失败。
  - [x] 增加可选开机 owner enrollment helper：`EXPO_PUBLIC_LOOI_ENROLL_OWNER_ON_BOOT=1`，用于移除 live acceptance 中的声纹不匹配变量。
  - [x] 尝试组合 enrollment + live runner；发现并修复 runner 时序竞争，使 live acceptance 等待开机 owner enrollment 完成后再触发。
  - [x] 重跑组合 enrollment + live runner；完整 session -> speaker pass -> STT -> SSE -> TTS -> assistant -> cleanup 路径完成，但因模拟器输入音量仍很低，VAD 使用 safety timeout，ASR 只听到标点。
  - [x] 提高 macOS 输出/输入音量后重跑 live runner，确认足够音量的模拟器音频可触发 `vad-speech`；该次仍错过 owner enrollment 音频，所以声纹失败，且 VAD 未在 safety timeout 前发出 `vad-end`。
  - [x] 把 Sherpa VAD 已完成的 `segments` 当成 speech-end 事件处理，避免真实 live 流水线在 VAD 已产出完成段后仍等待 safety timeout。
  - [x] 在 enrollment 和 live recording 都有足够音量的情况下重跑组合 runner；单条 trace 完成 `vad-speech` -> `vad-end` -> speaker pass -> meaningful STT -> SSE -> TTS -> assistant -> cleanup。
  - [x] 在 iOS 模拟器运行 3 次 live acceptance runner，验证重复录音/SSE/TTS cleanup；三条 trace 都回到 `voiceState="sleeping" isListening=false isProcessing=false`，其中两条到达 SSE/TTS/assistant，仍可见模拟器音频限制。
  - [x] 增加 `pnpm voice:accept-device` 真机验收脚本：启动 server，带 live acceptance tracing 跑 Expo，写入带时间戳日志，并在结束后停止 server。
  - [ ] 在真实 iOS 设备上运行长时间重复资源验收。

## Device tool / LOOI body integration

- [x] Review existing client/server API and tool architecture.
- [x] Add server-side device tool registry and invocation plumbing.
- [x] Add client-side device tool registration/execution scaffolding.
- [x] Add Looi robot SDK integration placeholders for movement/light tools.
- [x] Add tests/docs and run validation.
- [x] Commit changes and open PR.

## Local LOOI SDK package migration

- [x] Copy the old `packages/looi-sdk` SDK into this monorepo.
- [x] Add `packages/*` to the pnpm workspace and depend on `@sourcebug/looi-sdk` via `workspace:*`.
- [x] Update robot tools to use the local SDK classes/types instead of a dynamic optional import.
- [x] Document that native BLE transport binding is the remaining device-side step.
- [x] Run app/server/package validation.
- [x] Commit changes and open PR.

## LOOI robot real-run integration

- [x] Audit current SDK/device-tool wiring and confirm native BLE transport is still missing.
- [x] Add a React Native BLE transport and bind it through `configureLooiRobotTransport()`.
- [x] Add Settings robot scan/retry/select flow before first connection.
- [x] Start saved robot reconnect/handshake automatically from the home screen after user selection.
- [x] Add a deterministic server route that invokes registered `looi_move` device tools.
- [x] Validate app/server checks and document remaining real-device acceptance steps.
  - [x] `pnpm exec tsc --noEmit`
  - [x] `pnpm --dir server test`
  - [x] `pnpm test`
  - [x] React Doctor changed-file scan: 100/100, no issues.
  - [ ] Real LOOI robot hardware acceptance: scan -> connect -> handshake -> physical move.

## 唤醒后音频丢失修复 (wakeword-audio-gap)

更新时间：2026-06-30 CST

- [x] 措施 1: App 启动时预热 STT createStream
- [x] 措施 2: sessionService.touch() 改为非阻塞
- [x] 措施 3: 唤醒时跳过冗余 stopListeningStreaming
- [x] 措施 4: VAD + STT 并行启动
- [x] 措施 6: preroll 取量从 700ms 增到 1000ms
- [x] 验证: tsc + test + React Doctor
- [ ] 真机验证: 唤醒词+命令连续说，确认 ASR 完整识别

## Android dev-client restart bug investigation

- [x] Start the Expo dev server with `pnpm dev`.
- [x] Detect the connected Android target and restart the dev client.
- [x] Capture Metro/Android logs and identify the runtime failure.
  - [x] Android bundle completed and app initialized.
  - [x] Observed `[Bootstrap] Failed to register device tools: fetch failed: java.net.NoRouteToHostException: Host unreachable`.
- [x] Apply a focused fix if the failure is in app code.
  - [x] Updated local `.env` server URLs from the stale LAN IP to the current host IP.
- [x] Run the smallest relevant validation and update follow-up notes.
  - [x] Confirmed `http://192.168.3.73:8080/health` from the host.
  - [x] Restarted Metro after env reload and relaunched Android dev client.
  - [x] Confirmed Metro/logcat no longer show `NoRouteToHost` or device-tool registration failure.
  - [x] Fixed duplicate React key warning in home quick actions by using stable action IDs instead of route hrefs.
  - [x] Re-ran Android dev-client clean log check; no duplicate key warning, JS fatal, or device-tool registration failure.
  - [x] `pnpm exec tsc --noEmit`
  - [x] React Doctor changed-file scan: 88/100, remaining warnings are existing SettingsScreen size and sequential await debt.

## Home robot interaction UI refinement

- [x] Replace visible Chinese quick-action chips with icon-only controls backed by existing `expo-symbols`.
- [x] Keep action names as accessibility labels while removing visible prompt text from the quick panel.
- [x] Replace in-page side navigation letters with `expo-symbols` icon + title controls.
- [x] Increase shared page scrollable area by compacting `DeviceShell` frame padding, side rail, header height, and title sizing.
- [x] Move the listening wave from the robot mouth into a compact head-top status badge.
- [x] Keep the robot mouth as an expression during listening.
- [x] Update RobotFace shadows to cross-platform `boxShadow`.
- [x] Validate changes.
  - [x] `pnpm exec tsc --noEmit`
  - [x] React Doctor changed-file scan: 88/100; remaining warnings are existing SettingsScreen size and sequential await debt.
  - [x] Android dev-client clean restart: no SVG/native module error, JS fatal, duplicate key warning, or device-tool registration failure.

## README bilingual launch preparation

更新时间：2026-06-29 00:00:00 UTC

- [x] 梳理根 README 当前内容和 `packages/looi-sdk` 初版 API。
- [x] 更新根 README 为中/英双版，明确 looi-sdk 是早期核心之一，RN 应用是 SDK 的应用场景之一。
- [x] 更新 SDK README 为中/英双版，补充安装、API、设计原则和鸣谢。
- [x] 提供 GitHub Description、Topics、Labels 建议配置。
- [x] 感谢 `splattydoesstuff/sooperchargeforbots` 带来的切入方向。
- [x] 运行 README/SDK 文档相关校验。
