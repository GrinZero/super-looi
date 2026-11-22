# Super-LOOI NSH 设计规范 (Design System & UI Standards)

目标平台：原生 iOS 与 Android（兼顾桌面磁吸底座横屏常驻与手持竖屏操作；`headless` 作为行为测试宿主）。所有表现层颜色、圆角与状态样式统一由 [`theme.json`](theme.json) 的语义 Token（设计令牌）驱动，组件内严禁硬编码 Hex / RGBA 色值。

---

## 1. 核心设计原则：双舞台体验对齐与 OLED 省电基底

Super-LOOI 由 **前台桌宠主页（Frontstage Companion）** 与 **后台管理空间（Backstage Utility）** 两层组成，彻底摒弃高饱和霓虹青科幻 HUD（平视显示器）风格，统一采用温润、克制的低饱和器物语言：

1. **主页（桌宠陪伴页）常驻深色省电底**：
   - 作为长时间吸在底座上常亮运行的桌面伙伴，主页在**浅色（白天）与深色（夜间）模式下均保持深色基底**，兼顾 OLED 屏幕省电、防烧屏与隐藏物理屏幕黑框的无界感。
   - 白天与暗黑模式在主页上的差异，直接体现在**深色基底的深浅度**与**暖米色眼眸的色温/发光亮度**上（白天清朗抗环境反光，夜间沉入纯黑零功耗并压低眩光）。
2. **后台（管理设置页）采用明暗双主题工具界面**：
   - 后台承载 API Key 输入、OAuth 授权、家居连接与任务检视，遵循日常高频工具软件的阅读习惯：**白天（Light）采用方案 B「暖石日光（Warm Stone）」**，**暗黑（Dark）采用方案 A「中性锌灰（Neutral Zinc）」**。

---

## 2. 语义 Token 体系（`theme.json`）

### 2.1 前台桌宠舞台专用 Token（`light` 与 `dark` 均为深色底）

| Token 名称 | Light（白天陪伴态 · 抗眩光深炭底） | Dark（暗黑陪伴态 · 纯黑 OLED 零功耗底） | 用途说明 |
| :--- | :--- | :--- | :--- |
| `stage-bg` | `#11100F` | `#040405` | 主页全屏基底色（夜间纯黑隐入屏幕黑边） |
| `face-texture` | `rgba(250,245,235,0.04)` | `rgba(229,214,190,0.024)` | `39 × 21` 细腻背景点阵纹理 |
| `horizon-core` | `rgba(250,245,235,0.10)` | `rgba(229,214,190,0.08)` | 舞台底部地平线柔光中心 |
| `horizon-zero` | `rgba(250,245,235,0)` | `rgba(229,214,190,0)` | 地平线柔光透明外缘 |
| `eye-core` | `#FBF7F0`（清朗暖奶米） | `#E8DAC3`（柔和暖燕麦米） | 圆眼主体发光色与左上呼吸点 |
| `eye-edge` | `#EFE7DA` | `#D5C2A5` | 可选的 `<=8%` 中心至边缘轻微柔化色 |
| `eye-halo` | `rgba(250,245,235,0.16)` | `rgba(229,214,190,0.14)` | 圆眼外圈柔和 OLED 光晕 |
| `halo-zero` | `rgba(250,245,235,0)` | `rgba(229,214,190,0)` | 圆眼光晕透明外缘 |
| `face-stroke` | `rgba(251,247,240,0.72)` | `rgba(232,218,195,0.58)` | 表情嘴型与条件眉弧 |
| `face-ivory-*` / `face-amber-*` / `face-sage-*` / `face-rose-*` / `face-mist-*` | 低饱和清朗亮米 / 琥珀 / 鼠尾草绿 / 柔粉 / 冰雾蓝 | 夜间柔和降眩光对应色阶 | 72 表情扩展语义色与平面微符号光晕（见 [`super-looi-72-expressions-design.md`](../../docs/super-looi-72-expressions-design.md)） |
| `stage-pill-bg` | `rgba(255,250,242,0.08)` | `rgba(255,248,236,0.05)` | 主页外围轻量胶囊底色 |
| `stage-pill-border` | `rgba(255,250,242,0.14)` | `rgba(255,248,236,0.10)` | 主页外围轻量胶囊边框 |
| `stage-pill-fg` | `#F7F1E6` | `#EAE0D0` | 主页胶囊主文字色 |
| `stage-pill-muted` | `#A8A29E` | `#8E8A84` | 主页次要状态与唤醒提示文字色 |
| `stage-muted` | `rgba(245,239,230,0.54)` | `rgba(234,227,213,0.56)` | 舞台次级提示与副标题文字色 |
| `stage-panel` | `#1B1917` | `#121215` | 舞台插件不透明哑光主面板底色（杜绝透底重影） |
| `stage-tile` | `#24211E` | `#1A1A1E` | 舞台面板内座位砖块与次级分组块底色 |
| `stage-rose-bg` | `rgba(232,125,146,0.16)` | `rgba(219,110,132,0.16)` | 毒药/狼人阵营/告警选中态柔和玫瑰底色 |
| `stage-rose-border` | `rgba(232,125,146,0.44)` | `rgba(219,110,132,0.40)` | 毒药/狼人阵营/告警选中态玫瑰描边 |
| `stage-rose-ink` | `#7F2D36` | `#6E2731` | 暖米色主按钮承载玫瑰红动作时的深玫瑰字色 |
| `stage-amber-bg` / `stage-amber-border` | `rgba(232,176,91,0.14)` / `0.44` | `rgba(223,159,72,0.14)` / `0.40` | 警徽/当前发言/选中胶囊与金珀舞台框线 |
| `stage-sage-bg` / `stage-sage-border` | `rgba(111,208,150,0.14)` / `0.44` | `rgba(94,196,135,0.14)` / `0.40` | 已就绪/已投票/好人阵营鼠尾草绿舞台底框 |
| `stage-mist-bg` / `stage-mist-border` | `rgba(154,212,245,0.14)` / `0.42` | `rgba(138,199,236,0.14)` / `0.38` | 神职技能/预言/冰雾蓝提示舞台底框 |

