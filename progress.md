## 待核实任务人工审阅（2026-11-12）

- [x] Step 1：核对任务恢复、会话阻塞和横屏任务入口，确定人工审阅只解除提醒及阻塞并保留执行结果。
- [x] Step 2：持久化人工审阅时间，统一待审阅计数、任务排序与会话继续条件。
  - [x] 接通运行时与 App store，审阅后同步首页提示和任务列表。
  - [x] 在任务详情提供“已人工审阅”按钮与审阅时间，首页提醒可直接进入任务。
- [x] Step 3：验证重启后不再提醒、可继续原对话、原始失败与回执仍可查看。
  - [x] 7 项执行器回归、完整 App 中英文横屏人工审阅回归通过；NSH check/build 通过。
  - [x] 完整 App TypeScript 检查通过；未连接开发真机，实机验收见 todo.md。
  - [x] 独立 review 通过；修正旧会话先发送后审阅的提示清理，隔离提交本轮变更。

# Super-LOOI 重构与演进进度

## 底座与智能家居语义分离（2026-11-12）

- [x] Step 1：核对截图对应的工具与会话记录，确认错误归因来源。
  - [x] 家居执行链与 BodyRuntime 无依赖；实时语音仅直接暴露底座工具，家居需经 run_agent_task。
  - [x] 查询 Langfuse 已结束会话：13:21 家居工具独立关闭大厅台灯并回读 off；未找到截图回复的完整追踪，不能断言当时具体误调了哪个工具。
- [x] Step 2：明确语音与任务 Agent 的领域边界和工具用途。
  - [x] 台灯／家电经家居服务控制，底座补光灯与运动经 BLE 控制。
  - [x] App 内共用领域说明；语音经 run_agent_task 委派家居，任务 Agent 只在用户要求控制时调用 control_home_device，保留真实失败原因。
- [x] Step 3：完成针对性验证、独立 review 与隔离提交。
  - [x] 语音与底座运行时回归、4 项家居错误回执回归、3 项任务会话回归通过；补充任务系统提示词经公开配置注入模型的验证。
  - [x] Runtime 构建、App 运行时类型检查及生产运行时打包通过。
  - [x] 使用配置的 GPT-4o 做工具选择评估：底座断连仍委派大厅台灯、卧室灯走家居、自己的补光灯走底座、歧义“开灯”先询问；未操作真实设备。
  - [x] GPT-4o 补充评估：纠正底座断连导致台灯失败的错误归因；修正失败转述省略错误码的问题，write／503 复测按“米家写入阶段错误码 503，指令未确认受理”回答。
  - [x] 独立 review 发现并修复只读查询误导为控制、公开类型缺少 systemPrompt 两项问题，复审通过。

### 家居控制底层错误透传（2026-11-12）

- [x] Step 1：核对大厅台灯执行证据与失败分支
  - [x] 确认 `turn_on / brightness:255` 参数正确，265 ms 返回的回执不足以区分发送失败和回读失败
  - [x] 确认协议层、MIoT transport 和网关存在错误信息丢失
- [x] Step 2：复现错误分类缺陷并实现修复
  - [x] 保留 HTTP 状态、米家返回码与逐属性失败结果；按小米官方实现接受写入返回码 0／1
  - [x] 回执区分发送、回读、结果不匹配与真实等待超时，保留网络原因和实际回读，应用连接与批量读取携带来源错误
  - [x] 在 `AGENTS.md` 写入底层错误传播要求
- [x] Step 3：验证、独立 review 与提交
  - [x] 定向回归先失败后通过；home-assistant 61 项、contracts 5 项、应用侧家居 23 项回归通过
  - [x] 首轮 6 项故障回放从失败转为通过；独立审查修正无关色温错误影响亮度／开关确认的问题
  - [x] NSH 类型检查、完整应用构建、真实 QuickJS 原生宿主验证通过
  - [x] 独立复核通过，修正旧请求覆盖新连接来源状态及单来源回读错误丢失；真机复测项记入 `todo.md`
  - [x] 规则与结构化错误接口隔离提交 `d9f7ee1`
  - [x] 隔离提交本次改动；额外用排除既有工作区变更的代码快照验证类型检查与 33 项定向回归

### Pi 标准运行时与生态接入（2026-11-12）

- [x] Step 1：核对官方 SDK 与现有任务、凭据、工具和兼容层，确定职责与迁移方案
  - [x] 采用 `createAgentSession`、标准资源加载器与官方扩展入口，计划见 `docs/plans/pi-ecosystem-runtime-plan.md`
- [x] Step 2：迁移 AgentSession、模型访问、审批、观测与完成语义
  - [x] 使用官方 SDK，会话消息、压缩、重试和排队由 Pi 管理；标准扩展命令按官方处理结果完成
  - [x] 覆盖启动取消和扩展关闭，将原生确认对话、通知及 Shell 回执接到 Pi 接口
- [x] Step 3：接通标准工具、Skills、规则、模板、扩展、MCP 和消息队列
  - [x] 使用标准 read/write/edit 与宿主 BashOperations；接通官方 MCP、tool_search 和 codemode 扩展
  - [x] 语音 manage_agent_task 支持 steer / follow_up；App 凭据和 Pi 目录归手机自身持有
- [x] Step 4：完成自动化验证、独立 review、架构说明与隔离提交
  - [x] Runtime 104 项、语音队列回归及真实 Rust QuickJS 的 node-shims／looi-runtime／looi-ecosystem／mobile-runtime／pi-sdk 通过
  - [x] 原生生态专项覆盖资源加载、扩展、codemode 嵌套工具、压缩摘要恢复和 MCP OAuth 刷新保存
  - [x] Runtime／兼容包构建、NSH 类型检查及 App 构建通过；独立复核发现均修复
  - [x] 更新 `docs/pi-runtime.md`、研究结论及架构页面；分阶段提交 `70b32a3`、`58714f5`、`b5e0a20`
  - [ ] 真机横屏安装验收；ADB／devicectl 无连接真机，MCP 首次登录界面与回调接线另记 todo

### QuickJS stream/promises（2026-11-12）

- [x] Step 1：核对 stream 垫片、打包别名与 Node Promise API
  - [x] 确认缺失模块映射及流完成／错误状态，复用现有事件与文件流
- [x] Step 2：补齐 pipeline、finished 与必要的流生命周期状态
  - [x] 支持两种模块导入、完成等待、错误传播、取消和背压
- [x] Step 3：QuickJS 回归、类型检查、独立 review 与隔离提交
  - [x] 在真实 QuickJS 验证文件传输、转换链、完成／失败及取消；类型检查和包构建通过
  - [x] 修正独立审查发现的提前返回、resume 与终点早关问题，QuickJS 专项和完整兼容层回归通过
  - [x] 子 agent 复核通过，隔离提交本次改动；原有 Node 导出检查的原生模块解析问题记入 todo.md

### Pi SessionManager 接入（2026-11-12）

- [x] Step 1：核对 Pi 1.5.0 的会话 API、消息事件和 NSH 构建边界
  - [x] 采用 SessionManager 原生 JSONL；旧 JSON 不读取、不迁移
  - [x] 删除自定义会话存储类，单任务执行器直接持有本轮 SessionManager
- [x] Step 2：实现消息级持久化与恢复
  - [x] 新建／按 ID 重开会话，恢复活动分支上下文
  - [x] 用户、模型与工具消息结束即追加，失败和取消保留已结束消息
  - [x] 声明直接依赖，接通 QuickJS 验证构建
- [x] Step 3：验证、独立 review 与提交
  - [x] 覆盖重启、多轮、执行中检查点、失败／取消及旧格式断开；runtime 89 项回归通过
  - [x] runtime 89 项、独立定向 11 项通过；runtime／compat／NSH 类型检查、NSH 完整构建与 QuickJS 两组验证通过
  - [x] 独立 review 无待修复问题，同步架构说明与源码快照，实现提交 `97a3270`，文档单独提交

### 任务真实链路与本地 Trace（2026-11-12）

- [x] Step 1：追踪任务、语音、Langfuse 和审计 UI 的数据边界
  - [x] 确认历史消息进入模型输入，现有 steps 未保存参数／回执且重复使用轮次作为行 key
  - [x] 采用同源 observation 本地持久化与 Langfuse 导出，复用 SQLite 与现有父子 span
- [x] Step 2：本地记录真实执行数据
  - [x] 保存 observation 开始／完成、父子关系、输入／输出与错误，独立于远程配置
  - [x] 关联任务根节点，记录历史上下文、模型请求、搜索动作、本地工具与交互
  - [x] 连接语音委派及结果回传，任务详情实时更新
- [x] Step 3：实现横屏链路检查界面
  - [x] 紧凑任务列表与可展开执行树，区分模型请求、工具回执和最终回答
  - [x] 展示模型输入、搜索词、工具参数／输出、耗时、错误与原始数据
  - [x] 旧记录明确缺失，不重建事实；覆盖中英文与稳定节点身份
- [x] Step 4：验证、独立 review 与交付
  - [x] 后台包 83 项回归通过，覆盖历史上下文＋搜索、多工具父子链、本地独立记录、重启读取、失败及跨连接播报
  - [x] 独立 review 修正跨连接播报脱链、语音／模型取消标记，阶段提交后端 5586616
  - [x] 后台构建、NSH 类型检查与原生编译通过；844×390 原生 headless 测试覆盖任务选择、关闭／重选、展开与工具实时更新
  - [x] QuickJS 原生宿主通过本地 observation 的 SQLite 写入和重启读取，修复本地模式初始化引用全局 fetch
  - [x] 独立复核修正真实 provider error、取消应答误报；定向回归通过，隔离提交本轮实现并同步架构页／源码快照
- [ ] Step 5：开发真机横屏验收；当前 iOS 与 ADB 均无连接设备，具体用例记入 todo.md

### Voice Agent 只读工具与自然委派对齐（2026-11-12）

- [x] Step 1：追踪语音工具、后台执行、全局任务 UI 与会话归属
  - [x] 确认 2.5 秒快路径等待、Store 全局 busy 与首页停止按钮的接线
  - [x] 确认麦克风采集独立运行，执行任务复用前台 conversationId
- [x] Step 2：调研实时语音直接调用工具与异步交付的一手实践
  - [x] 核对 OpenAI Realtime、LiveKit、Pipecat 的工具执行与会话生命周期
  - [x] 区分只读 shell 的能力范围、手机宿主接入成本与已有工具复用点
  - [x] 完成研究文档及独立 review，补充共享 busy 的调用方与跨会话通知现状
- [x] Step 3：对齐本次最小改动
  - [x] 用户确认后台 LLM 按温热窗口复用上下文，只读查询覆盖文件／环境和 App 数据，整体移除右下角停止任务按钮
  - [x] 核对逻辑会话与连接／缓存的区别，采用 15 分钟滑动空闲窗口
- [x] Step 4：实现自然委派与短交流间的结果交付
  - [x] 立即回传受理，移除 2.5 秒快路径及其双重结果分支
  - [x] 保留执行占用，解除语音任务与前台进度／回复呈现的绑定；删除首页停止任务按钮
  - [x] 后台 LLM 使用独立于文字会话的温热上下文，交流续期、运行中保留
  - [x] 待机时完成或会话结束前尚未发送的结果保留到下一次语音连接投递
- [x] Step 5：定向回归、类型检查、构建与独立 review
  - [x] 语音全套回归通过，覆盖立即受理、空闲交付、取消、跨连接通知及温热窗口；类型检查与构建通过
  - [x] 独立 review 复现并修复未发送通知随旧连接释放而丢失的问题，复核与回归通过
  - [x] 同步架构页和源码入口，隔离提交本次改动
- [ ] Step 6：真机横屏验收；iOS 与 ADB 设备列表均为空，具体用例记入 todo.md

### Agent 架构微步骤拆解（2026-11-11）

- [x] Step 1：读取《查找 Agent 架构规划》，核对用户确定的调用关系
  - [x] 固定语音主 Agent → 唯一持久协调 Agent → 独立任务 Agent 的主链
  - [x] 确认观察、目标跟进和反馈由同一协调 Agent 承担
- [x] Step 2：对照现有任务执行、会话保存与语音回流代码，编写微步骤计划
  - [x] 标明已有能力、需要新增的边界及各步前置条件
  - [x] 每步只引入一个可验证的行为，先形成单任务闭环
- [x] Step 3：独立审查拆分粒度与依赖，整理待办并提交规划文档
  - [x] 由子 agent 审查能力覆盖、步骤粒度与依赖；按意见细分为 8 轮、56 步
  - [x] 补齐家居状态采集、异步查询、播放状态与双向纠正的依赖，更新 todo.md
  - [x] 隔离提交本次文档


### 实时语音转写重复与文字越界修复（2026-11-11）

- [x] Step 1：核对豆包实际转写事件与会话合并逻辑，复现「说一句话给我听听」重复拼接
  - [x] 定位用户转写无条件追加与对话行宽度约束缺失
  - [x] 使用同句合成 PCM 请求豆包 `1.2.6.1`：中间 `delta` 是反复修订的完整句子，完成事件字段为 `text`
- [x] Step 2：在协议／会话边界修正转写语义，在原布局内约束长文本
  - [x] 用户转写按整句替换，删除轮次拼接开关；豆包完成事件读取 `text`
  - [x] 容器／对话行获得明确宽度，正文伸缩并限制两行
- [x] Step 3：定向回归、类型检查、构建与独立子 agent review，隔离提交协议修复
  - [x] 协议、遥测和语音运行时定向回归通过；NSH 和 runtime 类型检查、NSH 构建通过
  - [x] 独立 review 无发现；macOS 原生 844×390 横屏核对长短句、浅／深色，文字未越界
  - [x] iOS / ADB 设备列表无手机真机；手机横屏验收留在 todo.md
  - [x] 协议与测试隔离提交 `98fd661`；会话／页面修复叠加在先前未提交的语音调试功能上，保留工作区

### 家居卡片单一事实槽位与状态降级重设计（2026-11-10）

- [x] Step 1：在 `@super-looi/home-devices` 建立按尺寸（Span）与运行态计算的卡片视图模型（`card-presentation.ts`、`device-aggregator.ts`、`types.ts`）
  - [x] 清理周期家电 `stages` 中的非工序状态（移除 `"待机"`、`"完成"`），修正待机/关闭态 `activeStageIndex = -1` 与 `"待机就绪"` 冗余文案
  - [x] 实现 `resolveApplianceCardView(appliance, span)` 与 `collectCardVisibleTexts(view)`：收口 Header 副标题、右上角槽位（仅保留可控电源或离线/故障徽章，废除挤压 `1x1` 标题的冗余状态胶囊）与 Body 内容区的单一事实分配
- [x] Step 2：重构 `HomeSpaceView.tsx` 卡片渲染层，消除“卡中卡”左栏标题复读与同义状态堆叠
  - [x] 接入 `resolveApplianceCardView`，统一渲染周期家电工序条（每段直显自身工序名，仅在有倒计时/保温分钟数时展示数值）、温控单行步进器（Header 展示模式与室温，Body 仅展示目标温度步进）、扫地机快捷动作与多键开关全宽标题
  - [x] 同步 `apps/nsh/scripts/build-runtime.ts` 导出与类型声明
- [x] Step 3：编写单测不变量（Deduplication Invariant Test）、完成构建验证与独立子 agent 审查
  - [x] 在 `packages/home-devices/test/` 对全量真实家庭快照、直连 MIoT 与演示设备断言单卡状态词不重复、待机不点亮工序条、多键开关无挤压徽章
  - [x] 运行类型检查、构建、测试套件并经独立子 agent 审查通过后隔离提交

### 豆包页内预置音色选择（2026-11-10）

- [x] Step 1：核对官方全双工音色表、保存／试听接口与 NSH 设计规范
  - [x] 普通数据表维护名称与 ID；草稿归现有语音页，保存与试听复用 Store
- [x] Step 2：接入新版右侧音色抽屉，沿用现有舞台、服务卡片和试听布局
  - [x] 四款主推、八款更多预置、四款经典音色分组展示，已有默认与专属 ID 显示可识别名称
  - [x] 选择预置后直接试听草稿，再通过「使用此音色」保存；专属 ID 保留输入／粘贴
- [x] Step 3：类型检查、构建、运行时回归、音色选择行为与独立审查
  - [x] `typecheck`、`build`、`test:voice-runtime`、`voice_presets` 通过；专项覆盖中文横屏／英文竖屏的预置选择、专属 ID 和取消
  - [x] 当前豆包凭证与 `1.2.6.1` 模型真实请求四款主推，PCM 分别为 152046、144328、152692、152380 字节
  - [x] 子 agent 按新版 UI 基线复核通过；`app_ui` 3/4 通过，家居旧英文提示断言失败记入 todo.md
  - [x] 音色表与文案已隔离提交 `de7a92a`；页面接入与专项测试保留在现有新版语音 UI 工作区
  - [ ] 连接真机后核对原生选择器布局与实际试听；ADB 与 iOS 设备列表为空

### 实时语音同页对话调试、音色试听与现代化 Key 设置（2026-11-10）

- [x] Step 1：扩展实时语音协议、会话与运行时能力（`realtime-protocol.ts`、`apps/nsh/runtime/voice/`、`store.ts`）
  - [x] 协议层新增 `encodePreviewSpeech` 单次短句试听帧编码（豆包 `speech_text_buffer.commit`、OpenAI 单轮朗读请求）
  - [x] `LiveVoiceSession` 接入 `purpose: "conversation" | "preview"`（试听仅开启输出流、不请求麦克风、排空即结束）与用户实时转写 `userTranscript`
  - [x] `VoiceCredentialStore` 与 `VoiceRuntime` 支持掩码尾号摘要 `keyHint`、清除凭证 `clearCredentials`、草稿音色试听 `preview` 与运行中重连应用 `restartSession`
- [x] Step 2：重构语音管理页 UI 为左舞台对话调试 + 右侧扁平检视面板（`ManagementShell.tsx`、`VoiceSpaceView.tsx`、`Controls.tsx`、`extra-catalog.ts`）
  - [x] 顶栏收敛为「实时语音」标题与返回键；左栏还原状态胶囊、15 阶动态声波纹、双行实时对答（「你：…」「LOOI：…」）与底部胶囊控制栏（静音/打断/开始与结束对话）
  - [x] 右栏「语音服务」升级现代化 Key 管理（钥匙串掩码尾号展示、剪贴板一键粘贴、明文显示/隐藏切换、更换与移除凭证、运行中保存联动）
  - [x] 右栏「音色」与「唤醒」支持默认/预置/专属音色切换、未保存草稿一键试听（「试听」/「结束并试听」/「停止试听」）与会话中「应用并重连」
- [x] Step 3：自动化回归测试、Mac 原生预览验证与独立子 agent 审查
  - [x] 扩充 `voice-runtime-cases.ts` 与 `app_ui.rs` / `native_compat.rs` / `voice_presets.rs` 覆盖试听、用户转写、Key 管理与同页调试
  - [x] 运行类型检查、构建、测试套件并生成明暗/横竖屏实机渲染截图
  - [x] 子 agent 独立 review（修复试听结束后 `transcript` 恢复、`fail()` 并发回 `standby` 错误保留与紧凑按钮 `hitSlop` 触控热区）、更新 `DESIGN.md` / `todo.md` 并完成提交

### 图二语音配置与同页调试规划（2026-11-10）

- [x] Step 1：核对图二方向、现有页面与 VoiceRuntime 的配置／会话边界
  - [x] 确认开始语音无需跳页；服务由环境变量选择，豆包音色只在新会话建连时应用
  - [x] 核对 NSH 设计规范、凭证存储、双协议及自动唤醒生命周期
- [x] Step 2：形成语音服务、音色试听与同页调试的交互及接口方案
  - [x] 明确服务卡片、连接编辑、全局唤醒与调试区的职责
  - [x] 明确草稿试听、保存应用、运行中修改与服务切换行为
- [x] Step 3：独立 review，完善实施步骤、待办与规划文档提交
  - [x] 简化运行中服务切换，补清试听单次输出、唤醒恢复及保存／重连语义，复核通过

### 语音管理页结构重设计（2026-11-10）

- [x] Step 1：定位首屏表单过重、音色与会话操作分散的问题，核对 NSH 设计规范及服务适配边界
- [x] Step 2：重组服务上下文、凭证与音色配置、实时对话工作区
  - [x] 顶栏容纳当前服务及 OpenAI Realtime 接入位置
  - [x] 保存后的凭证与音色采用摘要及内联编辑，保留原配置动作
  - [x] 会话状态、主操作、自动唤醒和转写集中呈现，适配横竖屏
- [x] Step 3：NSH 类型检查与构建通过；现有 32 项测试中 31 项通过，修正另一项旧标题断言后定向复测通过
  - [x] 豆包／OpenAI 协议及唤醒运行时、17 项 Node 回归通过
  - [x] Mac 原生窗口核对浅／深色、横／竖屏；已配置状态采用内存配置预览，截图位于 docs/artifacts/voice-space/
- [x] Step 4：子 agent 独立 review 通过，修正授权后重试、连接阶段提示与静音播放表现，隔离提交本次改动

### 管理页顶栏操作图标（2026-11-10）

- [x] Step 1：对照截图定位返回、扫描底座、新对话与刷新，核对 NSH 组件与设计约定
- [x] Step 2：扩展 Canvas 线性图标与共用 44pt 图标按钮，替换横竖屏顶栏操作
  - [x] 保留原操作与 testID，加入本地化读屏名称、悬停提示及扫描／刷新动态反馈
- [x] Step 3：类型检查、构建与 31/31 现有测试通过；Mac 原生窗口核对浅／深色图标渲染，预览保存至 docs/artifacts/toolbar-icons/
- [x] Step 4：子 agent 独立 review 通过，仅暂存本次改动并提交

### 家居服务绑定新布局与米家视频独立登录 Flow 落地（2026-11-10）

- [x] Step 1：准备米家与 Home Assistant 官方高清图标资源与品牌图标组件
  - [x] 提取并封装官方 256x256 图标资源为无损内联组件，杜绝手绘失真
- [x] Step 2：扩展 Store 中的摄像头视频授权状态与独立登录流状态管理
  - [x] 增加视频授权状态（已连接/未连接/已授权）、关联摄像头数量及登录流程动作
- [x] Step 3：实现米家视频独立登录流程页面组件 (`XiaomiVideoLoginFlow.tsx`)
  - [x] 实现账号登录、图形验证码按需、短信/邮箱验证按需及完成返回的 4 阶段界面
- [x] Step 4：重构服务绑定主页面布局为左右分栏主从结构 (`HomeSpaceView.tsx`)
  - [x] 左栏实现家居服务列表（米家直连、Home Assistant、离线演示）及多状态点
  - [x] 右栏实现米家直连设备控制与摄像头视频独立卡片、地区选择、HA 及离线演示详情
- [x] Step 5：编写自动化测试并验证完整登录流、服务切换与响应式布局
- [x] Step 6：运行项目整体检查、类型检查、独立 Review 与阶段性 Commit

### 家居服务绑定页 UI 方案发散（2026-11-10）

- [x] Step 4：生成米家视频登录、图形验证、短信／邮箱验证和返回绑定页四状态效果图；按需验证及验证码错误在同页展示，图片与提示词保存至 docs/artifacts/home-services-options/video-login-flow*
- [x] Step 1：核对现有服务选择卡、配置表单、全局导航与 NSH 设计指南
- [x] Step 2：用 imagegen 生成主从分栏、紧凑列表、双栏服务卡三种横屏方案
- [x] Step 3：纳入米家视频独立登录，生成同一服务内区分设备控制与摄像头视频的第四版；四张效果图与提示词保存至 docs/artifacts/home-services-options/

### 路由返回卡顿与过渡动画（2026-11-10）

- [x] Step 5：store.goBack 统一界面返回与系统返回，覆盖设备详情、服务绑定、管理页与首页；原行为回归失败，修复后通过
- [x] Step 6：模拟器验证服务绑定/详情返回与桌宠画布恢复，隐藏画布停止绘制；修复家居 SelectField 字段和两处遗留 key，31/31 测试、类型检查及独立 review 通过

- [x] Step 1：iPhone 16e 模拟器捕获进入管理约 266ms、切语音约 991ms；临时探针定位同步唤醒启动 875–888ms、停止 149–157ms，已排除静态翻译调用为主要原因
- [x] Step 2：异步加载/释放唤醒模型，iOS 后台还原系统音频会话；同步请求代次取消、共享目录翻译、保留页面与离页控制停止
- [x] Step 3：复用 NSH createMotion 加入 160ms、8pt 淡入过渡，遵循系统减少动态效果
- [x] Step 4：30/30 测试、类型检查、构建、原生唤醒和独立 review 通过；模拟器语音页提交约 5.2ms、返回首页约 2.5ms，证据见 `docs/navigation-performance.md`

### 米家摄像头手机内接入实施（2026-11-10）

- [ ] Step 1：建立隔离实现，完成原生媒体会话和无预览 JPEG／共享预览
  - [x] 保留现有未提交改动与 8790 开发会话；已取得三台实际 H.265 样本
  - [ ] iOS VideoToolbox、Android MediaCodec/EGL、显示组件与原生注册
  - [ ] 使用真机开发宿主验证样本解码、取帧和消费者释放
- [ ] Step 2：移植 Rust 云账号、密码原语、CS2 与 MISS，持久化视频凭据
- [ ] Step 3：接入家居登录／预览与 Pi 图片工具，维护取消与前后台生命周期
- [ ] Step 4：完成定向检查、独立 review、真实设备联调与架构更新，分阶段提交

### 米家摄像头手机内接入设计（2026-11-10）

- [x] Step 1：对照已实测协议，核对家居运行时、凭据、原生注册及播放器边界
  - [x] 查明现有 Video 仅接 URL、HomeRuntime/store 为单预览；视频账号需独立会话，Pi 工具已支持图片内容
- [x] Step 2：比较协议移植和媒体接入路径，查证两端系统 API 与新增依赖成本
  - [x] 用户确认预览 + Agent 取帧；推荐 Rust 协议、iOS VT 像素共享、Android 独立 SurfaceTexture/EGL 与按需 JPEG
  - [x] 核对原生组件注册、iOS 15 基线、Android target 35 与插件接线，整理官方／AOSP 来源
- [x] Step 3：明确账号、会话、显示与退出生命周期的契约，形成接入方案和实施步骤
  - [x] 单 DID 共享解码、前台无预览取帧、取消／退出消费者、图片模型工具链与新增成本已写入 `docs/plans/xiaomi-camera-native-integration-plan.md`
- [x] Step 4：独立复核关键接口、来源与取舍，更新待办并提交文档
  - [x] 双消费者、无预览取帧、两端 API 与 Android 注册时序、Pi 图片链路及依赖成本复核通过；旧计划已指向新方案，待办按确认用途更新

### 社区 MISS/CS2 实机取流验证（2026-11-10）

- [x] Step 1：检查现有会话与网络，准备最小独立协议探针
  - [x] `.env` 无 xiaomiio 账号凭据；iOS 登录使用 nonPersistent WebView，已结束的网页登录会话未保留
  - [x] 在临时目录准备上游协议与扫码登录；通用账号端点 TLS 连接失败，`cn.account.xiaomi.com` 可达；临时扫码回执持续 403，已改用上游原生账号／验证码登录页面
  - [x] 独立复核并修正验证码域名适配、错误重输状态和采样提前结束的统计保留；登录实验结果见 `docs/xiaomi-camera-community-verification.md`
- [x] Step 2：完成 xiaomiio 登录，核对三台摄像头的型号、地址与 MISS 会话参数
  - [x] 保留当前验证码会话修正区域回调并完成 STS；实际设备列表验证通过，三台均在线、vendor 为 CS2
  - [x] 原探针请求返回 -12/throttle deny；Go 风格 HTTP 请求组合成功，原形式复查仍 -12，未把差异单独归因于 UA
- [x] Step 3：逐台验证 CS2、MISS 认证与连续视频帧，使用原生编解码工具检查媒体
  - [x] 三台均协商 TCP，约 20 秒采样分别解码 399/397/311 帧 H.265，解码错误均为 0；大厅和小鸟已抽帧确认真实画面
  - [x] 天台首次 CS2 握手超时，IP 可达，重试成功；统计与请求对照已归档，未把桌面首包耗时当作手机首帧
- [x] Step 4：记录实测证据、独立 review、更新待办并提交
  - [x] 独立复核三台成功统计、首次失败、请求组合的因果边界与桌面／手机范围；已归档 JSON，清理已解决待办

### 社区米家摄像头取流方案复核（2026-11-10）

- [x] Step 1：深入用户指定的 `Kosztyk/xiaomi_camera_native`，核对协议源码、授权与依赖
  - [x] 固定 0.3.10 源码，追踪 xiaomiio → miss_get_vendor → CS2 → MISS → ChaCha20 编码帧；区分 Original 重封装与默认 FFmpeg 转码
- [x] Step 2：交叉核对 go2rtc、MiBeeNvr 与其他可移植实现的目标型号证据
  - [x] hlc7 有成功播放与 VLAN 超时记录；039a01 仅找到准确 CS2 日志；核实同作者 JS 移植尚无实机测试
- [x] Step 3：比较手机进程内接入方式与成本，整理研究结论
  - [x] 记录 Node 兼容层网络/加密差距、原生编码帧入口和与现有 HA OAuth 不同的账号会话，见 `docs/xiaomi-camera-community-solutions.md`
- [x] Step 4：独立 review、更新待办并提交研究记录
  - [x] 复核协议、许可、依赖与上游型号证据，修正三台设备／两种型号的数量措辞；研究文档与差异格式检查通过

### Miloco 摄像头取流机制研究（2026-11-10）

- [x] Step 1：核实官方当前版本，对比既有旧版取流研究
  - [x] remote main 为 `05cdb1c`；确认 Miloco 独立 OAuth 身份、camera C ABI 与四种桌面原生产物
- [x] Step 2：追踪真实媒体帧、解码与前端播放路径，核对队列、重连及资源释放
  - [x] 原生编码帧 → PyAV/BGR → libx264 → WebSocket → WebCodecs/MSE；核对共享解码、20 帧队列和每订阅者 8 包队列
  - [x] 确认网页退出释放转码订阅与编码器，感知仍可持有底层摄像头连接
- [x] Step 3：评估手机进程内复用范围与新增依赖成本，写入研究文档
  - [x] 记录仅 macOS/Linux 产物、闭源 SDK 与其他 App 用途未授权的具体限制；区分原始码流接口与网页重编码成本
- [x] Step 4：独立 review、更新待办并提交研究记录
  - [x] 修正 JPEG 与 BGR 分支图、网页订阅与底层连接释放的职责表述；固定提交源码、二进制与许可结论复核通过

### 米家摄像头进程内取流落地与性能验证（2026-11-10）

- [x] Step 1：更正为手机内置 `HomeRuntime/direct_miot`；停止错误的外部 HA 路线，撤下新增桌面集成、独立测试配置和测试 APK，恢复原 8790 开发会话，原米家凭据未改
- [ ] Step 2：GPT-6.1 SOL High 在正确底座的隔离树中，用手机已有 MIoT 会话验证 hlc7 流动作与 039a01 P2P 授权
  - [x] 两台 hlc7 沿用手机既有 OAuth，HLS action 返回 HTTPS 播放地址；一台原生 Video 加载 640×360 并产生播放进度，另一台 I/O 错误 `1/-1004`
  - [x] 039a01 P2P start/stop 成功但输出为空；现有 OAuth 主机的 `device/miss_get_vendor` 返回 404，尚无会话参数
  - [x] 已对成功启动的流执行 stop；撤除授权探针、临时包与 8792 转发，恢复原 8790 开发会话
  - [x] 按房间复测卧室与天台，两台 master 均为 404；同地址短暂等待未恢复，未取得可分析的媒体片段
  - [ ] RTSP 与 039a01 精确候选授权端点尚未实测；P2P 线索已记录到 `docs/xiaomi-camera-mobile-p2p-authorization.md`
