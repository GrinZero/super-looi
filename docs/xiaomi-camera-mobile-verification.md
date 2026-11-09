# 手机米家摄像头 HLS：接口与实测记录

日期：2026-11-10，设备：魅族 20 Pro。开发宿主内使用原 `com.superlooi.app` namespace 和已有 MIoT OAuth scope；没有重新登录、复制 vault、连接外部 HA 或转发媒体端口。

## 真实接口结果

| 设备 / 接口 | 结果 | 媒体证据 |
|---|---|---|
| 两台 `isa.camera.hlc7`：`8/3 get-stream-configuration` | HTTP 200，顶层及动作 code 都为 0，原始输出为 `[1,0]` | 这是 Alexa 服务的配置响应；正式 HLS 会话只使用 Google HLS 服务自身的状态与配置 |
| 两台 hlc7：`9/1 start-hls-stream`，输入 `[1]` | 顶层及动作 code 都为 0，返回 HTTPS `.m3u8` 地址 | 证明现有 OAuth 可取得地址，媒体访问结果见下文 |
| 大厅 `chuangmi.camera.039a01`：`6/1 start-p2p-stream` | 顶层及动作 code 都为 0，`out=[]` | 没有返回地址或 P2P 会话参数 |
| 大厅：当前 HA OAuth 主机的 `device/miss_get_vendor` | HTTP 404 | 该主机未提供此路由；不能据此判定其他视频授权接口的权限 |

所有本次成功启动的 HLS 都发送了对应 `9/2 stop-stream`，大厅 P2P 发送 `6/2 stop-stream`；这些停止动作均返回顶层及动作 code 0。播放器测试结束时清除了原生视图。未测量米家云端最终释放资源的时刻。

原始规格的 HLS 输入关联 `video-attribute`，输出关联 `stream-address`。正式代码从每台设备的 spec 关联动作 ID、入参值和输出位置；不会将所有型号硬编码成同一组 service/action ID。大厅只提供 P2P 动作，本轮显示“实时视频暂未接通”，保留原有设备控制。

## 地址可用性与播放器

第二轮的样本按当轮清单序号记录，没有将序号当作跨轮设备身份：

- 样本 1：master HTTP 200，MIME 为 `application/vnd.apple.mpegurl`，87 字节，含 `EXTM3U` 与 `EXT-X-STREAM-INF`。master 未见 KEY/MAP，子 playlist 的 HEAD 返回 200。原生 `Video` 触发 prepared（`onLoad`），尺寸 640×360，随后播放时间推进。
- 样本 2：媒体请求失败，原生返回 `media error 1 (-1004)`，未 prepared、未推进。

该轮没有保存实际画面或首帧事件，prepared/进度不能代替目视首帧、实时性或硬件解码结论。master 不含 KEY 也不能说明子 playlist 没有加密。

第三轮按米家 inventory 中的房间区分卧室、天台：两台都返回 `cn01.livestreaming.io.mi.com` 的 HTTPS 地址，但首次及同地址重取 master 都为 HTTP 404、空响应，没有 child、片段、codec 或 MEDIA-SEQUENCE 可分析。该轮开发热更新替换了探针视图，原生播放部分不用于判断媒体；HTTP 请求及停止动作的返回记录保留在 [房间诊断日志](artifacts/camera-mobile-direct/room-diagnostic-server.log)。随后恢复了原 8790 会话并移除了 8792 转发。

没有证据把这些 404 归因于播放器编码能力，也没有稳定起播、跨五分钟播放或 15 分钟稳定性结论。

## 正式实现

- `packages/home-assistant/src/camera/miot-camera.ts`：spec 驱动的能力发现；单次观看的 `ready` / `close` 接口。明确关闭、忙碌和未知状态分开处理；没有开机或更改隐私设置的动作。
- `HomeRuntime`：持有一个观看 owner，先关闭上一会话，再开始下一会话。旧账号 client 保留到晚到 start 清理完成，不走已失效的 dashboard generation fetch。
- `store`：离页、切账号、后台或 native error 时先卸载播放器，再关闭观看会话。只保存当前播放状态，URL 不写入配置或设备快照。
- `HomeSpaceView`：摄像头详情以 appliance ID 保持节点；控件继续从 accessor 读取实时状态。普通“连接实时流”按钮已移除，剩余云台/重启控制仍可使用。首页不创建播放器，分辨率来自 native 事件。

## 验证与设备状态

HA 包 51 项测试、Runtime 摄像头时序 2 项、NSH 类型检查及构建通过。时序覆盖读取挂起时退出不再 start、晚到成功与未知网络结果的一次清理、明确拒绝/忙碌不 stop，以及切账号后用原 client 关流。

[真实 NSH 引擎节点日志](artifacts/camera-mobile-direct/native-node-lifecycle.txt)记录同一 Video 节点经历三次 dashboard 替换后保持身份，退出详情后数量为 0。这个测试覆盖节点生命周期，不覆盖真实视频性能。

正式 App 已构建并送达开发宿主；开始正式详情验收前，USB 连接消失，核验为同一 serial 的 WiFi ADB 随后 offline，重新连接超时。因此没有取得有效的正式详情 PSS/RSS/CPU、截图、首帧、延迟或长播数据。[采样结果说明](artifacts/camera-mobile-direct/performance.txt)不包含播放性能数值。

本次临时 8792 服务已停止。手机离线时无法发送恢复 8790 的 Intent，也无法查询最后一次 WiFi 8792 转发是否已随断线移除；设备恢复连接后应先恢复 8790 并检查移除 8792 转发。原 8790 开发服务保持运行。没有安装新宿主或测试 helper，没有新增 8123 转发。
