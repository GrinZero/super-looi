# 语音管理页重设计

## 页面结构

- 顶栏展示当前语音服务与 OpenAI Realtime 接入位置。当前服务由 `VOICE_PROVIDER` 决定，OpenAI Realtime 显示为待接入标记。
- 配置区整合服务名称、凭证状态和输出音色。未配置时直接输入凭证，已配置时显示摘要，按需展开更换凭证与自定义音色。
- 对话区展示真实连接阶段、开始／结束、静音、打断、Hey LOOI 自动唤醒和当前转写。连接中与已连接使用不同文案。
- 横屏将配置与对话并列；竖屏优先显示对话，再显示配置。各内容区负责自己的滚动，输入沿用管理空间的键盘避让。

## 模块与取舍

`VoiceRuntime` 继续拥有凭证与会话生命周期；`store` 继续暴露配置和操作。`VoiceSpaceView` 只拥有输入草稿、编辑展开与错误反馈，不引入新的服务注册表、持久化选中状态或连接适配层。后续开放服务切换时，可以复用顶栏服务位置与配置区，切换行为仍归运行时所有。

复用 `ActionButton`、`TextField`、`SwitchRow` 和主题令牌。页面内的状态波形仅反映现有音量数据，不新增动画依赖或计时器。

## 实施与验证

- [x] 重组顶栏与配置、会话内容
- [x] 中英文文案及真实连接阶段反馈
- [x] NSH 类型检查与构建
- [x] 更新并运行现有页面交互回归、Mac 原生窗口检查横竖屏布局
- [x] 独立 review 与提交

## 验证证据

NSH 类型检查、构建与独立 review 通过。现有 32 项测试中 31 项通过；另一项旧标题断言更新后，`real_app_task_and_home_panels` 定向复测通过。语音运行时与 17 项 Node 回归通过。

[未配置横屏](../artifacts/voice-space/landscape-light.png)来自实际页面；[已配置横屏](../artifacts/voice-space/configured-preview-light.png)、[深色横屏](../artifacts/voice-space/configured-preview-dark.png)与[深色竖屏](../artifacts/voice-space/configured-preview-portrait.png)复用实际页面组件，在 Mac 原生测试宿主使用内存配置展示已保存状态，未发起语音连接。视口分别为 844 × 390 与 390 × 844pt。

真机待核对项与 Mac 测试宿主 Keychain 写入限制见 `todo.md`。
