# Super-LOOI Presence v3.0 新版具身硬件 UI 设计规范
## 「Luminous Hardware & Media-Rich Conformal Bento（灵动光感硬件与富媒体共形空间）」

本规范基于对 Presence v2.1 的深度视觉与代码走查，以及与原始目标设计稿（`archive/legacy-v1:design/首屏示例.png`、`archive/legacy-v1:design/记忆示例.png`、`page-design.md`、`docs/design-v2/ui_manifest.json`）的逐帧对齐制定。

## 本轮执行边界与原生运行约束（2026-11-04）

本轮仅实现 `@super-looi/mobile` Phase 7 Step 7.1 / 7.2，并提前实现用户明确要求的 `RobotFaceView` avatar。四大空间整体重构、`ConformalDeviceShell` 整体升级与 Hub Web 同步仍属后续 7.3 / 7.4。

预编译 iOS Simulator `superlooiapp.app` 使用 RN 0.85.3 New Architecture，已包含 ExpoFont（`@expo/vector-icons`）、ExpoImage，以及原生 `experimental_backgroundImage` 的径向/线性渐变、`boxShadow` 与 `filter`；没有链接 RNSVG。**不得添加 `react-native-svg`，不得直接编辑 Expo prebuild 产物。** 移动端以 Ionicons 与 RN 原生绘制实现；下文后续空间所述 SVG 插画仅表示视觉目标或 Web 实现，不能据此引入移动端 RNSVG。

验收分别记录代码实现、mobile 三项自动化检查和 iOS 模拟器视觉结果；无原生截图时不得宣称已消除全部 Mach bands 或已达成逐像素一致。

---

## 一、 v2.1 六大视觉与交互病灶归档（v3.0 必须彻底根治）

1. **首屏大脸失真与“脑门贴膏药”**：
   - `RobotFaceView.tsx` 与 `console-html.ts` 在眼球顶部硬贴了 `eyeHighlight` 灰白条，在默认 `neutral` 态画了两条悬空细棍眉毛，且在 iOS 上因 3 层半透明 `<View>` 叠加形成刺眼的“同心塑料环 (Mach bands)”，`eyeCrescent` 渲染成眼球右侧怪异括号。
   - 首屏顶部常驻 `[ ● 陪伴待机 / 感知未接入 ]`、`[ 功能 ]`、`[ 仿真台 ]` 三个带框大胶囊，违背 `page-design.md` “默认状态下，它就是一张脸”的核心原则。
   - 底部唤醒栏退化为暗淡小灰字，丢失了 `首屏示例.png` 标志性的 `··|┃|·· ( 说 Hey LOOI 唤醒我 ) ··|┃|··` 对称声波括号与底部弧形地平线辉光。
   - iOS 竖屏视口下固定像素未按视口短边自适应缩放，导致画面挤压失调。
2. **共形外壳与右上角迷你头显简笔画化**：
   - 右上角迷你 LOOI 头显 (`avatar` 模式) 退化为 `108×66` 扁平单线框，丢失了 `记忆示例.png` 中 3D 深空灰金属倒角头盔外壳、顶部 `···· M ····` 传感器灯阵、两侧发光青色耳灯与深凹纯黑曲面面罩（Visor）的立体硬件质感。
   - 标题旁 `.anchor` / `anchorPair` 画成了两个粗短胶囊 `❚❚`，视觉上酷似“暂停键 `⏸`”，而非 `记忆示例.png` 的 9 柱对称细线音频波纹 (`··|┃|··`)。
   - 左上角缺乏发光猫耳/面罩几何徽标。