- [x] Step 3：GPT-6.1 SOL High 落地手机进程内 HLS 会话、原生 Video 与详情生命周期；包内复用既有 OAuth，无新增运行依赖
  - [x] 同服务规格发现与开始/结束动作；离页、切账号、退后台取消观看，处理已发出开流请求的晚到结果
  - [x] 移除假分辨率和电源推导的播放状态；保留摄像头控制，039a01 明确显示视频尚未接通
- [x] Step 4：主 agent review 并修复取消时序、跨服务状态误用和控制入口丢失；包测试 51/51、运行时 2/2、节点生命周期 1/1，集成后的 NSH typecheck/build 通过
  - [x] Headless 实际 Video 节点 64 在三次 dashboard 替换后保持同一 ID，退出详情后数量为 0；此项不代表真实媒体性能
- [ ] Step 5：真机记录真实首帧、延迟、稳定播放、PSS/RSS/CPU 与释放情况；无媒体时不将空闲内存或节点测试当作播放性能
  - [ ] 正式详情验收时 USB 与 Wi-Fi ADB 均离线，等待手机恢复调试连接；本轮未取得有效播放性能样本
- [x] Step 6：按用户指定的 iOS 模拟器复测，并回查原 session 的接入流程
  - [x] 重启卡死的 8790 dev 服务与 iPhone 16e 开发宿主，验证管理页响应；用户完成米家登录后加载 44 台设备
  - [x] 正式详情复现卧室与天台加载失败，原生日志确认 HTTP 404 / CoreMedia -12938，失败后播放器析构
  - [x] 同一卧室设备与 OAuth 对照直接 start、stop→start；动作均成功，新返回媒体地址 GET 均为 404、零字节
  - [x] 读取原主/子 session、重建探针逻辑并对照参考源码；原成功条件只有瞬时进度，确认期限/续流缺失及上游维护者不支持直播的声明
  - [x] 撤除延时实验与临时跟踪，恢复当前开发包；记录 `docs/xiaomi-camera-mobile-verification.md` 与脱敏证据

### 智能家居真机能力、拖边布局与设计还原落地（2026-11-10）

方案见 [`docs/plans/smart-home-device-and-design-repair-plan.md`](docs/plans/smart-home-device-and-design-repair-plan.md)。

- [x] Step 1：真实设备能力闭环（`@super-looi/home-assistant`、`@super-looi/home-devices`、`apps/nsh/runtime`）
  - [x] 扩充 MIoT Spec 解析（`parseMiotSpec` 保留 `actions` 及关联入参属性）与 `MiotHttpClient.callAction`（`miotspec/action`）
  - [x] 扩充 `mapMiotDevice` 与 `DirectMiotTransportAdapter`：映射可写布尔（`switch`）、可写范围数值（`number`/`climate`）、可写枚举（`select`）及动作（`button`），支持 `set_value`/`select_option`/`set_temperature`/`set_hvac_mode`/`press`
  - [x] 扩充 `ha-rest-transport.ts` 属性白名单、`ha-entity-policy.ts` 风扇/空调能力与 `gateway.ts` 命令校验与状态回读判据
  - [x] 在 `@super-looi/home-devices` 引入五类统一控制元语 `controls`（`Toggle`/`Range`/`Choice`/`Action`/`Metric`），补齐风扇 `dmaker.fan.p45`、空调 `xiaomi.airc.h09h00`、台灯、净化器、扫地机、洗碗机、电饭煲、电热水瓶、除湿机、音箱、宠物设备与摄像头真实能力
- [x] Step 2：统一卡片几何、拖边缩放与房间级布局入口（`@super-looi/home-devices`、`apps/nsh/store.ts`、`apps/nsh/ui/`）
  - [x] 扩展 `TileSpan = "1x1" | "2x1" | "1x2" | "2x2"` 与 `layout-store.ts` 尺寸读写
  - [x] 收敛布局编辑状态为房间 ID（`homeLayoutEditing: string | null`），移除顶栏“调整布局”按钮与卡片表面循环尺寸/方向/互换按钮，将房间批量电源收敛到房间头“更多”菜单
  - [x] 基于画布实际宽度测量（`floor((width + 12) / (208 + 12))`）与固定基准行高实现 `1x1 / 2x1 / 1x2 / 2x2` 卡片流式排布、右/下/右下角 44dp 拖边缩放热区（含 8dp 迟滞与预览重排）及长按拖移排序，修复 `Each` 稳定 `key={(app) => app.id}`
- [x] Step 3：视觉还原与复杂设备专项修复（`apps/nsh/theme.json`、`apps/nsh/ui/HomeIcons.tsx`、`apps/nsh/ui/HomeSpaceView.tsx`）
  - [x] 在 `apps/nsh/theme.json` 补齐 `light`/`dark` 语义颜色 Token（`lighting`/`airflow`/`air-quality` 等），更新 `HomeIcons.tsx`（区分 `desk_lamp` 与 `light`，重绘带立柱底座冷蓝 `fan` 扇叶，新增 `leaf`/`thermometer`/`droplet`）
  - [x] 还原房间分组容器层级、同设备来源 PM2.5 + 空气质量等级胶囊、两行设备名称（去房间前缀与型号长名规整）
  - [x] 修正洗碗机 `qmdq88.dishwasher.s1` 误判洗衣机、扫地机主刷/边刷耗材覆盖、电饭煲未提供字段时的虚构食谱/进度、摄像头占位说明与 KB→GB 换算
- [x] Step 4：完整使用路径验收、架构图同步与独立审查
  - [x] 通过 `@super-looi/home-assistant`（52/52）、`@super-looi/home-devices`（4/4）、`@super-looi/nsh`（31/31）全量测试、全仓 `pnpm typecheck` 与 `pnpm build`
  - [x] 更新 `docs/arch/architecture.js` 与 `docs/arch/sources.js`（93 个源码文件同步）
  - [x] 安装到魅族 20 Pro 真机（`391QYGCN224FE`）完成真实 44 台家庭设备加载与视觉验收，修复独立子 agent review 指出的全部 11 项问题及 HA 摆风 `oscillate` 透传并终审 **PASS**

### 家居手动刷新反馈（2026-11-10）

- [x] Step 1：定位顶栏按钮复用后台轮询加载状态，明确手动刷新独立状态的归属
- [x] Step 2：按钮文字与禁用状态仅跟随手动刷新，保留首次加载与后台同步
- [x] Step 3：类型检查、构建、现有加载态测试 2/2 与独立 review 通过；魅族真机连续自动同步时按钮保持“刷新”，手动刷新显示“刷新中…”并禁用，完成后恢复

### 米家摄像头取流与 HA 包集成调研（2026-11-10）

- [x] Step 5：按“不得新增常驻进程”修订方案
  - [x] 核对现有 HA 内置 go2rtc 进程及模块限制，找到纯 Python CS2/MISS 进程内集成；Original 转封装与 HA 既有图片接口可避免新服务/编码器
  - [x] 撤销独立 go2rtc/FFmpeg 服务推荐，改为 HA 进程内取流、标准 HLS 接口和 NSH 原生 Video；重写成本、型号与真机实验步骤
  - [x] 独立审查通过；明确部署时替换上游 FFmpeg 快照覆盖，复用 HA 进程内图片接口；更新待办与文档检查
- [x] Step 1：核对两种真实摄像头型号、现有 HA 包接口与 NSH 播放能力
  - [x] 确认两台 `isa.camera.hlc7` 和一台 `chuangmi.camera.039a01`；官方 Xiaomi Home 不提供视频流
  - [x] 追踪设备标识、摄像头能力与运行时调用边界；确认 NSH 固定版本已有 WebView/Video，当前页面仍为占位视窗
- [x] Step 2：核对 go2rtc、小米官方取流组件及社区桥接方案的一手证据
  - [x] 确认 go2rtc 独立小米登录、建连获取密钥和局域网媒体路径，核对公开 HTTP/WebRTC/RTSP 接口
  - [x] 完成 Mac/容器部署、两个型号和 Miloco SDK 使用限制的证据归档，见 `docs/xiaomi-camera-streaming-research.md`
- [x] Step 3：由主 agent 编写 `docs/plans/xiaomi-camera-streaming-plan.md`，比较接口与依赖成本，拆分实施步骤和真机验收条件
- [x] Step 4：子 agent 独立审查，补齐持久卡片身份/控制主来源及真机 HTTPS 证书条件；更新待办，完成文档链接与 diff 检查

### 智能家居真机调研与修复方案（2026-11-10）

- [x] Step 1：连接魅族 20 Pro，读取当前家居首页与设备能力字段
  - [x] 通过临时只读探针读取账号内 46 台设备规格和属性，核对首页 44 张卡片，保存去除设备标识和凭据的能力清单；探针已撤除并恢复原开发会话
  - [x] 补齐风扇详情、布局编辑与明暗主题截图，恢复跟随系统外观
- [x] Step 2：读取 agy `a9061a4d-7a3f-4899-a8ee-179e59a17aea` 用户设计反馈及原始分组/Bento 设计图，对照信息层级、图标、PM2.5 和布局入口差距
- [x] Step 3：追踪设备字段、能力归一化、命令与回读、元语与界面组装，形成 [分层修复方案](docs/plans/smart-home-device-and-design-repair-plan.md)
- [x] Step 4：独立 review 与复核通过；补齐动作状态判据、1x2 独立轴缩放、同设备 PM2.5 来源、长名称及房间编辑身份，保存方案和待办；业务功能未落地


### 设备固定排序与开关乐观更新（2026-11-10）

- [x] Step 1：定位状态参与排序和开关等待回执、重复读取的问题
- [x] Step 2：固定设备排序，在共享状态层实现即时开关与回执协调
  - [x] 覆盖轮询旧值、连续点击和失败恢复
- [x] Step 3：开关交互 10/10、设备聚合 3/3、家居运行时 1/1、NSH 28/28 测试、类型检查、构建与独立 review 通过；修复热更新到魅族 20 Pro 开发宿主
- [ ] Step 4：魅族真机完整核对风扇开关即时反馈和卡片位置；本次已确认新版家居页加载，未完成开关交互验证

### 家居设备加载态（2026-11-10）

- [x] Step 1：定位已绑定服务读取期间被空数组误判为未绑定的问题
- [x] Step 2：在 store 跟踪家居读取，首次加载显示进度，刷新保留已有设备
- [x] Step 3：NSH 28/28 测试、类型检查、构建及独立 review 通过；魅族 20 Pro 开发宿主冷启动进入家居显示加载提示，读取完成后正常显示设备

### Android 真机开发默认启用 Langfuse（2026-11-10）

- [x] Step 1：确认真机启动入口、现有遥测开关和 Langfuse 服务状态
- [x] Step 2：真机开发启动按健康端点自动开关上报，本机服务自动配置 ADB 端口转发
- [x] Step 3：构建环境用例 2/2、独立 review 通过；魅族 20 Pro 开发宿主覆盖安装并前台运行，上报配置已注入，ADB `3000` / `8790` 转发已建立

### 智能家居空间 V2 深度重构：专属设备全屏页、长按自由布局、矢量图标体系与状态实时同步（2026-11-09）

方案见 [`docs/plans/smart-home-ux-v2-plan.md`](docs/plans/smart-home-ux-v2-plan.md)。

- [x] Step 1：修复 `@super-looi/home-assistant` 与 `@super-looi/home-devices` 数据与聚合层缺陷
  - [x] 修复 `大厅灯`（`yutai.plug.fsov7m`）误绑语音禁用开关、`阳台灯`/`卧室灯`（`开关 按键`）不可控、人体传感器误判为灯具、冰箱温度计误判为插座及华氏度（`°F`）未换算摄氏度（`°C`）问题
  - [x] 修复扫地机器人显示 `13` / `14` / `Yes` 等原始状态码问题（在 MIoT 解析器与 `device-aggregator` 双层映射可读工作状态）
  - [x] 扩充监控（`CameraCapability`）、扫地机器人（`VacuumCapability`：电量、面积、时长、吸力/水量模式、4 项耗材寿命、集尘/洗拖布/回充动作）、电饭煲/周期家电（`CycleTaskCapability`）与温控/喂食器深度能力模型，以及 `layout-store.ts` 自由位置移动/互换能力
- [x] Step 2：实现智能家居前台实时状态轮询与同步（`apps/nsh/store.ts`）
  - [x] 打开 `home` 空间立即刷新状态，并在前台停留期间每 4 秒静默同步最新设备快照，确保外部渠道（米家 App / 墙壁开关）操作后界面自动更新
- [x] Step 3：构建矢量家电与操作图标库 `apps/nsh/ui/HomeIcons.tsx`
  - [x] 使用 NSH `Canvas` 绘制 23 类家电矢量图标与电源（`⏻`）、播放、暂停、停止、回充、方向移动、尺寸切换等操作图标，消除对“开启/关闭”文字按钮的依赖
- [x] Step 4：重构 `apps/nsh/ui/HomeSpaceView.tsx`（长按自由布局 + 监控/扫地机/电饭煲等独立全屏专属页面）
  - [x] 移除详情面板中的 `1×1`/`2×1`/`2×2` 按钮，改为长按任意方块进入自由布局模式（支持尺寸切换、方向移动、点选目标方块直接互换位置）
  - [x] 将卡片开关统一为点亮/熄灭态分明的圆形电源图标按钮（`⏻`）+ 明确的状态副标题
  - [x] 实现点击卡片进入全新独立全屏页面：监控专属全屏页、扫地机器人专属全屏页、电饭煲/周期家电专属全屏页、空调/环境全屏页、灯光/多键开关/插座/宠物家电专属全屏页
- [x] Step 5：全量单测、Headless UI 测试、子 Agent 独立 Review 与真机安装验证

### 智能家居空间重构与 `@super-looi/home-devices` 组件体系（2026-11-09）

方案见 [`docs/plans/smart-home-redesign-plan.md`](docs/plans/smart-home-redesign-plan.md)。

- [x] Step 0：完成真实家庭快照（`data/home-assistant/.storage/` 45 台设备）盘点、Nano Banana 16:9 横屏多尺寸 Bento 设计稿迭代与方案定稿
- [x] Step 1：创建 `@super-looi/home-devices`（`packages/home-devices`），实现房间净化、6 大设备原型聚合、10 类领域能力模型与多尺寸 Bento 布局持久化，通过 45 台真实设备快照单测
- [x] Step 2：升级 `@super-looi/home-assistant` 与 `apps/nsh/runtime/home.ts`，支持多源并发挂载（`direct_miot` + `external_ha` + `simulation`）与全品类安全控制路由（45/45 网关单测与 `verifyHomeRuntime` 通过）
- [x] Step 3：贯通 `MobileRuntime`、`store.ts`、Bento 卡片尺寸持久化（`home.layout.v1`）与双语国际化词条
- [x] Step 4：重构 `ManagementShell.tsx` 与 `HomeSpaceView.tsx`（「我的设备」房间分栏 + 可自定义尺寸 Bento 磁贴 + 二级详情面板 +「服务绑定」独立管理页，严格控制表面文字密度）
- [x] Step 5：完成全仓构建/类型检查/测试、魅族 20 Pro 真机安装验证、`docs/arch/` 更新与子 Agent 独立 review
  - [x] `@super-looi/home-devices` 2/2 单测、`@super-looi/home-assistant` 45/45 单测、`@super-looi/nsh` 26/26 全量测试（含 `app_ui.rs` 2/2）与全仓 7 包 `pnpm typecheck` 全部通过
  - [x] 子 Agent 独立代码与 UI 审查指出的 5 项问题（灯光亮度 `1..255` 换算、Bento 同优先级卡片调序归一化、`valve`/`siren`/`notify` 权限与高危域收口、房间活跃计数国际化词条、多源并发模式下模拟设备控制标记）已修复并复审 **PASS**
  - [x] Android 开发包（`Super LOOI.apk`）已重新构建并覆盖安装至魅族 20 Pro 真机（`192.168.3.123:5555`）

### Android LIVE 外放声音偏小（2026-11-09）

- [x] Step 1：魅族 20 Pro 的媒体音量 60/60、通话音量 7/7；LIVE 中实际输出为听筒，且应用未选择通信输出设备
- [x] Step 2：在应用自有 Android 音频插件中选择内置扬声器，保留已连接耳机通道，会话结束时释放应用选择
- [x] Step 3：原生插件测试、Java 构建与独立 review 通过；修复版安装到魅族 20 Pro，LIVE 的 AAudio 输出由听筒 `deviceId:2` 切换至扬声器 `deviceId:3`；结束后通信设备选择清空，恢复 `MODE_NORMAL`
- [ ] Step 4：用户试听确认实际播报响度

### `PiAgentExecutor` 模块化重构 Phase 1（2026-11-09）

方案见 [`docs/plans/pi-executor-refactor-plan.md`](docs/plans/pi-executor-refactor-plan.md)。

- [x] Step 1：按 Agent 五大正交维度（`core/`、`prompts/`、`governance/`、`memory/`、`tools/`）重组 `packages/looi-runtime/src/agent/` 目录，并将移动端底座/家居工具抽离至 `apps/nsh/runtime/tools/`
- [x] Step 2：实现一次性任务运行器 `core/pi-task-runner.ts`（`PiTaskRunner`），将 `core/pi-executor.ts` 收敛为任务准入与并发调度器，并同步更新 `docs/arch/`
- [x] Step 3：完成 `@super-looi/runtime`、`@super-looi/nsh`、`@super-looi/nsh-node-compat` 回归验证、全仓类型检查与子 agent 独立 review
  - [x] 全仓 `pnpm typecheck`、`@super-looi/runtime` 89/89 单测、`@super-looi/nsh` 语音与异步任务回归套件及 `.nsh/out` 构建全部通过
  - [x] 子 agent 独立代码审查终审 **PASS**

### LOOI 控制系统协议能力接入与无极变向轮盘（2026-11-09）

方案见 [`docs/plans/body-control-system-and-stepless-wheel-plan.md`](docs/plans/body-control-system-and-stepless-wheel-plan.md)。

- [x] Step 1：扩充 `@super-looi/looi-driver` 双轴脉冲、离散无应答 GATT 写入 FIFO 30ms 节流串行链与 `FED8`/`FED2` 静默窗保护，补充驱动单测（26/26 通过）
- [x] Step 2：升级 `BodyRuntime`、`application.ts`、实时语音 `control_looi_body`、`store.ts` 与 `build-runtime.ts` 类型契约（接入无极 `setDriveVector`、亮度控制、电量读取与双语错误归一化）
- [x] Step 3：实现《王者荣耀》式 360° 无极变向摇杆 `SteplessWheel`（多指触点追踪 + 前后台/急停锁定）、补光灯无极亮度滑杆、底座电量与外接供电状态栏及中英文文案，同步更新 `DESIGN.md`
- [x] Step 4：完成驱动、运行时、NSH Headless UI 回归验证、魅族 20 Pro 真机安装检查与子 agent 独立 review
  - [x] `@super-looi/looi-driver` 26/26 单测、`@super-looi/nsh` 类型检查、`test:voice-runtime` 与 Rust `app_ui` 2/2 全部通过
  - [x] Android 开发包（`arm64-v8a` / `armeabi-v7a`）已重新构建并覆盖安装至魅族 20 Pro（`192.168.3.123:5555`）
  - [x] 子 agent 三轮独立 review 终审 **PASS**

### LOOI 底座协议能力补齐（2026-11-09）

- [x] Step 1：核对社区协议与本仓驱动/原生桥接边界，确定只扩充协议层
- [x] Step 2：补齐有符号双轴运动编码与四方向标准字节
- [x] Step 3：贯通 `FED8` GATT 读取，解析电量与外接供电
- [x] Step 4：补齐 `FED2` 亮度控制及现有开关默认亮度
- [x] Step 5：驱动 24/24、NSH 类型检查/运行时用例、iOS 模拟器宿主与 Android 三 ABI/开发宿主编译通过；独立 review 终审 PASS。Android 探针的真机安装阶段因 2.8 GB 测试包经 Wi-Fi ADB 传输缓慢而终止，物理协议效果留待真机核对

### 现有代码分主题提交与 PR（2026-11-09）

- [x] Step 1：核对 `origin/main`、本地 66 个提交及未提交文件，确定以现有历史构建串联 PR
- [x] Step 2：全仓 `pnpm typecheck`、`pnpm test`（NSH 24/24）与 `pnpm build` 通过；独立 review 指出的未确认取消状态错误已修复并由异步语音回归用例覆盖，生成的 Python 缓存已忽略
- [x] Step 3：按历史主题建立五个分支；运行时代码与原生底座控制已提交为 `88622fa`，文档和资源另成提交
- [x] Step 4：推送七个分支并创建 GitHub PR #7–#13；按 NSH 兼容、移动运行时、界面与唤醒、Realtime 遥测、双语与底座、运行时收尾、文档资源依次串联

### Android LIVE 实体音量键控制（2026-11-09）

- [x] Step 1：确认 LIVE 的 AAudio 输出与音频焦点均使用语音通话用途，Activity 未指定实体音量键对应的播放通道
- [x] Step 2：会话期间将音量键指向语音外放通道，结束或退后台时恢复原通道
- [ ] Step 3：完成原生插件构建检查与 Android 真机验证，独立 review 后提交
  - [x] Android 原生插件测试与 Java 编译通过；开发宿主已构建并安装到魅族 20 Pro
  - [x] 独立 review 未发现明确缺陷
  - [ ] 待真机在 LIVE 实际播报时按音量键确认外放音量变化

### 实时语音会话由静默超时结束（2026-11-09）

- [x] Step 1：确认模型结束工具、豆包结束意图选项与 12 秒计时链路
- [x] Step 2：移除模型结束工具和服务端主动退出配置；用户或洛伊结束说话后进入 12 秒静默计时
- [x] Step 3：双协议配置、播报排空与静默回待机回归通过；延迟转写完成不延后截止时间，独立 review 通过

### Android 真机连接后约 5 秒断开（2026-11-08）

- [x] Step 1：核对真机蓝牙记录，连接约 5 秒后由对端断开；发现社区流程的持续 `FED0` 心跳未接入
- [x] Step 2：在驱动状态机中持续发送当前运动帧，空闲与停止时发送 `0000`，断连时结束心跳
- [x] Step 3：驱动 19/19、NSH 运行时测试与类型检查通过；Android 修复版已打包并安装到魅族 20 Pro，独立 review 未发现明确问题；开发宿主已切到当前源码并保持运行
- [x] Step 4：真机对照定位 5 秒断开：社区序列即使持续写 `FED0` 仍被底座断开；恢复既有三步握手并保留心跳后，连接持续约 6 分 27 秒，直到开发宿主重启
- [x] Step 4.1：按独立 review 恢复 `FED9` 在三步握手前订阅，驱动 19 项测试与类型检查通过
- [ ] Step 5：实测吸合通知与基础动作，确认控制手感

### LOOI 底座社区初始化流程试验（2026-11-08）

- [x] Step 1：核对现有握手、原生通知订阅时机与社区初始化顺序
- [x] Step 2：切换为 `FEDA:01 → FED5/FED9 订阅 → FEDA:03 → FED0:0000`，注释保留原三步握手
- [x] Step 3：更新双端桥接与相关测试，完成构建检查及独立 review
  - [x] 驱动 19/19、NSH 运行时测试、类型检查及 Android 原生插件测试通过
  - [x] Android APK 与 iOS 模拟器 App 打包通过；新版 APK 已安装到魅族 20 Pro
  - [x] 修复独立 review 指出的通知丢失、重复回调与握手期间动作抢先执行
- [ ] Step 4：等待用户在物理底座上测试连接、在座通知与基础动作

### NSH headless App 私有存储测试修复（2026-11-08）

- [x] Step 1：复现 `Private app storage unavailable`，确认 2 项 `App.test.tsx` 在 `nsh/test` 的无数据目录宿主中初始化失败
- [x] Step 2：迁移整页用例至 Rust `Headless`，为每次应用启动配置私有临时目录，并保留国际化纯 TSX 测试
- [x] Step 3：补齐独立 review 指出的模型、语音、底座界面断言；`cargo test --test app_ui` 2/2 与完整 `pnpm --filter @super-looi/nsh test` 24/24 通过

### 底座方向轮盘轻触与长按（2026-11-08）

- [x] Step 1：确认轮盘原先每次按下发送 600–800 毫秒脉冲，底座控制接口支持停止和有界运动
- [x] Step 2：轻触改为短脉冲；长按保持同一次运动并定期续租，松手或离开页面立即停止；补充中英文操作提示
- [x] Step 3：验证轻触、长按、停止与页面切换，完成独立 review
  - [x] NSH 类型检查、24 项应用测试、底座运行时测试及 looi-driver 18 项测试通过
  - [x] 独立 review 指出的外部停止后心跳误判和连续轻触后长按延迟已修复，最终复审 PASS；长按 UI 测试覆盖按下与松开

### 底座头部俯仰连续调节（2026-11-08）

- [x] Step 1：定位三档限制在滑杆步长、界面映射和驱动固定字节
- [x] Step 2：将 25°–85° 的角度写入贯通界面、运行时和蓝牙驱动；滑杆拖动期间更新设备，合并过密指令
- [x] Step 3：验证任意角度、快捷档位和界面反馈，完成独立 review
  - [x] 驱动 17 项测试、运行时用例、驱动与 NSH 类型检查通过
  - [x] 独立 review 指出的角度术语冲突与滑杆／快捷按钮竞态已处理
  - [x] 当次完整 NSH 测试复跑为 22/24；另 2 项的私有存储初始化问题已在上方「NSH headless App 私有存储测试修复」中处理

### 清除上次底座连接（2026-11-08）

- [x] Step 1：确认底座只保存一台上次连接设备；现有断开操作不清除本机记录
- [x] Step 2：在底座运行时清除保存记录并取消当前连接，接入页面操作与中英文文案
- [x] Step 3：运行时用例验证断开、持久记录清除、重启不自动连接及再次连接后保存；NSH 类型检查通过，独立审查发现的测试竞态已修正

### 安卓真机底座扫描修复（2026-11-08）

- [x] Step 1：确认蓝牙与扫描权限已开启，系统记录原扫描采用低功耗模式、每次约 1.5 秒且返回 0 个广播
- [x] Step 2：首次配对扫描改为 8 秒低延迟扫描；补齐精确位置授权，并将系统扫描失败回传到界面
- [x] Step 3：开发包真机扫描发现 `LOOI Robot`，定位后续 3 步握手未等待 GATT 写入确认
- [x] Step 4：等待订阅与每步写入回执后，开发包真机连接 `LOOI Robot`，界面显示“已吸合就绪”
- [x] Step 5：连接状态单独决定方向、头部与补光灯操控，吸合状态不作为操控前提
- [ ] Step 6：清理诊断日志，运行相关检查，完成独立 review 与提交

### Android Task 审核模式（2026-11-08）

- [x] Step 1：梳理审核链路与设置持久化
  - [x] 确认 `PiAgentExecutor` 的工具前审核和 `SettingsSpaceView` 的偏好保存方式
  - [x] 确定逐项确认、本机自动、YOLO 三档的执行范围
- [x] Step 2：实现模式传递与设置界面
  - [x] 每次 task 启动时固定审核模式，执行器按模式决定是否弹出审核
  - [x] 设置页显示三档说明并保存选择，补齐中英文文案
- [x] Step 3：验证与独立 review
  - [x] 类型检查、iOS／Android 模式行为探针与设置页持久化测试通过
  - [x] 子 agent 独立 review 无实际缺陷；本轮差异已提交

### Android 实时语音后页面卡死修复（2026-11-08）

- [x] Step 1：魅族 20 Pro 真机复现，并通过关闭自动唤醒的对照试验定位到唤醒词线程
- [x] Step 2：修复音频错误重置时的条件变量身份丢失，增加针对死锁路径的回归测试；测试修复前失败、修复后通过
- [x] Step 3：Rust 单元测试 17/17 通过；修复版 APK 覆盖安装到魅族 20 Pro，启动实时对话并等待 18 秒后，“对话”输入框及“连接”页均可正常打开；独立 review 通过

### ChatGPT 订阅登录回调重试（2026-11-08）

- [x] Step 1：定位手动回调提交后立即消耗 prompt、错误链接导致授权流程退出的原因
- [x] Step 2：提交前核对回调地址与当前授权 state；错误时清空输入框并保留授权页面
- [x] Step 3：按用户要求移除依赖补丁，保留应用内回调链接校验和输入框清空行为
- [x] Step 4：覆盖格式错误、state 不匹配后继续等待及取消；相关运行时用例与类型检查通过

### LOOI 具身底座 SDK 接入 NSH 应用（2026-11-08）

对齐 [`docs/plans/nsh-looi-sdk-integration-plan.md`](docs/plans/nsh-looi-sdk-integration-plan.md) 与 Nano Banana V2 暗黑版设计稿：合并 `@sourcebug/looi-sdk` 与 `@super-looi/looi-driver`，实现 iOS / Android 双端原生 `LooiBle` 桥接与 `BodyRuntime`，接入实时语音与 Pi Agent 双通道具身工具，落地去工程化的「底座」管理空间（极简状态卡 + 经典圆形方向轮盘 + 纵向头部俯仰滑动条 + 补光灯开关）。

- [x] **Step 0：产品需求文档、Nano Banana V2 设计稿与技术方案定稿 (`docs/plans/nsh-looi-sdk-integration-plan.md`)**
  - [x] 梳理 `@super-looi/looi-driver` 与 `archive/legacy-v1` SDK 能力边界，确定 Thin Pollable Rust `LooiBle` + Deep TS `BodySupervisor` 架构
  - [x] 使用 Nano Banana 生成并迭代去工程化 V2 设计稿，敲定以暗黑版双内嵌面板布局为准（前台桌宠主页零额外胶囊打扰，后台左栏抓大放小，右栏经典圆形方向轮盘 + 纵向头部滑动条 + 补光灯胶囊）
- [x] **Step 1：扩展 `@super-looi/looi-driver` 扫描、定向连接与姿态/灯光高层接口 (`packages/looi-driver`)**
  - [x] 扩展 `transport.ts`：新增 `LooiDeviceCandidate`、`LooiConnectTarget`、`scanCandidates` 与 `SimulatedBleTransport` 虚拟候选及 `simulateDock(docked)`
  - [x] 扩展 `body-supervisor.ts`：新增 `BodySupervisorSnapshot`、`getSnapshot()`、`setHead(pose)`、`setLight(on)` 与状态变更监听
  - [x] 扩充并通过 `packages/looi-driver/test/body-supervisor.test.ts` 单元测试（16/16 通过）
- [x] **Step 2：实现双端原生蓝牙桥接 `LooiBle` 与权限插件 (`apps/nsh/src/ble*`, `apps/nsh/native/`)**
  - [x] 实现 `apps/nsh/src/ble.rs`（有界事件队列、代际隔离、脱座 `06` 与退后台自动下发 `fed0:0000` 急停安全律及 Rust 单元测试）
  - [x] 实现 iOS `CoreBluetooth` 后端 `apps/nsh/src/ble/ios.rs` 与 Android `BluetoothGatt` 后端 `apps/nsh/src/ble/android.rs` + `LooiBleBridge.java`
  - [x] 在 `apps/nsh/src/lib.rs` 注册 `LooiBle`，更新 `apps/nsh/native/plugins.json` 与 `apps/nsh/scripts/native-plugins.mjs` 注入 iOS/Android 蓝牙权限（`cargo test` 与 `test:plugins` 通过）
