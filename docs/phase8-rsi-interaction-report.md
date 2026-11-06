# Phase 8: RSI 循环 UI 交互深度审阅与人体工学收敛报告

## 1. 目标与 RSI 循环方法论

本阶段聚焦 **UI 交互质量与触控人体工学**（而非单纯配色与静态视觉），围绕四大核心交互维度建立 **RSI (Recursive Self-Improvement)** 闭环（`独立交互审计 → 方案收敛 → Codex 并行落地 → iOS 模拟器 & Playwright 多视口实测 → 独立子代理复审打分`）：

1. **信息有效区占比与首屏可操作性 (Effective Information Viewport Ratio)**：底座短横屏（`844×390pt/px`）、手机竖屏（`390×844` / `393×852`）与桌面端（`1280×800`）交互内容有效区占比目标 `>= 72%`，核心决策按钮首屏可见（Above-the-Fold）。
2. **滑动、拖拽与手势物理 (Scrolling, Swiping & Gesture Physics)**：水平滑块拖拽与纵向 `ScrollView` 零冲突、`<100ms` 紧急停止按钮免疫舞台上滑抢占、底部抽屉跟手下滑收起、竖屏消除上下双 `ScrollView` 抢滚动、键盘弹出防吞点击与避让。
3. **点击热区与 Fitts 定律防误触 (Hit Targets & Safe Area)**：全端可交互控件有效触控框 `>= 44×44pt/px`，严格避让 iOS 底部 `21pt` Home Indicator 系统上滑区，高危/删除按钮物理分组隔离。
4. **布局稳定性与即时反馈闭环 (`CLS = 0` & Feedback Loop)**：内页轻提示脱离文档流（`CLS = 0`），拨动开关具备 `pending` 待回读脉冲态，滑块拖拽防轮询回跳，空闲态消除 `10Hz` 无效重绘，满足 React 19 渲染纯度。

---

## 2. 四轮演进量化总览 (`Round 0 → Round 1 → Round 2 → Round 3`)

| 交互审计维度 | Round 0 基线 | Round 1 | Round 2 | **Round 3 (终态)** | 累计提升 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **1. 信息有效区占比与首屏折叠率** | `48` | `73` | `94` | **`97 / 100`** | `+49` |
| **2. 滑动、拖拽与手势物理** | `52` | `76` | `94` | **`97 / 100`** | `+45` |
| **3. 点击热区、防误触与安全区** | `56` | `78` | `96` | **`98 / 100`** | `+42` |
| **4. 布局稳定性 (`CLS=0`) 与反馈闭环** | `54` | `79` | `95` | **`98 / 100`** | `+44` |
| **综合交互评分 (Composite Score)** | **`52.5`** | **`76.5`** | **`94.8`** | **`97.5 / 100`** | **`+45.0`** |
| **残余缺陷统计 (`P0 / P1 / P2`)** | `5 / 4 / 3` | `3 / 5 / 3` | `0 / 0 / 4` | **`0 / 0 / 0`** | **全清零** |

---

## 3. 各轮关键病灶根治记录

### 3.1 RSI Round 1 (`52.5 → 76.5`)：底层手势解耦、热区恢复与零跳动架构
- **浮层轻提示零布局偏移 (`CLS = 0`)**：重构 [`ConformalDeviceShell.tsx`](../../apps/mobile/src/ui/components/ConformalDeviceShell.tsx) 内页 `LightToastCapsule` 为绝对定位浮层（`pointerEvents="none"`），根除原先每次触发轻提示导致的 `72–93pt` 全页上下跳动。
- **首屏 `<100ms` 急停触控免疫与上滑唤醒修复**：修复 [`app/index.tsx`](../../apps/mobile/app/index.tsx) 中舞台 `PanResponder` 在运动态抢夺紧急停止按钮手势的安全隐患，消除 `-22..-35pt` 上滑死区，并在视线收敛后门控 `100ms` 空闲定时器，消除后台无效重绘。
- **水平亮度滑块与纵向滚动物理隔离**：新增 [`brightness-gesture.ts`](../../apps/mobile/src/ui/brightness-gesture.ts) 与重构 [`BrightnessSliderBar.tsx`](../../apps/mobile/src/ui/components/BrightnessSliderBar.tsx)，区分水平拖拽（锁定父级 `ScrollView` 实时控光）与纵向滑动（立即放行滚动且绝不误改亮度），并在 Web 端 [`console-html.ts`](../../apps/hub/src/console-html.ts) 加入 `draggingSlider` 轮询保护。
- **底部抽屉跟手下滑收起与延时调优**：双端 [`QuickDrawerModal.tsx`](../../apps/mobile/src/ui/components/QuickDrawerModal.tsx) 与 Web `#sheet` 接入跟手下滑关闭手势、常驻顶部抓手条，自动收起时间从仓促的 `4.5s` 延长至 `7.5s`（且 `SimLab` 不自动误关）。
- **竖屏消除双 `ScrollView` 钥匙孔嵌套**：Mobile [`MemoriesSpaceView.tsx`](../../apps/mobile/src/ui/spaces/MemoriesSpaceView.tsx)、[`TasksSpaceView.tsx`](../../apps/mobile/src/ui/spaces/TasksSpaceView.tsx) 与 Web `<=720px` 窄屏统一改为顶部 `>=44pt` 分段页签 + 单流全高顺滑滚动。

