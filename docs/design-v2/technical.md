# Phone Agent 技术调研与架构设计

## 结论与技术路线

推荐以 super-looi 作为手机产品基线，保留 React Native／Expo、BLE transport、语音接口及现有 Postgres／Mem0；将 DeepSeek Harness 作为家庭主机上的可替换任务执行内核。手机原生层管理相机、声音、身体与停止，Home Assistant 管理家居协议与确定性自动化，长期用户记忆由独立的证据与事实服务掌握。[S01][S02][S10]

产品的核心资产是“有时间、有来源、有适用范围的用户上下文”及其与行动的连接。dsh-Go 解决移动任务体验的重要部分，LOOI 提供身体。Screenpipe 仅作为内部实现的研究样本：借鉴采集调度、去重、证据关联、语义投影和检索，自行实现手机摄像头与语音管线。本方案没有 Screenpipe App、daemon、API、MCP、数据库或 Mac 安装依赖。

修订版 v0.2；调研截止 2026年11月2日 Asia/Taipei。本版将 Screenpipe 明确为机制参考，并扩充第11节的手机实现映射。证据分为源码事实、官方文档事实、工程建议和待实机验证四类。所有拟议接口、预算与性能目标均为本项目设计，不是上游已提供的能力；未运行用户硬件或安装 APK。本报告以固定提交观察实现，并在来源中保留可追踪路径。

### 八项决定

- Android 前台 dock 为首个持续感知环境，随身模式继续任务但降低自动采集。
- RN 负责产品界面，原生层负责采集生命周期和 BLE 停止；不让 JS 定时器承担失联安全。
- DSH 通过受监督的子进程接入 Hub，不把 camera/audio 直接塞进 agent loop。
- 日常对话、感知事件、生产力任务分别存储和调度，按需要组装上下文。
- 家居先经 HA，按实体和操作授权；物理动作以回读和证据区分终态。
- Mem0 继续做召回适配器，新增 SQL 证据与事实版本账本。
- 主动观察从俯仰和新帧开始；轮式转向取决于实机故障停止证据。
- 不在 P0 引入 Kubernetes、独立消息总线、图数据库或第二套 Agent 框架。

:::page

## 1 研究对象与版本快照

| 对象 | 本轮读取版本 | 证据边界 |
| --- | --- | --- |
| DeepSeek Harness | master ce7073d51254c26cd63b22a60835b8f948deb447 | 官方源码快照；developer preview |
| CLI源码 manifest | 0.2.2-alpha.2，Node ≥24.9.0 | 不等同 npm 默认发行 |
| npm检索快照 | @deepseek-ai/dsh 0.2.1-rc.5 | 研发安装前需再次核实并锁依赖 |
| dsh-Go | release v1.0.8，2026-11-01 | main提交晚于release，能力不能混用 |
| dsh-Go main | 80a733b6c3f0bdcff7f99eeef37d0a543ddfb8a3 | 内置引擎锁0.2.1-rc.4；client说明仅验证到rc.2 |
| super-looi | 9985101d840e1ec1a6bbb022bccb1b0eb369b3d6 | 2026-06-30；SDK为早期alpha |
| Home Assistant | 2026.10.4 | 文档与release核实；具体集成仍需设备验证 |
| 小米官方HA集成 | v0.5.0，75b3acb6325a3a8d295688b13904737d6738a6a5 | 2026-09-28 |
| Screenpipe机制参考 | a6225faaca4517d50c32d8eaf0e83a14fe9a2626 | 2026-10-31；只读内部实现，非运行时依赖 |
| Mastra参考 | a47a1fa757efa927ae04014d77fb39aa837cb563及现行文档 | 只作为记忆机制参考，暂不新增运行时依赖 |

版本信息对应项目维护者源码、发布记录或 npm 检索；其中 npm 索引信息可靠性低于实际安装清单。正式构建应输出 runtime manifest：源码 SHA、包版本、锁文件摘要、模型能力、Android target、固件、集成版本和验收结果。不得使用浮动 latest 作为设备控制版本。[S01][S06][S10][S20][S29][S37][S45][S46]

### 许可证与复用边界

| 项目 | 当前核实 | 决策影响 |
| --- | --- | --- |
| DSH核心／super-looi | MIT | 可按相应许可复用，仍检查依赖和模型权重 |
| dsh-Go主体 | AGPL-3.0；sdk／examples有独立MIT范围 | 参考设计与直接复制代码分开决定 |
| dsh-Go宠物美术 | ASSETS明确排除 | 使用原创表情与角色，不复制Deepy／鲸娘 |
| Screenpipe研究样本 | 当前源码许可记录为Commercial License | 只参考机制，自主实现手机管线；未列入产品依赖 |
| 小米官方HA集成 | 仅非商业HA用途等限定 | 不抽取OAuth客户端或云API开发通用产品 |
| Apple HomeKit APIs | 家庭配置／自动化与数据出端限制 | 不把Apple API数据库直接送入跨端通用记忆 |

这是对实际复用范围的工程识别，不用“分进程”或“经HA转接”推导自动免责。私人验证与对外分发分别做适用性判断。Screenpipe 的许可信息仅记录研究样本背景，不作为当前架构的集成或采购门槛；如果未来决定复制具体代码，再核对该版本的复用条件。[S09][S21][S26][S36]

:::page

## 2 super-looi 的现有能力与差距

用户指定的仓库已经覆盖手机、语音、记忆、感知和身体的最初连接。它应作为演进基础。以下结论来自实际代码，不把架构文档中的愿景视为完成状态。[S10]

| 模块 | 代码中已存在 | 对目标产品的差距 |
| --- | --- | --- |
| RobotFace与页面 | 全屏／头像表情、语音状态联动 | 增加注意力、系统可用性及导航独立状态 |
| CameraFrameFeeder | 前摄每3秒takePictureAsync，base64 | 持续原生帧分析、生命周期、质量与热管理 |
| CameraPerceiver | 最多10帧，取最近单帧理解 | streaming占位；无时间戳／视角轨迹；confidence固定0.8 |
| SceneAnalyzer | 描述文本bigram Jaccard去重 | 不等于图像差异、物体跟踪或场景变化检测 |
| looi-sdk | 移动、头部、灯、吸附通知与raw写入 | 未提供可验证的角度／里程／避障遥测 |
| moveLooi | JS定时循环、延时后停止 | speed仅返回未用于控制；缺并发互斥与故障闭环 |
| device-tools WS | 注册、调用、结果及最近完成call去重 | 稳定身份、执行中去重、TTL、授权和重启恢复需补 |
| 记忆服务 | Mem0 OSS、pgvector、add/search/getAll | 证据权威表、纠错、有效期、删除级联、身份范围 |
| 会话服务 | 消息、evidenceUri、5分钟超时摘要 | 最近80条压为80字，不足以保留长期结构化知识 |

