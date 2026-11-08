# Kimi / Moonshot 与智谱 GLM / Z.AI 接入补充调研

核验日期：2026-11-07。依据官方文档、维护者源码和本地 `@earendil-works/pi-ai@1.5.0`，未登录账号或执行付费请求。本文补充 MiniMax / 小米调研，不涵盖阿里、DeepSeek、火山、腾讯和聚合平台。

## 可比较结论

| 服务 | 便利接入方式 | 订阅适用范围证据 | 对 LOOI 的建议 |
|---|---|---|---|
| Kimi Code | 官方客户端设备码 OAuth；第三方会员 Key；Pi 已有 OAuth 实现 | 官方允许个人交互式 Agent 框架，含 OpenClaw；禁止批量非交互、转售和伪造客户端身份 | 列入优先订阅候选；首步会员 Key 预设，OAuth 验证自身客户端身份后接入；无人值守任务不共用订阅 |
| Moonshot 开放平台 | 国内/国际 API Key + OpenAI 兼容 | 按量平台，与 Kimi Code / 网页会员计费和 Key 不互通 | 通用 Agent、后台任务的稳定预设 |
| 智谱 BigModel / Z.AI 标准 API | API Key + OpenAI 兼容 | 官方明确自建应用、网站、机器人、SaaS 使用标准 API | GLM 首发采用标准 API，区分国内与国际账号 |
| GLM Coding Plan | 专用套餐 Key；自家 ZCode 有账号授权登录 | 仅官方指定工具和产品；虽含 OpenClaw/Hermes，未覆盖所有自建 Agent | 不作为 LOOI 默认订阅选项；获得明确支持后再开放 |

以上是结合用途的工程建议，不是凭“有 API endpoint”推断所有用途都获支持。尤其“我们用了 Pi SDK”不等于“我们的产品就是官方支持的 Pi Coding Agent”。

## Kimi：应区分会员、Code 和按量 API

