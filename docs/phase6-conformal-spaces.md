# Phase 6 首屏接线与四大共形空间

本阶段依据 `docs/design-v2/ui-v2.1-redesign-spec.md`、`docs/phase6-layer1-components.md` 完成 Step 6.2 首屏接线与 Step 6.3 四大共形二级空间。代码实现、独立审查与 mobile 三项检查已完成。模拟器视觉/交互和真实硬件链路的验收范围在文末独立列明。

## 交付与交互

- `apps/mobile/app/index.tsx`：全屏大脸、快捷抽屉、仿真台、隐私暂停、字幕、轻提示、运动急停与控制器生命周期。
- `apps/mobile/src/ui/components/ConformalDeviceShell.tsx`：安全区、88pt 导航轨、离座截止时间、共形双节点、头像视线和轻提示。
- `apps/mobile/src/ui/spaces/MemoriesSpaceView.tsx`：搜索/筛选、证据双栏、原生 View 桌面矢量示意与三种记忆修订动作。
- `apps/mobile/src/ui/spaces/TasksSpaceView.tsx`：生产力任务流、作用域审批、已核验产物与诚实取消演练。
- `apps/mobile/src/ui/spaces/HomeSpaceView.tsx`：四卡家居能力网格、传感器真值来源、回读徽章、冲突调和与规则提案。
- `apps/mobile/src/ui/spaces/CabinSpaceView.tsx`：三路独立连接、双脑切换、热阶梯/OLED 微移与 48 项验收分组看板。
- `apps/mobile/src/index.ts`：可复用组件和公开类型导出。

## 共形外壳接口

`ConformalDeviceShell` 的 `activeSpace` 为 `memories | tasks_and_rules | home | cabin`；宿主提供 `onNavigate`、`onReturnToFace`、标题/副标题、`isDocked`、`deskFreshnessNotice`、`miniGaze`、`faceState`、`microShift`、`toast` 和内容 `children`。壳层仅展示状态，不拥有捕获、导航、运动或 Toast 生命周期。

外壳读取 `useSafeAreaInsets()` 并给四边添加安全区。横屏左侧 88pt 导航轨中，常规导航按钮高至少 64pt；便携竖屏切换顶部紧凑栏，按钮高至少 58pt。LOOI 和右上头像均通过 `onReturnToFace` 返回大脸。离座时显示琥珀色截止时间/新鲜度横幅，标题旁的双青色节点保留共形锚点，avatar 收到 `{ x: miniGaze.x, y: -miniGaze.y }`。

同文件导出 `LightToastCapsule`，根据传入 `ToastItem` 显示顶部中央胶囊。胶囊不拦截触摸，过期和说话期间挂起由宿主 `LightToastQueue` 负责。玻璃表面由原生半透明 View、描边与高光组合，不引入模糊依赖。

## 四空间接口与本地演示边界

回忆册和任务簿接收 `controller`、可选 `onChange` 与 `onNotify`。横屏且字体缩放小于 1.7 时使用等宽双栏，便携/大字体回退纵向布局。回忆册将显示器、键盘、杯垫和靶心全部绘制为原生 View，并注明“桌面空间矢量示意 非原始画面”。筛选、搜索、位置选择、`confirmed` Revision +1、撤回与遗忘均更新本地账本，调用相应控制器动作；用 WeakMap 以控制器生命周期保留演示修改。

任务流始于 `awaiting_approval`。批准仅推进本地 `running`，不直接写成功；拒绝或取消先进入 `cancelling`，由明确的退出回执演示推进 `cancelled`，或由失联演示推进 `unknown`。事件序号持续递增，退出确证 ID 单独展示，重置样例不重放远端命令。Readback Evidence 明确为独立的模拟 `artifact_probe` 样例。作用域列出 `/workspaces/super-looi-demo` 读写边界与 `git push --force origin fix/stairs`，审批不调用真实执行器。日常约定支持添加、暂停/恢复和删除。

