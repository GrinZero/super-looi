# 蓝牙底座二次吸附全自动连接与首屏多模态反馈方案

针对已完成首次配对的 LOOI 磁吸底座（存在 `savedDeviceId` 且开启 `autoConnect`），打通用户在首屏（`face`）直接将手机吸附到底座时的**静默自动连接**与**四重即时具身反馈**（`dock_snap` 表情、`LightToast` 轻提示、双频磁吸音效、云台抬头归中问候）。

## 1. 模块边界与接口取舍（`codebase-design`）

### 1.1 自动重连生命周期：下沉至 `BodyRuntime` 内部守望
- **备选 A（UI 层轮询调用 `connectBodyDevice`）**：在 `store.ts` 定时调用显式连接接口。缺点是后台等待底座开机期间 `status().connecting` 反复翻转导致管理页按钮与状态胶囊闪烁、超时错误覆盖 `lastError` 并弹出报错提示，且与手动「扫描附近底座」「断开连接」产生竞态。
- **采用方案 B（深模块 `BodyRuntime.setForegroundActive(active)` + 静默守望状态机）**：
  - **触发条件**：`foregroundActive && mode === "real_ble" && autoConnect && Boolean(savedDeviceId) && !manualDisconnectHold && !connected && !connecting && !scanning` 且系统蓝牙权限已为 `"granted"`（首屏静默守望不主动弹权限框）。
  - **连接策略**：
    - 应用启动或从后台切回前台（`setForegroundActive(true)`）时，立即发起首轮静默直连；
    - 若直连未命中（如手机重启后 Android 控制器缺少外设地址类型缓存，或底座刚通电），下一轮先执行最长 `2.5s` 的目标设备快速扫描（命中 `savedDeviceId` 立即提前结束扫描）再发起连接；
    - 重试间隔采用有界退避 `1.2s → 2.5s → 4.5s`，静默重试期间不置 `connecting = true`、不写入超时 `lastError`。
  - **用户意图优先**：
    - 显式调用 `disconnect()` 置 `manualDisconnectHold = true`，当前会话保持断开，不违背用户点击「断开连接」的意图；显式 `connect()`、重新开启 `autoConnect` 或重启后解除保持；
    - 意外断线（`onStateChange` 进入 `disconnected` / `fault`）不置保持标志，自动进入退避重连；
    - 显式 `scan()` 期间暂停静默重连，扫描结束后若仍未连接则自动恢复守望。

### 1.2 原生 BLE 已知外设重连优化（`ios.rs` / `LooiBleBridge.java` / `NshNativeBleAdapter`）
- **iOS (`apps/nsh/src/ble/ios.rs`)**：`connect()` 在内存 `discovered` 未命中时，优先通过 `NSUUID` 调用 `-[CBCentralManager retrievePeripheralsWithIdentifiers:]` 取回系统已知 `CBPeripheral` 并直接调用 `connectPeripheral:options:`（蓝牙栈尚未 `PoweredOn` 时挂起，待 `centralManagerDidUpdateState:` 就绪后立即连接），仅在系统缓存未命中时回退至扫描发现。
- **Android (`apps/nsh/native/android/com/superlooi/nsh/LooiBleBridge.java`)**：API 23+ 调用四参数 `device.connectGatt(owner, false, callback, BluetoothDevice.TRANSPORT_LE)`，强制走低功耗蓝牙通道，避免双模自动探测导致的 `status=133`。
- **`NshNativeBleAdapter.waitForDevice(deviceId, timeoutMs)`**：轮询 `scannedDevices()` 一旦发现目标 `deviceId` 立即停止扫描并返回，消除固定 8s 等待。

### 1.3 在座检测来源审视（复用 `FED9` 硬件传感器，不引入手机磁力计或充电广播）
- 底座不插外接电源时无线充电未必启用，手机磁力计受不同机型磁环位置干扰且需高频采样；而底座自带硬件在座传感器并通过 `FED9`（`05` 在座 / `06` 脱座）通知上报。
- 配合常驻 BLE 静默守望：
  - **底座通电待机场景**：手机靠近桌面时已完成静默连接与 3 步握手（`connected_unarmed`），吸附瞬间 `FED9: 05` 在 `< 50ms` 内到达；
  - **底座刚唤醒/断线恢复场景**：静默守望建连并在 3 步握手前订阅 `FED9`，激活后立即收到在座状态并触发同一套上升沿反馈。