官方 FAQ 将 Kimi Code 和开放平台明确分开：Code 使用会员额度及其专用 Key；开放平台使用按量余额。国内开放平台地址为 `https://api.moonshot.cn/v1`，国际为 `https://api.moonshot.ai/v1`。Code 的 Anthropic base 为国内 `https://api.kimi.com/coding/`、国际 `https://api.kimi.ai/coding/`。[官方 FAQ](https://www.kimi.com/code/docs/kimi-code/faq.html)。

Code 同时支持 OpenAI Chat Completions / Responses 与 Anthropic 协议；OpenAI base 为 `https://api.kimi.com/coding/v1`，国际域名换为 `api.kimi.ai`。当前文档模型包括 `k3.1-pro`、`k3.1-pro-highspeed`、`k3`、`k3-256k`、`kimi-for-coding` 和高速变体，权限和上下文依赖会员档位。不能把 `kimi-for-coding` 永久当成一个固定底层模型；也不能给只支持思考的模型发送关闭思考设置。[官方概览](https://www.kimi.com/code/docs/)。

当前会员说明已经区分新旧套餐：新会员 Plus 及以上可使用 Code，保留 5 小时滚动窗口但取消周窗口；旧套餐仍有周窗口；月总额度与 Kimi 会员共享。可以另开 Extra Usage，但应由用户在厂商端控制。产品不宜硬编码“每周恢复”。[会员说明](https://www.kimi.com/code/docs/kimi-code/membership.html)。

### 为什么值得列入优先候选

官方社区倡议将可用范围描述为个人交互式，并明确兼容 Agent 框架，包括 OpenClaw；同时禁止非交互批量执行、二次分售和伪造 User-Agent 等客户端身份。企业或商业集成应使用开放平台。[社区倡议](https://www.kimi.com/code/docs/kimi-code/community-guidelines.html)。官方还专门提供了 Hermes Agent 会员 Key 接入教程，说明这不只局限在其自家 IDE。[Hermes 官方教程](https://www.kimi.com/code/docs/third-party-tools/hermes.html)。

因此，个人点按/语音触发的 LOOI 交互值得优先验证；持续后台自动化或面向多用户的托管服务不能从这条政策外推。LOOI 自身的产品/商业分发边界、OAuth client 注册方式仍未获得专门确认。

### OAuth 和社区实现

官方新 Node 版 Kimi Code 源码修订：`MoonshotAI/kimi-code@eb2035f3cad57cc12d4d5082ec626f7f0ea5f651`。[OAuth HTTP 实现](https://github.com/MoonshotAI/kimi-code/blob/eb2035f3cad57cc12d4d5082ec626f7f0ea5f651/packages/oauth/src/oauth.ts) 包含 RFC 8628 device-code 流程：`/api/oauth/device_authorization` 获取设备码，`/api/oauth/token` 轮询及刷新，处理 pending、slow_down、拒绝、过期及临时服务故障。其参数化 `OAuthFlowConfig` 将主机和 client ID 与 HTTP 流程分开。这是实现参考，仍不是任意第三方可复用其身份的许可。

本地 Pi 1.5.0 的 `dist/providers/kimi-coding.js` 已同时注册 API Key 和 `lazyOAuth(loadKimiCodingOAuth)`。其 `dist/auth/oauth/kimi-coding.js` 使用 `https://auth.kimi.com` 的 device-code + refresh 流程，模型请求走 `https://api.kimi.com/coding/v1`。因此 Kimi 在当前技术底座中的 OAuth 复用条件比仅有通用 Key 表单更好；仍需手机端真实验证及客户端身份核验。

第三方 [opencode-kimi-full](https://github.com/lemon07r/opencode-kimi-full) 也实现设备码登录、令牌刷新、401 单次重试和登录/刷新时模型发现。但其 README 写明模仿 kimi-cli 的 User-Agent / X-Msh 指纹；这与当前官方“不伪造客户端身份”的规则存在直接冲突，**不应照搬指纹伪装**。可以借鉴独立 auth 存储、刷新锁和动态模型发现，而不是客户端冒充。

OpenClaw 固定版本 `ef22366218e71f2badd34dd9933e658e9b84d5ac` 的 [Kimi 入口](https://github.com/openclaw/openclaw/blob/ef22366218e71f2badd34dd9933e658e9b84d5ac/extensions/kimi-coding/index.ts) 仍以 `KIMI_API_KEY` / `KIMICODE_API_KEY` 为主要连接方式。因此“某 GitHub issue 提议 OAuth”不能当作主线已经提供该功能。

## GLM：标准 API 与 Coding Plan 必须分开

智谱国内官方 FAQ 的范围非常明确：自建应用、网站、机器人和 SaaS 的 API 集成使用标准 API；Coding Plan 限定官方指定工具。新文档还说明套餐 Key 与模型标准 API Key 分开管理、不能互用。当前套餐列出的模型是 GLM-5.3 / GLM-5.3-Flash。[BigModel FAQ](https://docs.bigmodel.cn/cn/coding-plan/faq)。国际 [Z.AI FAQ](https://docs.z.ai/devpack/faq) 同样限定官方支持的工具和产品。

| 类型 | 国内 BigModel | 国际 Z.AI |
|---|---|---|
| 标准 API，OpenAI | `https://open.bigmodel.cn/api/paas/v4` | `https://api.z.ai/api/paas/v4` |
| Coding Plan，OpenAI Chat | `https://open.bigmodel.cn/api/coding/paas/v4` | `https://api.z.ai/api/coding/paas/v4` |
| Coding Plan，Anthropic | `https://open.bigmodel.cn/api/anthropic` | `https://api.z.ai/api/anthropic` |
| Coding Plan，OpenAI Responses | `https://open.bigmodel.cn/api/v1` | `https://api.z.ai/api/v1` |

地址来源：[ZCode 官方连接说明](https://zcode.z.ai/en/docs/configuration)、[国内工具列表及协议](https://docs.bigmodel.cn/cn/coding-plan/tool/others)、[国际工具列表及协议](https://docs.z.ai/devpack/tool/others)。

国内指定通用工具包括 OpenClaw、Hermes、Cherry Studio 等，但这些工具采用低于编程请求的调度优先级，在高峰期可能排队/限流。国际列表也明确对通用工具尽力服务。它们证明“有通用 Agent 例外”，不证明“任何自建 Agent 都能使用订阅”。

### 登录体验和开源实现

ZCode 官方提供 Continue with Z.ai / Continue with BigModel，浏览器授权后绑定账户并自动使用其 Coding Plan；因此 GLM 也不是“只有手填 Key”。但本次没有找到可用于 LOOI 的公开第三方 client 注册、scope、设备授权规范。[ZCode 连接文档](https://zcode.z.ai/en/docs/configuration)。

OpenClaw 固定版本的 [Z.AI 插件](https://github.com/openclaw/openclaw/blob/ef22366218e71f2badd34dd9933e658e9b84d5ac/extensions/zai/index.ts) 注册 API Key 方式，并按账号端点配置模型。Pi 1.5.0 本地 `dist/providers/zai.js` 的默认地址恰好是 **Coding Plan** `/api/coding/paas/v4`，国内另有 `zai-coding-cn.js`；将它直接作为 LOOI 标准 GLM provider 会选错计费路径。接标准 API 时需要明确覆盖/创建对应 provider，不能只复用名字。

## 对连接体系的实际影响

1. 同一厂商下面应让用户选择“会员/订阅”或“按量 API”，自动匹配 Key 创建入口与 endpoint，而不是让用户猜 URL。
2. OAuth 的数据模型需支持 device-code、刷新令牌、账号区域、到期、重新登录；也要容纳“网页登录后签发 API Key”，两者不应混成一种实现。
3. 模型目录与会员权限动态读取；失败时区分无权限、额度耗尽、限流和真正的认证失效。
4. 订阅适用的交互任务与长期后台任务分配不同连接；不要静默切到会收费的 API fallback。
5. 优先顺序建议：Kimi/Moonshot API 预设可以早做；Kimi 个人交互订阅和 OAuth 是重点验证；GLM 先标准 API，Coding Plan 暂留扩展能力而不宣称通用支持。
