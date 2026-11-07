# Super-LOOI 架构与硬件验证待办清单

本清单追踪关键的技术选型实测、硬件行为验证与集成确认项。各阶段完成技术验证后，产物应沉淀至 `docs/` 并从本清单归档。

---

## 1. 具身本体与硬件验证 (LOOI Base)

- [x] **LOOI 固件脱座与急停行为基线 (BodySupervisor 软硬件双保险)**
  - `BodySupervisor` 已固化脱座（`06`）瞬时 0000 刹车并吊销活跃租约；断线前强制下发高优先级 0000 停车。
  - [ ] 真机物理联调：观察真实下位机在 BLE 偶发断连与拔机时的失联硬件 watchdog 反应。
- [x] **头部俯仰物理限位与脉冲标定**
  - `executePulse` 已固化有界微动作调度与运动防抖等待窗口（settling window ≥200ms）。
  - [ ] 真机物理联调：在真实 LOOI 硬件上微调 100ms vs 200ms 脉冲行程。
- [ ] **Android + iOS 双端 CoreBluetooth / BleManager 差异化适配**
  - 确认 iOS 与 Android 在后台或屏幕锁定时对 BLE MTU 与 Characteristic 写入延迟的物理差异。

---

## 2. 语音全双工与快慢脑协同实测

- [x] **豆包默认 WebSocket 通路与 `/ws/voice` 握手队列修复（2026-11-05 实测通过）**
  - 修复 `/ws/voice` 在 `activeProvider.createSession()` 异步握手期间丢弃客户端初始 `unmute_commit` / `text_input` 消息的竞态问题，并在 `DoubaoVoiceSession` 收到 `session.created` 时自动重同步开闭麦状态与瞬态连接重试。
  - 修复豆包 `tool_result` 回传后重复触发 `speak_text` 导致双倍口播与多轮字幕拼接问题；端到端中文语音输入 -> ASR -> 工具调用 (`remember_fact` / `run_agent_task`) -> 24kHz 语音回复实测通过。

- [x] **双轨语音主链路对比与实现**
  - **轨 A (字节跳动端到端 Duplex)**: 20ms/640B PCM16k mono 实时自校正节拍器、`input_audio_mute.commit` / `unmute`、口播舞台提示剥离及 `response.cancel` 打断取消已落地。
  - **轨 B (ModularVoice: 流式 ASR + Fast LLM + 流式 TTS)**: 模块化流水线、结构化 Tool Call 与 AbortController 打断已落地。
- [x] **自发声防回灌 (TTS Loopback Suppression)**
  - `LoopbackSuppressionManager` 动态计算助理外放时间窗口，推导 `SelfEventWindow` 并门控麦克风上行流，杜绝自发声二次误唤醒与循环触发。

---

## 3. 视觉模型 (VLM) 选型与评测

- [x] **三类 VLM 方案综合基准评测 (`cloud` vs `lan` vs `edge`)**
  - 评测基准套件 `apps/hub/src/vision/benchmark.ts` 已就绪，结论沉淀至 `docs/phase1-vision-and-voice-benchmark.md`。
  - 确定默认采用 Cloud VLM（零本地发热、高检出率），LAN VLM 作为私密内网备选，Edge VLM 采用串行互斥与空闲 5s 自动卸载策略。

---

## 4. 远程生产力副驾与执行环境

- [x] **进程内极简 `pi-agent` 执行引擎替换（2026-11-06）**
  - 已由 `@earendil-works/pi-agent-core@1.5.0` + `@earendil-works/pi-ai@1.5.0`（`PiAgentExecutor`）替换原 `@deepseek-ai/dsh-sdk-client` 子进程方案，移除 329 个 `@deepseek-ai/dsh*` 传递依赖包，消除 `~1s` 子进程冷启动与 JSON-RPC/Cordis patch 开销。
  - 进程内 `bash` / `read_file` / `write_file` / `ask_user_question` 工具、工作区真实路径沙箱、`beforeToolCall` 审批拦截、进程组信号强杀取消与会话恢复 6 项真网实测通过。
