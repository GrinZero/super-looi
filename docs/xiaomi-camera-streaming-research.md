# 米家摄像头独立取流：一手证据

调研日期：2026-11-10。目标设备来自本仓真实设备清单：卧室与天台各一台 `isa.camera.hlc7`，大厅一台 `chuangmi.camera.039a01`。本文记录上游事实；集成设计见 [集成方案](plans/xiaomi-camera-streaming-plan.md)。

## 核对的源码版本

| 项目 | 版本 | 主要用途 |
| --- | --- | --- |
| AlexxIT/go2rtc | 最新稳定版 `v1.9.15`，`7c05066c90ab6ad1fccb506d5f0408aa31ebe60f`，2026-10-25 发布 | 自行实现米家取流与转发 |
| XiaoMi/xiaomi-miloco | `05cdb1c77310afcfb77e64349bfb5efbeebded05` | 官方 Python MIoT SDK 与摄像头原生库 |
| willjayyyy/ha-xiaomi-camera | `73ce5fdef19cbbec56e8c54e332bbda2042ad411`，HA 集成版本 `2.0.1` | SDK/go2rtc 桥接为 HA camera 实体 |

稳定版来源：[go2rtc release](https://github.com/AlexxIT/go2rtc/releases/tag/v1.9.15)。其余两项按上述 commit 阅读，避免把分支后续变化当成本次结论。

## 官方 HA 集成与视频权限

小米官方 `xiaomi_home` 明确不提供摄像头视频流：米家 App 与摄像头另行协商视频密钥，普通 HA 集成不能据此获取视频。设备在线、读取到摄像头属性或 OAuth 登录成功，均不能推出视频链路可用。[官方功能说明](https://github.com/XiaoMi/ha_xiaomi_home/wiki/Features-that-will-not-be-implemented#camera-video-stream)

go2rtc 的授权路径与 HA OAuth 不同。`api/xiaomi` 接收账号密码及可选验证码，完成登录后保存 `userID → passToken`；后续再换取 `serviceToken` 和 `ssecurity`。请求摄像头时生成密钥对，调用 `/v2/device/miss_get_vendor` 获取签名、设备公钥和协议厂商，再建立本地 P2P 会话。官方 HA 的 `access_token` 不是这些凭据，不能直接放进 go2rtc 配置。[go2rtc 接入代码](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/internal/xiaomi/xiaomi.go)、[账号实现](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/pkg/xiaomi/cloud.go)

Miloco 的 OAuth 客户端 ID 为 `2882303761520431603`；官方 HA 使用 `2882303761520251711`。Miloco 也不能按同一授权会话处理。[Miloco 常量](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/const.py)、[HA 常量](https://github.com/XiaoMi/ha_xiaomi_home/blob/main/custom_components/xiaomi_home/miot/const.py)

## 两种型号的证据强度

| 型号 | 一手记录 | 能得出的结论 |
| --- | --- | --- |
| `isa.camera.hlc7` | go2rtc 作者维护的型号表列为 CS2/UDP、HEVC/H.265 + PCMA，分辨率 2304×1296 / 640×360；同页指出初始 SD 画质的 H.265 SPS 参数有问题 | 存在明确的成功取流记录，首次连接与画质切换应实测 |
| `chuangmi.camera.039a01` | MiBeeNvr 项目贡献者在 2026-08-07 的调查中，记录其生产环境该型号解析为 `vendor=cs2` | 支持把它作为 CS2 候选验证；这条记录不能等同于 go2rtc 已验证通过 |

来源：[go2rtc 作者型号表 #1982](https://github.com/AlexxIT/go2rtc/issues/1982)、[MiBeeNvr 原作者调查 #167](https://github.com/Mi-Bee-Studio/MiBeeNvr/issues/167)。后者可在页面搜索 `2026-08-07` 和型号定位。

另有 go2rtc 用户报告 `hlc7` 正常输出 H.265 与音频，问题设备是另一台旧型号；这是辅助成功记录。[原始报告 #2273](https://github.com/AlexxIT/go2rtc/issues/2273)

Miloco 当前 `camera_extra_info.yaml` 按设备类别加拒绝清单过滤；这两个型号均未被拒绝。未命中拒绝清单只说明 SDK 接受其型号，不证明实际可播放。SDK 中确实实现了该过滤逻辑。[型号配置](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/configs/camera_extra_info.yaml)、[摄像头实现](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/camera.py)

## go2rtc 的运行条件与媒体输出

- 每次连接摄像头需要联网获取加密密钥，视频连接只走本地；因此它是“云端授权 + 局域网媒体”，不能算完全离线取流。[Xiaomi source 文档](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/internal/xiaomi/README.md)
- `v1.9.15` 提供原生 macOS ARM64 二进制。纯协议转发可单进程运行；需要视频转码时调用 FFmpeg。Docker 镜像预装 FFmpeg，而原生二进制需自行提供它。[发布及平台说明](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/README.md)、[FFmpeg 模块](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/internal/ffmpeg/README.md)
- go2rtc 的 MISS 客户端识别 H.264、H.265、PCMU、PCMA 和 Opus。实际编码由摄像头返回；`hlc7` 的社区记录为 H.265/PCMA，不能预设为 H.264/AAC。[媒体解析代码](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/pkg/xiaomi/miss/client.go)
- FFmpeg 能按观看需求启动并转成 H.264 或 AAC/Opus。macOS 支持 VideoToolbox，但上游也记录过 M1 CPU 转码优于 GPU 的结果，应按真实机器和三路负载决定是否启用硬件转码。[转码文档](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/internal/ffmpeg/README.md)、[硬件说明](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/internal/ffmpeg/hardware/README.md)
- HTTP API 默认 1984，RTSP 默认 8554，WebRTC 默认 TCP/UDP 8555；API 支持 stream 列表与播放协商，转发可与 HA 独立部署。[API](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/internal/api/README.md)、[WebRTC](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/internal/webrtc/README.md)

## Mac 与容器网络的区别

Docker Desktop 从 4.34 起可启用 host networking（主机网络），但文档明确其实现位于四层、容器不能直接绑定宿主机的接口 IP；它与 Linux 原生 host network 不等价。因此不能仅添加 `network_mode: host` 就认定摄像头发现/P2P 在 Mac 上已解决。这里是基于 Docker 明确限制的部署判断，尚未运行本项目的摄像头实测。[Docker 官方文档](https://docs.docker.com/engine/network/drivers/host/)

`ha-xiaomi-camera` 作者测得 SDK 在同 LAN 连接成功，跨 VPN 失败；其部署要求 host network，并指出 Docker bridge 会影响广播发现和 P2P。该项目的“必须 host network”是其 SDK 桥接实现要求，不应扩大为所有 go2rtc 配置在所有系统上的结论。[桥接架构](https://github.com/willjayyyy/ha-xiaomi-camera/blob/73ce5fdef19cbbec56e8c54e332bbda2042ad411/docs/ARCHITECTURE.md)

## Miloco 与 HA 桥接项目的实际依赖

Miloco SDK 是 Python ≥3.11 包，携带 Linux x86_64/ARM64 与 macOS x86_64/ARM64 预编译动态库。Python 依赖包括 PyAV、aiohttp、cryptography、Pillow、pydantic 等；因此“官方有 SDK”不代表可以仅在现有 TypeScript 包中增加几个 HTTP 请求实现视频。[依赖定义](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/pyproject.toml)、[动态库加载代码](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/camera.py)

Miloco 根许可证将授权限定于非商业 Miloco 使用，并明确未授权将其用于其他 APP、Web 服务开发；SDK 源文件引用该许可证。这是选用该依赖的具体限制，不能因为仓库可下载就按 MIT 使用。[Miloco LICENSE](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/LICENSE.md)

`ha-xiaomi-camera` 自身为 Apache-2.0，但其取流进程固定依赖 Miloco commit `eb264e8bb650ad5573d0e18962e69c6e48d2fe6d`，另带 PyAV、numpy、aiohttp、go2rtc 与 FFmpeg。其许可证不能替换 Miloco 的许可证。[项目许可证](https://github.com/willjayyyy/ha-xiaomi-camera/blob/73ce5fdef19cbbec56e8c54e332bbda2042ad411/LICENSE)、[依赖](https://github.com/willjayyyy/ha-xiaomi-camera/blob/73ce5fdef19cbbec56e8c54e332bbda2042ad411/addon/requirements.txt)、[Dockerfile](https://github.com/willjayyyy/ha-xiaomi-camera/blob/73ce5fdef19cbbec56e8c54e332bbda2042ad411/addon/Dockerfile)

HA Container 无 Supervisor 时，该集成会要求填写独立桥接地址；HA OS 才能走安装 add-on（附加组件）的流程。最终 camera 实体的 `stream_source()` 返回 RTSP URL，媒体无需经过自定义集成的 Python 代码。[配置流程](https://github.com/willjayyyy/ha-xiaomi-camera/blob/73ce5fdef19cbbec56e8c54e332bbda2042ad411/custom_components/xiaomi_camera/config_flow.py)、[camera 实体](https://github.com/willjayyyy/ha-xiaomi-camera/blob/73ce5fdef19cbbec56e8c54e332bbda2042ad411/custom_components/xiaomi_camera/camera.py)

go2rtc 本身为 MIT 许可证。[LICENSE](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/LICENSE)

## 留给设备实测的问题

1. 三台摄像头的固件版本，以及各自首帧、音频、SD/HD 切换与关闭重开结果。
2. `chuangmi.camera.039a01` 在 go2rtc `v1.9.15` 的实际媒体轨道；CS2 报告本身不能替代播放结果。
3. `hlc7` 启动时 SPS 问题是否在当前固件出现，以及主码流的稳定配置。
4. 三路同时观看时的上游会话、CPU、转码与首帧开销；同一台摄像头由 HA 与应用同时读取时是否复用一个上游连接。