3. **防御性免责声明污染与底层 Schema 字段裸露**：
   - 回忆册卡片正面直接印着 `REV 1 · DEMO`，详情暴露 `WHEN / WHERE / HOW / TRUST`、`authenticated_user_statement`、`ev_keys_stmt`；
   - 任务页直接裸露 `ws_godot_island · DEMO`、`art_checklist`、`ev_artifact_godot`，甚至在“日常约定”中直接渲染原始 JSON 字符串 `{"service":"turn_on","color_temp_kelvin":4000}` 和 `context == "web_study"`；
   - 家居页直接将 `light.study_ceiling`、`sensor.study_temperature` 作为副标题展示，并在窄屏下断词折行。
4. **满屏 1px 蓝框方盒与原始控件，零富媒体与零触控质感**：
   - 回忆册缺乏 `记忆示例.png` 的左侧发光时间轴与 16:9 场景光影插画；右侧桌面证据示意图在移动端是 `<View>` 方块积木，在 Web 端是写死 `cx="98" cy="124"` 静态坐标的灰暗简笔画。
   - 书房家居用两个并排文字按钮 `[ 开启 ] [ 关闭 ]` 代替发光拨动开关（Toggle Switch），移动端甚至用 `<TextInput>` 弹键盘输入 `1..255` 整数调亮度；Web 端色温按钮 `[3000K] [4000K] [5500K]` 漏写选中高亮态。
5. **手搓 `<View>` 火柴棍图标 (`LooiIcon.tsx`) 与窄屏/弹层布局崩坏**：
   - `LooiIcon.tsx` 用旋转 `<View>` 拼凑图标，四角不闭合、线条生硬。
   - `console-html.ts` 中 `.drawer-open .wake { opacity: 0 }` 写在 `.wake { opacity: 0.72 }` 之前，导致打开快捷抽屉/仿真台时底层唤醒文字穿透重叠在按钮上。
   - Web 窄屏 (`<650px`) 下 `.rail` 使用全局 `position: fixed; bottom: 0` 横穿长截图中央截断卡片，且 `.connections` 未改为单列导致三张连接卡挤成 `105px` 细条。

---

## 二、 Presence v3.0 四大核心设计支柱与组件规范

### 支柱 1：Ionicons / RN 原生光学底座与人性化语义转译层 (`humanize.ts` + `LooiIcon`)
1. **使用已有原生能力**：
   - `LooiIcon.tsx` 全部 30 个 `LooiIconName` 与 props 保持兼容，使用 `@expo/vector-icons/Ionicons` 渲染，并提供 Node 环境或字体未加载时的安全回退。
   - 导出 `LooiBrandMark`：青色发光猫耳/面罩徽标；导出 `LooiWaveOrnament`：7/9 柱对称细声波。两者不依赖 RNSVG。
   - 全屏眼球、背景辉光与头盔使用 RN 0.85.3 原生 `experimental_backgroundImage` 和 `boxShadow`，避免多层同心圆透明 View 造成离散色带。
2. **新增人性化文案转译模块 (`apps/mobile/src/ui/humanize.ts` & Web 同构映射)**：
   - **记忆来源 (`how`)**：
     - `authenticated_user_statement` → `主人亲口确认`（配声波图标）
     - `active_look_capture` → `视觉抓拍 + 语音`；`passive_observation` → `桌面视觉观察`
     - `pattern_inference` / `inferred` → `近期习惯推断`
   - **认识论状态 (`epistemicStatus`)**：
     - `confirmed` → `已确认事实`（翠绿 `#4ADE80`）
     - `observed` → `观察记录`（青蓝 `#28D5FF`）
     - `inferred` → `模型推测`（琥珀 `#F3C56B`）
   - **日常约定与家居规则自然语言化**：
     - 自动将 `entity_id: "light.study_ceiling"`, `condition: 'context == "web_study"'`, `desired_state: {"service":"turn_on","color_temp_kelvin":4000}` 转译为人类可读标题与描述：
       - 主标题：`书房吸顶灯 · 学习模式自动调光`
       - 触发与动作：`当进入书房学习时 → 自动开启并调至 4000K 自然白光`
   - **工作区与产物名称人性化**：
     - `ws_godot_island` → `Godot 海岛工程`；`art_checklist` → `道路与阶梯核查清单`；`art_app` → `Godot 构建产物包`。
     - `Task succeeded with 2 verified artifacts` → `任务已完成 · 2 项产物已回读核验`；`High-risk command requires user approval...` → `检测到高危命令，等待主人单次授权`。
   - **动态场景锚点**：`resolveMemorySceneTarget(whereText, itemTitle)` 返回归一化 `xPercent`、`yPercent` 和 `keyboard_left | monitor_right | bookshelf | drawer_right`；显式空间文字优先于物品默认位置，场景靶心随实际位置变化。
   - 为上述 helpers 配套 `humanize.test.ts`，从 `apps/mobile/src/index.ts` 导出。
     - 保留测试所需的必要可访问性与契约字段（如在折叠详情或 `accessibilityLabel` / 次级徽章中保留原始标识），但主视觉层级 100% 干净自然。

