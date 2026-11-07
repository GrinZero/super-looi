# 当前待办

## NSH 后续功能

- [ ] LOOI BLE 原生桥接及真机连接、断连、脱座与停止验证；共享驱动与状态机已保留。
- [ ] 双端真机麦克风、扬声器、AEC（回声消除）、后台音频和 LIVE 并发性能验证；模拟器合成 PCM 链路已有记录。
- [ ] MIoT 完整 OAuth fixture、回调 GET / POST 307 / 子资源请求测试及真实设备回读。
- [ ] 相机采集、视觉输入与前台保持唤醒的原生接线。
- [ ] 如需导入旧用户数据，实现旧端数据导出与 NSH 导入；旧源码见 `archive/legacy-hub-and-expo`。
- [ ] 商店签名、Android API 36 / AAB、32 位 ABI 运行与真机发布验证。
- [ ] Pi 预编译扩展、深链 OAuth 与图片处理的手机宿主验证；完整桌面 SDK 根入口的兼容问题见既有兼容层记录。

## 模型服务认证与订阅接入（2026-11-07 调研）

结论见 [接入范围与架构建议](docs/llm-provider-auth-research.md) 和 [MiniMax / MiMo 证据](docs/llm-china-provider-research.md)。本轮未实施或验证真实账号调用。

- [ ] ChatGPT 正式 plan usage：核验项目发行形态，手机系统浏览器 + 127.0.0.1 回调、OIDC 身份验证、注册复用、账号目录与 Responses 工具流。
- [ ] MiniMax M Plan：确认自有 App OAuth client 接入规则、国内/国际域名与个人交互用途；验证设备码登录和刷新。
- [ ] 小米 MiMo：先接按量 API 预设；第三方免 Key 授权与 Token Plan 对机器人场景的适用性待确认，不复用米家授权。
- [ ] 统一多连接/凭据生命周期、协议适配、旧配置迁移与模型发现；套餐额度耗尽不得静默转为按量扣费。

- [ ] 扩展候选落地：Kimi 会员 Key/OAuth 的自有客户端身份与个人交互范围；GLM 标准 API 明确避开 Pi 默认 Coding Plan endpoint；Qwen 新订阅第三方资格另验。
- [ ] 补齐 DeepSeek、Qwen/百炼、火山、硅基流动预设；腾讯/百度/OpenRouter 扩展目录；火山/Kimi 平台端超额计费设置需可见。
