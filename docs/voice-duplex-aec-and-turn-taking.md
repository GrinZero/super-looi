# 实时语音回声消除与判停方案

核验日期：2026-11-12。现役协议为 Seeduplex `1.2.6.1`，连接 `/api/v3/duplex/realtime/dialogue`。

## 豆包提供的能力

回声消除（AEC）与判停解决两个不同问题：AEC 从麦克风输入中去掉设备正在播放的声音；判停决定用户何时表达完毕。延长判停时间不能消除已经混入输入的助手声音。

| 能力 | 官方资料所支持的结论 | 本项目的含义 |
| --- | --- | --- |
| 原生 WebSocket API 的 AEC | Seeduplex API 的公开音频输入是单声道音频流；公开配置中未找到 AEC 开关或播放参考音频输入接口。厂商明确提供的 AEC 位于设备端 SDK。 | 保持当前原生 WebSocket 接入时，应在上传前完成 AEC。不能由模型“抗干扰”描述推导出它已完成设备回声消除。 |
| 模型动态判停 | 官方模型列表将全双工版本描述为具备动态判停和抗干扰能力。 | 当前模型已经有判停能力，仍需要干净且节奏正确的输入音频。 |
| 自定义停顿窗口 | 原实时语音文档定义 `asr.extra.end_smooth_window_ms`，默认 1500ms、范围 500ms～50s，并要求 `enable_custom_vad=true`。新协议《接入必读》说明原 `asr/tts/dialog` 配置可整体放入 `extension` 复用。 | 现有 `extension.asr.extra` 位置有官方迁移依据。全双工参数表未再次列出这两个字段，当前 `1.2.6.1` 是否按固定窗口执行，应以音频对照实测确定。 |
| 强制判停 | 新协议提供 `input_audio_buffer.commit`，用于客户端确认 query 完毕后主动触发判停。 | 可以主动告诉模型“说完了”；该事件本身不等于关闭此前的自动判停。 |
| 开放式语义判停配置 | 核对的新协议公开配置中未找到 `semantic_vad`、`eagerness`、`create_response=false` 或 `turn_detection=null` 的契约。 | 不能照搬 OpenAI 同名字段来阻止豆包提前回复。 |
| 按键控制输入结束 | 原实时语音 API 明确提供 `dialog.extra.input_mod=push_to_talk`，关闭服务端 VAD，使用 `EndASR` 结束；新协议把 `EndASR` 映射为 `input_audio_buffer.commit`。 | 新旧迁移说明提供了探索入口，但当前全双工版本未单独声明按键模式支持范围；确认实际行为后才能作为“由客户端决定发言结束”的实现依据。 |

