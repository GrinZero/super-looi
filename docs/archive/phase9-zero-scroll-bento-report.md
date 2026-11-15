# Phase 9 · Zero-Scroll Bento Cockpit v4.0

2026-11-04，范围为 `@super-looi/mobile`。四个空间、快捷抽屉与 SimLab 已完成；未修改 Expo prebuild 产物。Hub Web 控制台同步留作后续独立任务。

## 交付

- 外壳移除顶部标题栏与右上装饰头像，活头像进入导航轨，点击返回全屏大脸；离座提示与 Toast 为浮层。短横屏导航轨宽 80pt，为 iPhone 两侧安全区内的工作区留出 646pt。
- 抽屉四入口同排，只显示图标、标题和实时状态；底部工具同排。SimLab 为紧凑 3×2 网格。
- 回忆册四条双行记录同屏，证据检视包含三按钮、84pt 定位图、版本凭据与四格事实；纠错、撤回、遗忘及原图过期语义保留。
- 任务以两列四卡展示任务、独立已核验产物、单次审批和日常约定；保留取消中、停止未确认、已确认退出凭据及重置流程。
- 家居顶栏整合四快捷动作，反馈与规则确认置于顶部，四设备卡同屏。紧凑亮度滑轨与五档共一行，五档均为 44×44pt。
- 维修舱连接与演练同排，三栏展示双脑、长稳与验收。四守护指标、四门禁均为 2×2，A–H 八组为两列四行；保留紧凑演示标记与实际 Hub 报告来源。

## 验证

最终源码完成后统一运行，全部退出码 0：

| 检查 | 结果 |
| --- | --- |
| `pnpm --filter @super-looi/mobile typecheck` | 通过 |
| `pnpm --filter @super-looi/mobile test` | 22 suites / 119 tests，0 fail / skipped |
| `pnpm --filter @super-looi/mobile build` | TypeScript 构建通过 |
| `git diff --check` | 通过 |

日志位于 [checks/](artifacts/phase9/checks/)。独立 review 的变更范围 React Doctor 检查无新增问题；最终修复后主 Agent 再运行 `pnpm dlx react-doctor@latest apps/mobile --verbose --scope changed --base 4beca59`，扫描 15 个变更文件，退出 0，输出 `No issues found`。详细审查见 [独立审查](phase9-independent-review.md)。RSI 测试包含生产交互处理器执行与触区、响应式尺寸回归。

## 原生验收

iPhone 16e、iOS 26.3，横屏 844×390pt，普通字号，现有原生 Debug 包与 Metro。四空间默认态、抽屉、SimLab 均未手动纵向滚动即可完整显示主要内容与操作。

| 状态 | 原生截图 |
| --- | --- |
| 四入口抽屉 / SimLab | [抽屉](artifacts/phase9/ios-quickdrawer.png) · [SimLab](artifacts/phase9/ios-simlab.png) |
| 四条记忆 / 位置编辑 / 修正后 | [默认](artifacts/phase9/ios-memories.png) · [键盘编辑](artifacts/phase9/ios-memory-editor-keyboard.png) · [v2 修正](artifacts/phase9/ios-memory-corrected.png) |
| 任务四卡 / 取消三态 | [默认](artifacts/phase9/ios-tasks.png) · [取消中](artifacts/phase9/ios-tasks-cancelling.png) · [未确认](artifacts/phase9/ios-tasks-unknown.png) · [已确认](artifacts/phase9/ios-tasks-cancelled.png) |
| 家居四卡 / 规则提案 / 冲突 | [默认](artifacts/phase9/ios-home.png) · [提案](artifacts/phase9/ios-home-proposal.png) · [冲突](artifacts/phase9/ios-home-conflict.png) |
| 维修舱默认 / Hub 回执 / 用例详情 | [默认](artifacts/phase9/ios-cabin.png) · [48/48 回执](artifacts/phase9/ios-cabin-acceptance.png) · [详情](artifacts/phase9/ios-cabin-case-detail.png) |

点击验证包括记忆位置确认/取消，任务未知后重新请求取消验证及退出回执，第二条约定暂停/恢复，家居提案显式确认，HA 独立断连、BLE 重连零动作重放与实际运行 48 项验收。Hub 返回 48/48、96/96 分，四门禁均为 0。键盘编辑保证关键编辑动作可见；展开完整验收矩阵与键盘覆盖后的详情保留滚动，不作为默认首屏零滚动状态。原生验证细节见 [验证记录](artifacts/phase9/README.md)。

