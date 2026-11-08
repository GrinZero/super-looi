# Super-LOOI 具身底座 SDK 接入 NSH 应用：产品文档与技术设计方案

## Goal Description（背景与目标）

当前 Super-LOOI 已完成向 **Native Shell（NSH，原生壳框架）** 的无 Hub（去中心化本地主机）架构迁移，手机本机已跑通 **Pi Agent 循环**、**sherpa-onnx 本地唤醒 + 豆包/OpenAI 实时语音** 与 **米家/Home Assistant 家居控制**。然而，作为具身桌面机器人的核心部分——**LOOI 磁吸履带底座 SDK** 目前仍处于未接入状态：

1. **存量 SDK 资产与缺口**：
   - 早期 `@sourcebug/looi-sdk`（位于 `archive/legacy-v1`）验证了设备扫描、名称/UUID 过滤、已选底座持久化、高层移动/头部/灯光 API 与 `looi_move` / `looi_set_head` / `looi_set_light` 工具；
   - 现役 [`@super-looi/looi-driver`](../../packages/looi-driver/src/index.ts) 沉淀了逆向验证的 BLE（Bluetooth Low Energy，低功耗蓝牙）协议常量（[`constants.ts`](../../packages/looi-driver/src/constants.ts)）、跨端传输适配器（[`transport.ts`](../../packages/looi-driver/src/transport.ts)）与带安全租约状态机的 [`BodySupervisor`](../../packages/looi-driver/src/body-supervisor.ts)；
   - 但 [`apps/nsh`](../../apps/nsh/App.tsx) 尚未注册原生 BLE 桥接模块，[`build-runtime.ts`](../../apps/nsh/scripts/build-runtime.ts) 未打包 `@super-looi/looi-driver`，Agent 与实时语音无法驱动底座，界面也缺少底座连接配对与经典器物控制台。

2. **本次交付目标**：
   - 将 `@sourcebug/looi-sdk` 的设备发现/高层控制能力与 `@super-looi/looi-driver` 的安全状态机合并收敛为完整的本机具身驱动层；
   - 在 `apps/nsh` 实现双端原生 `LooiBle` 模块（iOS `CoreBluetooth` + Android `BluetoothGatt`）及无硬件开发期的 `simulation`（模拟体验模式）；
   - 打通 **「底座扫描配对 -> 3 步协议握手与磁吸在座感知（`fed9`） -> 实时语音/Agent 具身动作工具 -> 前台桌宠无感联动 -> 管理空间『底座』经典轮盘与滑动条控制台」** 完整闭环。

---

## 已定稿核心产品与交互决策

1. **实时语音（LIVE 对话）与慢思考 Agent 双通道共享单实例 `BodyRuntime`**：
   - 除了允许慢思考 `PiAgentExecutor` 在多步任务中调用身体工具外，直接在 [`VoiceRuntime`](../../apps/nsh/runtime/voice/runtime.ts) 中注册轻量级 `control_looi_body` 工具（与 `run_agent_task`、`end_conversation` 并列），使豆包/OpenAI Realtime 可在 `~100ms` 内直接驱动底座边说话边做动作。
2. **前台桌宠主页零打扰与有界脉冲安全边界**：
   - **前台桌宠舞台（`App.tsx`）保持纯粹**：不在桌宠主页增加“底座已吸合”或“急停 · 向前移动中”等状态胶囊；
   - **自然动作中止**：单次移动脉冲严格限制在 `[50ms, 1200ms]` 内且必须满足 `isDocked === true`；用户从磁吸支架上拿起手机（`fed9 = 06`）、点击语音「打断」或直接说“停下”，均在 `<100ms` 内硬件级刹停。
