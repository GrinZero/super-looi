# NSH 中英双语

NSH 支持 `zh-CN` 与 `en-US`。默认跟随 NSH 响应式系统语言；管理空间「设置」页的语言下拉框（`跟随系统`／`简体中文`／`English`）可覆盖，并由 `Storage` 保存。其他系统语言映射到简体中文。

## 实现边界

- `apps/nsh/store.ts` 持有语言偏好；`i18n` 读取最终语言，按绑定求值翻译。已有状态、错误与 Toast 保存稳定消息标识及参数，展示时翻译。模型 ID、用户输入和服务端原始数据不作为词条。
- 本地词条使用 i18next core 27.0.1；FormatJS 补齐 NSH QuickJS 缺少的 `Intl.Locale` 与 `Intl.PluralRules`，仅加载中英复数数据。日期、数字明确传入最终界面语言。
- iOS 与 Android 的米家登录原生弹层接收应用语言，原生标题／取消按钮跟随应用覆盖值；网页登录内容由米家提供。
- 文字 Agent 与 Realtime 共用语言规则：新会话默认界面语言，明确要求或另一语言的完整问题切换，短回应沿用最近回复语言。Pi 恢复历史时移除旧 system 消息，使用本轮系统提示；短回应按去掉引用和代码后的正文语言附加本轮语言指令。任务账本保留用户原文。
- Realtime 在完整回复的 `text_done` 边界识别正文语言，仅在变化时通过 `session.update` 更新当前会话语言提示。更新只携带 instructions，保留音色和工具配置；不等待用户短语转写后再修改提示。
- 音色保留 `zh_female_vv_jupiter_bigtts`，未增加未经当前账号验证的英文专用音色。

## 体积

同一 NSH 0.4.0、普通 `build` 配置，对比实施前 HEAD 加原有未提交改动的隔离工作区与双语版本：

| 产物 | 实施前 | 双语版本 | 增量 |
| --- | ---: | ---: | ---: |
| bundle.js | 1,481,879 B | 2,020,947 B | 539,068 B（526.4 KiB，36.4%） |
| bundle.nshc | 4,928,338 B | 5,732,699 B | 804,361 B（785.5 KiB，16.3%） |

增量包含词条、polyfill、i18next 和接入代码。保留依赖的理由是使用经过维护的复数与语言标签实现，并免去自建词条语法；代价主要是包体增加。

## 验证

- `pnpm typecheck`、`pnpm test` 通过。Runtime 79 项；NSH 21 项；另有 contracts 5 项、driver 15 项、home-assistant 45 项以及 Node 兼容层契约测试。
- `pnpm --filter @super-looi/nsh build` 通过；NSH 和 iOS host 的既有 Rust 警告数量与基线一致。
- NSH Rust 测试 `real_app_task_and_home_panels` 通过 `set_environment` 在运行中改变系统 locale，验证中文／英文响应；UI 测试验证手动覆盖及重启恢复。QuickJS 实际运行英文单复数、中文／英文日期与数字格式。
- `pnpm --filter @super-looi/nsh test:voice-runtime` 验证 VoiceRuntime 创建后改变应用语言，新会话握手使用最新语言。
- `pnpm --filter @super-looi/nsh test:plugins` 通过；iOS 原生登录桥接随模拟器构建编译。
- `pnpm --filter @super-looi/nsh exec node --import tsx scripts/nsh.ts ui-bilingual-ios` 在 iPhone 16e 模拟器通过英文各空间、即时切换与首页验收。

实际 Pi `mode: "voice"` 会话依次得到中文回答、英文回答、含“你好”引用的英文解释、对“嗯”的英文回应，再按明确要求返回中文。短回应样例输出为 “Alright! Let me know how I can assist you.”。

实际豆包会话使用产品 `voiceInstructions("zh-CN")` 和默认 Vivi，英文问题返回英文文本和 29 个音频帧，共 575,872 B PCM（24 kHz 单声道）。[试听](artifacts/multilingual/doubao-bilingual-product-english.m4a)。

## 界面截图

[首页](artifacts/multilingual/ios-face-en.png) · [模型](artifacts/multilingual/ios-models-en.png) · [语音](artifacts/multilingual/ios-voice-en.png) · [家居](artifacts/multilingual/ios-home-en.png) · [任务](artifacts/multilingual/ios-tasks-en.png) · [设置](artifacts/multilingual/ios-settings-en.png)

## Realtime 连续语言切换

同一真实豆包会话收到 `session.updated` 后，三轮输入、最终文字与有声输出均通过：

| 输入 | 最终回复 | PCM 字节 |
| --- | --- | ---: |
| 英文完整问题：晴天天空的颜色 | 英文解释蓝天 | 443,386 |
| 短回应「好的。」 | “Got it! Let me know if you have another question.” | 143,238 |
| 「请用中文告诉我，太阳从哪边升起？」 | 中文解释太阳从东方升起 | 441,640 |

[转写、最终文字和音频帧统计](artifacts/multilingual/doubao-language-turns.json) · [三轮回复试听](artifacts/multilingual/doubao-language-turns.m4a)。该机制使用[豆包全双工协议的 session.update](https://docs.volcengine.com/docs/doubao-voice/end-to-end-real-time-voice-full-duplex-version?lang=zh)。
