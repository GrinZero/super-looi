# 社区 MISS/CS2 取流验证

实验日期：2026-11-10。目标设备为两台 `isa.camera.hlc7` 和一台 `chuangmi.camera.039a01`。

## 结果

三台摄像头均通过公开 Python MISS/CS2 实现取得真实 H.265 视频，并完成约 20 秒采样和完整解码检查。三台实际协商的传输方式均为 CS2/TCP。此处是 Mac 直连设备的协议验证，App 内的取流入口尚未改动。

| 设备 | 型号 | 成功连接耗时 | 首个编码包 | 视频尺寸 | 解码帧数 | 媒体跨度 | 解码结果 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 大厅／监控 | `chuangmi.camera.039a01` | 0.628s | 1.025s | 864×480 | 399 | 19.920s | 退出码 0，错误 0 行 |
| 小鸟 | `isa.camera.hlc7` | 1.250s | 1.365s | 640×360 | 397 | 19.958s | 退出码 0，错误 0 行 |
| 天台 | `isa.camera.hlc7` | 2.317s | 2.743s | 640×360 | 311 | 19.593s | 退出码 0，错误 0 行 |

天台第一次在 CS2 握手阶段约 8.247 秒超时；同一 IP 的 ICMP 检查 2/2 成功，稍后重试握手与媒体采样成功。没有对该摄像头执行重启或设置修改。

已抽取并查看大厅和小鸟摄像头的实际画面。编码媒体及抽帧保存在本机临时目录；提交的证据只含统计与响应元数据：[四次取流尝试](artifacts/camera-cs2-direct/results.json)、[云请求对照](artifacts/camera-cs2-direct/request-comparison.json)。

## 实验环境与协议来源

- 在 Mac 的临时 Python 环境直接导入 `Kosztyk/xiaomi_camera_native` 0.3.10 的协议目录，固定提交 `d1479e4c1f95c37abc9f7774b0d1e2a0dffe4a23`。
- 临时环境使用 `aiohttp`、`cryptography`；二维码实验另使用 `segno`。没有向 App 添加依赖或安装开发包。
- 本机 Wi-Fi 地址为 `192.168.3.117`，默认网关为 `192.168.3.1`。
- 现有 App 凭据为 HA OAuth。iOS 登录页使用 `WKWebsiteDataStore.nonPersistentDataStore`，网页登录结束后没有保留可供本实验恢复的 xiaomiio 账号会话。

## 扫码登录实验结果

扫码部分是临时探针补充的账号登录入口，不属于该项目自带的密码登录实现。

| 请求 | 实际结果 |
| --- | --- |
| `account.xiaomi.com/pass/serviceLogin` | 代理与直连测试均发生 TLS 连接失败 |
| `cn.account.xiaomi.com/pass/serviceLogin` | HTTP 200，可取得 xiaomiio 登录初始化参数 |
| 中国区账号端点的 `longPolling/loginUrl` | 成功生成二维码，响应声明 300 秒有效期，回执地址为 `ak.lp.account.xiaomi.com/lp/s` |
| 使用登录会话发起扫码回执长轮询 | 收到 HTTP 403、647 字节 HTML；页面标识 Xiaomi tengine 服务。切换直连后仍观察到相同响应 |
| 独立无 Cookie 请求同一回执地址 | TLS 可建立，但 120 秒内没有得到 HTTP 响应 |

用户完成了手机侧扫码确认，但扫码实验没有取得可用账号会话。403 的触发条件未确定；后续成功取流使用下面的原生账号／验证码登录。

## 原生账号登录与云请求差异

账号及短信验证码提交后，原探针在后续 `account.xiaomi.com` 回调连接失败。将这部分请求同样映射到可达的 `cn.account.xiaomi.com` 后，`/identity/result/check` → `/pass/serviceLoginAuth2/end` 返回包含 `ssecurity` 的登录响应。最后通过 `sts.api.io.mi.com/sts` 取得新的 serviceToken；该域名的连接也出现过失败，临时验证使用本机 curl 完成这次回调。此后用实际设备列表请求验证会话，成功发现三个目标设备，均在线。

最初的取流配置请求对三台均返回 HTTP 200、`code=-12`；补充读取服务端消息得到 `throttle deny`。原探针自行设置的会话 User-Agent 为 `Mozilla/5.0`，并沿用 Python 请求中的 `MIOT-ENCRYPT-ALGORITHM: ENCRYPT-RC4`、`Accept-Encoding: identity` 和自动 Cookie 会话。

对照保持同一有效账号会话、Python RC4 签名和 X25519 密钥生成，仅将请求组合改成 go2rtc 风格：`Go-http-client/1.1`、显式三个账号 Cookie、独立 Cookie 容器、不发送上述 MIOT 加密头与 identity 编码头。此请求返回 `code=0`、`message=ok`，包含 vendor、公钥与签名字段。随后再次以原探针组合请求同一 hlc7，仍得到 `-12`；以有效组合请求三台则全部取得 CS2 参数并进入局域网握手。

HTTP 对照与媒体处理均由 Python 探针完成。该对照确定了一种能工作的请求组合，尚未单独定位 UA、加密头、编码头或 Cookie 中哪一项触发拒绝；浏览器 UA 来自探针设置。

## 媒体采样方法

账号登录探针改为调用上游 `XiaomiCloud.login()`、`submit_captcha()` 和 `submit_verification()`。账号请求使用可达的中国区端点；临时适配同时处理通用／中国区验证码地址，并在验证码输入错误时保留同一挑战会话。

探针按上游实现发现目标设备、调用 `provision()` 和 `MissClient.connect()`，逐台采样 20 秒编码视频；取流配置请求使用上述已实测有效的 HTTP 请求组合。每包累计帧数、字节、codec 与媒体时间跨度，提前结束时保留已有统计。编码媒体只写入临时目录，再用本机 `ffprobe -count_frames` 与 `ffmpeg -f null` 解码。

成功的媒体证据应包含有效宽高、非零解码帧数、解码退出码及错误行数。首个解密编码包的到达耗时单独记录为 `first_packet_seconds`，不能当成播放器显示首帧或手机播放性能。

协议研究与型号证据见 [社区取流实现](xiaomi-camera-community-solutions.md)；既有云 HLS 的真实失败记录见 [手机验证记录](xiaomi-camera-mobile-verification.md)。