---

### 支柱 2：第一层 —— 纯净全屏发光生命体 (`RobotFaceView` v3 + `QuickDrawer` v3)
1. **1:1 复刻 `首屏示例.png` 光学大眼**：
   - **移除冗余装饰**：彻底删除眼球顶部的灰白高光条 (`eyeHighlight` / `eyeCrescent`) 以及 `neutral` / `listening` 态的悬浮细棍眉毛。
   - **原生平滑渐变光晕 + 深宝蓝折射底缘**：
     - 背景使用 `experimental_backgroundImage: "radial-gradient(...)"` 绘制连续氛围光，移除离散同心光圈层。
     - 双眼 `196×180pt`、`borderRadius: 90pt`、`gap: 164pt`；通过 `useWindowDimensions()` 使用 `scale = Math.min(1.08, Math.max(0.58, Math.min((width - 32) / 620, (height - 80) / 340)))`。
     - 眼球使用 `experimental_backgroundImage: "linear-gradient(180deg, #3BE2FF 0%, #1DC4FF 78%, #0058FF 100%)"` 与 `boxShadow: "0 0 58px 14px rgba(40, 213, 255, 0.42), inset 0 -10px 0 0 #004CFF"`。
   - **圆润微笑弧与动态眼睑情绪**：
     - 微笑使用 `64×22pt`、`borderBottomWidth: 5pt`、`borderRadius: 32pt` 的青色发光弧线。
     - neutral / listening 不显示悬空眉毛，仅 thinking、curious、happy、skeptical、alarmed 使用细微眼睑/眉形表达；保留睡眠与安全状态。
2. **零后台铬元素首屏 + 底部声波括号唤醒栏**：
   - 首屏顶部默认**不显示** `[功能]`、`[仿真台]` 大框按钮；左上角仅保留一枚极克制的无边框半透明微状态点（`opacity: 0.48`，轻触可展开状态或呼出抽屉；同时保留隐藏/轻量无障碍入口以兼容测试）。
   - 底部 1:1 还原 `首屏示例.png`：左侧 7 根对称渐变的发光声波刻度 `··|┃|··` + 弧形括号 `( 说 Hey LOOI 唤醒我 · 轻触屏幕展开 )`（其中 `Hey LOOI` 为 `#2B88FF` 电光蓝高亮）+ 右侧 7 根对称声波刻度 `··|┃|··` + 屏幕底缘柔和的蓝色弧形地平线辉光。
