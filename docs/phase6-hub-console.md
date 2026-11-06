# Phase 6 Hub Presence v2.1 控制台

本轮依据 `docs/design-v2/ui-v2.1-redesign-spec.md` 和 `progress.md` Step 6.4，完成 Hub 内嵌 Web 控制台升级及工作区四包验证。移动端 UI 联网验收、iOS 模拟器逐屏交互和物理硬件验收继续独立跟踪；不将 Step 6.4 整体标为完成。

## Hub 实时接口与可信状态

为 Web 界面增加三个只读接口，保留既有控制入口：

| 接口 | 用途与边界 |
| --- | --- |
| `GET /api/console/status` | 返回 Hub 当前语音/视觉 provider、HA 适配器健康和验真时间；明确控制台当前为仿真、物理 BLE 未连接、物理急停未核验 |
| `GET /api/home/states` | 只返回白名单实体及当前状态快照，保留传感器单位和原始更新时间；缺读数或离线时快照为 `null`，不生成虚假物理读数 |
| `GET /api/tasks/:taskId/grants` | 返回该任务真实 ActionGrant 的作用域、状态和单次授权限制；不存在的任务返回 404 |

`HubTaskSupervisor.getTaskActionGrants()` 按任务筛选授权；审批额外校验授权归属，拒绝通过另一任务 ID 使用授权，并保持两个任务与授权未变。

`apps/hub/test/console-readonly-api.test.ts` 覆盖仿真/物理状态区分、HA 健康变化、白名单和传感器原始快照、缺失/离线状态、任务授权隔离/撤销、跨任务审批拒绝。接口实现代理报告 Hub 类型检查和接口/任务聚焦测试 15/15 通过；独立审查无阻断。最终根目录回归另列于下节。

## 控制台交付

`apps/hub/src/console-html.ts` 保持内嵌单页形式，以 `#03070D` 点阵设备屏、`rgba(10, 22, 36, 0.78)` 玻璃表面和 Cyan / Blue / Green / Amber / Coral 语义色统一大脸与内页。图标来自内联 SVG symbol；生成 HTML 与动态服务器文本均移除 Emoji，不依赖外部字体图标。

默认只显示全屏大脸、感知微胶囊、功能/仿真台入口和底部轻触引导。152×134 圆润眼睛带双层呼吸辉光、`#0066FF` 下缘折射、动态眉毛和 SVG 微笑；声波只在说话演练时激活。隐私暂停闭眼并明确只暂停本页交互，浏览器未采集相机/麦克风，也没有远端硬件断开回执。

轻触大脸/功能打开六入口快捷抽屉，仿真台打开六动作演练抽屉，空闲 4.5 秒收起；对话框含键盘焦点管理与减少动态效果适配。演练动作先关抽屉、回大脸，再执行，顶部轻提示保持 3 秒。说话为有界动画演练；记当前画面写入真实 Hub 记忆 API，但来源明确为带 SHA-256 内容哈希的 `app_context` 设备屏示意，绝不伪装相机抓拍。主动微观察调用 Hub 仿真接口；脱座记录本页截止时间；急停只同步停止本页运动/声波并丢弃迟到反馈，不宣称底座已停车或已撤回发出的 Hub 请求。

二级空间共享 88px 玻璃窄轨和右上角可返回大脸的迷你头显；选择记忆/审批卡时视线联动，窄屏响应式收敛布局。

| 空间 | 交付与接线 |
| --- | --- |
| 回忆册 | 双栏搜索/筛选列表与四问检视器，SVG 桌面示意明确注明非真实坐标；读取 Hub claims，支持真实纠错、拿走撤回、源证据遗忘 |
| 约定任务 | 双栏任务事件/产物和授权审批/规则；显示真实 scope、workspace、命令摘要和单次授权边界，缺失具体文件范围明确告知；取消先为请求中，必须有终止证据才显示已确认，否则保留未知 |
| 书房家居 | 吸顶灯、台灯、新风与传感器 2×2 网格；显式开关、亮度、色温命令与真实快照回读，传感器保留单位/时间戳，仿真适配器有标识；支持偏好提案确认/撤销；HA 不健康时禁用操作 |
| 维修舱 | BLE / Hub / HA 三列独立状态与可得验真时间、语音/视觉 provider 切换、A-H 八组 48 项看板及四门禁；缺少的 BLE、热状态、模型卸载遥测如实标为未接入 |

每 5 秒刷新 Hub 数据，分域记录失败；避免轮询重建正在编辑的输入。所有 HTTP 非成功状态按失败处理，服务器文本转义后再进入 HTML。验收报告要求完整唯一 A01–H06、汇总分数/通过数一致、四门禁有效；不完整或矛盾报告不能显示成功。

家居联调同时修复 `apps/hub/src/home/gateway.ts`：fresh noop 和执行后核验均比较开关状态及请求的亮度/色温参数。灯已开但参数不同仍执行；服务应答成功而回读参数不符返回 `unverified / readback_mismatch`，不生成虚假成功。

新增 `console-runtime.test.ts` 直接执行实际输出的内联脚本，7 项覆盖语法/零 Emoji、真实 48 项报告及伪造拒收、取消终止证据、HTTP 错误、转义与 Emoji 清理、HA 离线和真实只读 schema/仿真记忆来源。新增 `home-parameter-readback.test.ts` 两项覆盖参数变更、相同参数 noop、回读不一致。

## 最终全工作区验证