- [x] **Step 3：实现 `BodyRuntime` 并打通 Agent 与实时语音双通道具身工具 (`apps/nsh/runtime/`)**
  - [x] 新增 `apps/nsh/runtime/body.ts`：封装 `NshNativeBleAdapter`、`BodyRuntime`（`real_ble` / `simulation` / `disabled` 模式、自动重连、脉冲与姿态控制、结构化回执）
  - [x] 升级 `apps/nsh/runtime/application.ts`：接入 `BodyRuntime`、SQLite `body_action_evidence` 表与 `get_looi_body_status` / `control_looi_body` 工具
  - [x] 新增 `apps/nsh/runtime/voice/tools/control-looi-body.ts` 并接入 `VoiceRuntime` 低延迟语音具身控制与打断急停联动
  - [x] 更新 `apps/nsh/scripts/build-runtime.ts` 打包 `@super-looi/looi-driver` 并导出类型声明（`tsc -p tsconfig.runtime.json` 与 `test:voice-runtime` 通过）
- [x] **Step 4：实现后台「底座」空间 UI 与状态管理 (`apps/nsh/store.ts`, `apps/nsh/ui/`)**
  - [x] 升级 `apps/nsh/store.ts`：新增 `body` 空间路由、响应式状态、模式/扫描/连接/轮盘/滑轨/补光灯操作及退后台急停联动
  - [x] 升级 `apps/nsh/ui/ManagementShell.tsx` 并新增 `apps/nsh/ui/BodySpaceView.tsx`（严格还原暗黑版双内嵌面板布局：左栏大字号设备卡 + 右栏经典圆形方向轮盘 + 纵向头部俯仰滑动条 + 补光灯胶囊）
  - [x] 升级 `apps/nsh/ui/TasksSpaceView.tsx` 展示任务关联的 `bodyActions` 执行记录
- [x] **Step 5：更新架构文档、全量测试、iOS 模拟器实机截图验证与独立子 Agent 审查**
  - [x] 更新 `docs/arch/index.html`、`docs/arch/architecture.js`、`docs/arch/sources.js` 与 `todo.md`
  - [x] 新增 `apps/nsh/tests/body-runtime-cases.ts`，通过全仓 `pnpm build`、`pnpm typecheck`、`pnpm test` 与 `cargo test`（NSH 23/23 通过）
  - [x] 在 iOS 模拟器实机验证日间/夜间模式下的「底座」空间经典轮盘与头部滑动条交互并截图（`docs/artifacts/nsh-node-compat/ios-settings-body.png`, `ios-settings-body-light.png`）
  - [x] 调度独立 review 子 Agent 审查，修复全部 5 项审查建议并复审通过（PASS），完成 Git 提交

### Langfuse 语音会话消息与 LLM 调用可见性（2026-11-08）

- [x] Step 1：核对截图对应的 Langfuse 会话，确认用户转写和两次 `llm.chat` 已入库；定位 Session 页只呈现 AI 消息的输入输出结构问题
- [x] Step 2：在 `realtime.response` 记录按轮次排序的 `role/content` 输入与输出；晚到 ASR 归位后导出并保留模型回复完成时间；失败的 `llm.chat` 写入错误原因
- [x] Step 3：运行相关测试和类型检查，验证本地 Langfuse 展示效果，完成独立 review 与提交
  - [x] 8 项遥测测试、运行时类型检查、NSH 语音集成测试、类型检查和构建通过
  - [x] 本地 Langfuse Session 页已显示两轮用户消息与助手回复；LLM 失败原因已通过 Observations v2 API 回读
  - [x] 独立复审发现并修复 ASR 失败时待导出响应未释放；iPhone 16e 模拟器已连接新构建

### LOOI 原创暖机械音复刻参考（2026-11-08）

- [x] Step 1：确定偏中性、机灵温暖且有明确电子质感的声线；核对豆包复刻参考音频规格
- [x] Step 2：合成单人中文底稿，通过降调、72 Hz 环形调制和轻微镶边效果制作持续机械质感，导出复刻参考 WAV
- [x] Step 3：检查音频为 14.52 秒、24 kHz 单声道 PCM、峰值 -4.5 dB，无长静音；提供试听文件

### NSH 豆包自定义输出音色（2026-11-08）

- [x] Step 1：让豆包协议握手接收可选 Speaker ID，保留现有默认音色
- [x] Step 2：在 VoiceRuntime 持久保存 Speaker ID，并在语音设置中支持填写和恢复默认
- [x] Step 3：协议与语音运行时测试、NSH 类型检查及 19/19 全量测试通过；iOS 模拟器截图核对布局，独立 review 指出的空输入、连接时序和错误提示问题已修复

### NSH 本地 Langfuse 无对话记录修复（2026-11-08）

- [x] Step 1：从 Langfuse v2 API 确认只有探针、没有用户对话观测；核对 iPhone 16e 的运行配置
- [x] Step 2：为 NSH 增加 `localhost:3000` 的 HTTP POST 权限，导出失败时输出一次错误日志
- [x] Step 3：iPhone 16e 中的诊断 Span 通过 5 秒定时导出写入 Langfuse；移除临时探针并重启 NSH
- [x] Step 4：iPhone 16e 实际语音会话写入 `voice.session`、3 个 `realtime.user_turn` 与 2 个 `realtime.response`；发现用户转写文本未写入，转入下项修复

### 豆包用户话语写入 Langfuse（2026-11-08）

- [x] Step 1：查到真实 Trace 中 3 个用户轮次有音频时长、无文本；核对豆包 Seeduplex ASR 事件字段
- [x] Step 2：读取 `conversation.item.input_audio_transcription.delta`，在 `completed` 无文本时使用该轮最新识别结果
- [x] Step 3：运行时协议与观测测试、NSH 语音测试及类型检查通过；iPhone 16e 已重启为追踪开启的修复版
- [x] Step 4：真实语音 Trace 已包含用户文本与回复文本；发现豆包的 `delta` 返回整段更新，拼接会重复
- [x] Step 5：iPhone 16e 真实会话 `5d07f54f169c44c89764f58408762ac6` 中 `voice.session.input.userTranscripts` 与用户轮次输出均包含“现在几点了？”，无重复拼接

### Langfuse v4 与多厂商 Realtime 接入（2026-11-08）

- [x] Step 1：建立 Realtime 协议适配器并迁移语音运行时
  - [x] 豆包与 OpenAI GA 握手、事件、工具回执和打断
  - [x] 凭据隔离、热更新、字幕与音频播放归属
- [x] Step 2：接入 Langfuse OTLP 追踪与 Voice → Agent 上下文
  - [x] 本地 Compose、构建配置与密钥隔离
  - [x] Voice Socket、Agent StreamFn 和工具观测
- [x] Step 3：验证、独立 review、文档与分阶段提交
  - [x] 全仓 `pnpm typecheck`、`pnpm test`、`pnpm build` 通过；协议、语音运行时、OTLP、跨层 Trace 与构建密钥隔离测试通过
  - [x] Langfuse v4 Compose 六个服务启动；OTLP 写入后 Observations v2 可读回观测
  - [x] 独立 review 的构建密钥、Compose 密钥长度、打断竞态、静音轮次、握手时长、凭据脱敏及晚到 ASR 问题已修复并复审通过
  - [x] 从 Pi 归一化的首条 system message 提取 System Prompt 与工具定义；运行时 75 项测试和全仓类型检查通过
  - [x] 更新架构图与源码快照，分阶段提交核心实现和集成改动


### 模型配置按账号加载可用模型（2026-11-08）

- [x] Step 1：定位右侧静态列表与订阅授权后的数据流
- [x] Step 2：在授权或保存凭证后拉取 `/models`，打开已有连接时刷新；右侧仅展示在线结果和手动模型
- [x] Step 3：核对 OpenAI 订阅与兼容 API 返回格式，完成 NSH 检查、UI 测试与独立 review
  - [x] 模型列表 3 项协议/选型测试、NSH 19 项及运行时 68 项测试、类型检查与构建通过
  - [x] iPhone 16e 模拟器 UI 测试通过；测试网络返回两条账号模型，截图确认右栏展示 ID 与名称
  - [x] 独立 review 指出的非聊天模型筛选、旧账号异步覆盖、订阅初次选型和在线型号持久化问题已修复并复审通过

### NSH 语音工具定义与执行聚合（2026-11-08）

- [x] Step 1：核对两个工具的 schema、执行逻辑及会话状态依赖
- [x] Step 2：将两个工具拆为各自的函数模块，schema 与执行逻辑同处一处
  - [x] `tools/run-agent-task.ts` 管理任务调用；`tools/end-conversation.ts` 管理道别回执和完成状态
  - [x] `tools/index.ts` 只处理共享回执格式与调用去重；`protocol.ts` 组装会话消息
- [x] Step 3：更新会话配置和架构图，完成测试、构建与独立 review
  - [x] NSH `typecheck`、完整 `test`（19/19）和 `build` 通过
  - [x] 架构图锚点与工具源码快照一致；独立 review 通过


### NSH 语音运行时模块拆分（2026-11-08）

- [x] Step 1：梳理 `voice.ts` 职责、调用入口与现有语音测试
- [x] Step 2：建立 `runtime/voice/`，集中模型提示词和 Realtime 会话配置，保留现有公开入口
  - [x] 拆出类型、提示词、协议配置；`VoiceRuntime` 保留原有状态机和调用签名
  - [x] 更新架构图中的语音源码入口与本地快照
- [x] Step 3：完成语音测试、类型检查、构建及独立 review
  - [x] `test:voice-runtime`、NSH `typecheck`、完整 `test`（19/19）与 `build` 通过
  - [x] 架构图源码锚点与语音快照一致；独立 review 未发现回归


### NSH 自动语音唤醒与 Realtime 对话（2026-11-07）

- [x] Step 1：固定 sherpa-onnx 模型与原生库，接入 iOS / Android 构建和 APK 打包
  - [x] 核对发布资产、C API 与唤醒词 token，并实现缓存准备脚本
  - [x] 配置 Cargo 链接、模型内嵌与 Android 原生库注入
- [x] Step 2：实现 Rust 音频单流切换、本地 KWS 工作线程与就绪提示音
  - [x] KWS 模型初始化、专用线程和有界采集队列
  - [x] KWS / conversation 切换、播放排空与音频状态桥接
- [x] Step 3：实现 VoiceRuntime 待机唤醒、Duplex 会话、多轮对话和自动休眠
  - [x] 待机、权限、唤醒、会话结束及道别工具
  - [x] 播放排空、用户语音阶段和 12 秒空闲计时
- [x] Step 4：连接状态管理和首屏、语音管理空间交互
- [x] Step 5：运行测试与 iOS / Android 构建，独立 review 并提交
  - [x] iOS 模拟器真实模型加载与单流切换；Android API 34 模拟器首次授权后 KWS 与单流切换通过
  - [x] Android 三 ABI APK 构建、ELF 与 ZIP 16 KB 对齐验证；iOS 合成 PCM → 豆包 ASR → Agent 工具 → 原生语音输出通过
  - [x] 类型检查、NSH 18 项测试、插件测试和 iOS UI 复核通过；独立 review 指出并复核播放完成与权限时序修复
  - [x] 分阶段提交本次改动

### LIVE 首屏嘴型闪烁修复（2026-11-07）

- [x] Step 1：定位音量阈值导致微笑与波形嘴型反复切换
- [x] Step 2：移除首屏语音波形嘴型及重采样逻辑，保留表情嘴型
- [x] Step 3：完成 NSH 检查、构建、现有测试及 iOS 视觉验证，独立审查并提交
  - [x] `typecheck`、`build` 通过，现有测试 17/17 通过
  - [x] iPhone 16e 模拟器进入 LIVE 聆听，确认微笑嘴型显示
  - [x] 独立审查无功能问题；同步 UI 规范及颜色 Token 用途说明

### 可点击源码的架构图（2026-11-07）

- [x] Step 1：核对当前 NSH / QuickJS / Pi 源码、原生能力与家居调用关系
  - [x] 区分已接入的运行链路与保留的 LOOI 身体驱动
  - [x] 使用 Anthropic frontend-design 技能确定暖白、陶土色的图与源码双栏布局
- [x] Step 2：实现 `docs/arch/index.html` 与源码阅读交互
  - [x] 绘制架构节点、调用关系及任务 / 语音 / 家居路径
  - [x] 内嵌相关源码快照、入口定位与本地文件链接
- [x] Step 3：浏览器验证、独立子 agent 审查与提交
  - [x] 浏览器遍历 16 个节点、40 个文件视图：代码与 37 个原文件一致，全部入口可定位
  - [x] 验证 HTTP 工作区读取、file:// 快照读取、390px 窄屏、搜索、入口跳转与 URL 定位恢复
  - [x] 独立子 agent 复审通过；修复跨视图搜索、语音任务回调箭头与 SVG 文本贴边
  - [x] 更新进度并只提交本次架构图文件

### 语音管理空间 UI 体验优化（去冗余提示、消除 CLS、修复边界溢出）（2026-11-07）

针对横屏与移动端语音配置界面的视觉与交互优化：清除未要求冗余提示文案，将 Toast 提示升级为绝对定位悬浮层消除 CLS 抖动，精简卡片结构与尺寸以消除边界溢出与文字截断。

- [x] **Step 1：精简冗余提示文案与状态展示 (`apps/nsh/ui/VoiceSpaceView.tsx`)**
  - [x] 移除冷门技术参数副标题（`16kHz PCM...`）与未要求的免责/安全废话（系统钥匙串存储声明、麦克风权限隐私声明）
  - [x] 移除卡片右上角与顶栏重复的被挤断徽标（`已配`），保持顶栏统一表达状态
  - [x] 简化输入框占位符、操作按钮文案及 `phaseDescription` 阶段文案
- [x] **Step 2：将 Toast 改为绝对定位悬浮层消除 CLS (`apps/nsh/ui/ManagementShell.tsx`, `apps/nsh/ui/Controls.tsx`)**
  - [x] 在 `ManagementShell.tsx` 中将横屏与竖屏下的 Toast 脱离文档流，改为 `absolute` 浮动层
  - [x] 在 `Controls.tsx` 中优化 `LightToast` 悬浮阴影与层次
  - [x] 缩短保存通知文案，避免打扰用户
- [x] **Step 3：消除横屏下的内容与徽标超出边界问题 (`apps/nsh/ui/VoiceSpaceView.tsx`, `apps/nsh/ui/ManagementShell.tsx`)**
  - [x] 优化卡片内边距与间隙（`p-3.5 gap-3`），卡片首屏完整可见（输入框与保存按钮不被切断）
  - [x] 补齐 `min-h-0`、`min-w-0` 弹性盒属性，确保外层视口自适应与滚动安全兜底
  - [x] 优化 Safe Area 布局：外层移除粗暴的右侧死黑边，横屏顶部 Banner 背景与边框延伸到底，内部操作按钮与下方内容区保留安全区避让保护
- [x] **Step 4：测试与构建验证、独立子 Agent 审查与 Git 提交**
  - [x] 运行 `pnpm --filter @super-looi/nsh typecheck` 和 `test`（17 项全部通过）
  - [x] 启动独立 review 子 agent 审查代码与 UI（审查结论：PASS）
  - [x] 提交 git commit

### LLM 凭证配置标准化与 NSH 前后台一体化重构（2026-11-07）

对齐 [`docs/plans/llm-credential-standardization-plan.md`](docs/plans/llm-credential-standardization-plan.md) 与 [`apps/nsh/DESIGN.md`](apps/nsh/DESIGN.md)：直接复用 `@earendil-works/pi-ai@1.5.0` 标准化多服务商凭证架构，落地「全天候深色省电桌宠主页 + A/B 明暗双主题结构 3 后台管理空间」。

- [x] **Step 0：视觉与架构规范定稿 (`apps/nsh/DESIGN.md`, `docs/plans/llm-credential-standardization-plan.md`)**
  - [x] 敲定「结构 3」后台管理布局（`58pt` 极窄左轨 + `48pt` 横向胶囊顶栏 + `7:5` 平衡双栏工作区，竖屏 `<600pt` 自动折为底栏 + 单列）
  - [x] 敲定全天候深色省电桌宠舞台（白天 `#11100F` 深炭底 + `#FBF7F0` 清朗暖奶米圆眼；夜间 `#040405` 纯黑 OLED 底 + `#E8DAC3` 柔暗暖燕麦米圆眼，去除拟真眼球高光白斑与青色系束缚）与后台 A/B 明暗双主题
  - [x] 完成 `apps/nsh/DESIGN.md` 与 `docs/plans/llm-credential-standardization-plan.md` 编写校验
- [x] **Step 1：构建标准化 LLM Provider 目录与 `VaultCredentialStore` (`packages/looi-runtime`)**
  - [x] 新增 `packages/looi-runtime/src/agent/llm-providers.ts`：定义五大预置服务品牌（`OpenAI / ChatGPT`、`Kimi`、`MiniMax`、`小米 MiMo`、`智谱 / Z.AI` 含标准按量 `zai-cn`/`zai-intl` 与 Coding Plan 区分）+ `custom` 兼容 API（`openai-completions` / `openai-responses` / `anthropic-messages`）目录矩阵
  - [x] 实现版本化 `ModelVaultEnvelope`（`version: 2`）与旧版 `{ baseUrl, model, apiKey, conversationId }` 无损迁移，实现对接 Pi `CredentialStore` 全局单槽互斥读写的 `VaultCredentialStore` 及 `createLooiModelsRegistry`
  - [x] 导出接口并编写单元测试 `packages/looi-runtime/test/llm-providers.test.ts`（68 项测试通过）
- [x] **Step 2：升级 `PiAgentExecutor` 与 `packages/nsh-node-compat` 静态 OAuth 打包支持**
  - [x] 在 `packages/nsh-node-compat` 新增沙盒安全的轻量 `node:http` 回调服务垫片（支撑 `openaiChatGPTOAuth` 竞态回退至手动粘贴回调 URL），并在打包入口静态注册 `registerBunOAuthFlows`（覆盖 `kimiCodingOAuth` 设备码授权与 `openaiChatGPTOAuth`）
  - [x] 升级 `packages/looi-runtime/src/agent/pi-executor.ts`：支持注入共享 `Models` 注册表与 `{ providerId, modelId }` 解析模型和流式函数，100% 兼容既有 `{ baseUrl, apiKey, model }` 与自定义 `streamFn`
  - [x] 通过 `pnpm --filter @super-looi/runtime test` / `typecheck` / `build` 与 `pnpm --filter @super-looi/nsh-node-compat test`
- [x] **Step 3：落地全天候深色桌宠光学 Token 与 A/B 双主题 (`apps/nsh/theme.json`, `apps/nsh/ui/RobotFace.tsx`, `apps/nsh/nsh.json`)**
  - [x] 更新 `apps/nsh/theme.json`：写入 `light`（日间深炭桌宠 + 后台方案 B 暖石日光）与 `dark`（夜间纯黑 OLED 桌宠 + 后台方案 A 中性锌灰）全量语义 Token
  - [x] 更新 `apps/nsh/nsh.json`：切换 `"appearance": "system"`，补充 OAuth 所需的 `"clipboard": true` 与 `"openUrl": { "schemes": ["https"] }` 权限声明
  - [x] 重构 `apps/nsh/ui/RobotFace.tsx`：接入 `eye-core` / `eye-edge` / `eye-halo` / `halo-zero` / `face-stroke` / `face-texture` / `horizon-core` / `horizon-zero`，移除拟真高光白斑（`glint`）与暗底月牙内缘，保留正圆几何、条件眉弧与真实音频 RMS 声波
- [x] **Step 4：升级 `MobileRuntime`、`store.ts` 与「结构 3」后台四空间 UI (`apps/nsh`)**
  - [x] 升级 `apps/nsh/runtime/application.ts` 与 `apps/nsh/scripts/build-runtime.ts`：接入 `VaultCredentialStore` + `createLooiModelsRegistry`，暴露多 Provider 目录快照、API Key 保存/清除、兼容 API 配置、模型切换及 OAuth 登录（设备码通知 / 浏览器回调 URL 提交 / 取消 / 登出）接口，保持旧 `configuration()` / `configure()` 兼容（QuickJS 12 项验收全通过）
  - [x] 升级 `apps/nsh/store.ts`：管理前后台空间路由（`face | models | voice | home | tasks`）、外观切换（`system | light | dark`）、多服务商凭证/模型状态与 OAuth 交互流
  - [x] 实现结构 3 后台管理组件：`ManagementShell.tsx`、`ModelsSpaceView.tsx`、`VoiceSpaceView.tsx`、`HomeSpaceView.tsx`、`TasksSpaceView.tsx`，连通 `apps/nsh/App.tsx` 前台深色省电舞台与后台切换
- [x] **Step 5：全量测试回归、iOS 模拟器双模式实机截图验证与独立子 Agent 审查**
  - [x] 更新并扩充 `apps/nsh/App.test.tsx`、`apps/nsh/HomePanelProbe.tsx`、`apps/nsh/native/android-test/com/superlooi/nsh/test/UiProbe.java` 与 `apps/nsh/scripts/nsh.ts`
  - [x] 运行全套 `typecheck`、`build`、`test`（含 QuickJS 兼容套件）全部通过
  - [x] 在 iOS 模拟器实机验证白天/暗黑模式下的桌宠大脸与结构 3 四空间截图
  - [x] 调度独立审查子 Agent 核验代码与 UI，修复全部审查发现项（离开模型空间自动中止悬空 OAuth、`custom` 兼容保存按钮禁用校验、全量胶囊 `44pt` 触控热区对齐、`openUrl` 异常防御、`DESIGN.md` Token 同步）并提交 Git Commit

### Expo / Hub 退役收尾（2026-11-07）

当前产品采用 NSH 最简 Agent Loop。以下历史阶段的旧端保留、Expo 验证与记忆产品迁移要求由本次退役收尾取代；硬件后续事项统一见 todo.md。归档分支 archive/legacy-hub-and-expo（55f77ef）保留旧端及删除前未提交修改。

- [x] Step 1：归档旧端（包含未提交修改），核对共享代码与回归测试
- [x] Step 2：迁移可复用测试，删除旧应用、依赖与启动配置
- [x] Step 3：更新 NSH 入口、当前说明与待办，移除过时的 Expo 工作项
- [x] Step 4：完成 pnpm 构建、类型检查、测试和 iOS UI 验证，独立审查并提交
  - [x] pnpm build / typecheck / test 通过；共享包 128 项测试、NSH 17 项及 QuickJS 兼容套件通过
  - [x] iOS 首屏真实交互测试通过，检查 ios-face.png 截图
  - [x] 独立审查发现并清除旧 RN 视图文件断言，复审通过

### NSH 首屏 UI 1:1 还原与极简 Agent Loop 减法收敛（2026-11-07）

- [x] **Step 1：运行时做减法 — 移除记忆账本耦合，精简为最简 Agent Loop (`apps/nsh/runtime/*`, `apps/nsh/store.ts`)**
  - [x] 从 `apps/nsh/runtime/application.ts` (`MobileRuntime`) 剥离 `MemoryLedgerService`、`createMemoryClaim`、`memoryTools()`（`recall_memory` / `remember_fact` / `forget_memory`）及 `记住/回忆/忘记` 离线正则拦截，所有对话统一走最简 `PiAgentExecutor` 循环（`read_file`/`read`、`write_file`、`bash`、`ask_user_question` 及可选家居工具）
  - [x] 精简 `apps/nsh/runtime/voice.ts` 与 `apps/nsh/store.ts`：去除语音系统提示词中的记忆描述，支持从顶栏 `LIVE 对话` 胶囊一键开启/打断/关闭实时语音（及在连接设置中统一保存豆包语音 API Key），保留高危/写入工具的单次审批门禁
  - [x] 同步更新 `apps/nsh/scripts/build-runtime.ts` 生成声明与相关测试探针（`verify-mobile-runtime.ts`, `native-voice-pipeline.ts`）
- [x] **Step 2：大脸光学与几何 1:1 还原 (`apps/nsh/ui/RobotFace.tsx`, `apps/nsh/theme.json`)**
  - [x] 移除 `RobotFace.tsx` 的 `bottomInset` 压缩与上移，对齐 `RobotFaceView.tsx` 全屏居中 `620×340` 比例与视口自适应缩放
  - [x] 补齐双椭圆深空蓝氛围背光 (`atmosphere`) 与底部地平线流光 (`horizonGlow`)
  - [x] 修复正圆眼眸光学渲染：移除 `neutral` / `speaking` 状态下的常驻突兀眉弧（仅在 `getEyePosture` 定义的情绪下按角度/位移绘制眉弧），修正径向渐变圆心与半径（消除顶部/两侧死黑蓝圈，还原底部 3D 内阴影月牙边缘、左上高光 `eyeSpecular` 与右下灵动星芒 `eyeSparkle`）
  - [x] 对齐微笑弧度、视线跟随 (`gaze`) 与声波条渲染
- [x] **Step 3：首屏纯粹大脸交互 1:1 还原 (`apps/nsh/App.tsx`, `apps/nsh/ui/Controls.tsx`)**
  - [x] 移除旧首屏左上角粗体 `LOOI` 文字、右上角大号 `任务/连接` 按钮及底部 `家居/LIVE/对话` 按钮栏与状态底栏
  - [x] 还原原版首屏顶栏 (`cornerRow`)：左上角半透明呼吸状态点 + 状态文案（`陪伴待机` / `实时聆听中` / `Agent 思考中` / `LOOI 说话中`）；右上角精修 `LIVE 对话` 流光胶囊（含状态点与 `LIVE 中`/`打断` 态）、`对话` 胶囊及轻量 `连接` 入口
  - [x] 还原顶栏下方内联悬浮输入框 (`askBar`)、居中轻提示胶囊 (`LightToastCapsule`)、底部对称 7 阶声波纹 + 声波括号唤醒引导栏 (`wakeGuide`：`说 Hey LOOI 唤醒我 · 轻触开启 LIVE 对话`)、底部玻璃字幕胶囊 (`ConversationSubtitleOverlay`) 与右下角 `停止任务` 胶囊
  - [x] 将模型配置与豆包语音 API Key 整合进统一的 `连接设置` 弹窗，移除首屏多余二级面板入口（保留组件源码不删除）
- [x] **Step 4：测试回归、iOS 模拟器实机截图核验与独立子 Agent Review**
  - [x] 更新 `apps/nsh/App.test.tsx`、`apps/nsh/scripts/nsh.ts`、`apps/nsh/tests/native_compat.rs`、`apps/nsh/tests/native-voice-pipeline.ts` 与 `apps/nsh/native/android-test/com/superlooi/nsh/test/UiProbe.java`
  - [x] 运行 `pnpm --filter @super-looi/nsh typecheck`、`pnpm --filter @super-looi/nsh test`（17/17 通过）、`pnpm --filter @super-looi/nsh-node-compat test`（20/20 验收套件通过）及共享包测试
  - [x] 在 iOS 模拟器运行 `pnpm --filter @super-looi/nsh test:ui:ios` 截取 `docs/artifacts/nsh-node-compat/ios-face.png` 与 `ios-settings.png`，对比 `pure-face-minimal-runtime.png` 核验 1:1 还原度
  - [x] 调用独立子 Agent 进行代码与 UI 审查，修复 4 项审查发现（`store.ts` 表情切换防打断眨眼保护、`RobotFace.tsx` 呼吸动画 `computed` 隔离、`TasksPanel.tsx` 过期文案清理、Android `UiProbe.java` 验收流同步）并更新 `progress.md` / `todo.md` 提交 Git Commit

### NSH 计划续推与版本复验（2026-11-07）

用户确认本轮先完成模拟器软件验收；真机媒体/BLE/底座验收另行保留。

- [x] Step 1：核对既有实现、工作树与未完成门禁；调度 GPT-6.1 Sol 独立核验
- [x] Step 2：固定 Pi 1.5.0 / NSH 0.4.0 的 QuickJS、engine、iOS、Android 验收矩阵
  - [x] 四包、Rust 5 项、真实网关与移动适配 SDK 验证；透明 root SDK 36 个构建错误仍单独记录
  - [x] 双端十套宿主回归与 Release 冷启动、离线记忆/安全凭据重开；两平台业务bytecode一致；Android产品两轮真网对话通过
- [x] Step 3：补齐本机真实模型网络与任务闭环，修复复验发现
  - [x] iOS / Android MobileRuntime 使用原生 fetch 完成真实模型任务；内存凭据、临时测试入口清理
  - [x] 修复模型配置安全存储失败后的旧执行器恢复；新增第十套 QuickJS 回归
  - [x] 修正 iOS simulator Release Keychain 身份选择
  - [x] 实际 createAgentSession 双端原生真网：模型write/read、精确回复、JSONL工具回执与最终回复恢复通过
- [ ] Step 4：推进领域能力迁移，逐项满足删除门禁
  - [x] 修复底座计时伪证据；主动观察缺少本次有效稳定性证据时停止；324 JS/10 NSH全仓通过，最终24相关测试与QuickJS48契约通过，Sol复审通过
  - [ ] 家居运行时与设置完整验收
    - [x] 安全单槽凭据、HA/MIoT/显式模拟模式、generation隔离、请求去重；Node与真QuickJS fixture通过
    - [x] 主agent接入Agent单次审批、下发前SQLite intent/回执、取消中断与unknown恢复；Sol独立复审通过
    - [x] 取消预读不写、已派发取消不重试；unknown计入恢复状态并阻止原会话继续
    - [x] HA/演示设置双端移动UI；iOS脚本与Android系统输入实际点击通过
    - [ ] MIoT登录入口验收
      - [x] 原生专用浏览器、回调导航/资源阻断、一次性消费及生命周期；6 Rust登录测试/Android插件测试/NSH16项通过，Sol复审通过
      - [x] 双端最终原生窗口冒烟复验：真实窗口展示/无效URL拒绝/并发owner拒绝/取消均通过；Android三ABI编译，执行为API34 ARM64
      - [x] OAuth提交点动态native consumed/expiry/代际guard；异常视为失效，CAS从最新vault仅回滚本次值；13 OAuth与6类真实单槽竞态、Flow/QuickJS通过并独立复审
      - [x] 产品区域/登录/取消/退出/刷新接线；双端实际选择新加坡、打开官方页并原生取消返回通过，未输入账号；已保存账号UI作用域测试通过
      - [ ] 本地GET/POST307/子资源回调零请求fixture及完整OAuth fixture验收
  - [ ] 原生语音与协议接线
    - [x] PCM16k采集/24k播放、有界队列/背压/静音；7 Rust单测与双端实际cross-check通过
    - [x] iOS原生后台/中断/路由停止，Android失焦锁存/AAudio确认清空；独立复审通过
    - [x] 双端模拟器真实原生静音PCM enqueue/clear/stop通过（未使用麦克风）
    - [x] WebSocket协议与UI确认后共享Agent调用；真QuickJS/双端fixture通过，独立复审通过
    - [x] 旧连接写失败隔离、旧音频取消屏障、重复工具去重、损坏语音凭据可重配
    - [x] 双端真实原生WebSocket、合成PCM与response.canceled确认；各247808字节，不采集麦克风/不写产品凭据
    - [x] 双端合成PCM→真实ASR→一次实际Agent记忆查询→原生语音回复；输出55296/75776字节，独立有界队列保持打断响应
    - [x] iOS未授权麦克风启动原生拒绝，无权限提示；双端实际采集/AEC效果仍留待硬件验收
  - [x] 任务详情与新对话双端移动UI验收
    - [x] 十项分页、unknown优先、只读详情含家居回执、新对话保留任务；QuickJS副本/会话隔离/重开测试通过
  - [x] 保留每轮独立 task 的持久对话 session；同会话并发与 unknown 结果隔离；Node 11项和QuickJS重启/切换测试通过
  - [x] BLE纯逻辑迁移前修复：重连断线监听、通知ticket清理、迟到连接/并发断开与同步异常重试；15项测试及独立复审通过
  - [ ] NSH真实BLE原生桥、MIoT安全登录WebView、旧数据迁入仍待落地
