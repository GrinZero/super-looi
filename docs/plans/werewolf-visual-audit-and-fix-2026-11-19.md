# 狼人杀 UI 视觉审计与修复方案（2026-11-19）

## 1. iOS 横屏基线空间约束

基准视口：`844 × 390 pt`（实测 iPhone 16e 模拟器 `@3x = 2532 × 1170 px`，安全区 `left=47..59, right=47..59, top=0, bottom=21`）。
- 顶栏高度：`56 pt`（`paddingTop: 10`，实际行中心 `y = 32 pt`）。
- 全宽画布（`floating_top` + `capsulePlacement: "top_bar"`）：可用区 `y = 60..359 pt`，净高 `299–301 pt`。
- 左分栏右画布（`split_left`）：`widthRatio` 分别为 `0.34`（发牌）、`0.32`（白天发言）、`0.30`（终局），右画布净高 `299–301 pt`。
- 后台 `ManagementShell`：扣除左侧 `80 pt` 导航轨、安全区与工作区内边距后，净宽约 `618 pt`。

## 2. 已确认的实质性异常清单

### 2.1 顶栏与舞台几何（`MorphableStage` / `StageCapsule` / `StageDrawer` / `RobotFace`）
1. **流内错误条与冗余字幕条挤爆画布**：`WerewolfStageError`（`36–52 pt`）与 `judgeSubtitle`（`36 pt`）插入 `StageCanvas` 文档流顶部，压缩面板至 `211–263 pt`，引起 Lobby 左卡底排腰斩、右卡座位上下碰撞、Dealing 镜头环压盖标题且抓拍按钮插入主按钮背后、9P/12P 夜间第 3 排裁切过半。
   - **方案**：`StageCanvas` 与 `StageDrawer` 移除流内 `WerewolfStageError`，统一收口至顶栏红色告警按钮（`werewolf-stage-error-btn`），点击弹出深炭 `<Dialog>` 展示完整 `[stage=... code=...] reason` 并支持复制；卡片页不再顶部叠加重复 `judgeSubtitle`，仅全屏闭眼态（`night_intro` / `dawn_settle`）显示字幕。
2. **顶栏左区碰撞截断与高低参差**：左侧叠加 `voiceStatusPill` 文字胶囊与 3 枚 `w-8 h-8`（`32 pt`）按钮，导致预言家回合截断为 `第1夜 · 预言家...` 且 `[⋯]` 紧贴左眼光晕；左 `32 pt` vs 右 `44 pt` 明显高低参差，且外层 `overflow-hidden` 裁切 `hitSlop`、相邻热区重叠 `8 pt`。
   - **方案**：`voiceStatusPill` 改无边框精简文字，重播入口移入 `[⋯]` `<Menu>` 首项，顶栏左钮统一升级为 `w-11 h-11`（`44 pt`）；修正 `posture-geometry.ts` `STAGE_TOP_RIGHT_CONTROLS_RESERVED_WIDTH = 296`、光晕包络按 `600` 计算且留 `14 pt` 净空。
3. **微缩表情对位与眼睑光晕瑕疵**：`floating_top` frameless `targetCenterY` 偏高 `3.8 pt`，`judge_lobby` 微缩眉弧发虚，半闭眼 `eyelid` 先画完整 `halo` 再裁切导致上方残存灰雾穹顶；`split_left` 垂直重心偏高且 `victory_party` 彩屑距胜负标题仅 `4.2 pt`。
   - **方案**：`floating_top` frameless `targetCenterY = safeTop + Math.round(STAGE_TOP_BAR_HEIGHT * 0.60)`；`RobotFace` 在绘制 `halo` 前即应用 `eyelid` 裁剪；`choreography.ts` 区分无眉 `judge_lobby` 与带眉 `judge_dealing`；`split_left` 拟合宽度 `560 → 600`、`verticalFraction` `0.36 → 0.40`、`leftCompanion.top` 偏移 `132 → 146`。
4. **抽屉 `peek` 态裁切按钮**：`peekHeight = 95 pt` 未计入 `safeBottom = 21 pt`，净内容高仅 `24–25 pt`，`44 pt`「主机代操作」被裁切 43%。
   - **方案**：`peekHeight` 计入 `safeBottom`（`safeBottom + 86..96 pt`），抓手栏收紧至 `h-7`（保 `hitSlop`），`full` + `peek` 同步上移表情中心，拉高至 `large` 时展示夜行门禁面板。
5. **浅色外观下深炭舞台弹出纯白浮层**：`StageCapsule` `<Menu>` 与 `QrCodeCanvas` `surface="stage"` 弹窗误用 `bg-popover`，且 12P LAN 菜单展开 18 项溢出横屏。
   - **方案**：`StageCapsule` `<Menu>` 与 `QrCodeCanvas` 舞台态弹窗均切换深炭舞台令牌；解绑座位超 3 席时收口为单条弹窗管理入口。