上述代码来自固定SHA；Camera和memory等文件在来源索引提供直接路径。[S11][S12][S13][S14][S15][S16][S52][S53]

### 必须先补的实现问题

第一，SDK disconnect 清理移动循环时使用 writeStop:false，drive 写入默认不等待响应。这不能证明断连后电机会停止。第二，重复 call 在完成前再次到达时，单靠 completedCallResults 无法阻止并发重复执行；应增加 in-flight ledger 和串行身体仲裁。第三，拍照工具返回缓存帧，却没有可判断新鲜度的时间与视角信息；主动观察可能重新解释同一帧。第四，设备工具的部分录音、视频和方向能力仍是占位，应从 capability discovery 中标 unavailable。[S11][S12][S52]

### 增量迁移顺序

先在现有接口外增加 schema_version、source timestamps、capability 状态与 action receipt，再建立 Task／MemoryService 边界。保留原 UI、ASR 与 BLE transport 的可用实现，逐个把实时循环移入原生层。原有 memory 记录以 legacy_import 导入，不能补造来源；80字摘要保留为列表预览，结构化 observations 另存。

:::page

## 3 手机架构与运行位置

### 客户端选型

| 方案 | 对现有仓库的复用 | 实时能力 | 本项目取舍 |
| --- | --- | --- | --- |
| RN／Expo dev build＋原生模块 | 高 | 原生Camera、Audio、BLE；JS负责界面 | 首选，沿已有代码增量推进 |
| Flutter fork dsh-Go | 低至中 | 已有本机引擎与移动任务体验 | 私人实验或接受AGPL的分支 |
| 全Kotlin重写 | 低 | Android平台控制最直接 | 仅关键模块原生化，避免全量重写 |
| Web／PWA | 部分TypeScript | 生命周期与设备覆盖需额外验证 | 作为管理页／设计审阅，不承担持续身体控制 |

选择 RN 的主要理由是已有可复用实现，不是认定任意 RN 组件都适合长时间采集。需要原生依赖的开发构建，不能把 Expo Go 当最终运行环境。目标 Android SDK 按当期发布要求配置；dsh-Go 当前 targetSdk 28 的侧载路线不作为现代分发基线。[S07][S45]

### 手机内部边界

Native Capture Service 独占音频采集，分发给 KWS／VAD／ASR。CameraX ImageAnalysis 处理低分辨率变化检测，采用有界 backpressure，旧帧来不及处理时丢弃，保持最新图像；不把每帧转 base64 穿过 RN JS bridge。[S28]

Native BodySupervisor 持有 GATT、动作租约、互斥、停止优先级和单调时钟。RN 只发送高层意图、展示状态；动画掉帧不影响停止。缓冲媒体主要在 RAM，SQLite 保存事件元数据、outbox 和任务缓存，选中的媒体写入有界文件目录。

### Hub 部署

一个 Node／Fastify 产品服务即可承载身份、Task API、Memory API、上下文装配和网关模块；一个 Postgres 继续保存事件、事实与向量索引；DSH Supervisor 管理少量独立 worker；HA 保持独立运行。无需一开始拆成大量微服务。

DSH 的任意 shell 与 Home Gateway 不能以同一高权限身份共享凭证。至少使用专用执行用户、受限工作区、文件权限和执行端 capability 校验；对需要更强隔离的任务采用容器或远端受限 runner。仅分为两个进程不足以保护 HA token。

Mac 可以验证，但合盖休眠会影响常驻性。长期家庭服务应放在真正常开节点；工作 Mac 只在在线时接任务。手机离家后通过用户批准的安全远程通道连接，BLE 身体始终在手机本地。

[[ARCHITECTURE]]

:::page

## 4 DeepSeek Harness 与 dsh-Go

### 官方 Harness 的复用价值

DSH 使用可组合插件组织模型 adapter、工具、会话和执行循环，适合把现有文件操作、SSH、工具调用、审批与工作区能力接入新产品。Session 日志和 compaction 管理任务上下文；它们并不自动成为长期用户画像或世界状态库。[S01][S03]

推荐自建 phone-agent profile，增加 context.retrieve、home.action、body.observe、work.delegate 等窄工具。感知事件先写证据服务，当前交互需要时才取经过筛选的 context pack。不要为每一帧照片创建 user message，也不要把所有家庭事件注入所有工作 session。

### 官方 SDK 的真实接口边界

TypeScript SDK 通过 stdio JSON-RPC 启动完整 Harness 子进程，支持文本、图像块、事件通知、审批与持久会话恢复。图像能进入协议不代表任意所选模型具备图像理解；模型能力需在 route registry 声明并验证。[S02]

当前 run 的结果是输入被接收至下一次 idle 区间内最后提交的回复，可能混入插话和其他排队工作。RPC 超时停止等待，但运行时可能继续执行；官方 SDK 尚无独立 runtime cancellation request。close 可以结束所拥有的 Harness 进程，仍不能单凭此证明已经启动的远端 SSH 进程停止。[S02][S44]

因此在外层定义 task_id、worker_id、session_id、remote_job_id 和 context_snapshot_id。每项重要长任务独占 session；同一个手机当前对话另有 session。worker 处理互斥与队列，不以“最后一句assistant文本”判断任务完成。

### 两种 SSH

| 机制 | Harness所在位置 | 主要用途 |
| --- | --- | --- |
| dsh-Go远程主机 | 被连接电脑上运行完整dsh web | 手机继续电脑会话 |
| DSH SSH provider | Harness／模型／Session在Hub，执行世界在远端 | Hub在Mac／服务器运行文件与进程工具 |

SSH 连接失效时动作可能已经发生，不能无条件重放。需固定主机指纹、远端工作目录、runner身份，保存任务句柄与产物索引。[S04][S49]