- [ ] **正式部署的执行隔离与状态范围**
  - [ ] 专用执行身份/容器与Hub任务级身份授权；同用户worker不能声称与Hub混合`.env`安全隔离。
  - [ ] 外部SSH/后台job独立停止回执；未知时保留unknown。
  - [ ] DSH会话/附件/备份的记忆删除联动与outbound manifest。
  - [ ] 通用任务的预期产物/业务验收规则；观察到既有输入文件不等同于目标产物验收。
  - [ ] 多Hub进程共享状态目录的租约/数据库事务（当前仅支持单写者）。
- [x] **工作区与授权契约原型（模拟 runner 验证）**
  - `DshWorkspaceRunner` 落地工作区白名单沙箱与 `..` 路径穿越拦截。
  - 高危命令拦截器：对包含 `rm -rf`, `git push --force`, `dd`, `sudo` 等高危操作强制签发 `ActionGrant` 并在 `awaiting_approval` 态等待用户移动端显式 `UserActionRef` 授权。
- [x] **取消状态契约原型（真实进程待接入）**
  - 已实现取消状态与 unknown 分支的模拟测试；2026-11-05 核查确认 `terminateJob` 仅修改 Map，未发送真实进程信号。真实退出证据待官方 worker 接入后验收，详见调研报告。

---

## 5. 智能家居 (Home Assistant) 集成确认

- [ ] **跨平台本机原生控制中心与 `@super-looi/home-assistant` 独立包（H1 / H2 完成，H3 / H4 软件已交付、实物待验收）**
  - 调研结论与架构设计见 [跨平台本机控制中心与 `@super-looi/home-assistant` 独立包调研](docs/home-assistant-mobile-runtime-research.md)：放弃笨重且不支持 iOS 的 `PRoot + Linux + Python HA` 容器方案，转向 iOS/Android 双端通用的纯 TypeScript 独立包 `@super-looi/home-assistant` + 本机进程内控制中心（In-App Local Control Center）。
  - [x] **Phase H1（共享家居包与 Hub 迁移，2026-11-06）**：已完成并独立 review；全仓 246 项测试、build/typecheck 通过，阶段结论见 [H1 实施记录](docs/home-assistant-runtime-h1.md)。
  - [x] **Phase H2（米家 OAuth 与 MIoT 云端直连，2026-11-06）**：协议实现、量化与安全回读、凭据并发守卫已完成；全仓 274 项测试、build/typecheck 通过，见 [H2 实施记录](docs/home-assistant-runtime-h2.md)。
  - [ ] **Phase H3（软件已交付，真实米家授权 / 物理回读待验收）**：原生安全存储、WebView、米家 / 外部 HA / 演示 / Hub 模式与页面已接通；见 [本机控制中心交付](docs/local-control-center-delivery.md)。
    - [x] 接入系统安全存储、原生加密与 WebView；模式切换守卫、前台状态刷新与后台暂停已落地。
    - [x] iOS 原生包重建、模拟器页面与官方小米登录页实测通过。
    - [ ] 本人完成米家授权后，验证 Keychain 凭据写入 / 恢复、真实设备发现、控制回读与断网恢复；桌面 HA 关闭。
  - [ ] **Phase H4（本机软件闭环与真实豆包 API 已通过，手机物理录放音待验收）**：本机文件记忆、删除墓碑、离线文字、LIVE 直连与家居工具已落地。
    - [x] 无 Hub 合成语音实测：四类工具、记忆落盘 / 恢复、151552 字节回复 PCM；只操作演示设备。
    - [ ] 在手机连接设置保存豆包 Key，完成真实麦克风 / 扬声器及真实米家的无 Mac Hub 全闭环；Android 原生与长稳验证。

