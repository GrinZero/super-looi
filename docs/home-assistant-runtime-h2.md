# 本机家居运行时 · H2 实施记录

日期：2026-11-06

H2 已完成：`@super-looi/home-assistant` 提供独立米家 OAuth、令牌管理、MIoT 规格解析和云端 HTTPS 直连传输，可通过现有 `HomeAssistantGateway` 使用。H3 将把这些能力接入移动端的安全存储、登录页面与连接模式。

## 认证与凭据

- `MiotOAuthClient.beginAuthSession()` 生成随机设备 UUID 和对应 SHA-1 state。标准 WebCrypto 是默认实现，原生宿主可注入 `MiotCryptoProvider`；缺少安全随机源时会明确失败。
- `tryInterceptCallbackUrl()` 严格匹配配置的 `http://homeassistant.local:8123/api/webhook/<id>` origin/path，验证 state、重复参数、有效期和授权错误。宿主应阻止所有 `intercepted: true` 的导航，包括错误结果，以免访问回调地址。
- `completeAuthWithCode()` 仅接受已验证回调中的一次性 code。换票数据中的 `client_id` 保留完整 JSON 整数精度；区域限定为官方支持的 `cn / de / i2 / ru / sg / us`。
- `MiotTokenManager` 在请求时检查凭据，在生命周期达到 70% 后合并并发刷新；存储键按区域、客户端和回调隔离。凭据由宿主注入的 `CredentialStore` 保存，共享包提供存储接口。
- 写入按顺序执行，注销会阻止迟到写回。取消登录在凭据提交点之前恢复原账号，提交点之后保留已提交账号；退出已登录账号使用 `logout()`。存储失败会返回错误，调用方应等待操作完成后更新登录状态。

## 协议与映射

`MiotHttpClient` 按官方协议获取自有 / 共享家庭、房间与分页设备，发送 `Bearer<token>`、`X-Client-BizId` 和 `X-Client-AppId` 请求头。公开设备清单仅保留设备标识、名称、型号、规格、在线提示与房间信息。LAN token、地址、网络名称和所有者信息不会进入公开清单。

属性读取每批最多 150 项，同时最多 3 批。读取与写入均验证响应关联键，拒绝重复或不匹配结果。写入只发送一次，断网恢复不会重发历史命令。请求及响应体读取有超时，错误不会携带原始 URL、凭据或响应正文。

`MiotSpecResolver` 校验 URN、服务 / 属性 ID 与范围，合并相同规格请求，支持内存和宿主注入的公共规格缓存，默认有效期 14 天。缓存损坏会重新获取；调用方得到独立副本。

`DirectMiotTransportAdapter.discover()` 返回可交给网关的实体定义，包含房间、能力和白名单标记。单台规格失败通过 `discoveryFailures` 和 `miot_discovery_partial` 报告，同时保留可用设备；整体发现失败则清空控制绑定。账号或连接模式改变后，宿主应重新建立传输与网关并发现设备。

- 默认白名单为空，调用方需显式指定实体或 `*`。
- 初期开放标准灯、风扇、开关 / 插座的可读写布尔电源；控制还受设备品类、危险型号 / 名称与网关策略约束。其他数字或布尔属性作为只读传感器，字符串遥测暂不映射。
- 灯光亮度在设备可达步进和网关 1–255 之间换算；色温按设备步进量化并与 2200–6500K 安全区间相交。网关在量化之后仍检查原参数边界，回执保留实际回读值。
- 写入响应不会合成目标状态。网关随后再次查询属性，只有读到匹配值才确认；部分写入失败、缺失属性、矛盾回读或网络故障保持未核实。

## 宿主组合

```ts
const region = "cn";
const auth = new MiotOAuthClient({ region, redirectUri, store: secureStore, crypto: nativeCrypto });
// 宿主完成 WebView 回调拦截并 await auth.completeAuthWithCode(code)。
const transport = new DirectMiotTransportAdapter({
  client: new MiotHttpClient({ region, getAccessToken: () => auth.tokens.getAccessToken() }),
  specs: new MiotSpecResolver({ cache: publicSpecCache }),
  allowedEntities: selectedEntityIds,
});
const gateway = new HomeAssistantGateway({ transport, initialEntities: await transport.discover() });
```

`secureStore`、`nativeCrypto`、公共规格缓存与设备选择由宿主提供；原生实现和页面在 H3 接入。共享包保持零 Node 专属运行时依赖，编译时禁用 Node 全局类型。

## 验证与边界

`pnpm build`、`pnpm typecheck`、`pnpm test` 均退出 0。全仓 **274 项**测试通过：contracts 5、looi-driver 11、home-assistant 42、mobile 127、hub 89。Hub 的 48 项核心验收运行器通过。

覆盖 OAuth 回调、过期 / 重复 code、精确 client_id、区域隔离、刷新合并、注销和取消的存储竞态、分页、错误脱敏、超时、规格缓存、白名单、量化后安全边界、部分失败及零重放。45 台设备 / 1121 个传感器实体的协议夹具验证了 8 次批量读取；这些是合成规模数据。隔离 VM 实际执行了无 Node 全局对象的 OAuth、语音网关与规格缓存流程；Mobile Metro 的 iOS / Android 源码解析回归通过。

独立子 agent review 发现的认证尾部并发问题已修复并补回归，最终审查无剩余可确认问题。真实账号登录、iOS / Android 原生集成及物理设备控制仍在 H3 验收。云端属性响应没有统一设备源时间戳，本适配器的快照时间记录本次查询观察时间；软件回读匹配不替代物理台架验收。UDP / MQTT 通路及更多品类能力仍属后续扩展。

协议依据：[官方 miot_cloud.py](https://github.com/XiaoMi/ha_xiaomi_home/blob/main/custom_components/xiaomi_home/miot/miot_cloud.py) 和本地已部署的同名源码；规格接口依据本地 `miot_spec.py` 的 `/miot-spec-v2/instance` 调用。总体路线见 [调研文档](home-assistant-mobile-runtime-research.md)，下一阶段待办见 [todo.md](../todo.md)。