### dsh-Go 参考范围

可以参考生成中插话、任务过程折叠、主机切换、待审批卡片、重连与原生插件页面。其 Android 本机通过 Ubuntu、Node 与 PRoot 运行 DSH，引擎在手机不代表模型推理也在手机。其语音插件提供播放／打断等能力，前台与主机覆盖有边界；这并非连续摄像头与全双工语音产品的现成内核。[S06][S07][S08]

如果匹配发行包还没有当前 SDK 能力，PoC 应固定一组相容发行版，或明确锁定源码构建；不得以研究到的 master 文档声称 rc.5 安装后已经全部可用。

:::page

## 5 长任务与执行语义

Task 状态包括 queued、running、awaiting_approval、cancelling、succeeded、failed、cancelled、unknown。UI 可将 unknown 细分为连接中断与取消待核实。状态变更是有顺序的持久事件，客户端用 cursor 续传；该 cursor 与动作幂等键不是同一字段。

每个 TaskRequest 包含意图、工作区、截止时间、上下文引用、授权范围和 client_request_id。计划中的每个 ActionRequest 再包含目标、参数、expires_at、grant_id、expected_state_version、reason_evidence_ids。模型不直接生成可执行凭证。

### 动作回执

| 状态 | 含义 | 用户文案 |
| --- | --- | --- |
| accepted | 执行端接收并通过预检查 | 已接收 |
| sent | 已尝试向设备／runner提交 | 已发送，等待反馈 |
| observed | 收到相关状态或进程反馈 | 设备已回报／任务已结束 |
| verified | 满足该能力定义的成功证据 | 已完成，并可查看依据 |
| rejected | 权限、参数或条件不成立 | 未执行，说明原因 |
| failed | 执行端明确返回失败结果 | 执行失败，并说明已发生的变化 |
| unverified | 已提交，但没有充分完成证据 | 已发送，尚未确认完成 |
| unknown | 提交或副作用状态都无法确定 | 结果待核实 |

本地 BLE write 成功只证明数据提交给传输层，不能等同机械到位。构建任务 exit 0 也应检查预期产物存在；文件修改显示 diff 和路径。证据强度在 capability contract 中定义，不能统一用一个 ok:true 代替。

### 取消流程

先在 Task ledger 记录取消请求并撤销后续副作用 grant；执行端立即拒绝新动作。再请求相应 runner 停止，必要时关闭独立 DSH worker。远端任务必须返回 job／进程组终态；不支持可靠停止的远端工具保留 unknown 并查询。清理后读回可能变化的设备／文件，区分已经发生的副作用和未执行步骤。

body.stop 使用手机本地最高优先级路径，不等待 Hub、模型、SDK或网络；运动中撤销lease、停止循环和写stop需要一起发生。手机进程死亡仍取决于固件失联行为，所以软件取消语义不能替代硬件验收。

### 断线与重放

传感器事件以 (source_id, boot_epoch, sequence) 作为唯一身份；content_hash 用于检查同身份重传的一致性，相同身份不同 hash 记冲突并拒绝覆盖。事件允许幂等重试入库；UI 状态事件允许重放；具有物理副作用的命令不因连接恢复自动重放。可证明幂等的 set_state 可以先读回再有限重试，toggle、场景脚本、发布与机器人移动默认不可重放。

:::page

## 6 智能家居接入方案

### 推荐路由

Phone Agent 经 Home Gateway 接入 HA；HA 分别连接 Xiaomi Home、HomeKit Device 和 Matter。可选 HomeKit Bridge 把 HA 实体展示回 Apple Home。手机不需要自己实现所有设备协议，也不需要持有米家密码或每个配件的配对密钥。

| 路线 | 适合什么 | 必须确认 |
| --- | --- | --- |
| HA＋Xiaomi Home | 用户自有HA内的米家设备验证 | 型号、地域、固件、许可、云／本地路径 |
| HA＋HomeKit Device | 原生HAP配件 | 配对码、已有配对迁移、网络发现 |
| HA＋Matter | 支持Matter的配件 | 支持类型、fabric共享、Thread／IPv6网络 |
| iOS原生HomeKit | Apple平台原生家庭界面 | 数据用途与出端条款、用户授权 |
| 米家IoT开发者API | 开发者自有接入硬件 | 不是控制任意消费者家庭的开放入口 |
| 手机UI自动点击 | 个别可见的临时兜底 | 不提供稳定状态订阅，抢占宠物前台 |

HomeKit Device 与 Bridge 方向不同。传统 HAP 配件已有 Apple Home 配对时，HA 文档要求相应移除再配对，之后可经 Bridge 返回；不能承诺保留全部既有场景。Matter 可加入多个 fabric，但不意味着所有米家或HAP设备都具备这种共存能力。[S17][S18][S19]

### 小米的真实边界

官方 ha_xiaomi_home 使用 OAuth，支持若干账号地区，但设备与地区仍需逐项核实；普通蓝牙、红外和虚拟设备不在其通用支持声明中。中央网关可提供一部分本地路径，没有中央网关通常依赖云；旧设备可能仍只向云报告属性，控制与观察是否离线可用需分别测试。[S20][S47]

当前 LICENSE 限制用途，不能直接将其客户端和相关云 API 抽出来开发通用 Phone Agent。通过自有 HA 做个人验证是技术路线建议，商业集成适用范围仍须单独确认。米家公开 IoT 的控制应用文档也限定开发者自己已接入的硬件产品。[S21][S22]

Apple HomeKit Framework 能力属于 Apple 平台。其开发者许可对 API 数据的使用目的与传离设备有约束，不设计“iOS读取整个HomeKit DB，上传跨平台通用记忆”的默认路径。HA 直接从配件取得的状态需记录为不同来源，不能与Apple数据库导出混淆。[S26]

:::page

## 7 家居控制与事件闭环

HA 实际控制通过服务调用完成；POST /api/states 只是改变 HA 内部显示状态，不能控制物理设备。REST 读取实体与服务调用，WebSocket 提供状态订阅与更新。MCP适合工具发现和一次性查询，不能替代持续家庭事件流。[S23][S24][S25]

### 执行步骤