- [x] **HA 接入环境与首批白名单实体**
  - 首批书房设备白名单（吸顶灯、台灯、风扇、温湿度传感器）及安全参数区间（亮度 1..255、色温 2200..6500K）已在 `HomeAssistantGateway` 固化。
  - 严格物理隔离门锁、燃气等高危域，提供歧义消除追问能力。
- [x] **状态回读超时与幂等重试规则**
  - 落地新鲜 No-op（新鲜状态已匹配时避免冗余网络下发）、真实 Applied 与超时 Unverified。
  - 断开重连严禁盲目重发旧控制指令，批量下发支持 partial 局部故障明细上报。

---

## 6. 证据记忆账本与持久化部署验证

- [x] **PostgreSQL + pgvector Schema 与 1536 维向量检索索引**
  - `apps/hub/src/memory/schema.sql` 已定义完整的 `privacy_epochs`, `evidence_events`, `episodes`, `memory_claims`, `context_packs`, `deletion_tombstones` 结构。
- [x] **迟到写回守卫 (Late Writeback Guard) 与代际墓碑**
  - `MemoryLedgerService` 落地 `deletion_generation` 与 `capture_epoch` 校验，`LateWritebackRejectedError` 与级联撤回已在测试中完全通过。
- [ ] **物理生产数据库迁移与 Docker pg16 实联**
  - 在包含真实 `pgvector` 插件的容器实例中运行 schema 迁移，验证 HNSW/IVFFlat 向量检索在真实千级事实库下的查询时延与吞吐。

---

## 7. 长稳运行与 48 项核心验收回归 (Phase 5)

- [x] **48 核心验收用例自动化运行器与四大安全硬门禁**
  - `AcceptanceRunner` (`apps/hub/src/acceptance/runner.ts`) 与 `acceptance-48-cases.test.ts` 实现完成。
  - 48/48 测试用例 100% 确定性通过，总分 96/96。
  - 四大门禁：`unauthorizedActions === 0`, `crossSubjectLeaks === 0`, `zombieResurrections === 0`, `unverifiedCompletions === 0` 全部完美守住。
- [x] **移动端长稳守护器 (`DockedLongevitySupervisor`)**
  - 实现热阶梯与内存阶梯优雅降级（nominal -> fair -> serious -> critical），确保 <100ms 紧急停车绝对优先。
  - 实现 BLE 断连自愈与零重放安全协议（Zero Motion Replay）。
  - 实现 OLED 防烧屏像素微偏移，位移矢量硬截断在 `[-6, 6]` px 内。
  - 架构与实测总结沉淀至 `docs/phase5-acceptance-and-longevity-report.md`。
- [ ] **双端 7×24 小时真实物理台架长时间常驻巡检**
  - 在实体无线充底座与真实真机（iPhone 15+ / Pixel 8+）上挂载运行 72 小时，监控电池发热温升与电池膨胀保护表现。

---

## 8. Presence v3.0 UI 重构与视觉验收 (Phase 7)

规范与原生运行边界见 [Presence v3.0 设计规范](docs/design-v2/ui-v3.0-redesign-spec.md)，阶段性结论与完整验收证据已沉淀至 [Presence v3.0 交付与验收报告](docs/phase7-ui-v3-report.md) 及 [横屏精修报告](docs/mobile-presence-landscape-polish.md)。

- [x] **7.1/7.2 代码实现、独立 review 与横屏首屏/抽屉核验已完成**
  - Ionicons / Node 字体回退、猫耳品牌标/对称声波纹、`humanize.ts` 自然中文转译与四区动态坐标已实现；原生光学大脸、3D 头盔面罩、声波括号唤醒栏与共形缩放抽屉已落地并完成横屏（`844×390pt`）实机截图核验。
