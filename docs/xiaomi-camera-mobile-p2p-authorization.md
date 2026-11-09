# 手机内置米家运行时：039a01 的 P2P 授权接口

调研日期：2026-11-10。对象为 `chuangmi.camera.039a01`；运行宿主为手机内的 `HomeRuntime` / `direct_miot`。研究问题是现有 `ha.api.io.mi.com` OAuth 会话能否取得 MISS/CS2 会话参数。

## 结论

**目前没有找到当前 HA OAuth 客户端取得该型号 MISS 参数的公开成功实现。** 但“小米完全没有 OAuth 摄像头授权接口”也不准确：官方 Miloco 的摄像头实现使用另一套 OAuth 客户端，通过 `miss_get_vendor_security` 获取参数。该路径属于 `mico.api.mijia.tech`，请求与响应均带额外加密；现有 `haapi` 会话能否使用它，尚无公开调用证据。[官方摄像头封装](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/camera.py)、[官方客户端常量](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/const.py)、[官方分发的摄像头库](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/libs/darwin/arm64/libmiot_camera_lite.dylib)

因此应把当前问题表述为“**现有 OAuth 会话的摄像头会话授权尚未打通**”，不能把已经成功执行的 `start-p2p-stream` 当成已获得视频密钥，也不能仅因为 `miss_get_vendor` 在 HA host 返回 404 就断言所有 OAuth 授权路线均不存在。[小米官方对 HA 视频能力的说明](https://github.com/XiaoMi/ha_xiaomi_home/wiki/Features-that-will-not-be-implemented#camera-video-stream)、[go2rtc 的完整授权步骤](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/internal/xiaomi/xiaomi.go)

## 039a01 的 MIoT 动作能返回什么

本仓采集的 `chuangmi-039a01:2` 规格中，`p2p-stream` 服务只有 `start-p2p-stream`（6/1）和 `stop-stream`（6/2）；两个动作的 `in`、`out` 均为空。没有 Google/Alexa 的 HLS/RTSP 服务、`stream-address` 输出属性或 `initiate-webrtc-session`。因此没有依据换另一个已声明的 action 直接读取会话公钥、签名或播放 URL。[已采集的原始型号规格](artifacts/home-repair-audit/capability-inventory.json)

主任务的真机结果为两个动作的 API code/action code 都是 0，而 `out` 为空；这与规格声明一致。它证明动作被接受，不能证明取得了 MISS 的授权参数。go2rtc 把设备唤醒/动作与后续的云端 vendor/密钥请求分开执行，说明后者不是该动作成功的隐含返回值。[go2rtc `wakeUpCamera`、`getCameraURL` 与 `getMissURL`](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/internal/xiaomi/xiaomi.go)

`hass-xiaomi-miot` 的直放 URL 路径只在规格含 `camera_stream_for_google_home` / `camera_stream_for_amazon_alexa` 时，调用 `start_hls_stream` / `start_rtsp_stream` 并解析 `stream_address`。它没有为 039a01 的空输出 `start-p2p-stream` 提供等价取密钥路径。[固定版本 `camera.py`](https://github.com/al-one/hass-xiaomi-miot/blob/829d61206610d8c3cc697594d57393cc258ecb6e/custom_components/xiaomi_miot/camera.py)

## 三套授权身份不可混为一套

| 实现 | OAuth/登录客户端 | API host / 业务标识 | 取流授权证据 |
| --- | --- | --- | --- |
| 当前包采用的官方 HA 通道 | OAuth client ID `2882303761520251711` | `ha.api.io.mi.com`，`haapi`，JSON + `Authorization: Bearer<TOKEN>`（实际无空格） | 官方未实现视频协商 |
| go2rtc `v1.9.15` | `xiaomiio` 账号登录，`passToken` → `serviceToken` / `ssecurity` | `api.io.mi.com/app`，RC4 签名通道 | `/v2/device/miss_get_vendor` → vendor、设备公钥与签名 |
| 官方 Miloco | OAuth client ID `2882303761520431603` | `mico.api.mijia.tech`，`micoapi`，加密 body | `/app/v2/device/miss_get_vendor_security` |

来源：[官方 HA 常量与 headers](https://github.com/XiaoMi/ha_xiaomi_home/blob/75b3acb6325a3a8d295688b13904737d6738a6a5/custom_components/xiaomi_home/miot/miot_cloud.py)、[HA client ID](https://github.com/XiaoMi/ha_xiaomi_home/blob/75b3acb6325a3a8d295688b13904737d6738a6a5/custom_components/xiaomi_home/miot/const.py)、[go2rtc cloud 登录](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/pkg/xiaomi/cloud.go)、[go2rtc vendor 请求](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/internal/xiaomi/xiaomi.go)、[Miloco 常量](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/const.py)。

官方 HA 的公开 HTTP 类没有摄像头 vendor 方法，官方 wiki 也明确不支持取得摄像头视频加密密钥。Miloco 客户端 ID、API host 和 headers 的差异，是实际代码事实；“把现有 token 换个 host 或 client ID 就能用”没有证据支持。[HA HTTP 实现](https://github.com/XiaoMi/ha_xiaomi_home/blob/75b3acb6325a3a8d295688b13904737d6738a6a5/custom_components/xiaomi_home/miot/miot_cloud.py)、[官方 wiki](https://github.com/XiaoMi/ha_xiaomi_home/wiki/Features-that-will-not-be-implemented#camera-video-stream)、[Miloco headers](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/cloud.py)

## Miloco 的 OAuth 摄像头路径：哪些是源码事实

以下使用固定 commit `05cdb1c77310afcfb77e64349bfb5efbeebded05`。

1. `MIoTCamera.__init__()` 将 `_host` 设为 `OAUTH2_API_HOST_DEFAULT`，非中国区增加地区前缀。`init_async()` 调用 `miot_camera_init(self._host, OAUTH2_CLIENT_ID, self._access_token)`。所以 `mico.api.mijia.tech` 确实传入摄像头原生库，而不只是用户资料或设备列表的 host。[`camera.py`](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/camera.py)
2. OAuth token 来自 Miloco 自己的授权流程，并在更新时传入 `miot_camera_update_access_token`；不是从 `xiaomiio` 的 `passToken` 派生。[`client.py`](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/client.py)、[`camera.py`](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/camera.py)
3. Python HTTP 实现公开了 Miloco 的加密封装：随机 16 字节 AES key，同一 key 作为 CBC IV；JSON 经 PKCS7 padding 后 AES-CBC 加密并 Base64；AES key 用公开 RSA key 和 PKCS1v15 加密，Base64 后放入 `X-Client-Secret`。响应按同一 AES key/IV 解密并解析 JSON。[`cloud.py` 的初始化、`aes_encrypt_with_b64` / `aes_decrypt_with_b64`](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/cloud.py)
4. HTTP headers 是 `Content-Type: text/plain`、`X-Client-BizId: micoapi`、`X-Encrypt-Type: 1`、`X-Client-AppId: 2882303761520431603`、`X-Client-Secret` 和 `Authorization: Bearer<TOKEN>`（`Bearer` 与 token 之间无空格）。这与 HA 的 plain JSON 请求不是相同封装。[`cloud.py` 的 `__api_request_headers`](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/cloud.py)

公开 Python 文件没有调用 `miss_get_vendor_security` 的 HTTP 函数；具体摄像头 HTTP 调用在项目分发的 native library（原生动态库）内。下面将静态二进制证据单独列出，不把它冒充公开 C 源码。[官方动态库目录](https://github.com/XiaoMi/xiaomi-miloco/tree/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/libs)

## 官方动态库的实际调用链

对同一 commit 的 `darwin/arm64/libmiot_camera_lite.dylib` 使用 `strings` 和 `otool -tvV` 静态查看，可定位到以下代码，而不只是发现一个未引用字符串。[对应原始二进制](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/libs/darwin/arm64/libmiot_camera_lite.dylib)

| ARM64 地址 | 静态可见行为 |
| --- | --- |
| `0x73d9c` | 组装 `app_pubkey`、`did`、`support_vendors`、`caller_uuid` 四字段的 JSON |
| `0x73e14` / `0x73e20` | 将 `/v2/device/miss_get_vendor_security` 和该 JSON 交给 RPC 回调 |
| `0x11b8` / `0x11c8` | `miss_mico_rpc_send` 比较该方法名；匹配后将参数传入 `0x3a4c` |
| `0x3a78` / `0x3a90` | 拼接 `https://%s/app/v2/device/miss_get_vendor_security`，向 `http_post_json` 传入原参数字符串 |
| `0x36f8` / `0x3728` | HTTP 200 后解密 Base64 响应并解析 JSON |
| `0x37c8` / `0x3848` | 检查 `code == 0`，提取 `result` |

对应请求的明文形状是下面的对象，不是 `miotspec/action` 的 `{params:{...}}` 包装。`app_pubkey` 是客户端临时公钥；`caller_uuid` 在原生会话内部持有，其运行时取值未通过 Python 封装公开。不能把这里的形状当成对现有 HA token 的成功调用证明。[官方动态库](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/libs/darwin/arm64/libmiot_camera_lite.dylib)、[go2rtc 临时密钥生成与同名请求字段](https://github.com/AlexxIT/go2rtc/blob/7c05066c90ab6ad1fccb506d5f0408aa31ebe60f/internal/xiaomi/xiaomi.go)

```json
{"app_pubkey":"<client public key hex>","did":"<camera did>","support_vendors":"<vendor list>","caller_uuid":"<caller uuid>"}
```

响应还可能有第二层封装。原生 `_decode_msg` 在 `0x6ef1c` / `0x6ef40` 查找 `crypt_params` 或 `crypt_result`，并在 `0x6ef84` 读取 `svr_pubkey`，随后再解码给 vendor 解析。故外层 HTTP 解密得到的 `result` 不能直接假定为 go2rtc `miss_get_vendor` 的明文 `vendor/public_key/sign`。具体第二层密码算法和所有字段的兼容性不在本次证据范围内。[官方动态库](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/libs/darwin/arm64/libmiot_camera_lite.dylib)

## 手机 SDK 是否提供等效接口

官方 `MiEcosystem/miot-plugin-sdk` 有 `connectToDeviceWithStateChangeCallBack`、MISS command 等接口声明，但它是米家插件开发环境：README 要求使用米家 App 扫描调试。固定 revision 的摄像头 JS 连接方法是 stub（占位实现），其他方法依赖 `NativeModules.MHCameraSDK`；未公开一个让独立手机应用用 HA OAuth token 换 MISS 参数的实现。[官方插件 SDK README](https://github.com/MiEcosystem/miot-plugin-sdk/blob/a48234baf2f3e7faba09c6c7bd18efe7197841bf/README.md)、[`miotcamera.js`](https://github.com/MiEcosystem/miot-plugin-sdk/blob/a48234baf2f3e7faba09c6c7bd18efe7197841bf/miot-sdk/service/miotcamera.js)

## 对一次有边界的接口验证有何意义

现在有精确的候选方法名 `device/miss_get_vendor_security`，其来源为官方实际调用链。它比继续猜测多个 URL 有依据；但验证必须分别回答“当前 HA host 是否存在该路由”“当前客户端 token 是否获准调用”“返回是否能解出完整 CS2 参数”。已有的另一路径 404、P2P action 成功都不能替代这三项结果。[官方动态库调用链](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/libs/darwin/arm64/libmiot_camera_lite.dylib)、[官方 HA 客户端](https://github.com/XiaoMi/ha_xiaomi_home/blob/75b3acb6325a3a8d295688b13904737d6738a6a5/custom_components/xiaomi_home/miot/miot_cloud.py)

截至本次源码调查，仍缺少当前 `haapi` client ID 调用该方法的公开成功记录。Miloco 的另一 OAuth identity（授权身份）证明“OAuth 摄像头授权”在官方体系内存在；它不证明当前 HomeRuntime 的授权可直接复用，也不要求改变手机内置运行的部署结构。[Miloco 初始化代码](https://github.com/XiaoMi/xiaomi-miloco/blob/05cdb1c77310afcfb77e64349bfb5efbeebded05/backend/miot/src/miot/camera.py)、[两个客户端的常量定义](https://github.com/XiaoMi/ha_xiaomi_home/blob/75b3acb6325a3a8d295688b13904737d6738a6a5/custom_components/xiaomi_home/miot/const.py)
