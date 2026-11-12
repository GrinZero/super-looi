# Codex CLI 随 App Linux 内置

## 运行路径

用户 → Voice Agent → Task Agent → App 内 Alpine 的普通 Codex 会话 → Codex 服务与目标云环境。

App 内的 Codex CLI 自行完成登录和令牌刷新。Task Agent 通过 `codex_exec` 用自然语言委派创建环境、规划与查询等任务，通过 `codex_cloud` 直接启动云端任务。开发机承担构建与安装。用户选择先使用现有 `video2rig` 环境。插件、授权与双工具设计见 [插件系统与 Codex Cloud 工具方案](plugin-system-and-codex-cloud-plan.md)。

## 发行包与升级

固定官方 `@openai/codex@0.167.2-linux-arm64` 的 `aarch64-unknown-linux-musl` 可执行文件；来源和版本写入 `native/linux/sources.lock.json`。CLI 是静态 ELF，两个加载段均按 64 KiB 对齐，文件大小 279,318,936 字节，约 266.4 MiB。使用原始 CLI 文件，Cloud 和设备码登录不引入其语音运行库或 Code Mode 独立宿主。

CLI 在 Linux 准备流程中下载并打入移动端安装包，首次使用不再下载。iOS 安装器会去掉非 Mach-O 资源的执行位，因此 App 按内置版本将 ELF 安装到自身私有 `linux-tools` 目录，赋予执行权限后挂载到 guest `/opt/looi`，通过 `/usr/local/bin/codex` 符号链接调用。版本更新原位替换工具文件。Android 将 ELF 作为原生可执行资源安装，并通过现有 PRoot 绑定到同一路径。这样已有 guest 无需重装，`apk` 软件包、工作区和 `/root/.codex` 登录态继续使用。

选择挂载 App 发行文件而非替换用户 rootfs，是因为现有 Linux guest 在 App 升级后保留。增加的接口只涉及一个发行文件和已有的挂载边界；不增加服务、远程桥接或另一套任务执行器。

## 步骤

- [x] 固定 App 自有运行环境与账号边界，核对官方 Linux 发行包。
- [x] 接通 iOS／Android 插件打包入口和 guest 的 CLI 挂载。
- [x] Codex 插件贡献 `codex_exec(prompt,sessionId?,cwd?)` 与 `codex_cloud(prompt,environment?,branch?,attempts?)` 两个工具和 Pi 标准 Skill；执行记录关联会话或云端 task ID，保留原始 CLI 结果。
- [x] 在 iOS 模拟器的 App 中验证版本、Cloud 命令帮助和未登录回执。
- [ ] 在 App 插件页完成官方登录、Cloud 列表及任务提交；Android 完整 APK 编译。
- [ ] 完成独立 review、定向检查和文档更新。

## 登录与云端任务

插件启动 App Linux 中的官方 `codex login`，将登录链接展示到插件页并打开系统浏览器。CLI 保存和刷新自身 `/root/.codex` 的凭据，两个工具共享同一登录态：

- `codex_exec` 接收自然语言任务、可选会话 ID 与工作目录，启动普通 `codex exec --json`；进度和完整回答交回 Task Agent，后续可按会话 ID 继续。
- `codex_cloud` 接收任务描述及环境／分支，直接执行 `codex cloud exec`；收到受理后等待当前 CLI 退出，返回真实进程回执、task ID 和链接，不等待云端执行完成，后续可交给 `codex_exec` 查询处理。

Pi 标准 Skill 说明两种入口的选择与回执含义。

第一轮验证先运行不需要登录的命令，再由 App 独立授权，执行普通 Codex 任务并继续同一会话。环境管理以自然语言任务验证，例如通过 `codex_exec` 创建／配置环境，再通过 `codex_cloud` 在该环境启动任务；不将 App 自行实现环境管理 API 作为前置条件。

登录会话由插件拥有，不占用 Agent 的 Shell 期限。普通执行会话使用官方 JSONL 事件取得进度、会话 ID 和完整回答；Cloud 启动回执保留实际受理状态和远端 task ID。Codex 会话 ID 与 Cloud task ID 分别保存，回答结束或提交受理均不等同于远端执行完成。当前使用原生 CLI 接口；外部 A2A Agent 的接入取舍见插件方案第 5.7 节。

## 来源

- [官方 CLI 命令](https://learn.chatgpt.com/docs/developer-commands?surface=cli)：Cloud 提交、列表与认证说明。
- [官方非交互任务](https://learn.chatgpt.com/docs/non-interactive-mode)：自然语言任务、JSONL 事件和会话继续。
- [官方登录说明](https://learn.chatgpt.com/docs/auth)：设备码授权。
- [官方 Cloud 客户端](https://github.com/openai/codex/blob/6bfdc75f0d9e6fae313234f694839866d7c63c39/codex-rs/cloud-tasks-client/src/http.rs)：提交、状态、消息和差异读取。
- [官方 npm 平台映射](https://github.com/openai/codex/blob/6bfdc75f0d9e6fae313234f694839866d7c63c39/codex-cli/bin/codex.js)：Linux ARM64 musl 目标。