3. **共形缩放式毛玻璃抽屉 (`QuickDrawer` v3)**：
   - 唤出快捷抽屉或仿真台时：
     - **底层唤醒栏强制完全隐藏**（修复 `.drawer-open .wake` CSS 层叠顺序 Bug，彻底杜绝文字穿透）；
     - 向 `RobotFaceView` 传入 `drawerOpen={quickDrawerVisible || simLabVisible}`，机器人双眼平滑缩小至约 `0.72` 倍并上移 `44pt`；不以厚重黑幕遮盖大脸。
     - 左上角状态入口保持 `opacity: 0.48`，Lab 入口使用低透明度小点/胶囊；保持 `打开快捷功能抽屉` 与 `打开仿真演练台` 无障碍标签。
     - 抽屉采用 4 个主空间高颜值发光玻璃大卡（带实时计数角标，如 `4 条记忆`、`待批授权`、`3 台在线`、`48 项核验`，均取自实时状态）+ 顶部/底部独立分组的 `[ 隐私暂停 ]` 与 `[ 仿真演练台 Lab ]` 工具操作。
   - SimLab speaking 演示提示使用自然中文，如 `正在为你留心书桌上的钥匙与水杯位置 · 演示模式`。

---

### 支柱 3：第二层外壳 —— 3D 头盔面罩 `ConformalDeviceShell` v3
1. **右上角 3D 机器人头盔面罩 (`MiniLooiHelmet`)**：
   - 严格还原 `记忆示例.png` 右上角：使用 RN 原生渐变与阴影绘制 `148×82pt`、`borderRadius: 34pt` 的立体深空灰金属倒角外壳 (`#132030` → `#08101A` 线性渐变 + 高光内描边；avatar 组件提前纳入 Step 7.2)、顶部传感器阵列 (`···· M ····`)、左右两侧发光青色耳灯条 (`#28D5FF`)、深凹纯黑曲面玻璃面罩 (`#02050A`)，内部青色双眼与微笑弧线随用户点击卡片产生平滑的视线聚焦偏移。
2. **左侧玻璃窄轨 (`86pt`) 与标题 9 柱音频波纹**：
   - 窄轨顶部绘制发光的 **LOOI 猫耳面罩品牌徽标**（复用 `LooiBrandMark`）；
   - 窄轨导航项未选中态干净无冗余方框，选中态呈现 `记忆示例.png` 同款的青蓝外发光圆角方框 (`borderRadius: 18pt` + 柔和内辉光)；
   - 页面大标题（如 `我的记忆`、`书房家居`）旁将酷似暂停键的 `❚❚` 替换为 **9 柱对称高低错落的发光声波纹 (`··|┃|··`)**。
3. **窄屏/竖屏安全布局**：
   - Web 与移动端在窄屏 (`<720px`) 下，底部导航栏采用高遮蔽率毛玻璃 (`rgba(4, 10, 18, 0.95)`) 并为内容滚动区预留充足底部安全边距，且在静态长图中避免悬浮拦腰截断卡片内容。

---

### 支柱 4：第三层 —— 四大共形空间的富媒体化与实体控件重塑

#### 1) 回忆册 (`MemoriesSpace` v3)
- **左侧发光时间轴 + 富媒体场景插画 Bento 卡片**：
  - 列表左侧配备发光青色时间轴线与节点 (`●───●`)。
  - 每张记忆卡片内嵌一幅 **16:9 深色氛围感 SVG 场景光影插画**（根据物品类型渲染：背光机械键盘旁的金属钥匙、曲面显示器右下方的 AirPods 耳机盒、书架二层的保温杯、右侧抽屉里的充电线），底部左侧显示声波图标与自然语言来源（`语音 + 视觉`），右上角显示语义色徽章（`已确认事实` / `观察记录` / `模型推测`），正面不再显示 `REV 1 · DEMO`。
- **右侧高精度动态证据检视器 (`Evidence Inspector`)**：
  - 顶部为高精度俯视书桌光影 SVG 图，**根据当前选中记忆的真实位置动态移动青色脉冲靶心与高亮区域**（彻底修复写死 `cx="98" cy="124"` 的 Bug！点击钥匙聚焦键盘左侧，点击 AirPods 聚焦显示器右下方，点击保温杯切换至书架层板区域，点击充电线聚焦右侧抽屉）。
  - 下方以中文化四维卡片展示：`观察时间`、`空间位置`、`记忆依据`、`认识边界`，底部提供高对比度三态纠错按钮（`不是这里`、`已经拿走了`、`忘掉这条`）。