### 2.2 开局大厅 / 发牌 / 二维码
1. **Lobby 左卡 12P 守卫裁切消失 & 底边参差**：角色摘要折 2 行 + 4 颗规则 chips 折 2 行，使「具身环视」与「调整规则 >」掉出视口；`<Scroll>` 与右卡底边差 `16 pt`。
   - **方案**：「调整规则 >」上移至左卡右上角与标题齐平，角色摘要紧凑单行，滑块轨高收紧为 `h-11 p-1`，底部 4 chips 单行独占整行，移除左卡 `<Scroll>` 使左右卡片内底边齐平。
2. **Lobby 右卡扁椭圆 & 角标飘移 & 二维码留白**：`on_device` 座位缺定宽外框被拉成 `70.7×40 pt` 扁椭圆；`lan_companion` `relative` 错挂在宽格上导致绿勾飘离正圆 `12 pt`、`0/6` 误亮绿、Wi-Fi 端口截断；`QrCodeCanvas` 双重静区使 `96 pt` 卡内黑码仅占 `50×50 pt`（27% 面积）。
   - **方案**：`on_device` 改为固定正圆 + 单行说明；`lan_companion` 将 `relative` 锁在正圆包裹层，按未就绪/部分/全员就绪分级着色，Wi-Fi 去 `http://` 保端口；`QrCodeCanvas` 取消外层 padding、`quietModules = 4` + 边界连续映射，缩略码扩至 `size={104}`。
3. **Dealing Seat 1 按压跳动 & 头像栏越界**：`engine.ts` `canStepBackDeal` 误含 `dealingRevealingSeat !== null`，Seat 1 按下瞬间插入「← 上一位」把主按钮推右 `+95.7 pt`；翻牌卡 `flex-1` 拉伸空洞；进度圆点已完成态“绿圈套绿圈”。
   - **方案**：`canStepBackDeal` 仅判断 `dealingHistorySeats.length > 0`；Seat 1 始终保留禁用态占位保主按钮位置零跳变；镜头环缩为 `w-14 h-14` + `h-9` 抓拍钮；翻牌卡改居中自适应，新增纯对勾 `"check"` 图标。

### 2.3 夜间 / 白天 / 公投 / 离场 / 终局
1. **夜间 9P/12P 裁切截断、预言家标题错位与女巫按钮失衡**：`judgeSubtitle` 压缩下 9P/12P 夜间第 3 排裁切过半，12P 选中态 `"12号 已选择"` 横向溢出，5 处 `<Scroll contentClass="justify-center">` 缺 `min-h-full` 导致 6P 重心错位 `13.5 pt`，女巫三钮 `303:66:303` 参差，预言家结果页标题未切换。
2. **白天 9P/12P 挤压溢出**：有头像态圆外重复 `12号` 文本列吃掉 `30 pt`，12P 状态区仅剩 `18.5 pt` 且 9P/12P 纵向溢出。
3. **公投锯齿与溢出**：副屏 7–12P 砖块溢出 `15.7 pt` 且 12P 纵向溢出；本机投票 `flex-wrap` 动态宽度（`40 pt` vs `104 pt`）锯齿严重。
4. **终局纵向溢百点 & 12P 横向截断**：`min-h-14` 3 行卡片 + `LOOI 复盘` 在 `<Scroll>` 内导致 6P 裁切复盘条、9P/12P 溢出近 `100 pt`；12P 角色名净宽仅 `20 pt`。
   - **方案**：全面收紧网格尺寸与内边距、取消冗余选中后缀、夜间/白天/公投/终局 `<Scroll>` 补 `min-h-full`、白天头像号改角标、本机投票改为等宽网格、终局将 `LOOI 复盘` 移出 `<Scroll>` 并精简 12P 卡片状态文本。

### 2.4 后台管理空间、控件、图标与主题令牌
1. 补充前台舞台专用 `stage-amber-*`、`stage-sage-*`、`stage-mist-*` 与 `accent`/`accent-foreground`，修正 Light `muted-foreground`（`#5E5E66`）与 Dark `stage-muted`（`0.56` 透明度）满足 AA 对比度。
2. `Controls.tsx` 抽出共享 `ToggleSwitch`、`SelectField` 改矢量尖括号、统一可见 `focus-visible:ring-2` 焦点环、`TextField compact` 升级 `min-h-11`。
3. `PluginsSpaceView.tsx` 手机横屏改 `grid-cols-2`（`>=960pt` 为 `grid-cols-3`）、目录标题 `items-baseline`、`subtle-text` 升为 `text-muted-foreground`；`SettingsView.tsx` `w-8 h-8` 紧凑步进器 + `hitSlop={6}`、去重复阵营词、独立边框容器包裹连续 `SwitchRow`、`w-24` 发言时长防挤爆 `交互形态`。
4. `WerewolfIcons.tsx` 补 `flexShrink: 0`，修复 `hunter`、`replay`、`white_wolf_king` 几何缺陷并统一 `avatar_silhouette` 线性描边风格。
