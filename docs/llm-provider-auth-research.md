# 模型服务、订阅与认证接入调研

调研日期：2026-11-07（Asia/Taipei）。本轮是文档与源码核验，未登录用户账号、购买套餐或执行付费推理；不表示本项目已接通这些平台。

## 推荐范围

候选范围覆盖 ChatGPT、MiniMax、小米 MiMo、Kimi/Moonshot、智谱/Z.AI、Qwen/阿里云百炼、DeepSeek、火山方舟、腾讯 TokenHub、硅基流动及 OpenRouter。MiniMax 和小米是重点样本，不是范围上限。首批界面应聚焦少数便利入口，完整厂商放可搜索预设目录。优先级按本项目用户交互、国内可用性和配置成本决定，不代表模型质量跑分。

推荐分层：优先验证 ChatGPT、MiniMax、Kimi 的授权；首批 Key 预设覆盖主流中国厂商，腾讯/百度/OpenRouter 放扩展目录。完整比较与依据见本文后半部分“扩大候选”和“最终推荐分层”。

中国平台的官方链接、开源固定版本证据与限制详见 [MiniMax / MiMo 专项调研](llm-china-provider-research.md)。

## ChatGPT：现在已有官方公开的订阅授权路径（当前 preview）

官方当前发布了面向开源、本地托管应用的 ChatGPT plan usage：通过授权使用用户套餐执行符合条件的 Responses 请求，不获得用户 ChatGPT 历史记录。收费或远程托管应用另走意向申请。因此上一轮“只能确认 Codex 登录”的判断需要更新：有官方公开接入文档，项目自身发行形态仍需对照其适用条件。[官方概览](https://developers.openai.com/siwc/token-sharing-open-source)

### 授权与推理

- 新注册通过 `dynamic_agent_client` 启动，设置真实应用名和稳定 `ext_agent_host_id`；回调获得实际 issued client ID。后续重新授权复用该 ID。
- 使用 PKCE、state、nonce，验证 ID token 签名、issuer、audience、有效期及 nonce；验证 `chatgpt.tokens.use.direct` scope 后才可使用套餐。
- 官方当前指定系统浏览器和 `http://127.0.0.1:<port>/auth/callback`，允许后续更换端口，不允许把主机随意替换为 localhost。不能直接假定自定义 App deep link 可替代。
- 授权与 token 端点分别为 `https://auth.openai.com/api/accounts/authorize`、`https://auth.openai.com/api/accounts/oauth/token`；无需 client secret。

来源：[Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)。

推理使用公开 `https://api.openai.com/v1/responses`，而非历史 Codex backend-api 路由。通过同一 access token 获取 `/v1/models` 的账号模型列表；此流响应为 `models` 数组，展示 `display_name`、调用 `slug`。HTTP 必须 `store:false`、`stream:true`；收到 `response.completed` 才视为成功，SSE 中途也可能报告套餐额度错误。[Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

套餐路径不是完整 OpenAI API 的任意替代：不支持音频/视频输入、transcription、Files upload 及若干托管工具；本地 function/custom tools 可通过规定结构调用。HTTP 需要自带历史，不使用 `previous_response_id`，多个常见参数如 `max_output_tokens`、`temperature` 不被接受。机器人实时语音继续单独配置。[Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

### 开源实现与本仓库的可复用部分

OpenCode dev 当前已实现新的 token-sharing，而不只是旧 Codex OAuth。固定源码版本 `145e948159e8dbaa3229d354a98dcfbcff7cfe92` 包含动态注册、随机 loopback 端口、issued client ID 复用、JWKS 验证、refresh、额度错误停止重试。需要注意该版本模型目录自动刷新接线仍被注释，实际使用 fallback 集合；不能仅因存在 fetchModels 函数就宣称完整动态发现已启用。[固定源码](https://github.com/anomalyco/opencode/blob/145e948159e8dbaa3229d354a98dcfbcff7cfe92/packages/core/src/plugin/provider/chatgpt.ts)

本仓库已安装 `@earendil-works/pi-ai@1.5.0`，检查安装包的：

- `dist/providers/openai.js`：同一 provider 下包含 API Key 和 ChatGPT subscription 两种认证，使用 Responses API。
- `dist/auth/oauth/openai-chatgpt.js`：实现动态注册、scope 检查与 refresh；依赖 Node `http`、`crypto`，固定 1455 回调端口。该安装版本每次 login 使用动态注册，并仅检查 ID token 存在；不能直接代替官方规定的完整身份校验与 returning-account 流程。
- `dist/auth/oauth/openai-codex.js`：保留旧 Codex browser/device-code 路径，client ID、端点与新流不同。设备码便利性不能直接推导为新正式授权流也支持设备码。

包仓库：[earendil-works/pi](https://github.com/earendil-works/pi)。以上结论以本地安装的 1.5.0 实际文件为准，不把上游 main 当成本项目版本。我们的 `packages/looi-runtime/src/agent/pi-executor.ts` 当前自行构造单一 `looi` provider 与 `openAICompletionsApi`，绕开了这些预置能力。

## 开源社区的处理方式如何影响设计

应采用“provider → auth method → connection → model”的结构，并将凭据与调用协议分开。

1. 一个品牌可能有多种计费和认证：ChatGPT 订阅与 OpenAI API Key，MiniMax 国内/国际、套餐/按量，小米普通 API 与 Token Plan。
2. OAuth 的结果可能是可刷新的 access/refresh token，也可能是授权后生成的 API Key；不能统一存成一个 apiKey 字符串而丢失生命周期。
3. 对应连接限制凭据允许发送到的 origin；自定义地址不能继承官方订阅 token。配置切换不能静默从套餐转到按量扣费。
4. refresh 合并并发、原子保存旋转令牌，注销/取消后旧回调不能恢复连接。错误区分“未授权、需重新登录、额度耗尽、模型不可用、网络失败”。
5. 模型列表按账号和连接缓存；不把旧开源示例中的型号当成当前账户权限。模型发现失败允许明确的手填路径，不伪造“已验证”。

这是基于官方协议和社区实现提出的本项目设计建议，并非本轮已实现功能。

## OpenRouter：方便，但不是订阅代用

官方支持 PKCE 浏览器授权，随后向 `/api/v1/auth/keys` 交换用户自己的 API Key，使用其 OpenRouter 余额。当前还提供不设置 callback 的手动授权码流程；可以作为移动端回调困难时的候选，但一键回跳需另测。适合扩大可选模型范围，优先级低于用户关注的三个品牌。[官方 OAuth 文档](https://openrouter.ai/docs/guides/overview/auth/oauth)

## 首批产品与实现顺序建议

默认添加服务突出 ChatGPT、MiniMax、Kimi 和可搜索的厂商预设；OpenAI API Key 放在 OpenAI 的另一连接方式。预置厂商只让用户选择地区、授权方式和模型，地址放高级设置。只展示经过实际验证的授权入口，避免“登录成功但不能调用”的假完成。

建议顺序：

1. 重构连接记录和执行器 provider 选择，迁移旧三字段配置为“自定义 OpenAI Chat Completions”，保留安全存储。
2. 接通选定首批普通 API 预设并核验流式工具调用；保留 OpenAI Chat Completions、Responses、Anthropic Messages 三类协议。
3. 对 ChatGPT 官方公开流（preview）、MiniMax 与 Kimi OAuth 做手机原型，完成登录、模型发现/选择、真实对话、工具调用、续期、重启、注销与取消验证。授权流程依赖的应用注册和套餐资格另行确认。
4. 决定是否开放 MiMo Token Plan；官方用途未涵盖当前需求前不推荐它用于 LOOI 的通用陪伴/家居执行。
5. 逐步补充扩展目录。现阶段不宣称已比较各厂商延迟、中文对话质量或工具调用成功率。

手机端关键缺口是官方 ChatGPT loopback 回调与本项目 QuickJS/NSH 原生宿主的衔接，已有米家专用登录窗不能自动复用为所有厂商授权。需系统浏览器、临时原生回调监听及前后台生命周期实测；不能以桌面 CLI 的成功替代。

## 扩大候选：不能只围绕 MiniMax 与小米

用户要求覆盖更广的中国厂商。以下是补充核验，Kimi 与智谱详见 [追加专项报告](llm-china-additional-providers-research.md)。本节据认证体验、使用范围和适配成本给出分层，不以品牌名单替代筛选。

| 候选 | 已核验的便捷方式 | 对 LOOI 的建议 |
| --- | --- | --- |
| Kimi / Moonshot | Kimi Code 订阅 Key + OAuth；普通 Moonshot API 独立 | 上调至订阅授权优先候选；遵循个人交互式 Agent 范围与自有客户端规则 |
| 智谱 / Z.AI | 标准 API Key；Coding Plan 有专用端点 | 提供标准 API 预设；机器人不默认走 Coding Plan |
| DeepSeek | 官方 API Key，OpenAI / Anthropic 兼容 | 首批 API 预设，配置路径短；本轮未找到可承诺的第三方订阅 OAuth |
| Qwen / 千问AI平台 / 阿里云百炼 | 自家 Qwen Code 有 Plus/Pro OAuth；云平台有按量 Key 和套餐 Key | 先标准 API；把 QwenCloud 和百炼及其地区/套餐分别建模，不能自动迁移混用 |
| 火山方舟 / 豆包 | 按量 Key、Coding Plan、Agent Plan | 首批或紧随其后的 API 预设；Agent Plan 是候选，但 LOOI 工具身份和文本用途须确认 |
| 腾讯 TokenHub / 混元 | 普通 API Key、多模型 Token Plan | 扩展预设目录；不能将腾讯账号登录等同模型订阅 OAuth |
| 硅基流动 | API Key，一处连接多个模型 | 国内聚合入口，建议首批预设候选；按模型能力筛选 |
| 百度千帆 | 当前 v2 API Key、OpenAI 兼容、模型列表 API | 扩展预设目录；避免让普通用户走旧版 AK/SK 流程 |

这里“未找到”仅表示本轮公开资料没有建立该能力，不是证明厂商不存在合作接入。

### Qwen：自家订阅 OAuth 与第三方现状不同

Qwen 官方仓库固定修订 `f087e699af32fed9ad6df8a345627adc9f49493a` 的认证指南支持 Qwen Plus/Pro 订阅 OAuth，同时将 QwenCloud、Alibaba ModelStudio、第三方与自定义配置分开。QwenCloud 标准 Key 的中国地址为 `https://maas.qianwenaiapi.com/compatible-mode/v1`，国际地址为 `https://maas.qwencloudapi.com/compatible-mode/v1`；旧百炼配置保留独立身份，不自动替换。[官方仓库认证指南](https://github.com/QwenLM/qwen-code/blob/f087e699af32fed9ad6df8a345627adc9f49493a/docs/users/configuration/auth.md)

OpenClaw 当前维护者文档则明确旧 `qwen-oauth` Portal 已移除，需为对应云端点重新配置 API Key；因此不照搬旧“免费 Qwen OAuth”的教程，也不把自家 Plus/Pro 登录当作第三方开放授权证明。[OpenClaw Qwen 文档](https://docs.openclaw.ai/providers/qwen)

百炼当前工具接入文档对 Token/Coding Plan 排除自动化平台、自建应用后端等用途。订阅与按量地址不同，普通北京按量地址为 `https://dashscope.aliyuncs.com/compatible-mode/v1`；具体区域/新旧产品要由连接预设明确选择。Qwen Code 的配置示例能说明技术接线，但不替代套餐自身的使用范围。[官方工具范围](https://www.alibabacloud.com/help/en/model-studio/more-tools)、[百炼套餐说明](https://help.aliyun.com/en/model-studio/coding-plan)

### 火山：需要分清按量、Coding Plan、Agent Plan

火山当前不仅有 Coding Plan，还有 Agent Plan。后者官方提供 Pi/OpenCode 等接入，OpenAI 兼容地址 `https://ark.cn-beijing.volces.com/api/plan/v3`、Anthropic 兼容地址 `https://ark.cn-beijing.volces.com/api/plan`；OpenCode 指南还推荐 Responses API，说明不应统一降级为 Chat Completions。[Agent Plan 其他工具](https://docs.volcengine.com/docs/ark/agent-plan-personal-other-tools?lang=en)、[官方 OpenCode 配置](https://docs.volcengine.com/docs/ark/agent-plan-personal-opencode?lang=en)

Agent Plan 当前概览对文本/向量模型仍限定 AI 工具场景，不能据“Agent”名称推断任意自建后台适用。该套餐还允许用户开启超额后付费：开启后无需改 Key/地址即可产生后付费账单。所以我们的“不得静默切到按量”只能约束客户端自身切换，还应展示平台侧超额设置的事实，不能承诺所有订阅永不额外扣费。[套餐范围与超额规则](https://docs.volcengine.com/docs/ark/agent-plan-personal-plan-overview?lang=zh)

普通推理为 `/api/v3`，Coding Plan 为 `/api/coding/v3`，Agent Plan 为 `/api/plan/v3`；这些必须作为不同计费连接，不能靠用户反复手改 URL。[官方 Coding Plan 配置](https://docs.volcengine.com/docs/ark/coding-plan-personal-plan-overview?lang=zh)、[官方 OpenClaw 部署指南](https://docs.volcengine.com/docs/ecs/QuicklydeployingOpenClawonLinuxandintegratingitasanAIassistantintoIMtools?lang=en)

### DeepSeek、硅基流动、腾讯、百度：用预设降低 Key 配置门槛

DeepSeek 官方说明直接兼容 OpenAI/Anthropic，分别使用 `https://api.deepseek.com` 与 `https://api.deepseek.com/anthropic`，认证为 API Key，且有 OpenClaw/OpenCode 等专门集成入口。适合一屏只输入 Key 再选择模型。[官方 API 起步](https://api-docs.deepseek.com/quick_start/agent_integrations/)

硅基流动官方流程为创建 API Key 后使用 REST/OpenAI 接口，同时提供模型列表与 function calling 文档。它的价值是一个连接覆盖多种模型，而非假设每个模型厂商的订阅均可通用。应按模型返回能力和实测过滤工具/图片支持。[官方起步](https://docs.siliconflow.cn/docs/userguide/quickstart)

腾讯当前 TokenHub 国内按量 OpenAI 地址为 `https://tokenhub.tencentmaas.com/v1`，混元也有该平台调用指南。国际 Token Plan 的独立端点为 `https://tokenhub-intl.tencentcloudmaas.com/plan/v3`，其文档禁止在支持工具范围外的自动脚本、自建后端和非交互批量调用。国内/国际及普通/套餐分别配置，不能用一个“腾讯”默认地址囊括。[混元调用指南](https://cloud.tencent.com/document/product/1823/132252)、[Token Plan 国际范围](https://intl.cloud.tencent.com/ind/document/product/1300/81315)

百度千帆当前提供 OpenAI 兼容 v2，`https://qianfan.baidubce.com/v2`；模型列表使用 API Key Bearer 验证的 `/v2/models`。本轮将它作为普通 API 扩展预设，不对其套餐/第三方 OAuth 作未经核实的承诺。[OpenAI 兼容文档](https://ai.baidu.com/ai-doc/WENXINWORKSHOP/2m3fihw8s)、[模型列表](https://cloud.baidu.com/doc/qianfan-api/s/Dmba8k71y)

## 最终推荐分层

1. **重点授权适配**：ChatGPT、MiniMax、Kimi。三者都投入真实登录与续期验证，不因只有前两家被用户首先提到而遗漏 Kimi。官方 preview、第三方客户端身份和用途条件仍按各平台处理。
2. **首批 Key 预设**：上述厂商的普通 API，以及 DeepSeek、MiMo、Qwen/百炼、智谱、火山、硅基流动。API Key 不等于差体验：厂商选好后仅需贴 Key，地址/协议/模型自动或半自动配置。
3. **可搜索扩展目录**：腾讯 TokenHub、百度千帆、OpenRouter；已有账号的用户可以直接用预设。其他服务仍由 OpenAI Chat Completions / Responses / Anthropic 自定义入口覆盖。
4. **套餐不是自动推荐项**：MiMo、GLM、百炼、火山、腾讯的套餐与普通 API 分开；根据应用身份/用途证据决定是否开放订阅入口，不用“社区能跑”代替产品适用性。

这是接入与便利性排序，未测模型质量、中文陪伴语气、首 token 延迟、语音链路延迟或真实多轮工具成功率。最终默认模型应由后续相同任务集实测决定。本轮不以短期折扣、旧免费额度或营销跑分锁定默认厂商。

## 核验与交付

主 agent 汇总官方与开源证据，独立子 agent 复核了 OpenAI、MiniMax、MiMo、Kimi、GLM、Qwen 与火山关键结论；已将 OpenAI 成熟度明确标为 preview。文档 `git diff --check` 通过。没有修改产品代码，不需要为本次调研运行应用测试；未完成的账号、移动宿主和真实推理验证列入根目录 todo.md。