- [x] **7.3 共形外壳、四大富媒体空间与横屏 Above-the-Fold 精修已完成**
  - 共形 Shell 与回忆册、约定任务、书房家居、维修舱四大空间完成；`pnpm --filter @super-looi/mobile typecheck`、`test`（16 suites / 61 tests）、`build` 全退出 0。
  - 横屏首屏折叠线以上（Above-the-Fold）密度精修已完成，截图归档于 `docs/artifacts/phase7/landscape-polish/`。
- [x] **7.4 Hub Web 控制台 (`console-html.ts` v3) 升级与双端终审已完成**
  - 修复 `.drawer-open .wake` 文字穿透、窄屏 `.rail` 悬浮腰斩长图与 `.connections` 三列挤压问题，1:1 同步 Presence v3.0 视觉与交互（58/58 Hub 测试通过，全仓 134/134 测试通过）。
  - 桌面、窄屏、短横屏截图已归档至 `docs/artifacts/phase7/web-console/`，独立 UI/UX 审查子 Agent 10/10 维度终审 PASS。
- [ ] **真机竖屏便携态与物理外设联调补充验收**
  - 待后续重新构建支持竖屏旋转的原生开发包并连接实体 LOOI 底座 / Home Assistant 网关后，补充真机竖屏便携态及硬件级长稳交互验证。

---

## 9. Phase 8: RSI UI 交互深度审阅与循环收敛（已闭环归档）

完整四轮演进指标（`52.5 → 76.5 → 94.8 → 97.5 / 100`，`P0 / P1 / P2 = 0 / 0 / 0`）、视口预算几何计算与 21 张双端实测截图已全部归档至 [Phase 8 RSI 交互收敛报告](docs/phase8-rsi-interaction-report.md)。

- [x] **RSI Round 1–3 全量交互缺陷清零（182 项自动化测试 + 225 个控件多视口热区审计全绿）**
  - 已完成浮层轻提示零跳动（`CLS = 0`）、`<100ms` 急停免疫上滑抢占、水平亮度滑块与纵向滚动物理隔离、抽屉跟手下滑收起、竖屏分段单流滚动、`844×390` 短横屏高有效视口占比（Mobile `83.2%` / Web `84.6%`）与全控件 `>= 44×44pt/px` 热区覆盖。

---

## 10. Phase 10: 主 Agent 亲自操刀 — 审美与 Bento 质感全面重塑（已闭环归档）

针对上一轮 Codex 产物的机械线框感与多处排版缺陷（亮度滑轨挤压、任务页左右高度失衡、抽屉图标裁切、维修舱参差不齐等），已由主 Agent 亲自重塑 Mobile 与 Hub Web 双端 UI，并沉淀至 [Phase 9/10 零滚动 Bento 驾驶舱报告](docs/phase9-zero-scroll-bento-report.md)：

- [x] **10.1 驾驶舱侧栏与快捷抽屉/演练台光学质感精修 (`ConformalDeviceShell.tsx`, `QuickDrawerModal.tsx`)**
- [x] **10.2 书房家居全宽流光亮度滑轨与 2×2 均衡 Bento 矩阵 (`BrightnessSliderBar.tsx`, `HomeSpaceView.tsx`)**
- [x] **10.3 回忆册与约定任务空间黄金比例与高质感卡片重塑 (`MemoriesSpaceView.tsx`, `TasksSpaceView.tsx`)**
- [x] **10.4 维修舱顶栏对齐与三栏等高工程仪表盘精修 (`CabinSpaceView.tsx`)**
- [x] **10.5 Hub Web 控制台 (`console-html.ts`) 同步升级与 iOS 模拟器实机逐屏截图核验**

---

## 11. 开箱即用能力核对与 Phase 11 极简真实可用闭环（2026-11-04）

语音全双工与极简 Personal Agent 闭环已落地并沉淀至 [Phase 11 极简真实可用语音 Personal Agent 报告](docs/phase-11-live-voice-and-personal-agent.md)：