1. 目标解析为允许范围内唯一实体；“那盏灯”有多个候选时询问。
2. 获取 capability、最新状态和新鲜度，校验操作、单位、参数范围和grant。
3. 先建立相关状态观察，再提交明确目标状态并保存action_id与HA context。
4. 等待新状态符合预期；若集成传播context则关联，同时保留时间与来源。
5. 超时转为unverified／unknown；先查询原请求与设备，不立即重复副作用。
6. 逐个实体返回结果，部分失败显示部分完成，补偿动作另受授权。

如果足够新鲜的当前状态已满足目标，直接返回 verified 且 outcome=noop，并保留状态证据；不发送多余命令，也不等待一个未必产生的新状态变化事件。

设备回报与视觉证据分别存储。例如 HA 报灯on，但镜头仍暗，可以是遮挡、曝光或集成状态问题，不让视觉模型直接覆盖设备值。CO₂、温湿度与空气质量只认已接入传感器读数及其时间，不能从画面推算。

### Home Assistant MCP 的现状

官方 MCP 支持 OAuth2＋PKCE。当前新安装默认 Expose all LLM APIs 开启，Require administrator 也开启；PoC应显式选择所需 API 与暴露实体，查看实际工具列表。context-snapshot 是条件可用的静态资源，当前没有 notifications／sampling 支持，连续上下文继续走 WebSocket。[S25]

### 权限设计

产品网关只提供 resolve_targets、get_state、execute_authorized、get_action 等窄接口，不向模型暴露任意 call_service。HA token 保存在网关执行身份下，不出现在提示词、DSH工作区或日志。正式用户授权采用正确的原生授权／PKCE流程；长效token可用于个人POC，不成为默认用户引导。[S43]

家居写操作只通过产品网关；官方 HA MCP 如用于写入，应作为网关下游适配，不再给同一任务配置绕过网关的直接写入 connector。只读工具也遵守相同家庭与实体范围。

Home Registry 为每个能力保存 control_path、observation_path、offline_verified_at、max_state_age、allowed_range。局域网连接并不能证明整个链路本地化。断WAN、断设备、断手机各测一次；家庭常驻规则留在HA，个人Agent产生规则草案并在确认后安装。

:::page

## 8 LOOI BLE 身体与原生控制器

SDK 将 BLE transport 与高层 API 分离，支持 move、startMoveLoop、stop、setHead、setLight、吸附事件和raw写入。应用已提供 react-native-ble-plx transport，README中对通用RN transport的未来说明不应掩盖应用侧已有实现。[S11][S52]

### 能力与不可假设的部分

| 能力 | 已读代码事实 | 产品约束 |
| --- | --- | --- |
| 前后左右与stop | 离散drive payload | 先标方向／脉冲，不表示可控m/s |
| 头部 | up／center／down及字节值 | 只在校准限位内使用；字节不等于角度 |
| 灯光 | 开关 | 不承诺RGB颜色，参数未实现不得暴露 |
| 吸附 | docked／undocked通知 | 连接新建时的初始未知状态不得当已吸附 |
| 运动反馈 | API未提供可验证位姿或里程 | 不提供精确转角、位置到达的虚假回执 |
| 避障／悬崖 | 官方成品宣传有对应能力 | 第三方BLE控制是否继承需真机验证 |

官方LOOI成品强调通过手机感知与表情／身体结合；这为交互提供参照，但其原App动作库、控制策略和安全行为不能据此视为自有SDK能力。[S41]

### BodySupervisor

状态为 disconnected、connected_unarmed、ready、observing、manual、stopping、fault。只有完成底座身份、吸附状态、前台、温度和校准检查后才能进入ready；boot后默认unarmed。每次动作有lease到期、session epoch、最大持续时间和互斥owner。stop可抢占所有动作，新旧任务不能同时写drive。

禁止模型调用raw BLE。模型仅能提出 observe(target, reason, budget) 或离散、已授权的 head pose；原生控制器选择经过校准的命令。参数 clamp、队列上限、超时、错误处理和重连后禁止自动续动作都在本地实现。

### 硬件发布门槛

先在固定机身、轮子悬空的夹具验证停止与失联，再进入受保护测试区验证蓝牙断开、手机进程被杀、JS线程阻塞、手机拿起、底座重启时的机械停止。日志中的“发送stop”不是停止证明，需视频与设备行为记录。若固件无可依赖watchdog或未证明失联停止，则关闭自主轮式转向／平移；头部动作仍需单独验证物理限位与故障行为，必要时使用固定支架，由用户移动物体补充视角。

:::page

## 9 主动感知的具体机制

主动观察由证据缺口触发。例如当前问题要求识别键盘左侧对象，但ROI被遮挡；规划层生成ObservationRequest，包含问题、已看视角、缺失字段、允许区域、最大尝试次数与有效期。BodySupervisor验证后执行短动作，稳定后Capture Service产生新的frame_id和view_id，再重新评估。

### 闭环与停止条件

候选视角价值由预期信息增益、当前任务相关性、时延、能耗、打扰和运动风险共同排序。MVP用规则与阈值即可，暂不建设学习型主动探索策略。只选当前授权动作集合；收益不足、最大次数已用完、设备不ready或用户打断时结束。界面可说“这边还是被挡住了，可以把它移一下吗”。

取帧必须晚于 stop_command_at 加经真机标定的 settling 等待，并通过可用的图像／IMU稳定检测；没有停车遥测时，不能把发送 stop 的时刻命名为已确认 motion_end。稳定画面只支持取帧质量判断，不代替固件故障停车门槛。摄像头曝光变化、运动模糊与相机旋转引发的全局变化应单独标记，防止误判物体消失。没有里程或角度反馈时，pose只记校准动作标签和不确定性。

### 几何与成像

默认前摄朝向用户和桌面；横屏旋转、前摄镜像、相机内参和底座安装偏移需要统一映射。显示的镜像画面不能直接当空间左右依据，VLM输入与UI证据应共享规范化方向标记。LOOI头部主要提供俯仰，左右观察通常涉及底座轮式转向，不能描述成具有独立pan云台。

不把单目短时观察当作SLAM、毫米级坐标或物体永久性。优先使用“键盘左侧／屏幕前方”等带参考物和时间的关系；镜头移动后重新确认参考物。用户指出的对象与视觉track关联失败时保留歧义。

### 防止自激活

