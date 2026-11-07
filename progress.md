# Super-LOOI 重构与演进进度

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
