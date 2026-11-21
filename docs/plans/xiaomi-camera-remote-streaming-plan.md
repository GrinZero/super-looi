# 大厅米家监控公网直播方案

## 选路规则

每个新的预览或 Agent 取帧会话先用局域网。若云端返回的中继参数可用，局域网握手、TCP 与 MISS 鉴权共用 4 秒期限，发出开流命令后给解码首帧 4 秒。局域网地址不可用、会话传输失败或首帧超时后，关闭局域网连接，在同一观看会话中清理本次尝试的解码状态，获取新授权并连接公网中继。设备明确拒绝鉴权与原生解码失败直接返回原因。能够解码首帧后，会话持续使用选中的路径。

Super LOOI 的 Rust 摄像头模块内实现 **CS2 公网媒体中继**。App 用已有的小米视频账号向小米云为 `chuangmi.camera.039a01` 申请会话，再直连小米的 CS2 中继。用户在外面用 4G/5G 或其他 Wi-Fi 时仍从同一个监控详情页观看，家里只需让摄像头保持联网。

LAN 路径从云端设备列表读取 `localip`，先走 UDP 协商，再连接设备返回的 TCP 端口。`Cloud::provision` 通过 `miss_get_vendor` 取得会话密钥和签名，并从 CS2 回执解析设备标识和中继发现参数。公网模块通过 UDP 承载同一个 MISS 会话的命令和媒体通道，两条路共用原生媒体解密与解码。[云授权](../../apps/nsh/src/camera/cloud.rs)、[传输和 MISS 会话](../../apps/nsh/src/camera/transport.rs)

## 为什么优先验证中继

| 路径 | 已有证据 | 对大厅机型的判断 |
| --- | --- | --- |
| 小米 CS2 公网媒体中继 | `micam` 作者记录了 `chuangmi.camera.029a02` 和 `chuangmi.camera.ipc019` 的远程取流，MijiaDeck 使用同一组件。go2rtc 的一个衍生提交也包含媒体中继实现。 | 大厅机型已在 Super LOOI 通过 CS2/TCP 局域网出图。公网中继的账号、机型和固件兼容性需要实测。 |
| 公网协调后直接连摄像头 | 未合并的 go2rtc #2264 原版在公网 VPS 上实测 C302n，媒体由摄像头直送客户端；讨论里另有改版对 HLC8 跨 NAT 的实测。#2631 从云端发现地址，实测是中区门铃同网播放。 | 云端协调成功无法保证蜂窝网络后的媒体可达。优先验证实际经中继传输的链路。 |
| 官方独立应用授权或 HLS | 小米的公开控制端文档描述设备状态与控制，摄像头插件的原生接口由米家 App 提供。官方 HA 集成没有视频。大厅机型的 MIoT `start-p2p-stream` 实测无地址输出。 | 公开接口里尚未找到适用于该机型、可供独立 App 使用的稳定公网视频接口。 |
| 家庭 VPN | Tailscale 子网路由支持从 iOS/Android 访问家中的设备私网地址。Linux 内核模式转发 UDP 和 TCP。 | 自用可通过家用路由器或专用网关尝试，手机需要 VPN，家里的网关需要常在线。现有 App 无需改代码，实际 UDP 握手和动态 TCP 端口仍需验证。 |

[micam 实测与协议说明](https://github.com/eugeneRover/micam#supported-cameras)、[MijiaDeck 预览实现与来源](https://github.com/Songmanual/MijiaDeck#摄像头预览--experimental-camera-preview)、[go2rtc 媒体中继衍生提交](https://github.com/kisharora/go2rtc/commit/76b3e456c2f1dda97cce9f2797a668818e165488)、[go2rtc #2264](https://github.com/AlexxIT/go2rtc/pull/2264)、[go2rtc #2631](https://github.com/AlexxIT/go2rtc/pull/2631)、[小米独立控制应用文档](https://iot.mi.com/new/doc/accesses/direct-access/other-platform-access/application-access)、[米家插件 SDK](https://iot.mi.com/v2/new/doc/plugin/quickstart/plugin-principle)、[小米 HA 集成答复](https://github.com/XiaoMi/ha_xiaomi_home/discussions/78)、[大厅取流实测](../xiaomi-camera-community-verification.md)、[大厅 MIoT 动作实测](../xiaomi-camera-mobile-verification.md)、[Tailscale 子网路由](https://tailscale.com/docs/features/subnet-routers)、[Tailscale 转发模式](https://tailscale.com/docs/reference/kernel-vs-userspace-routers)

`micam` 的公开仓库未标注许可证，MijiaDeck 也记录了上游分发授权未确认。它的机型报告可用于判断优先级。实现时使用出处和许可明确的参考材料，核对衍生补丁涉及的上游来源。路由器、家庭服务器和桌面开发机都不需要持有 App 的米家登录态。

## 实施与验收

1. **先核实授权结果。** 在横屏真机开发包中用 App 已登录的视频账号为大厅摄像头请求 `miss_get_vendor`。确认实际 `vendor`、账号地区，以及响应是否含可用的 `p2p_id` 和 `init_string` 等中继发现所需信息。执行记录只保留字段存在性、失败阶段和服务错误，不写入签名、密钥或会话凭据。
2. **在 App 内打通公网媒体。** 在现有 Rust `camera` 模块里补中继发现、建连和 UDP 通道收发，沿用 `Miss` 边界向上交付命令回执和视频包。预览与 Agent 取帧继续从同一原生会话消费。新增复杂度集中在 UDP 包的确认、重传和顺序处理，以及中继会话退出。验证期间让该次请求明确走公网中继，便于确认实际取流路径。[已有 MIT 实现的 CS2 UDP 收发参考](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/protocol/cs2.py)
3. **用真实首帧决定是否产品化。** 关闭手机 VPN，用同一台 `039a01`，分别在 iPhone 5G 和外部 Wi-Fi 打开详情。核对公网中继建连、MISS 认证、真实首帧、持续播放及退出重开。记录首帧时间及失败阶段、底层错误码和可定位原因。如果授权或媒体失败，同一网络下用官方米家 App 做对照。验证通过后再决定如何在正常打开详情时选择本地与公网路径，并复测 Android 和局域网直播。

家庭 VPN 方案可以独立使用。确认摄像头当前 LAN IP 后，由支持 Tailscale 的家用网关发布该摄像头的主机路由（`/32`），授权手机访问该地址，然后用手机蜂窝网络测试现有详情页首帧。网关需要允许协议实际使用的 UDP 和协商出来的 TCP 端口。验证先使用 Linux 内核转发，便于定位不同源端口的 UDP 回包是否被 NAT 丢弃。[Tailscale 子网路由配置](https://tailscale.com/docs/features/subnet-routers/how-to/setup)