TTS、电机动作、姿态变化、自动开灯都会产生新的声音和画面变化。这些动作生成self_event并有短暂refractory窗口；同一动作产生的观察不能再次启动相同动作。冷却时间、动作预算与反复证据去重共同阻止“看见变化→转头→再看见变化”的循环。

[[PERCEPTION]]

:::page

## 10 音频与视觉上下文管线

### 音频

手机Audio Session Manager管理采样、AudioFocus、设备路由、AEC和NS；本地KWS／VAD快速决定唤醒与打断，ASR产生带时间的转写。已有sherpa-onnx接口可继续验证，不必同时更换全部语音组件。AEC能力因设备而异，不能仅通过API存在推断回声已消除。[S42]

即时对话和背景观察是两条消费者：对话低时延、可打断；背景观察按用户开启的模式分段整理。自己的TTS打上来源，电视与访客默认speaker_unknown。Diarization只聚类说话人，不能代替主人认证；敏感执行使用当前明确操作与本地确认。

语音打断首先停止TTS，随后发送speech_interrupted；取消工作任务是另一个明确动作。这样用户插话不会误杀构建任务，用户说“停止机器人”也不会只关闭动画。来电或音频路由切换先释放资源，恢复时检查授权与当前模式，不自行重新打开被关闭的麦克风。

### 视觉

初始本地轻量分析可从低分辨率5fps开始测量，而模型理解按事件调用。帧新鲜度、模糊、曝光、遮挡、运动状态与区域掩码先过滤；对值得保留的变化形成前／中／后少量证据。关键帧可配短burst，快速放置事件不能仅靠每30秒一帧发现。

RAM环有硬容量，不同相机分辨率下按字节退化；队列满时丢弃冗余低优先级观察并记录gap。用户明确“记住”优先于背景候选。网络中断时只保存获准且有界的片段，恢复后上传过期检查；不把新收到时间当作实际发生时间。

### 模型路由

| 任务 | 默认位置 | 输入与失败处理 |
| --- | --- | --- |
| VAD／KWS／停止 | 手机 | 不依赖联网；低时延 |
| ASR | 已有本地方案优先，授权云可选 | 分段文本＋时间；保留识别不确定 |
| 视觉事件提取 | Hub编排，调用已授权VLM服务 | 少量选帧；仅实际加载本地模型时标本地推理 |
| 日常短答 | 低时延route | 当前对话＋少量可用记忆 |
| 复杂任务规划 | DSH所配置模型 | task限定context pack与工具 |
| 记忆整理 | 异步小批量worker | schema约束；失败不阻塞语音 |

模型名称与大小由实测质量、中文能力、延迟和预算选择。Hub 运行 DSH 不代表 Hub 本地运行大模型，离线推理能力逐路声明。Harness品牌、SDK图片传输与模型实时视听能力是三个不同层级。[S02][S05]

:::page

## 11 参考 Screenpipe 内部实现的手机上下文引擎

本节研究它如何把连续输入组织成可检索上下文。研究对象是固定提交中的 Rust／SQL 内部实现；Phone Agent 自行实现等价的模块职责，不安装或调用 Screenpipe，不读取它的数据库。其桌面输入来自屏幕、音频与可用 UI 结构，而本产品的核心输入来自手机摄像头、麦克风和家居状态。[S29]

### 11.1 事件触发与采集调度

源码 event_driven_capture.rs 使用窗口／输入事件、视觉变化及 idle 回退决定何时采集。可借鉴的是“触发、限频、合并与低频补查”的调度方式，桌面的点击事件、间隔和变化阈值不能直接套给相机。[S30]

手机端拟建 ContextTriggerBus：接收用户明确记住、VAD语句边界、可见物体变化、家居事件和主动观察完成后的取帧请求。每个触发携带原因、时间窗口、优先级和有效期。短时间同一事件可合并，用户明确请求优先；低频补查只检查采集活性与候选变化，不强制形成长期记忆。采集、保存与模型调用分别限频，队列只保留有界工作量。

### 11.2 成对证据与时间关联

paired_capture.rs 关联同一时段截图与 accessibility tree，使用结构化信息及 OCR 路径，并处理两者不一致的情况。它通过 hash、simhash、内容引用和缓存减少冗余。关键是保留“这份结构来自哪次观察”，而非脱离截图保存一段孤立文本。[S31]

手机端拟建 EvidenceAssembler：围绕语音或观察事件，选择前／中／后的少量源帧，绑定音频区间、相机方向、view_id和有时间的设备状态。按采集时间关联，保留每个源的 boot_epoch、单调时间与时钟误差；不把上传时间当成发生时间。缺帧、不同步和无法覆盖的时段显式记为gap。多个模态的源根独立保留，时间接近不代表内容一定相关。

### 11.3 去重应减少处理，不应擦掉变化

手机端需要区分三层：同事件身份的重传去重；同媒体字节的存储复用；近似视觉内容的模型调用抑制。前两层可用确定性键或哈希，第三层是有误差的策略，必须保留原观察时间和选择原因。画面大部分相同，仍可能发生小物体移动；相似度不足以证明“没有发生事件”。

主动调整视角、自身灯光改变、运动模糊和前摄曝光变化，都要随候选帧携带来源标记。新视角即使视觉相似，也不能被简单丢掉；重复模型描述不能增加独立支持次数。Screenpipe 的桌面去重机制提供设计参照，手机端的视觉阈值、ROI和运动处理需要独立测量。[S31]

### 11.4 从原始证据投影到结构化事件

screenpipe-semantic 将 UI 结构转换为 conversation、message、document、task、calendar_event、page 等对象，保留 stable／derived／ephemeral 身份、解析run、规范化对象版本与源节点关联。借鉴点是观察、解析结果与实体身份分离，以及解析过程可追溯。[S32][S33]

手机端对应的语义对象由本项目定义，例如 utterance、object_observation、placement_event、activity_hint、task_reference、room_state。语义解析保存 parser/model version、输入证据IDs和输出版本；重新解析追加修订，不覆盖旧证据。视觉track只是暂时关联，不能直接成为永久物品身份；活动线索也不能自动成为用户长期偏好。MemoryClaim 的确认、纠错与有效期由下一层记忆服务负责。

### 11.5 音频分块、重叠与归属

handle_new_transcript.rs 对重叠转写按设备维护先前片段，并检查实际时间重叠再去重。这比全局按相似句子去重更贴近采集事实。[S34]

