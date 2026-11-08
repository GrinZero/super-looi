# LOOI 控制系统协议能力接入与无极变向轮盘方案

基于协议提交 `0e80654`（`FED0` 双轴有符号运动 `setMotion`、`FED8` 电量与外接供电读取 `readPowerStatus`、`FED2` 补光灯无极亮度 `setLightBrightness`），更新驱动脉冲接口、`BodyRuntime`、Agent / 实时语音工具、`store` 状态流与「底座」管理空间界面，并将原有四向点击按钮轮盘替换为《王者荣耀》式 360° 无极变向摇杆轮盘。

## 1. 模块边界与接口取舍（`codebase-design`）

### 1.1 连续摇杆会话归属：下沉至 `BodyRuntime`
- **备选 A（浅层透传）**：UI 组件自行维护租约获取、500ms 续租定时器、触控帧节流与停止竞态计数。缺点是租约生命周期分散在 `BodySpaceView`、`store` 与 `BodyRuntime` 三处，手指静止按住与快速滑动切换容易产生续租遗漏或 BLE `writeWithoutResponse` 队列拥塞。
- **采用方案 B（深模块 `BodyRuntime.setDriveVector(speed, turn)`）**：
  - 调用方只声明目标速度矢量 `(speed, turn)`（各 `-127..127`）与 `stop()`。
  - `BodyRuntime` 内部统一持有手动驾驶租约、450ms 自动续租定时器（保证手指推到底保持静止时租约不断）、25ms 最新值合并（Latest-wins Coalescing）与代数守卫（`driveGeneration`），移除 UI 层约 65 行点击/长按状态机。

### 1.2 驱动层增强（`packages/looi-driver`）
- `BodySupervisor.setMotion(lease, speed, turn)`：清理过期 `SelfEventWindow` 并合并连续运动窗口；当编码后的两字节负载与当前心跳帧相同时跳过重复即时写入，由既有 30ms 心跳维持。
- `BodySupervisor.executePulse(request, settlingMs, motion?)`：可选接收 `{ speed, turn }`，复用同一套单活动租约互斥、`SelfEventWindow` 感知抑制、停止帧与可抢占等待，供 Pi Agent 与实时语音执行有界双轴脉冲移动。

### 1.3 运行时、工具与回执契约（`apps/nsh/runtime`）
- `BodyStatusSnapshot` 新增：
  - `lightBrightness: number`（`0..255`）
  - `powerStatus: { batteryPercent: number; externalPower: boolean } | null`
  - `powerReading: boolean`
  - `motion: { speed: number; turn: number }`
- `BodyRuntime`：
  - 连接握手完成后异步触发首次 `readPowerStatus()`（失败不阻断已建立的底座连接）；提供 `readPowerStatus()` 幂等并发合并供手动刷新。
  - 模拟模式下 `setSimulatedDock(docked)` 同步模拟外接供电标志变化（在座 `externalPower: true`，脱座 `externalPower: false`）。
  - `BodyControlAction` 扩充 `move`、`light_set`、`read_power`（保留既有 `forward`、`backward`、`turn_left`、`turn_right`、`head_up`、`head_center`、`head_down`、`head_set`、`light_on`、`light_off`、`stop`）。
- Pi Agent（`application.ts`）与实时语音（`control-looi-body.ts`）工具同步支持 `move`（`speed`、`turn`、`duration_ms`）、`head_set`（`head_degrees`）、`light_set`（`brightness`）与 `read_power`。

## 2. 交互与界面设计（`ui/Controls.tsx` + `ui/BodySpaceView.tsx`）

1. **《王者荣耀》式 360° 无极变向摇杆（`SteplessWheel`）**：
   - 使用 NSH `View` 手势响应器（`onStartShouldSetResponder` + `onResponderGrant: () => true` + `onResponderTerminationRequest: () => false`）阻断外层 `Scroll` 抢占纵向手势，跟踪初始触点 `identifier` 防止多指跳变。
   - **防误点启动**：触点需产生 `>= 5pt` 滑动位移才激活驾驶，纯点击轮盘任意位置不触发运动；松手或手势中断立即回中并调用 `stopBody()`。
   - **极坐标到协议矢量映射**：以 `10%` 中心死区过滤微颤，死区外按径向推程线性映射模长，上推 `speed > 0`（`+127`）、下拉 `speed < 0`（`-127`）、左推 `turn > 0`（`+127`，对应 `007f`）、右推 `turn < 0`（`-127`，对应 `0081`）。
   - **视觉呈现**：原生 `Canvas` 读取 `theme.json` 语义 Token 绘制外圈刻度环、拖拽时的《王者荣耀》式外缘方向高亮圆弧与指向角标、牵引线及可跟随手指移动的中心摇杆圆钮；面板右上保留独立 `44pt` 热区的 `急停` 按钮（`testID="body-wheel-stop"`）与实时速度/转向读数。
2. **补光灯开关与无极亮度滑杆**：
   - 右下补光灯区域整合开关按钮（`testID="body-light-toggle"`，默认开启亮度 `128` 即 `50%`，记忆上次非零亮度）与横向 `Slider`（`testID="body-light-slider"`，`0%–100%` 映射 `0..255`），使用最新值合并队列避免连续拖动阻塞 GATT 心跳。
3. **底座电量与外接供电状态栏**：
   - 左栏设备状态卡在已连接时展示电量百分比、`外接供电 / 电池供电` 状态与 `刷新电量` 按钮（`testID="body-power-refresh"`）。

## 3. 验证计划
- `@super-looi/looi-driver` 单测：覆盖 `executePulse` 双轴矢量脉冲、`setMotion` 相同负载去重与 `SelfEventWindow` 收敛。
- `@super-looi/nsh` 运行时与工具测试（`body-runtime-cases.ts`）：覆盖 `setDriveVector` 连续变向与静止续租、`light_set` 亮度调节、`readPowerStatus` 自动/手动读取、Pi Agent 与实时语音新工具参数。
- NSH 类型检查、构建与 Headless UI 测试（`app_ui.rs`）：验证摇杆拖拽变向与松手急停、补光灯亮度滑杆、底座电量显示及中英文文案。
- Android 真机（魅族 20 Pro）：安装更新后的开发包检验横竖屏排版与触控响应。