#### 2) 约定与任务簿 (`TasksSpace` v3)
- **生产力任务卡与三态诚实取消**：
  - 展示清晰的任务目标、工作区徽章（`Godot 海岛工程`）、阶段状态条与可阅读的已核验产物芯片（如 `📄 道路与阶梯核查清单 · 已回读`、`📦 Godot 构建产物 · 已回读`）。
  - 取消操作展示醒目的三态诚实反馈条（`请求取消中` → `远端进程已确认停止` / `连接中断 · 结果待核实`）。
- **高危作用域审批盾牌卡 (`Scoped Approval Shield`)**：
  - 采用醒目的琥珀金渐变边框与安全盾牌头部，结构化展示 `📁 读取范围`、`✍️ 写入目标`、`⚡ 拦截高危指令 (代码块高亮)`、`⏱ 授权边界 (单次有效)`，主操作按钮 `[ 批准本次执行 ]`（琥珀实心高亮）与 `[ 拒绝并请求取消 ]`（珊瑚红描边）层级分明。
- **日常约定卡片自然语言化**：
  - 将原始 JSON 规则转译为自然语言卡片（如 `书房吸顶灯 · 进入书房学习时自动开启 4000K 自然白光`），不再直接裸印 JSON 大括号。

#### 3) 书房家居 (`HomeSpace` v3)
- **实体感触控控件（彻底淘汰 `<TextInput>` 填数字与双文字开关按钮）**：
  - **发光拨动开关 (`LooiToggleSwitch`)**：每张设备卡右上角配备 `记忆示例.png` 同款的蓝白发光拨动开关，开启时整张卡片泛起微弱的暖白/青蓝环境内辉光。
  - **可视化触控亮度滑轨 (`LooiBrightnessBar`)**：移动端与 Web 端统一提供直观的流光进度条 + 分档快捷触控点（`25% / 50% / 75% / 100%` 及平滑拖动），彻底移除移动端的 `<TextInput>` 填数字框。
  - **色温冷暖色块胶囊**：`[ ● 3000K 暖黄 ]`（`#FFB347` 色点）、`[ ● 4000K 自然白 ]`（`#FFF4E0` 色点）、`[ ● 5500K 清冷光 ]`（`#8CE0FF` 色点），当前选中档位明确高亮激活描边与发光底色（修复 Web 端色温未高亮 Bug）。
- **环境传感器真值仪表盘**：
  - 采用三列大字号环形/弧形指示卡展示 `23.8°C 温度`、`48% 湿度`、`612 ppm CO₂ (空气清新)`，将冗长的 `sensor.study_*` 实体 ID 收敛为精致的 `物理传感器实测` 角标。

#### 4) 维修舱 (`CabinSpace` v3)
- **三路连通性健康卡（窄屏自适应折行）**：
  - 宽屏三列并排、窄屏 (`<720px`) 自动切换为单列紧凑卡片（修复 `hub-mobile-cabin.png` 挤压 Bug）。
- **双脑引擎热切换 + 硬件健康与 OLED 位移十字准星雷达**：
  - 可视化展示双轨语音、三端视觉、4 阶热状态阶梯槽与 `[-6, +6]px` OLED 防烧屏位移十字坐标盘。
- **48 项核心验收：四大安全硬门禁盾牌看板 + 8 组进度总览（支持按需展开 48 项明细）**：
  - 默认凸显 **四大安全硬门禁（0 越权执行、0 跨主体泄露、0 僵尸复活、0 未核验完成）** 与 **A~H 八组通过率进度条 (`6/6`)**，并提供 `[ 展开/收起 48 项用例明细 ]` 切换开关，兼顾日常视觉克制与完整验收核查。
