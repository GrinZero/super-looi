# Super-LOOI 中英双语接入调研

日期：2026-11-08

## 结论

首批以 `zh-CN`、`en-US` 覆盖界面与对话，语言设置提供「跟随系统／简体中文／English」。界面文案采用 **i18next core 27.0.1**：它能直接使用仓库内词条和 TypeScript 类型，不要求替换 NSH 的 TSX 构建或引入 React 绑定。NSH 的 `locale()` 已是响应式的系统区域设置读取器，但其 QuickJS 环境缺少 `Intl.Locale` 和 `Intl.PluralRules`；英文复数要配合 FormatJS 的这两项 polyfill（补充实现）及 `en`、`zh` 数据。采用 i18next v27 时，应显式设置 `fallbackLng: "zh-CN"`。[NSH 设备环境](https://nsh.dev/docs/device-and-environment/)、[NSH 全局 API](https://nsh.dev/modules/globals/)、[i18next v27 变更](https://github.com/i18next/i18next/releases/tag/v27.0.0)、[FormatJS PluralRules 要求](https://formatjs.github.io/docs/polyfills/intl-pluralrules/)

语音不需要另加语言识别模型。新会话以界面语言为默认，明确的语言要求或另一种语言的完整问题决定当轮回复语言；单个外语词、口音和简短语气词不触发切换。文字 Agent 与 Realtime（实时语音）使用同一规则。这个边界符合 [OpenAI Realtime 的多语言提示建议](https://developers.openai.com/api/docs/guides/voice-prompting)。现有豆包默认音色 `zh_female_vv_jupiter_bigtts` 已在英文语音探针中返回英文文本及音频，故首批可继续使用该音色；英文专用音色需逐个验证实际模型与账号能力，不能仅凭音色表直接配置。豆包官方明确说明中文音色具备英文能力，英文场景更推荐英文音色。[豆包音色列表](https://docs.volcengine.com/docs/doubao-voice/tone-list-3?lang=zh)

## 当前项目的接入边界

| 位置 | 当前事实 | 接入含义 |
| --- | --- | --- |
| `apps/nsh/App.tsx`、`apps/nsh/ui/`、`apps/nsh/store.ts` | `Text`、按钮、无障碍标签、状态、Toast（轻提示）及错误文案直接写在 TSX 或 store 中；`store.ts` 已用 NSH `signal` 和 `Storage`。 | 一个应用层语言状态即可驱动界面；沿用现有 `Storage` 保存手动覆盖。 |
| `apps/nsh/scripts/build-runtime.ts`、`apps/nsh/runtime/` | 业务 runtime 先经 esbuild 打成独立模块，再由 NSH 构建应用。部分 provider 标签、状态和错误文本由 runtime 返回。 | 不在两个 bundle 内各建一套会漂移的全局语言状态；runtime 面向 UI 的文本改为稳定消息标识和参数，由应用层翻译。 |
| `apps/nsh/runtime/voice/prompts.ts`、`packages/looi-runtime/src/agent/pi-executor.ts` | Realtime 提示词要求「用中文回答」；语音任务的 Agent 最终回答也被明确限定为中文。 | 把默认语言和按输入切换的规则传入两条对话链路；工具协议及用户原文保持原样。 |
| `packages/looi-runtime/src/agent/personal-memory.ts` | 记忆提示块有中文结构语和写死的 `toLocaleTimeString("zh-CN")`。 | 生成模型可读提示块时显式传入会话语言，时间格式按选定语言处理；不翻译已保存的用户事实。 |
| `apps/nsh/src/audio/kws.rs` | 当前 sherpa-onnx 唤醒模型和词条已有中英 `Hey LOOI`／中文谐音。 | 唤醒词与界面语言独立，无需引入第二套 KWS 模型。 |

NSH 的 `locale()` 返回 BCP 47（语言与地区标签）并在系统变化时更新依赖它的绑定。其 `Intl.NumberFormat`、`Intl.DateTimeFormat` 可用于中英数字和日期；手动覆盖时必须显式传入最终界面语言，不能依赖 `Intl` 的系统默认值。锁定的 NSH 0.4.0 源码也确认 `Intl.getCanonicalLocales` 已存在，`PluralRules`、`Locale` 不存在。[NSH 设备环境](https://nsh.dev/docs/device-and-environment/)、[NSH 全局 API](https://nsh.dev/modules/globals/)

## 最新社区方案比较

版本由 2026-11-08 的 `pnpm view <package> version` 核对；比较的是与 NSH 相容的 **core（核心库）**，不是各自的 React 组件。

| 方案 | 查询版本 | 用途与适配 | 新增复杂度及判断 |
| --- | --- | --- | --- |
| **i18next core** | `27.0.1` | 本地资源、插值、复数、回退语言；v27 可用 selector API（选择器 API）增强键类型与插值检查。[API](https://www.i18next.com/overview/api)、[TypeScript](https://www.i18next.com/overview/typescript)、[v27.0.1 发布](https://github.com/i18next/i18next/releases/tag/v27.0.1) | 需一个 NSH 响应式桥接和缺失的 Intl polyfill；无需词条编译步骤。**推荐。** |
| **Lingui core** | `6.12.0` | 框架无关 core 提供 ICU 消息、提取和编译目录。[简介](https://lingui.dev/introduction)、[Core API](https://lingui.dev/ref/core)、[发布](https://github.com/lingui/js-lingui/releases/tag/v6.12.0) | 宏转换、提取命令、PO/编译目录增加构建环节；React `Trans` 不适用于 NSH `Text`。首批收益不足以抵偿这套流水线。 |
| **Paraglide JS** | `3.2.1` | 编译成类型安全、可按消息优化的函数；v3 官方提供 **esbuild 插件**，但本仓库的 esbuild 只处理独立业务 runtime，界面 TSX 由 NSH 打包。界面若采用 Paraglide，应先用 CLI 生成物理模块供 NSH 打包，或进一步确认 NSH 插件入口。[更新记录](https://paraglidejs.com/changelog)、[编译方式](https://paraglidejs.com/compiling-messages) | 仍需 `project.inlang`、生成目录、NSH 语言状态适配；网页默认的导航／重载式切换不适用于原生界面，需自定义策略。它可只使用本地词条，不必接 TMS。[语言策略](https://paraglidejs.com/strategy) |
| **FormatJS `@formatjs/intl`** | `6.1.4` | ICU MessageFormat、数字和日期格式能力较全，适合复杂语法。[Core API](https://formatjs.github.io/docs/intl/)、[消息格式](https://formatjs.github.io/docs/intl-messageformat/) | 需自己管理目录、实例和 NSH 响应式；当前中英 UI 文案不需要这层额外格式能力。 |
| **Unicode MF2 / `messageformat`** | `4.1.0` | MessageFormat 2 是 Unicode 的新消息标准；`messageformat` v4 实现该语法。[Unicode 规范](https://messageformat.unicode.org/)、[JS 实现](https://messageformat.github.io/) | 它是消息格式与格式器，不负责本项目的语言偏好、资源目录或界面更新；适合作为格式演进观察对象，当前不额外引入。 |

`i18next` 的新增依赖承担明确职责：core 管词条和语法；`@formatjs/intl-locale` 补 NSH 缺失的 `Intl.Locale`；`@formatjs/intl-pluralrules` 补英文复数并只装载中英规则。FormatJS 两项在查询日分别为 `5.4.2`、`7.0.2`。其成本是初始 bundle 增量和两项 polyfill 的初始化顺序；比自己维护复数规则和未来语言扩展更可控。[FormatJS PluralRules 文档](https://formatjs.github.io/docs/polyfills/intl-pluralrules/)、[i18next 复数文档](https://www.i18next.com/translation-function/plurals)

## 推荐接入设计

1. **语言所有权在应用层。** 定义 `LanguagePreference = "system" | "zh-CN" | "en-US"`；`system` 时将 NSH `locale()` 的 `zh-*`、`en-*` 分别映射到首批两种语言，其余地区使用源语言 `zh-CN`。`Storage` 保存偏好，应用启动先加载偏好再显示可交互界面。应用层 `t`（翻译函数）在绑定中读取最终语言，调用 i18next 的指定语言翻译；不依赖 `changeLanguage()` 的全局异步切换。已有 store 是这项状态的自然归属，独立包装层的用途仅是隐藏词条与 NSH 响应式桥接。[NSH 设备环境](https://nsh.dev/docs/device-and-environment/)、[i18next 指定语言翻译](https://www.i18next.com/overview/api)
2. **本地词条与文本边界。** 简中是源词条，英语按界面语境重写完整句子。覆盖按钮、标题、状态、空态、Toast、无障碍名称和 runtime 面向 UI 的错误；变量只插入用户输入、数量等运行时数据。对 runtime 返回的用户可见文案使用稳定消息标识与参数，应用层统一翻译，避免业务 bundle 复制一份翻译实例。这个消息标识增加了跨 bundle 的接口，但把语言状态留在同一个所有者，且翻译可以随语言切换立即重算。[i18next 文案实践](https://www.i18next.com/principles/best-practices)
3. **格式化与复数。** 在翻译初始化前载入 `Intl.Locale`、`Intl.PluralRules`，只加载 `en`、`zh` 规则。日期、时间和数字使用 `new Intl.DateTimeFormat(effectiveLocale, ...)` / `Intl.NumberFormat(effectiveLocale, ...)`；i18next 资源显式指定 `fallbackLng: "zh-CN"`。NSH `Text` 不是 HTML，插值不应把 `&` 变为 HTML 实体；配置应与原生文本渲染匹配。[FormatJS polyfill](https://formatjs.github.io/docs/polyfills/intl-pluralrules/)、[i18next 插值](https://www.i18next.com/translation-function/interpolation)
4. **对话语言与音色分开。** 新会话把界面语言作为默认值传给 Realtime 和文字 Agent。明确语言要求优先；完整问题的语言决定当轮输出；短回应沿用会话最近使用的语言。语音转写保留用户原话，工具结果保留原始数据，Agent 最终回答遵守上述回复语言规则；不另加语言检测依赖。豆包首批保留已实测产生英文回复文本及音频的 Vivi 默认音色；自动按轮切换音色会增加会话协议状态和声线跳变，现阶段没有必要。[OpenAI 多语言提示建议](https://developers.openai.com/api/docs/guides/voice-prompting)

## 豆包英文语音实测

2026-11-08 使用仓库 `.env` 中已有的豆包凭证、项目当前 `1.2.6.1` 模型及 `session.create` 格式，经 WebSocket 向 Realtime 接口发送由 macOS `say` 生成的 4.57 秒英文问题：“Hello LOOI. Please answer in English. What color is the sky on a clear day?” 探针临时使用英文回复提示词；产品代码未改动，现有产品提示词仍强制中文。该接口的官方说明确认支持中英文语音对话。[豆包 Realtime API](https://docs.volcengine.com/docs/doubao-voice/end-to-endreal-time-speech-large-model-api-access-document?lang=en)

| 音色 ID | 服务端结果 | 结论 |
| --- | --- | --- |
| `zh_female_vv_jupiter_bigtts`（项目默认） | 收到 `session.created`、英文 `response.output_text.done`、26 个 `response.output_audio.delta`；PCM 共 **507,094 字节**，24 kHz 单声道约 **10.56 秒**。文本为 “On a clear day, the sky looks blue...” | **英文回复文本和对应音频帧均已实测。** [试听文件](artifacts/multilingual/doubao-vivi-english-probe.m4a) |
| `en_female_jenny_uranus_bigtts`（官方英文音色候选） | 同一英文问题返回英文文本、`response.output_audio.started/done`，但没有任何音频 delta。 | 在当前模型和凭证下**不能作为已验证的语音输出选项**；先不加入产品音色选择。 |

默认音色的试听文件保留了服务端返回的音频。英文文本事件与音频帧证明接口有对应输出；朗读内容与听感可通过试听文件直接核对。官方音色表将默认 `jupiter` Vivi 列为中文音色，同时说明中文音色具备英文能力；英文音色是否适用于当前 S2S 模型需要按具体 ID 验证。[豆包音色列表](https://docs.volcengine.com/docs/doubao-voice/tone-list-3?lang=zh)

## 实施顺序与验收

详细执行清单见 [NSH 中英双语接入实施计划](plans/nsh-bilingual-integration-plan.md)。

1. 在后续实施计划中先接语言偏好、i18next 本地词条及 Intl polyfill，再迁移可见界面文案；用 NSH headless（无界面测试）验证系统 `locale()` 更新、手动覆盖持久化、英文 `1 item / 2 items` 和两种语言的日期格式。
2. 将 runtime 面向 UI 的状态和错误转换为稳定消息标识，迁移 Agent 与 Realtime 的语言提示词；分别检查中文、英文、明确要求切换语言、短语气词与中英混合输入，确认最终回答及语音字幕遵守同一规则。
3. 在 iOS 模拟器检查首页、模型、语音、家居和任务空间的英文文本长度、无障碍名称与语言即时切换；以真实豆包会话验证英文朗读和中文返回。当前已保存的英文音频可作为输出基线，英文专用音色需通过有音频帧的实测后才可选用。

本调研只使用本地词条与社区库；不引入 TMS（Translation Management System，翻译管理系统）。
