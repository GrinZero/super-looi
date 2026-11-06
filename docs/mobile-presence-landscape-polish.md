# Mobile Presence v3.0 横屏精修

日期：2026-11-04。目标：iPhone 16e iOS Simulator，844×390pt，按 `ref-firstscreen.png` 与 `ref-memories.png` 精修 `apps/mobile`。本轮不提交 commit，不改 Expo prebuild 产物；并行 Hub 变更不属于本轮范围。

## 实现

- 首屏使用透明径向地平线渐变，移除可能形成菱形/矩形边界的圆角实体辉光；覆盖层打开时移除角落状态/Lab 入口。
- 微笑改为裁切圆弧，眼球使用指定径向渐变与柔化蓝边。短横屏抽屉模式保持 `translateY: -86`、`scale * 0.56`。
- QuickDrawer 使用 98pt 空间卡、紧凑横向图标/文案、单行标题区与工具行。短屏面板下移 8pt，仍保留原安全区内 4pt 底部间距，给微笑留出空隙。
- 共形 Shell 实际源码的 `main` 对应请求中的 `shell`：10/12pt 内边距、12pt 间距、68pt 标题区、23/28pt 标题、单行 12/16pt 副标题和 0.86 倍头像。窄屏标题保留头像避让区。
- 记忆搜索与四个筛选项同排；时间与日期合并。76pt 原生插画与物品/位置引用/标签并排，选中卡旁直接呈现三个纠错动作。纠错编辑器在右侧顶部展开并自动滚回顶部。证据图在短横屏为 52pt，为四维信息留足空间；示意图免责声明与位置图例分开显示。
- 家居移除重复标题段，改用诚实反映在线状态的演示状态栏和重置入口。短横屏 2×2 卡片保留开关、亮度滑轨/五档、三档色温与传感器读数；紧凑控件只在短屏常规字号启用。
- 维修移除重复标题，以实际视口而非扣除侧栏后的内层宽度判定短横屏。三路连接同排，双脑与热阶梯/OLED 雷达同排；策略明细、演练按钮及验收矩阵顺序保留在其后。
- 任务短横屏分为任务、单次审批、日常约定三列。审批仍明确读取/写入范围、完整命令、覆盖分支历史风险及单次边界；完整技术凭据继续可滚动查看。

支持组件仅增加紧凑布局参数；控制回调、离线待核实、取消回执与本地演示边界保留。非短横屏和大字号继续使用可滚动布局。

## 自动检查

在最后一次源码修改后运行，均退出码 0：

- `pnpm --filter @super-looi/mobile typecheck`
- `pnpm --filter @super-looi/mobile test`：16 suites / 61 tests，全通过，0 fail / skipped。
- `pnpm --filter @super-looi/mobile build`：TypeScript 构建，非原生二进制编译。

`git diff --check` 限定 mobile 与本轮文档范围。检查日志保留在 `/tmp/mobile-polish-{typecheck,test,build}.log`。

## 原生截图与交互

证据目录：[`docs/artifacts/phase7/landscape-polish/`](artifacts/phase7/landscape-polish/)。由单独的原生验证 agent 独占 Simulator 检查。

- [`ios-firstscreen.png`](artifacts/phase7/landscape-polish/ios-firstscreen.png)：圆弧微笑与柔化眼球、底边辉光。
- [`ios-quickdrawer.png`](artifacts/phase7/landscape-polish/ios-quickdrawer.png)：完整缩小双眼/微笑位于面板上方，四张空间卡与两个工具入口可见，顶部状态入口已隐藏。
- [`ios-lab.png`](artifacts/phase7/landscape-polish/ios-lab.png)：顶部状态入口隐藏；Lab 内容保持滚动。
- [`ios-memories.png`](artifacts/phase7/landscape-polish/ios-memories.png)：首条插画、引用、标签与三个动作完整可见；右侧证据图与四维信息位于首屏。
- [`ios-home.png`](artifacts/phase7/landscape-polish/ios-home.png)：2×2 设备卡与控制完整可见；已点击验证 20% 亮度、3000K、开关与重置。
- [`ios-cabin.png`](artifacts/phase7/landscape-polish/ios-cabin.png)：三路连接与双脑/热阶梯/OLED 雷达完整可见。
- [`ios-tasks.png`](artifacts/phase7/landscape-polish/ios-tasks.png)：首条任务、完整审批盾牌、两个约定与操作完整可见。

记忆「不是这里」已核验能立即显示位置编辑器。完整取消三态与所有次级交互未在本轮重新逐项点击；原有自动化覆盖已通过。竖屏、大字号和长期运行不属于本次 844×390pt 原生验收范围，既有 Phase 7.4 待办继续独立跟踪。

## 独立审查

审查中发现并修复记忆纠错编辑器藏在远端滚动区下方、400–719pt 标题缺少头像避让、紧凑证据图免责声明与图例重叠。最终复核无新的可行动问题；短屏面板 8pt 下移也已复核安全区与滚动行为。
