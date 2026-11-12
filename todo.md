# 当前待办

## 语音过早接话与重复收音

- [ ] 在原生 `VoiceAudio` 选择并接入厂商无关的 AEC；优先比较 AEC3 / Sonora 与 LocalVQE 仅去回声模型，统一播放参考和采集时钟，在真机横屏核对外放与自然插话。用户提供的 SAMI 模型若继续使用，还需匹配的独立运行库及离线授权。协议与框架取舍见 [通用 Realtime 与独立 AEC 调研](docs/realtime-portability-and-aec-research.md)。
  - iOS 已调用 `setVoiceProcessingEnabled(true)` 并读回启用状态，mixer 输出与输入 tap 共用处理格式；iPhone 16e／iOS 26.3 模拟器的真实采播与 KWS／会话切换探针通过。用户所报现象发生于该模拟器，当前使用 Mac 内置麦克风与扬声器；继续实测外放回声抑制与自然插话效果。
  - Android 三项核查：实际使用 AAudio，输入已请求 `VOICE_COMMUNICATION`、输出已请求语音通信用途；未分配／读取音频会话 ID，未创建 AEC 或读取 `getEnabled()`，状态回执也无 AEC 字段。真机核对实际 input preset、AEC 绑定与启用返回值、采播设备及系统效果链；自定义 AAudio 播放和 16k／24k 采样率差异本身不能证明参考失配。2026-11-12 核查时 ADB 无连接真机。
- [ ] 修正实时语音上行的 20ms 节拍：当前处理后再等待 20ms、每轮最多发一帧，缺少耗时补偿，500ms 缓冲超限丢旧帧。
- [ ] 在真机横屏复核句中停顿和外放插话，记录最后一帧人声到服务端判停的间隔，再决定是否调整停顿窗口；三次真实握手已发送 `end_smooth_window_ms=2500` 和 `enable_custom_vad=true`，现有观测不足以判断参数失效。

## Node 兼容包导出检查

- [ ] 修复 `packages/nsh-node-compat/scripts/check-exports.ts` 在 Node 中直接加载 `dist/shims/crypto.js` 的方式；当前因原生专用导入 `__nsh_native/crypto` 无法解析而失败。

## 任务真实链路

- [ ] 连接开发真机横屏验收任务选择、长上下文展开、搜索动作、失败／取消标记，以及查看任务后返回语音的跨连接播报；方案见 `docs/plans/task-execution-trace-plan.md`。

## Voice Agent 只读工具与自然委派

- [ ] 根据真实请求记录调整历史对话追问中的额外 `web_search` 调用；本地链路已能独立展示历史输入、搜索动作与最终回答。
- [ ] 接入语音直接只读 shell：覆盖文件／日志／环境及设备／任务／App 数据查询，执行接口取舍依据见 `docs/voice-agent-readonly-shell-and-handoff-research.md`。
- [ ] 连接手机开发真机后横屏验证自然委派：接下要求后继续闲聊、说话期间完成后空闲汇报、结束／重连后交付待发结果、语音停止工作及温热窗口内追问；当前 iOS 与 ADB 设备列表均为空。实现依据见 `docs/plans/voice-natural-handoff-plan.md`。

## 实时语音转写重复与文字越界

- [ ] 连接手机真机后复核「说一句话给我听听」的转写与横屏长句；整句事件、完成事件 `text`、下一轮回归以及 Mac 原生横屏渲染均已验证通过。

## 豆包预置音色

- [ ] 连接 iOS 或 Android 真机后核对选择器布局与实际试听；当前设备列表为空。

## 家居英文文案回归

- [ ] `app_ui::language_and_appearance_preferences_survive_reopening` 仍等待旧提示 `Connect your Xiaomi Home account`，当前家居服务页显示 `Sign in to Xiaomi Home`；音色专项与其他三项页面回归通过。

## 语音配置与同页调试

实施依据：[图二语音配置与同页调试计划](docs/plans/voice-debug-workspace-plan.md)。

- [x] 按图二实现服务卡片、对应配置、用户转写／回复与固定会话栏，直接在当前页开始和结束对话。
- [x] 完成豆包音色草稿试听、保存、应用并重连；试听采用不采集麦克风的短会话，结束后恢复原唤醒偏好。
- [ ] 完成 VoiceRuntime 服务切换、每服务音色与默认选择迁移，实测 OpenAI Realtime 的音色和试听后开放卡片。

## 家居与表情接入语音

