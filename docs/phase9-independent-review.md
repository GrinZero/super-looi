**Phase 9 独立审查 · 2026-11-04**

比较基线为 `4beca5954afa49fba2fd8a9b1026fca7d329a587`。审查范围包括 Phase 9 的 shell、快捷抽屉、四个空间、共用亮度控件及相关测试；最终复核包含 `759ab02` 之后的 Cabin 数值单元格宽度修复。审查者仅修改本报告，没有实现业务代码或提交代码。

结论：最终复核未发现仍需修复的 P1/P2 问题，也没有其他已证实的待修缺陷。对照根 `AGENTS.md`，实现没有直接修改 Expo prebuild 产物，使用 pnpm 执行检查。

审查中确认并关闭了两项问题：

- **P1 · Cabin 默认汇总超宽、需要滚动。** 原生验证发现，独立审查查看[修复前截图](artifacts/phase9/ios-cabin-before-grid-fix.png)后确认：844×390 横屏下，原百分比 `flexBasis` 配合 `flexGrow` 的布局实际显示为单列，四项策略占四行、Hard Gate 数值越出右边界、A–H 仅 A–F 首屏可见。原预算测试直接假设两列，无法证明真实布局。最终 [CabinSpaceView.tsx](../apps/mobile/src/ui/spaces/CabinSpaceView.tsx#L79) 按所属 panel 的实宽扣除 padding、border 和 gap，分别计算 policy、gate、group 的数值宽度，并关闭这些单元格的伸缩。[回归测试](../apps/mobile/test/rsi-cabin-interactions.test.ts) 覆盖 320、390、519、520、639、640、646、732pt 实宽。独立查看修后[默认待验证态](artifacts/phase9/ios-cabin.png)及[原生验收态截图](artifacts/phase9/ios-cabin-acceptance.png)，确认两种状态下策略 2×2、Hard Gate 2×2 且四个数值完整、A–H 2×4 均在首屏；无报告时显示待验证，报告返回后显示 48/48，问题关闭。
- **P2 · 删除说明后模拟链路与真实连接边界不清。** 初稿将本地 controller 状态直接显示为“已连接”，删除原说明段落后没有可见演示标记。最终 [连接卡](../apps/mobile/src/ui/spaces/CabinSpaceView.tsx#L124) 保留“演示 · 状态”，双脑面板保留“演示策略”，Hub 验收区域仍由真实报告驱动。代码、测试及修后截图均已复核，问题关闭。

具体核查结果：

| 范围 | 代码与交互核查 | 实际查看的原生证据 |
| --- | --- | --- |
| Shell / Drawer | 顶栏和装饰头像已移除；live avatar 位于 rail 返回按钮；freshness 与 toast 脱离布局流；抽屉描述可选；原手势仲裁、关闭与 idle guard 保留 | [四卡单排与工具行](artifacts/phase9/ios-quickdrawer.png)、[LAB 3×2](artifacts/phase9/ios-simlab.png) |
| Memories | 四条两行卡；不渲染 MemorySceneArtwork；三纠错动作同行；保留过期/撤回标记；位置修改、撤回和删除沿用 controller，并增加生产 handler 回归 | [默认首屏](artifacts/phase9/ios-memories.png)、[键盘上方编辑/确认/取消](artifacts/phase9/ios-memory-editor-keyboard.png)、[改后版号与标注](artifacts/phase9/ios-memory-corrected.png) |
| Tasks | 四卡布局；单次批准进入 running 而不制造产物；取消请求等待退出证据；断连保持 unknown；确认后才展示退出凭据；约定增删、暂停/恢复覆盖生产 handler | [初始四卡](artifacts/phase9/ios-tasks.png)、[取消中](artifacts/phase9/ios-tasks-cancelling.png)、[待核实](artifacts/phase9/ios-tasks-unknown.png)、[确认退出](artifacts/phase9/ios-tasks-cancelled.png) |
| Home | slider 手势实现保留；五档 preset 改为物理 44×44；36pt 顶部与色温操作保留 slop 且父行预留 44pt；pending/offline 不宣称回读；反馈置顶，提案需显式确认 | [四卡](artifacts/phase9/ios-home.png)、[提案两按钮与四卡](artifacts/phase9/ios-home-proposal.png)、[冲突反馈](artifacts/phase9/ios-home-conflict.png) |
| Cabin | 依据测量后 646pt 工作区进入三列；连接与演练同顶行；默认八组汇总；展开 48 case 和详情可滚动；HA 独立切换、BLE 零重放、provider/thermal/OLED、真实报告和详情滚动均有行为测试 | [修后默认首屏](artifacts/phase9/ios-cabin.png)、[验收结果](artifacts/phase9/ios-cabin-acceptance.png)、[展开后的 A01 详情及收起按钮](artifacts/phase9/ios-cabin-case-detail.png) |

测试变更保留 portrait 分页、键盘、手势、反馈定位、审批与取消边界，增加状态和生产 handler 执行断言。Cabin 使用组件执行 harness 校验 props、事件与嵌套布局偏移；尺寸断言用于防止尺寸规则回退，最终首屏结论同时依据原生截图。

最终数值宽度修复后，主 agent 统一重跑并报告以下检查全部 exit 0：

- `pnpm --filter @super-looi/mobile typecheck`
- `pnpm --filter @super-looi/mobile test`：22 suites，119 tests，0 failed，0 skipped。
- `pnpm --filter @super-looi/mobile build`
- `git diff --check`

审查者另执行过 `pnpm dlx react-doctor@latest apps/mobile --verbose --scope changed --base 4beca59`，当时变更范围扫描 exit 0、无新增诊断；该补充扫描发生在最终 Cabin 宽度修复前，不替代上述最终检查。首次未钉基线的广范围扫描报出的 `index.tsx` effect cleanup 问题已核对为基线既存误报：原实现已清理 timers、subscription、scene work 和 abort controller。

视觉证据适用于本轮记录的 iOS 844×390、默认字号及截图对应状态。审查者查看了验证代理产出的截图，没有独立操作模拟器。键盘打开、矩阵展开、详情、增添更多数据或放大字体时保留滚动；这些状态不计入默认 cockpit 首屏零滚的结论。
