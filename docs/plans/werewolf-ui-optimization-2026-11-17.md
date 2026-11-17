# 狼人杀 UI 视觉与舞台交互优化实施计划（2026-11-17）

## 1. 目标与边界

对照 `docs/artifacts/werewolf-ui-redesign-2026-11-16/` 中的 7 张横屏效果图（`01-settings.png`–`07-game-over.png`）优化狼人杀（`werewolf-judge`）在 `844 × 390 pt` 横屏安全区下的舞台表现层与交互结构：

1. **核心视觉与器物语言对齐**：
   - 在 `apps/nsh/plugins/werewolf-judge/ui/WerewolfIcons.tsx` 绘制统一的 `<Canvas>` 矢量线性图标集：8 种身份图标（`werewolf`、`white_wolf_king`、`seer`、`witch`、`hunter`、`guard`、`idiot`、`villager`）以及舞台交互图标（`privacy_shield`、`hold_hand`、`potion_bottle`、`waveform`、`check_circle`、`clock`、`wifi`、`replay`、`speaker_on`、`speaker_off`、`more_dots`、`arrow_left`、`arrow_right`、`chevron_right`、`avatar_silhouette`）。
   - 保持单实例 `<RobotFace />` 纯净平面暖米色自发光眼眸（收窄夜间表情过于刺眼的珊瑚红与闪电符号，统一为柔和半闭眼/弯月眼；白天保留细框眼镜 + 微笑；终局保留 `> <` 欢庆眼与彩屑）。
   - 全部舞台背景、面板、座位砖块、玫瑰红警告与选中态均通过 `apps/nsh/theme.json` 新增语义 Token（`stage-panel`、`stage-tile`、`stage-rose-bg`、`stage-rose-border`、`stage-rose-ink`）驱动，组件内零硬编码 Hex/RGBA。
2. **宿主壳层与插件配置页沿用现有布局**：
   - `ManagementShell`（左侧 `80pt` 导航轨）及 `PluginsSpaceView` / `PluginsContextBar`（顶部面包屑、图标、版本徽章、依赖就绪胶囊、启用开关）保持现有结构。
   - `WerewolfSettingsView`（`apps/nsh/plugins/werewolf-judge/ui/SettingsView.tsx`）沿用现有左右双卡片独立 `<Scroll>` 结构与全部现有规则/扫码配置项，仅引入身份线性图标、阵营人数摘要、单边框分隔行以及扁平化 `SwitchRow variant="flat"`。
   - `MorphableStage` 顶部右侧宿主安全主控栏（`exit-plugin-stage`、`voice-toggle`、`compose`、`connection-settings`）保持最高 `zIndex: 40` 不可遮挡不变量。

## 2. 模块边界与架构取舍

### 2.1 首屏顶栏单行化（`PluginStagePresentation.capsulePlacement`）
- **改造前痛点**：`MorphableStage` 顶栏左上角固定展示 `● 陪伴待机`（或播报期误显语音静音），下方 `y ≈ 62pt` 再悬浮一条 `StageCapsule`，两者信息重叠且占用 `390pt` 矮横屏约 `40pt` 垂直净空。
- **方案对比**：
  - 方案 A：保持胶囊始终悬浮于顶栏下方，由各插件自己压缩面板高度。会导致 9/12 人座位砖块与终局复盘第 5–6 号底牌无法完整首屏呈现。
  - 方案 B（采用）：在 `PluginStagePresentation` 增加可选 `capsulePlacement?: "below_top" | "top_bar"`（默认 `"below_top"`）。当插件指定 `"top_bar"` 时，`MorphableStage` 将 `<StageCapsule />` 直接放入顶栏左侧槽位，跳过 Layer 25 悬浮胶囊与额外垂直留白；现有未声明该字段的插件或探针（`StageProbe.tsx`）行为不变。

