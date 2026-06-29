# 主屏幕语音对话进度

更新时间：2026-06-28 13:11:25 CST

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