- [x] Step 5：本阶段独立复审、记录证据并分阶段提交；全仓build/typecheck/test通过（323项JS、10项NSH），完整业务迁移保持未完成

### NSH Node 兼容层与 Pi 落地（2026-11-06）

- [x] **Step 1：固定依赖与运行时事实**
  - [x] 读取方案、仓库指令与工作树；隔离既有语音修改
  - [x] 固定 NSH VM quickjs-jit 0.14.1 / Pi 1.5.0 / Cargo.lock，实测并记录完整 SDK 与 codemode 门禁
- [ ] **Step 2：独立 Rust + QuickJS 兼容包**
  - [x] cap-std 沙盒、稳定文件句柄/偏移读取、SQLite WAL/事务与预算、哈希/压缩、notify 监听（行扫描仍复用 upstream JS）
  - [x] Deno parser + 能力内置 Shell、异步取消/退出回执、结构/时间/输出预算与不支持参数拒绝
  - [x] JS 垫片、严格 bundler 别名与独立 QuickJS runner，Node 不参与运行被测 bundle
  - [x] Rust 兼容库 aarch64-apple-ios-sim cargo check 通过；移动目标启用 bindgen 解决固定 VM 缺失预生成 bindings
  - [ ] NSH 双端宿主与发行构建；双端模拟器已通过，签名发行待完成
    - [x] 构建固定 NSH 0.4.0 / e626a8d CLI，混合模板 check / 首个 headless 交互测试通过
    - [x] 提取 runtime-neutral Bridge，注册真实 NodeCompat 原生 class；宿主注入 System.data_dir 与 FS grant 校验，JS 不传宿主路径
    - [x] Shell/std thread + oneshot 可在无 Tokio 的 NSH executor 等待；任务票据单消费、完成未消费与丢弃等待仍约束实际 worker 容量
    - [x] codemode stop 同步入队，丢弃 wait 不阻断 VM 退出/容量释放；五项 Rust 回归通过
    - [x] 同一套 node shims / codemode / SDK 在真实 NSH hardened engine + native class、256 MiB embedding 配额执行通过
    - [x] iOS 模拟器真实 NSH 宿主运行原生 class：文件/SQLite/Shell、codemode、实际 SDK 七工具与会话恢复全部通过
    - [x] 全部八组兼容套件在 NSH hardened engine（256 MiB）与 iOS 模拟器通过；测试预编译入口压缩后解决开发传输断连
    - [x] Android API 34 ARM64 模拟器八套原生测试；Release APK 编译 arm64-v8a / armeabi-v7a（debug 签名，非商店发行）
    - [x] 双端模拟器 Release 无开发服务器冷启动、离线记忆与安全配置重开
    - [ ] 商店签名 / Android API 36 与 AAB；32位ABI执行
- [ ] **Step 3：Pi 四包真实 QuickJS 验证**
  - [x] agent-core 真 QuickJS 多轮工具、steer/follow-up 与 abort
  - [x] pi-ai 模型/SSE/UTF-8/工具参数流；Rust HTTPS → QuickJS 上游 SDK 的真实 .env 网关调用通过
  - [x] durable Harness / 四工具 / SQLite journal 关闭重开、真正 SIGKILL 后恢复一次生成与 requestId 去重
  - [x] portable codemode：Rust 原生隔离 VM 适配上游 RemoteCodemodeSandbox 协议（本机进程内，不增加外部服务）
    - [x] 复用上游 PRELUDE_SOURCE，独立线程/VM 与工具消息桥接
    - [x] 内存/时间/取消、输出/store/异常与沙盒越权验证
    - [x] deterministic start/deliver/replay 与 Durable Codemode 集成
    - [x] async continuation 超时、原生入场/帧/乱序结果字节上限、饱和时停止回执与容量复用回归
  - [x] coding-agent headless source entries 的 SessionManager JSONL 恢复与七工具（find/bash 注入 Operations）
  - [x] coding-agent 实际 createAgentSession / ModelRuntime / DefaultResourceLoader：显式移动 SDK 适配模式，七个默认工具与 JSONL 恢复、正常退出通过
    - [x] 默认 find/grep 接 Rust fd/rg；process.kill 只取消沙盒 actor；Unicode Segmenter 使用 ICU
    - [x] 隔离桌面 TUI/图片处理、动态 TS 编译、本机 TCP OAuth；预编译扩展注册与原生深链适配入口
    - [x] 修复固定 stdlib AbortSignal.any 的 Rust opaque callback 引用环，真实 QuickJS GC 退出回归通过
    - [ ] NSH 原生网络对象、图片与默认安全凭据接入后的实际手机端 SDK 验证
- [ ] **Step 4：业务接入与迁移门禁**
  - [x] 提取 @super-looi/runtime：Agent/任务/记忆/48 项验收与纯 UI 状态机；Hub/Expo 暂以兼容转发保留路径
    - [x] 首轮纯逻辑抽取与包构建通过，未触碰四个既有语音修改
    - [x] 替换 C02/C05/D05/H01–H06 常量通过项，补真实隐私/状态机/墓碑恢复断言；48 项已在独立 QuickJS 通过
    - [x] SQLite 记忆/任务连接适配，WAL/FULL、原子墓碑日志、关闭重开与旧备份防复活；QuickJS 实际 Pi 工具回读
    - [x] 双端第九组业务套件；审批/Shell 重定向与动作重放、损坏快照、ContextPack 删除竞态、推断拒绝恢复均补回归并独立复审通过
    - [x] 全仓 build/typecheck/test 通过（315 项 JS 测试、九套 QuickJS、强杀恢复、NSH hardened engine 与初始交互）；CJS 条件导出兼容 Expo 测试加载器
    - [ ] 本机 SQLite 记忆/任务与实际 Agent 工具闭环；同源验收进 NSH 双端
  - [ ] 本机 Agent / 领域工具、凭据和任务持久化接线
    - [x] 原生安全凭据：iOS Keychain / Android Keystore 双端 CRUD；app 自有 entitlement / Application 插件；并发锁与增量 manifest / DEX 回归
    - [x] 原生插件与 App 基础最终复审通过；长回复/审批内容/干净启动已修；非配合工具退出保持 unknown、close 有界失败并补 Node/QuickJS/双端回归
    - [ ] 完整 App Agent 多轮任务与恢复管理验收
    - [x] iOS / Android MobileRuntime 原生 fetch 真网模型单任务完成与关闭（2026-11-07）
    - [x] App 自有主题 / Button / Input / Dialog 与单 Canvas 圆眼首页、本机 SQLite/Agent 服务和生命周期接线
    - [x] iOS 横屏真实 UI 离线记住/回忆/忘记闭环、配置弹窗/键盘及截图；初版弹窗溢出已修复
    - [x] Android 原生 UI 系统自动化通过设置、中文输入及离线记忆闭环；使用独立测试 APK 绕过 NSH test driver Dialog 焦点缺口
    - [x] 全仓 build/typecheck/test 通过（316 项 JS 测试与九套 QuickJS、强杀/预算/原生集成）；双端九套+凭据CRUD；iOS UI和Android系统UI均通过
    - [ ] App 真网模型/语音/硬件继续接线与验收
  - [ ] NSH 移动宿主、语音和 UI 迁移验证；满足替代条件再移除 Hub
- [ ] **Step 5：完整目标验收与交付（持续推进）**
  - [x] 原生宿主阶段全仓 build/typecheck/test 通过（含 NSH hardened engine 回归、初始化交互及原有 307 项业务测试）；iOS 八套原生测试通过；独立复审修复取消生命周期问题
  - [x] 扩展至八组真 QuickJS 套件（含 codemode 与完整 SDK），SIGKILL / runner deadline 仍通过；全仓 build/typecheck/test（307 项既有 JS 测试）、Cargo test 与独立复审通过；本轮移动 App 与去 Hub 尚未完成
  - [x] 全仓 pnpm build/typecheck/test 通过（307 项原有 JS 测试 + 六组 QuickJS / SIGKILL / deadline）；Cargo test、公开包导出检查、独立子 agent 复审通过
  - [x] docs/nsh-node-compat-implementation.md / todo 记录实际证据和剩余门禁；分阶段提交，不勾选完整迁移


### dsh-Go iOS 分支与 issue #609 调研（2026-11-06）

- [x] **Step 1：固定证据范围**
  - [x] 读取 issue #609 及维护者评论，区分上游分支与个人 fork 真机反馈
  - [x] 固定两分支 commit，追踪 iOS 引擎与 framework 修复链路
- [x] **Step 2：运行机制与能力核验**
  - [x] 核对内嵌 Node、DSH runtime 构建/加载、本机协议与手机工具桥接
  - [x] 核对 fs / shell / 子进程、取消/重启、后台与模型调用边界
  - [x] 核对 CI、真机、签名分发证据，修正先前 Android 路线泛化
- [x] **Step 3：项目适用性与交付**
  - [x] 完成 docs/dsh-go-ios-branch-research.md，更新相关调研的版本边界
  - [x] 独立子 agent review，补充 todo，检查链接与提交范围并提交

### Native Shell 迁移可行性调研（Android / iOS，2026-11-06）

- [x] **Step 1：现状与迁移边界**
  - [x] 核对仓库指令、依赖及未提交修改；仅提交本次调研文件
  - [x] 盘点当前 agent loop、端侧家居/语音、机器人首页及硬件依赖
  - [x] 区分无自建服务端、无外部服务与桌面执行能力的边界
- [x] **Step 2：官方能力与源码核验**
  - [x] 核验 NSH 移动打包、QuickJS/Rust 桥接和运行时兼容性
  - [x] 核验 agent 网络流、存储、实时音频、BLE/相机与后台限制
  - [x] 将机器人首页视觉与动画逐项映射到 NSH
- [x] **Step 3：迁移方案与验证门槛**
  - [x] 完成 docs/nsh-mobile-migration-research.md，给出分模块结论与分阶段 PoC
  - [x] 将尚待实测的问题写入 todo.md
- [x] **Step 4：独立审查与交付**
  - [x] 子 agent 独立 review；主 agent 修订证据与结论
  - [x] 检查文档链接、diff 和提交范围，提交调研结果

### 核心架构做减法：极简 Agent Loop + 实时语音层 + 纯粹大脸交互（2026-11-06）

- [x] **Step 1：极简 Agent Loop 重构 (`apps/hub/src/agent/dsh-executor.ts`, `executor.ts`)**
  - [x] 剥离 `MemoryToolBridge` 本地 MCP Server 挂载与 `PersonalMemoryStore` 强制依赖（保留原源码文件不删除）
  - [x] 剥离 `RECEIPTS_PLUGIN` Cordis 切面注入与 SHA-256 文件产物扫描，回归官方 `@deepseek-ai/dsh-sdk-client` (`DeepSeekHarness` + `session.run`) 典型极简用法
  - [x] 保留核心会话执行、实时 `onStep` 通知、原生审批 (`approval/request`) 与追问 (`onUserQuestion`) 交互及取消能力
- [x] **Step 2：双端语音层去记忆化与指令精简 (`apps/hub/src/voice/doubao-engine.ts`, `apps/hub/src/app.ts`, `apps/mobile/src/runtime/*`)**
  - [x] 精简 `DEFAULT_LOOI_VOICE_TOOLS`：移除 `remember_fact`、`recall_memory`，仅保留 `HOME_VOICE_TOOLS` 与 `run_agent_task`
  - [x] 精简 `DEFAULT_LOOI_INSTRUCTIONS`：去除个人记忆指令与 `<personal_memory>` 注入，聚焦自然陪伴对话、智能家居控制与 `run_agent_task`
  - [x] 精简 Hub `/ws/voice`：移除 `remember_fact` / `recall_memory` 工具分支及用户口述“记住...”正则自动写盘逻辑
  - [x] 精简移动端 `LocalControlCenter` 与 `LocalVoiceSocket`：移除本机语音记忆工具（`remember_fact` / `recall_memory` / `forget_memory`）与本机记忆自动同步
- [x] **Step 3：移动端与 Web 控制台回归纯粹大脸交互（全部次级页面隐藏，保留源码文件）**
  - [x] 重构 `apps/mobile/app/index.tsx`：移除右上角 `LAB` 按钮、隐藏 `QuickDrawerOverlay` 快捷抽屉与全部二级空间入口（回忆册、任务、家居、维修舱、SIM LAB），首屏仅呈现纯粹 `RobotFaceView` 大脸 + `LIVE 对话` + `对话` 文本输入 + 字幕/状态提示 + `停止任务` / `AgentInteractionSheet`
  - [x] 移除 `index.tsx` 启动时拉取 `/api/agent/memories` 及同步回忆册的副作用
  - [x] 同步隐藏 Hub Web 控制台 (`apps/hub/src/console-html.ts`) 的次级空间抽屉与 LAB 入口，聚焦全屏大脸与实时语音/Agent 交互
- [x] **Step 4：测试套件对齐、iOS 模拟器验证与独立子 Agent Review**
  - [x] 更新受减法影响的单元与集成测试，运行全仓 `pnpm typecheck`、`pnpm test`、`pnpm build` 确保 100% 通过
  - [x] 在 iOS 模拟器验证纯粹大脸首屏 UI 与实时语音/对话框交互，截图留存 (`docs/artifacts/pure-face-minimal-runtime.png`)
  - [x] 调用独立子 Agent 进行代码审查，修复发现项并归档提交

### 全部本地改动合并发布到 main（2026-11-06）

- [x] **Step 1：发布范围与备份**
  - [x] 确认包含 65 个未进入远端 main 的提交及 7 个原始未提交文件
  - [x] 用户改为单一 commit 直接发布 main；保留原分支与本地改动备份
- [x] **Step 2：独立审查与验证**
  - [x] 子 agent 独立审查未提交语音改动；主 agent 修复握手断线清理、排队控制阻塞与跨轮记忆兜底
  - [x] 增加 4 项 WebSocket 回归；全仓 pnpm build / typecheck / test 通过（305 项测试），diff 检查通过
- [x] **Step 3：单一提交发布准备**
  - [x] 确定以 origin/main 为父提交，完整保留当前本地文件状态；原功能分支与旧本地 main 另行保留
  - [x] 发布采用正常快进推送 main，不强推；最终提交 hash 与远端核对结果记录在本轮交付回执

### 家居空间 UI 交互、点按与页面体验深度优化（2026-11-06）

- [x] **Step 1：乐观控制状态机与无噪提示重构 (`home-control-interaction.ts`, `BrightnessSliderBar.tsx`, `ToggleSwitch.tsx`)**
  - [x] 升级 `HomeControlInteraction`：在 `pending` 与云端延迟同步 (`uncertain`) 窗口期间持续维持用户显式请求的乐观目标状态（`on`、`brightness`、`color_temp_kelvin`），杜绝云端回读晚到导致的开关/滑块跳回旧值
  - [x] 移除常规调节与云端延迟同步时的冗余 Toast 弹窗（如“尚未确认，正在同步设备状态”、“配置已保存”等），仅在明确拒绝 (`rejected`) 时回退并内联提示
  - [x] 升级 `BrightnessSliderBar`：支持 `inactive`（关灯弱化态，避免关灯时滑轨依然高亮发光）、支持拖拽态实时高亮对应档位与容差匹配（`±2%`），保留全部现有手势仲裁与无障碍不变量
- [x] **Step 2：紧凑 Bento 顶栏、房间/分类筛选与高质感设备卡片 (`ConnectedHomeSpaceView.tsx`)**
  - [x] 合并 `LocalHomeSpaceView` 与 `ConnectedHomeSpaceView` 的双重顶栏、搜索栏与分类栏为紧凑 Bento 顶栏，释放横屏首屏视口高度，确保首屏完整呈现 2×2 设备卡片
  - [x] 新增房间快速筛选胶囊（`全部房间` + 动态提取房间列表）、分类计数角标（`设备控制`、`传感器`、`全部`）与按需展开/一键清空（`×`）搜索框，修复清空搜索重置分类的交互断层
  - [x] 重塑设备卡片视觉：补齐发光图标底座 (`deviceIconBox`)、设备名称智能去重与房间胶囊、顶部语义状态徽章 (`statusPill`)、开启态环境流光渐变 (`cardOn`)、带冷暖色点与当前选中态的色温预设胶囊，以及传感器/二进制传感器的自然中文格式化
  - [x] 统一全量点按反馈（`opacity + scale`、`disabled` 视觉降级、刷新状态指示）
- [x] **Step 3：点击卡片进入「设备详情与精细调节」抽屉面板 (`HomeDeviceDetailModal.tsx`, `ConnectedHomeSpaceView.tsx`)**
  - [x] 保持卡片右侧仅 `ToggleSwitch` 直接切换开关；点击设备卡片主体打开「设备详情与精细设置」毛玻璃浮层面板
  - [x] 灯光详情支持：4 组一键光效场景（`阅读专注`、`温馨夜读`、`柔和起夜`、`明亮清冷`）、全宽精细亮度滑轨与 `±10%` 微调步进、5 档全范围色温预设与 `±200K` 微调步进
  - [x] 风扇/开关/传感器详情支持：大尺寸开关与状态概览、自动聚合展示同一物理设备（同 `device_id` / `device_name`）下的所有关联传感器与状态属性、更新时间与能力清单
- [x] **Step 4：「连接设置」弹窗双栏/分区重构与保存语义统一 (`LocalHomeSpaceView.tsx`, `HomeSpaceView.tsx`)**
  - [x] 修复「连接设置」弹窗右上角“完成”丢弃修改与双保存按钮的语义冲突：改为明确的关闭按钮 + 遮罩点击关闭 + 底部统一「保存并生效」主操作入口（米家 OAuth 登录独立触发）
  - [x] 优化横屏弹窗布局为高密度左右双栏/分区结构（左侧家居连接方式与参数、右侧语音与记忆运行位置），消除横屏大幅纵向滚动与顶部截断
  - [x] 同步优化 `HomeSpaceView.tsx` 演示页的乐观交互与关灯滑轨弱化，确保全部既有测试与新增交互测试 100% 通过
- [x] **Step 5：自动化测试、iOS 模拟器实机核验与独立子 Agent Review**
  - [x] 新增/更新单元与交互测试，运行全仓 `pnpm typecheck`、`pnpm test`、`pnpm build`
  - [x] 在 iOS 模拟器实机验证并截图检查首屏密度、乐观开关/调光、设备详情弹窗与连接设置弹窗
  - [x] 调用独立子 Agent 进行代码审查，修复发现项并归档提交

### 本机控制中心收尾 · H3 / H4（2026-11-06）

- [x] **Step 1：宿主与原生依赖**
  - [x] 安全存储、加密、WebView 与 Expo 插件；对齐原生开发包依赖
  - [x] 本机运行时持久配置、账号与模式切换、前台恢复及后台停轮询
- [x] **Step 2：家居登录与实际页面**
  - [x] 米家 WebView 严格回调拦截；外部 HA / 离线演示 / Hub 兼容
  - [x] 设备列表、控制和全局状态从同一个运行时读取，失败无演示回退
- [x] **Step 3：本机记忆与直连语音**
  - [x] 文件持久记忆与删除代际 / 证据记录；回忆册真实编辑删除
  - [x] 豆包直连桥接、工具调用、20ms PCM 节拍、打断与零重放
  - [x] App LIVE / 文本入口接本机模式；API Key 存系统安全存储
- [x] **Step 4：软件验证与交付**
  - [x] 故障与并发测试、全仓 290 项检查、React Doctor 增量无问题
  - [x] iOS 构建 / 模拟器核验；独立 review 和修复
  - [x] 记录真实授权 / 硬件验收边界，更新 todo / docs 并提交


- [ ] **本人授权 / 硬件验收**：米家真实授权与设备回读、手机 LIVE 实录、Android 真机；保留 todo 待办，不以演示或 Node 实测替代。

### 本机家居运行时实施 · Phase H2（2026-11-06）

- [x] **Step 1：协议与实施边界**
  - [x] 核对官方集成本地源码及公开上游；确认 OAuth、区域主机、请求头与批量协议
  - [x] 保留现有语音、控制台、研究文档与 todo 其他修改；跳过文档重新解析
- [x] **Step 2：认证生命周期**
  - [x] 实现独立 OAuth 会话、严格回调匹配、state 校验与一次性换票
  - [x] 注入安全凭据存储和随机源；实现 70% 生命周期刷新、并发合并及注销防迟到写回
  - [x] 验证大整数 client_id 精度、地区隔离、超时与错误脱敏
- [x] **Step 3：MIoT 协议与规格**
  - [x] 获取家庭 / 房间 / 分页设备清单，批量属性读取与单次写入
  - [x] 规格解析与可注入缓存；能力保守映射、亮度与色温范围换算
  - [x] 直连传输接通统一网关，白名单控制与真实回读确认
- [x] **Step 4：验证与交付**
  - [x] 45 台 / 1121 实体规模、部分失败、陈旧回读与断线零重放测试
  - [x] 全仓 build / typecheck / test（274 项测试）；独立子 agent review 与修复
  - [x] 更新阶段说明、todo 与进度并提交
- [ ] **后续 H3 / H4**：移动端安全存储与 WebView 登录、本机语音和记忆；真实账号 / 物理设备另行验收


### 本机家居运行时实施 · Phase H1（2026-11-06）

- [x] **Step 1：确认迁移边界**
  - [x] 对齐调研中的 H1–H4 顺序；本阶段完成共享包与 Hub 迁移
  - [x] 记录现有未提交改动，保留其他任务的语音、控制台与研究文档修改
- [x] **Step 2：建立跨平台共享包**
  - [x] 抽离网关、规则引擎、语音工具与仿真传输
  - [x] 去除 Node 内置依赖及语音引擎反向依赖
  - [x] 迁移 REST 与 WebSocket 注册表；使用可注入的标准网络接口
  - [x] 提供 React Native 源码入口与无 Node 类型的编译检查
- [x] **Step 3：接通现有 Hub**
  - [x] Hub 家居模块改为共享包兼容导出；Fastify 与环境配置留在 Hub
  - [x] 原有家居与 48 项安全验收沿用同一实现
- [x] **Step 4：验证与交付**
  - [x] 补充跨平台网络、超时清理、注册表失败与包边界测试
  - [x] 全仓 build / typecheck / test（246 项测试通过）
  - [x] 子 agent 独立 review，主 agent 修复并复验
  - [x] 更新 todo.md 与阶段说明，提交本阶段产物
- [ ] **后续 H2–H4**：米家 OAuth / MIoT 直连、移动端三模式登录流、本机语音与记忆闭环


### Home Assistant 内置移动运行时调研（2026-11-05）

- [x] **Step 1：证据与现状**
  - [x] 固定 dsh-Go 源码版本，核对打包、安装、启动与保活实现
  - [x] 核对 HA / Xiaomi Home、Android / iOS 的平台约束
  - [x] 映射 Super-LOOI 当前数据、凭据与进程依赖
- [x] **Step 2：架构与验证路线**
  - [x] 定义本机持久化、故障恢复与不支持场景
  - [x] 编写迁移边界、分阶段 PoC 与可测验收门槛
- [x] **Step 3：交付**
  - [x] 独立审查并修正文档，将未决项写入 todo.md
  - [x] 提交本轮调研文档与进度，保留其他会话改动

### 米家真实接入（2026-11-05）

- [x] **Step 1：核对现状与接入路径**
  - [x] 用户确认米家 / 小米，尚未部署 Home Assistant
  - [x] 核对官方 Xiaomi Home 集成、OAuth 与云端 / 中枢控制边界
  - [x] 确认 Hub 与 Mobile 当前仍使用演示设备
- [x] **Step 2：Hub 真实 Home Assistant 连接底座**
  - [x] 实现 REST 适配器、凭据配置、真实状态读取与连接诊断
  - [x] 读取真实实体并按显式白名单开放控制；用户选择全部支持设备，无配置保持未连接
  - [x] 回读与错误场景测试、独立 review 修复：延迟 / 陈旧回读、模拟数据隔离、凭据脱敏、传感器未知值
- [x] **Step 2.1：Mobile 与语音接线**
  - [x] 自动读取真实设备列表、搜索、灯光 / 风扇 / 开关控制、亮度 / 色温、只读设备状态
  - [x] 语音真实状态查询与明确实体控制；网关统一验证能力、参数与回执
  - [x] 全局连接状态轮询，真实模式移除 HA 断连模拟，防止旧请求覆盖操作结果
  - [x] 全仓 234 项测试、typecheck/build 通过；iOS 待授权页面实测；独立 review 无阻断项
- [ ] **Step 3：部署与首台米家设备联调**
  - [x] 用户选择米家全部设备；已有 Mac mini，本轮先在当前 Mac 部署联调
  - [x] 启动 Docker，安装小米官方集成；转换官方 2026.11.0 镜像兼容本机 Docker 20.10 的压缩支持
  - [x] Home Assistant 容器启动，`/api/onboarding` 实测可用；浏览器已打开本地账号创建页
  - [x] 用户已创建本地账号并完成初始化；临时 mDNS 服务发布回调名称，实测 `homeassistant.local:8123` 可达
  - [x] 用户完成风险确认与小米 OAuth，导入全部 45 台设备 / 1121 个实体
  - [x] 用户明确授权主 Agent 创建 Super-LOOI 访问令牌，写入本地 `.env` 并重启 Hub
  - [x] 实测 Mobile 显示真实设备，语音查询读取空气检测器 6 项状态（其中 4 项可读）；未触发物理设备动作
  - [ ] 真实设备控制后的物理回读验收（保留为后续显式控制场景，不以读取测试冒充完成）
- [x] **Step 4：真实全量账号联调收敛**
  - [x] WebSocket 注册表读取设备 / 房间 / 集成来源，仅导入米家实体，排除 HA 自带状态
  - [x] Mobile 常用控件 / 传感器 / 全部功能分类、搜索与分页；Web 控制台改用真实列表
  - [x] 语音发现分页；控制台状态批量读取，避免每轮 1121 个并行请求
  - [x] 非电源类开关保持只读；隐藏文本实体内容与凭据属性；注册表失败独立报错
  - [x] 全仓 239 项测试、typecheck/build 通过；React Doctor 本轮增量零诊断；独立 review 无阻断项
  - [x] iOS 与 Web 实测真实状态；真实读取与物理动作验收分开记录，未触发物理设备动作

## 总体规划概览

- **Phase 0: 仓库归档、黄金资产提取与净室 Monorepo 骨架初始化**
- **Phase 1: Android + iOS 双端具身本体与可插拔语音/视觉底座**
- **Phase 2: 可追溯证据记忆账本与“脸与页面共形”内页**
- **Phase 3: 远程生产力副驾闭环 (`TaskSupervisor` + DeepSeek Harness / SSH)**
- **Phase 4: 情境智能家居闭环 (`HomeGateway` + Home Assistant)**
- **Phase 5: 48 条核心验收场景与 Android + iOS 双端长稳打磨**
- **Phase 6: Presence v2.1 具身设备感与“脸与页面共形”UI 全量重构**

---

## 阶段执行进度

### Phase 0: 仓库归档、黄金资产提取与净室 Monorepo 骨架初始化

- [x] **0.1 归档旧代码基线与分支**
  - [x] 创建 `archive/legacy-v1` 干净归档分支，收敛旧版验证代码与未跟踪补丁
  - [x] 严格保留根目录 `.env` 密钥文件，并在 `.gitignore` 确保其不入库
  - [x] 切回 `main` 主分支，重置为清爽重构起点
- [x] **0.2 黄金资产抢救与入库落盘**
  - [x] 提取字节跳动 OpenSpeech 全双工二进制协议实现至 `docs/golden-reference/doubao-duplex-reference.ts`
  - [x] 提取 V2 核心 PRD 至 `docs/design-v2/prd.md`
  - [x] 提取 V2 核心技术方案至 `docs/design-v2/technical.md`
  - [x] 提取 48 条全量验收 Case 矩阵至 `docs/design-v2/acceptance-48-cases.md`
  - [x] 提取 V2 协议设计草案至 `docs/design-v2/protocol_contracts.reference.ts`
  - [x] 提取 UI Manifest 布局定义至 `docs/design-v2/ui_manifest.json`
- [x] **0.3 净室清理与工作区净化**
  - [x] 移除旧 `app/`, `src/`, `server/`, `scripts/`, `patches/`, `plugins/` 等冗余目录
  - [x] 移除旧 Metro/Nativewind/Babel 临时文件，仅保留必要配置与文档
- [x] **0.4 组织标准演进看板**
  - [x] 初始化全新层级化 `progress.md`
  - [x] 初始化聚焦硬件/架构实测的 `todo.md`