## 本轮发现与修复

原生检查发现维修舱百分比 `flexBasis` 子单元实际排成超宽单列，门禁值裁切且 G/H 组落出首屏；当时的静态两列预算未能发现该问题。[修复前截图](artifacts/phase9/ios-cabin-before-grid-fix.png) 已保留。已将三类网格改为基于所属面板宽度计算的数值宽度，禁用 flex 增长和收缩，并覆盖 320、390、519、520、639、640、646、732pt 八个宽度断点。最终原生默认及报告态均确认两列网格与八组完整可见。

独立审查另发现删除长段说明后模拟链路边界不够明确，已以「演示 · 状态」和「演示策略」紧凑标签修复。最终结论与证据范围见独立审查记录。

---

## Phase 10 · Zero-Codex Craft v4.1（主 Agent 亲自操刀视觉与比例重塑）

针对 Phase 9 初版由 Codex 生成的 UI 存在机械线框感与多处视觉缺陷，主 Agent 亲自接管并完成了全量视觉、排版比例与双端一致性重塑：

1. **驾驶舱侧栏与抽屉光学精修 (`ConformalDeviceShell.tsx`, `QuickDrawerModal.tsx`, `RobotFaceView.tsx`)**：
   - 为左轨顶部迷你 LOOI 活性头像新增深空玻璃底座舱 (`brandAvatar`)、呼吸在线绿点与 `LOOI` 微标；移除底部孤立灰线；导航项升级为三段流光渐变与内发光边框。
   - 修复 `QuickDrawerModal` 与 `SimLabSheet` 图标溢出 Bug（`shortIconTile` 从 `24×28pt` 扩容为 `38×38pt` 圆角玻璃底座，搭配 `20pt` 图标），消除 `书房家居` 卡片内 `演示网关已连接` 截断，并将抽屉打开时大脸微移至 `-106pt`，使微笑弧与抽屉顶边保持清朗呼吸间距。
2. **书房家居双行流光滑轨与 2×2 对称 Bento (`BrightnessSliderBar.tsx`, `HomeSpaceView.tsx`)**：
   - 彻底修复 `BrightnessSliderBar` 在紧凑态下将滑轨与 5 个档位按钮挤在同一行导致滑轨仅剩 `~60pt` 的缺陷：采用「首行全宽流光滑轨 + 右对齐百分比读数，次行 5 枚紧凑档位胶囊（带 `hitSlop` 保障 `>=44pt` 触控热区）」的双行精密布局。
   - 为 `书房台灯` 补齐底部色温/照度遥测条（与左卡色温行等高对称），并将 `书房新风` 与 `环境传感器` 升级为带流光风道与三联玻璃仪表的均衡卡片，彻底消除屏幕底部黑洞。
3. **回忆册与约定任务黄金比例重塑 (`MemoriesSpaceView.tsx`, `TasksSpaceView.tsx`)**：
   - `MemoriesSpaceView`：重排右侧检视舱视觉层级为「标题与版本徽标 -> 84pt 桌面空间定位图 -> 2×2 玻璃事实格 -> 底部三枚精修操作按钮」，并使左右两栏在 `844×390pt` 下顶底完全平齐。
   - `TasksSpaceView`：消除左短右长导致的左下角大片黑洞；左右两栏四张 Bento 卡（`楼梯碰撞修复`、`已核验产物`、`高危作用域审批`、`我们的日常约定`）顶底严丝合缝对齐；升级琥珀金渐变授权主按钮与终端代码块质感。
4. **维修舱顶栏对齐与三栏等高仪表盘 (`CabinSpaceView.tsx`) + Hub Web 同步 (`apps/hub/src/console-html.ts`)**：
   - 顶栏 3 枚连接胶囊与 2 枚演练胶囊统一 `46pt` 高度与 `14pt` 圆角，根治 `Home Assistant` 与 `HA 断连模拟` 断词折行。
   - 下方三栏（`双脑引擎热切换`、`长稳守护器`、`48 项核心验收`）实现 `alignItems: "stretch"` 等高对齐，消除 `Nominal` 与 `OLED` 坐标折行，并同步升级 `apps/hub/src/console-html.ts` 至 v4.1 视觉规范。