### 2.2 后台管理与通用控件 Token（方案 B 暖石日光 vs 方案 A 中性锌灰）

| Token 名称 | Light · 方案 B（Warm Stone 暖石日光） | Dark · 方案 A（Neutral Zinc 中性锌灰） | 用途说明 |
| :--- | :--- | :--- | :--- |
| `background` | `#F5F4F0` | `#111113` | 后台主工作区画布底色 |
| `sidebar` | `#EBE9E2` | `#161619` | 左侧极窄导航轨 / 竖屏底栏底色 |
| `card` | `#FFFFFF` | `#1B1B1F` | 顶栏与双栏工作卡片平面 |
| `popover` | `#FFFFFF` | `#202025` | `Dialog`、`Select`、`Menu` 浮层表面 |
| `muted` | `#EFECE6` | `#242429` | 未选中胶囊、内嵌代码块与次级填充 |
| `accent` | `#E6E3DB` | `#2E2E36` | 次级轮廓图标按钮与控件悬停Accent底色 |
| `accent-foreground` | `#18181B` | `#F4F4F5` | Accent 底色之上的前景图标与文字色 |
| `border` / `input` | `#DFDDD5` | `#2C2C33` | `1px` 区域分割线与输入框边框 |
| `foreground` | `#18181B` | `#F4F4F5` | 一级标题与正文主色 |
| `muted-foreground` | `#5E5E66` | `#9CA3AF` | 字段标签、端点说明与次级文案 |
| `subtle-text` | `#A1A1AA` | `#71717A` | 弱提示与占位辅助说明 |
| `primary` | `#18181B` | `#F4F4F5` | 主提交按钮与激活胶囊填充色 |
| `primary-foreground` | `#FFFFFF` | `#111113` | 主提交按钮与激活胶囊文字色 |
| `ring` | `#18181B` | `#F4F4F5` | 键盘与输入聚焦环 |
| `verified` | `#16A34A` | `#22C55E` | 凭证就绪圆点、LIVE 通话激活态 |
| `warning` | `#D97706` | `#FBBF24` | 授权等待与限流提示 |
| `destructive` | `#DC2626` | `#F87171` | 停止任务、告警表情与危险确认动作 |

---

## 3. 前台桌宠主页规范（`App.tsx` + `ui/RobotFace.tsx`）

### 3.1 纯净平面自发光圆眼渲染纪律
- 单一原生 `Canvas` 在居中的 `620 × 340` 逻辑坐标系内绘制：背景 `39 × 21` 微点阵、底部地平线微光、双圆眼、条件眉弧与表情嘴型。
- 背景纹理覆盖整屏；表情的缩放与中心位置根据系统安全区实时计算，横屏时避开两侧的摄像头挖孔或刘海。
- **严禁拟真眼球化（Uncanny Valley 防护）**：
  - 圆眼采用**纯净暖米色平面自发光（`eye-core`）或 `<=8%` 极轻微柔化**，搭配外圈柔和同色微光晕（`eye-halo`）。
  - **禁止绘制左上角亮白高光圆斑（Specular Glint），禁止绘制底部深黑立体阴影框**，杜绝“潮湿假眼珠/白翳反光”观感。
  - 圆眼半径必须等比缩放，严禁压扁为椭圆；`neutral` 与 `speaking` 状态严禁绘制眉弧。
- **表情嘴型**：聆听和说话时保持微笑，嘴型不随麦克风或播放音量切换；思考、休眠与警觉使用各自的表情嘴型。

### 3.2 外围三区轻量胶囊
- **左上（状态呼吸区）**：状态圆点（LIVE 通话中为 `verified`，其余为 `eye-core`）+ `12pt` 状态短语（`陪伴待机` / `实时聆听中` / `Agent 思考中` / `LOOI 说话中`）。
- **右上（主控胶囊组）**：轻量声波圆形胶囊（`testID="voice-toggle"`，通过四柱声波纹、连接三点与播放中断方标及语义色表达实时通话状态，不叠加冗长文字）、`对话`（展开顶栏下方内联输入栏 `askBar`）、`连接`（`testID="connection-settings"`，一键进入全屏后台管理空间）。
- **底部（唤醒引导 / 字幕胶囊）**：待机未关闭引导前显示对称 7 阶声波纹与 `( 说 Hey LOOI 唤醒我 · 轻触开启 LIVE 对话 )`；有活跃转写或回复时切换为字幕胶囊（轻触查看完整回复）。

---

## 4. 后台管理空间规范（「结构 3」· `ManagementShell`）

后台取代多层模态弹窗堆叠，统一收口 **`模型`**、**`语音`**、**`家居`**、**`底座`**、**`任务`**、**`定时`**、**`插件`**、**`设置`** 八个一级模块（将实时语音从文本 LLM 模型配置中独立拆出，新增 LOOI 硬件底座连接与体感遥控空间、本机定时调度与勿扰空间及插件生态空间，并将外观与多语言等通用设置收口至独立的「设置」页）。

### 4.1 三段式空间骨架与横竖屏自适应