手机端拟建 AudioSegmenter：按VAD与最大时长产生带起止时间的片段；需要跨块上下文时保留有限重叠，按同一输入源、真实时间重叠和文本边界合并。保留 provisional／final 与修订状态，避免把中途改口提早定为事实。自己TTS的播放区间单独标记；说话人分离只产生候选speaker，不授予owner身份。

### 11.6 检索保留结构与证据回指

Screenpipe 的搜索实现结合结构化过滤、SQLite FTS5与语义记录，提供了“时间／来源／文本联合查询”的参照。[S35]

本项目在既有 Postgres／pgvector 上实现 ContextQuery，手机保留有界本地缓存，不复制 Screenpipe 的 SQLite schema。查询先限定身份、项目、来源和时间，再做全文／语义召回，最后回取支持证据、修订与新鲜度。中文分词与别名召回独立验证。送入 Harness 的 context pack 只含当前目标需要的短事实和证据引用；不把完整音视频或未经确认的活动推断装入所有任务。

### 11.7 具体模块边界与验收

以下为自主实现的模块，不是 Screenpipe 提供的接口。

| 模块 | 输入 → 输出 | 核心约束 |
| --- | --- | --- |
| ContextTriggerBus | 语音／视觉／家居触发 → 候选时间窗 | 合并、限频、优先级、TTL |
| EvidenceAssembler | 时间窗＋源缓存 → evidence bundle | 源时间、view_id、gap、各自源根 |
| NoveltyGate | 候选帧＋既有指纹 → 保留／复用／跳过理由 | 保留小变化与明确请求；新视角单独评估 |
| AudioSegmenter | 带时间音频 → 转写片段与修订 | 只清理真正重叠；保留否定与改口 |
| SemanticProjector | 证据bundle → 结构化事件与parse run | 来源回指、版本化、未知主体 |
| ContextQuery | 授权查询 → 证据支持的context pack | 先过滤，再检索；删除与到期可见 |

在既有48条场景中重点检查：B04同源派生只计一次；B05改口形成一项最终意图；A03遮挡不生成物体被移走；C03自身TTS不自触发；D03删除后迟到解析不能写回；F06重启重传不重复生成事件。管线补充记录漏事件、重复事件、时间错配、无依据语义、模型调用量和处理延迟，以评估机制迁移效果。

桌面 AX 树、屏幕文字、窗口焦点均有平台提供的结构；真实相机画面没有这层确定结构。手机方案因此仍需视觉理解、临时关联和不确定性管理。主动看、空间关系、身份认证与长期记忆治理是本项目新增的职责，不能声称由 Screenpipe 的内部机制自动提供。

:::page

## 12 记忆系统的数据层

持续采集、长期记忆和对话压缩分别处理。第一层回答“当时有什么证据”，第二层回答“现在可以相信什么”，第三层决定“当前模型窗口放什么”。这三者共享来源ID，不能互相替代。

| 对象 | 内容 | 权威与更新方式 |
| --- | --- | --- |
| EvidenceEvent | 源帧／音频／App结构化记录／家居事件 | 尽量不可变，允许受控删除与到期 |
| Episode | 同一事件的时段与相关证据 | 版本化分组，保留拆分／合并来源 |
| MemoryClaim | 偏好、关系、物品最后位置等 | 状态、有效期、主体和证据；可修订 |
| WorkingState | 当前模式、会话、人／空间、待处理事项 | 短TTL，优先实时读取 |
| Procedure | 已验证流程与偏好参数 | 有版本与适用范围，每次重新授权 |
| TaskLedger | 目标、步骤、授权、动作、产物 | 执行回执驱动，不由摘要推断完成 |

### 必要字段

EventEnvelope至少包含event_id、household_id、subject_id可空、source_device_id、boot_epoch、sequence、observed_at、monotonic时间、received_at、time_uncertainty、source_kind、evidence_refs、parser_version、privacy_scope、retention_policy。记录上传时间不能覆盖发生时间。

MemoryClaim至少包含predicate、object、status、source_kind、evidence_ids、derivation_roots、valid_from／to、recorded_at、revised_at、expires_at、sensitivity和acl_policy_id。双时间轴区分现实何时适用与系统何时获知；timestamp本身不证明内容正确。[S39]

### 状态与晋升

用户明确且归属可信的陈述可形成confirmed事实，但“今晚暗一点”只作用于今晚。环境观察先为candidate或inferred；多个独立episode能支持模式，长期偏好仍通过轻量确认。物品位置存object_last_seen，传感器读数存短期状态，不能直接晋升为个性判断。

同一原始证据的 ASR、视觉描述或摘要共享对应 derivation root；同一 episode 的音频与相机证据保留各自源根与共同 episode_id。相关模态和重复派生不能自动计成多次独立经历，重复帧也不能“投票”成高置信度。对错人、事实变化、时间范围不同和识别错误分别修订，而非简单最新覆盖。

[[MEMORY]]

:::page

## 13 检索与对话上下文

先从认证、任务和用户授权确定household／subject／project／source／time范围，再检索当前状态、时间邻近episode、全文和向量。ACL与删除过滤必须先于内容进入模型；不能先召回所有私密数据，再让模型决定哪些可见。

Top候选回取证据、前后文与修订状态，去除同根重复、已否定和失效事实；RRF或reranker只负责排序。中文检索单测物品别名、时间表达、错别字与中英文项目名，不能把默认英文分词能力当成中文召回保证。[S51]

Context pack建议由当前目标、最近明确发言、实时状态、相关事实及其来源、待办／承诺和必要附件引用组成。家庭全量照片不随任务默认发送；工作任务只获得对应项目和时间片段。每个pack记录manifest，支持追踪哪些记忆进入了哪个session。

### Mem0 的角色

当前Mem0＋pgvector继续做语义索引与候选召回；SQL账本掌握主体、来源、版本、删除和权限。原有disableHistory:true与固定owner-1反映原型阶段，不通过简单开关修复审计和多用户隔离。legacy记录无法恢复来源时明确标记。[S15]

### Mastra Observational Memory

OM用Observer提取观察、Reflector压缩已有观察，解决长对话上下文增长；可按模型能力处理附件。它不替代相机采样、空间理解和证据治理。当前官方文档将OM的resource scope标deprecated，推荐thread scope；跨对话连续性使用资源范围working memory与检索。[S37][S38]

