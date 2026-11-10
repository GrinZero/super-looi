# 当前待办

## 米家摄像头取流

三台摄像头的社区协议直连均已取得真实可解码视频，实测及原 HLS 失败证据分别见 [社区协议验证](docs/xiaomi-camera-community-verification.md) 与 [手机 HLS 验证](docs/xiaomi-camera-mobile-verification.md)。

- [ ] 将已验证的 MISS/CS2/TCP 链路接入手机进程：现有 App 仍使用返回 404 的云 HLS；社区链路需要 xiaomiio 账号会话、socket、会话加密和原生编码帧入口。复用范围与复杂度见 `docs/xiaomi-camera-community-solutions.md`。
- [ ] 在手机开发宿主验证真实显示首帧、连续播放、退出释放与前后台恢复；本轮成功证据来自 Mac 的三次约 20 秒媒体采样。
- [ ] 恢复魅族 20 Pro 的 USB/ADB 连接后，执行手机内置链路的延迟与播放／退出内存验收。

## 智能家居能力与视觉还原

实施依据：[真机能力、拖边布局与设计还原方案](docs/plans/smart-home-device-and-design-repair-plan.md)。

- [x] 按真机调研补齐 MIoT 可写属性和动作映射、HA 风扇参数、能力元语组装；真实风扇具备 4 档风速、3 种模式、摇头及角度，空调具备温度/模式/风速，台灯具备亮度/色温及 11 项模式选择器。
- [x] 修复布局入口重复、尺寸按钮替代拖边、窗口宽度决定列数导致卡片过窄，以及 PM2.5 和家电图标缺少语义视觉的问题。
- [x] 修复洗碗机误归洗衣机、扫地机双刷耗材覆盖、电饭煲空转虚构进度、监控流/分辨率占位文案和存储单位（KB→GB）错误；证据见 `docs/artifacts/home-repair-audit/capability-inventory.json`。


## 设备排序与开关反馈

- [ ] 魅族 20 Pro 核对风扇开关的即时反馈与卡片位置保持；固定排序、乐观更新及轮询/连续点击/失败恢复回归已通过，开发宿主已热更新。

## Pi Agent 联网搜索与任务结果

- [ ] 区分执行循环结束与用户目标完成：上述真机任务 `toolCallsCount=0`，仍被保存为 `succeeded`；当前执行器只排除模型错误、取消和空回复。设计结果表达时覆盖能力不足和需要补充信息，避免通过匹配自然语言回复推断状态。

## Agent 记忆与上下文管理

依据见 [社区机制调研](docs/agent-memory-context-research.md)。

- [ ] 比较 Pi 1.5.0 压缩逻辑独立复用与整体接入 `AgentSession` 的集成面，明确现有 SQLite 任务、审批和消息检查点的归属。
- [ ] 确定 `PersonalMemoryStore` 与 `MemoryLedgerService` 的统一个人事实写入入口，明确记住、纠正、遗忘及检索注入的调用关系。
- [ ] 核对豆包/OpenAI 语音转写的持久化与摘要注入能力，确定语音重连接续逻辑会话的方式，并按实际模型窗口确定上下文预算。

## NSH Linux Shell 接入

依据见 [双端 Linux Shell 接入计划](docs/plans/nsh-linux-shell-openminis-plan.md)。

- [ ] 连接 iPhone 并配置有效开发签名后，运行 `test:ios --device <UDID>` 与 `test:linux:ios --device <UDID>`；本次用户确认 iOS 按双 SDK 构建检查交付，真机运行未执行。实现与验证见 `docs/nsh-linux-shell.md`、`docs/nsh-linux-shell-verification.md`。

## Android LIVE 音量键真机确认（2026-11-09）

- [ ] LIVE 声音偏小：已修复魅族 20 Pro 的默认听筒路由，真机确认 AAudio 输出切到扬声器 `deviceId:3`；待用户试听确认实际播报响度。
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

- [x] LOOI 具身底座 SDK 与 NSH 接入（方案见 [`docs/plans/nsh-looi-sdk-integration-plan.md`](docs/plans/nsh-looi-sdk-integration-plan.md) 与 [`docs/plans/body-control-system-and-stepless-wheel-plan.md`](docs/plans/body-control-system-and-stepless-wheel-plan.md)）：已完成 iOS / Android 双端 `LooiBle` 原生桥接、`BodyRuntime`、实时语音与 Pi Agent 双通道 `control_looi_body` 工具（支持双轴无极脉冲、任意角度俯仰、无极补光亮度与电量查询），以及「底座」管理空间的 360° 无极变向摇杆轮盘、纵向头部滑动条、补光灯亮度滑杆与电量状态卡。
- [ ] LOOI 物理底座真机已验证 BLE 扫描、3 步握手及 `fed9` 上座通知；待实测脱座通知、360° 无极变向摇杆斜向转向手感与云台物理量程。
- [ ] 对照 [`andrey-tut/LOOI-Robot`](https://github.com/andrey-tut/LOOI-Robot) 的实测协议，完成以下真机核对：
  - [ ] 继续定位 [两套初始化真机对照](docs/looi-ble-live-verification.md) 中的具体必要步骤：记录目标底座固件版本，对照 `FEF0` 时间、`FEDA:8101`、通知顺序及社区 `FED8` 读取。
  - [ ] 真机核对新四方向字节 `7f00`、`8100`、`007f`、`0081` 及双轴合成向量是否产生预期的直行、原地旋转与差速弧线运动；既有三步握手配合 30 ms `FED0` 已保持连接约 6 分 27 秒。
  - [ ] 连续 `FED0` 心跳与头部/灯光写入并发时，真机曾显示“蓝牙特征值写入失败”：已定位 Android `BluetoothGatt.writeCharacteristic` 无应答写入在 `onCharacteristicWrite` 回调前仍占写锁，并在 `BodySupervisor` 中将 `FED0`/`FED1`/停止帧统一纳入 FIFO 30 ms 节流队列且在 `FED8`/`FED2` 60 ms 静默窗暂停无应答写入；待在物理底座上核对并发拖动摇杆、调节俯仰与灯光时是否彻底消除写忙报错。
  - [ ] 真机核对底座界面 `FED8` 电量/外接供电读取及 `FED2` 亮度滑杆（默认开灯 `50%` / `0x80`、满亮 `0xFF`）的物理效果。
  - [ ] 真机校准 `FED1` 中位 `0x87` 与对方实测 `0x5A`，同步核对 25°/85° 的抬头、低头标注；评估 `FED9` 触摸/悬崖传感器解析。
- [ ] 蓝牙底座二次吸附真机联调：已在 `BodyRuntime` / `store.ts` 落地已配对底座的前台静默自动重连（`retrievePeripheralsWithIdentifiers:` / `TRANSPORT_LE` + 命中即停扫描）、手动断开保持，以及首屏二次吸附四重反馈（`dock_snap` / `undock_float` 表情、`LightToast`、`playDockCue` 音效与 `67° → 55°` 云台问候）；待搭配通电的 LOOI 物理底座核对真机断连恢复时延与 `FED9` 吸合/脱座手感。
- [ ] 双端真机麦克风、扬声器、AEC（回声消除）、后台音频和 LIVE 并发性能验证；模拟器合成 PCM 链路已有记录。
- [ ] MIoT 完整 OAuth fixture、回调 GET / POST 307 / 子资源请求测试及真实设备回读。
- [ ] 相机采集与视觉输入的原生接线。
- [ ] iOS 真机验证前台屏幕常亮、失活释放与再次激活恢复；设备目标编译检查已通过。
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