1. **横屏底座态（`windowSize().width >= 600`）**：
   - 各区域背景铺到屏幕边缘，安全区只约束内容：导航轨向左侧挖孔区延伸，内部导航保持 `80pt` 宽；顶部操作栏背景和底部分隔线延伸到右边缘，控件避开右侧安全区；导航轨背景与竖向分隔线贯穿到底部，工作区内容避开底部安全区。Android 额外上报的挖孔补偿与系统安全区一并在这些区域内部消费。
   - **第一段：左侧极窄导航轨（`80pt` 宽，`bg-sidebar` + 右侧 `1px` `border-border`）**
     - **顶部返回锚点**：`44 × 44pt` 微缩桌宠按钮，内部固定采用 `stage-bg` 深色底与两枚 `eye-core` 暖米圆点（唯一保留前台深色桌宠特征的门户按钮），点击即刻返回全屏桌宠主页。
     - **中部模块导航**：垂直排列 `模型`、`语音`、`家居`、`底座`、`任务`、`定时`、`插件`、`设置` 8 个入口（触控热区 `>= 44 × 44pt`；底座吸合就绪或家居在线、存在活跃定时规则时显示 `verified` 绿点，存在 `unconfirmed` 定时规则或待审批调度交互时优先显示 `warning` 黄点）。
     - **底部状态点**：展示本机运行时就绪状态。
   - **第二段：顶部横向上下文胶囊栏（`48pt` 高，`bg-card` + 底部 `1px` `border-border`）**
     - 替代传统臃肿的二级纵向目录栏，横向排布当前模块的子源胶囊（溢出时支持横向滚动），右侧仅保留清爽的 `返回` 按钮，不堆叠通用设置控件：
       - **`模型`**：`OpenAI / ChatGPT`、`Kimi`、`MiniMax`、`小米 MiMo`、`智谱 / Z.AI`、`+ 兼容 API`（已存有有效凭证时显示 `verified` 绿点）。
       - **`语音`**：顶栏仅显示清爽的 `实时语音` 标题与右侧返回动作；下方工作区采用「左对话舞台（`flex-[4.2]`） + 右配置检视器（`flex-[5.8]` + 左 `1px` `border-border`）」结构：左侧居中承载服务与会话状态徽章、15 柱对称声波条、2xl 会话状态大标题、双行实时转写（`你：...` / `LOOI：...`）与同页对话动作（未开始时为居中的 `开始对话`，通话中为 `静音` + `结束对话`，试听中为 `停止试听`）；右侧按 `语音服务`（基于 `VOICE_PROVIDERS` 的流式自适应服务商选择器，支持豆包、MOSS-Live、OpenAI Realtime 等多服务商扩展与自动折行，并支持钥匙串尾部掩码摘要 `••••••••OICE`、一键剪贴板粘贴、明文显示/隐藏切换、更换或移除密钥）、`音色`（默认/自定义音色展开设置、留在当前页的免麦克风短会话 `试听 / 结束并试听 / 停止试听`，以及通话中保存新音色后的 `应用并重连`）和 `唤醒`（`Hey LOOI 自动唤醒` 开关）三段排布。
       - **`家居`**：横向切换 `米家直连`、`Home Assistant`、`离线演示` 及停用开关。
       - **`底座`**：左侧横向切换 `蓝牙底座` 与 `模拟体验`，右侧提供 `扫描附近底座` 胶囊按钮；前台桌宠主页不叠加任何“底座已吸合 / 急停”胶囊，保持 100% 桌宠沉浸感。
       - **`任务`**：顶栏提供新对话与刷新。任务历史占约三分之一宽度，任务标题优先，状态与更新时间为辅助信息，翻页控件固定在列表底部。详情固定显示任务状态和「概览 / 执行过程 / 回执」标签。概览优先展示回答或错误，原始请求和任务 ID 可选取。执行过程支持展开记录，回执保留命令退出信息、产物摘要、家居与底座操作证据。列表和详情独立滚动，切换任务打开新任务的概览，同一任务的实时更新保留当前标签和已展开节点。
       - **`定时`**：顶栏 `SchedulesContextBar` 左侧切换 `规则 · N` 与 `勿扰时段`（实时处于勿扰中附带状态圆点），右侧放置 `自动跟进` 开关胶囊与主动作按钮 `+ 新建规则`（勿扰页切换为 `+ 添加时段`）。规则子视图采用横屏 `42% / 58%` 主从双栏独立 `<Scroll>`：左栏承载来源筛选（`全部 / 用户创建 / 自动跟进`）、规则行（标题、来源、周期、下次触发时间、`unconfirmed` 等状态点与行尾 `Switch`）及引导空状态；右栏检视器提供 `立即运行`、`编辑…`、`删除`（原生 `AlertDialog` 确认）、`unconfirmed` 警示条、策略标签、完整指令及倒序执行记录（含 `stage`/`code`/`reason`、`toolFailures`、`查看任务` 与 `继续此会话`）。勿扰与凭据子视图采用双栏：左栏放置勿扰总开关、按分钟边界离散刷新的实时勿扰状态卡、口头设置示例、精确闹钟降级提示卡（含 `打开系统设置`）及 **GitHub 只读令牌**配置卡（Fine-grained 只读 PAT，保存/在线校验/清除，永不回显明文）；右栏展示可跨午夜（`HH:MM – 次日 HH:MM`）与指定星期的多时段卡片列表。新建/编辑规则与勿扰弹窗支持一次性快捷延迟与定点、固定间隔、每日定点、标准 5 段 Cron（含 `previewCronOccurrences` 下次触发实时预览，精确呈现 `2028-02-29` 等跨年闰日与结构化错误）。
       - **`插件`**：顶栏在目录态展示 `插件` 标题、说明与右侧返回动作，进入插件详情时切换为面包屑返回按钮、插件图标/名称/版本徽章、紧凑依赖状态胶囊与启用开关；下方目录在横屏底座态将搜索框与横向滚动分类胶囊并排于首行，下方按宽度响应式采用两栏（`< 960pt` 手机横屏为 `grid-cols-2`）或三栏（`>= 960pt` 宽屏平板为 `grid-cols-3`）等宽卡片网格，保证同行卡片的顶部标题、摘要首行基线与底部状态栏水平对齐，当前内置插件首屏完整可见。
       - **`设置`**：展示 `通用设置` 标题，工作区内分卡片承载**外观**（`跟随系统 / 浅色 / 深色`）与**多语言下拉框**（`SelectField`：`跟随系统 / 简体中文 / English`）。
   - **第三段：下方平衡双栏工作区（`flex-1 min-w-0 min-h-0`）**
     - 左栏与右栏分担当前模块的表单、状态与列表内容；`底座` 页左栏展示设备大标题、吸合状态胶囊、已连接底座的电量百分比与外接供电状态栏、`启动时连接上次底座 / 模拟放上底座` 拨杆与可用底座列表（仅展示设备名、信号格图标与连接按钮，严禁展示 UUID、dBm 数值、GATT 寄存器地址或握手日志），右栏采用双内嵌卡片承载**360° 无极变向摇杆轮盘（`方向轮盘` + 等宽实时双轴速度/转向读数 + 顶栏急停胶囊，拖动摇杆无极变向、松手即停）**、**纵向头部俯仰连续滑杆（`抬头 / 平视 / 低头` + 大字号 `25°–85°` 等宽读数）**与底部**补光灯开关及无极亮度滑杆（`0%–100%`）**。
     - 外层窗口严禁整体滚动；横屏 `390pt` 视口下保持紧凑表单密度使主操作首屏完整可见，列表或长内容仅在所属卡片内部独立挂载 `Scroll`。