3. **后台管理空间「底座（`body`）」去工程化与暗黑版统一布局**：
   - **左栏（连接卡片抓大放小）**：隐藏 UUID、`dBm`、寄存器地址、握手步数与租约状态等一切工程指标；顶部展示桌宠底座微缩图标、大字号设备名（如 **`LOOI 桌面底座`**）与醒目的在位状态徽标（**`● 已吸合就绪`**），中部为内嵌圆角盒 **`靠近自动重连`** 开关（模拟体验模式下为 **`模拟放上底座`**），下方为极简 **`其他可用底座`** 列表与底部 **`断开连接`** 按钮；
   - **右栏（双内嵌面板 · 经典方向轮盘 + 头部俯仰滑动条）**：统一采用暗黑版设计稿的双内嵌面板结构——左侧内嵌面板居中放置**经典圆形四向方向轮盘（中心带凸起圆形停止键 `■`）**，右侧上方内嵌面板放置**纵向头部俯仰滑动条（左侧大字号显示实时角度 `25°`/`55°`/`85°`，上下标注 `抬头`/`低头`）**，右侧下方为独立圆角胶囊开关 **`☀ 补光灯 · 已开启 / 已关闭`**。

---

## 1. 产品需求文档（PRD：具身底座能力定义）

### 1.1 核心用户场景（User Scenarios）

| 场景 ID | 场景名称 | 触发方式 | 系统与硬件行为 | 异常与安全边界 |
| :--- | :--- | :--- | :--- | :--- |
| **S1** | **首次扫描配对与磁吸上座** | 用户进入「连接 -> 底座」，点击「扫描附近底座」并点选 `LOOI` | 1. 请求系统蓝牙权限并扫描广播 `000000ff-...` 或名称含 `LOOI` 的外设；<br>2. 建立 GATT 连接并自动完成 3 步时间同步握手（`feda:03` -> `fef0:时间` -> `feda:8101`）；<br>3. 订阅 `fed9` 磁吸通知：手机放上磁吸面收到 `05` 后状态升为 `已吸合就绪`，记住设备 ID 供后续自动重连。 | 未吸上底座（`connected_unarmed`）时，允许开关补光灯，但**物理锁定所有电机与头部动作**。 |
| **S2** | **拿起手机立即刹停（Undock Safety Lock）** | 底座正在移动或转向时，用户直接从磁吸支架上拿起手机 | 1. 底座通过 `fed9` 发送 `06`（脱座）；<br>2. 原生 BLE 层与 `BodySupervisor` 立即吊销当前动作租约（Lease），向 `fed0` 写入 `0000` 停止指令；<br>3. 状态切回 `已连接 · 请放上底座`。 | 断连、脱座或 App 退入后台期间被中断的动作**绝不排队重放（Zero Motion Replay）**。 |
| **S3** | **语音/对话中的自然具身表达** | 用户在 LIVE 语音或文字对话中说：“抬头看我”、“往左转一点”、“打开补光灯” | 1. 模型调用 `control_looi_body` 工具；<br>2. `BodyRuntime` 申请单活互斥租约（`BodyActionLease`），下发有界脉冲指令并在到期后自动发 `0000` 停止；<br>3. 运动期间自动开启 `SelfEventWindow`（自生成事件抑制窗口）；<br>4. 动作完成后写入 SQLite 任务证据表。 | 若当前有另一动作租约正在执行，拒绝并发抢占（单活互斥）；若用户说“停下”或点击语音打断，`<100ms` 抢占终止。 |
| **S4** | **底座经典轮盘操控与模拟体验** | 用户在「底座」管理空间操作方向轮盘、头部滑动条、补光灯，或切换到「模拟体验」模式 | 1. 真机模式下操作轮盘下发有界脉冲、拖动/点按头部滑轨调整俯仰角、点按胶囊开关补光灯；<br>2. **模拟体验（Simulation）模式**下，使用内存 `SimulatedBleTransport` 完整运行同一套 `BodySupervisor` 状态机，支持一键切换“模拟放上底座”。 | 真实蓝牙连接失败时**绝不静默回退到模拟底座**；模拟模式需用户显式切换。 |

### 1.2 LOOI BLE 协议规范表（基于逆向验证契约）

