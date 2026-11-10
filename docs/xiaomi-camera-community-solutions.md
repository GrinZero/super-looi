# 米家摄像头社区取流实现

调查日期：2026-11-10。目标是把取流能力放进现有手机进程，比较可复用的公开协议源码、准确型号证据与运行成本。

## 结论

社区已有不依赖 Miloco 闭源 SDK 的 MISS/CS2 协议实现。go2rtc 提供较成熟的 Go 参考；Kosztyk 同时提供 Python 与 Node.js 移植。Node.js 版本最接近现有 TypeScript 调用层，但不能直接运行在当前 NSH：本项目的 Node 兼容层尚未接入它使用的 `dgram` / `net` socket（套接字）接口，crypto 兼容层也未导出它使用的密钥与流加密接口。

精确型号的证据不同：`isa.camera.hlc7` 有真实成功播放报告，也有最新稳定版取流超时报告；`chuangmi.camera.039a01` 有云端返回 `vendor=cs2` 的一手日志，但本次找到的记录不足以证明稳定播放。不能用 `039a04`、`039c01` 的支持记录替代 `039a01`。

2026-11-10 本地补验已完成：三台目标摄像头均通过 CS2/TCP 取得约 20 秒真实 H.265 视频，并通过完整解码；下表仍用于区分各社区项目自身的证据。具体结果与请求差异见 [实测记录](xiaomi-camera-community-verification.md)。

## 源码版本

