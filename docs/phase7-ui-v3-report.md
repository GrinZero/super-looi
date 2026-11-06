# Presence v3.0 UI 交付与验收报告

## Step 7.3：共形外壳与四大空间（2026-11-04）

本轮为 `@super-looi/mobile` 实现 Presence v3.0 共形 Shell 与记忆、任务、家居、维修四空间。按用户指定使用 88pt 轨道、20/40/60/80/100% 五档亮度，沿用 RN 0.85.3 的 `experimental_backgroundImage` / `boxShadow` 与 Ionicons；没有新增 RNSVG 或直接修改 Expo prebuild 产物。

### 交付内容

- **共形 Shell**：猫耳品牌标与 LOOI 字样、无框非激活入口、青色发光 squircle 与连线节点、9 柱标题声波、点阵/径向光晕头像背景。独立轻提示区域避免覆盖标题和内容；短横屏 rail 已修复底部入口遮挡，avatar 视线平滑跟随选中卡片。
- **记忆空间**：发光时间轴与键盘/钥匙、显示器/AirPods、书架/杯子、抽屉/线缆四种 16:9 原生场景插画；5 柱声波、中文来源、短时间与认识论徽章。证据图靶心与高亮区共用动态场景坐标，四维信息中文化，凭据 ID/版本仅留弱化页脚。内联位置修正、拿走与遗忘回调保留；已撤回事实不继续显示当前位置靶心，无选中事实时释放头像焦点。
- **任务空间**：工作区、摘要、产物与约定调用 humanize helpers；审批面板使用琥珀/珊瑚盾牌、四类作用域信息与批准/拒绝按钮；取消三态明确区分请求中、进程退出已核验与失联待核实，不假报成功。
- **家居空间**：三个设备采用受真实快照控制的发光开关；吸顶灯/台灯支持滑轨点击、拖动释放提交与五档即时设置，亮度同时显示百分比与 255 数值。吸顶灯三档色温有独立冷暖色点与选中态。温湿度/CO₂ 大字号仪表保留来源与演示边界，未将 UI 演示样本声称为实时物理读数。
- **维修舱**：BLE/Hub/HA 独立状态点、验真时间与响应式拓扑；OLED 十字雷达呈现真实 `[-6,+6]px` 位移，四阶热状态槽；四安全盾牌、A–H 进度条和默认折叠的 48 项明细。未运行报告显示待验证，不预填全通过。

### 前置组件与共享改动

继承并完整保留前置 7.1/7.2 的 `humanize.ts`、对应测试、`LooiIcon` / `LooiBrandMark`、`RobotFaceView` 与 `src/index.ts` 导出。7.3 增补 5 柱 `LooiWaveOrnament`、avatar 视线平滑、任务与规则转译回归，以及记忆场景和纠错集成测试。前置首屏、抽屉、Metro 和 TypeScript 配置另由前置批次维护，交付见 [mobile foundation 报告](phase7-mobile-foundation-report.md)。本报告不替代该批次验收。

### 自动化与独立审查

最终集成检查由主 agent 在完整实现及记忆修复落地后执行：

| 检查 | 结果 |
| --- | --- |
| `pnpm --filter @super-looi/mobile typecheck` | 退出 0 |
| `pnpm --filter @super-looi/mobile test` | 16 suites / 61 tests，61 pass、0 fail、0 skipped，退出 0 |
| `pnpm --filter @super-looi/mobile build` | 退出 0；TypeScript 构建，不是原生 iOS 编译 |
| `git diff --check` | 通过 |
| 独立代码 review | 无未解决 P1/P2 |

独立 review 曾发现自定义编辑位置后高亮区仍使用旧区域坐标的 P2 问题。修复后 activeZone 与 target 统一读取 `resolveMemorySceneTarget`，位置文案保留真实编辑内容；review 已复核。新增记忆回归覆盖四类场景、显式位置优先、空编辑保护、修订/失效证据保留、撤回及遗忘后头像焦点释放。