家居使用 `StudyHomeDemo`：白名单为书房顶灯、台灯与新风；显式目标状态下发后读取本地 transport 状态核验，离线不写绿色成功，高危域在访问 transport 前拒绝。顶灯色温限定 3000K/4000K/5500K，第三次调整产生待确认提案，须显式用户事件确认后才晋升。`sensor.*` 环境数值为本地样例，保留来源标注，禁止从视觉推断。所有这些 UI 可交互，但不向物理 Home Assistant 发送指令。

维修舱接收 `CabinSpaceController`、`DockedLongevitySupervisor`、通知/变更回调及外部验收状态/报告/错误/运行回调。BLE、Hub、HA 分别显示连接状态与验真时间；HA 断连独立模拟，BLE 重连清理旧动作并显示重放计数。语音、视觉 provider 与热压力档位由控制器更新。验收未运行时为待验证，运行中显示等待 Hub，失败保持未核验，宿主开始新运行时清空旧报告；A-H 组和四项硬门禁只根据收到的报告呈现。

## 状态与边界

宿主以单实例挂载 Presence、Face、Toast、Memories、Tasks、Cabin、Longevity 与 KeepAwake 控制器，并以 `PresenceStateManager` 的 `innerSpace` 驱动首页/内页。首页移除旧顶栏与常驻调试按钮，保留感知状态微胶囊、功能/仿真台入口与底部触摸/上滑引导。八类控制器、四空间、Shell 与公开类型由 `apps/mobile/src/index.ts` 导出。

6 个 SimLab 动作回调的首个动作均为 `setSimLabVisible(false)`，随后返回大脸并执行场景变化/通知。说话演示输入有界幅度形成声波和单句字幕，普通 Toast 由队列挂起至说完后恢复。微观察场景仅模拟视线与本地运动队列，显示 58pt 珊瑚红 `#FA8E86` 停止胶囊；停止同步清理场景队列后调用本地急停。切换场景、隐私暂停、热压力禁止观察、进入后台和卸载均清理或停止运动，隐私暂停用全屏睡眠脸与纪元状态呈现。

常亮策略连接 `expo-keep-awake` 原生接口，按驻座/前台/隐私状态请求或释放，并串行化获取与释放以防异步清理竞态。宿主清理轮询、OLED、眨眼、场景计时器、AppState 订阅、验收请求和 Face blink 工作；离座记录当前真实截止时间，归座不重放旧运动。移动端目前没有接入真实相机、麦克风和 BLE transport，界面明确提示“感知未接入”及本地仿真边界，不将演示写成实时观察或硬件成功。

验收运行器通过 `EXPO_PUBLIC_HUB_URL`（兼容 `EXPO_PUBLIC_LOOI_SERVER_URL`，默认 `http://127.0.0.1:3000`）请求 `POST /api/acceptance/run`。30 秒超时或 HTTP/网络/结构错误均显示结果待核实。`parseAcceptanceReport` 要求 48 个唯一 A01-H06 用例、96 总分、完整四门禁，并验证明细/汇总/成功布尔值一致；数据不足或矛盾不能显示绿色成功。此次单测验证客户端解析与拒收边界；独立跨层验证还实际执行 `new AcceptanceRunner().runFullSuite()`，经 JSON roundtrip 后传入 mobile `parseAcceptanceReport`，退出码 0、`schemaAccepted=true`，48/48、96/96、A-H 各 6 项、四门禁全 0。该结果覆盖本地真实 Hub runner 与 mobile parser 兼容性，不是 HTTP、UI 联网或物理硬件验收。尚未通过 UI 实际运行远端 Hub 48 项。

## 验证记录

独立最终检查于 2026-11-04 在两处 render ref 错误修复后再次执行；三项 mobile 命令从工作区根目录执行，React Doctor 从 `apps/mobile` 执行：

