# 当前待办

## Android LIVE 音量键真机确认（2026-11-09）

- [ ] 魅族 20 Pro 在 LIVE 实际播报时按实体音量键，确认改变的是语音外放响度；会话结束后确认音量键恢复原通道。开发宿主已安装，原生插件检查与 Java 编译通过。

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
  - [x] `VoiceRuntime`：本地待机、Duplex 多轮与 12 秒静默自动休眠。
  - [x] 首屏和语音管理空间：唤醒开关、状态文案与前后台/米家登录生命周期联动。
  - [ ] 用真实麦克风分别说出 Hey LOOI、嘿露伊、你好露伊，记录唤醒准确率和误唤醒情况；iOS 模拟器已验证 Hey LOOI 口述命中并进入 LIVE 连接，其余口令和真机仍待测。
  - [ ] 用真实豆包 Duplex 凭证验证唤醒后的多轮播报、长句不误休眠与 12 秒静默回待机。
  - [ ] 用真实 OpenAI Realtime 凭证验证多轮、打断播放进度、工具续说与 Langfuse 中的完整 Voice → Agent Trace；当前已覆盖协议、运行时和追踪集成测试。
  - [x] Android API 34 模拟器首次麦克风授权、KWS 加载、单流切换与提示音探针通过；三 ABI APK 已构建并通过 16 KB 对齐验证。
- [ ] **后续备选优化：零等待连说增强（视首版实机体验按需启用）**
  - [ ] **备选 B1（冷启动有界 FIFO + 加速节拍追赶）**：唤醒词命中瞬间将词尾后的首句语音缓存在本地有界 FIFO（上限 3 秒），收到 `session.created` 后将豆包发送节拍器从 `20ms` 临时提速至 `11ms`（约 1.8x）排空积压帧后恢复 `20ms` 实时步进，支持 `"Hey LOOI 打开台灯"` 无需停顿连说。
  - [ ] **备选 B2（Warm Session 静音热备）**：在活跃交互驻座期预先建立豆包 WebSocket 并保持 `input_audio_mute.commit` 静默，本地 KWS 命中瞬间仅发送 `input_audio_unmute.commit` 实现 `0ms` 建连延迟。

## NSH 后续功能

- [x] LOOI 具身底座 SDK 与 NSH 接入（方案见 [`docs/plans/nsh-looi-sdk-integration-plan.md`](docs/plans/nsh-looi-sdk-integration-plan.md)）：已完成 iOS / Android 双端 `LooiBle` 原生桥接、`BodyRuntime`、实时语音与 Pi Agent 双通道 `control_looi_body` 工具，以及去工程化的「底座」管理空间（经典方向轮盘 + 纵向头部滑动条 + 补光灯开关）。
- [ ] LOOI 物理底座真机已验证 BLE 扫描、3 步握手及 `fed9` 上座通知；待实测脱座通知、轮盘与云台物理量程，以及方向轮盘轻触微移与长按连续运动的实机手感。
- [ ] 对照 [`andrey-tut/LOOI-Robot`](https://github.com/andrey-tut/LOOI-Robot) 的实测协议，完成以下真机核对：
  - [ ] 继续定位 [两套初始化真机对照](docs/looi-ble-live-verification.md) 中的具体必要步骤：记录目标底座固件版本，对照 `FEF0` 时间、`FEDA:8101`、通知顺序及社区 `FED8` 读取。
  - [ ] 真机核对新四方向字节 `7f00`、`8100`、`007f`、`0081` 是否产生预期的纯直行/原地旋转；既有三步握手配合 30 ms `FED0` 已保持连接约 6 分 27 秒。
  - [ ] 连续 `FED0` 心跳与头部/灯光写入并发时，真机曾显示“蓝牙特征值写入失败”；本轮已为 `FED8` 读取和 `FED2` 写入暂停心跳，仍需定位原有失败写入并核对头部操作时序。
  - [ ] 真机核对 `FED8` 电量/外接供电读取及 `FED2` 亮度 `0x80`/`0xFF` 的物理效果。
  - [ ] 真机校准 `FED1` 中位 `0x87` 与对方实测 `0x5A`，同步核对 25°/85° 的抬头、低头标注；评估 `FED9` 触摸/悬崖传感器解析。
- [ ] 蓝牙断线后自动重连：当前开关仅控制启动或切回蓝牙模式时连接上次底座；在真机验证断线事件与重连时机后，再实现持续重试。
- [ ] 双端真机麦克风、扬声器、AEC（回声消除）、后台音频和 LIVE 并发性能验证；模拟器合成 PCM 链路已有记录。
- [ ] MIoT 完整 OAuth fixture、回调 GET / POST 307 / 子资源请求测试及真实设备回读。
- [ ] 相机采集、视觉输入与前台保持唤醒的原生接线。
- [ ] 如需导入旧用户数据，实现旧端数据导出与 NSH 导入；旧源码见 `archive/legacy-hub-and-expo`。
- [ ] 商店签名、Android API 36 / AAB、32 位 ABI 运行与真机发布验证。
- [ ] iOS 真机 Release 构建：当前 ONNX 静态库链接缺少 `___chkstk_darwin`，`nsh package --target ios` 未能产出设备包；修复链接后验证横屏 `Info.plist`。
- [ ] Pi 预编译扩展、深链 OAuth 与图片处理的手机宿主验证；完整桌面 SDK 根入口的兼容问题见既有兼容层记录。

## 模型服务认证与订阅接入（2026-11-07 调研）

结论见 [接入范围与架构建议](docs/llm-provider-auth-research.md) 和 [MiniMax / MiMo 证据](docs/llm-china-provider-research.md)。

- [ ] ChatGPT 正式 plan usage：核验项目发行形态，手机系统浏览器 + 127.0.0.1 回调、OIDC 身份验证、注册复用、账号目录与 Responses 工具流。
- [ ] MiniMax M Plan：确认自有 App OAuth client 接入规则、国内/国际域名与个人交互用途；验证设备码登录和刷新。
- [ ] 小米 MiMo：先接按量 API 预设；第三方免 Key 授权与 Token Plan 对机器人场景的适用性待确认，不复用米家授权。
- [ ] 统一多连接/凭据生命周期、协议适配、旧配置迁移与模型发现；套餐额度耗尽不得静默转为按量扣费。

- [ ] 扩展候选落地：Kimi 会员 Key/OAuth 的自有客户端身份与个人交互范围；GLM 标准 API 明确避开 Pi 默认 Coding Plan endpoint；Qwen 新订阅第三方资格另验。
- [ ] 补齐 DeepSeek、Qwen/百炼、火山、硅基流动预设；腾讯/百度/OpenRouter 扩展目录；火山/Kimi 平台端超额计费设置需可见。
