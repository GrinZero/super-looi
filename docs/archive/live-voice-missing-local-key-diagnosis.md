# 本机 LIVE 语音连接失败诊断（2026-11-06）

## 结论

本轮 iPhone 16e 的 LIVE 失败发生在网络连接之前：本机 `voiceKey()` 成功返回，但返回值为空，`LocalVoiceSocket.open()` 随即抛出无消息异常，尚未创建豆包 WebSocket。不能据此判断豆包服务、Key 有效性或麦克风是否正常。

仓库根 `.env` 配置了非空 `DOUBAO_API_KEY`，但 Mobile 本机语音没有读取这个变量。当前实现仅从 iOS SecureStore 读取 `doubao-api-key`（账号名为该名称的 SHA-256）；本机设置界面需显式提供非空 Key 才会写入。保存“本机语音”模式时允许 Key 留空，因此模式配置成功不代表凭据已经配置。

这次证据能确定当前读取结果为空，不能证明过去从未保存过、为何未保存或是否被其他操作清除。

## 运行证据

- 设备：iPhone 16e，iOS 26.3；原生应用 `com.anonymous.superlooiapp`，Metro 端口 8081。
- 持久配置 `local-center-v1` 校验通过，`voiceMode = local`、`mode = direct_miot`。此路径直连豆包，不经过 Hub。
- 主 agent 在 `await this.center.voiceKey()` 后临时记录 `Boolean(key)`，并记录捕获异常的消息是否为空；未记录任何 Key 内容。
- 2026-11-06 12:44:49（Asia/Taipei），通过模拟器 UI 点击 LIVE，再现截图相同提示。Metro 日志 `/private/tmp/super-looi-local-metro.log` 与原生日志同时出现：

```text
[voice-diagnosis] local voice credential present: false
[voice-diagnosis] open failed: empty error
```

`false` 出现在 `voiceKey()` 完成之后，证明本轮不是 SecureStore 读取抛异常。结合紧接着的 `if (!key) throw new Error()`，确定失败发生在 `this.factory(LOCAL_DUPLEX_URL, key)` 之前。

临时诊断日志已移除；本轮不修改凭据、连接模式或产品代码。早期直接查询 Keychain 元数据和独立辅助进程受访问限制，未作为根因依据；结论来自真实 App 的读取结果与 UI 复现。

## 错误为何没有说明缺 Key

1. `apps/mobile/src/runtime/local-voice-socket.ts` 的空 Key 分支抛出无消息异常，catch 统一调用 `fail()`。
2. `fail()` 发出通用“本机语音连接失败，请检查 API Key 与网络”。
3. `apps/mobile/src/runtime/live-voice-client.ts` 的 `socket.onerror` 忽略错误对象，再转换为“无法连接语音通道，请检查连接设置”。
4. 首页在错误前加上“语音通道未就绪”，最终丢失了缺凭据这一具体原因。

## 后续修复方向

- 要恢复当前本机语音，需将有效的豆包 Key 保存到此 App 的 SecureStore，再验证握手与真实语音；只在根 `.env` 写入 Key 对此路径没有作用。
- 应在选择本机语音且没有已保存凭据时明确提示缺 Key，区分凭据缺失、握手失败、服务拒绝与超时，并保留上游错误原因。
- 如果需要开发环境复用 `.env`，应设计明确的开发凭据配置流程；不要直接把私钥加成 `EXPO_PUBLIC_*` 常量或提交到仓库。
- 当前为诊断请求，上述配置和产品修复尚未执行。