| 检查 | 结果 | 覆盖范围 |
| --- | --- | --- |
| `pnpm --filter @super-looi/mobile typecheck` | 退出码 0 | `src` 和 `app` TypeScript/TSX 类型检查 |
| `pnpm --filter @super-looi/mobile test` | 退出码 0，10 suites，45/45 通过 | 控制器、Metro resolver、家居本地回读/高危域、记忆修订、取消证据与完整验收报告解析 |
| `pnpm --filter @super-looi/mobile build` | 退出码 0 | `tsc -p tsconfig.build.json` 的移动端库导出编译 |
| `git diff --check` | 退出码 0 | 当前变更空白检查 |
| 独立集成审查 | 已完成，最终无未解决 P1/P2 | 首屏动作顺序、状态/计时器清理、连接与证据边界、Shell 和四空间布局约束 |
| React Doctor 最终复扫 | 退出码 0，73/100；0 errors / 47 warnings | 扫描 33 文件，Home/Memories 两项 render ref 错误已修复；保留非阻断诊断 |
| Hub runner 与 mobile parser 跨层兼容 | 退出码 0，48/48、96/96、四门禁全 0 | 实际本地 AcceptanceRunner 全套执行、JSON roundtrip 与 mobile 严格解析；非 HTTP/UI/硬件 |
| iOS 首屏视觉 smoke | iPhone 16e / iOS 26.3 通过 | Expo bundle HTTP 200，首屏无缺失字形、空闲波形或旧顶栏；四空间逐态交互未完成 |

React Doctor 按技能要求用 pnpm dlx 执行，未修改 package 或 lock。普通沙箱默认缓存目录与 registry 访问 EPERM 后，改用临时 cache/store 并提升执行成功（关闭 fetch retries，整体限定 90 秒）。初扫的 2 项 render ref 错误已修复：Home 将 model 获取改为 memo，并通过 effect 注册/同步健康状态；Memories 通过 effect 同步回调 ref。最终复扫退出码 0、73/100、0 errors、47 warnings，不将初扫 62/100 作为最终结果。

剩余诊断经代码上下文检查后未发现需要本轮追加的功能修复，也未添加抑制配置：

| 诊断组 | 数量 | 判断与范围 |
| --- | --- | --- |
| 原生阴影键及 boxShadow 偏好 | 35 | 确实存在既有 shadow 样式，高置信度；当前 iOS 首屏发光视觉已验证，属于样式 API 迁移建议，后续按跨端视觉需求评估 |
| 控制流复杂度与大组件 | 6 | 结构性可维护性建议，高置信度；不代表当前功能错误，拆分不扩入本轮 |
| ref/state 初始化 | 3 | 确有每次 render 的廉价 Promise/对象读取，高置信度；现有初始化不持有新增外部资源，暂无可测性能影响 |
| 固定数组索引 key | 1 | 固定 7 条波形图形，不重排，当前语义安全，高置信度 |
| 选择变化时重置内联位置编辑 | 1 | 当前 effect 是明确的产品行为，不应沿用前一条记忆的编辑状态，高置信度 |
| ScrollView 内 mapped 列表 | 1 | 当前本地演示为 4 条，暂无虚拟化必要；接入真实大账本后需评估，置信度中 |

最终诊断临时目录：`/var/folders/mr/b_2wqc0d13s4nbzdl019mgy80000gn/T/react-doctor-dc7bb652-dca6-449b-9d98-d403507c02ac`。

环境：pnpm 9.15.9 与 Xcode developer dir 可用。普通沙箱内的只读 `xcrun simctl list devices booted` 因 CoreSimulator 服务隔离退出码 1；主调度在只读提升后成功确认 iOS 26.3 的 iPhone 16e 已 Booted（UUID `F90B8A44-A2D2-4FF6-90FF-C55E887A3305`）。模拟器可用性已确认，首屏视觉 smoke 已完成，四空间逐态视觉/交互验收仍待执行，不以沙箱内失败判断设备不可用。当前 CUA 对 Simulator 操作被拒绝，已通过 simctl/Expo 启动与截图。首屏记录见 [iOS 首屏截图](artifacts/phase6/ios-firstscreen-2026-11-04.png)；该截图不代表已点遍四空间或完成全部交互验收。

TypeScript build 为 `tsc -p tsconfig.build.json`，不等同于 iOS 原生编译或 Expo 运行时验收。单元测试也不证明真实 BLE 急停小于 100ms、真实家居状态或 72 小时硬件长稳结果。Step 6.4 的 Hub Web 控制台及全工作区回归独立跟踪。