React Doctor 首轮结果为 65/100、26 warnings、0 errors；最终补扫使用 `pnpm dlx react-doctor@latest apps/mobile --verbose --scope changed --include-untracked --no-score --output-dir /tmp/super-looi-phase7-review-react-doctor`，覆盖 42 个文件，30 warnings、0 errors，退出 0。独立审查确认没有新增功能缺陷；警告涉及组件结构、静态装饰 key、ref 分配与 scope glob 误报，未扩大本轮范围调整。该工具的 warning 不等于 typecheck 或测试失败。

### 原生验收与尚未覆盖边界

本轮补充 native smoke 使用 iPhone 16e / iOS 26.3（Simulator UUID `F90B8A44-A2D2-4FF6-90FF-C55E887A3305`），实际应用为 844×390pt 横屏。`simctl` 保存的是 1170×2532px 原始 framebuffer，查看时顺时针旋转 90°；四图均在进入对应空间后截图并经 `view_image` 审查。

| 画面 | 已确认内容 |
| --- | --- |
| [记忆空间](artifacts/phase7/step7-3/ios-memories.png) | 时间轴、场景插画顶部、中文证据检视器；截图含 Metro refreshing 蓝条，后续稳定 CUA 画面确认已消失 |
| [任务空间](artifacts/phase7/step7-3/ios-tasks.png) | 琥珀作用域审批面板及中文任务信息正常首屏渲染 |
| [家居空间](artifacts/phase7/step7-3/ios-home.png) | 设备控制首屏正常；实际点击吸顶灯 ON→OFF 后显示「已关闭」「演示已回读」，无障碍值为 0 |
| [维修舱](artifacts/phase7/step7-3/ios-cabin.png) | 三路连接及断连状态首屏正常渲染 |

Shell 四个导航入口在短横屏上直接可见，品牌标、标题声波、头盔及原生渐变没有 RedBox。此轮未确认代码层阻断。另一并行模拟器任务抢占后，CUA native pipe 连续关闭，原生审查停止深入交互；未完成的 UI 项包括亮度拖动/五档按钮/色温、任务取消三态、记忆三类纠错、维修舱矩阵展开，以及竖屏/窄屏和 Web 验收。代码审查与自动化覆盖不代表这些 UI 点击已实测。

Step 7.3 的实现、指定三命令与独立审查已完成；上述 smoke 是额外证据。Hub Web v3 与完整双端逐屏验收继续属于 Step 7.4。本轮不宣称全部交互、逐像素视觉或双端硬件验收通过；家居硬件回读、真实 BLE 与远端执行不能由 UI 演示和单元测试替代。

### 阶段提交

- `fb34a2f`：7.3 规划与待办拆分。
- `6fcdec4`：家居触控控件、维修舱看板及实施进度。
- `99bcc10`：共形 Shell、记忆/任务空间、前置共享组件与回归测试。

四张 `step7-3` 截图由并行前置批次提交 `819fa8b` 收录；本轮仅引用并补充实测范围，不将该提交归为本轮执行。


---

## Step 7.4：Hub Web 控制台 v3 升级、iPhone 横屏精修与双端终审（2026-11-04）

### 1. Mobile iOS 横屏（`844×390pt`）首屏弧度与折叠线以上精修
- **首屏与共形抽屉**（`apps/mobile/app/index.tsx`、`RobotFaceView.tsx`、`QuickDrawerModal.tsx`）：
  - 移除首屏底部可能被 iOS UIKit 裁切为菱形边界的圆角实体背景，改用透明底径向地平线渐变辉光；微笑弧改用圆环裁切实现纯净圆弧 `︶`。
  - 抽屉/仿真台打开时自动隐藏顶部状态角标与底部声波括号唤醒栏；短横屏下大脸平滑上移缩放（`translateY: -86`、`scale * 0.56`），使双眼与微笑弧完整露在毛玻璃面板上方。
