# MOSS-Live TLS 握手失败诊断

核查时间：2026-11-13 18:21–18:25（Asia/Taipei）。

## 错误与证据

截图错误为 `websocket.connect / ERR_SOCKET_CLOSED / WebSocket handshake failed: IO error: tls handshake eof`。失败发生于 TLS 握手，尚未完成 WebSocket 升级和 API 鉴权。

代码 `packages/looi-runtime/src/voice/realtime-protocol.ts` 使用 `wss://api.mosi.cn/v1/realtime?model=moss-live-1.0`，通过 `Authorization: Bearer …` 传递密钥，与 [MOSS 官方接口文档](https://platform.moss.cn/docs/reference/moss-live/) 一致。NSH 0.5.0 原生 WebSocket 使用系统域名解析、TCP 与 rustls 建立连接。

| 探针 | 结果 |
| --- | --- |
| 初次通过系统解析访问官方地址 | TCP 成功，TLS ClientHello 后连接结束，curl 35 / `SSL_ERROR_SYSCALL` |
| 初次通过环境变量中的 HTTP 代理访问官方地址 | CONNECT 200 后 TLS 失败，同为 curl 35 |
| 系统与路由器 DNS、阿里加密 DNS | 返回 `47.100.61.37` |
| Google / Cloudflare 加密 DNS | 返回 CNAME `api.mosi.cn.a2.initac.com`，分别取得 `155.102.130.219`、`155.102.130.148` |
| 临时为单次请求指定上述 CDN 地址，保留域名和证书验证 | 观察到 TLS 成功；独立复核中 `.148` 曾失败，重试成功 |
| 后续系统解析路径及单次请求指定 `47.100.61.37` | 连续三次 TLS 验证成功，WebSocket Upgrade 返回 HTTP 403 |
| 不提供密钥的 WebSocket Upgrade | 服务端返回 `102111001 / permission_error / missing bearer api key`，证明请求已到达鉴权阶段 |

`47.100.61.37` 后续能提供有效域名证书，因此不同 DNS 答案不能直接证明 DNS 污染。上述请求经过系统 TUN 路由；`--noproxy '*'` 只绕过 curl 的显式代理，不能证明物理直连。路由检查显示目标经过 `utun1500 / 198.18.0.1`，Clash Party / mihomo 正在运行。

可确认当前网络路径出现过间歇性 TLS 握手失败，与截图错误阶段一致。缺少截图发生时的代理与服务端日志，尚不能将原因归到代理、出口或服务端节点。探针未读取或使用 App 保存的密钥，没有验证该密钥的有效性。

## 开发服务器断开

运行中的 App 启动参数为 `--dev-server ws://127.0.0.1:8790/ws`。检查时没有 8790 端口监听，也未找到对应开发服务器进程，可解释 `Dev server disconnected — reconnecting…`。它和云端语音 TLS 连接属于不同链路。

## 后续定位入口

再次出现 TLS 失败时，关联同一时间的 mihomo 域名、命中规则、出口和连接错误，区分代理路径与目标节点。恢复开发服务器后，在已连接开发真机上横屏复测实际密钥鉴权与语音会话。