- [x] **极简持久个人记忆与跨端同步 (`PersonalMemoryStore`)**：基于本地 `data/personal-memory.json` 零心智落盘持久化，支持语音/文本 `remember`、`recall`、`forget`，自动同步至 `MemoryLedgerService` 与 Mobile 回忆册 (`/api/agent/memories`)。
- [x] **官方 DSH 执行器**：2026-11-05 已替换并删除原 `MinimalAgentLoop`；沿用 `.env` 模型网关，使用官方工具与记忆 MCP，见 [实现报告](docs/dsh-engine-integration.md)。
- [x] **真实全双工语音与快慢脑桥接 (`/ws/voice` + `LiveVoiceClient`)**：对齐豆包 OpenSpeech Duplex V3 协议 (`wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`, `1.2.6.1`)，打通 Mobile (`@siteed/audio-studio` + `expo-audio`) 与 Web (`getUserMedia` + `AudioContext`) 16kHz 采集、24kHz 播放、Barge-in 打断与 Agent 工具结果自动口播 (`speech_text_buffer.commit`)。
- [ ] **视觉相机真机推理与外部物理硬件适配器**：待连接实体 LOOI 蓝牙底座与真实 Home Assistant 网关后，接入真机相机抓拍与物理硬件适配器。
- [ ] **首次使用与分发安装包**：提供独立可分发安装包、引导配对与局域网 Hub 自动发现。


## 12. 原生开发包重建依赖（2026-11-04）

- [x] Reanimated 4.3.1 / Worklets 0.8.3 已对齐 Expo SDK 56 / RN 0.85.3；iOS prebuild、Pods 与原生构建通过，见本机控制中心交付。


## 13. 米家真实接入（2026-11-05）

- [x] Hub REST 连接、动态设备发现、Mobile 与语音已接线；真实服务未配置时不回退演示设备。
- [x] 当前 Mac 已完成 Home Assistant 与小米 OAuth，45 台设备 / 1121 个实体已导入并绑定 Hub；阶段说明见 `docs/home-assistant-xiaomi-setup.md`。
- [ ] 灯 / 风扇 / 已识别的基础电源开关已提供控制接口；空调模式、温度、扫地机等其他功能目前只读，后续按实际能力补齐控制。
- [ ] 真实设备状态回读与断网恢复联调尚未验收；软件测试不代表物理设备验收。


## 家居控制交互修复（2026-11-06）

- [x] 已修复全屋刷新阻塞、连续操作丢失与待核实提示不恢复；操作即时显示目标、按设备串行合并后续输入、真实回读恢复提示，防止旧 HA 缓存覆盖。Mobile 150 / 家居包 42 项测试通过，独立复审通过。
- [ ] 真实米家长时延与物理灯具连续调节仍需实物验收。本轮 iPhone 16e 已观察到云端状态晚于同步核实窗口才更新，界面会自动恢复；尚未测量时延分布或观察物理灯具，不将云端读数等同于实物验收。


## LIVE 语音失败排查（2026-11-06）

- [ ] 当前 iPhone 16e 本机语音未读到 Key，需显式配置手机 SecureStore 后再验真实语音。根因与实测证据见 `docs/live-voice-missing-local-key-diagnosis.md`。
- [ ] 本机语音配置允许缺 Key，连接时具体原因被通用错误覆盖；后续增加凭据校验与错误透传。本轮仅排查，未修改产品或凭据。


## 智能唤醒与事件介入（2026-11-06 规划，尚未实施）

方案见 [智能唤醒设计](docs/intelligent-wake-design.md)。历史“VAD 唤醒完成”不代表待机唤醒词已实现；当前仍需手动开启 LIVE。

- [ ] **W0：本地唤醒词选型 PoC**
  - [ ] 固定 LOOI 目标读音与中英候选词；比较 sherpa-onnx / Porcupine 的实际命中、误触发、初始化条件与许可。
  - [ ] 验证 iPhone 原生单一采集、PCM 帧序/采样率/时间戳及 KWS 桥接；测包体、CPU、内存和热状态。