依据：[Seeduplex API](https://docs.volcengine.com/docs/doubao-voice/end-to-end-real-time-voice-full-duplex-version?lang=zh)、[接入必读](https://docs.volcengine.com/docs/doubao-voice/access-must-read?lang=zh)、[原实时语音 API](https://docs.volcengine.com/docs/doubao-voice/end-to-endreal-time-speech-large-model-api-access-document?lang=zh)、[模型列表](https://docs.volcengine.com/docs/doubao-voice/model-list?lang=zh)。

## 官方 Seeduplex SDK 的设备端 AEC

火山提供直接使用现役双工协议的移动 SDK，AEC 在手机上处理。

| 项目 | iOS | Android |
| --- | --- | --- |
| 官方文档当前版本 | `SpeechEngineToB 0.0.15.0` | `com.bytedance.speechengine:speechengine_tob:0.0.15.0` |
| 协议 | `SEProtocolTypeSeedDuplex` | `PROTOCOL_TYPE_SEED_DUPLEX` |
| 地址 | `/api/v3/duplex/realtime/dialogue` | 同左 |
| 文档最低系统 | iOS 12.0 | Android 4.4 / API 19 |
| 文档架构 | armv7、arm64、x86_64 | armeabi-v7a、arm64-v8a |
| 网络依赖示例 | SocketRocket 0.6.1 | okhttp 4.9.1 |
| AEC 配置 | `SE_PARAMS_KEY_ENABLE_AEC_BOOL=true`，并设置 `SE_PARAMS_KEY_AEC_MODEL_PATH_STRING` | `PARAMS_KEY_ENABLE_AEC_BOOL=true`，并设置 `PARAMS_KEY_AEC_MODEL_PATH_STRING` |

两端 SDK 均提供本地 `aec.model`。默认录音和播放由 SDK 处理；启用其软件 AEC 需要显式开关及模型路径。接入示例使用现有语音 API Key，AEC 配置中没有单列额外云端服务鉴权步骤。旧版 Dialog SDK 文档为 `0.0.14.7` 与原 `/api/v3/realtime/dialogue`；全双工接入应以专用 `0.0.15.0` 文档为准。[全双工 iOS SDK](https://docs.volcengine.com/docs/doubao-voice/end-to-end-full-duplex-ios-sdk-documentation?lang=zh)、[全双工 Android SDK](https://docs.volcengine.com/docs/doubao-voice/end-to-end-full-duplex-android-sdk-documentation?lang=zh)、[原 iOS SDK](https://docs.volcengine.com/docs/doubao-voice/end-to-endios-sdk-interface-documentation?lang=zh)。

### 采集与播放的两种接法

**由 SDK 负责采集与播放。** SDK 内部掌握麦克风与播放音频，可直接提供 AEC 所需参考。上行 JSON 事件通过通用 `sendDirective` 发送，下行 JSON 事件通过 `SEDialogDownlinkEvent` / `MESSAGE_TYPE_DIALOG_DOWNLINK_EVENT` 接收。工具定义、工具回执和业务协议语义可继续使用；连接与音频设备生命周期改由 SDK 引擎承担。

**保留自定义 PCM 设备。** SDK 支持 `STREAM` 输入配合 `feedAudio`，也支持关闭内部播放器后通过音频回调自行播放。官方要求此时自行保证播放参考与录入回声的时间位置一致。播放回调跟随 SDK 的实时进度，解码回调则在数据准备好后立即返回；使用现有播放队列时，不能把解码时刻当作实际播出时刻。两端 SDK 文档没有给出“只调用 AEC，返回处理后 PCM，再交给另一个 WebSocket”的独立处理器接口契约；这条接法不能直接视为一个可插拔的 AEC 库。[iOS 自定义输入输出](https://docs.volcengine.com/docs/doubao-voice/end-to-end-full-duplex-ios-sdk-documentation?lang=zh)、[Android 自定义输入输出](https://docs.volcengine.com/docs/doubao-voice/end-to-end-full-duplex-android-sdk-documentation?lang=zh)。

## 集成取舍

系统 AEC 能复用本项目已有的原生音频层和厂商无关 WebSocket 协议，新增工作集中在 iOS 语音处理启用、Android 音效会话绑定，以及现有音频状态中的启用结果；不增加模型资源和第三方 SDK。

官方 SDK 的具体收益是提供同一厂商的软件 AEC 与采播链路。代价是增加两端 SDK、网络依赖、模型资源打包与路径管理、原生桥接和引擎生命周期；现有 `VoiceAudio` 与 SDK 需要明确唯一的音频所有者，KWS（唤醒词）与会话之间也需切换所有权。为保持回声参考对齐，由 SDK 同时拥有采集和播放比混用两套播放进度更直接。这些是基于 SDK 接口与现有调用链的集成推断。

面向 OpenAI 与豆包共用音频处理，AEC 放在原生音频层。系统 AEC 与独立处理器的选择、用户提供的 SAMI 模型和通用 Realtime 框架比较，见 [通用 Realtime 与独立 AEC 调研](realtime-portability-and-aec-research.md)。判停参数在收音与上传节拍修正后单独测量。

## 设备原生支持与现有缺口

### iOS

iOS 13 起，`AVAudioEngine` 的 I/O 节点提供 `setVoiceProcessingEnabled(true)`。引擎停止时在输入节点启用，系统会同时将输入、输出节点切到语音处理模式，采集端据此消除设备播放声音。`voiceChat` 负责语音会话模式，单独设置它不会启用这套回声消除处理。[Apple API](https://developer.apple.com/documentation/avfaudio/avaudioionode/setvoiceprocessingenabled(_:))、[Apple 语音会话说明](https://developer.apple.com/documentation/avfaudio/avaudiosession/mode-swift.struct/voicechat)、[WWDC 的输入输出处理说明](https://developer.apple.com/videos/play/wwdc2019/510/)。

当前 [`audio/ios.rs`](../apps/nsh/src/audio/ios.rs) 在 `Audio::start` 配置 `playAndRecord + voiceChat`，随后获取输入格式、安装采集 tap 并启动引擎，缺少语音处理启用。最小修改位置在引擎启动和读取输入格式之前；启用后重新读取实际格式，继续复用现有重采样及同一引擎中的播放器。语音处理是否启用可由 `isVoiceProcessingEnabled` 读取，`isVoiceProcessingBypassed` 用于确认采集端没有绕过处理。[Apple bypass API](https://developer.apple.com/documentation/avfaudio/avaudioinputnode/isvoiceprocessingbypassed)。

这条实现不增加第三方依赖，现有 `VoiceAudio` 生命周期继续统一管理待机、LIVE 和设备切换。

### Android

Android 提供 `AcousticEchoCanceler`：`isAvailable()` 查询设备是否实现，实例绑定录音的音频会话，`setEnabled(true)` 启用并通过 `getEnabled()` 读取状态。通信音源可能由设备自动插入 AEC，因此设置 `VOICE_COMMUNICATION` 与显式绑定音效的含义不同。[Android AEC](https://developer.android.com/reference/android/media/audiofx/AcousticEchoCanceler)、[通信音源](https://developer.android.com/reference/android/media/MediaRecorder.AudioSource#VOICE_COMMUNICATION)。

现有 [`audio/android.rs`](../apps/nsh/src/audio/android.rs) 设置通信输入预设，[Java 音频宿主](../apps/nsh/native/android/com/superlooi/nsh/SuperLooiApplication.java) 设置 `MODE_IN_COMMUNICATION`。AAudio 层尚未请求分配 session ID，也没有音效实例的创建、启用和释放。AAudio 默认的 `AAUDIO_SESSION_ID_NONE` 无法用于显式挂载 Java 音效；Android 9 / API 28 起，可请求 `AAUDIO_SESSION_ID_ALLOCATE`，再将 `AAudioStream_getSessionId()` 返回值交给 Java `AcousticEchoCanceler.create(sessionId)`。[NDK 会话与音效互操作](https://developer.android.com/ndk/reference/group/audio)。

最小实现保持现有 AAudio 采播，只在 Rust 与现有 Java 插件间增加会话 ID 传递及 AEC 实例生命周期。当前 `Api::stream` 打开流后立即启动，集成时将 AEC 绑定放在录音启动前，停止时释放。系统 API 的存在不代表每台目标手机都提供了可用 AEC；具体手机的 `available/enabled` 状态与外放效果需在该设备确认。分配音效会话可能增加音频延迟，官方 NDK 文档明确列出这一取舍。

## 本项目建议的修正顺序

1. 在现有原生音频层接入供两个服务商共用的 AEC，并把启用结果接回现有音频状态。系统 AEC 与独立处理器都在这一层选择，具体依赖与帧处理差异见通用性调研。
2. 修正 [`LiveVoiceSession.tick`](../apps/nsh/runtime/voice/live-session.ts) 的发送节拍：当前每轮最多发送一帧 20ms 音频，处理完成后再等待 20ms；使用实际时间补偿，避免长期落后采集时钟。缓冲超过 500ms 丢帧与本次抢话的关系仍需设备数据确认。
3. 保持当前已发送的 2500ms 配置，用真实音频测量句中停顿、最后一段人声与服务端判停的关系，再确定窗口调整值。不要把最终转写到响应的 19ms 解释成用户只停顿了 19ms。

模块归属保持清晰：`VoiceAudio` 负责音频设备和回声处理；`VoiceAudioPipeline` 负责 PCM 缓冲及实际播放位置；`RealtimeProtocolAdapter` 负责服务商事件和参数；`LiveVoiceSession` 负责对话轮次和工具调用。补齐原生处理即可复用这些边界，收益是改善现有缺陷，成本是两端原生调用和音效生命周期，无需另设语义判停服务。

真机横屏复现使用三个场景：助手外放时用户保持安静，确认不会生成包含助手回复的用户轮次；助手说话时用户插话，确认仍能停止播报并识别实际用户内容；用户说「我想知道的是……」停顿后续说，比较不同停顿长度的提交时刻。这三个场景分别验证回声、插话与判停。