2. **竖屏手持态（`windowSize().width < 600`）**：
   - 左侧导航轨自动收束为底部安全区导航栏（均分 8 个一级模块入口，保持 `>= 44 × 44pt` 触控热区）。
   - 顶部 `48pt` 横向胶囊栏保持在安全区顶部；下方 `7:5` 双栏自然流式折为上下单列并启用纵向滚动，配合 `env(keyboard-inset-height)` 确保软键盘弹出时输入框与提交按钮完整可见。

### 4.2 视觉层级、控件几何与交互准则

1. **平面色阶分层，克制阴影**：
   - 基础分栏与卡片仅通过 `background`、`sidebar`、`card`、`muted` 的色阶对比和 `1px` `border` 划分边界，**不对常规卡片施加阴影**；阴影仅用于悬浮在内容之上的 `Dialog`、`Popover`、`Menu`、`Select` 弹出面。
2. **整块填充选中态**：
   - 导航按钮、顶部胶囊、通道切换器与模型列表行仅通过**圆角背景填充（如 `bg-primary` 或 `bg-muted`）+ 文字颜色/字重对比**表达选中态，**严禁使用单侧边条（Leading-edge bar）**。
3. **触控热区与字体排印**：
   - 移动端所有可点击行、胶囊、图标按钮保证至少 **`44 × 44pt`** 触控热区。
   - 全应用字号底线为 `12pt`（`text-xs`）；系统 UI 字体用于常规界面文案，等宽字体（`font-mono`）专用于 API Endpoint、Model ID、OAuth 设备码、命令回执与 SHA-256 摘要。
4. **动作语义与审批门禁**：
   - 同一决策区域最多保留 **1 个 `primary` 主提交按钮**；进行中的异步保存或授权操作必须锁定重复提交并保留用户输入。
   - 文案遵循上下文精简原则：导航目的地只用精准名词（`模型`、`语音`、`家居`、`任务`），按钮直接写明动作结果（`保存配置`、`刷新设备`、`退出账号`）。
   - 模态 `Dialog` 仅保留给短促关键决策（高危工具单次允许 `approval`、Agent 追问 `question`、完整长回复查看）；高危审批必须明确列出操作类型、目标路径或命令参数（文件写入需展示完整待写入内容），单次允许仅对当前当次点击生成的会话有效。

### 语音服务官方文档入口

- 「语音服务」标题右侧提供「官方文档 ↗」，目标随当前服务商切换，未配置凭证时也可打开；通过系统浏览器访问对应实时语音指南。
- 使用共享 `ExternalLink`，保留 link 无障碍语义、键盘激活与至少 48pt 触控热区；浅色、深色均使用语义颜色。
- 动效：hover / pressed 背景沿用 muted 色阶，使用 150ms 颜色过渡；切换服务商立即更新链接目标及无障碍名称。

---

## 5. 横屏可变形首屏舞台规范（Morphable First-Screen Stage · `ui/stage/MorphableStage.tsx`）

当具身前台插件（如桌游裁判、视觉伴随、空间协作）通过 `ctx.stage.usePresentation(...)` 请求首屏舞台租约时，前台主页在不卸载单实例 `<RobotFace />` 的前提下完成空间连续变形：

1. **五种姿态（`FaceStagePosture`）与单实例连续性**：
   - `full`：默认全屏陪伴态，圆眼居中铺满安全区。
   - `floating_top`：缩放至 `0.20–0.36`（`pill` 默认 `0.32`，`frameless` 支持缩至 `0.20–0.24` 嵌入顶栏中央净空区，不额外挤压下方 `StageCanvas` 纵向空间），自动避让右上角主控胶囊组，支持 `pill`（`elevated-glass` + `stage-pill-border`）或 `frameless` 外框。
   - `docked_corner`：缩放至 `0.20–0.42`（默认 `0.28`）停靠于顶栏下方的 `top_left` 或 `top_right` 安全区角落，绝不与顶栏系统控制柄重叠。
   - `split_left`：左栏保留伴随表情（比例 `0.28–0.52`，默认 `0.38`），右栏让渡给插件 `StageCanvas` 交互画布；当插件提供 `StageCompanion` 槽位时，左栏表情中心上移为 `leftCompanion` 区域让出表情正下方伴随文案与胜负主标题空间。
   - `minimized_pill`：极简胶囊态（缩放 `0.22`）悬浮于顶部中央，为底部大抽屉或画布留出最大纵向交互空间。
2. **四类插件插槽、顶栏单行化与故障熔断隔离**：
   - `StageCanvas`（`zIndex: 10`）、`StageCompanion`（`split_left` 左栏下方，复用 `StageCanvas` 边界隔离）、`StageCapsule` 与四档位 `StageDrawer`（`closed` / `peek` / `medium` / `large`，`zIndex: 25`）分别包裹在独立 `<ErrorBoundary>` 内；任一插件视图抛错立即触发 `exitPluginStage` 自动复位至 `{ kind: "full" }` 并弹出轻量提示，保障 LOOI 主表情永不崩溃。
   - 当 `PluginStagePresentation.capsulePlacement === "top_bar"` 时，`<StageCapsule />` 直接替换顶栏左侧通用状态文字，避免顶栏与悬浮胶囊双行堆叠；当 `drawer` 处于 `large` 遮挡 `StageCanvas` 时自动隐藏底层画布防止半透明重影。