- [ ] **W1：前台驻座唤醒与会话闭环**
  - [ ] 共享触发策略、音频所有权、上游 ready + 采集回执、提示后说、超时与隐私代际；连说增强需本地端点、有界首句 FIFO 与排空/恢复实时证据。
  - [ ] 复用本机直连及 Hub 两种会话；修正缺 Key 提示和无效的 Hey LOOI 引导。
  - [ ] 真机验连续首句、续聊、切账号/模式/后台/来电等竞态；点击打断保底。
- [ ] **W2：确定性事件与介入策略**
  - [ ] 接任务/审批、前台提醒及一个真实家居阈值规则；新增真实事件适配器和规则持久运行服务。
  - [ ] 去重/TTL/迟滞/勿扰/队列上限/过期处理；仅输出播报不能调用默认开麦入口。
  - [ ] 明确规则执行宿主和唯一播报设备，App 挂起不承诺 JS 调度与家居轮询准时。
- [ ] **W3 / W4：可选能力，单独验收**
  - [ ] 主动搭话默认关闭；影子模式评估在场证据、误打扰与预算。
  - [ ] 真机验证 AEC 与外放语音打断，当前 speakerUntil 抑制不等于可靠双工插话。
  - [ ] Android microphone 前台服务、iOS 后台录音 PoC、Web 和多设备协调各自记录支持范围。


## 工业设计实物推进（2026-11-06）

外观与结构开发定义见 [工业设计开发稿](docs/super-looi-industrial-design.md)。本轮已交付整体效果图与六分区拆解板，以下是进入工程样机的剩余工作。

- [ ] 固定目标手机（裸机／保护壳）、LOOI 型号与固件，实测手机包络、质量、底座三轴、磁吸中心、俯仰轴与窗口／接口位置。
- [ ] 将厂商 110 × 98 × 110 mm 标称值映射到实际测量轴向与姿态，补齐全装配包络、支撑区和运动避让区。
- [ ] 完成磁吸装取／静态滑移／俯仰干涉／供电走线的实物验证，记录热与长时驻留表现。
- [ ] 通过固定机身测试后，在保护区域验证真实 BLE 身体、断连、脱座与停止；未通过的执行器保持禁用。
- [ ] 依据测绘建立参数化装配 CAD／STEP 与实测三视图；若新做附件，再补零件图、公差链、材料工艺与采购 BOM。


## 手机端 Agent loop / 去 Hub（2026-11-06）

调研与验收边界见 [手机端 Agent loop 调研](docs/mobile-agent-loop-research.md)。以下尚未实施，历史 Hub/DSH 接入记录不等于完成本机迁移。

- [ ] Expo 56 / RN 0.85 / Hermes 上验证 pi-agent-core@1.5.0 的 Metro 打包、两轮工具闭环、流式输出、abort、预算与参数校验；确认 Node-only 模块未进入移动 bundle 的可达依赖图或执行路径。失败时记录最小适配成本，并对同一验收集比较 AI SDK Core。
- [ ] 接手机直连模型配置（用户凭据进 SecureStore）、本地工具注册和运行时事件，复用记忆/米家/HA能力；电脑/Hub 关闭后跑真实多轮任务。
- [ ] 本地任务/会话/审批/问答/取消与工具意图/回执持久化；强退、断网、配置切换和未知副作用恢复不得盲目重放。
- [ ] 文字与实时语音统一任务/权限边界，避免两个循环重复派发家居动作。
- [ ] 盘点 Hub 全部 API、规则/生产力/记忆/设备职责与已有数据，完成迁移、替代或明确停用后，才能移除 Hub 部署依赖。
- [ ] iOS 用户发起长任务的 BGContinuedProcessingTask 单独 PoC；Android 前台服务另验。原生修改经 Expo module / config plugin，不改 prebuild 产物。
- [ ] 本地模型为后续可选项：固定兼容 provider 版本，真机测中文工具可靠性、内存/热/延迟；不作为首轮去 Hub 前提。