### 2.2 分屏左栏具身字幕与胜负槽位（`PluginUiModule.StageCompanion`）
- **改造前痛点**：播报期宿主底部 Layer 40 的 `ResponsePreview`（`subtitle-capsule`）在 `liveVoiceTranscriptActive()` 为真时绕过 `hideDefaultDock` 盖住插件底部操作按钮；同时 `split_left` 左栏表情正下方大片留白未利用，迫使右侧画布额外承担法官台词行或巨型横幅。
- **方案设计**：
  - 在 `PluginUiModule` 增加可选 `StageCompanion` 插槽（错误隔离边界沿用 `"StageCanvas"` 槽位标识符上报错情，保持 `looi-runtime` FFI 契约不变）。
  - `computeStageLayout` 在 `isSplitLeft && hasCompanion` 时将左栏 `<RobotFace />` 中心上移至纵向 `0.37` 处，并输出互不重叠的 `leftCompanion` 坐标供发牌提示、白天发言台词与终局胜负大标题使用。
  - `MorphableStage.showResponsePreview()` 在 `stage.presentation.active && (stage.presentation.hideDefaultDock || effectiveDrawerDetent() !== "closed")` 时一律返回 `false`，保证底部操作区不被宿主字幕浮层遮挡。

### 2.3 全舞台面板化与低频动作收纳
- 建房大厅、本机夜间行动、白天发言、放逐公投、警上报名及离场技能统一挂载于 `StageCanvas` 哑光面板（`floating_top` + `chrome: "frameless"` 居中微缩眼眸或 `split_left`）；`lan_companion` 夜间闭眼等待维持 `facePosture: { kind: "full" }, drawerDetent: "peek"`。
- 狼人自爆、已绑定副屏座位解绑、刷新地址、提前结算、终止本局与退出狼人杀统一收入顶栏 `[⋯]` 原生 `<Menu>`，破坏性动作经原生 `AlertDialog.show` 二次确认；狼人自爆选座使用紧凑 `<Dialog>`，去除底部常驻 `38pt` 退出条。

## 3. 空间预算（`844 × 390 pt` 横屏 · 安全区 `left=59, right=59, bottom=21`）

- 顶栏高度：`STAGE_TOP_BAR_HEIGHT = 56pt`（左 `StageCapsule`、中可选无边框 `floating_top` 微缩表情、右宿主安全按钮组）。
- `StageCanvas` 有效工作区（`top_bar` + `drawerDetent: "closed"`）：`top = 60pt`，`bottom = 29pt`，净高约 **`301pt`**，足够单屏容纳：
  - `02-lobby`：左右 56% / 44% 双面板，6–12 人单行预设 + 滑块模式切换 + 扫码入座网格 + 主 CTA；
  - `03-dealing`：1–12 进度节点 + 72pt 头像环 + 防窥盾/身份卡 + 底部 2–3 键操作栏；
  - `04-night`：3×3 选座网格（`min-h-11` 44pt 触控高度）+ 右侧目标摘要 + 唯一主提交按钮；
  - `05-day-discussion`：单行发言人 + 环形计时器 + 3×2/3×3/4×3 座位砖块 + 底部 3 键操作栏；
  - `06-voting`：60%/40% 暗票状态砖块 + 大字进度统计 + 状态按钮；
  - `07-game-over`：滑动 Tab + 3×2 全员底牌 + LOOI 复盘条 + 底部双按钮完整首屏呈现。

## 4. 验证矩阵

1. `pnpm --filter @super-looi/nsh typecheck`
2. `pnpm --filter @super-looi/nsh build`
3. `pnpm --filter @super-looi/nsh test:werewolf`
4. `pnpm --filter @super-looi/nsh exec node --import tsx scripts/nsh.ts test`（覆盖 `app_ui`、`MorphableStage.test.tsx`、`WerewolfStage.test.tsx` 的 light/dark 与 `reducedMotion` 变体）
5. `xcrun devicectl list devices` / `adb devices -l` 检查真机连接状态（无真机连接时登记 `todo.md`）
6. 只读 `research` 子 Agent 独立审查