### 3.2 RSI Round 2 (`76.5 → 94.8`)：二阶跨页锁死修复与 `844×390` 短横屏首屏倍增
- **修复 Web `#correctionForm` 跨空间渲染冻结 (`[R2-P0-1]`)**：在 [`console-html.ts`](../../apps/hub/src/console-html.ts) 的 `renderSpaces()` 中将表单编辑守卫严格限定于当前激活空间，`switchSpace()` 切页时自动重置 `#correctionForm.hidden = true`，并补齐 `>=44px` `"取消"` 按钮。
- **修复 Web `844×390` 左轨溢出 `120px` 与抽屉工具行裁切 (`[R2-P0-2 / P0-3]`)**：短横屏下左轨 `.rail` 收敛为 `318px <= 390px`（6 个入口全部 `>=44×44px` 且 100% 露出）；`#sheet` 高度放宽至 `min(82dvh, 332px)`；`.space-header` 压缩至 `52px`，使短横屏工作区有效视口占比跃升至 **`84.6%`**，回忆检视三按钮、高危审批双按钮与家居主控全部首屏可见。
- **Mobile `844×390pt` 书房家居四卡同屏 (`[R2-P1-1]`)**：[`BrightnessSliderBar.tsx`](../../apps/mobile/src/ui/components/BrightnessSliderBar.tsx) 紧凑态将滑轨与百分比同行排布，[`HomeSpaceView.tsx`](../../apps/mobile/src/ui/spaces/HomeSpaceView.tsx) 在保持全部档位与预设 `>=44pt` 有效热区前提下压缩卡片纵向占用，实现首屏同时完整呈现吸顶灯、台灯、新风与环境传感器（`23.8°C / 48% / 612ppm`）四张卡片。
- **iOS Home Indicator 安全区、导航锚点方向与深链直达 (`[R2-P1-2..5]`)**：左轨与四大空间 `ScrollView` 补齐 `insets.bottom` 安全垫高；修正左轨激活青色锚点朝向右侧工作区接缝；修复 Web `.mini` 头盔 `transform: scale` 等比缩放；双端存在 `awaiting_approval` 时窄屏/竖屏首次进入自动聚焦审批页签；[`app/index.tsx`](../../apps/mobile/app/index.tsx) 接入 `useLocalSearchParams` 原生深链导航并消除渲染期写 `ref.current`。

### 3.3 RSI Round 3 (`94.8 → 97.5`)：四项 `P2` 微雕清零
- **Web 窄屏 (`390×844`) 证据检视首屏收敛 (`[P2-1]`)**：`#memoryInspector .evidence-grid` 在窄屏保持紧凑双列排布，使 `不是这里 / 已经拿走了 / 忘掉这条` 三枚 `>=44px` 按钮底边收束于 `y = 664.6px`（完整位于底部导航栏上方）。
- **Web 异步轮询防抢滚动 (`[P2-2]`)**：`setMobileTaskPane(pane, reveal = false)` 仅在用户显式点击页签时平滑滚动定位，后台轮询自动聚焦待审批页签时不打断当前阅读位置。
- **Mobile 记忆内联位置编辑显式取消 (`[P2-3]`)**：[`MemoriesSpaceView.tsx`](../../apps/mobile/src/ui/spaces/MemoriesSpaceView.tsx) 在展开内联位置编辑时将主按钮文案切换为 `"取消修改"`，并在输入框旁提供显式 `44pt` `"取消"` 按钮。
- **Mobile 短横屏快捷抽屉微笑弧呼吸间距 (`[P2-4]`)**：[`RobotFaceView.tsx`](../../apps/mobile/src/ui/components/RobotFaceView.tsx) 在短横屏抽屉展开时上移大脸舞台（`-98pt`），使青色微笑弧完整悬浮于毛玻璃抽屉顶沿之上。

---

## 4. 自动化测试与双端实测证据矩阵

- **全工作区门禁**：`pnpm typecheck`、`pnpm test`（4 包共 **182** 项测试全绿通过：`contracts` 5、`looi-driver` 11、`hub` 68、`mobile` 98）、`pnpm build`、`git diff --check` 全部零错误通过。
- **Playwright 多视口实测审计**：覆盖 `844×390`、`390×844`、`1280×800` 共 14 个页面状态、**225** 个可见交互控件，检测 **`<44px` 热区违规 = 0**、**固定容器裁切违规 = 0**、**`#correctionForm` 跨空间切换恢复 = PASS**。
- **双端实测截图归档**：
  - Round 1 采样（15 张）：[docs/artifacts/phase7/rsi-round1/](artifacts/phase7/rsi-round1/)
  - Round 2/3 收敛终态（21 张，含 7 张 iOS 模拟器 `844×390pt @3x` 原生横屏截图 + 14 张 Web 多视口截图）：[docs/artifacts/phase7/rsi-round2/](artifacts/phase7/rsi-round2/)