## Native Shell 迁移验证（2026-11-06）

源码级结论已归档至 [Android / iOS 无 Hub 迁移调研](docs/nsh-mobile-migration-research.md)。用户已确认允许手机直连云 API；以下均为实施/真机待办，不能按调研完成勾选。

- [ ] **双端宿主 PoC**：固定 NSH v0.4.0，验证 iOS / Android embedding、host call/event、原生组件、权限配置、Release 无调试服务器启动及签名发布路径；Android AAB 与 target API 36+ 兼容（v0.4.0 CLI 默认仍为 API 35）。
- [ ] **Pi / QuickJS 兼容性**：独立同版本 VM 的四包、实际 SDK 七工具、原生 codemode、SSE、abort/预算与真实网关已通过，见兼容层实施记录；仍需 NSH 手机真实挂载及领域工具闭环验收。
- [ ] **实时媒体**：原生 PCM / AEC / 播放 / 音频焦点；豆包 X-* WS 真实握手、节拍、打断、断线零重放；Bearer WS 的宿主适配按需验证。
- [ ] **存储与恢复**：系统安全凭据、SQLite/受控文件、工具意图/回执事务、强退 unknown 核验与旧数据迁入；不得用 5 MiB KV 代替全部持久存储。
- [ ] **机器人视觉**：按全屏/头像及全部状态比图，验证渐变、内外阴影、点阵、裁剪、真实音量条；双端真机 LIVE 并发帧时/电量/热观察。
- [ ] **家居与硬件**：米家 OAuth / MIoT 真实回读、BLE 重连与急停、相机采集、前台保持唤醒/热策略；模拟器不能替代硬件验收。
- [ ] **功能与后台范围**：为原桌面 shell/CLI 工具确定手机替代；逐项退出旧 Hub API、隐藏页面和状态；明确锁屏/后台/强退后的规则、任务与感知支持范围。


## dsh-Go iOS 分支验证（2026-11-06）

源码、issue 与 CI 结论见 [iOS 分支调研](docs/dsh-go-ios-branch-research.md)。以下是本项目后续可选验证，不表示采用 DSH 或已完成迁移。

- [ ] 比较 NSH QuickJS / 内嵌 NodeMobile 对 Pi 1.5.0 的适配成本；若引入双 JS 引擎，实测事件桥接、内存、取消与停止后重启。
- [ ] 若借鉴 NodeMobile host，验证 Release 真机签名、addon framework 布局、真实云模型闭环、堆与原生内存/fd管理、强退 unknown 恢复及后台继续；模拟器脚本模型 CI 不替代这些验收。
- [ ] 若确有 Linux CLI 需求，再验证 arm64 iSH / Alpine guest 的实际程序、审批/路径、取消清理、DNS/网络、真机性能与分发/许可条件；不能默认宣称 Python、任意原生子进程或其他 App 控制可用。


## NSH Node 兼容层实施（2026-11-06）

- [x] 已替换 C02/C05、D05、H01–H06 常量通过项并补审批/隐私/恢复/状态机断言，48 项同源代码已在 iOS / Android 原生宿主运行。它们仍是软件契约；真实传感器、热管理、音频与 LOOI 实物验收继续保留。详见 [业务运行时记录](docs/nsh-portable-runtime.md)。

实施证据与范围见 [兼容层实施记录](docs/nsh-node-compat-implementation.md)。已交付独立 Rust/QuickJS 包、九组测试（含实际 SDK、native codemode 与业务 runtime）、真实模型 SSE 与强杀恢复验证。

