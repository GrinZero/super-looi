# MOSS-Live Realtime API Provider 接入方案

引入 MOSS-Live（`wss://api.mosi.cn/v1/realtime?model=moss-live-1.0`）作为实时语音协议适配器（`providerId: "moss"`），支持在运行时与构建环境（`VOICE_PROVIDER=moss`）中切换，并与现有豆包 Duplex V3、OpenAI Realtime 共用统一的 `RealtimeProtocolAdapter`、`LiveVoiceSession` 与 `VoiceRuntime` 生命周期。

## 接口与职责

- `RealtimeProtocolAdapter`（`packages/looi-runtime/src/voice/realtime-protocol.ts`）：
  - 新增 `createMossLiveProtocol(options)`，并在 `createRealtimeProtocol` 中支持 `providerId: "moss" | "moss-live"`。
  - 吸收 MOSS-Live 协议细节：
    - 握手与会话配置：`encodeSessionStart` 发送 `attach_session`；收到 `session_attached`（`session_created`）后由 `encodeSessionConfigure` 发送 `media.configure`（请求 `output_audio: { format: "pcm16", sample_rate: 24000 }` 以匹配本机 24 kHz 播放管线，若服务端返回 48 kHz 则在协议层 2:1 降采样为 24 kHz PCM16）、可选 `change_voice`（`voice_name`）及 `session.update`（`persona`、`instructions`、`tools`）；收到 `session.updated` 且 `data.error === ""` 后发出 `session_ready`，对话模式下通过 `encodeMute(muted)` 发送 `mic_state` 开启或关闭麦克风。
    - 二进制音频流：`encodeAudioAppend` 直接返回 16 kHz 单声道 S16LE `Uint8Array` 二进制帧；`decodeServerEvents` 将 `response.audio.context`（含 `run_id`、`turn_id`、`chunk_id`、`duration_ms`）与随后到达的二进制 `Uint8Array` 帧配对解码为 `audio_delta`。
    - 播放回执编码：新增可选方法 `encodePlaybackChunkCompleted`、`encodePlaybackCompleted` 与 `encodePlaybackStopped`，将 MOSS-Live 的 `playback.chunk.completed`、`playback.completed`、`playback.stopped` 封装在协议适配器内。
    - 转写与工具回传：`input.transcript.updated/done/revised` 与 `output.transcript.updated/done` 均为整句快照（`snapshot: true`）；工具调用通过 `conversation.item.create` 提交结果，收到 `conversation.item.created`（`tool_output_confirmed`）后发送带 `call_ids` 的 `response.create` 继续回答；后台任务完成或交互通知使用 `session.commentary.append`，上下文同步使用 `session.update`。
    - 错误保留：将 `error`、`session.updated.data.error`、`media.configured.data.error`、`client_context.updated.data.error` 及 `response.ended(status=failed)` 的具体错误码与原因完整保留到 `RealtimeServerEvent`、观测链路与会话错误状态。
- `VoiceSocket`、`observeVoiceSocket` 与 `LiveVoiceSession`（`apps/nsh/runtime/voice/`、`packages/looi-runtime/src/telemetry/realtime-observer.ts`）：
  - `VoiceSocket.read/write` 扩展支持 `string | Uint8Array`，观测器按二进制帧字节数累计上下行音频流量。
  - `LiveVoiceSession` 根据本机 `queuedPlaybackMs` 跟踪当前回复各音频块的实际播放进度，在单块播完、整轮播完及打断清空时发送协议层编码的播放回执帧。