3. **宿主安全不变量（Unblockable Host Safety Bar）**：
   - 顶栏右侧主控胶囊组（`退出舞台`、`LIVE 语音`、`对话`、`连接设置`）固定处于最高栈层（`zIndex: 40`），外层布局容器统一使用 `pointerEvents: "box-none"`，确保插件画布可正常点按且任何插件视图均无法遮挡或拦截宿主退出与安全控制。
   - 在 `hideDefaultDock: true` 或 `StageDrawer` 展开期间，宿主 Layer 40 底部 `ResponsePreview`（`subtitle-capsule`）一律保持隐藏，严禁在插件交互面板底部盖上全局字幕胶囊或吞掉触控。

### 5.1 首屏舞台动效清单（Motion Inventory）

| 触发场景（Trigger） | 动画属性（Animated Channels） | 曲线 / 弹簧参数（Curve / Spring） | 无障碍降级（`reduceMotion()`） |
| :--- | :--- | :--- | :--- |
| `FaceStagePosture` 五态空间切换 | 单实例表情层 `translateX`、`translateY`、`scale` 与胶囊外框（零宽高重排） | 位移与缩放使用原生 `AnimatedValue.spring`（`stiffness: 280, damping: 30, mass: 1`，近似临界阻尼无回弹）；胶囊外框 `opacity` 使用 `AnimatedValue.timing (180ms easeOut)` | 跳过动画直接 `.set(target)` 瞬时到位 |
| `StageDrawer` 档位切换与手势松手吸附 | 抽屉 FLIP `translateY` + 底部同色连续延展裙边（结合 `PanEvent.velocity.y` 速度投射与 `cancelled` 回弹） | 原生 `AnimatedValue.spring`（`stiffness: 320, damping: 32, mass: 1`） | 跳过弹簧直接 `.set(0)` 瞬时吸附 |
| `StageCanvas` / `StageCompanion` / `StageCapsule` 挂载入场 | 容器 `opacity` | `createMotion({ enter: "fadeIn", duration: 180 })` 原生淡入 | 自动跳过淡入瞬时呈现 `opacity: 1` |
| 顶栏 `退出舞台` 胶囊点击反馈 | 按压态透明度 `active:opacity-75` | 系统即时触控反馈 | 保留即时明度对比反馈 |

---

## 6. 具身桌游舞台与防窥交互规范（Embodied Tabletop Stage · `werewolf-judge`）

面向 6–12 人线下桌面聚会，LOOI 作为居中具身法官承载 **本机首屏触控** 与 **局域网手机扫码副屏** 双模体验，所有视图严格受控于 `844 × 390` 横屏安全区与 `theme.json` 语义令牌：

### 6.1 双舞台色彩分工、顶栏一体与线性图标系统
- **前台首屏插槽（`StageCapsule` / `StageCompanion` / `StageCanvas` / `StageDrawer`）**：采用不透明哑光深炭舞台面板（`stage-panel`、`stage-tile`、`stage-pill-border`、`stage-fg`、`stage-pill-fg`、`stage-muted`）配合 `1px` 细分割线消除层层套卡。主行动提交按钮统一使用暖米实心填充（`bg-eye-core text-stage-bg`，或女巫毒杀态使用 `bg-eye-core text-stage-rose-ink`）。阵营与牌局状态仅在关键判断处点缀低饱和舞台令牌：已入座/已投票/好人使用 `stage-sage-bg` / `stage-sage-border` / `face-sage-core`，警徽与当前发言/选中项使用 `stage-amber-bg` / `stage-amber-border` / `face-amber-core`，神职技能提示使用 `stage-mist-bg` / `stage-mist-border` / `face-mist-core`，狼人/毒药/出局/告警使用 `stage-rose-bg` / `stage-rose-border` / `face-rose-core`，且每项状态均同时具备文字或矢量图标标识（绝不只靠颜色区分）。
- **顶栏一体化胶囊（`capsulePlacement: "top_bar"`）**：全阶段在宿主顶栏左侧单行展示语义状态圆点、阶段短标、必要副信息（如 `存活 X/N` 或预设名）与右侧紧凑圆形快捷图标按钮（重播 `replay`、语音播报/静音 `speaker_on`/`speaker_off`、更多菜单 `more_dots`），将 `390pt` 矮横屏纵向工作区全部还给游戏面板。`狼人自爆`、已绑定副屏座位 `#k 解绑`、`提前结算（未投记弃票）`、`规则与配牌设置`、`终止本局` 与 `退出狼人杀` 统一收口于 `[⋯]` 原生 `<Menu>`，破坏性动作由原生 `AlertDialog` 二次确认。
- **矢量线性图标（`WerewolfIcons`）**：通过 `<Canvas>` 统一绘制 8 角色线性图标及舞台常用图标（防窥闭眼盾、长按手势、毒药烧瓶、声波纹、勾选圆标、等待时钟、Wi-Fi 弧线、匿名头像剪影），严禁在 JSX 中堆砌大面积高饱和 Emoji 替代图标。
- **扫码二维码表面（`<QrCodeCanvas />`）**：固定使用 `token("face-ivory-core")` 绘制 4 模块静区浅底、`token("stage-bg")` 绘制深色码点，保证浅色与深色系统外观下均维持高反差深码浅底极性，手机相机与微信扫一扫无需反色识别即可秒扫；默认作为语义 `<Button>` 触发器，轻点后弹出居中横屏 `<Dialog>`（`rounded-2xl` 容器、`maxHeight` 安全区封顶、右栏内置 `<Scroll>` 兜底），`844 × 390` 横屏下码面尺寸为 `256 × 256pt`，点击遮罩/放大码面/`Esc`/返回键或「收起二维码」即可关闭。
- **后台配置页（`WerewolfSettingsView`）**：严格沿用 `ManagementShell`（左侧 `80pt` 导航轨）与 `PluginsContextBar`（顶部面包屑、图标、版本徽章、视觉追踪就绪胶囊、启用开关）以及左右双卡片独立 `<Scroll>` 布局（`background`、`card`、`muted`、`border`、`foreground`、`muted-foreground`），融入角色线性图标、阵营配比摘要（`X 狼 · Y 神 · Z 民`）、单边框分隔行与扁平 `SwitchRow variant="flat"`。