本项目不为OM替换DSH。第一版使用DSH已有compaction管理任务上下文，另做结构化事实检索；若基准发现压缩丢失承诺、否定与时序，再把可替换Observer／Reflector worker接入。80字摘要只用于会话预览，不作为唯一长期知识层。[S03][S16]

### 记忆不是权限

所有检索结果和环境文本作为不可信data注入。即使过去偏好被confirmed，也不转成system级指令或新的grant。工具调用仍经过确定性执行端校验；纸条上的“忽略限制”、电视播报或网页中的命令不能通过长期记忆洗成授权。[S40]

:::page

## 14 删除与留存的完整语义

原始媒体自动到期与用户主动删除分开。经明确授权独立保留的摘要可在原始媒体到期后存在，标注source_expired；不能展示不存在的原图。用户选择删除源片段及派生内容时，追踪derivation roots删除或重算所有依赖。

### 删除流程

1. 原子写入删除墓碑与新的privacy_epoch；查询立即不可见。
2. 取消相关ASR／VLM／summary／embedding作业；在写回端再次校验epoch，拒绝迟到结果。
3. 删除本地媒体、Hub媒体与索引，修订claim与episode，清理缓存和context manifest。
4. 找到DSH持久附件与session副本。已使用受删内容的活跃session关闭或重建干净上下文，不能仅在最后追加“忘记”。
5. 备份恢复先应用删除日志；外部服务按其实际能力请求删除并显示状态，不能承诺远程已接收数据必然即时消失。
6. 用户看到完成范围、剩余待处理项和结果；审计只留最少事件，不在删除日志重抄敏感原文。

忘记一条推断不必删除全部源片段，但要抑制同一推断被后台再次自动生成；删除某段原始数据默认影响其派生内容。两者在UI分别命名，避免用户误解。

### 身份与权限

设备配对生成稳定身份，owner由认证系统确定而非模型文本。访客和未识别说话人保持未知主体，不自动写入owner画像。家庭、个人、工作项目和第三方connector分别授权；grant包含目标、操作、参数、期限和触发上下文。

凭证进入Keychain／Keystore或Hub受限存储，不进入LLM上下文。原始媒体按设备／家庭分离加密，导出与备份有范围选择。关闭Camera／Mic要释放实际采集资源和清空易失环；指示器依采集回调显示，不能只改一个页面开关。

## 15 App 与桌面扩展

Connector contract包含发现、鉴权、可用性、读取、动作、回读与撤销。优先API／MCP和系统开放接口，UI自动化单列为前台、可中断、能力有限的执行类型。付款、账号凭证等不混入一般自动化工具列表。

工作区由用户明确选定，或通过获授权的App接口／项目插件提供当前项目、文档与任务状态；SSH负责读取实际工作目录并执行任务。手机摄像头与语音提供现实讨论的上下文，使用project_id、用户指代确认和源时间关联到工作任务。这里不引入 Screenpipe 运行时或持续桌面录制；App连接与SSH仍作为独立生产力扩展。仅因环境中出现相似词不能自动确定工作项目。

:::page

## 16 传输协议与可观测性

建议保留现有WebSocket设备通道并升级为有版本的产品协议。手机主动建立带认证的连接；注册能力时提供schema、实际可用状态、最近验证时间和能力限制。工具schema存在但executor未实现时，不允许被发现为可用。

| 消息 | 关键字段 | 处理规则 |
| --- | --- | --- |
| context.event | source_id、boot_epoch、seq、observed_at、refs | 可重试入库，去重、时钟误差保留 |
| task.submit | task_id、client_request_id、context_snapshot、workspace | 持久接收后才确认 |
| task.event | task_id、event_seq、state、artifact_refs | 按cursor恢复，缺口触发快照 |
| action.request | action_id、grant、target、expires_at、expected_version | 执行前再次验证权限与条件 |
| action.receipt | action_id、status、observed_at、evidence | 不把sent改名为verified |
| body.stop | local reason、lease_epoch | 原生立即抢占，再异步记录 |
| privacy.change | new_epoch、affected_scopes、capture_mode、retention | 暂停感知使对应旧采集作业与自主身体grant失效 |
| ui.navigate | destination、originating_user_event | 只接受当前用户导航，不由task状态自动触发 |

架构允许同一传输重发但不承诺跨所有物理设备exactly-once。对outbox、in-flight与terminal结果分别记录，避免执行中重复；重启后只恢复状态观察和未完成处理，身体动作不自动恢复。

privacy_epoch 按作用域校验，并区分采集暂停代次与证据删除代次。隐私暂停不自动撤销独立工作任务的有效授权；工作任务仅在用户明确撤销、授权到期或所依赖证据被主动删除时停止／重建上下文。暂停后不为旧感知作业创建新的持久记忆，也不向仍在执行的工作任务补充新的环境输入。

观测trace串联capture、ASR、episode、claim、context pack、task、action和receipt。日志默认记录耗时、数量、错误码与ID，敏感媒体和全文不进入普通telemetry。关键指标分别统计语音响应、VLM事件延迟、记忆正确性、动作验证率和取消不确定比例，不能用一项“请求成功率”代表整体。

### 测试策略

固定版本做协议契约测试；用可控的假设备注入重复、乱序、超时与断线；最终使用实际设备验证物理行为。测试要覆盖关键风险，不为每个UI颜色写机械重复测试。软件mock不能证明固件停车、热稳定或家居离线可用。

:::page

## 17 存储与模型调用预算

下表是明确参数下的算式，均按每天dock 16小时、十进制MB／GB，不是实测，也不是厂商报价。实际JPEG大小、语音占空比和模型图像计费随设备与服务改变。

| 假设 | 日量 |
| --- | --- |
| PCM16、16kHz、单声道全部留存 | 16,000×2×57,600 = 1.8432GB |
| Opus 24kbps全部留存 | 24,000÷8×57,600 = 172.8MB |
| 上述音频仅15%语音片段 | 25.92MB；ASR 144分钟 |
| 120KB JPEG，每30秒一帧 | 1,920帧，230.4MB |
| 120KB JPEG，0.2fps | 11,520帧，1.3824GB |
| 120KB JPEG，1fps | 57,600帧，6.912GB |
| 每天80个事件，每事件3张120KB源帧 | 240帧，28.8MB |