- **共形外壳与四大空间首屏密度优化**（`ConformalDeviceShell.tsx`、`MemoriesSpaceView.tsx`、`TasksSpaceView.tsx`、`HomeSpaceView.tsx`、`CabinSpaceView.tsx`）：
  - 压缩 `ConformalDeviceShell` 横屏头部高度至 `68pt` 并保留 `0.86x` 3D 头盔面罩与视线联动。
  - **回忆册**：搜索框与 4 枚认识论筛选胶囊同行排列，首条记忆的场景插画、位置引用、纠错按钮与右侧桌面空间靶心图 + 2×2 四维证据卡完整进入首屏。
  - **书房家居**：移除重复大标题块，2×2 设备能力 Bento 卡片（发光 `ToggleSwitch`、水平/垂直防冲突 `BrightnessSliderBar` + 五档快捷胶囊、`3000K/4000K/5500K` 冷暖色点胶囊、大字号温湿度/CO₂ 仪表）一屏完整呈现。
  - **约定与任务**：横屏三列并排呈现任务流、琥珀金 `高危作用域 · 单次审批` 安全盾牌卡与自然中文 `我们的日常约定`。
  - **维修舱**：顶部三列独立连接健康卡（BLE / Hub / HA）与下方双脑引擎热切换 + 四阶热状态槽 + `[-6, +6]px` OLED 防烧屏位移十字雷达同屏呈现。
- **截图归档**：`docs/artifacts/phase7/landscape-polish/ios-{firstscreen,quickdrawer,lab,memories,tasks,home,cabin}.png`。

### 2. Hub Web 控制台（`apps/hub/src/console-html.ts`）Presence v3.0 升级
- **Layer 0 & Layer 1**：220×200 渐变发光大眼 + `#0051FF` 立体底缘折射、移除 `.orb:after` 顶部灰白月牙带与默认悬空细眉、SVG 圆弧微笑、对称 7 柱声波括号唤醒栏 `··|┃|·· ( 说 Hey LOOI 唤醒我 · 轻触屏幕展开 ) ··|┃|··`；修复 `.drawer-open .wake` CSS 层叠顺序文字穿透 Bug。
- **Layer 2 共形外壳与响应式修复**：左侧 88px 窄轨配备发光猫耳徽标、发光青蓝圆角选中框与连线节点；标题旁配备 9 柱对称声波纹；右上角还原 `168×88px` 3D 金属头盔面罩（含顶部 `··· M` 传感器阵列、两侧青色耳灯与视线联动凹面屏）；修复 `<720px` 窄屏 `.rail` 悬浮腰斩长图与 `.connections` 三列挤压未折行问题。
- **Layer 3 四大富媒体空间**：
  - 全面接入自然中文语义转译层（消除卡片正面 `REV 1`、英文枚举与原始 JSON 规则裸露）。
  - 回忆册配备 4 幅 16:9 深色 SVG 场景光影插画与随选中记忆位置动态聚焦的桌面 SVG 脉冲靶心。
  - 任务簿配备琥珀安全盾牌审批面板与已回读产物芯片；家居空间配备发光拨动开关、流光滑轨（含防轮询回跳保护）与 `.selected` 高亮色温胶囊；维修舱配备三路连接卡、双脑切换、OLED 位移十字雷达、四大硬门禁盾牌卡、A–H 八组进度条与可折叠 48 项用例明细。
- **截图归档**：`docs/artifacts/phase7/web-console/hub-v3-{desktop,narrow,short}-*.png`。

### 3. 全仓自动化门禁与独立子 Agent 终审结论
- `pnpm typecheck`：4 个 workspace 包全部 0 错误通过。
- `pnpm test`：全工作区 100% 通过（`@super-looi/contracts` 5 项、`@super-looi/looi-driver` 10 项、`@super-looi/hub` 64 项、`@super-looi/mobile` 79 项，0 失败）。
- `pnpm build`：4 个 workspace 包全部 0 错误通过。
- **独立 UI/UX 审查子 Agent 终审结论**：**10/10 维度 PASS**，确认原版参考稿（`首屏示例.png`、`记忆示例.png`）与 Presence v3.0 设计规范全部要求均已闭环落地。
