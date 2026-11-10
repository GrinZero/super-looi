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

本次临时 8792 服务已停止。手机离线时无法发送恢复 8790 的 Intent，也无法查询最后一次 WiFi 8792 转发是否已随断线移除。交付前复查时 8790 也已无监听；设备恢复连接后需在当前 root 工作树启动 8790、切回该开发会话，并检查移除 8792 转发。没有安装新宿主或测试 helper，没有新增 8123 转发。

## iOS 复测与原接入流程审计（2026-11-10）

iPhone 16e、iOS 26.3 模拟器在米家登录后加载了 44 台设备。卧室与天台在正式详情均未出现画面；AVPlayer 的媒体请求收到 HTTP 404，CoreMedia 错误为 `-12938`，随后出现 AVPlayerItem 与 AVPlayer 的析构日志。原生日志见 [native-player.log](artifacts/camera-ios-direct/native-player.log)。失败发生在播放列表获取阶段，尚未进入可用于评估解码、首帧和播放内存的阶段。

`f124d87` 接入的调用链为：

1. `DirectMiotTransportAdapter.discover()` 从规格中的 `start-hls-stream` 发现能力。
2. `HomeRuntime.startCamera()` 使用现有 OAuth 创建客户端，交给 `createMiotCameraSession()`。
3. 会话读取电源与同服务流状态，调用 Google Home 服务 `9/1`、输入 `[1]`，提取 `out[0]` 的地址。
4. store 保存该 URL，`CameraMonitor` 把它直接传给 NSH `Video.src`。
5. 原生加载失败后，store 卸载 Video，runtime 调用 `9/2` 结束会话。

这条链只实现了 MIoT 动作到云 HLS 播放器的接线，没有实现 MISS/CS2 的密钥协商、摄像头媒体连接和编码帧接收。大厅的 `p2p_pending` 正是未实现取流的分支。

### 同设备初始化对照

保持卧室同一台摄像头、同一 OAuth、同一 `9/1 in=[1]`，对比直接 start 与先 `9/2 stop` 再 start。两次开流和停止动作均为 HTTP 200、顶层及动作 code 0；返回 142 字节 URL，分别指向 `cn02`、`cn01.livestreaming.io.mi.com`。原样 GET 两个新返回地址均为 HTTP 404、零字节响应。第二次预先 stop 的动作也确认成功。结构化结果见 [comparison.json](artifacts/camera-ios-direct/comparison.json)。

因此，该样本已排除“只需补开流前 stop 即可恢复”的解释。404 是新返回地址的实际 HTTP 结果；单凭这个响应还不能区分米家端会话建立、设备上传或云转码资源环节的内部原因。

### 原探针与参考实现的缺口

原 session 的探针在 `onProgress.currentTime > 0` 时立即置空 source、销毁 Video，然后 stop。那次 master GET 200、child HEAD 200、640×360 的 onLoad 和瞬时进度仍是有效事件记录，但没有画面留证、媒体片段或持续播放记录，不能据此认定真实直播已经跑通。

参考实现 `MiotCameraEntity.async_get_stream_address()` 在获取新地址前执行 stop→start，并解析期限；没有期限输出时使用 270 秒的更新周期。当前会话没有期限与续流接口。hlc7 的实际 start 输出规格只有 URL，`expiration-time` 虽在服务中声明，却不属于该动作输出，不能从属性范围推导本次会话期限。[参考源码](https://github.com/al-one/hass-xiaomi-miot/blob/829d61206610d8c3cc697594d57393cc258ecb6e/custom_components/xiaomi_miot/camera.py#L439)

该组件维护者在同型号 hlc7 的 Issue #1744 中于 2025-12-01 明确表示组件不支持实时视频流，且没有支持计划。这使其遗留 HLS 代码不足以作为本项目直播可用性的依据；这一声明也不等于证明米家所有 HLS 服务已关闭。[维护者回复](https://github.com/al-one/hass-xiaomi-miot/issues/1744)

现有证据支持的结论是：该 HLS 接入尚未完成真实媒体闭环；当前可复现的直接失败点是米家新返回播放地址的 HTTP 404，另有独立的续流功能缺失。
