# MiniMax 与小米 MiMo 接入调研

核验日期：2026-11-07。范围为官方文档、OpenClaw 源码、OpenCode 文档和本项目安装的 Pi SDK；没有登录用户账号、购买套餐或执行付费调用。这里的“已确认”指文档/源码证据，不代表 LOOI 手机端联调通过。

## 建议

- **MiniMax 应作为优先订阅接入候选**：官方已提供 OpenClaw OAuth 登录，国内与国际区域都支持；同时保留订阅 Key 和按量 Key。现在官方名称是 M Plan，不应把旧 Coding Plan 名称和旧套餐额度永久写入 UI。
- **小米 MiMo 应作为优先 API 预设**：普通按量 API 可以直接使用 OpenAI 兼容协议。Token Plan 技术上也可接，但其当前使用范围仍有限制，不应默认承诺可以承担 LOOI 的持续感知、家居自动化和通用机器人后台工作。
- **小米确实有免手填 Key 的授权体验**，但目前明确证据是其自家 MiMo Code；本次没有找到第三方通用 OAuth 注册/接入规范，不能把米家 OAuth 当作 MiMo 模型授权。

## MiniMax：官方订阅和授权

国内官方 OpenClaw 指南把 OAuth 列为推荐登录方式，并另列手填订阅 Key；国际指南明确有 M Plan 即可 OAuth 登录，不需要先创建 M Plan Key。当前两份指南示例模型是 `MiniMax-M3.1-Flash`，且该模型始终启用思考。[国内官方指南](https://platform.minimax.cn/docs/m-plan/openclaw)、[国际官方指南](https://platform.minimax.io/docs/m-plan/openclaw)。

M Plan FAQ 明确区分订阅 Key 与普通按量 Key，二者额度不能混用；订阅 Key 用于 AI Agent 和编程工具，个人交互使用是主要定位，生产环境建议按量付费。订阅额度与积分包可以衔接，但不会因此自动扣按量账户余额。对我们而言，连接数据需要保存计费方式；不能把“余额不足”统一处理成“登录失效”。[官方 FAQ](https://platform.minimax.cn/docs/m-plan/faq)。

官方“其他工具”文档允许支持自定义地址和 Key 的工具接入，并提供以下国内预设；其中推荐 Anthropic 兼容协议以利用 prompt cache。[官方通用配置](https://platform.minimax.cn/docs/m-plan/other-tools)。

| 方式 | Base URL | 凭据 |
|---|---|---|
| OpenAI 兼容 | `https://api.minimax.cn/v1` | 订阅 Key，或对应按量调用所需 Key |
| Anthropic 兼容 | `https://api.minimax.cn/anthropic` | 同上 |
| 国际 OpenClaw OAuth | 源码默认 `https://api.minimax.io`，调用层配置 Anthropic 路径 | access / refresh token |
| 国内 OpenClaw OAuth | 源码默认 `https://api.minimaxi.com`，调用层配置 Anthropic 路径 | access / refresh token |

**域名有迁移差异**：新官方 Key 文档使用 `minimax.cn`，社区 OAuth 配置仍使用 `minimaxi.com`。不应盲目字符串替换所有登录/API 主机；OAuth 凭据须绑定签发区域。订阅个人交互许可也不能直接推断成无人值守、高频生产自动化许可。

## MiniMax：OpenClaw 源码怎么做

固定源码修订：`openclaw/openclaw@ef22366218e71f2badd34dd9933e658e9b84d5ac`。

[oauth.ts](https://github.com/openclaw/openclaw/blob/ef22366218e71f2badd34dd9933e658e9b84d5ac/extensions/minimax/oauth.ts) 实现设备码授权加 PKCE：获取 `/oauth2/device/code`，打开返回的验证 URL，再轮询 `/oauth2/token`。授权主机区分 `account.minimaxi.com` 和 `account.minimax.io`；令牌交换使用 `urn:ietf:params:oauth:grant-type:user_code`，带 `user_code`、`code_verifier`。刷新使用 `refresh_token`，持久化签发端点，拒绝跨区域刷新。源码还处理 state、取消、过期时间单位和刷新响应不轮换 refresh token 的情况。

[插件入口](https://github.com/openclaw/openclaw/blob/ef22366218e71f2badd34dd9933e658e9b84d5ac/extensions/minimax/index.ts) 将 OAuth 连接注册为 `minimax-portal`，模型调用采用 `anthropic-messages`。这说明登录并不是把某个字符串塞进现有通用 API Key 表单即可。

对手机端的推论：设备码流程不要求本地 TCP 回调服务器，适合外部系统浏览器加轮询；仍需处理 App 切后台后的轮询暂停/恢复和用户取消。OpenClaw 源码内的固定 OAuth client ID 是其已有集成的证据，**不是我们已获准使用该应用身份的证明**；LOOI 自有客户端注册或允许复用的规则仍需核验。

## 小米 MiMo：API 与 Token Plan

官方 OpenClaw 指南分别列出按量 `sk-...`、个人订阅 `tp-...` 和团队订阅 `ttp-...`。按量 Base URL 为 `https://api.xiaomimimo.com/v1`。其指南提醒 Anthropic 链路可能因工具调用消息缺少 `reasoning_content` 而报 400，因此首选 OpenAI 兼容链路，并验证多轮工具调用时的推理字段保留。[官方 OpenClaw 指南](https://mimo.mi.com/docs/en-US/tokenplan/integration/openclaw)。

Token Plan 当前地区预设是 `https://token-plan-{cn,sgp,ams}.xiaomimimo.com/v1`；也提供 `/anthropic`。专用 Key 与区域地址应以用户套餐页面为准。最新订阅说明列出 `mimo-v2.6-pro`、`mimo-v2.6-flash`，并宣布旧 `mimo-v2.5-pro` / `mimo-v2.5` 于 2026-10-21 下线；静态社区目录仍可能残留旧项。[官方订阅说明](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription)。

**范围限制**：同一份官方订阅说明明确将套餐限定在编程工具，并禁止明显非 coding 的自动化脚本、自定义应用后端等 API 请求。虽然它也列举 OpenClaw，且营销文案覆盖办公效率，这些表述仍不能消除具体限制。LOOI 是个人机器人/家居助手，建议默认走按量预设，Token Plan 作为用途确认后的可选连接，不能承诺通用可用。

## 小米 MiMo：授权登录并非不存在

2026-10-27 更新的官方 MiMo Code 指南已经支持跳转开放平台授权或手填授权码，用户无需配置 API Key；按量模式授权后平台会自动生成 `mimo-code-cli-key` 前缀的 Key，也可选择 Token Plan。它是“浏览器授权后签发 Key”的产品例子。[MiMo Code 官方说明](https://mimo.mi.com/docs/en-US/tokenplan/integration/mimo-code)。

本次未找到公开的第三方 MiMo OAuth client 注册、scope、移动回调和令牌交换规范。因此应记为“自家客户端已支持，第三方集成待确认”，而不是“小米没有登录授权”。小米账号通用登录、米家授权与模型平台凭据不能互换。

## 开源客户端的可借鉴结构

OpenClaw 将小米按量与 Token Plan 分为 `xiaomi` / `xiaomi-token-plan`，Token Plan 进一步按区域提供预设，使用独立凭据配置，避免专用 Key 被发到按量端点。[固定版本目录定义](https://github.com/openclaw/openclaw/blob/ef22366218e71f2badd34dd9933e658e9b84d5ac/extensions/xiaomi/provider-catalog.ts)、[当前维护者文档](https://docs.openclaw.ai/providers/xiaomi)。小米官方较早 OpenClaw 指南还说订阅必须手配，而当前社区代码已有预设；实施时以固定 SDK 版本及真实探针为准。

OpenCode 采用先 `/connect` 连接、再 `/models` 选模型的流程；自定义 provider 能分别指定运行库、地址、凭据、额外请求头、body 和模型能力。可借鉴其“认证与模型选择分离”，无需在首屏向用户暴露全部高级参数。[OpenCode 维护者文档](https://opencode.ai/docs/providers/)。

本项目已安装的 `@earendil-works/pi-ai@1.5.0` 包源码中，`dist/providers/minimax.js` / `minimax-cn.js` 已提供 Anthropic API Key provider；`xiaomi.js` 与 `xiaomi-token-plan-{cn,sgp,ams}.js` 已提供 OpenAI-compatible API Key provider。包元数据指向 [earendil-works/pi](https://github.com/earendil-works/pi/tree/main/packages/ai)。这是本地版本检查结果，不表示这些 provider 已接进 LOOI UI，也不表示 MiniMax OAuth 已在这些工厂中实现。

## 实施前待验证

1. MiniMax 面向我们自有 App 的 OAuth client 身份、地区和用途支持；真实登录、刷新、退出后迟到写入防护。
2. MiMo 第三方授权能否像 MiMo Code 一样签发 Key；未确认前只提供 Key 预设。
3. MiMo Token Plan 对 LOOI 个人对话与家居控制的实际适用范围；生产/后台路径先按量。
4. 两家模型的流式输出、工具循环、推理历史、错误分类及模型目录动态更新；特别避免固化已下线型号。
5. 现有 Pi provider 在 QuickJS / iOS / Android 的真实传输和凭据存储联调；本次仅静态调研，未花费用户额度。