事件方案的80次是容量规划样例，不是可靠性结论。快速事件必须通过本地分析与环形缓存捕获；降低保存量不能通过漏掉事件实现。80个10秒音频证据在24kbps下约2.4MB，但若背景ASR处理全部15%语音，转写仍有144分钟，两种预算不可混同。

### 计算费用的方法

日费用 = ASR分钟数×转写单价 + VLM实际计费单位×视觉单价 + 输入token与输出token分别计费 + TTS字数／音频量费用 + 存储与必要网络。不同供应商图像按分辨率、切片或token计费，不能假设每张图固定价格。

例如假设每张图折算800输入token，57,600张相当于46.08M视觉输入token；240张为0.192M，均未包含提示词和输出。这仅说明事件筛选对调用量的量级影响，不能直接转换成当前模型价格或质量提升。

### 资源与热预算

原始音频30秒PCM环约0.96MB；相机环起始20MB上限，实际还需计入解码帧、模型与相机驱动内存。相机、ASR、TTS、BLE、动画和充电并行时，以实机温度、CPU、RAM与电池充电净变化为准。若额外持续功耗为P瓦，16小时耗能为16P Wh；不能用手机在充电推断没有热限制。

预算耗尽或热状态升级时依次减少背景VLM、暂停主动动作、降低分析／保留频率；保留语音停止与当前明确交互。将轻量分析、保存、云上传和模型调用分别计量，避免一个“帧率设置”影响全部功能。

:::page

## 18 评测与实机验收

### 对照组

A为纯当前对话；B增加显式记忆；C增加被动多模态事件；D在C上增加有限主动观察。使用相同任务、模型与预算，比较证据正确率、时间／主体归属、补充说明次数、完成率、延迟、打扰和资源。主动观察只有在D比C获得额外可验证信息时才算收益。

### 必过门槛

| Gate | 验证内容 | 不通过时 |
| --- | --- | --- |
| 平台并发 | 真机2小时再8小时，相机／语音／BLE／动画 | 收敛采集与动画，保留主动交互 |
| 身体故障 | 蓝牙断开、进程死亡、离座、限位 | 禁自主轮式动作，必要时固定机位 |
| 家居闭环 | 至少灯／通风／传感器各50次、断WAN | 只公布已验证型号和路径 |
| 记忆正确性 | 否定、错人、过期、冲突、同根去重 | 降为显式记忆，停止自动晋升 |
| 删除 | in-flight回写、索引、summary、DSH副本、备份 | 不扩大持续保存 |
| 任务可靠性 | 插话、超时、取消、远端未停、重连 | 单任务、只读或明确显示unknown |
| 权限隔离 | 恶意环境文本、越界实体／目录、撤权 | 停用对应执行能力 |
| 分发 | SDK版本、目标平台、许可和美术范围 | 保持私人原型或调整集成 |

LongMemEval可借鉴跨会话抽取、更新、时序与拒答评测，但不能直接代表摄像头、语音或机器人能力。本项目另外提供48条具体回归场景，覆盖物理世界的不完整观察和执行副作用。[S54]

### 七天日用

前两天只记录shadow候选和用户主动请求；中间三天开启有限背景记忆与提醒；最后两天开启已通过安全门槛的主动观察。每天回看误记、无用提示、漏事件与任务结果，不将沉默计为满意。样本规模只支持个人alpha判断，所有体验指标标注样本量和失败例。

## 19 实施拆分与架构决策

| 决策 | 原因 | 接受的代价与约束 |
| --- | --- | --- |
| ADR01 保留RN与现有后端 | 复用现有BLE、语音、界面与数据路径 | 相机／音频／身体生命周期仍需原生模块 |
| ADR02 DSH先部署Hub | 控制依赖、资源与长任务恢复 | 需要常开节点；模型路由单独配置 |
| ADR03 家居经HA | 复用设备协议与确定性自动化 | 配对、设备型号及许可分别验证 |
| ADR04 自有记忆ledger | 统一来源、修订、删除与权限 | 增加SQL schema，Mem0只作检索适配 |
| ADR05 身体能力经硬件gate | 当前SDK不足以证明停车或到位 | 未通过的执行器禁用，保留固定视角 |
| ADR06 导航由用户意图控制 | 保持宠物驻留与可预测的交互 | 后台任务仅轻量提示，详情需用户进入 |

前三个可交付里程碑为：可信语音＋一次源帧记忆；一盏灯的授权设置与回读；一个远程项目的任务、产物与可靠取消状态。其后扩大到事件感知、偏好晋升与有限主动看。单一设备组合的私人日用 alpha 暂按12到16周规划，G0 后重新估算；这是已有代码基础上的工作量估计。固件 watchdog 缺失和上游许可授权属于外部阻塞，不能假设会在兼容缓冲期内解决。

### 首轮工程任务与完成定义

下列模块名为建议新增边界，不声称上游已存在。接口草案及 mock 数据见 protocol_contracts.ts 与 protocol_examples.json。

| 工程包 | 最小改动 | 完成证据 |
| --- | --- | --- |
| Capture／Body原生模块 | 统一音频拥有者、帧时间与有界动作租约 | 故障视频＋trace；2小时并发记录 |
| Memory ledger | event／claim／revision／derivation／tombstone表 | 一次记住、一次纠错、删除后迟到写回被拒绝 |
| Task Supervisor | 独立worker、事件cursor、持久job ID与取消协议 | 断开再连接不重复构建；停止状态有证据 |
| Home Gateway | 限定实体、目标状态、订阅与回读 | 灯的成功、no-op、失联与部分失败均如实显示 |
| Interaction Shell | 宠物状态、用户导航、记忆证据与任务审批 | 15个设计状态可切换；后台完成不抢页面 |

开发顺序先打通同一条纵向流程，再横向增加设备与事件种类。每天可演示的样例是“明确记住当下画面→从证据回答→调用一个受限动作→检查结果”；不能把UI、模型与硬件分别跑通视为整体完成。

### 待实物确认清单

LOOI固件失联停车、头部限位、吸附通知初始值；用户手机Android16的热与后台行为；家居model ID／区域／网关；工作Mac是否常开；DSH实际可安装匹配SDK版本；拟公开／商业分发范围。这些是影响方案的真实未知项，不能用增加提示词或UI状态掩盖。

:::sources