| 通道别名 | Characteristic UUID | 方向与属性 | 载荷（Hex）与业务语义 |
| :--- | :--- | :--- | :--- |
| **`Service`** | `000000ff-0000-1000-8000-00805f9b34fb` | Primary Service | LOOI Robot 主控制服务 |
| **`handshakeControl`** | `0000feda-0000-1000-8000-00805f9b34fb` | Write (With Response) | 握手步骤 1 发送 `"03"`（1B）；步骤 3 发送 `"8101"`（2B）激活控制 |
| **`handshakeData`** | `0000fef0-0000-1000-8000-00805f9b34fb` | Write / Notify | 握手步骤 2 发送 20B ASCII 时间戳（格式 `A2026 11 08 13 45 00` 的 Hex） |
| **`dockNotify`** | `0000fed9-0000-1000-8000-00805f9b34fb` | Notify | 磁吸在座状态通知：`"05"` = 在座（Docked），`"06"` = 脱座（Undocked） |
| **`drive`** | `0000fed0-0000-1000-8000-00805f9b34fb` | Write Without Response | 履带移动：前进 `"7707"`、后退 `"86fc"`、左转 `"047a"`、右转 `"0082"`、停止 `"0000"` |
| **`head`** | `0000fed1-0000-1000-8000-00805f9b34fb` | Write Without Response | 头部俯仰：抬头 `"00"`（25°）、中位 `"87"`（55°）、低头 `"ff"`（85°） |
| **`light`** | `0000fed2-0000-1000-8000-00805f9b34fb` | Write Without Response | 前部补光灯：开灯 `"01"`、关灯 `"00"` |
| **`rawFe00`** | `0000fe00-0000-1000-8000-00805f9b34fb` | Write | 原始扩展指令通道 |

---

## 2. 模块边界与分阶段改动清单

1. **共享驱动层（`packages/looi-driver`）**：
   - 在 `transport.ts` 扩展 `LooiDeviceCandidate`、`LooiConnectTarget`、`scanCandidates` 与 `SimulatedBleTransport.simulateDock(docked)`；
   - 在 `body-supervisor.ts` 新增 `getSnapshot()`、`setHead(pose)` 与 `setLight(on)`。
2. **原生蓝牙桥接与权限插件（`apps/nsh/src/ble*` & `apps/nsh/native/`）**：
   - `apps/nsh/src/ble.rs`、`apps/nsh/src/ble/ios.rs`、`apps/nsh/src/ble/android.rs`、`apps/nsh/native/android/com/superlooi/nsh/LooiBleBridge.java`；
   - 在 `apps/nsh/src/lib.rs` 注册 `LooiBle`，并在 `apps/nsh/native/plugins.json` 与 `apps/nsh/scripts/native-plugins.mjs` 配置双端蓝牙权限。
3. **本机身体运行时与双通道工具（`apps/nsh/runtime/`）**：
   - 新增 `apps/nsh/runtime/body.ts`（`BodyRuntime` + `NshNativeBleAdapter`）；
   - 在 `apps/nsh/runtime/application.ts` 接入 `BodyRuntime`、`body_action_evidence` 表与 `get_looi_body_status` / `control_looi_body` 工具；
   - 在 `apps/nsh/runtime/voice/tools/control-looi-body.ts` 与 `apps/nsh/runtime/voice/runtime.ts` 接入低延迟语音身体控制工具；
   - 更新 `apps/nsh/scripts/build-runtime.ts` 导出身体相关类型与接口。
4. **NSH 表现层（`apps/nsh/store.ts` & `apps/nsh/ui/`）**：
   - `App.tsx` 保持零额外胶囊打扰；
   - `ManagementShell.tsx` 新增 `底座`（`body`）导航项与顶部 `蓝牙底座 / 模拟体验` + `扫描附近底座` 胶囊栏；
   - `BodySpaceView.tsx` 严格按照暗黑版设计稿实现左栏极简设备卡与右栏双内嵌面板（经典圆形方向轮盘 + 纵向头部俯仰滑动条 + 补光灯胶囊）；
   - `TasksSpaceView.tsx` 支持展示任务关联的 `bodyActions` 执行证据。
