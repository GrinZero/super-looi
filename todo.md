# 当前待办

## 中英双语接入

接入依据见 [NSH 中英双语接入调研](docs/nsh-multilingual-integration-research.md)，执行步骤见 [实施计划](docs/plans/nsh-bilingual-integration-plan.md)。

实现与验证见 [NSH 中英双语](docs/nsh-bilingual-integration.md)。
- [ ] 豆包英文专用音色 `en_female_jenny_uranus_bigtts` 在当前 `1.2.6.1` 模型与凭证下返回英文文本但零音频帧；如需提供英文专用音色，先核实适用的 S2S 音色 ID 并取得有声输出。

## LOOI 专属机械音色

- [ ] 试听 `assets/voice/looi-warm-mechanical-reference.wav` 后确定声线；在豆包音色设计或声音复刻中生成专属 Speaker ID，填入 NSH「语音 → 豆包输出音色」。当前 `DOUBAO_API_KEY` 请求 Seed Audio 1.0 返回 `403 resource not granted`。

## iOS 模拟器语音回灌（2026-11-08）

- [ ] iPhone 16e 的第二轮 ASR 转写包含 LOOI 上一轮播报；核对模拟器播放回灌与实时语音回声消除，避免把助手语音当作用户输入。

## NSH 自动语音唤醒 → 豆包 Realtime 对话（2026-11-07 规划）

调研与实施方案见 [开源社区调研](docs/voice-wake-realtime-community-research.md) 与 [NSH 语音唤醒实施方案](docs/plans/nsh-voice-wake-realtime-plan.md)。

- [ ] **首版稳健基线（喊 Hey LOOI $\rightarrow$ 眼神/提示音就绪 $\rightarrow$ 开口多轮对话 + 12s 自动休眠）**
  - [x] 跨端原生库链接与模型资产打包管线：iOS 真机/模拟器静态链接、Android 三架构动态库注入和 16 KB 对齐、模型内嵌与沙盒释放。
  - [x] Rust 原生音频层：中英双语 KWS、专用推理线程、单流切换、就绪提示音与播放排空状态。
  - [x] `VoiceRuntime`：本地待机、Duplex 多轮、12 秒自动休眠与道别工具。
  - [x] 首屏和语音管理空间：唤醒开关、状态文案与前后台/米家登录生命周期联动。
  - [ ] 用真实麦克风分别说出 Hey LOOI、嘿露伊、你好露伊，记录唤醒准确率和误唤醒情况；iOS 模拟器已验证 Hey LOOI 口述命中并进入 LIVE 连接，其余口令和真机仍待测。
  - [ ] 用真实豆包 Duplex 凭证验证唤醒后的多轮播报、长句不误休眠、道别工具和 12 秒回待机。
  - [ ] 用真实豆包凭证复核明确结束语回待机：协议适配器已启用 `enable_user_query_exit`，将 `status_code="20000002"` 映射为播报排空后 `session.close`，模拟回归已通过；真网回读尚待验证。该端点实测拒绝 `response.create`（`45000000: unknown event name`）。
  - [ ] 用真实 OpenAI Realtime 凭证验证多轮、打断播放进度、工具续说与 Langfuse 中的完整 Voice → Agent Trace；当前已覆盖协议、运行时和追踪集成测试。
  - [x] Android API 34 模拟器首次麦克风授权、KWS 加载、单流切换与提示音探针通过；三 ABI APK 已构建并通过 16 KB 对齐验证。
- [ ] **后续备选优化：零等待连说增强（视首版实机体验按需启用）**
  - [ ] **备选 B1（冷启动有界 FIFO + 加速节拍追赶）**：唤醒词命中瞬间将词尾后的首句语音缓存在本地有界 FIFO（上限 3 秒），收到 `session.created` 后将豆包发送节拍器从 `20ms` 临时提速至 `11ms`（约 1.8x）排空积压帧后恢复 `20ms` 实时步进，支持 `"Hey LOOI 打开台灯"` 无需停顿连说。
  - [ ] **备选 B2（Warm Session 静音热备）**：在活跃交互驻座期预先建立豆包 WebSocket 并保持 `input_audio_mute.commit` 静默，本地 KWS 命中瞬间仅发送 `input_audio_unmute.commit` 实现 `0ms` 建连延迟。

## NSH 后续功能

- [ ] LOOI BLE 原生桥接及真机连接、断连、脱座与停止验证；共享驱动与状态机已保留。
- [ ] 双端真机麦克风、扬声器、AEC（回声消除）、后台音频和 LIVE 并发性能验证；模拟器合成 PCM 链路已有记录。
- [ ] MIoT 完整 OAuth fixture、回调 GET / POST 307 / 子资源请求测试及真实设备回读。
- [ ] 相机采集、视觉输入与前台保持唤醒的原生接线。
- [ ] 如需导入旧用户数据，实现旧端数据导出与 NSH 导入；旧源码见 `archive/legacy-hub-and-expo`。
- [ ] 商店签名、Android API 36 / AAB、32 位 ABI 运行与真机发布验证。
- [ ] Pi 预编译扩展、深链 OAuth 与图片处理的手机宿主验证；完整桌面 SDK 根入口的兼容问题见既有兼容层记录。

## 模型服务认证与订阅接入（2026-11-07 调研）

结论见 [接入范围与架构建议](docs/llm-provider-auth-research.md) 和 [MiniMax / MiMo 证据](docs/llm-china-provider-research.md)。

- [ ] ChatGPT 正式 plan usage：核验项目发行形态，手机系统浏览器 + 127.0.0.1 回调、OIDC 身份验证、注册复用、账号目录与 Responses 工具流。
- [ ] MiniMax M Plan：确认自有 App OAuth client 接入规则、国内/国际域名与个人交互用途；验证设备码登录和刷新。
- [ ] 小米 MiMo：先接按量 API 预设；第三方免 Key 授权与 Token Plan 对机器人场景的适用性待确认，不复用米家授权。
- [ ] 统一多连接/凭据生命周期、协议适配、旧配置迁移与模型发现；套餐额度耗尽不得静默转为按量扣费。

- [ ] 扩展候选落地：Kimi 会员 Key/OAuth 的自有客户端身份与个人交互范围；GLM 标准 API 明确避开 Pi 默认 Coding Plan endpoint；Qwen 新订阅第三方资格另验。
- [ ] 补齐 DeepSeek、Qwen/百炼、火山、硅基流动预设；腾讯/百度/OpenRouter 扩展目录；火山/Kimi 平台端超额计费设置需可见。