2026-11-04 初稿首轮三项命令通过（23 suites / 106 tests）；运行时边界修复、家居参数回读修复和新增测试稳定后，从根目录重新执行全部三项命令，最终结果如下。

| 根目录检查 | 最终结果 |
| --- | --- |
| `pnpm typecheck` | 四包全部通过，退出码 0 |
| `pnpm test` | 25 suites / 115 tests 全通过，退出码 0，失败 0 |
| `pnpm build` | 四包 TypeScript 构建全部通过，退出码 0 |
| `git diff --check` | 退出码 0 |

| 包 | 最终 suites | 最终测试 | 失败 |
| --- | ---: | ---: | ---: |
| `@super-looi/contracts` | 1 | 5 | 0 |
| `@super-looi/looi-driver` | 1 | 11 | 0 |
| `@super-looi/hub` | 13 | 54 | 0 |
| `@super-looi/mobile` | 10 | 45 | 0 |
| 合计 | 25 | 115 | 0 |

最终临时日志分别为 `/tmp/super-looi-hub-console-final-typecheck.log`、`/tmp/super-looi-hub-console-final-test.log`、`/tmp/super-looi-hub-console-final-build.log`。Hub suite 内执行 48 条核心验收用例，由单项测试承载，不重复计入上述 115 个测试。

## Web 独立审查与浏览器证据

独立审查最终无阻断问题。在 `env -i` 启动的隔离本地 Hub 实例上执行真实浏览器检查，只导入 `buildApp` 并使用内存 seed，没有加载 `.env`。以下为实际操作结果：

| 检查 | 结果与证据 |
| --- | --- |
| 1440×900 首屏、抽屉与四空间 | 已逐屏截图看图；[大脸](artifacts/phase6/hub-face.png)、[快捷抽屉](artifacts/phase6/hub-quick-drawer.png)、[仿真台](artifacts/phase6/hub-lab.png)、[回忆册](artifacts/phase6/hub-memories.png)、[任务](artifacts/phase6/hub-tasks.png)、[家居](artifacts/phase6/hub-home.png)、[维修舱](artifacts/phase6/hub-cabin.png) |
| 轻提示与抽屉可访问性 | 实测 3 秒轻提示、4.5 秒抽屉无操作收起、焦点圈定和 Escape 关闭 |
| 说话与隐私 | [说话态](artifacts/phase6/hub-speaking.png)、[隐私闭眼态](artifacts/phase6/hub-privacy.png)，待机无声波 |
| 视线、脱座和急停 | 点卡后迷你头显视线变为 `--mx: -7px / --my: 4px`；拔下/归座记录本页真实截止时间；本地急停明确提示没有硬件停止回执 |
| 主动微观察 | API 成功返回遮挡时的诚实 fallback，提示微调后仍被挡住；未强行显示“发现目标” |
| 记忆 HTTP 联动 | 实际向 Hub 写入明确标记的仿真设备屏快照；纠错成功，轮询不清空编辑输入 |
| 诚实取消 | [请求中](artifacts/phase6/hub-cancelling.png) → 网络请求中断后的[结果待核实](artifacts/phase6/hub-cancel-unknown.png) → 收到退出证据后的[已确认停止](artifacts/phase6/hub-cancel-confirmed.png) |
| 家居与规则 | 实际 3 次参数调整生成提案、确认后在任务页撤销；注入 `healthy: false` 后[设备离线且控件禁用](artifacts/phase6/hub-home-offline.png) |
| 390×844 响应式布局 | 四空间无水平溢出；[首屏](artifacts/phase6/hub-mobile-face.png)、[回忆册](artifacts/phase6/hub-mobile-memories.png)、[任务](artifacts/phase6/hub-mobile-tasks.png)、[家居](artifacts/phase6/hub-mobile-home.png)、[维修舱](artifacts/phase6/hub-mobile-cabin.png) |
| Web UI 运行完整验收 | 通过 UI 实际 HTTP 请求 Hub，48/48、96/96、四门禁全部 0；组名修正后重跑，[验收看板](artifacts/phase6/hub-acceptance.png) |

以上 19 张 Web 截图保存在 `docs/artifacts/phase6/hub-*.png`，与历史 iOS 首屏截图分开。窄屏 Web 不等同于原生 iOS/Android 验收。

浏览器高危审批按钮“批准本次”（`task_demo_push` 对应 `git push --force`）的点击被自动审批审查拒绝：用户未授权具体破坏性命令，且演示环境不足以证明不会执行。没有点击或绕过。审批面板布局与作用域已渲染检查；审批 API 集成、授权归属拒绝、HTTP 失败测试与浏览器成功点击属于不同证据，不能互相冒充。

## 分阶段提交

- `d8189e5`：本轮交付计划。
- `7021357`：只读接口与授权归属保护。
- `f263415`：Presence 控制台、运行时回归及家居参数回读修复。
- 本文、`progress.md` 与 `todo.md` 在最终归档提交中收敛。

## 独立验收边界

- 本轮 Web 交付不能替代移动端 UI 实际请求 Hub 并核验 48 项看板。
- `tsc` 构建不能替代 iOS 原生编译、模拟器逐屏视觉/交互验收。
- 仿真状态和确定性测试不能证明物理 BLE 急停时延、真实相机/麦克风切断、真实 Home Assistant 设备回读或双端 72 小时长稳。
- 既有用户改动 `apps/mobile/package.json`、`pnpm-lock.yaml` 与未跟踪设计规范不属于本轮提交。