实施依据：[家居控制与表情控制接入计划](docs/plans/voice-home-and-expression-integration-plan.md)。

- [ ] 家居工具对齐页面控制元语，打通实时语音直接查询、参数控制与房间批量操作，并同步 Pi 工具。
- [ ] 接入 72 表情口令及自主表达，统一显示优先级、到期恢复与会话清理。
- [ ] 完成双协议多工具按轮回传与续说、自动化回归及开发真机验收。

## 米家摄像头取流

三台摄像头的社区协议直连均已取得真实可解码视频，实测及原 HLS 失败证据分别见 [社区协议验证](docs/xiaomi-camera-community-verification.md) 与 [手机 HLS 验证](docs/xiaomi-camera-mobile-verification.md)。 接入按用户确认的「实时预览 + Agent 按需取帧」设计，见 [原生接入方案](docs/plans/xiaomi-camera-native-integration-plan.md) 与 [两端原生媒体研究](docs/xiaomi-camera-mobile-native-research.md)。

- [ ] 在真机验证前台无预览 JPEG、同 DID 共享解码与另一 DID 临时取帧，并接回 Agent 图片工具。现有 App 已接入 xiaomiio 账号和 MISS/CS2 原生预览；iPhone 16e 已显示大厅实时画面。复用范围与复杂度见 `docs/xiaomi-camera-community-solutions.md`。
- [ ] 新增 Pi 家居图片工具，返回真实 JPEG 图像块并接通当前视觉模型；现有家居工具仅返回文本，旧 VisionProvider 不是本链路。
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

- [ ] 连接真机，横屏验收 Pi 标准资源与会话恢复、执行中补充要求、取消和 codemode 嵌套工具；自动化结果与接口见 [Pi 运行时接入](docs/pi-runtime.md)。
- [ ] 接通 MCP 首次浏览器登录：在 App 注册 `installNativeOAuthCallbackAdapter` 的 deep link 回调，并提供授权入口；已有令牌的保存与刷新已在真实 QuickJS 中验证。
- [ ] 基于现有 SQLite 持久化能力确定个人事实存储与统一写入入口，接通记住、纠正、遗忘及检索注入。
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


## 管理空间边缘衔接

- [ ] 连接开发真机核对管理空间横竖屏边缘与分隔线；代码已改为区域背景铺满、内容消费安全区，类型检查、构建、隔离后的 4 项 App UI 回归与独立审查通过。当前 ADB 无连接设备。

## 语音管理页

- [ ] 在已签名开发真机核对语音新布局、凭证保存、键盘输入及首次麦克风授权后重试。Mac 测试宿主保存凭证返回 `Keychain write unavailable (-34018)`；已配置截图采用内存状态预览。当前无连接真机。
- [ ] 开放服务切换时将语音服务选择落到 VoiceRuntime，保持豆包与 OpenAI 各自凭证及音色配置；当前顶栏标明 OpenAI Realtime 待接入。


## 家居设备网格交互优化

- [ ] 真机验证缩放手感与折叠布局：代码、7 项回归与独立审查已通过；当前 Android 未连接，历史 Wi-Fi ADB 地址连接被拒绝，devicectl 未发现 iPhone。


## 米家视频真实接线

- [ ] 在真机补充新账号完整验证码登录与 Android 原生预览；iPhone 16e 已验证保存的视频账号恢复、真实设备发现与大厅实时画面，验证码请求序列已有原生 HTTP 回放和页面交互回归。


## 语音主 Agent 与长期导演

实施顺序见 [Agent 架构微步骤计划](docs/plans/agent-coordinator-microsteps-plan.md)，社区依据见 [语音与多任务架构调研](docs/voice-agent-community-architecture-research.md)。

- [ ] 从微步骤 01 开始实施单任务启动入口，按 8 轮、56 步推进唯一持久协调 Agent 与多任务主链。
- [ ] 第 6 轮用真机对话记录调整观察频率与摘要预算；初版按完整对话轮次触发观察，结果汇总经过协调 Agent，表达复用语音空闲窗口。

## 大厅台灯控制回执（2026-11-12）

- [ ] 连接开发真机，横屏复测大厅台灯开关与亮度 255；核对真实米家返回码、操作后的回读及任务详情错误数据。当前 `devicectl` 和 ADB 均无连接真机。历史 11:04 回执没有保存底层码，无法追溯当次失败原因；新链路已保留 HTTP 状态、米家返回码、属性结果和网络原因。