### 6.2 防窥门禁（Hold-to-Reveal Privacy Shield）与键盘/无障碍双通道
- 发牌看牌（`dealing`）与本机黑夜行动面板（`night_guard` / `night_wolf` / `night_witch` / `night_seer`）默认覆盖不透明防窥门禁层，未解锁前底层不渲染敏感目标信息。
- **触屏按住防窥**：基于语义 `<Button>` 的 `onPressDown` 与 `onPressUp` 实现——手指按住（持续 `>= 220ms`）期间揭开底牌或夜晚技能盘；手指抬起或滑出瞬间 **`0ms` 瞬时闭合遮罩**，杜绝递手机或闭眼瞬间的余光泄密。
- **键盘与辅助功能等价路径**：轻点或键盘 `Enter` / `Space` 激活（`< 220ms`）切换至显式展开态并提供独立 `44 × 44pt`「隐藏底牌 / 锁定遮罩」按钮；点击「记住了，下一位」或提交夜晚技能时同步强制归零门禁状态。

### 6.3 狼人杀舞台完整动效清单（Motion Inventory）

设置页的「历史对局」沿用 `ActionButton` 的按压与焦点反馈。历史页使用全屏 `Dialog` 淡入淡出，开启减少动态效果时即时切换。空态插画随页面一起出现，顶栏返回和空态主按钮使用舞台色令牌，按压反馈为不透明度变化。关闭后回到原设置页。

有已结算记录时，历史页在同一深色舞台中按结束时间倒序显示列表。横屏卡片从左到右呈现日期与时间、板子与胜负、公开名场面。列表随页面进入，内容更新时就地显示。

| 状态变化类别（Category & State Change） | 原生动效工具与令牌参数（Tool & Motion Tokens） | 无障碍降级（`reduceMotion()`） |
| :--- | :--- | :--- |
| **1. 按压与悬停（Press & Hover）**：座位砖块、操作按钮、预设胶囊、分段项与二维码触发卡 | 悬停/边框色阶过渡 `transition-colors duration-120`；按压反馈 `transition-transform duration-180 active:scale-[0.97]` + 明度加深，禁用态屏蔽按压缩放 | `motion-reduce:active:scale-100`，仅保留即时明度与边框色阶切换 |
| **2. 图标与标签切换（Glyph & Label Swap）**：顶栏阶段状态点、播报/静音图标切换、计时器「暂停 / 继续」、`StageCompanion` 法官台词更新 | 倒计时 `01:00` 与 `X / N` 计数采用 `tabular-nums` 等宽数字防抖动；左栏 `StageCompanion` 文案及语音状态角标采用 `180ms` 淡入切换 | 瞬时更新数字与图标，无闪烁 |
| **3. 选中态滑动（Sliding Selection）**：开局准备载体切换（`本机防窥 | 手机副屏`） | 单一选中背景滑块通过 `createAnimatedValue` `timing(targetX, { duration: 240, easing: "easeInOut" })` 在等宽槽位间平滑滑动 | 直接 `.set(targetX)` 瞬时落位 |
| **4. 内容入场与离场（Arriving & Leaving Content）**：阶段画布切换、副屏扫码座位就绪打勾、终局全员底牌揭晓 | 画布容器 `createMotion({ enter: "fadeIn", duration: 180 })`；扫码座位就绪与终局底牌网格采用 `180ms–240ms` 轻量淡入（列表/网格上限封顶） | 跳过淡入动画，阶段面板与全部座位/底牌瞬时呈现 |
| **5. 浮层与防窥盾开合（Opening & Closing Surface）**：长按防窥盾揭开/闭合、`[⋯]` 原生 `<Menu>`、狼人自爆确认 `<Dialog>`、二维码点击放大 `<Dialog>`、原生 `AlertDialog` | 揭开防窥盾时内容层 `180ms easeOut` 呈现；**松手遮蔽时 `0ms` 瞬时闭合遮罩（安全优先）**；`<Menu>` 从顶栏按钮锚点展开/收起；`<Dialog animation={reduceMotion() ? "none" : "fade"} />` | 揭开、遮蔽、菜单与弹窗均为 `0ms` 瞬时显隐（`motion-reduce:active:scale-100`） |
| **6. 用户触发的布局变形（Layout Change）**：阶段推进驱动 `floating_top`（顶栏微缩眼眸）↔ `split_left`（左伴随右画布）↔ `full`（副屏闭眼守夜）连续过渡 | 复用宿主 `MorphableStage` 单实例 `AnimatedValue.spring`（`stiffness: 280, damping: 30, mass: 1`） | 宿主自动 `.set(target)` 瞬时切换姿态 |
| **7. 拖拽与松手释放（Drag & Release）**：`lan_companion` 夜间闭眼态可拖动的底部 `StageDrawer` peek 提示条 | 拖拽过程 `1:1` 跟随手指，松手按 `PanEvent.velocity.y` 投射吸附至最近档位（`stiffness: 320, damping: 32`） | 松手直接瞬时吸附目标档位 |
| **8. 加载与进度（Loading & Progress）**：终局 AI 法官复盘后台生成中、暗票收集横向进度条 | AI 复盘生成中复用共享 `<LoadingIndicator />` 旋转圆弧进度环；暗票进度条随收到票数比例平滑更新宽比 | `<LoadingIndicator />` 自动停转静止展示，进度条直接落位 |
| **9. 实时连续状态（Live & Continuous）**：白天/警上发言 `<Canvas>` 环形倒计时弧、发牌前摄人脸对准环 | `<Canvas>` 进度弧随剩余秒数连续绘制，最后 `10s` 切换 `token("warning")` 语义色；人脸对准就绪时外环切换 `token("verified")` | 倒计时弧按整秒离散步进更新，不播放呼吸脉冲 |
| **首夜倒计时** | 全员领牌后，等宽数字原位逐秒更新。「上一位」沿用按压反馈，入夜沿用阶段切换动效。 | 数字直接更新，阶段即时切换。 |