- `VoiceCredentialStore`、`VoiceRuntime` 与 `VoiceSpaceView`（`apps/nsh/runtime/voice/credentials.ts`、`runtime.ts`、`apps/nsh/ui/VoiceSpaceView.tsx`）：
  - 按 `providerId` 独立保存 API Key 与 `voiceIds`，内置 MOSS-Live 官方预置音色（暖暖 `6c3152b1-1d4f-4e49-ade3-09f447712fec`、木木 `6cc93520-3207-4f7a-bca9-2d560b9c306b`）与专属音色 ID 输入及试听。
  - 支持在语音管理页直接切换实时语音服务商（MOSS-Live、豆包、OpenAI Realtime），并支持通过 `VOICE_PROVIDER=moss` 指定默认服务商。
  - 压缩左侧语音舞台至 `flex: 4.2`、扩展右侧配置检视器至 `flex: 5.8`，并以 `VOICE_PROVIDERS` + `flex-wrap` + `grow shrink-0` 替代固定三均分 `flex-1` 分段条，消除长名称底板溢出并支持后续接入更多语音 Provider。

## 取舍

1. **在协议适配器内配对二进制帧与播放回执，而非拆分独立 MOSS 会话类**：
   - 方案 A：为 MOSS-Live 单独编写一套 `MossLiveVoiceSession`。代价是复制唤醒、12 秒静音休眠、后台任务 `WHEN_IDLE` 队列、跨连接历史拼接与 Langfuse 观测逻辑。
   - 方案 B：扩展 `VoiceSocket` 支持 `Uint8Array`，在 `RealtimeProtocolAdapter` 内完成 `response.audio.context` 与二进制帧配对，并由 `LiveVoiceSession` 基于本机播放队列余量触发可选的 `encodePlayback*` 钩子。
   - 采用方案 B：新增概念最少，所有实时语音特性（唤醒、打断、工具委派、跨连接温热上下文、遥测）对 MOSS-Live 自动生效。
2. **下行音频优先协商 24 kHz PCM16 并保留 48 kHz 降采样**：
   - MOSS-Live 默认下行 48 kHz PCM16，但 `media.configure` 原生支持 `output_audio.sample_rate = 24000`。优先协商 24 kHz 可减少一半下行带宽并直接对齐 Rust 音频线程 `PLAYBACK_RATE = 24000`；同时在协议层保留 48 kHz → 24 kHz 降采样，兼容未协商或固定 48 kHz 的流。

## 实施步骤

- [ ] Step 1：实现 `createMossLiveProtocol` 与二进制 WebSocket 观测适配（`packages/looi-runtime`）
  - [ ] 扩展 `RealtimeProtocolAdapter`、`RealtimeServerEvent` 与 `ObservedVoiceSocket` 支持 `Uint8Array` 二进制帧、快照式转写、工具确认续答及播放回执编码
  - [ ] 实现 `createMossLiveProtocol` 完整握手、音色切换、工具调用、主动播报与错误透传
- [ ] Step 2：升级 `LiveVoiceSession`、`VoiceCredentialStore` 与 `VoiceRuntime`（`apps/nsh/runtime/voice`）
  - [ ] 在 `LiveVoiceSession` 接入二进制帧读写、分块播放进度确认（`playback.chunk.completed` / `playback.completed` / `playback.stopped`）、`tool_output_confirmed` 与 `mic_state` 同步
  - [ ] 在 `VoiceCredentialStore` 与 `VoiceRuntime` 支持 `"moss"` 凭据、分服务商音色 ID 存储与运行时服务商切换
- [ ] Step 3：接入 `VoiceSpaceView` 服务商切换与 MOSS-Live 预置音色（`apps/nsh/ui`、`store.ts`、`i18n`）
  - [ ] 新增 MOSS-Live 音色表（暖暖、木木及自定义 ID），在「语音服务」支持切换 MOSS-Live / 豆包 / OpenAI Realtime
- [ ] Step 4：自动化测试、构建检查、独立子 agent review 与提交
  - [ ] 补充 `packages/looi-runtime/test/realtime-protocol.test.ts` 与 `apps/nsh/tests/` 中的 MOSS-Live 握手、二进制音频、播放回执、打断、工具调用与历史重连测试
  - [ ] 通过类型检查、包测试、NSH 构建与 Rust UI 测试，完成独立 review 并更新 `docs/arch/index.html` 与 `progress.md`