| 项目 | 核实版本 | 协议与运行形式 | 对本项目的用途与成本 |
| --- | --- | --- | --- |
| [Kosztyk/xiaomi_camera_native](https://github.com/Kosztyk/xiaomi_camera_native) | `d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23` | Python MISS/CS2，Home Assistant 集成 | MIT 协议源码可供移植；原始码流模式不转码，默认 HA 输出仍调用 FFmpeg。需替换 Python 网络与加密调用，去掉 HA 外壳。 |
| [Kosztyk/homebridge-xiaomi-camera-native](https://github.com/Kosztyk/homebridge-xiaomi-camera-native/tree/8b537ea4f210908b46e5e5d7c21063da0fdc1aaf) | npm 1.0.2，main `8b537ea4f210908b46e5e5d7c21063da0fdc1aaf` | MIT，纯 Node.js MISS/CS2；Homebridge 外围负责 HomeKit 与 FFmpeg | 可借鉴 JS 协议层；仍须实现原生网络与加密接口，且作者尚无实体摄像头实测。 |
| [AlexxIT/go2rtc](https://github.com/AlexxIT/go2rtc/tree/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f) | stable v1.9.15，`7c05066c90ab6ad1fccb506d5f0408aa31ebe60f`；master `990f4de3cc21d1cca917d02d0bc40f2fabe75a49` | MIT，公开 Go 云端认证、MISS、CS2、TUTK 实现；完整程序是媒体服务器 | 独立协议参考最有价值；嵌入 Go 会增加 Go runtime（运行时）和跨语言构建成本，Rust 移植则需自行维护传输状态机。 |
| [Mi-Bee-Studio/MiBeeNvr](https://github.com/Mi-Bee-Studio/MiBeeNvr/tree/d393c966892cdaeca3afc80beb139ae567dd6424) | main `d393c966892cdaeca3afc80beb139ae567dd6424` | Go NVR，内含改编自 go2rtc 的 Xiaomi/CS2/TUTK 源码 | 可补充设备日志与后续修正；整套 NVR 引入录制、数据库、Web UI 等手机取流不需要的模块。 |

go2rtc stable 到所查 master 的变化只有 GitHub 工作流与 `docker/hardware.Dockerfile`，没有 Xiaomi 协议更新。切换 master 本身没有对应的协议修复依据。[版本对比](https://github.com/AlexxIT/go2rtc/compare/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f...990f4de3cc21d1cca917d02d0bc40f2fabe75a49)

## 精确型号的社区证据

| 型号／方案 | 已知事实 | 不能由此推出的结论 |
| --- | --- | --- |
| `isa.camera.hlc7`，go2rtc | 维护者的工作型号表列出 MJSXJ03HL / BHR5255GL，`cs2+udp`、HEVC/PCMA、2304×1296 与 640×360；表中注明起流可能先给 SD，影响 H.265 SPS 参数。[#1982](https://github.com/AlexxIT/go2rtc/issues/1982) | 不代表所有区域、固件、网络均可连接。 |
| `isa.camera.hlc7`，使用者播放记录 | #2273 的问题对象是另一台 `ipc019e`，但作者提供了正常工作的 hlc7 对照，显示 `xiaomi/miss`、`cs2+udp`、H.265 与音频。[#2273](https://github.com/AlexxIT/go2rtc/issues/2273) | 后续有关 ipc019e 音频失败的评论不能算作 hlc7 音频失败。 |
| `isa.camera.hlc7`，v1.9.15 失败记录 | 2026-11-07 的 #2659：sg 区域，发现设备成功，视频 UDP 超时；其中 hlc7 位于独立 VLAN。作者的同子网失败样本实际是 hlc6。[#2659](https://github.com/AlexxIT/go2rtc/issues/2659) | 没有证据证明该 hlc7 在同子网也失败；Issue 尚无根因结论。 |
| `chuangmi.camera.039a01`，MiBeeNvr | 2026-08-07 的生产环境日志列出此准确型号，返回 `vendor=cs2`。同一条评论描述三台摄像头约两小时发生四百次重连，作者定位到云端返回另一网段、不可达的私有 IP。[#167](https://github.com/Mi-Bee-Studio/MiBeeNvr/issues/167) | 这是厂商协议与地址问题的线索，不能计为稳定出图成功。 |
| `chuangmi.camera.039a01`，go2rtc 型号表 | 所查 #1982 没有该准确型号；存在 `039a04`、`039c01` 等其他型号。[#1982](https://github.com/AlexxIT/go2rtc/issues/1982) | 相似型号不能视作同型号验证。 |

## 用户指定的 xiaomi_camera_native：实际取流过程

固定版本为 0.3.10。根目录与集成目录均为 MIT 许可证；NOTICE 明确标注其协议代码改编自 go2rtc，既不打包或执行 go2rtc，也不包含小米原生 SDK。这提供了独立于 Miloco 闭源产物的源码基础。[许可证](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/License)、[来源说明](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/NOTICE)

实际调用顺序如下：

1. **账号会话**：账号密码登录或 `userId + passToken` 恢复 `xiaomiio` 会话，取得 `serviceToken` 与 `ssecurity`。云请求使用 RC4-drop1024 与签名，而非 HA OAuth Bearer token。
2. **取得摄像头会话参数**：本机生成 X25519 密钥对，请求 `/v2/device/miss_get_vendor`，提交设备 DID、公钥和 `support_vendors=TUTK_CS2_MTP`。当前实现只接受 `vendor.vendor == 4`（CS2），取得设备公钥与签名；没有实现 TUTK、Agora 或 MTP。
3. **连接局域网设备**：向摄像头 IPv4 的 UDP 32108 端口探测，经打洞应答协商 UDP 或 TCP 与连接端口，再处理数据分片、顺序、ACK 和保活。它没有云中继路径。
4. **MISS 认证和起流**：X25519 共享秘密再经 HSalsa20 派生会话密钥；命令 `0x100` 提交公钥和签名，收到 `result=success` 后发送加密的 `0x102` 起流命令。`enableaudio=0`，当前只取视频。
5. **拿到编码帧**：媒体 channel 2 的数据按 32 字节帧头解析 codec、序号、flags 与毫秒时间戳，再使用 8 字节 nonce 的 raw ChaCha20 解密。codec 4/5 分别为 H.264/H.265，`MissClient.read_video()` 返回元数据与编码 payload，未经过视频解码。

对应源码：[cloud.py](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/protocol/cloud.py)、[cs2.py](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/protocol/cs2.py)、[crypto.py](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/protocol/crypto.py)、[miss.py](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/protocol/miss.py)。

### 协议层与 HA 播放外壳的区别

协议目录约 2,259 行，包含云请求、CS2、MISS，也包含会话管理、TS 封装和快照等外围代码。协议用 Python 实现，但调用 `aiohttp` 与 `cryptography`；`manifest.json` 的 `requirements: []` 不能解释为没有这些运行依赖，它们来自 HA 环境。[manifest](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/manifest.json)、[协议目录](https://github.com/Kosztyk/xiaomi_camera_native/tree/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/protocol)

`session.py` 把解密编码帧交给纯 Python `MpegTsMuxer` 重封装。选择 Original 时直接发布 MPEG-TS，不转码；默认 H.264 模式则启动 FFmpeg 子进程，使用 `libx264 ultrafast zerolatency` 软件编码，默认最高 720p。随后本地 `127.0.0.1` HTTP 服务把媒体交给 HA stream 播放链。因此“不需要 go2rtc”并不等于默认播放没有子进程。[session.py](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/protocol/session.py)、[media.py](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/custom_components/xiaomi_camera_native/protocol/media.py)

对手机有用的提取边界是 `read_video()` 的编码帧，避免为手机引入 HA、Python 运行时、FFmpeg 与本地 HTTP 播放外壳。相应成本是实现手机可用的云端会话、网络和加密接口，并把编码帧接入原生解码与显示。当前 `Video.src` 消费 URL，不能直接把 Annex B 字节数组当作 URL 播放。

### 实机证据覆盖范围

作者提供的 2026-10-24 录屏和 HA recorder 记录覆盖 `chuangmi.camera.029a02`、`chuangmi.camera.046c04`、`mxiang.camera.c301` 三个准确型号，版本为 0.3.8；验证文档说明后续版本 PTZ 命令未变化。本项目的 `isa.camera.hlc7` 与 `chuangmi.camera.039a01` 均不在其已验证列表；视频连接代码没有按这三个型号限制，三型号白名单只控制 PTZ 按钮。公开仓库现有七项测试是打包与元数据检查，不能当作协议和播放实测。[VALIDATION.md](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/VALIDATION.md)、[实机报告](https://github.com/Kosztyk/xiaomi_camera_native/blob/d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23/docs/PTZ_HARDWARE_VERIFICATION_2026-10-24.md)

## 云端授权与局域网视频是两段流程

go2rtc 的公开实现使用 Xiaomi Home 账号会话，经 `passToken` 等字段恢复登录，再以 `xiaomiio` 服务的 `serviceToken`、`ssecurity` 签名并加密请求 `/v2/device/miss_get_vendor`。该接口返回厂商、设备地址、设备公钥和会话签名；随后本机才通过 CS2 建立局域网连接、做 MISS 认证并接收媒体。这里需要的凭据和已有 HA/MIoT OAuth access token（访问令牌）并不等价。[云端配置入口](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/internal/xiaomi/xiaomi.go)、[云端会话实现](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/pkg/xiaomi/cloud.go)

因此，发现设备成功只能证明设备列表授权有效。还需分别核实 MISS 配置请求是否成功、返回哪个厂商和地址、局域网握手是否成功、MISS 是否接受会话签名。社区的协议实现没有提供“用现有 OAuth 自动取得另一套登录凭据”的依据。

## Homebridge 的 JS 实现能复用多少

### 已存在的协议边界

`lib/cloud.js` 负责账号与会话配置；`lib/cs2.js` 负责 UDP/TCP 协商、保活、顺序重组和 ACK；`lib/miss.js` 负责认证、起流命令与编码帧；`lib/crypto.js` 负责密钥与加密。协议核心只用 Node.js 内建模块，未依赖 Miloco SDK、Python 或 go2rtc 可执行文件。[源码与上游归属](https://github.com/Kosztyk/homebridge-xiaomi-camera-native/blob/8b537ea4f210908b46e5e5d7c21063da0fdc1aaf/NOTICE)

现成插件的 npm 依赖是 Homebridge 配置 UI 与二维码库，FFmpeg 为可选分发依赖；这些属于配对与播放外壳。`session.js` 另建本地 HTTP 服务器，把 MPEG-TS 交给 FFmpeg；HomeKit 每个观看者仍会启动 FFmpeg 做 H.264 软件编码。手机进程若直接消费 H.264/H.265 帧，没有必要引入这些外围组件。[package.json](https://github.com/Kosztyk/homebridge-xiaomi-camera-native/blob/8b537ea4f210908b46e5e5d7c21063da0fdc1aaf/package.json)、[session.js](https://github.com/Kosztyk/homebridge-xiaomi-camera-native/blob/8b537ea4f210908b46e5e5d7c21063da0fdc1aaf/lib/session.js)、[FFmpeg 调用](https://github.com/Kosztyk/homebridge-xiaomi-camera-native/blob/8b537ea4f210908b46e5e5d7c21063da0fdc1aaf/lib/ffmpeg.js)

### 与当前 NSH 的接口差距

| 需求 | 上游调用 | 仓库现状与具体适配成本 |
| --- | --- | --- |
| UDP 局域网连接 | `dgram.createSocket('udp4')`、bind/send/message/close；先向 32108 发送 CS2 探测 | `nsh-node-compat/src/bundler.ts` 无 dgram 实现。需 Rust 宿主提供异步数据报 socket 与事件；这属于协议必需能力。 |
| TCP 协商结果 | `net.createConnection`、data/write/setNoDelay/destroy/writableLength | 本项目的兼容层同样未接入 `node:net`；底层 NSH 标准库有 TCP 能力，仍需适配上述 Node 调用。CS2 可能协商 UDP 或 TCP；若只支持 UDP，需明确以所测设备确实选择 UDP 为依据，不能把 TCP 当作无成本现成能力。 |
| 会话密钥 | `generateKeyPairSync('x25519')`、DER 导入导出、`diffieHellman`，随后 JS HSalsa20 | 当前 Node crypto 导出缺少这些同步接口。底层 `quickjs-jit-stdlib 0.14.1` 的 WebCrypto 已有 X25519 generate/import/export/deriveBits，可改成异步密钥接口后复用；仍需核对 DER/raw 字节格式。 |
| 帧与命令加密 | `createCipheriv('chacha20', key, iv)`；8 字节 nonce，拼成 16 字节 IV | 当前 Node crypto 没有 createCipheriv。底层已有 ChaCha20-Poly1305，但它与此处 raw ChaCha20 的格式和算法不同，不能直接替代。需提供准确的流加密实现。 |
| 云请求加密与签名 | JS RC4-drop1024、Node hash/randomBytes | RC4 已为 JS；MD5/SHA-1/SHA-256 与随机字节已有兼容层。 |
| 字节和异步工具 | Buffer、BigInt、Promise、URL/URLSearchParams、fetch、AbortSignal、timer | 多数已有；仍需适配上游依赖的 response body 异步迭代、Set-Cookie 多值读取、重定向策略和 timer `.unref()` 语义。 |
| 编码帧输出 | `MissClient.readVideo()` 返回 codec、时间戳、payload | 能作为手机原生解码器输入的协议边界；当前产出仅 H.264/H.265 视频，`startMedia` 明确 `enableaudio:0`，不能据此承诺音频。 |

上表来自上游 [cs2.js](https://github.com/Kosztyk/homebridge-xiaomi-camera-native/blob/8b537ea4f210908b46e5e5d7c21063da0fdc1aaf/lib/cs2.js)、[crypto.js](https://github.com/Kosztyk/homebridge-xiaomi-camera-native/blob/8b537ea4f210908b46e5e5d7c21063da0fdc1aaf/lib/crypto.js)、[cloud.js](https://github.com/Kosztyk/homebridge-xiaomi-camera-native/blob/8b537ea4f210908b46e5e5d7c21063da0fdc1aaf/lib/cloud.js)、[miss.js](https://github.com/Kosztyk/homebridge-xiaomi-camera-native/blob/8b537ea4f210908b46e5e5d7c21063da0fdc1aaf/lib/miss.js)，以及仓库 `packages/nsh-node-compat/src/bundler.ts`、`packages/nsh-node-compat/src/shims/crypto.ts`、`packages/nsh-node-compat/rust/Cargo.toml` 和本机对应 `quickjs-jit-stdlib-0.14.1` 源码导出表。

**成熟度限制是明确的一手事实：**作者 README 表示尚未用实体摄像头测试，也未与 iPhone 实际配对；账号流程使用模拟 HTTP 测试。因此它提供了可读、可移植的 JS 实现，尚不能作为真实设备已通的证据。[项目验证说明](https://github.com/Kosztyk/homebridge-xiaomi-camera-native/tree/8b537ea4f210908b46e5e5d7c21063da0fdc1aaf#readme)

## 另外两条候选路线

### go2rtc 的云中继补丁

PR #2264 提出根据 `p2p_id` 走云中继与 NAT 握手，列举 hlc7 等可能适用的设备。但 PR 仍开放，作者真实设备测试只有 C302n；不能把它当成已合并的 hlc7 修复。它的价值是另一条公开握手实现，可在局域网 CS2 证据不足时进一步比较，代价是增加中继、会话认证和 NAT 状态机。[#2264](https://github.com/AlexxIT/go2rtc/pull/2264)

### MiBeeNvr 的协议部分

MiBeeNvr 也使用账号会话和 MISS 配置请求，不是绕过会话授权的另一种通道。`internal/xiaomi/cloud.go`、`cs2.go` 保留 MIT 文件头并注明来自 go2rtc；整体 v0.11.0 起使用 AGPL-3.0-only，`pkg` 链接例外不覆盖整个 `internal` 目录。若仅参考独立协议文件，应按实际文件头与来源判断，而非把整套当前 NVR 当成 MIT 项目。[cloud.go](https://github.com/Mi-Bee-Studio/MiBeeNvr/blob/d393c966892cdaeca3afc80beb139ae567dd6424/internal/xiaomi/cloud.go)、[cs2.go](https://github.com/Mi-Bee-Studio/MiBeeNvr/blob/d393c966892cdaeca3afc80beb139ae567dd6424/internal/xiaomi/cs2.go)、[NOTICE](https://github.com/Mi-Bee-Studio/MiBeeNvr/blob/d393c966892cdaeca3afc80beb139ae567dd6424/NOTICE)、[链接例外](https://github.com/Mi-Bee-Studio/MiBeeNvr/blob/d393c966892cdaeca3afc80beb139ae567dd6424/LICENSE.pkg-linking-exception)

## 手机接入尚待完成的部分

本地实测已确认三台目标设备均能取得 CS2 会话参数、完成 MISS 认证并连续收到可解码帧；实际协商方式为 TCP。以下是手机工程的剩余接入工作：

- 当前 App 保存的是 MIoT HA OAuth；本轮另行取得的 xiaomiio 会话位于 Mac 临时探针，手机仍需承接这套账号会话及其生命周期。
- 为现有宿主补齐协议必需的网络与加密接口，沿用已经通过实测的云请求组合。
- 将 Annex B H.264/H.265 编码帧接入手机原生解码与显示，并承接当前详情页的进入、播放和退出生命周期。

公开协议可以避免新增常驻 NVR 与完整 Node/Go 服务；实际实现成本集中在手机内的账号会话、socket、会话加密和编码帧入口。Mac 的约 20 秒采样已经证明协议和设备可以配合工作，手机显示与性能应在上述入口落地后实测。