- [x] iOS Keychain / Android Keystore CRUD 在双端模拟器通过；app 自有模拟器 entitlement / Android Application 插件处理宿主缺口，未回落明文。插件并发/增量 manifest/DEX 幂等已修复并独立复审通过。
- [x] 已定位 Android NSH 0.4.0 test driver Dialog 输入缺口；以独立 UiAutomation 测试 APK 通过真实窗口点击、中文输入及记住/回忆/忘记。不修改 NSH，测试 APK 不进入产品包。
- [ ] Native memory 的 source event 审计、删除后的内容/派生会话保留策略与用户身份作用域继续落实；当前 UI “忘记”执行墓碑级逻辑撤回，不代表数据库页/WAL/历史会话的取证擦除。
- [x] 实际 SDK 双端原生 fetch 真网 write/read/JSONL恢复与移动安全凭据验证。
- [ ] 预编译扩展/深链 OAuth 与图片处理仍需独立手机宿主验收；桌面根 barrel 的透明构建审计仍保持单独失败状态。
- [ ] 双端离线 Release / 商店签名验收（Android 两 ARM Release APK 已编译，仍为 debug 签名）；真实 NSH class、私有 app sandbox、无 Tokio executor 作业生命周期、notify 与九组测试已在 hardened engine（256 MiB）/ iOS 与 Android API 34 ARM64 模拟器通过，见 native-host-audit.json。NSH 已有本机首页、离线记忆与安全凭据基础，完整业务仍在迁移。
- [ ] 独立文件命名空间/私有 SQLite 迁入迁出、未知副作用恢复、手机安全凭据/任务/审批/记忆/家居/媒体/BLE/UI 接线；满足所有 Hub 职责替代后才能移除 Hub。
- [ ] 兼容层后续覆盖：Rust 原生行扫描、真正异步 FS/有界输出流、更多明确的 Node API/命令参数；当前 JSON 桥接和上游 JS 行扫描不等于零拷贝。native notify 需双端实测。


## NSH 续推复验（2026-11-07）

- [x] 双端 MobileRuntime 原生 fetch 真网模型单任务通过；模型配置写入失败恢复已修复。
- [x] 普通多轮对话保留上下文、重启恢复与配置切换隔离；独立 task 证据保留。
- [ ] unknown 任务详情、明确核验和续跑入口；目前仅提示计数。
- [ ] NSH MIoT安全登录、语音端到端、BLE原生桥、旧数据迁入。
  - MIoT双端专用原生浏览器已实现并通过实际窗口冒烟；仍需产品UI、OAuth交换提交前原生session有效性守卫，以及GET/POST307/子资源回调零请求fixture。后台切换已同时取消窗口关闭后尚未消费的callback/交换。后续OAuth commit guard须在token store.get/set后及最终continuation动态重查native consumed状态、原授权expiry、home/store generation；捕获guard异常并返回false以保证旧账号回滚。
  - BLE传输重连/订阅/取消与并发断开问题已修，15项测试通过；固定NSH没有现成BLE API，需要app自有原生桥。
  - 家居Agent审批/SQLite intent与回执、取消unknown恢复通过QuickJS与独立复审；双端合成语音→真实ASR→实际Agent查询→原生语音回复通过，真实麦克风/AEC仍待硬件验收。
  - BodySupervisor已移除settling伪证据，主动观察缺证据停止；仍需接入真实停稳传感器及对应相机帧，模拟fixture不代表物理验收。
  - 保留Hub/Expo直到端侧全量替代门禁通过；本轮仅模拟器软件验收，真机BLE/底座/音频效果另列。
- [ ] 透明 root SDK 构建仍有 36 个错误；移动适配 SDK 单独通过，不用空垫片掩盖不支持项。
- [x] 当前双端模拟器 Release 构建、无开发服务器冷启动及持久化验收通过。
- [ ] 商店签名、API 36/AAB、32位ABI执行另验；真机硬件按用户要求留待后续。

- [x] Android Release 验收误覆盖原未知配置后，已按用户授权用 `.env` 配置恢复，并通过重启读回及真实两轮对话；原值无备份，不能宣称还原原值。后续配置验收必须隔离测试 appId 或先保存原值。