- [x] **0.5 搭建 pnpm Workspace 净室骨架**
  - [x] 根目录 `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `docker-compose.yml`, `README.md`
  - [x] `packages/contracts` (`@super-looi/contracts`): 零依赖 TypeScript 契约库（上下文证据、记忆账本、动作回执、具身观察、双轨语音/视觉等）及单元测试
  - [x] `packages/looi-driver` (`@super-looi/looi-driver`): 逆向 BLE 常量固化、带停机互斥租约与脱座急停的 `BodySupervisor` 及单元测试
  - [x] `apps/hub` (`@super-looi/hub`): Fastify 服务端骨架、健康检查、可插拔 Voice/Vision 注册中心及单元测试
  - [x] `apps/mobile` (`@super-looi/mobile`): Expo 移动端骨架、横屏驻留配置、`presence-state.ts` 独立状态机及单元测试
- [x] **0.6 全局类型检查与测试验证**
  - [x] `pnpm install`, `pnpm typecheck`, `pnpm test` 100% 通过
  - [x] 提交 Phase 0 清洁 Git 提交

---

### Phase 1: Android + iOS 双端具身本体与可插拔语音/视觉底座

- [x] **1.1 具身硬件控制接入 (`packages/looi-driver`)**
  - [x] 封装跨端 BLE 传输层（适配 Android BLE 与 iOS CoreBluetooth 的 `CrossPlatformBleTransport` & `SimulatedBleTransport`）
  - [x] 实现 `BodySupervisor` 自动握手重试、租约互斥与失联保活
  - [x] 验证脱座 (`06`) 瞬时硬件停车与软件租约吊销
  - [x] 导出 `SelfEventWindow` 标记给感知层以抑制自发电机转动噪声与画面位移
  - [x] 落地 `executePulse` 有界微动作调度与防抖等待窗口（settling window ≥200ms）
- [x] **1.2 移动端全屏驻留情感脸模 (`apps/mobile`)**
  - [x] 落实色彩语义规范与调色板（Cyan 独占眼睛与拾音、Green 确认、Amber 推测、Coral 急停）
  - [x] 实现 `RobotFaceController` 眼动聚焦、眨眼节拍、情感状态与声音波形共振
  - [x] 实现 <100ms 本地瞬时触摸急停与前台横屏电源常亮保活策略 (`KeepAwakeController`)
  - [x] 实现 `LightToastQueue` 3 秒自消失轻提示与拾音防打断队列
- [x] **1.3 Hub 端双轨语音管道接入 (`apps/hub`)**
  - [x] 升级语音契约 (`VoiceUpMessage` / `VoiceDownMessage`) 支持双轨信令
  - [x] 轨 A: 接入 `DoubaoVoiceProvider`（严格 20ms/640B 实时自校正节拍器、关麦提交与瞬时打断）
  - [x] 轨 B: 接入 `ModularVoiceProvider`（模块化流式 ASR + Fast LLM + 流式 24k TTS 与 AbortController 取消）
  - [x] 实现 `LoopbackSuppressionManager` 动态抑制助理 TTS 外放回灌与二次误唤醒
- [x] **1.4 视觉感知适配层与 Benchmark**
  - [x] 抽象 `VisionProvider` 标准协议与注册表
  - [x] 实现 `CloudVisionProvider`、`LanVisionProvider` 与具备串行互斥/空闲 5s 自动卸载的 `EdgeVisionProvider`
  - [x] 建立三层视觉基准评测套件 (`runVisionBenchmark`) 与 `/api/vision/benchmark` 诊断路由
  - [x] 沉淀 `docs/phase1-vision-and-voice-benchmark.md` 阶段性架构结论文档

---

### Phase 2: 可追溯证据记忆账本与“脸与页面共形”内页

- [x] **2.1 证据与事实账本存储引擎**
  - [x] 编写 PostgreSQL + `pgvector` Schema（`privacy_epochs`, `evidence_events`, `episodes`, `memory_claims`, `context_packs`, `deletion_tombstones`）
  - [x] 实现 `MemoryLedgerService`（带 `(source_id, boot_epoch, sequence)` 幂等去重与 SHA-256 哈希冲突校验）
  - [x] 落地三态流转（`inferred` -> `observed` -> `confirmed` / `retracted`）与事实双时间物理区间（`observed_at`, `valid_from`, `valid_to`）
  - [x] 实现 `queryObjectLastSeen` 诚实认识论语态（明确观测时刻与时效性限定语，杜绝幻觉确凿性）
  - [x] 挂载 Fastify 记忆管理 REST 路由（`/api/memory/events`, `/api/memory/claims`, `/api/memory/last-seen/:objectName` 等）
- [x] **2.2 视觉主动微观察与有界俯仰**
  - [x] 落地 `ContextTriggerBus` 频控总线：限制后台触发器频率（默认 3000ms），优先放行显式指令并提供 400ms 快速合并窗口
  - [x] 落地 `NoveltyGate`：过滤相同 viewId 与指纹的冗余静止帧，精准识别旋转俯仰与局部 ROI 变化
  - [x] 落地 `EvidenceAssembler`：确立视觉与音频独立派生根，并记录 `SelfEventWindow` 运动/发声遮蔽标记
  - [x] 落地 `BoundedActiveLookCoordinator`：强制校验脱座安全状态，硬顶预算（最大 2 次尝试，单次脉冲 ≤250ms，运动总长 ≤3000ms，防抖稳定窗口 ≥200ms）
  - [x] 遇到遮挡或无信息增益时诚实放弃并回退坦诚话术（“微调视角后这边还是被挡住了，可以帮我把它移开一下吗？”）
- [x] **2.3 隐私纪元、纠错与代际墓碑**
  - [x] 落地 `correctClaim` 用户事实纠错机制：标废上一版本并派生 `confirmed` 修正版本
  - [x] 落地 `rejectInference` 否认推测机制并记录 `suppressedInferenceKeys`，彻底阻断模型死灰复燃
  - [x] 落地 `deleteEvidenceSource` 级联删除与代际墓碑：生成 `DeletionTombstone`，废弃所有派生断言并强制作废活跃 `ContextPack`
  - [x] 落地迟到写回守卫（Late Writeback Guard）：异步推理任务写回前强校验当前 `deletion_generation` 与 `capture_epoch`，遇冲突直接抛出 `LateWritebackRejectedError` 拒收
- [x] **2.4 移动端“回忆册”共形展开内页**
  - [x] 移动端实现 `MemoriesConformalSpaceController`：支持全屏脸模与时间轴锚点双向平滑共形形变（`face_fullscreen` <-> `memories_timeline_open`）
  - [x] 保留 `#28D5FF` 荧光青色眼动锚点节点
  - [x] 联动角落迷你小 LOOI 头像视线：用户点击卡片时，小机器人视线实时转头盯视选中的照片（视线向量聚焦 `{ x: 0.65, y: 0.35 }`）
  - [x] 格式化 4 问生活片段卡片（When 何时、Where 何地、How 何源、Trust Level 凭据），区分已确认事实（绿）、观测记录（青）、推测（琥珀）与隐私过期脱敏徽章
  - [x] 提供“不是这里”（纠错）、“已经拿走了”（移除失效）、“忘掉这条”（彻底遗忘）三大直觉用户动作回调
  - [x] 沉淀 `docs/phase2-memory-ledger-and-conformal-ui.md` 阶段性架构与设计文档

---

### Phase 3: 远程生产力副驾闭环 (`TaskSupervisor` + DeepSeek Harness / SSH)

