# LOOI BLE 初始化真机对照（2026-11-08）

测试设备：魅族 20 Pro、同一台广播名为 `LOOI Robot` 的底座（地址 `ec:64:c9:aa:54:96`）、NSH Android 开发宿主。

| 初始化流程 | 真机结果 |
| --- | --- |
| [社区流程](https://github.com/andrey-tut/LOOI-Robot/blob/main/docs/PROTOCOL.md)：`FEDA:01` → 订阅 `FED5/FED9` → `FEDA:03` → `FED0:0000`，随后每约 30 ms 写 `FED0`；本次实现尚未执行其 `FED8` 读取 | 22:41:45.150 建立 BLE 连接，22:41:50.159 对端断开，Android 报告 `reason=19`。日志显示两次 CCCD（客户端特征配置描述符）写入回调，以及断开前持续约 30 ms 一次的特征写入回调。 |
| 对照流程：`FEDA:03` → `FEF0:时间` → `FEDA:8101` → 订阅 `FED9` → `FED0:0000`，随后每约 30 ms 写 `FED0` | 22:45:30.659 建立 BLE 连接，至开发宿主 22:51:57 重启时才断开，持续约 6 分 27 秒；Android 日志继续出现约 30 ms 一次的写入回调。此轮订阅顺序与既有实现不同，可能错过一次性在座通知。 |

当前采用本设备既有的 `FED9` 先订阅、三步握手顺序，并保留持续 `FED0` 写入。对照说明社区流程在这台底座上未完成持久连接，且持续运动心跳本身不足以解决 5 秒断开。两组流程同时改变了 `FEDA` 负载、`FEF0` 时间写入及通知订阅顺序，尚不能单独归因到其中某一个字节或步骤；`FED8` 读取也未在本次社区流程中验证。

## 协议层能力（2026-11-09）

驱动现提供 `motionToPayload(speed, turn)`，以两个 `-127..127` 的有符号值生成 `FED0` 帧。`BodySupervisor.setMotion(lease, speed, turn)` 在现有动作租约内设置持续重发的运动帧；四方向预设使用纯轴指令 `7f00`、`8100`、`007f`、`0081`。

`BodySupervisor.readPowerStatus()` 按需读取 `FED8` 两字节，返回 `batteryPercent` 与 `externalPower`，并将最近一次结果保存在驱动快照中。Android/iOS 原生桥接均新增 GATT 读取回执。`BodySupervisor.setLightBrightness(level)` 以 `0..255` 设置 `FED2`，现有 `setLight(true)` 使用默认亮度 `128`（`80`）。本轮保持既有握手，界面仍只提供方向轮盘和灯光开关。

读取 `FED8` 和等待 `FED2` 写入回执时，驱动按顺序执行这些 GATT 操作，暂停运动心跳两个周期后发起请求，完成后恢复心跳。

协议编码与桥接回执已通过自动测试；`FED8` 读取、方向实际物理效果和亮度仍需同一底座真机核对。