### 历史与逐轮复盘动效

| 触发 | 样式与反馈 | 减少动态效果 |
| --- | --- | --- |
| 历史卡、轮次、名场面、展开和返回按钮 | 150ms 明度、底色与选中描边过渡，焦点环即时显示 | 即时更新样式 |
| 打开历史或终局复盘 | 复用全屏 Dialog 淡入淡出，列表与详情切换时保留列表滚动 | 即时切换 |
| 切换轮次、翻开一夜、查看票型 | 新内容 150ms 淡入，标记对应选中轮次和展开状态 | 即时显示内容 |
| 卡片菜单、删除确认 | 锚定菜单，复用 Dialog 淡入淡出，删除后同一列表重新布局 | 菜单及确认即时开合 |
| 加载详情、生成点评、出现错误 | 复用 LoadingIndicator，结果及错误在同一区域更新 | 进度图标静止 |

## 7. 任务界面动效清单

| 触发 | 样式与反馈 | 减少动态效果 |
| --- | --- | --- |
| 选中任务、按压列表行 | 复用管理空间颜色，行内标记选中位置，背景色在 120ms 内过渡，行高保持稳定 | 直接切换色阶 |
| 切换详情标签 | NSH Tabs 原生指示线移动，RetainedPage 保留各标签的滚动位置 | 指示线和内容直接切换 |
| 翻页或切换任务 | 新一页列表和新任务详情从顶部显示，状态和时间使用等宽数字 | 内容立即更新 |
| 执行状态、输出或回执到达 | 在当前标签内就地更新状态、记录和数量 | 内容立即更新 |

---

## 8. 监控视频全屏视图与动效清单

面向智能家居摄像头的实时监控查看，采用独立内聚组件 [`CameraMonitor`](ui/CameraMonitor.tsx) 统一管理内联预览与全屏观看状态：

1. **单实例原生视频交接（Zero-Reconnect Surface Handoff）**：
   - 当存在活跃 `sessionId` 时，内联视口整块作为单一语义 `<Button>` 热区（右下角叠加 `pointerEvents: "none"` 的 `bg-glass-bg` + `border-stage-pill-border` 放大角标，严禁嵌套交互控件）。
   - 进出全屏不销毁底层会话，严格保证同一时刻全树仅挂载 1 个 `<CameraVideo>` 实例（非全屏挂载内联节点，全屏挂载 `<Dialog>` 内节点）。
2. **全屏承载层与深色舞台 HUD**：
   - 使用 `<Dialog presentation="fullScreen" statusBar={{ hidden: true, animated: true }} android={{ statusBarTranslucent: true }} closeOnEscape={true} closeOnSwipe={false} closeOnBackdropPress={false} />`，基底采用 `bg-stage-bg`（OLED 深炭/纯黑底），视频铺满 `absolute inset-0` 并维持原始宽高比居中渲染。
   - 顶部左/右胶囊（状态/摄像头名称/分辨率、重连、退出全屏）与底部状态及可选云台四向控制盘（`136 × 136pt`）统一遵循模态内部 `safeAreaInsets()` 安全区避让，颜色全部取自 `theme.json` 语义令牌（`stage-bg`、`stage-panel`、`stage-tile`、`glass-bg`、`elevated-glass`、`stage-pill-border`、`stage-pill-fg`、`stage-pill-muted`、`stage-fg`、`stage-muted`、`eye-core`、`verified`、`warning`、`destructive`、`ring`）。
   - 正在流畅播放且未操作云台时，HUD（Heads-Up Display，平视叠层控件栏）在 4 秒无交互后自动隐藏；轻触画面可即时显隐，连接中、缓冲中、断流出错或云台转动期间锁定显示。

### 8.1 全屏监控动效清单（Motion Inventory）

