# 米家摄像头独立取流：一手证据

运行位置约束：本项目使用手机内置的 `@super-looi/home-assistant` / `direct_miot`，摄像头实现须在手机进程内执行。下文 HA 服务器集成只作为协议参考，不是项目部署路线；实施边界见 [手机端方案](plans/xiaomi-camera-streaming-plan.md)。

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

## 不新增常驻进程：增量调查

用户约束为不新增常驻进程，因此上文独立 go2rtc、SDK bridge 的运行方式不能直接作为实施结论。下面区分“复用现有 HA 进程”“按观看启动 FFmpeg 子进程”与“新增 daemon（常驻服务）”。

### MIoT 直接返回播放 URL 的可能性

`hass-xiaomi-miot` 固定版本 `829d61206610d8c3cc697594d57393cc258ecb6e`（manifest `1.1.5`）的 `MiotCameraEntity` 确有 `async_get_stream_address()`：寻找 Google/Alexa 流服务，调用 `start_hls_stream` / `start_rtsp_stream`，传入 `video_attribute`，从 action 输出提取 `stream_address`，并按有效期刷新。这段 URL 获取本身在 HA Python 进程内执行。但其快照/MJPEG 路径用 `haffmpeg`，并非所有媒体功能都没有子进程。[camera.py](https://github.com/al-one/hass-xiaomi-miot/blob/829d61206610d8c3cc697594d57393cc258ecb6e/custom_components/xiaomi_miot/camera.py)、[manifest](https://github.com/al-one/hass-xiaomi-miot/blob/829d61206610d8c3cc697594d57393cc258ecb6e/custom_components/xiaomi_miot/manifest.json)

本仓真实 `hlc7` 规格包含 siid=8 的 RTSP 和 siid=9 的 HLS 动作，入参均为视频属性、输出流地址；两台设备的流状态读取值为 1。`039a01` 只声明 siid=6 的 `start-p2p-stream`，没有 Google/Alexa HLS/RTSP 服务，也没有可直接读取的 `stream_address`。这说明 HLS URL 探索只适用于这两台 `hlc7`，不能覆盖大厅型号。规格与状态值仅描述设备能力；取得 URL、URL 获得授权、持续收到视频是另外三件事。[本仓已采集的原始规格](artifacts/home-repair-audit/capability-inventory.json)

`hlc7` 的原始 issue #1744 报告 HA 重启后能播数分钟，随后 Idle，日志为 action `-704220025`（参数数目不匹配）、空 `stream_address`。它证明曾出现短时播放和续流问题，不证明现行固件或当前集成已修复。此次未找到 `039a01` 通过该 HLS action 稳定直放的原始成功记录；云端移动事件录像 URL 与实时流不是同一种能力。[设备原始报告](https://github.com/al-one/hass-xiaomi-miot/issues/1744)

### 已存在的 HA 进程内 Python CS2 实现

发现 `Kosztyk/xiaomi_camera_native`，固定 commit `d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23`，manifest `0.3.10`，MIT。其协议层用 Python `asyncio` 实现 CS2 UDP/TCP、MISS 命令和云授权，`cryptography` 执行解密；没有调用小米原生 SDK，没有运行 go2rtc。[manifest](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/manifest.json)、[CS2](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/protocol/cs2.py)、[MISS](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/protocol/miss.py)、[许可证](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/License)

`Original` 模式在进程内把仍然编码的 H.264/H.265 视频转封装为 MPEG-TS，经 `aiohttp` 在 `127.0.0.1` 的动态端口提供给 HA `stream`；媒体接收、会话、复用和空闲退出都在现有 HA 进程中。它是视频单轨封装，本版本不提供音频。默认的 `H.264` 模式则用 `asyncio.create_subprocess_exec()` 启动 FFmpeg，快照函数也会启动 FFmpeg。因此“取流不新增 daemon”成立，但“所有模式和功能都没有新进程”不成立；若要求连按需子进程也不增加，应限定 Original，并另行处理快照及解码。[session.py](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/protocol/session.py)、[纯 Python muxer](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/protocol/media.py)、[快照子进程](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/protocol/snapshot.py)

其已记录的实机型号只有 `029a02`、`046c04`、`c301`，没有本项目两种型号。视频连接按云端 `miss_get_vendor` 返回 `vendor=4`（CS2）准入，没有将视频限定为这三种型号；PTZ 则明确限制在这三种实测型号。故本项目两种摄像头可作为视频候选实测，不能直接声称该集成已支持；音频还需补充。[云授权](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/protocol/cloud.py)、[PTZ 与型号代码](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/protocol/miss.py)、[原作者硬件记录](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/docs/PTZ_HARDWARE_VERIFICATION_2026-10-24.md)

具体筛选路径也已核对：`TARGET_MODELS` 只经 `.get(model, model)` 提供显示名；`cloud.devices()` 按 `.camera.` / `.cateye.` 发现，`config_flow.async_step_cameras()` 展示所有发现设备，`__init__.py` 为所有选中设备创建会话。故 `hlc7` / `039a01` 可被发现、选择，不需要增加视频型号白名单。[选择流程](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/config_flow.py)、[会话创建](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/__init__.py)、[camera.py](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/camera.py)

HA `2026.11.0` 已有可复用的进程内快照路径：`Stream.async_get_image()` 启动/复用 HLS provider，并交给 `KeyFrameConverter.async_get_image()`；后者在线程池中通过已有 PyAV codec context 解码关键帧，交给 TurboJPEG 输出 JPEG，没有启动 FFmpeg。可用它替换上游自定义集成的快照子进程路径，无需另加解码库；尚未收到关键帧时返回值可以为 `None`。本次同时核对了容器运行版的方法实现。[stream/__init__.py](https://github.com/home-assistant/core/blob/2026.11.0/homeassistant/components/stream/__init__.py)、[stream/core.py](https://github.com/home-assistant/core/blob/2026.11.0/homeassistant/components/stream/core.py)

### go2rtc 能否只当库使用

`pkg/xiaomi`、`pkg/xiaomi/miss` 是可被外部 Go 模块导入的包，不是 `internal` 包，也不要求运行 `main()` 或 daemon。`miss.NewClient()` / `StartMedia()` / `ReadPacket()` 可在调用进程内执行；`ReadPacket()` 返回解密后的编码包 `Packet{CodecID, Sequence, Flags, Timestamp, Payload}`，尚未解码为像素。更高层 `miss.Dial()` 返回 `core.Producer`，通过 `Receiver.WriteRTP()` 写媒体包。[公开 producer](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/pkg/xiaomi/producer.go)、[MISS client](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/pkg/xiaomi/miss/client.go)、[MISS producer](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/pkg/xiaomi/miss/producer.go)

云端 `Cloud.Login` / `Request` 也公开，但 `getCameraURL` / `getMissURL` 的 DID→密钥/签名 URL 组装留在 `internal/xiaomi`，外部 Go 模块不能直接调用这些私有函数。因此只 import `xiaomi.Dial(xiaomi://账号@IP?did=...)` 并不等于 daemon 那条完整接入流程；嵌入者还要整合云授权和参数组装。[云接口](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/pkg/xiaomi/cloud.go)、[内部接入层](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/internal/xiaomi/xiaomi.go)

CS2 传输自身只用 Go 标准库；加密用 `golang.org/x/crypto`，媒体 producer/core 使用 `pion/rtp`、`pion/sdp/v3` 等。上游没有现成 C ABI，也没有 `//export` 的 cgo 接口；若要嵌入已有 Rust/Python 进程，需要自己编写 cgo `c-shared` / `c-archive` 包装、对象句柄和帧回调，并增加 Go 构建链。这是 Go 库复用方案，不是已有官方 C SDK。[CS2](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/pkg/xiaomi/miss/cs2/conn.go)、[加密](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/pkg/xiaomi/crypto/crypto.go)、[模块依赖](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/go.mod)

本次定向检索没有找到可直接复用、已有这两种摄像头验证的 Rust CS2 库；已确认的进程内替代实现是上述 Python 项目。

### 复用 HA 已有 go2rtc 的限制

本机 HA Container 的只读进程检查已发现 HA 管理的 go2rtc `1.9.15` 子进程。HA `2026.11.0` 的 `server.py` 通过固定 `_APP_MODULES` 启用模块，其中没有 `xiaomi`；YAML 配置没有开放 `modules` 设置。go2rtc 主程序会按启用模块列表初始化 Xiaomi source。因此“系统已有 go2rtc”不能推出“现有实例可直接接受 `xiaomi://`”；启用它涉及 HA 管理逻辑或扩展方式，不能只添加一条 stream URL。[HA server.py](https://github.com/home-assistant/core/blob/2026.11.0/homeassistant/components/go2rtc/server.py)、[go2rtc main.go](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/main.go)
