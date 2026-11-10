# 社区 MISS/CS2 取流验证

实验日期：2026-11-10。目标设备为两台 `isa.camera.hlc7` 和一台 `chuangmi.camera.039a01`。

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

用户完成了手机侧扫码确认，但探针没有取得 `serviceToken`、`ssecurity` 等可用会话字段。403 的触发条件尚未确定；本实验没有得到摄像头是否支持 CS2、MISS 是否接受认证或媒体是否可解码的实测结论。

## 原生账号登录与媒体验证边界

账号登录探针改为调用上游 `XiaomiCloud.login()`、`submit_captcha()` 和 `submit_verification()`。账号请求使用可达的中国区端点；临时适配同时处理通用／中国区验证码地址，并在验证码输入错误时保留同一挑战会话。

取得会话后，探针按上游实现发现目标设备、调用 `provision()` 和 `MissClient.connect()`，逐台采样 20 秒编码视频。每包累计帧数、字节、codec 与媒体时间跨度，提前结束时保留已有统计。编码媒体只写入临时目录，再用本机 `ffprobe -count_frames` 与 `ffmpeg -f null` 解码。

成功的媒体证据应包含有效宽高、非零解码帧数、解码退出码及错误行数。首个解密编码包的到达耗时单独记录为 `first_packet_seconds`，不能当成播放器显示首帧或手机播放性能。

协议研究与型号证据见 [社区取流实现](xiaomi-camera-community-solutions.md)；既有云 HLS 的真实失败记录见 [手机验证记录](xiaomi-camera-mobile-verification.md)。