- [x] **3.1 Hub 端持久任务状态机**
  - [x] 编写 PostgreSQL Schema (`apps/hub/src/productivity/schema.sql`：`productivity_tasks`, `task_events`, `action_grants`, `action_receipts`, `task_artifacts`)
  - [x] 实现 `HubTaskSupervisor`：支持 `client_request_id` 客户端重试幂等去重（网络断连重发不重复拉起任务）
  - [x] 支持基于游标的事件增量恢复 (`getTaskEvents(taskId, sinceSeq)`），断线客户端顺畅重连追齐流
  - [x] 实现全生命周期状态机流转（`queued` -> `running` -> `awaiting_approval` -> `cancelling` -> `succeeded` / `failed` / `cancelled` / `unknown`）
  - [x] 产物核验：必须取得 `ReadbackEvidence(kind: "artifact_probe" | "runner_exit")` 并生成 `status: "verified"` 回执后才允许标记 `succeeded`
- [x] **3.2 受限 ContextPack 装配引擎**
  - [x] 编写 `ContextPackAssembler` (`apps/hub/src/productivity/context-pack-assembler.ts`)
  - [x] 严格 ACL 与模态隔离：仅提取指定 `project_id` 匹配项，物理剔除家庭隐私记忆与音视频原始流
  - [x] 字符与 Token 预算截断，强制打标 `instruction_trust: "untrusted_context_data"`
  - [x] 动态 Live 撤回校验 (`validateContextPackForTurn`)：模型每一轮交互前校验 `ContextPack` 是否被墓碑标记失效，若失效及时阻断或重新装配干净包
- [x] **3.3 生产力执行通道 — DeepSeek Harness (DSH) + SSH Runner**
  - [x] 编写 `DshWorkspaceRunner` (`apps/hub/src/productivity/dsh-runner.ts`)：工作区白名单沙箱（严格防范 `..` 路径穿越或非白名单目录）
  - [x] 高危命令拦截器：拦截 `rm -rf`, `git push --force`, `dd `, `mkfs`, `sudo ` 等破坏性命令，转入 `awaiting_approval` 并签发 `ActionGrant`，只有持有合法的 `UserActionRef` 显式审批通过后才恢复执行
  - [x] 诚实取消协议 (`requestCancel`)：吊销待定 ActionGrant，向远端发送终止信号；取得真实进程退出回执才转为 `cancelled`；若失联或超时，如实转为 `unknown` (`stop_unconfirmed`)，严禁伪造 fake cancelled
  - [x] 挂载 Fastify 生产力 REST 路由（`/api/tasks`, `/api/tasks/:taskId`, `/api/tasks/:taskId/events`, `/api/tasks/:taskId/approve`, `/api/tasks/:taskId/cancel`）
- [x] **3.4 移动端“约定与任务簿”内页**
  - [x] 编写 `TasksAndRulesSpaceController` (`apps/mobile/src/ui/tasks-and-rules-space.ts`)：共形形变展开/收起（`face_fullscreen` <-> `tasks_and_rules_open`）
  - [x] 横竖屏适配与离座诚实边界：跟踪 `layoutMode: "landscape_docked" | "portrait_portable"`；脱座时记录 `deskObservationCutoffAt`，如实展示“已离开底座 · 桌面观察停于 19:42”
  - [x] 4 色语义卡片格式化：`running` (Cyan), `awaiting_approval` (Amber), `succeeded` (Green), `cancelling`/`unknown`/`failed` (Coral)
  - [x] 后台完成/待审批时向 `LightToastQueue` 入队 3 秒轻提示，绝不突兀抢占全屏前台
  - [x] 管理“约定”（Commitments & Reminders）清单
  - [x] 沉淀 `docs/phase3-remote-productivity-dsh.md` 阶段性架构与设计文档

---

### Phase 4: 情境智能家居闭环 (`HomeGateway` + Home Assistant) 与移动端“维修舱”内页

- [x] **4.1 Home Assistant 桥接层与实体白名单**
  - [x] 编写 PostgreSQL Schema (`apps/hub/src/home/schema.sql`：`home_entities`, `home_state_snapshots`, `home_action_receipts`, `home_automation_rules`)
  - [x] 封装可插拔 `HaTransportAdapter`（REST + WebSocket 状态订阅与测试用内存适配器）
  - [x] 实体白名单与高危域强校验：严格拦截 `lock`, `alarm_control_panel`, `gas`, `water_heater`, `garage_door` 等高危域
  - [x] 目标歧义消除 (`resolveTargets`)：多实体同名候选时返回澄清追问话术（如吸顶灯 vs 台灯），严禁瞎猜盲发
- [x] **4.2 幂等目标状态控制、真实状态回读与多源证据共存**
  - [x] 显式目标状态控制与 No-Toggle 规范：强行拒绝 `service: "toggle"`，并对数值边界校验（如亮度、色温范围）
  - [x] 真实状态回读与新鲜 No-op：若当前状态新鲜且已匹配，立即返回 `verified noop`，避免冗余网络下发；超时未回报标记 `unverified`
  - [x] 批量执行 (`executeBatch`)：支持多实体场景并发下发，当部分失败时诚实标记 `outcome: "partial"` 并呈现故障明细
  - [x] 传感器真值与视觉观测共存：环境指标（温度、湿度、CO2、PM2.5）仅限从传感器读取并打标时间戳；当实体状态（灯已开）与视觉（画面暗）冲突时，保留多源证据输出诚实双源解释，绝不以 VLM 猜测覆盖物理遥测
- [x] **4.3 传感器联动、偏好规则晋升与移动端“维修舱”内页**
  - [x] 编写 `HomeRulesEngine` (`apps/hub/src/home/rules-engine.ts`)：统计用户 3 次相似手动微调后生成 `HomeRuleProposal`，经显式 `UserActionRef` 确认后晋升为可撤销自动化规则
  - [x] 挂载 Fastify 智能家居 REST 路由（`/api/home/entities`, `/api/home/resolve`, `/api/home/execute`, `/api/home/batch-execute`, `/api/home/rules` 等）
  - [x] 编写 `CabinSpaceController` (`apps/mobile/src/ui/cabin-space.ts`)：第三大内页“维修舱”共形展开
  - [x] 离线降级诚实指示（Screen 14）：分别独立展示 LOOI 底座 (BLE)、Hub 主机、HA 网关在线状态与验真时间戳，严禁单一“假绿点”掩盖部分失联；重连时不自动盲目重放旧物理运动
  - [x] Provider 与隐私控制：支持热切换语音/视觉引擎，展示摄像头/麦克风/后台进程硬件状态指示
  - [x] 沉淀 `docs/phase4-smart-home-and-cabin.md` 阶段性架构与设计文档

---

### Phase 5: 48 条核心验收场景与 Android + iOS 双端长稳打磨

- [x] **5.1 48 条核心验收用例全覆盖测试 (`apps/hub/src/acceptance/runner.ts` & `apps/hub/test/acceptance-48-cases.test.ts`)**
  - [x] A 组（A01-A06）：物品最后位置、遮挡与主动微观察
  - [x] B 组（B01-B06）：ASR 否定漏听、时间范围与证据去重
  - [x] C 组（C01-C06）：主人 vs 访客、电视干扰与 TTS 回灌抑制（Hard Gate 1: unauthorizedActions === 0）
  - [x] D 组（D01-D06）：用户纠错、代际删除、迟到写回拦截与恢复（Hard Gate 3: zombieResurrections === 0）
  - [x] E 组（E01-E06）：智能家居白名单、状态回读核验与安全边界（Hard Gate 1: unauthorizedActions === 0）
  - [x] F 组（F01-F06）：生产力副驾状态机、SSH 隔离与真实取消确认（Hard Gate 2: crossSubjectLeaks === 0, Hard Gate 4: unverifiedCompletions === 0）
  - [x] G 组（G01-G06）：具身本体租约互斥、脱座即停与断线急停
  - [x] H 组（H01-H06）：双轨语音平滑回退、视觉兜底与隐私暂停
- [x] **5.2 Android + iOS 双端长稳运行 (`apps/mobile/src/shell/longevity-supervisor.ts` & `apps/mobile/test/longevity-supervisor.test.ts`)**
  - [x] 无线充底座 7×24 小时常驻发热、内存泄漏与 GC 压力测试（`DockedLongevitySupervisor` 优雅热降级：nominal -> fair -> serious -> critical）
  - [x] BLE 偶发断连、重连抖动与状态同步自愈能力（Zero Motion Replay 协议，断连清空队列，重连重放数为 0）
  - [x] 前台横屏防烧屏微偏移与休眠/唤醒平滑过渡（OLED 像素微偏移严格硬截断在 `[-6, 6]` px 内）
  - [x] 沉淀 `docs/phase5-acceptance-and-longevity-report.md` 阶段性验收与长稳架构报告

---

### Phase 6: Presence v2.1 具身设备感与“脸与页面共形”UI 全量重构

本次执行范围：依据 `docs/design-v2/ui-v2.1-redesign-spec.md` 完成 Step 6.4 的 Hub 内嵌 Web 控制台升级及根目录四包 `pnpm typecheck` / `pnpm test` / `pnpm build`，归档结果并提交本轮改动。保留既有 Step 6.1–6.3 交付记录；移动端 UI 联网验收、iOS 模拟器逐屏交互与双端硬件验收继续独立跟踪，不以 Web 或自动化验证代替。

- [x] **6.1 修复类型盲区、统一设备屏设计 Token 与零 Emoji 矢量图标底座**
  - [x] 拆分 `apps/mobile/tsconfig.build.json`（供 `dist` 导出）并升级 `apps/mobile/tsconfig.json` 将 `"app/**/*"` 纳入全局 `pnpm typecheck`
    - [x] 新建继承根基础配置的 `tsconfig.build.json`，限定 `src/**/*` 并输出至 `dist`
    - [x] 更新 mobile `build` 脚本，主配置启用 `noEmit`、`react-native` JSX 并覆盖 `src`/`app`
  - [x] 升级 `apps/mobile/src/ui/theme.ts`：补齐 `emergencyCoral` 别名，扩充设备屏深黑底色 (`#03070D`)、内页底色 (`#07111D`)、半透明玻璃表面、描边、电光蓝立体内缘及桌面视距字号阶梯 Token
    - [x] 保留全部原有调色板字段，新增用户指定的 12 个设备屏色彩 Token
    - [x] 调色板字段类型宽化为 `string`，修复 `app` 纳入检查后暴露的既有页面颜色赋值字面量冲突，保留原值和只读冻结行为
  - [x] 实现零 Emoji 矢量/几何图标组件 `apps/mobile/src/ui/components/LooiIcon.tsx`，提供不依赖字体字形的图标底座
    - [x] 导出 `LooiIconName` 与支持 `name`/`size`/`color` 的原生 View 几何图标，覆盖全部 30 个名称
    - [x] 检查新增图标与组件无 Emoji、特殊 Unicode 图标或字体图标依赖
  - [x] 修复 Metro 对 NodeNext 相对 `.js` 导入的 `.ts`/`.tsx` 回退映射，使新组件可按现有源码约定被 Expo 解析；真实 `.js` 优先，外部包与其他错误保留原行为
    - [x] 新增 4 项真实 Metro resolver 聚焦回归；最终独立 mobile 测试 7 个 suite、32/32 通过
  - [x] 运行 mobile `typecheck`、`test`、`build`，全部退出码 0；`git diff --check` 通过，记录结果至交付文档
- [x] **6.2 重构第一层：全屏驻留机器人本体 (`RobotFaceView`)、隐私休眠态与毛玻璃 `QuickDrawer`**
  - [x] 移除首屏常驻 `topBar` 与底部 6 个 QA 调试按钮，还原 100% 纯粹的全屏机器人表情大脸（Screen 01）
  - [x] 实现 `apps/mobile/src/ui/components/RobotFaceView.tsx`：支持 `fullscreen` 与 `avatar` 双模式、点阵网格背景、双层呼吸辉光、大尺寸圆润青蓝发光眼（带 `#0066FF` 立体下缘折射）、动态双眉、7 态表情切换、几何微笑弧线与真实语音幅度驱动声波（待机时保持安静不乱跳）
    - [x] 新建可复用 fullscreen 大脸：深黑纹理、双层光晕、152×134 青眼、`#0066FF` 下缘、顶部月牙高光与动态眉嘴
    - [x] 新建 108×66 头盔 avatar：侧灯条、顶部指示点、青色双眼与微笑，支持点击回调
    - [x] 通过 props 支持 7 态 `FaceExpression`、gaze、blinkProgress、waveformBars 与限制在 `[-6, 6]px` 的 microShift
  - [x] 接入 `DockedLongevitySupervisor` 的 `[-6, 6]px` OLED 防烧屏微偏移与 `RobotFaceController` 视线/眨眼控制
  - [x] 实现运动态专属 `<100ms` 珊瑚红紧急停止大胶囊（Screen 03）、底部实时短句转写浮层（Screen 02）与 `LightToastQueue` 说话防打断 3 秒轻提示（Screen 04）
  - [x] 实现 Screen 11 隐私暂停专属闭眼休眠态遮罩组件（闭眼细线 + 纪元驱动断麦断镜状态提示 + 轻触恢复回调；实际硬件控制待接线）
    - [x] 新建 `PrivacyPauseOverlay`：显示断麦断镜状态、PrivacyEpoch、本地缓冲清空/清理中与恢复按钮
  - [x] 实现 `apps/mobile/src/ui/components/QuickDrawerModal.tsx`：轻触大脸或上滑呼出 6 入口毛玻璃快捷抽屉（回忆册、约定任务、书房家居、维修舱、隐私暂停、仿真演练台 Lab），4.5 秒无操作自动淡出；将仿真测试触发器优雅收纳进 `仿真演练台 (Lab)` 浮层
    - [x] 新建 `QuickDrawerOverlay` 六入口玻璃卡片，最小触控高度 84pt，统一使用 `LooiIcon`，4.5 秒无操作自动关闭并清理计时器
    - [x] 新建 `SimLabSheet`，收纳说话/记画面/微观察/脱座归座/急停/48 项验收六类仿真回调
    - [x] 新建 `ConversationSubtitleOverlay`，提供 Screen 02 单句实时语音字幕胶囊
  - [x] 上轮历史交付：组件接口、生命周期及独立验证已沉淀至 `docs/phase6-layer1-components.md`；当轮 `index.tsx` SHA-256 与当轮基线一致、未做模拟器视觉验收，本轮已实际重构并接线
  - [x] 本轮首屏接线：全量重构 `index.tsx`，默认仅呈现全屏 `RobotFaceView`、感知微胶囊、功能/仿真台入口与底部引导，轻触/上滑呼出抽屉
    - [x] 挂载并联动 `PresenceStateManager`、`RobotFaceController`、`LightToastQueue`、三个共形空间控制器、`DockedLongevitySupervisor` 与 `KeepAwakeController`，清理定时器与订阅
    - [x] 实际接入字幕、隐私暂停/恢复、轻提示与运动急停；微观察时显示 `#FA8E86` 大胶囊并保持停止路径优先
    - [x] 仿真台六类动作统一先关闭 Modal，再执行状态变更与轻提示入队，允许全屏大脸即时反馈
    - [x] 更新 `apps/mobile/src/index.ts` 导出新组件与类型，检查新增可见图标仅使用 `LooiIcon`
  - [x] 本轮 iOS 首屏视觉 smoke：iPhone 16e / iOS 26.3、Expo bundle HTTP 200；首屏无缺失字形、空闲波形或旧顶栏，截图 `docs/artifacts/phase6/ios-firstscreen-2026-11-04.png`
  - [ ] 后续逐态交互验收：在 iOS 模拟器检查头像、抽屉、字幕、隐私面板与四空间点击流程（CUA Simulator 操作未获批准；不影响本轮代码实现完成）
- [x] **6.3 重构第三层：共形内页外壳 (`ConformalDeviceShell`) 与四大二级功能空间**
  - [x] 实现 `apps/mobile/src/ui/components/ConformalDeviceShell.tsx`：适配 iOS 横屏 `SafeAreaInsets`，提供左侧 88pt 玻璃窄轨导航（四入口触控高度至少 58pt，便携模式展示真实离座截止时间横幅）、顶部共形眼动锚点与右上角视线实时联动的迷你 LOOI 头显
    - [x] Header 展示当前空间标题、副标题、青色双节点锚点与可点击返回大脸的 avatar；头像 gaze 正确反转 Y 轴
    - [x] 顶部中央支持 `LightToastQueue` 3 秒轻提示，独立处理安全区与纵向内容滚动
  - [x] 实现 `apps/mobile/src/ui/spaces/MemoriesSpaceView.tsx`（Screen 06 & 07）：完整接入 `MemoriesConformalSpaceController`，采用横屏左列表 + 右侧证据详情检视器双栏布局（含桌面矢量示意图、When/Where/How/Trust 四问、诚实认识论边界与真实生效的 3 大纠错动作），点击卡片时右上角迷你 LOOI 视线平滑聚焦
    - [x] 搜索与全部/已确认事实/观察记录/推测筛选生效；原生 View 绘制显示器、键盘、杯垫与青色坐标靶心；三类纠错更新控制器与详情
  - [x] 实现 `apps/mobile/src/ui/spaces/TasksSpaceView.tsx`（Screen 08, 09, 13, 15）：完整接入 `TasksAndRulesSpaceController`，采用横屏左任务流 + 右侧高危作用域审批卡 (`Scoped Approval`) 与日常约定双栏布局；支持脱座真实截止时间戳横幅与三态诚实取消（`请求取消中 -> 已确认停止 / 结果待核实`）交互
    - [x] 展示沙箱、事件序号与已核验 Readback Evidence；审批显示读取范围、写入范围、拦截命令与批准/拒绝动作
    - [x] 演示 `cancelling`、真实进程退出 `cancelled` 与失联 `unknown` 分支，禁止未核验取消或完成
  - [x] 实现 `apps/mobile/src/ui/spaces/HomeSpaceView.tsx`（Screen 10）：独立“书房家居”空间，2×2 设备能力 Bento 网格（吸顶灯亮度/色温、台灯、新风、只读真实环境传感器 CO₂/温湿度真值卡），展示回读状态徽章、更新时间、物理/视觉双源调和与 3 次微调晋升规则提案
    - [x] 吸顶灯开关与 3000K/4000K/5500K 档位切换；台灯、新风与只读 `sensor.*` 真值卡独立展示回读状态与更新时间
    - [x] 物理/视觉冲突调和、第三次微调生成规则提案、高危门锁域拦截均可交互
  - [x] 实现 `apps/mobile/src/ui/spaces/CabinSpaceView.tsx`（Screen 14）：完整接入 `CabinSpaceController`，横向三列并排独立连通性卡片（BLE 底座 / Hub 主机 / HA 网关，杜绝单绿点粉饰）、双脑引擎热切换与 48 项核心验收分组看板
    - [x] 三路连接状态展示各自验真时间、HA 断连开关与 BLE 重连零动作重放计数
    - [x] 双轨语音、Cloud/LAN/Edge 视觉、Nominal/Fair/Serious/Critical 热阶梯与 `[-6,6]px` OLED 位移可视化
    - [x] 实现向 Hub 请求运行 48 项核心用例、校验完整报告并展示 A-H 八组与四大硬门禁，区分未运行、运行中和真实结果
  - [x] 独立跨层兼容验证：实际 Hub `AcceptanceRunner.runFullSuite()` 经 JSON roundtrip 输入 mobile parser，退出码 0，48/48、96/96、四门禁全 0（非 HTTP/UI/物理验收）
  - [x] 本轮最终验证与归档
    - [x] 运行 `pnpm --filter @super-looi/mobile typecheck`：退出码 0
    - [x] 运行 `pnpm --filter @super-looi/mobile test`：10 suites，45/45 通过，退出码 0
    - [x] 运行 `pnpm --filter @super-looi/mobile build`：退出码 0（TypeScript build，不代表原生 iOS 编译）
    - [x] React Doctor 修复两项 render ref 错误后复扫退出码 0，73/100，0 errors / 47 非阻断 warnings，未扩展无关阴影/架构迁移
    - [x] 独立审查集成回调与布局约束，记录静态/自动化结果及视觉和硬件局限至 `docs/phase6-conformal-spaces.md`，清理已解决 `todo.md` 条目
- [ ] **6.4 同步升级 Hub Web 控制台 (`console-html.ts`) 与 iOS 模拟器全屏实机验收**
  - [x] 同步升级 `apps/hub/src/console-html.ts` 为深邃点阵设备屏 + 纯净全屏大脸 + 快捷抽屉/仿真台 + 四大共形内页体验
    - [x] 明确本轮 Hub 与全工作区验证范围，拆分实施及审查步骤，记录当前待办
    - [x] 统一 `#03070D` 点阵、玻璃表面、五种语义色及内联 SVG 图标，移除全部 Emoji
    - [x] 落地默认全屏大脸、152×134 青蓝眼与双层辉光、动态眉毛、微笑弧和仅说话时激活的声波
    - [x] 落地功能/仿真台胶囊、六入口快捷抽屉、六动作仿真抽屉与自动收起后的 3 秒轻提示
    - [x] 落地 88px 玻璃窄轨、视线联动迷你头显、四问回忆册、作用域审批/诚实取消任务簿、2×2 家居和三列连接/48 项维修舱
    - [x] 保持 Hub `/api/*` 实时联动，审查隐私、异常回读、取消与验收结果的诚实反馈
      - [x] 新增只读控制台状态、白名单家居快照和任务授权作用域接口，区分仿真适配器与物理连接；拒绝跨任务错用授权
      - [x] Hub 类型检查与接口/任务聚焦 15 项测试通过；只读接口独立审查无阻断问题
      - [x] 修复家居 fresh noop 与执行回读只检查开关、忽略亮度/色温参数的问题；新增参数回读 2 项测试
      - [x] 新增 7 项真实内联脚本运行时测试，覆盖完整验收报告、诚实取消、HTTP 失败、内容转义、离线家居与仿真记忆来源
    - [x] 完成独立代码审查及真实 Web 视觉/交互验证，最终无阻断：19 张截图，桌面/窄屏、抽屉时序、三态取消、家居离线及 48/48、96/96、四门禁 0
      - [x] 记录审批按钮点击被自动审查拒绝的验收边界；API 回归与审批渲染通过，实际 UI 批准点击仍单列于 `todo.md`
  - [x] 运行根目录命令，确保全工作区四包 100% 零错误通过
    - [x] 初稿首轮根验证三项全部退出码 0；23 suites / 106 tests 全通过（最终实现稳定后再确认受影响门禁）
    - [x] 最终 `pnpm typecheck`：四包通过，退出码 0
    - [x] 最终 `pnpm test`：25 suites / 115 tests，0 fail；contracts 5、looi-driver 11、Hub 54、mobile 45，退出码 0
    - [x] 最终 `pnpm build`：四包 TypeScript 构建通过，退出码 0；`git diff --check` 通过
  - [x] 将 Hub 交付与验证结果归档至 `docs/phase6-hub-console.md`，收敛 `todo.md` 并提交本轮改动
    - [x] 分阶段提交计划 `d8189e5`、只读接口 `7021357`、控制台与家居参数回读 `f263415`
  - [ ] 通过移动端 UI 实际运行联网 Hub 48 项验收并核验 A-H 八组与四门禁显示；当前客户端解析单测不能替代此项
  - [ ] 在 iOS 模拟器上逐屏实机运行并截图核验（首屏陪伴、聆听/仿真台、快捷抽屉、隐私暂停、回忆册、任务簿、书房家居、维修舱），沉淀阶段性总结至 `docs/` 并清理 `todo.md`

---

### Phase 7: Presence v3.0 灵动光感硬件与富媒体共形空间深度重构 (`docs/design-v2/ui-v3.0-redesign-spec.md`)

- [x] **7.0 深度视觉审阅与 Presence v3.0 新版设计规范沉淀**
  - [x] 提取原版目标视觉参考稿（`archive/legacy-v1:design/首屏示例.png`、`记忆示例.png`、`page-design.md`）并与 Phase 6 全部 20 张实机/Web 截图逐帧对比
  - [x] 由审查子 Agent 完成全量代码与截图走查，定位六大系统性病灶与五处代码级实现 Bug
  - [x] 沉淀新版设计规范至 `docs/design-v2/ui-v3.0-redesign-spec.md`
前置批次范围（2026-11-04）：`@super-looi/mobile` Step 7.1、7.2，以及提前实现的 `RobotFaceView` avatar；本批次代码实现与独立 review 已完成，最终 mobile 三项检查全部通过，首屏与 avatar 原生截图已核验，抽屉留图、完整 SimLab 交互与 portrait 继续待验；交付记录独立见 `docs/phase7-mobile-foundation-report.md`。

本轮执行范围（2026-11-04）：按用户新指令执行 Step 7.3，共形外壳与记忆、任务、家居、维修四空间升级至 Presence v3.0，复用前置组件与 `humanize.ts`，运行 mobile 三项自动化检查并完成独立审查。用户明确指定的 88pt 导航、5 档亮度（20/40/60/80/100%）与原生绘制优先于旧规范示例。Step 7.4 的 Hub Web 与完整双端逐屏验收继续独立跟踪。

原生运行约束：预编译 `superlooiapp.app` 使用 RN 0.85.3 New Architecture，已含 ExpoFont / ExpoImage，未链接 RNSVG。必须使用 Ionicons、RN 原生渐变与 `boxShadow`；不得新增 `react-native-svg`，不得直接修改 Expo prebuild 产物。

- [x] **7.1 Step 1: Ionicons / RN 原生光学底座与人性化语义转译层 (`humanize.ts`)**
  - [x] 保留 `LooiIconName` 全部 30 个名称及既有 props，切换 `@expo/vector-icons/Ionicons`，提供 Node 未加载字体时的安全回退
  - [x] 导出 `LooiBrandMark` 猫耳面罩徽标与 `LooiWaveOrnament` 对称 7/9 柱声波纹
  - [x] 新建 `apps/mobile/src/ui/humanize.ts` 与 `apps/mobile/test/humanize.test.ts`
    - [x] 映射四类记忆来源与认识论状态/徽章，保留确认、观察、推断的语义边界
    - [x] 将书房实体、触发条件与动作 JSON 转为自然中文规则/约定标题和描述
    - [x] 转译工作区、任务完成/高危审批摘要与产物名称
    - [x] 实现 `resolveMemorySceneTarget(whereText, itemTitle)`，返回动态 `xPercent`、`yPercent` 与四类 zone，覆盖显式位置优先及未知输入
    - [x] 从 `apps/mobile/src/index.ts` 导出全部 helpers
- [x] **7.2 Step 2: `RobotFaceView` v3、底部唤醒栏与共形缩放抽屉**
  - [x] 重构 fullscreen 大脸
    - [x] 移除 `eyeCrescent` / `eyeHighlight` 与 neutral/listening 悬空眉毛
    - [x] 使用原生 `radial-gradient` 平滑氛围光、线性渐变眼球与外辉光/内嵌 `#004CFF` 折射，移除离散同心光圈层
    - [x] 实现 `196×180pt` 双眼、`164pt` 间距与 `64×22pt` 圆润青色微笑，保留其他情绪眼睑变化
    - [x] 通过 `useWindowDimensions()` 应用指定视口缩放公式；`drawerOpen` 时平滑缩至约 0.72 倍并上移 44pt
  - [x] 提前完成 avatar：`148×82pt` 金属头盔、顶部传感器阵列、青色耳灯、深黑凹面屏及跟随视线的眼睛/微笑
  - [x] 重构首页与 QuickDrawer
    - [x] 移除顶部大胶囊，仅保留低透明度状态入口与 Lab 入口，并维持两个无障碍标签
    - [x] 还原对称 7 柱声波、弧形括号、蓝色 `Hey LOOI` 与底边地平线辉光
    - [x] QuickDrawer / SimLab 打开时传递 `drawerOpen` 并将底部唤醒栏 opacity 置 0
    - [x] 四大空间卡片使用实时计数/状态角标，两个工具动作独立分组
    - [x] SimLab speaking 提示改为自然中文演示说明
  - [x] 独立审查已完成，无阻断发现；humanize + Metro 聚焦回归 17 项通过
  - [x] `pnpm --filter @super-looi/mobile typecheck`、`test`、`build` 全部退出码 0；测试 16 suites / 61 tests 全过、0 失败，独立 review 无阻断发现
  - [x] 核验 iOS 横屏首屏与 avatar 截图：首屏未见原有同心环，头盔传感器/侧灯/品牌标与图标实际呈现；证据位于 `docs/artifacts/phase7/steps-7.1-7.2/`
  - [ ] 后续视觉证据：补充稳定抽屉截图、完整 SimLab 交互与 portrait 实机；已观察抽屉隐藏唤醒栏及大脸缩小上移，但并发操作未留稳定截图，独立模拟器 CUA pipe 关闭后未继续宣称覆盖
- [x] **7.3 Step 3: 重塑第二/三层 —— `ConformalDeviceShell` v3 与四大富媒体空间（实现与指定验证完成）**
  - [x] 建立本轮实施、验证与归档子步骤；保留前置 7.1/7.2 原有记录及并行改动
  - [x] 确认前置 `humanize.ts`、`LooiBrandMark`、`LooiWaveOrnament`、`LooiIcon` 与头盔 avatar 的真实接口并完成集成
  - [x] 升级 `ConformalDeviceShell.tsx`
    - [x] 88pt 左轨顶部猫耳品牌标与 LOOI 字样；未选中项无框，选中项 18pt 青色发光圆角框与轨道连线节点
    - [x] 标题使用 9 柱对称声波；右上角接入头盔 avatar、点阵与径向光晕，保留视线联动
    - [x] 轻提示独立布局，避免与标题、avatar、卡片碰撞，兼顾窄屏与安全区
      - [x] iOS 短横屏实测发现 rail 底部遮挡，修复并复核四个入口均可触达
  - [x] 升级 `MemoriesSpaceView.tsx`
    - [x] 左侧发光时间轴与四类 16:9 原生渐变场景插画（键盘/钥匙、显示器/AirPods、书架/杯子、抽屉/线缆）
    - [x] 卡底 5 柱声波、自然中文来源、短时间与认识论徽章；移除正面 REV/DEMO、原始来源和凭据 ID
    - [x] 证据图按 `resolveMemorySceneTarget` 动态聚焦与高亮四区，中文四维信息卡，凭据编号与版本收纳到弱化页脚
    - [x] 保留不是这里、已经拿走了、忘掉这条及内联位置编辑完整回调
  - [x] 升级 `TasksSpaceView.tsx`
    - [x] 工作区、摘要、产物、约定使用 humanize helpers；主标题不暴露 JSON、条件表达式或英文状态
    - [x] 琥珀/珊瑚安全盾牌审批面板：读取、写入、高危指令、单次边界与批准/拒绝按钮
    - [x] 清晰呈现请求取消中、已确认进程退出、连接中断·结果待核实三态，不制造未核验成功
  - [x] 升级 `HomeSpaceView.tsx`
    - [x] 移除数字 TextInput 与双文字开关；三个设备提供青色发光 ToggleSwitch 与回读徽章，灯开时有环境内辉光
    - [x] 吸顶灯和台灯可视化亮度滑轨、百分比/255 显示，20/40/60/80/100% 五档点击立即调用处理器
    - [x] 吸顶灯 3000K/4000K/5500K 冷暖点胶囊及明确选中态
    - [x] 三个大字号温湿度/CO₂ 仪表与物理传感器实测来源，保留真实回读语义
  - [x] 升级 `CabinSpaceView.tsx`
    - [x] BLE/Hub/HA 三路独立信号、核验时间与窄屏响应式拓扑卡
    - [x] 双脑切换、OLED `[-6,+6]px` 活动点十字雷达与四阶热状态槽
    - [x] 四大安全盾牌、A–H 八组进度条与默认折叠的 48 项用例矩阵；未运行不伪装为全通过
  - [x] 集成验证与独立审查
    - [x] 实施中 checkpoint：mobile typecheck 一次通过；Home 家居安全测试 4/4、Cabin 相关测试 12 项通过；最终集成结果见下
    - [x] `pnpm --filter @super-looi/mobile typecheck` 退出码 0
    - [x] `pnpm --filter @super-looi/mobile test`：16 suites / 61 tests，61 pass、0 fail、0 skipped，退出码 0
    - [x] `pnpm --filter @super-looi/mobile build` 退出码 0（TypeScript 构建，非原生编译）
    - [x] 独立代码审查交互回调、窄屏布局及证据/回读诚实性；唯一 P2（自定义位置高亮区与靶心不同步）修复后复核，无未解决 P1/P2
    - [x] React Doctor 最终补扫含新增文件：42 files、30 warnings、0 errors，退出 0；独立审查确认无新增功能缺陷
    - [x] 归档 iPhone 16e 横屏四空间首屏与家居开关回读 smoke；CUA pipe 中断后的未测交互及完整双端矩阵保留至 7.4
    - [x] `git diff --check`；确认本轮提交无新增 RNSVG、无直接修改 Expo prebuild 产物
  - [x] 将实际交付与未验证边界写入 `docs/phase7-ui-v3-report.md`，整理 `todo.md` 并分阶段提交本轮文件
- [x] **7.4 Step 4: 同步升级 Hub Web 控制台 (`console-html.ts` v3) 与双端实机逐屏截图验收**
  - [x] 同步升级 `apps/hub/src/console-html.ts` 至 Presence v3.0 视觉体系：
    - [x] 1:1 同步纯粹发光大眼、底部声波括号唤醒栏、共形缩放抽屉、3D 头盔面罩、9 柱标题声波纹、4 幅记忆场景 SVG 插画、动态坐标桌面检视器、自然语言日常约定、发光拨动开关、自定义流光亮度滑轨、色温选中态高亮与可折叠 48 项验收看板
    - [x] 修复 `.drawer-open .wake` CSS 层叠顺序文字穿透 Bug、窄屏 `.rail` 悬浮腰斩长图 Bug 与窄屏 `.connections` 三列挤压未折行 Bug
  - [x] 运行全工作区 `pnpm typecheck`、`pnpm test`、`pnpm build` 确保 100% 零错误通过
  - [x] 在 iOS 模拟器（横屏底座模式 `844×390pt`）与 Web 浏览器上逐屏运行并截图对比核验，由独立 UI/UX 审查子 Agent 完成 10/10 维度终审 PASS，归档至 `docs/artifacts/phase7/` 与阶段报告 `docs/phase7-ui-v3-report.md`，更新清理 `todo.md` 并提交 commit


### Mobile Presence v3.0 iPhone 横屏精修（2026-11-04，844×390pt）

- [x] Step 1：修复首屏光学形状与抽屉避让
  - [x] 渐变地平线、隐藏覆盖层后的角标、圆弧微笑、眼球蓝边与短屏缩放
  - [x] 紧凑 QuickDrawer 与共形 Shell 标题/头像
- [x] Step 2：压缩四空间首屏垂直占用
  - [x] 记忆工具栏、时间头、场景插画与证据面板
  - [x] 家居状态栏、设备卡；维修连接卡与双脑/雷达；任务提示与卡片
- [x] Step 3：验证与独立检查
  - [x] mobile typecheck / test / build：全部退出码 0；16 suites / 61 tests 全过（0 fail / skipped）；build 为 TypeScript 构建
  - [x] 独立代码审查与 iOS Simulator 横屏截图核验：四空间主要卡片首屏可见，QuickDrawer 全脸/卡片/工具行避让，Lab 隐藏角标；家居与记忆关键点击 smoke 通过
  - [x] 更新剩余问题；按用户要求不提交 commit；归档见 `docs/mobile-presence-landscape-polish.md`

本轮适配以实际源码为准：Shell 对应 `main`，记忆纠错操作移至选中卡片旁，短横屏家居/任务提供紧凑布局，维修卡片按视口宽度而非内层宽度判定列数。保留竖屏/大字布局、离线待核实与单次审批语义。独立审查指出的纠错编辑器可见性、窄屏标题与头像避让已修复。

---

### Phase 8: RSI 循环交互深度审阅与重构（信息有效区、滑动物理、点击防误触与零跳动反馈）

采用 **RSI (Recursive Self-Improvement)** 循环闭环（`交互审计 -> 方案收敛 -> Codex 落地 -> 双端实测截图 -> 子 Agent 独立复审打分 -> 下一轮精修`），目标将四大交互维度（信息有效区占比、滑动与手势物理、点击区与 Fitts 定律、布局稳定性 CLS=0 与反馈闭环）从 Round 0 基线 `52.5/100` 提升至 `>= 92/100` 且零 P0/P1 缺陷。

- [x] **8.0 RSI Round 0：交互基线深度审阅与问题清单建档**
  - [x] 定义独立交互审计子 Agent（`interaction-reviewer`），完成移动端 11 个核心 UI 组件与过往截图逐行交互走查
  - [x] 量化基线得分：`52.5 / 100`（信息有效区 `48`、滑动与手势 `52`、点击区与防误触 `56`、布局稳定与反馈 `54`）
  - [x] 识别五大 P0 交互病灶与四项 P1 体验缺陷，登记至 `todo.md` 第 10 节
- [x] **8.1 RSI Round 1（Mobile）：核心交互架构、有效区释放与 `>=44pt` 触控人体工学重构**
  - [x] **8.1.1 外壳与首屏手势安全重构 (`ConformalDeviceShell.tsx`, `app/index.tsx`, `QuickDrawerModal.tsx`)**
    - [x] 将 `ConformalDeviceShell` 内页 Toast 改为绝对定位浮层（`position: "absolute"`, `pointerEvents: "none"`），消除 `72–93pt` 文档流跳动（`CLS = 0`）
    - [x] 回收短横屏（`844×390pt`）底部重复叠加的 `47pt` 死区，精简 `shortHeader`，使 390pt 横屏有效交互内容区占比从 `64.1%` 提升至 `79.7%`
    - [x] 修复竖屏窄宽（`<440pt`）`narrowHeader` 顶部 `76pt` 空白断层，改为紧凑同行布局并内聚头盔 Avatar
    - [x] 修复首屏 `PanResponder` 抢夺 `<100ms` 紧急停止按钮触控事件的安全隐患（运动急停态/隐私态/浮层打开时禁用舞台上滑抢占），消除 `-22..-35pt` 上滑死区，收敛 `100ms` 空闲无效全树重绘
    - [x] 为 `QuickDrawerModal` (`GlassSheet`) 补齐下滑关闭手势（`PanResponder` + `Animated` 跟手位移回弹）、常驻顶部抓手条，恢复关闭按钮与底部工具按钮 `>=44×44pt` 点击热区，并将空闲自动收起延时从 `4.5s` 调优至 `7.5s`
  - [x] **8.1.2 基础交互控件防冲突与热区合规 (`BrightnessSliderBar.tsx`, `ToggleSwitch.tsx`, `DesktopEvidenceDiagram.tsx`)**
    - [x] 重构 `BrightnessSliderBar` 手势（新增 `brightness-gesture.ts`）：区分水平拖拽与纵向滚动（水平锁定父级 `ScrollView`、纵向立即放行且绝不误触改写亮度），提供 `>=44pt` 滑轨热区与双行全宽五档触控
    - [x] 恢复 `ToggleSwitch` 在紧凑视觉轨道外层的 `>=48×44pt` 物理点击热区，新增 `pending` 待回读琥珀脉冲视觉态
    - [x] 修复短横屏 `DesktopEvidenceDiagram` 过度压缩（从 `52pt` 提升至 `84pt`），消除靶心裁切与图例碰撞
  - [x] **8.1.3 四大空间手势、键盘、竖屏单流与点击防误触 (`MemoriesSpaceView`, `TasksSpaceView`, `HomeSpaceView`, `CabinSpaceView`)**
    - [x] 全局 `ScrollView` 补齐 `keyboardShouldPersistTaps="handled"` 与 `keyboardDismissMode="on-drag"`，`MemoriesSpaceView` 接入 `KeyboardAvoidingView` + 实测横屏键盘避让、搜索框整行点击聚焦与一键清空按钮
    - [x] 消除竖屏（`!wide`）`MemoriesSpaceView` 与 `TasksSpaceView` 上下双 `ScrollView` 嵌套抢滚动病灶：竖屏改为顶部 `>=44pt` 分段切换器 + 100% 剩余高度单流顺滑滚动；记忆筛选胶囊改为横向单行滚动不折行
    - [x] 恢复四空间全部操作按钮的 `>=44pt` 触控区与防误触间距（记忆危险删除独立分组隔离）
    - [x] 优化内联展开可见性：`TasksSpaceView` 折叠冗余演示横幅释放 `40pt` 高度并使高危审批按钮首屏可见；`HomeSpaceView` 按触发类型精准自动滚动聚焦反馈卡；`CabinSpaceView` 改为基于实际内容宽度响应式断点，将明细开关提至头部并将选中用例详情置于分组上方首屏可见处
  - [x] **8.1.4 移动端自动化门禁验证**
    - [x] 新增 5 个交互测试套件共 25 项测试，`pnpm --filter @super-looi/mobile typecheck`、`test`（21 suites / 86 tests 全过）、`build` 100% 零错误通过
- [x] **8.2 RSI Round 1（Hub Web）：`console-html.ts` 交互一致性精修**
  - [x] 审查并对齐 Hub Web v3 控制台交互：抽屉下滑手势关闭、`armDrawer()` 仅限快捷抽屉自动收起（`7.5s`，不误关 SimLab）、全量控件 `>=44px` 点击区、Safari 滑块拖拽防 5s 轮询回跳保护、48 项分组点击筛选与详情展示、窄屏常驻底栏 + 分段检视切换与短横屏有效视口优化
  - [x] 新增 6 项交互回归测试，运行 `pnpm --filter @super-looi/hub typecheck`、`test`（64/64 通过）、`build` 100% 通过
- [x] **8.3 RSI Round 1 实机模拟器 + Web 交互实测与子 Agent 独立复审**
  - [x] 在 iOS 模拟器（横屏 `844×390pt` 底座态）与 Hub Web（桌面 `1280×800` + 短横屏 `844×390` + 手机窄屏 `390×844`）完成点击、滑动、抽屉下滑手势、键盘纠错与 48 项联网验收采样，留存 15 张对比截图于 `docs/artifacts/phase7/rsi-round1/`
  - [x] 调度 `interaction-reviewer` 子 Agent 完成 **RSI Round 1 独立复审**：总分从基线 **`52.5 / 100` 跃升至 `76.5 / 100` (`+24.0`)**（有效区 `73`、手势 `76`、热区 `78`、稳定性 `79`），精准识别出 3 项 Web 短横屏/跨页阻塞项与 5 项双端人体工学精修点
  - [x] 阶段性 Git Commit 已落盘（`b5d1c37`）
- [x] **8.4 RSI Round 2 & Round 3：二阶交互边界根治、全屏首屏折叠优化、微雕清零与文档归档**
  - [x] **8.4.1 RSI Round 2（Hub Web `console-html.ts`）：根治 3 项 P0 与短横屏/窄屏折叠率**
    - [x] `[P0-1]` 修复 `#correctionForm` 打开后切走冻结 `Tasks`/`Home`/`Cabin` 渲染的跨空间锁死 Bug：`renderSpaces()` 中将 `#correctionForm` 守卫限定于 `state.space === "memories"`，`switchSpace()` 切换时自动收起表单，并补充 `>=44px` `"取消"` 按钮与 `scrollIntoView`
    - [x] `[P0-2]` 修复 `844×390` 短横屏左轨 `.rail` 纵向溢出 `120px` 导致 `维修舱` 腰斩、`仿真台` 不可达的问题：短横屏压缩 `.rail` 间距与图标但保持每项 `>=48px` 高（总高 `318px <= 390px`），6 个入口 100% 完整可点
    - [x] `[P0-3]` 修复 `844×390` 短横屏 `#sheet`（`44vh` 裁切底部工具行）与 `Memories`/`Tasks`/`Home` 首屏有效区不足（`62.1%`）：抽屉放宽至 `min(82dvh, 332px)`，压缩短横屏 `.space-header`（`52px`）使有效视口占比升至 `84.6%`，将 `.cap-icon` 并入家居卡片标题行，确保短横屏抽屉工具行、任务高危审批按钮、记忆三类纠错按钮与家居主控全部首屏可见
    - [x] `[P1-3 / P1-5 / P2-3]` 修复短横屏 `.mini` 头盔缩放错位（保持内部坐标系纯 `transform: scale`）、手机窄屏 `.filters` 搜索框占满首行不截断、窄屏 `.connections` 紧凑同行图标、首屏 `.perception` 防孤字折行、`awaiting_approval` 首次进入自动聚焦审批页签，以及 `window.blur` 重置 `draggingSlider` 与 `#homeFeedback` 固定最小高度零抖动
  - [x] **8.4.2 RSI Round 2（Mobile `apps/mobile/**`）：首屏双行可见、安全区避让、热区/焦点纯度与深链直达**
    - [x] `[P1-1]` 精修短横屏 `HomeSpaceView` + `BrightnessSliderBar`：紧凑态将百分比读数与滑轨同行排布、精简卡片与状态栏纵向留白（保持全部控件物理/热区 `>=44pt`），使 `844×390pt` 首屏同时完整呈现第一排灯光卡与第二排 `书房新风` / `环境传感器` 读数
    - [x] `[P1-2 / P2-1 / P2-2]` 修复 `ConformalDeviceShell` 横屏底部 `21pt` Home Indicator 安全区避让（滚动内容与左轨底端安全垫高，外层不裁切视口）、修正左轨激活态青色连接点朝向内侧工作区（`right` 而非 `left`）、将浮层 Toast 下移至 Header 下方避免遮挡空间标题与头盔 Avatar，并修复 `CabinSpaceView` 验收分组 `contentWidth < 520` 双列断点
    - [x] `[P1-4 / P1-5]` 移除 `MemoriesSpaceView` 搜索框外层嵌套 `<Pressable>` 与空查询 `44pt` 占位死区、短横屏扁平化 `toolbarCard` 提升有效视口占比至 `83.2%`；竖屏点击记忆卡片一键切入 `证据检视`（附顶部 `"← 返回记忆时间轴"`），且 `TasksSpaceView` 存在 `awaiting_approval` 时首次进入自动切至 `审批与约定` 页签
    - [x] 为 `app/index.tsx` 接入 `expo-router` `useLocalSearchParams` 深链参数支持（`?space=...` / `?overlay=...`）并消除 `react-doctor` 渲染期写 `ref.current` 告警，实现真机深链直达与 iOS 模拟器全空间确定性实测截图
  - [x] **8.4.3 RSI Round 2 独立复审 (`94.8 / 100`) 与 Round 3 四项 `P2` 微雕清零 (`97.5 / 100`)**
    - [x] `interaction-reviewer` 子 Agent 完成 Round 2 独立复审：**`94.8 / 100`**（有效区 `94`、手势 `94`、热区 `96`、稳定性 `95`，**0 P0 / 0 P1**）
    - [x] 立即执行 **RSI Round 3** 微雕清零全部 4 项 `P2`：Web `390×844` 窄屏 `#memoryInspector` 双列网格使三枚操作按钮首屏可见（`y=664.6px <= 770px`）、`setMobileTaskPane(pane, reveal = false)` 防后台轮询抢滚动、Mobile `MemoriesSpaceView` 内联位置编辑显式 `"取消修改"` / `"取消"` 按钮、Mobile 短横屏 `QuickDrawer` 展开时大脸微笑弧上移（`-98pt`）留出清朗间距
    - [x] 全工作区四包 `pnpm typecheck`、`pnpm test`（**182** 项测试全绿通过，0 失败）、`pnpm build` 与 Playwright 225 控件热区/防裁切审计 100% 零违规通过
    - [x] 沉淀完整报告至 `docs/phase8-rsi-interaction-report.md`（附 21 张双端终态实测截图于 `docs/artifacts/phase7/rsi-round2/`），清理 `todo.md` 已解决项并完成最终 Git Commit

---

### Phase 9: LOOI 应用内页高密度驾驶舱重写（Zero-Scroll Bento Cockpit v4.0）

执行记录（2026-11-04）：本轮按最新请求聚焦 `@super-looi/mobile`，保留已有 Phase 9 规划；Hub Web 控制台同步独立留待后续范围。代码由四个独立 Codex 执行单元按文件分工，主 Agent 调度并统一验证，独立 review 与原生截图另行核验。

- [x] **9.0 执行准备与文件分工**
  - [x] 确认初始工作区仅 `progress.md` / `todo.md` 有既有改动，完整保留
  - [x] 分派 shell/抽屉、回忆/任务、家居、维修舱四组 Codex 实现与各自 RSI 测试
  - [x] 分派 iOS `844×390pt` 原生验证环境准备
  - [x] 统一运行 mobile typecheck / test / build：全部退出 0；22 suites / 119 tests 全过，0 skipped；变更范围 React 检查无新增问题
  - [x] 独立 review、修复、原生截图、阶段文档和提交

针对用户指出的「点进 LOOI 之后的应用界面信息密度过低、需要频繁滑动、过多非核心静态提示占据位置」问题，按照已对齐的四大设计决策对内页框架与四大子空间进行彻底重写：

- [x] **9.1 Step 1: 极简侧栏驾驶舱外壳与紧凑快捷抽屉重写 (`ConformalDeviceShell.tsx`, `QuickDrawerModal.tsx`, `app/index.tsx`)**
  - [x] 移除 `ConformalDeviceShell` 中占高 `68–92pt` 的顶部大标题栏 (`styles.header`)、口号式副标题与右上角大尺寸装饰头像 (`styles.avatarBackdrop`)
  - [x] 将迷你 LOOI 活性头像 (`RobotFaceView mode="avatar"`) 直接整合进左侧窄导航栏 (`rail`) 顶部作为「返回全屏大脸」主入口，右侧 `main` 区域 **100% 纵向高度** 释放给业务内容区
  - [x] 将离座状态提示 (`!isDocked`) 压缩为右上角/顶栏内联紧凑微标，保持 Toast 绝对定位浮层 (`CLS = 0`)
  - [x] 精简 `QuickDrawerOverlay` 与 `SimLabSheet`：移除冗余口号副标题与卡片底部静态说明文字，保留单排 4 张紧凑入口卡（图标 + 名称 + 实时状态微标）+ 底部紧凑工具条（`隐私暂停`、`仿真演练台 LAB`）
  - [x] iPhone 安全区内短横屏 rail / scroll / brand 收至 80pt，导航按钮 64×48pt，使内容宽度达 646pt；shell+route 13 项及跟进 shell 9 项通过，typecheck 退出 0
- [x] **9.2 Step 2: 回忆册与约定任务空间高密度 Bento 重写 (`MemoriesSpaceView.tsx`, `DesktopEvidenceDiagram.tsx`, `TasksSpaceView.tsx`)**
  - [x] **回忆册 (`MemoriesSpaceView.tsx`)**：
    - [x] 移除每张记忆卡片内占面积的伪插画 `MemorySceneArtwork`、时间轴冗余头与底部长段静态认识边界警告框 (`styles.boundary`)、免责声明与页脚
    - [x] 左栏改为高密度紧凑列表，使 4 条默认记忆在 `844×390pt` 横屏下**一屏全部完整呈现、无需滚动**（每行显示图标、物品名、位置、状态微标、来源与时间）
    - [x] 右栏改为紧凑证据与操作 Bento 舱（标题 + 状态/版本微标 + 同行 3 个 `>=44pt` 操作按钮 `不是这里`/`已经拿走了`/`忘掉这条` + 紧凑桌面空间定位图 + 2×2 关键事实网格），在 `844×390pt` 下**一屏完整呈现**
  - [x] **约定与任务 (`TasksSpaceView.tsx`)**：
    - [x] 彻底移除所有长段静态说明文字（沙箱说明、本地事件阶段说明、独立产物长文解释、高危审批作用域长段落等），仅保留高信噪比状态微标
    - [x] 重构为横屏 **2×2 Bento 驾驶舱**（左上：当前任务与内联取消/回执/重置操作；左下：紧凑单卡已核验产物；右上：紧凑高危单次授权卡与并排批准/拒绝按钮；右下：紧凑日常约定列表与内联暂停/删除/新增按钮），在 `844×390pt` 下**四角卡片与核心按钮一屏全部可见**
- [x] **9.3 Step 3: 书房家居与维修舱高密度 Bento 重写 (`HomeSpaceView.tsx`, `BrightnessSliderBar.tsx`, `CabinSpaceView.tsx`)**
  - [x] **书房家居 (`HomeSpaceView.tsx`)**：
    - [x] 移除长句说明与新风卡片大块空白占位 (`minHeight: 92`)
    - [x] 顶栏 (`~40pt`) 整合网关状态微标与 4 个演练快捷胶囊按钮（`冲突调和`、`微调提案`、`门锁拦截`、`重置`），触发反馈时在顶栏下内联紧凑展示
    - [x] 主体采用 **2×2 Bento 网格**（吸顶灯、台灯、书房新风、环境传感器），在 `844×390pt` 下**顶栏 + 四张设备卡一屏 100% 完整可见，无需滚动**
  - [x] **维修舱 (`CabinSpaceView.tsx`)**：
    - [x] 移除所有静态免责声明与长句描述
    - [x] 顶栏单行并排展示 3 条紧凑链路状态胶囊（`BLE 底座`、`Hub 主机`、`Home Assistant`）+ 内联 `HA 断连` 开关与 `BLE 重连演练` 按钮
    - [x] 主体采用 **三栏高密度 Bento 工程舱**（左栏：双脑语音/视觉引擎切换；中栏：4 档热压力阶梯 + 2×2 守护指标 + 紧凑同行 OLED 雷达；右栏：**48 项核心验收看板** 含运行按钮、4 项硬门禁微标与 A–H 8 组紧凑进度网格，支持展开用例矩阵），实现在 `844×390pt` 下**无需滑动即可一屏总览连接、双脑、长稳与 48 项验收**
    - [x] 原生截图发现百分比 flexBasis 子网格在 iOS 单列溢出；修为明确两列宽度，重新原生验收及 typecheck / test / build
- [x] **9.4 Step 4: Mobile 全套测试、iOS 模拟器实测截图及子 Agent 独立 Review**
  - [x] 同步更新 `apps/mobile/test/rsi-*.test.ts` 以匹配新的极简驾驶舱与高密度 Bento 契约，并确保 `pnpm typecheck`、`pnpm test`、`pnpm build` 全绿通过
  - [x] 在 iOS 模拟器（`844×390pt` 横屏）对重构后的抽屉及四大空间逐屏截图与点击验证，确认一屏信息密度、无冗余静态文案、无需频繁滑动
  - [x] 调度独立 Review 子 Agent 审查代码质量、布局密度与安全/诚实性边界，归档报告至 `docs/`，更新 `progress.md` 与 `todo.md` 并提交 Git Commit


阶段交付见 [Phase 9 零滚动 Bento 报告](docs/phase9-zero-scroll-bento-report.md)、[独立 review](docs/phase9-independent-review.md) 与 `docs/artifacts/phase9/`。原生发现的维修子网格单列溢出已通过数值宽度修复，最终 mobile 119 项测试、typecheck、build 全部退出 0。Hub Web 同步继续独立留在 `todo.md`。

---

### Phase 10: 主 Agent 亲自操刀 — 审美、布局比例与光学 Bento 质感全面重塑（Zero-Codex Craft v4.1）

针对上一会话（`85614c71-6850-4a68-a29f-5a85df2aa5e5`）因旧规则调用 Codex 导致生成的内页 UI 存在大量机械线框感、比例失衡与审美缺陷（如家居亮度滑轨被 5 个大方块挤压至不足 80pt、任务页左右两栏高度严重失衡留出左下角黑洞、快捷抽屉与演练台图标溢出 24×28 小方框、维修舱三栏底部参差不齐且顶栏高低错位、回忆册按钮堆叠粗暴等），由主 Agent 亲自从零精雕细琢全部 UI 组件与双端同步：

- [x] **10.1 Step 1: 驾驶舱外壳与快捷抽屉/演练台光学质感重塑 (`ConformalDeviceShell.tsx`, `QuickDrawerModal.tsx`)**
  - [x] 重塑 `ConformalDeviceShell` 左侧导航轨：为顶部迷你 LOOI 活性头像打造深空玻璃底座舱 (`brandPod`) 与细微呼吸光晕，精修四枚导航胶囊的选中态渐变光感与右侧能量连接锚点，移除底部突兀灰线
  - [x] 修复 `QuickDrawerOverlay` 与 `SimLabSheet` 图标溢出 Bug（`shortIconTile` 24×28 容纳 25pt 图标导致贴边裁切），升级为带色彩语义光晕的玻璃图标底座 + 右侧微箭头/状态胶囊引导 + 精致底部工具栏
- [x] **10.2 Step 2: 书房家居与亮度滑轨重构 (`BrightnessSliderBar.tsx`, `HomeSpaceView.tsx`)**
  - [x] 彻底修复 `BrightnessSliderBar` 在横屏紧凑态下与 5 档按钮同行挤压的审美缺陷：恢复全宽流光渐变滑轨 + 右侧实时百分比读数，下方并排 5 枚精致档位胶囊（兼顾 `>=44pt` 触控热区与视觉呼吸感）
  - [x] 重塑 `HomeSpaceView` 2×2 Bento 矩阵：顶栏升级为带在线呼吸灯的玻璃状态胶囊栏，台灯补齐色温/照度遥测条，新风与环境传感器升级为带流光风道与三联仪表盘的均衡 Bento 卡片，消除底部死黑留白
- [x] **10.3 Step 3: 回忆册与约定任务空间 Bento 比例与视觉层级重塑 (`MemoriesSpaceView.tsx`, `DesktopEvidenceDiagram.tsx`, `TasksSpaceView.tsx`)**
  - [x] 重塑 `MemoriesSpaceView`：顶栏搜索框与带计数徽章的分段筛选器一体化；左栏 4 张记忆卡采用「专属物品图标底座 + 物品名 + 空间位置胶囊 + 认识论色标」高颜值双行卡片并均衡铺满左栏高度；右栏证据检视舱采用「标题与版本徽标 -> 84pt 蓝图定位图 -> 2×2 玻璃事实格 -> 底部三枚精修操作按钮」的黄金视觉流
  - [x] 重塑 `TasksSpaceView`：消除左栏短、右栏长导致的左下角大片黑洞；左上「楼梯碰撞修复」精修流光进度条与内联操作栏，左下「已核验产物」升级为结构化文件回读凭证卡；右上「高危作用域审批」采用琥珀流光边框、终端代码块与高质感主次操作按钮；右下「日常约定」采用胶囊化列表项与精致内联控制
- [x] **10.4 Step 4: 维修舱三栏等高对齐与工程仪表盘精修 (`CabinSpaceView.tsx`)**
  - [x] 顶栏 3 枚连接胶囊与 2 枚演练胶囊统一 `46pt` 高度与 `14pt` 圆角，消除 `Home Assistant` 与 `HA 断连模拟` 断词换行及右侧高低错位
  - [x] 下方三栏（`双脑引擎热切换`、`长稳守护器`、`48 项核心验收`）实现视觉等高对齐（`alignItems: "stretch"` + `justifyContent: "space-between"`），补充 Edge 驻留状态胶囊、长稳 2×2 遥测微标与防折行 `Nominal`/OLED 雷达行、48 项验收流光门禁与 A–H 矩阵
- [x] **10.5 Step 5: 同步升级 Hub Web 控制台 (`apps/hub/src/console-html.ts`)、全量测试与 iOS 模拟器实机视觉验收**
  - [x] 同步升级 `apps/hub/src/console-html.ts` 至 v4.1 极简侧栏驾驶舱与高颜值 Bento 布局
  - [x] 更新并运行全工作区 `pnpm typecheck`、`pnpm test`（全仓 4 包 202 项测试 100% 全绿通过，0 失败）、`pnpm build` 确保 100% 零错误通过
  - [x] 在 iOS 模拟器（iPhone 16e `844×390pt`）实机渲染并逐屏截图核验（`docs/artifacts/phase9/ios-*.png`），交由子 Agent 独立 Review 后归档并提交 Commit
- [x] **10.6 Step 6: 纯圆几何表情动力学与眨眼状态同步优化 (`RobotFaceView.tsx`, `robot-face-controller.ts`, `app/index.tsx`, `console-html.ts`)**
  - [x] 根治眨眼后卡在 `blinkProgress = 0.5` 导致圆形眼睛变成扁平椭圆的定时器漂移缺陷：为 `RobotFaceController` 新增 `onStateChange` 回调并在每个眨眼阶段（`closing` -> `closed` -> `opening` -> `open`）与表情切换时主动通知视图刷新
  - [x] 升级双端眼眸为 1:1 绝对正圆几何（Mobile 大脸 `184×184pt, borderRadius: 92`、Avatar `24×24pt, borderRadius: 12`；Hub Web `.orb` `200×200px, border-radius: 50%`、`.mini-eye` `20×20px, border-radius: 50%`），彻底移除 `scaleY` 非均匀纵向压扁与切割球面的黑色眼睑遮罩
  - [x] 实现全圆润情绪表达系统 (`getEyePosture`)：通过正圆等比缩放（如 `curious` 大小圆聚焦、`listening` 放大倾听、`thinking` 凝视思考）、圆外悬浮灵动眉弧 (`browArc`)、随视线微移的球面高光点 (`eyeSpecular` / `eyeSparkle`) 及原生弹簧过渡表达丰富情绪，确保任意帧下眼眸始终保持正圆而不坍缩为椭圆
  - [x] 新增眨眼周期回调与正圆几何回归单测（全仓 203 项测试全绿通过），并在 iOS 模拟器实机复核截图（`docs/artifacts/phase9/ios-quickdrawer.png`、`ios-simlab.png`）


### 首次唤醒提示（2026-11-04）

- [x] Step 1: 定位 Mobile / Hub Web 提示与快捷抽屉入口
- [x] Step 2: 首次打开快捷抽屉即隐藏提示，本地保存，重启不闪现
- [x] Step 3: 验证首次展示、点击消失与重启恢复，运行检查并独立 review
  - [x] Mobile 使用已存在的 Expo FileSystem 文档目录保存标记；Web 使用 localStorage；读取完成前不展示，防止闪现
  - [x] Mobile 123 / Hub 69 项测试、双端 typecheck / build 与 git diff --check 通过
  - [x] iPhone 16e 模拟器：首次提示可见 → 点击打开抽屉 → 收起不再显示 → JS 重载仍隐藏
  - [x] 子 agent 最终只读复审通过；React Doctor 改动范围检查退出 0，无新增诊断（全量旧代码诊断未纳入本轮）
  - [x] 原生重建尝试遇到既有 Reanimated / RN 版本不兼容，已记录 todo；最终方案不需要新增原生模块

---

### Phase 11: 极简真实可用语音 Personal Agent 闭环（做减法：唤醒 + 豆包 Duplex V3 + 极简 DSH Agent Loop + 零心智记忆）

核心目标：砍掉繁琐的人工审批/三态维护心智负担，直通用户真正需要的两大核心体验：
1. **说话唤醒、自然实时对话**：像 Codex Live 一样自然全双工对话（真实麦克风上行、真实语音播放、随时插话打断 Barge-in、真实音频振幅驱动表情）。
2. **零心智负担的 Personal Agent**：内置 `dsh` 最基础的极简 Agent Loop（`LLM + bash + read_file + write_file + memory`），语音对话中自动记忆事实、自动调起 Agent Loop 干活并口播结果。

- [x] **11.1 Step 1: 极简持久个人记忆与 DSH 核心 Agent Loop (`apps/hub/src/agent/`)**
  - [x] 实现 `PersonalMemoryStore` (`apps/hub/src/agent/personal-memory.ts`)：基于本地 JSON 文件 (`data/personal-memory.json`) 的零心智持久化记忆（支持 `remember`、`recall`、`forget` 与自动生成 `<personal_memory>` 系统提示词块，并与 `MemoryLedgerService` 双向同步）
  - [x] 实现 `MinimalAgentLoop` (`apps/hub/src/agent/agent-loop.ts`)：复刻 `dsh` 最核心的 ReAct 工具循环（对接 `.env` 的 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`），内置 `bash`（真实进程执行）、`read_file`、`write_file`、`memory` 四大基础工具与实时步骤状态回调 (`onStep`)
  - [x] 在 Hub 挂载 `/api/agent/run` 与 `/api/agent/memories` 路由，并编写单元测试验证真实工具循环与磁盘持久化
- [x] **11.2 Step 2: 豆包 Duplex V3 真实全双工协议修复与快慢脑自动工具桥接 (`apps/hub/src/voice/`)**
  - [x] 修复 `DoubaoVoiceSession` (`apps/hub/src/voice/doubao-engine.ts`) 对齐实测 V3 协议（`wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`、模型 `1.2.6.1`、声线 `zh_female_vv_jupiter_bigtts`、`vadSmoothMs: 2500`）
  - [x] 在 `session.create` 注入 LOOI 自然对话人设、动态持久记忆摘要与 3 个零心智工具（`remember_fact`、`recall_memory`、`run_agent_task`）
  - [x] 升级 `/ws/voice` (`apps/hub/src/app.ts`)：服务端自动拦截并执行语音模型发出的 `tool_call`，实时下发 `agent_status` 微状态事件，并将执行结果自动回传给豆包会话进行自然口播
  - [x] 升级 `ModularVoiceProvider` 使用真实 LLM / AgentLoop 作为后备大脑，并编写/运行豆包 Duplex V3 + LLM 真实连通性探针验证
- [x] **11.3 Step 3: 双端真实麦克风采集、语音唤醒与 24kHz 音频流播放 (`apps/hub` & `apps/mobile`)**
  - [x] Hub Web 端 (`apps/hub/src/console-html.ts`)：接入浏览器 `getUserMedia` (16kHz PCM16 上行)、客户端能量 VAD 唤醒/打断与 `AudioContext` (24kHz PCM16 队列流式播放)，驱动实时声波与字幕
  - [x] Mobile 端 (`apps/mobile`)：恢复已编译在模拟器原生包内的 `@siteed/audio-studio`、`expo-audio`、`expo-file-system` JS 依赖，新建 `apps/mobile/src/runtime/live-voice-client.ts`，打通 `/ws/voice` 真实 16kHz 麦克风录音上行、VAD 唤醒与 24kHz WAV 音频播放
- [x] **11.4 Step 4: 首屏极简减法重构、全链路实测与子 Agent 独立 Review**
  - [x] 首屏交互做减法 (`apps/mobile/app/index.tsx` & `console-html.ts`)：轻触大脸或开口即进入 Live 对话，实时展示用户/LOOI 字幕与 `Agent · 执行中` 微状态，回忆册自动同步真实语音记忆
  - [x] 运行全工作区 `pnpm typecheck`、`pnpm test`、`pnpm build` 确保 100% 通过
  - [x] 在 iOS 模拟器与 Hub Web 实测真实语音链路与 Agent Loop 工具调用，交由子 Agent 独立 Review 后归档至 `docs/phase-11-live-voice-and-personal-agent.md` 并提交 Git Commit


### 官方 DSH 执行引擎复用调研（2026-11-05）

- [x] Step 1: 核实官方 SDK、运行时、插件与发行版本
  - [x] 固定官方源码 SHA，并区分源码接口与 npm 发行能力
  - [x] 验证 Node / pnpm 要求、安装入口及最小启动可行性
- [x] Step 2: 对照本仓库设计接入边界
  - [x] 梳理 Agent / Voice / TaskSupervisor 的调用链与现有模拟执行
  - [x] 明确会话、工具扩展、模型配置、审批、取消和恢复的责任
- [x] Step 3: 形成可执行迁移方案与验证清单
  - [x] 调研结论及来源沉淀 docs，未完成的接入实测列入 todo.md
  - [x] 子 agent 独立复审事实、接口与方案；修正两项边界并最终复审通过，文档/JSON/脚本语法检查通过并提交
  - [x] 隔离安装 rc.5 / rc.1 并通过 SDK 握手、cwd、缺失会话拒绝和关闭；rc.1 通过 `.env` 网关真实读取随机临时文件标记（首轮错误原因未确认，第二次只读人工重试通过）
  - [x] 独立复审补齐启动时 `.env` 再加载与任务总预算边界；运行代码和仓库依赖未修改


### 官方 DSH 引擎替换实现（2026-11-05）

- [x] Step 1: 锁定官方运行依赖与执行器接口
  - [x] pnpm 固定 SDK/runtime 0.2.2-rc.1 与 Node 要求，核对工具/profile实包
  - [x] 定义产品执行器、独占 worker 与持久任务/session 映射
- [x] Step 2: 实现真实引擎、产品工具和生命周期
  - [x] 官方 sdk profile、模型网关、隔离启动目录、事件映射与预算
  - [x] 审批/问题应答、真实关闭、恢复与错误终态
  - [x] 记忆工具接现有 Hub 服务，移除手写 ReAct 生产路径
- [x] Step 3: 接通 HTTP/语音与生产力任务
  - [x] 统一任务入口、状态/审批/问答/取消接口与WebSocket状态
  - [x] 替换生产力 runner 的模拟执行和静态回执
- [x] Step 4: 验证与交付
  - [x] 行为回归测试、真实模型文件/命令/记忆与取消/恢复验证
  - [x] 主agent修正子agent独立review问题，更新docs/todo并提交；全仓224项测试、typecheck/build通过
  - [x] 真网8项通过：官方bash canonical exit、文件SHA、记忆MCP、session恢复、记忆重载、原生问题与审批拒绝、长命令诚实取消
  - [x] iPhone 17 Pro模拟器核验审批/问题弹层，临时核验路由已删除；React Doctor相对a4983bc改动范围无新增诊断
  - [x] 独立review修复完成/取消竞态、并发交互、重启账本、abort窗口、resume admission及回执与SDK事件关联；同用户信任边界和业务验收待办已明确


### 家居控制等待与回读交互修复（2026-11-06）

- [x] Step 1: 检查截图对应状态与真实调用链
  - [x] 确认控制按钮等待全屋刷新、未核实状态不能随回读恢复
- [x] Step 2: 修复控制反馈与并发调节
  - [x] 即时目标反馈，同一设备串行下发并合并后续调节
  - [x] 使用操作回执更新卡片，后台刷新不阻塞控制
  - [x] 后续真实回读匹配后自动清除待核实状态
- [x] Step 3: 验证与独立 review
  - [x] 覆盖连续调节、迟到刷新、回读恢复与失败场景
  - [x] 运行相关测试、类型检查与 React Doctor
  - [x] 子 agent 只读 review，整理结论并提交本轮变更

  - [x] Mobile 150 / 家居包 42 项测试通过，Mobile typecheck / build 通过
  - [x] React Doctor 相对 HEAD 无新增错误；顺序刷新循环仅一项 await-in-loop 提示，因需排除操作交错的旧回读而保留串行
  - [x] iPhone 16e 真实米家：开关操作先未核实，延迟回读后自动恢复“已开启”；最终为原来的开启 / 53% 状态，未改账号或连接设置
  - [x] 复审补齐回执后旧 HA 缓存覆盖保护；本轮文件 diff --check 通过（其他现有文档尾随空白未改动）


### LIVE 语音连接失败排查（2026-11-06）

- [x] Step 1: 核对截图触发路径、运行服务与模拟器持久配置
  - [x] 当前 iPhone 16e 为本机语音 / 米家直连；不依赖 Hub
- [x] Step 2: 复现失败并获取底层握手、凭据或网络证据
  - [x] 真正运行的 App 返回 voiceKey 为空，网络连接前抛错；临时日志已移除
- [x] Step 3: 确认根因、独立复审诊断并记录结论
  - [x] 子 agent 只读独立 review 通过；区分当前 Key 为空与历史未保存原因未知
  - [x] 结论沉淀 `docs/live-voice-missing-local-key-diagnosis.md`，后续配置/错误提示修复记录 todo；本轮仅诊断


### 智能唤醒方案规划（2026-11-06）

- [x] Step 1: 核对现有语音、触发总线、隐私与生命周期实现
  - [x] 区分已实现链路、原型与真实硬件待验收项
  - [x] 核实候选本地唤醒引擎及 iOS / Android 限制
- [x] Step 2: 形成统一触发与介入策略设计
  - [x] 定义唤醒词、显式交互、事件触发、主动搭话和运行恢复
  - [x] 明确状态机、麦克风所有权、前后音频衔接、隐私与失效处理
  - [x] 制定分阶段交付、验收指标和待决项，沉淀 docs / todo
- [x] Step 3: 独立复审与交付
  - [x] 子 agent 只读 review，主 agent 修正文档；冷启动音频积压问题修正后复审通过
  - [x] 校验本地引用、代码围栏与 diff 空白；仅文档变更，提交规划文档


### Super-LOOI 工业设计与拆解（2026-11-06）

- [x] Step 1: 固定当前产品与视觉参考
  - [x] 截取当前 App 横屏首页，核对表情与功能入口
  - [x] 核对 LOOI 底座官方外观，区分现有硬件与设计提案
- [x] Step 2: 主 agent 制作工业设计图
  - [x] 产品整体效果图：底座 + 当前首页
  - [x] 分解设计板：结构、CMF、装配与使用状态
- [x] Step 3: 形成可执行设计与交付
  - [x] 输出尺寸边界、组件划分、验证清单及生成提示词
  - [x] 子 agent 独立 review 通过；PNG／引用／空白检查通过，更新实物待办并提交


### 核心 Agent Runtime 降维迁移至 `pi-agent`（2026-11-06）

- [x] Step 1: 组织进度计划并切换 `@super-looi/hub` 依赖至 `pi-agent`
  - [x] 在 `apps/hub/package.json` 引入 `@earendil-works/pi-agent-core@1.5.0`、`@earendil-works/pi-ai@1.5.0`、`@earendil-works/pi-schema@1.5.0`，移除 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-sdk-client`
  - [x] 执行 `pnpm install` 更新依赖树（移除 329 个 `@deepseek-ai/dsh*` 传递依赖包）
- [x] Step 2: 实现进程内极简 `PiAgentExecutor` (`apps/hub/src/agent/pi-executor.ts`)
  - [x] 基于 `@earendil-works/pi-ai` (`createModels` + `createProvider` + `openAICompletionsApi`) 对接 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`
  - [x] 实现受 `workspaceRoot` 沙箱约束的进程内工具：`read_file`、`write_file`、`bash`（透传 `AbortSignal` 与真实 `AgentCommandEvidence` 回执）、`ask_user_question`
  - [x] 接入 `Agent` 的 `beforeToolCall` 审批钩子、`subscribe` 实时步骤事件流、会话消息持久化恢复 (`resume`) 与真实进程取消
- [x] Step 3: 切换 Hub 默认执行器并迁移单元/集成测试
  - [x] `apps/hub/src/app.ts` 默认使用 `PiAgentExecutor`，`dsh-executor.ts` 保留兼容适配不删文件
  - [x] 更新 `apps/hub/test/dsh-executor.test.ts` 与 `apps/hub/scripts/verify-dsh.ts`，验证真实进程内工具执行、审批、提问、取消与恢复
- [x] Step 4: 全量构建测试、真网验证与独立子 Agent Review
  - [x] `pnpm typecheck`、`pnpm test`（Hub 94 项、Mobile 154 项等全仓通过）、`pnpm build` 全部通过
  - [x] `pnpm --filter @super-looi/hub verify:dsh` 真网模型 6 项探针（进程内 bash 退出回执、文件 SHA-256 读回、持久化会话恢复、原生提问、高危审批拦截、进程组取消）100% 通过
  - [x] 独立子 Agent 代码审查通过（补强进程组 `detached` 强杀、stdout/stderr 内存上限、symlink 真实路径逃逸守卫、`sessionId` 合法性校验及最近修改文件产物过滤），提交 commit


### 手机端 Agent loop 与去 Hub 调研（2026-11-06）

- [x] Step 1: 核对现有执行器与手机端边界
  - [x] 确认 pi-agent 迁移仅替换 Hub 执行引擎，记录现有未提交改动并保留
  - [x] 梳理 loop、模型传输、工具、任务持久化与 Hub API 依赖
- [x] Step 2: 调研社区端侧实现与平台限制
  - [x] 核验真实手机端 loop 项目、源码与许可证，区分远程控制端
  - [x] 核验 React Native / pi 可移植性、iOS 后台与工具边界（静态检查；运行验证仍待办）
- [x] Step 3: 输出适用方案与迁移顺序
  - [x] 将证据、推荐、未验证项沉淀 docs / todo
  - [x] 补查 dsh-Go 的 PRoot/Linux 本机路线与可嵌入移动底座
  - [x] 子 agent 独立 review 通过；主 agent 修正 dsh-Go 控制/对话链路图及移动 bundle 验收用词，固定源码引用/代码围栏/空白校验通过并提交

### 模型服务认证与订阅接入调研（2026-11-07）

- [x] Step 1: 核实 ChatGPT 与中国主流模型/聚合平台的官方认证、订阅与 API 边界
  - [x] 对照 ChatGPT、MiniMax、小米的开源 provider / OAuth 实现
  - [x] 扩展 Kimi、智谱、Qwen/百炼、DeepSeek、火山、腾讯、硅基流动，比较首批优先级
- [x] Step 2: 确定首批服务、兼容配置及手机端适配范围
- [x] Step 3: 沉淀引用证据、待验证项，独立复核并提交调研记录

  - [x] 官方文档与固定开源版本交叉核验；独立复核通过；记录当前 preview、第三方身份及套餐边界
  - [x] 文档空白检查通过；本轮仅调研，未运行账号登录或付费推理

### Hey LOOI 唤醒失效排查（2026-11-08）

- [x] Step 1：核对当前模拟器状态、唤醒配置与调用链
  - [x] 模拟器首页显示「待机 · 听 Hey LOOI」，确认已进入本地 KWS 待机
  - [x] 确认现有 iOS 探针仅验证模型加载与切流，未验证真实关键词命中
- [x] Step 2：复现关键词输入，定位识别或传递问题并修复
  - [x] 同一模型与词条下，4 条解码候选漏检较快的 Hey Louie 合成语音；12/16 条命中，16 条的两条非唤醒样本均未触发
  - [x] 对比仅匹配 LOOI/露伊：未改善该样本，保留完整唤醒词并将解码候选数调为 16
- [x] Step 3：执行原场景及相关回归，独立 review 并记录结果
  - [x] iOS 模拟器重启修复版后保持「待机 · 听 Hey LOOI」；用户对 Mac 麦克风口述 Hey LOOI 后进入「LIVE 连接中」
  - [x] `pnpm --filter @super-looi/nsh test:wake:ios`、`test:voice-runtime`、`cargo fmt --check` 通过；独立 review 未发现代码问题

### NSH 中英双语接入调研（2026-11-08）

- [x] Step 1：核对 NSH 运行时、当前文案与对话语言链路
  - [x] 确认应用为 NSH TSX + Rust，现有文案分布于 UI、store、runtime 与 Agent
  - [x] 核实系统语言、Intl 能力与手动语言偏好可用的现有接口
- [x] Step 2：核对最新社区方案与豆包／OpenAI 中英语音能力
  - [x] 对照官方发布记录、文档和本项目构建链比较候选框架；Paraglide v3 已有 esbuild 插件
  - [x] 豆包默认 Vivi 音色返回英文文本与 507,094 字节音频；英文 Jenny 音色在当前模型下零音频帧
- [x] Step 3：沉淀带来源的调研报告与后续接入建议
  - [x] 给出依赖的用途与复杂性成本、语言状态和提示词的职责边界
  - [x] 列明可执行的实施顺序与验收场景，记录未解决项到 todo.md
- [x] Step 4：独立复审、文档校验并提交本轮产物
  - [x] 修正独立复审指出的 Paraglide 构建边界：现有 esbuild 不处理 NSH 界面 TSX
  - [x] 后续实施清单经独立复审，文档无空白错误，英文音频时长和文件可解码性已核对

### NSH 中英双语产品落地（2026-11-08）

- [x] Step 1：界面语言与词条基础
  - [x] 保存既有 dirty baseline，核对 NSH 响应式与双 bundle 边界
  - [x] 加入 i18next / Intl polyfill、本地词条与持久化偏好
  - [x] 接入可即时切换的语言选择、日期与数字格式
- [x] Step 2：迁移界面与运行时消息
  - [x] 迁移首页、管理空间、模型、语音、家居、任务和无障碍文案
  - [x] 状态与错误使用稳定标识，由界面翻译
- [x] Step 3：统一文字与语音会话语言
  - [x] 新会话读取当前界面语言，提示词统一完整问题切换与短回应沿用规则
  - [x] 移除 Agent / 记忆提示中的固定中文输出要求
- [x] Step 4：验证与独立复审
  - [x] 全仓类型检查／测试、构建及语言行为测试通过；隔离基线实测 JS +539068 B、bytecode +804361 B
  - [x] iOS 模拟器逐屏核对与真实语音验证
  - [x] 独立 review 后修正并按本轮差异提交

  - [x] NSH 全套 21 项、Node voice/model/build-env 通过；QuickJS 复数、日期、偏好恢复实测通过
  - [x] iOS 模拟器英文主要界面与即时切换通过，修正模型／家居／语音长文本布局
  - [x] Vivi 产品提示词单轮英文输出：29 个音频帧、575872 字节 PCM
  - [x] Realtime session.update 真网三轮：英文→「好的」保持英文→明确中文，均有音频；更新只发生在回复语言变化时
  - [x] 独立复审通过，既有 dirty 与本轮差异分开提交（73fdaa8，后续语言更新单独提交）

### NSH 蓝牙底座连接体验优化（2026-11-08）

- [x] Step 1：核对底座页面、扫描和连接状态链，定位扫描完成后状态卡住的问题
- [x] Step 2：修正运行时状态并明确页面的扫描、连接、失败和空列表反馈
  - [x] 将自动连接开关文案对齐现有启动行为，真实断线重连记入待办
- [x] Step 3：运行相关测试与类型检查，独立复审并提交本轮改动
  - [x] NSH 24 项测试通过；BLE mock 覆盖首次授权等待、扫描完成和连接完成状态
  - [x] 主 agent 修正独立 review 指出的连接控制、扫描失败、旧错误与 Android 首次授权问题；复审通过

### 手机应用图标接入（2026-11-08）

- [x] Step 1：确认选定图标和 NSH 0.4.0 的图标配置入口
  - [x] 选定荧光黄底抽象机器人图标，输出 1024 × 1024 无透明 PNG
  - [x] 核对 NSH 的 `nsh.json.icon` 会进入 iOS asset catalog 和 Android launcher mipmap
- [x] Step 2：接入项目配置与文档
  - [x] 在应用 manifest 指向工作区图标资产
  - [x] 更新应用说明中的图标来源与打包行为
- [x] Step 3：验证真实平台产物
  - [x] 构建 iOS 模拟器应用，`Assets.car` 含 `AppIcon`；安装后主屏幕显示选定图标，截图保存于 `docs/artifacts/app-icon/ios-home.png`
  - [x] 构建 Android APK，manifest 指向 `res/mipmap-xxxhdpi-v4/ic_launcher.png`，包内资源为 192 × 192
  - [x] 独立 review 通过；NSH 开发宿主 `NshDev` 使用通用图标，正式 package 已使用项目图标

### NSH 底座扫描与连接解耦（2026-11-08）

- [x] Step 1：定位界面、store、BLE 运行时和连接取消路径中的耦合点
- [x] Step 2：允许连接期间扫描，点选新底座时切换连接目标
  - [x] 分离扫描和连接的 UI 禁用条件；扫描取消、连接取消及迟到结果按操作代次处理
  - [x] iOS 保留待连接目标所需的扫描；Android 连接不再中断附近设备扫描
- [x] Step 3：验证连接切换与扫描行为，完成独立 review
  - [x] BLE mock 覆盖连接中扫描、替换目标、授权等待取消和断开后立即重连
  - [x] NSH 类型检查、voice runtime、iOS 模拟器探针、Android 插件测试、looi-driver 17 项及独立复审通过

### Android 横屏挖孔遮挡修复（2026-11-08）

- [x] Step 1：真机复现并定位安全区数据链
  - [x] 魅族 20 Pro 横屏左侧系统挖孔 84 px，NSH `safeArea()` 四边均为 0
- [x] Step 2：在现有 Android 插件中读取左右挖孔边界，通过 NSH host 事件更新应用根容器，背景铺满屏幕
- [x] Step 3：仅在魅族 20 Pro 真机安装开发包并核对左右两侧，完成相关检查与独立 review
  - [x] 真机截图显示导航轨从左侧 84 px 安全边界后开始，右上返回按钮与右侧工作区完整显示
  - [x] NSH 类型检查、App UI 2 项测试、Android 插件测试通过；独立 review 通过

### `VoiceRuntime` 模块化重构与 `run_agent_task` 异步协同升级（2026-11-09）

- [x] Step 1：审视模块边界、实测豆包主动播报协议并落地实施计划
  - [x] 基于 `codebase-design` 审视 `apps/nsh/runtime/voice/runtime.ts` 的 4 类生命周期耦合，确定 `VoiceCredentialStore`、`VoiceAudioPipeline`、`LiveVoiceSession` 与 `VoiceTaskCoordinator` 边界
  - [x] 真网实测豆包 Duplex V3 `1.2.6.1`：`session.update` + `speech_text_buffer.commit` 产出 240,054 B 音频流（无 `call_id` 的 `conversation.item.create` 不触发响应）
  - [x] 沉淀设计方案至 `docs/plans/voice-runtime-refactor-and-async-task-plan.md`
- [x] Step 2：拆分重构 `apps/nsh/runtime/voice/`（保持存量行为零回归）
  - [x] 提取 `credentials.ts`（凭据与 `voiceId`、`wakeEnabled` 持久化）
  - [x] 提取 `audio-pipeline.ts`（纯同步 PCM 切片、背压、RMS 与打断已播毫秒账本）
  - [x] 提取 `live-session.ts`（一次性 WebSocket 会话实例隔离，收敛写队列、回合门控与取消账本）
  - [x] 精简 `runtime.ts` 为设备级状态监督器（`idle` / `permission` / `standby` / 当前会话槽位），通过存量全部语音与 NSH 24 项集成测试并提交
- [x] Step 3：实现双协议 `WHEN_IDLE` 主动播报与 `run_agent_task` 异步晋升升级
  - [x] 在 `packages/looi-runtime/src/voice/realtime-protocol.ts` 增加 `encodeProactiveSpeech`（豆包与 OpenAI 双协议适配）
  - [x] 实现 `task-coordinator.ts` 与 `manage-agent-task.ts`，升级 `run-agent-task.ts` 与 `prompts.ts`（2.5s 快路径直返 + 超时自动转后台 + 进度查询/中止）
  - [x] 接入 `apps/nsh/store.ts` 与 `build-runtime.ts`：解耦 `endSession()` 对后台长任务的取消行为，修正语音对话与后台思考并发时的表情优先级，同步更新 `docs/arch/`
  - [x] 新增 `apps/nsh/tests/voice-async-task-cases.ts` 覆盖快慢分流、挂断存活、`WHEN_IDLE` 排队播报与待审批通知
- [x] Step 4：全量验证、独立子 agent 代码复审与提交
  - [x] `@super-looi/runtime` 79 项测试、`@super-looi/nsh` 类型检查 / 语音与异步测试 / 24 项集成测试与 `build` 全部通过
  - [x] 独立子 agent 首轮审查 6 项并发边界与 3 组清理项全部修复并补齐回归单测，终审复核 PASS 后提交


### 72 桌宠表情声明式目录与 Canvas 原语引擎接入（2026-11-09）

- [x] Step 1：扩展 `looi-runtime` 72 表情类型契约与控制器行为守卫
  - [x] 完成 72 表情视觉图板（全 7 张）与方案文档 `docs/plans/face-72-declarative-primitives-plan.md`
  - [x] 新增 `packages/looi-runtime/src/shell/face-expressions.ts`，更新 `presence-state.ts`、`robot-face-controller.ts` 与 `build-runtime.ts`
  - [x] 补齐 `packages/looi-runtime/test/robot-face-and-toast.test.ts` 对 72 态切换、非圆眼防误眨眼与静息态锁定的单测（80 项全过）
- [x] Step 2：实现主题语义 Token、72 态声明式配方表与 `RobotFace` 正交原语渲染器
  - [x] 在 `apps/nsh/theme.json` 与 `apps/nsh/DESIGN.md` 增补低饱和 OLED 表情语义色 Token
  - [x] 实现 `apps/nsh/ui/face-recipes.ts`（覆盖 `#01–#72` 全部五通道几何配方，存量 7 态保持 1:1 参数）
  - [x] 重构 `apps/nsh/ui/RobotFace.tsx` 接入 `drawRobotFace` 五通道 `Canvas` 原语引擎（零瞳孔挖空、零硬编码色值）
- [x] Step 3：回归测试与构建验证
  - [x] 新增 72 表情配方与 `Canvas` 原语栈平衡/Token 守卫/眨眼契约一致性测试（`RobotFace.test.tsx`、`FaceProbe.tsx`）及架构图快照同步（`docs/arch/`）
  - [x] 通过 `@super-looi/runtime` 80 项单测、`@super-looi/nsh` `typecheck`、26 项全量集成测试与 `build`
- [x] Step 4：独立子 agent 代码复审与提交
  - [x] 独立子 agent 完成代码与视觉规范一致性复审，修复安全区 `safeArea()` 居中缩放、`cat_w` 逆时针开弧、`glasses` 鼻梁桥接/`pout_puff` 嘴角折线与静息态 `waveformBars` 守卫，终审 `PASS`
  - [x] 更新 `progress.md` 并隔离提交本轮变更
- [x] Step 5：iOS 模拟器预览台、可中断表情过渡与按需微动态循环
  - [x] 升级 `apps/nsh/FaceProbe.tsx` 与 `apps/nsh/scripts/nsh.ts`（支持自定义 `.tsx` 入口与 `ios:faces` 脚本），在 iOS 模拟器提供 72 表情分组试镜、自动轮播与单次眨眼触发
  - [x] 在 `apps/nsh/ui/RobotFace.tsx` 实现 `drawRobotFaceTransition`（同形态直接插值、异形态带预备/过冲弹性的交叉溶解及可中断重定锚）与 `normalizeBlinkProgress` 静息态防漏眨眼守卫
  - [x] 实现 `hasAmbientMotion` 与 36 个特殊表情连续微动态（`dizzy_spiral` 双眼反向旋转、`deep_snore` `ZZZ` 持续上浮消散、`coffee_boost` 蒸汽升腾、阅读扫视、计时器走针、落雨/音波/心跳等），36 个常规表情静止时保持零定时器空闲开销，并遵守 `reduceMotion()` 与前后台生命周期守卫
  - [x] 补齐 `apps/nsh/RobotFace.test.tsx`（过渡矩阵、微动态连续性、`thinking` 满眨眼挑眉连续性、唤醒中途打断及原生 `Canvas` 72 态回放），同步更新 `docs/arch/` 快照并通过独立子 agent 两轮复审 `PASS`

## 前台屏幕常亮（2026-11-09）

- [x] 接入 Android Activity 与 iOS Application 的前台常亮、失活释放。
- [x] iOS `aarch64-apple-ios` 编译检查、Android 原生插件编译和插件测试通过；独立 review 为 PASS。
- [x] 魅族 20 Pro 开发包验证：15 秒系统熄屏设置下前台静置 25 秒仍常亮，切回桌面 25 秒后熄屏；已恢复原有 600000 ms 设置。


## 蓝牙底座二次吸附全自动连接与首屏多模态反馈（2026-11-09）

计划文档：[`docs/plans/ble-dock-auto-attach-plan.md`](docs/plans/ble-dock-auto-attach-plan.md)

- [x] Step 1：梳理现有 BLE 连接、在座通知与首屏状态流断点，完成模块边界设计与实施计划 `docs/plans/ble-dock-auto-attach-plan.md`
- [x] Step 2：优化双端原生层与传输适配器已知设备重连
  - [x] Step 2.1：iOS `apps/nsh/src/ble/ios.rs` 支持 `retrievePeripheralsWithIdentifiers:` 已知 UUID 系统级直连与蓝牙上电挂起恢复
  - [x] Step 2.2：Android `LooiBleBridge.java` 显式指定 `BluetoothDevice.TRANSPORT_LE`
  - [x] Step 2.3：`NshNativeBleAdapter` 新增目标设备命中即停扫描 `waitForDevice(deviceId, timeoutMs)`
- [x] Step 3：在 `BodyRuntime` 实现前台静默自动重连守望与在座机械抬头问候
  - [x] Step 3.1：实现 `setForegroundActive(active)`、意外断线退避重连、`manualDisconnectHold` 手动断开保持与 `scan()` 让路恢复
  - [x] Step 3.2：实现 `onDockChange(true)` 上升沿 `67° → 55°` 云台问候与 `headCommandEpoch` 零冲突抢占取消，并在 `NativeRuntime` / `build-runtime.ts` 导出接口
- [x] Step 4：在 `VoiceAudio` 与 `VoiceRuntime` 实现单流共享的双频磁吸提示音 `playDockCue`
  - [x] Step 4.1：Rust `apps/nsh/src/audio.rs` 新增 `play_dock_cue(docked: bool)`（含自激抑制窗口与测试实现）
  - [x] Step 4.2：`VoiceRuntime` 新增 `playDockCue(docked: bool)`（兼容 `standby` 复用、`idle` 纯输出流临时启停与 `speaking` 避让）
- [x] Step 5：打通 `store.ts` 首屏常驻状态同步、四重瞬态反馈与中英文文案
  - [x] Step 5.1：更新 `extra-catalog.ts` 中英文词条与 `BodySpaceView.tsx` 自动重连开关文案
  - [x] Step 5.2：在 `store.ts` 接入前后台同步、首屏守望轮询及吸合/脱座边沿触发（`dock_snap` / `undock_float` 瞬态表情、`LightToast`、音效）
- [x] Step 6：补齐单元/UI 自动化测试、独立子 agent Review 与魅族 20 Pro 真机安装验证
  - [x] `@super-looi/looi-driver` 26/26 单测、`@super-looi/nsh` 类型检查、全量测试（`test:voice-runtime`、`test:model-list`、`test:build-env`、Rust/QuickJS/Headless UI 26/26、`test:plugins`）、`build` 与 iOS `aarch64-apple-ios` 编译检查全部通过
  - [x] 独立子 agent 三轮代码审查终审 **PASS**（已修复 CoreBluetooth 单例 `CBPeripheral` 重连取消竞态、`manualDisconnectHold` 切后台保持、静默重连中途异常断连回收与 `idle` 纯输出流升级录音流等边界）
  - [x] Android 开发包已重新编译原生库并安装至魅族 20 Pro（`391QYGCN224FE`），实测首屏与底座页渲染、吸合上升沿 `67° → 55°` 云台问候、`底座已吸合就绪` Toast 及 `AAudio` 纯输出磁吸音效流正常且无异常日志

## NSH Linux Shell 接入计划审查（2026-11-09）

- [x] Step 1：读取计划、仓库约束与相关技能，明确按当前计划全文审查。
- [x] Step 2：核对兼容层、Pi Agent 与原生后端的实际调用契约。
- [x] Step 3：完成独立子 agent 复核，合并 2 项 P1 与 2 项 P2；逐项核对固定上游源码。
- [x] Step 4：将 4 项待解决问题记录到 `todo.md`，整理带位置的审查结论。

## NSH Linux Shell 接入计划修订（2026-11-09）

- [x] Step 1：确认 4 项审查问题与现有计划的修改位置。
- [x] Step 2：补齐 guest 环境、PRoot 硬链接映射及双端进程回收规则。
- [x] Step 3：补充对应真机验收项，并同步 `todo.md`。
- [x] Step 4：独立子 agent 复核 PASS；补齐 Android 子进程 `SIGQUIT` 解屏蔽要求，文档差异检查通过。


## NSH 双端 Linux Shell 落地（2026-11-09）

计划：`docs/plans/nsh-linux-shell-openminis-plan.md`

- [x] Step 1：固定依赖与双端构建打包
  - [x] 读取计划、现有执行器和仓库设计规范，记录工作区已有修改
  - [x] 固定 Alpine / iSH / PRoot / loader，完成缓存与工具链准备脚本
  - [x] 接入 iOS 库、Android 插件资产与首次安装
- [x] Step 2：实现宿主 ShellRunner 与工作区路径一致性
  - [x] 定义执行契约、guest 环境与双端实现
  - [x] 完成后代回收、输出排空和工作区链接解析
- [x] Step 3：兼容层流式接口、Agent 与任务界面
  - [x] 输出队列、UTF-8 拼帧、原子尾块与超时语义
  - [x] 实时输出、全终态回执、审批与后台取消
- [x] Step 4：验证与交付
  - [x] 定向测试、类型检查、构建与原生插件检查
  - [x] Android ARM64 真机验收；iOS 按用户确认范围完成双 SDK 构建检查
  - [x] 独立子 agent review、文档及架构更新、分阶段提交

- 验证记录：兼容层 8 项 Rust 单测、桌面 QuickJS 全套测试、结构化超时四分支测试通过；iOS 设备未签名 `.app` 已成功链接并打入 fakefs 归档，修复 ONNX Clang builtins 的设备链接阻塞。

- Android 魅族 20 Pro（Wi-Fi ADB `192.168.3.123:5555`）Linux 专项测试通过：guest 环境/覆盖、文件共享与账本隔离、50,000 B 管道、UTF-8 双流、正常/取消/超时后代回收、相对/绝对/硬链接、经审批安装 Git/Python/Node/npm/pnpm/ripgrep。
- 用户确认 iOS 按构建检查交付；本机无 iPhone 与有效开发签名，未执行 iPhone 安装或运行。

- 完整 Android `CompatProbe` 通过（16.3 秒），修复 Pi SDK 桌面工具缓存目录覆盖 guest PATH 的实际问题；桌面 QuickJS 全套、85 项运行时测试、NSH 26 项测试与构建通过。
- 应用进程 force-stop / relaunch 后，在同一 guest 再次运行 Git 初始化与状态、Python、Node、pnpm、ripgrep 成功；包文件与 rootfs 版本标记保留。
- 两位独立子 agent 分别完成原生/兼容层与 Agent/UI 终审，均通过。

- 最终 Android 扩展专项通过（31.5 秒），增加双流各 24,010 字节取消尾部排空与内置 rg 显式软链接路径验证；截图已核对，日志见 `docs/artifacts/nsh-linux-shell/`。
- 使用说明、第三方许可证、iOS 对应源码/构建说明与 `docs/arch/` 已同步；APK 与双 SDK `.app` 均确认包含 rootfs 及许可证资源。

- 最终补充硬链接反向写入与外部链接不阻断后续硬链接产物扫描，Android 专项 38.6 秒通过；所有本次问题已清理，iPhone 实机运行入口保留在 `todo.md`。


## Agent 记忆与上下文管理社区调研（2026-11-09）

- [x] Step 1：核对现役实现，明确工作记忆、长期记忆、session 与压缩的比较范围。
- [x] Step 2：查证 Claude Code 官方机制及社区代表实现。
- [x] Step 3：查证 Codex 官方文档、公开源码及压缩 API 的边界。
- [x] Step 4：整理机制对比、适用条件与本项目的复杂性取舍，记录未决问题。
- [x] Step 5：独立复核关键结论与来源，提交调研文档。


## Pi 工具审批策略解耦（2026-11-09）

- [x] Step 1：核对 `beforeToolCall`、NSH 调用方与模块设计规范，明确审批策略和执行生命周期的职责。
- [x] Step 2：提取工作区路径解析及审批策略，提供按工具名注册规则的扩展接口，保持现有审批语义。
- [x] Step 3：覆盖三种模式、内置别名、自定义规则与审批交互；runtime 类型检查、89 项测试、构建及 NSH 类型检查通过。
- [x] Step 4：独立子 agent review PASS；修复交互测试中 observer 吞掉断言的问题，隔离提交本轮改动。


## Pi Agent 联网搜索缺口排查（2026-11-09）

- [x] Step 1：核对执行器、默认工具与 NSH 宿主的工具注册。
- [x] Step 2：读取 Android 真机会话，确认 GRIN ZERO 搜索任务直接返回能力不足，未调用工具。
- [x] Step 3：检查任务完成状态与能力注入，区分本次根因及相邻缺口。
- [x] Step 4：独立子 agent 复核工具注册、HTTPS 权限、任务完成语义及记忆/压缩/Skills 接线；搜索缺口与完成状态记录到 `todo.md`，提交排查记录。


## OpenAI 官方模型默认内置搜索（2026-11-09）

- [x] Step 1：确认官方 API / ChatGPT 订阅的 Pi 请求扩展点、搜索事件和引用表示。
- [x] Step 2：沿用 Pi 请求与原始事件 hooks 默认声明官方搜索，复用工具过程/计数/追踪；URL 引用写入会话，任务回复使用 NSH TextView 展示可点击来源。
- [x] Step 3：新增实际 Responses SSE 链路测试，覆盖请求、搜索计数、Unicode 引用、多来源、多轮、拒答、第三方渠道与搜索错误；93 项 runtime 测试、构建及 NSH 类型检查通过。
- [x] Step 4.1：独立子 agent review；修复无引用拒答文本被覆盖的问题，复核通过并提交实现。
- [x] Step 4.2：魅族 20 Pro 开发宿主以官方 `gpt-6.1-terra` OAuth 账号完成 GRIN ZERO 搜索；任务 `task_81cdc600-2705-4e94-939e-7d86520cf2cc` 持久化为 `succeeded`、工具调用 1 次、搜索 start/end 完整，来源点击后 Chrome 打开对应论文；已恢复开发包主页，正式包未修改。
- [x] Step 4.3：根据真实响应修复已有 Markdown 来源被重复追加的问题；回归用例先失败后通过，独立子 agent 复核通过，94 项 runtime 测试、构建及 NSH 类型检查通过。

## README 产品介绍与上手指南更新（2026-11-09）

- [x] Step 1：对照 tripo-studio-plugin README，核对现有文档、脚本、功能与截图。
  - [x] 确认主分支相对 origin/main 的架构差异与工作区已有修改，使用 HEAD 独立工作树编写。
  - [x] 核对表情、语音、模型、Linux Shell、家居与 BLE 底座的实际入口。
- [x] Step 2：重写产品定位、使用场景、真机上手、功能矩阵与界面画廊。
  - [x] 修正失效的无设备 iOS 启动说明和旧模块源码链接。
  - [x] 将详细构建与内部实现引向现有专题文档。
- [x] Step 3：独立子 agent 审查、链接检查与文档提交。
  - [x] 修正审查发现的横屏配置与 iPhone 开发观测表述，复核通过。
  - [x] 检查 50 个相对链接、图片和章节锚点，差异格式检查通过。
  - [x] 完成两轮文档提交，并同步至当前工作区，保留原有未提交修改。

## README 默认英文与中文入口（2026-11-09）

- [x] Step 1：确认移除顶部 GPL 链接，保留文末许可证说明与当前内容结构。
- [x] Step 2：将 README.md 改为英文，保留 README.zh-CN.md，添加双向语言切换。
- [x] Step 3：检查双语内容、命令与链接，独立审查通过并提交。
  - [x] 两版共 90 个相对链接、图片与锚点通过，标题层级、表格、命令和文档入口对应。
  - [x] 英文表达与内容对应审查通过，顶部语言切换与文末许可证说明符合要求。

## 家居与表情接入语音规划（2026-11-10）

- [x] Step 1：核对现有实时语音、Pi 家居工具、家居能力元语与 72 表情显示链路。
- [x] Step 2：编写 `docs/plans/voice-home-and-expression-integration-plan.md`，确定共享能力执行、表情覆盖及组合指令的按轮续说方案。
- [x] Step 3：完成独立子 agent review，修订豆包回传边界、家居反馈共享、用户开口事件和排队命令的会话归属；差异格式检查通过，提交规划文档。


## 管理空间安全区背景衔接（2026-11-10）

- [x] Step 1：定位横屏外层统一安全区 padding 导致的左右空带、底部断层与顶栏分隔线提前结束。
- [x] Step 2：改为各表面铺满屏幕，由导航内容、顶栏控件和工作区分别消费安全区；同步设计规范。
- [x] Step 3：类型检查与构建通过；隔离本轮改动后 4 项现有 App UI 回归通过，独立子 agent review 通过；修正审查发现的 Android 桌宠挖孔补偿归属，隔离提交。
- [ ] Step 4：连接真机后核对横竖屏边缘与分隔线视觉效果。


## 家居设备网格交互优化（2026-11-10）

- [x] Step 1：定位尺寸徽标、缩放触摸与滚动竞争，以及全屋概览的布局归属。
- [x] Step 2：完成界面与手势修改。
  - [x] 移除编辑状态的尺寸徽标。
  - [x] 缩放把手通过原生手势捕获独占拖动，保留设备区域滚动。
  - [x] 增加概览折叠开关，折叠后网格使用释放的空间，保留恢复入口。
  - [x] 将折叠状态放入现有 home UI store，跨管理空间横竖屏分支重建保留。
- [x] Step 3：完成定向交互测试、类型检查、构建与独立 review。
  - [x] 4 项 App UI、1 项网格手势/折叠回归与 2 项加载/语言回归通过。
  - [x] 类型检查、TSX 构建与独立子 agent review 通过。
- [x] Step 4：记录验收结果并隔离提交本轮修改。
  - [x] 实现提交 `e1a028c`；原有未提交修改保留在工作区。
  - [x] Android/iPhone 均未连接，真机视觉与拖动手感验收记录到 `todo.md`。


## 米家视频真实登录接线修复（2026-11-11）

- [x] Step 1：确认当前验证码、短信倒计时与授权结果均为 store 内模拟；定位先前原生实现所在工作区。
- [x] Step 2：迁移原生账号与媒体实现，保留当前页面布局并接通真实挑战、验证码发送、STS、设备发现和凭据恢复。
  - [x] 删除生产状态层中的固定验证码、默认账号和固定摄像头数。
  - [x] 将当前页面的提交、刷新、重发、取消与真实原生账号状态绑定。
  - [x] 接回原生预览，保持已有米家控制授权独立。
- [x] Step 3：执行登录交互、原生协议与家居摄像头回归，类型检查、构建和独立审查。
- [x] Step 4：在 iPhone 16e 恢复真实账号并验证实时画面，更新架构与遗留事项，分离提交原生实现和页面接线。
  - [x] 6 项生产登录控制器回归、3 项家居原生会话回归、3 项 Rust 协议／真实 HTTP 序列回放、1 项页面交互与 1 项原生节点生命周期测试通过。
  - [x] 类型检查和 TSX 构建通过；独立审查发现的图形错误提示清理时机与导航取消出口已修复。
  - [x] 复用此前用户指定的 iPhone 16e 横屏模拟器，已恢复真实视频账号、发现 4 台摄像头，并在大厅详情看到实时原生画面；本次没有重新发送用户短信。


## 清理未接入的旧记忆与上下文模块（2026-11-11）

- [x] Step 1：核对当前 NSH 调用链与旧模块引用，确定删除边界。
  - [x] 区分现役任务／会话持久化、旧记忆账本及上下文采集和装配组件。
  - [x] 核对混合验收与原生兼容探针，保留独立于旧记忆的验证。
- [x] Step 2：删除旧模块，清理导出、闲置配置与 SQLite 账本端口。
  - [x] 清理对应测试及兼容探针中的旧记忆分支。
  - [x] 更新记忆调研、待办和架构源码入口。
- [x] Step 3：运行受影响测试、类型检查与构建，完成独立子 agent review。
  - [x] Runtime 78 项测试、类型检查与清理旧构建产物后的构建通过；混合验收保留 33 项场景。
  - [x] QuickJS `looi-runtime` / `mobile-runtime` 探针通过，覆盖文件与 Shell 工具、SQLite 任务重开、会话恢复与家居回执。
  - [x] NSH 类型检查与 App 构建通过；独立子 agent review PASS。
  - [x] 架构图移除个人记忆入口，修正既有语音待机签名锚点并重新生成 96 份源码快照。
- [x] Step 4：记录验证结果并提交本轮变更。


## 语音主 Agent、多任务与长期导演的社区架构调研（2026-11-11）

- [x] Step 1：核验实时语音与执行模型协作的一手资料。
  - [x] 对照 OpenAI Chat-Supervisor 示例的工具分工与上下文传递。
  - [x] 核验 LiveKit 长耗时工具、进展更新与主动表达机制。
- [x] Step 2：核验多任务、结果通知与长期观察者的社区实现。
  - [x] 对照 DeepSeek Super-agent、OpenClaw 与 Letta 的具体职责和实现范围。
- [x] Step 3：汇总机制映射、来源与差异，记录影响本项目的取舍。
  - [x] 增补 Qwen Audio Agent 固定提交的前台工具、持久协调会话、并行项目与结果播报源码。
  - [x] 区分 LiveKit 异步委派、单向观察注入和 OpenAI 等待式 Supervisor。
- [x] Step 4：复核调研记录并隔离提交本轮文档。
  - [x] 子 agent 独立复核 Qwen、LiveKit 与 OpenAI 新增证据，结论 PASS。


## Agent 架构交互对照图（2026-11-11）

- [x] Step 1：以当前调用链和固定版本社区证据整理三个对照视图。
  - [x] 区分当前单任务、Qwen ACP 持久协调与 LOOI 统一协调入口的目标方案。
- [x] Step 2：制作分步任务与上下文流转图。
  - [x] 覆盖任务受理、独立执行、用户改口、观察反馈、完成投递与主动表达。
- [x] Step 3：复核事实边界、交互逻辑并交付对照图。
  - [x] 按用户明确的单一协调入口统一图、任务结果链路和分步上下文。
  - [x] 独立子 agent 复核通过；浏览器核对架构图和分步交互，JavaScript 语法检查通过。


## GPT、Qwen 与 LOOI 协调架构对照（2026-11-11）

- [x] Step 1：核验 OpenAI 官方语音架构、委派和旁路控制文档。
  - [x] 区分旧 Chat-Supervisor、GPT-Live 托管委派和自有后端委派。
- [x] Step 2：制作可切换 GPT 模式的三方架构图与职责对照。
- [x] Step 3：复核图义与交互，将结论更新到社区调研并隔离提交。
  - [x] 独立子 agent 复核 OpenAI 三模式契约，修正 Qwen 前台／后台工具的图义。
  - [x] 浏览器核对三模式切换、节点与表格联动；JavaScript 语法检查通过。


## 家居首次进入缓存（2026-11-11）

- [x] Step 1：确认加载链路与缓存归属，复用现有 SQLite 和规格缓存接口。
  - [x] 核实启动预加载已存在，持久设备快照与 MIoT 规格缓存尚未接入。
- [x] Step 2：接入原始设备快照持久化，启动先恢复展示、后台更新。
  - [x] 按账号、区域和来源处理快照归属及重新绑定失效。
  - [x] 保持缓存展示与实际连接状态分离。
- [x] Step 3：接入 MIoT 规格持久缓存，保留 14 天有效期和连接生命周期。
- [x] Step 4：运行缓存恢复、联网刷新及受影响回归，独立子 agent 审查并提交。
  - [x] 5 项缓存集成回归、10 项开关反馈、3 项摄像头、52 项 Home Assistant 测试及 NSH 类型检查通过。
  - [x] 修复独立审查发现的多来源部分连接失败覆盖完整快照问题，补充恢复后空目录清理回归。
  - [x] 魅族 20 Pro 已热更新，SQLite 已保存设备快照及 39 份型号规格。
  - [x] NSH App 构建、2 项中英文加载态回归和带私有数据目录的 QuickJS 原生兼容探针通过；独立复审无待修复项。
  - [x] 魅族 20 Pro 冷启动后家居页展示 44 台缓存设备；代码提交 `2677cfe`。


## 首屏输入框位置与占位文字（2026-11-11）

- [x] Step 1：将现有输入框移至底部回复区下方，复用首屏次级文字颜色提高占位文字对比度。
- [x] Step 2：完成类型检查、构建及 Android 真机横屏查看，检查输入与键盘显示。
  - [x] 魅族 20 Pro 确认底部位置、占位文字对比度、键盘弹出与收起；屏幕键盘输入后发送按钮可用。
- [x] Step 3：修复独立审查发现的键盘遮挡，复审通过并隔离提交本次改动。

## Langfuse 语音会话与重连上下文修复（2026-11-12）

- [x] Step 1：复核原始记录和模块职责，移除本次 todo 条目。
  - [x] 确认连接 ID、后台逻辑会话 ID 与主动播报文本采集三处缺口。
- [x] Step 2：统一逻辑会话 ID，接通语音重连历史与初始提示词记录。
  - [x] 复用已有 15 分钟会话窗口，语音、后台任务与通知保持同一 session ID。
  - [x] 保存已完成的对话转写，重连注入历史并在窗口过期后清理。
- [x] Step 3：补齐主动播报文字与上下文记录。
  - [x] 记录豆包 session.create 与主动播报提交文本，保持失败和打断语义。
- [x] Step 4：完成针对性回归、类型检查、构建、独立审查和隔离提交。
  - [x] 语音运行时与 16 项遥测／本地追踪回归、两端协议的重连历史、类型检查和 App 构建通过。
  - [x] 独立审查发现并修复零音频失败／取消误记播报全文的问题，复审通过。
  - [x] 本地 Langfuse 真实入库回放：同一 session 聚合 2 个连接 trace、1 份重连历史提示词、1 次后台投递及完整报时播报。
  - [x] 核对 ADB、无线发现与 iPhone 设备列表：均无连接真机，未安装或运行模拟器。
  - [x] 实现与回归已隔离提交 `a9e6386`。

## 语音过早接话与重复收音诊断（2026-11-12）

- [x] Step 1：读取指定 Langfuse 会话，核对用户断句、模型响应和工具调用的时间线。
  - [x] 查询会话 `voice_89865b34-843e-4e76-9b7f-643718479f2b` 的 45 条观测，确认三个连接均使用豆包 `1.2.6.1`。
  - [x] 多轮用户转写包含上一轮助手整句，并出现「查了下→查了一下」近音变化；客户端对 ASR 文本直接覆盖，回声回灌是证据最强的解释。
  - [x] 11:01:26.280 收到「我想知道的是。」最终转写，11:01:26.299 开始响应；句意尚未完整即进入下一轮。
- [x] Step 2：核对实际语音协议参数、采集节奏及手机原生回声消除配置。
  - [x] 三次真实握手均发送 `end_smooth_window_ms=2500` 与 `enable_custom_vad=true`；缺少最后一帧人声时间，不能由最终转写到响应的间隔判断窗口失效。
  - [x] iOS 仅设置 `voiceChat`，未调用 `setVoiceProcessingEnabled`；Apple 明确说明此组合不会启用回声消除。会话日志未记录平台；用户随后确认本次现象发生于 iOS 模拟器。
  - [x] Android 已设 `VOICE_COMMUNICATION` 与 `MODE_IN_COMMUNICATION`，没有显式 AEC 绑定或实际启用状态；实际设备是否自动启用需测量。
  - [x] 上行每次最多发一个 20ms 帧，处理完成再等待 20ms，无耗时补偿；超过 500ms 缓冲丢最旧帧，属于需修正的节拍问题，尚无本次丢帧证据。
- [x] Step 3：独立复核证据，记录根因、配置调整建议和未确认项。
  - [x] 子 agent 独立复核 ASR 归属、时间线和双端 AEC；保留回声为主要解释，不将参数已发送等同于服务端已生效。
  - [x] 修正项记入 todo.md；本轮仅诊断，未修改业务代码与语音参数。
- [x] Step 4：核验豆包 API 与设备端解决方案。
  - [x] 核验 Seeduplex 回声处理、自动判停与主动控制能力：现役双工移动 SDK `0.0.15.0` 内置端侧 AEC，需要启用开关与 `aec.model`；直接 WebSocket 的公开参数未提供 AEC 开关。
  - [x] 对照 iOS 13+ 语音处理与 Android API 28+ AAudio 会话／Java AEC 互操作，明确沿用现有原生音频层的最小改法与 SDK 接管采播的集成成本。
  - [x] 方案整理到 `docs/voice-duplex-aec-and-turn-taking.md`，独立复核通过；区分云端动态判停、手机系统 AEC 和官方 SDK 软件 AEC，并说明各自集成成本。
- [x] Step 5：根据用户补充核对 iOS 模拟器路由。
  - [x] 当前启动 iPhone 16e／iOS 26.3；CoreSimulator 配置输入为 `BuiltInMicrophoneDevice`，输出跟随宿主默认设备；`system_profiler` 确认当前默认输出为 MacBook Pro Speakers。
  - [x] 当前路由存在 Mac 外放被 Mac 麦克风录回的路径，结合助手整句出现在用户转写及未启用引擎语音处理，回灌仍为主要解释；当前路由不替代历史会话测量，Android 核查不能用于归因此次现象。

## Android AEC 三项核查（2026-11-12）

- [x] Step 1：追踪实际采播配置。
  - [x] 使用 AAudio，输入请求 preset `7`（`VOICE_COMMUNICATION`）、输出请求 usage `2`（语音通信），Java 设置 `MODE_IN_COMMUNICATION`；输入 preset 未读回。
- [x] Step 2：核对 AEC 控制和播放参考证据。
  - [x] 未调用 AAudio `setSessionId/getSessionId`，没有 Java AEC 创建、启用／读回与释放逻辑；现有状态回执无 AEC 信息。NDK 默认会话 ID 为 `NONE`，尚未接入应用可控的 Java AudioEffect 路径。
  - [x] 自定义队列经 `AAudioStream_write` 播放，采集经独立 AAudio 流读取；没有应用侧软件 AEC／参考输入。系统是否提供正确参考、设备是否自动做 AEC 仍需真机判断，不能仅凭采样率差异或自定义播放判定失配。
  - [x] 子 agent 独立复核三项结论与 NDK 会话语义；待确认项记入 todo.md。
- [ ] Step 3：真机横屏读取实际 preset、音频会话／AEC 启用状态及效果链，测量外放回声；核查时 `adb devices -l` 无连接设备。

## 通用 AEC 与 Realtime 框架调研（2026-11-12）

- [x] Step 1：核验独立 AEC 模型／库的端侧可用性。
  - [x] 用户提供 `aec.model` 为 100076 字节、SAMI 标识；找到独立 SAMICore C AEC 与纯离线运行库，区分 RNNAEC 神经路径、DSP 路径和单独离线授权，未执行模型推理。
  - [x] 比较 AEC3 / Sonora、LocalVQE、DTLN-aec；核对现有 sherpa-onnx 单流降噪不能替代双流 AEC，列明移动构建与处理帧成本。
- [x] Step 2：核验通用框架对 OpenAI Realtime 与豆包现役双工协议的真实支持。
  - [x] LiveKit 中文社区插件已接现役 Seeduplex JSON，但工具结果回传、音频截断存在缺口；Pipecat 需自写服务，TEN 已有豆包 duplex 只对应 TTS。
  - [x] 区分客户端音频处理、框架会话与传输，核对独立进程、手机工具 RPC 和 KWS 麦克风交接成本。
- [x] Step 3：结合现有模块边界比较两条路线，完成独立复核与文档交付。
  - [x] 合并研究为 `docs/realtime-portability-and-aec-research.md`，删除本轮中间草稿；建议优先比较独立 AEC3 与 LocalVQE，保留当前双协议调用。
  - [x] 独立审查发现并修正 SAMI 算法标识与 LocalVQE compact 前端资产描述，明确用户模型兼容尚未验证。
  - [x] 合并稿独立复审通过，文档格式检查通过，旧方案与 todo.md 已按厂商无关处理更新。

## Android AEC 三项核查（2026-11-12）

- [x] Step 1：追踪实际采播配置。
  - [x] 使用 AAudio，输入请求 preset `7`（`VOICE_COMMUNICATION`）、输出请求 usage `2`（语音通信），Java 设置 `MODE_IN_COMMUNICATION`；输入 preset 未读回。
- [x] Step 2：核对 AEC 控制和播放参考证据。
  - [x] 未调用 AAudio `setSessionId/getSessionId`，没有 Java AEC 创建、启用／读回与释放逻辑；现有状态回执无 AEC 信息。NDK 默认会话 ID 为 `NONE`，尚未接入应用可控的 Java AudioEffect 路径。
  - [x] 自定义队列经 `AAudioStream_write` 播放，采集经独立 AAudio 流读取；没有应用侧软件 AEC／参考输入。系统是否提供正确参考、设备是否自动做 AEC 仍需真机判断，不能仅凭采样率差异或自定义播放判定失配。
  - [x] 子 agent 独立复核三项结论与 NDK 会话语义；待确认项记入 todo.md。
- [ ] Step 3：真机横屏读取实际 preset、音频会话／AEC 启用状态及效果链，测量外放回声；核查时 `adb devices -l` 无连接设备。

## iOS 系统语音处理启用（2026-11-12）

- [x] Step 1：在现有 iOS 原生音频模块启用语音处理。
  - [x] 在连接音频图与读取采集格式之前调用 `setVoiceProcessingEnabled(true)`，读回启用状态。
  - [x] 启动失败保留失败阶段、NSError domain／code 与具体原因；后续状态检查保留已有错误并报告引擎／前台状态，通知中断保留通知名称。
  - [x] 修正模拟器输入 48k 单声道／输出 44.1k 双声道导致启动后 I/O 重配停机：mixer→output 显式使用输入节点的处理格式，24k 播放仍由 mixer 转换。
- [x] Step 2：构建 iOS 目标，在用户指定的当前模拟器核对实际启动与启用状态。
  - [x] iOS 原生宿主构建通过；最小真实采播探针确认启用读回通过、引擎持续运行、提示音队列排空并取得 25 个录音包。
  - [x] KWS 待机／会话切换探针通过，包含准备取消、待机不上传 PCM、提示音、复用采集与返回 KWS；临时探针已移除。
  - [x] 主应用已恢复；普通开发构建 20.1 MB 字节码触发已有的反复断线，使用压缩开发构建降至 4.7 MB，模拟器保持连接并显示正常语音界面。
- [x] Step 3：独立 review，更新待办与验证记录，隔离提交本次修改。
  - [x] 独立审查对照 Apple SDK 与官方 AVEchoTouch 样例，确认启用顺序、采播格式、节点生命周期与错误信息保留；格式检查通过。