| 状态变化类别（Category & State Change） | 原生动效工具与令牌参数（Tool & Motion Tokens） | 无障碍降级（`reduceMotion()`） |
| :--- | :--- | :--- |
| **1. 按压与悬停（Press & Hover）**：内联全屏触发卡与放大角标、全屏 HUD 重连/退出/恢复按钮、全屏云台方向按钮 | 内联触发卡使用 `transition-opacity duration-150 active:opacity-80`；HUD、恢复与云台按钮统一使用 `transition duration-150 active:scale-[0.95]` 与悬停底色提升，禁用态保持静止 | `motion-reduce:active:scale-100`，仅保留即时明度/边框反馈 |
| **2. 图标与标签切换（Glyph & Label Swap）**：全屏顶部状态圆点与播放/缓冲/异常文案、分辨率 `tabular-nums` 等宽数字、云台转动中提示 | 文本与状态点在固定容器高度内就地更新，数字使用 `tabular-nums` 防止横屏抖动 | 瞬时更新状态点与文案 |
| **3. 选中态滑动（Sliding Selection）**：本视图无 | 无 | 无 |
| **4. 内容入场与离场（Arriving & Leaving Content）**：无流占位（加载/错误）与实时画面切换 | 容器随 `sessionId` 条件就地切换，状态文案与操作按钮稳定居于视觉中心 | 瞬时切换状态内容 |
| **5. 浮层开合（Opening & Closing Surface）**：全屏 `<Dialog>` 开合、全屏 HUD 控制栏显隐（点击画布或 4 秒无操作自动收起） | 全屏 `<Dialog animation={reduceMotion() ? "none" : "fade"} />`；HUD 容器绑定单一 `AnimatedValue` 驱动 `opacity`：`timing(1, { duration: 180, easing: "easeOut" })` 展开、`timing(0, { duration: 150, easing: "easeIn" })` 收起 | `<Dialog>` 使用 `"none"`；HUD `opacity` 直接 `.set(0 / 1)` 瞬时切换 |
| **6. 布局变形（Layout Change）**：本视图无（通过互斥单实例交接而非宽高变形过渡） | 无 | 无 |
| **7. 拖拽与松手释放（Drag & Release）**：本视图无（禁用模态下拉误关） | 无 | 无 |
| **8. 加载与进度（Loading & Progress）**：连接视频中、缓冲中、云台转动提示 | 复用共享 `<LoadingIndicator stage={true} />` 旋转圆弧进度环（全屏顶部/左下角使用 `inline={true}` 紧凑样式） | `<LoadingIndicator />` 自动停转静止展示 |
| **9. 实时连续状态（Live & Continuous）**：`CameraVideo` 原生硬解码视频帧渲染 | 原生层（iOS `AVSampleBufferDisplayLayer` / Android `TextureView` + `EGLSurface`）按视频流帧率渲染，切换画布时立即重绘最新保留帧避免黑屏 | 视频实流按原生解码帧率正常播放，HUD 与辅助提示无闪烁 |

---

## 9. 「定时（Schedules）」空间与多任务审批队列规范（`ui/SchedulesSpaceView.tsx`）

1. **多任务交互审批队列（`pendingInteractions`）**：
   - 取代单槽交互状态，按 `(taskId, id)` 维护队列并优先展示 `"foreground"` 前台任务交互，其次展示 `"schedule"` 后台定时规则交互。
   - 任一任务结算或取消时仅通过 `clearInteractionsForTask(taskId)` 移除该任务对应交互，严禁清空并发运行中其他任务的待审批弹窗。
   - 全局审批 `Panel` 顶部在排队数量 `> 1` 或来源为 `"schedule"` 时展示归属条（如 `定时任务 · <ruleTitle>`）与等宽排队计数徽章（`1 / N`，`fontVariant: ["tabular-nums"]`），拒绝/停止按目标 `taskId` 精准路由至 `respondTask` 或 `cancelTask`。
2. **布局与视觉约束**：
   - 全部颜色读取 `theme.json` 语义令牌（零硬编码色值、常规卡片零阴影、圆角填充选中态禁止单侧边条、`>= 44 × 44pt` 触控热区）。
   - 横屏规则子视图左列表 / 右检视器按 `42% / 58%` 比例划分并各自挂载独立 `<Scroll>`；勿扰子视图左栏配置+GitHub PAT / 右栏多时段列表；数字与时间统一使用 `tabular-nums`。

### 9.1 「定时」空间动效清单（Motion Inventory）

| 状态变化类别（Category & State Change） | 原生动效工具与令牌参数（Tool & Motion Tokens） | 无障碍降级（`reduceMotion()`） |
| :--- | :--- | :--- |
| **1. 按压与悬停（Press & Hover）**：规则行、筛选胶囊、按钮、星期选择器 | `active:opacity-70 transition-colors duration-150 motion-reduce:transition-none`；列表行加深背景（`hover:bg-secondary` / `bg-muted`），`ActionButton` 与胶囊统一使用透明度按压反馈 | `motion-reduce:transition-none`，色阶与按压反馈瞬时响应 |
| **2. 图标与标签切换（Glyph & Label Swap）**：状态点、规则数、`立即运行` 图标、下次触发时间 | 计数与时间使用 `tabular-nums` 防抖动；`立即运行` 加载态复用 `IconButton` 原生 `createMotion` 旋转动效 | 立即切换文案与静态图标，停转 |
| **3. 选中态切换（Sliding / Selection）**：顶栏 `规则 / 勿扰时段`、来源筛选、规则列表行、触发类型与策略切换 | 整块圆角填充色在 `transition-colors duration-150 motion-reduce:transition-none` 内平滑过渡，行高与对齐轴稳定，禁止使用单侧边条 | `motion-reduce:transition-none` 瞬时切换选中填充 |
| **4. 内容到达与离场（Arriving & Leaving Content）**：子视图、执行记录、通知交付轻提示 | 子视图用 `RetainedPage` 保持滚动位置；新执行记录与提示就地更新 | 瞬时呈现 |
| **5. 浮层开合（Opening & Closing Surface）**：新建/编辑规则与勿扰 `Dialog`、删除 `AlertDialog` | `Dialog` 使用 `animation={reduceMotion() ? "none" : "fade"}` 并适配 `keyboardFrame().height`；删除走原生 `AlertDialog` | `0ms` 瞬时开合（`"none"`） |
| **6. 布局变化（Layout Change）**：条目增删、跨午夜提示显隐、Cron 预览展开 | 在所属 `<Scroll>` 容器内稳定重排，外层无整页跳动 | 瞬时更新 |
| **7. 拖拽与手势（Drag & Release）**：列表与表单滚动 | 仅使用原生 `<Scroll>` 滚动物理回弹，无自定义拖拽 | 原生滚动 |
| **8. 加载与进度（Loading & Progress）**：规则 `running` 状态、GitHub 令牌在线校验 | 规则运行态徽章与 GitHub 令牌校验复用 `LoadingIndicator inline` 旋转圆弧 | 静止圆弧展示 |
| **9. 实时连续状态（Live & Continuous）**：勿扰生效态指示、下次触发时间倒计时 | 按分钟边界离散刷新（仅基于 `scheduleClockTick` 与 `scheduleSettings` 计算），无高频闪烁 | 同样离散刷新 |