### 1.4 物理机械问候与音频提示音归属
- **云台抬头归中问候（`BodyRuntime`）**：
  - 在 `onDockChange(true)` 上升沿且握手已完成、无活跃运动租约（`activeLease === null`）时，自动执行两段式问候：先微抬至 `67°`，`240ms` 后归中至 `55°`（`center`）。
  - 通过 `headCommandEpoch` 代数守卫保证零干扰：任何紧随其后的显式头部控制（`head_up` / `head_down` / `head_center` / `head_set`）、脱座或断连都会递增代数并立即取消第二段归中写入。
- **双频磁吸音效（`VoiceAudio::play_dock_cue` + `VoiceRuntime.playDockCue`）**：
  - 复用 `VoiceRuntime` 持有的唯一 `VoiceAudio` 实例，避免破坏 `AUDIO_OWNER` 单流约束或打断 KWS 唤醒流；
  - `VoiceAudio::play_dock_cue(docked: bool)` 在 24kHz 输出队列合成短促提示音（吸附为清脆双音上行 `587Hz → 1175Hz`，脱座为轻柔下行 `880Hz → 587Hz`），同时更新 `suppress_until_sample` 防止本地唤醒模型自激；
  - 当 `VoiceRuntime` 处于 `idle`（未开启唤醒词或未配语音凭证）时，以 `audio.start(false)` 纯播放模式（不触发麦克风权限弹窗）临时打开输出流并在播放排空后自动关闭；处于 `speaking` 时跳过提示音以免打断语音播报。

## 2. 首屏状态同步与多模态交互（`apps/nsh/store.ts`）

1. **首屏常驻状态同步**：
   - 将应用前后台状态 `lifecycle() === "active"` 同步至 `runtime.setBodyForegroundActive(active)`（进入后台时自动暂停静默重连定时器并确保电机急停，回到前台立即唤醒守望）；
   - 当 `bodyStatus().connected`、`activeSpace() === "body"`，或处于 `real_ble && autoConnect && Boolean(savedDeviceId)` 守望状态时，前台保持 `250ms` 状态同步，确保首屏无需进入「底座」管理空间即可感知自动建连与吸合事件。
2. **在座边沿触发（Edge Trigger）**：
   - **吸附上升沿（`!prevDocked && nextDocked`）**：
     - **表情**：设置 `1800ms` 瞬态表情覆盖 `dock_snap`（若当前处于 `speaking` / `listening` / `connecting` / `thinking` 高优交互态则不抢占，超时后自动回落）；
     - **轻提示**：调用 `notify(t("dockAttachedToast"))` 在首屏顶部浮现 `LightToast`（“底座已吸合就绪”）；
     - **音效**：调用 `voice?.playDockCue(true)`；
     - **机械问候**：由 `BodyRuntime` 自动驱动云台完成 `67° → 55°` 抬头归中致意。
   - **脱座下降沿（`prevDocked && !nextDocked && next.connected`）**：
     - 设置 `1400ms` 瞬态表情覆盖 `undock_float` 并播放轻柔脱座音效 `voice?.playDockCue(false)`。
3. **管理界面文案同步**：
   - 将「底座」空间开关文案从“启动时连接上次底座”更新为“自动重连上次底座”（英文 `"Auto-reconnect last dock"`）。

## 3. 验证计划
- **`@super-looi/nsh` 运行时单测（`body-runtime-cases.ts` / `voice-runtime-cases.ts`）**：
  - 验证启动时外设离线、随后上线广播时的静默自动重连与 `FED9: 05` 自动就绪；
  - 验证意外断线后的自动重连 vs 手动 `disconnect()` 后的断开保持（`manualDisconnectHold`）；
  - 验证在座上升沿触发的 `67° → 55°` 云台问候，以及紧跟手动头部指令时的 `headCommandEpoch` 无冲突抢占取消；
  - 验证 `VoiceRuntime.playDockCue` 在 `idle`（纯输出流自动启停）、`standby`（复用 KWS 流）与 `speaking`（静默跳过）三种状态下的行为。
- **NSH 构建与 Headless UI 测试（`nsh check`、`nsh build`、`cargo test`）**：
  - 验证 `BodySpaceView` 新开关文案、模拟吸合切换后首屏 `LightToast` 与表情状态响应。
- **Android 真机验证（魅族 20 Pro）**：
  - 构建并安装更新后的开发宿主 APK 至真机，核验首屏启动、模拟/蓝牙底座交互与日志无异常。
