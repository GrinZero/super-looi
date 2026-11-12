# Codex CLI 与新版 Cloud 环境兼容性

核对日期：2026-11-13。核对对象为官方 CLI（命令行客户端）稳定版 `0.167.2`、该版本源码、`main` 上的新 Cloud 客户端，以及 openai/codex 的公开 issue、评论和 PR（合并请求）。

## 结论

App 内置的 `0.167.2` 与本次核对时的 npm `latest`、[官方最新稳定发布](https://github.com/openai/codex/releases/tag/rust-v0.167.2)一致。已有多个公开报告复现“同账号网页有新版环境，CLI 环境目录为空”，其中 [#50182](https://github.com/openai/codex/issues/50182) 与本项目的接口、错误和环境类型直接匹配。

`codex cloud` 的环境发现仍使用旧 `wham` 目录，并要求目录返回匹配项之后才创建任务。该版本没有把新版 `environment-configs` 目录接入这一子命令。仅把新环境 ID 填入旧创建接口，也不是已验证的修复路径：[#56995](https://github.com/openai/codex/issues/56995) 单独报告了下一阶段的创建失败。

上游 `main` 已合入原生 Cloud 会话客户端和 TUI（终端交互界面）接入，但相关实现不在 `0.167.2` 稳定分支中；目前也不能把它等同于一个可直接替换 `codex cloud exec --env video2rig` 的已发布命令。

## 直接相关的公开报告

以下是用户在官方仓库中的报告；状态与更新时间来自本次读取的 issue 元数据。

| Issue | 状态／最后更新（UTC） | 与本问题相关的证据 |
| --- | --- | --- |
| [#50182：当前 Cloud 环境无法被 CLI 发现](https://github.com/openai/codex/issues/50182) | Open／2026-11-11 | 同一 ChatGPT 账号，新目录有 `caas`／`asenvcfg_` 环境，旧目录 HTTP 200 空数组，CLI 在环境解析阶段拒绝提交。最初版本为 0.160.0。 |
| [#56350：新版环境不可见及模型设置不生效](https://github.com/openai/codex/issues/56350) | Open／2026-11-09 | 0.164.0 的独立复现；新环境在网页可运行，CLI 仅能看到旧环境。该 issue 还讨论旧任务的模型设置，不能将两个问题视为同一个故障。 |
| [#56995：已知新版环境 ID 仍无法通过旧接口创建](https://github.com/openai/codex/issues/56995) | Open／2026-10-26 | 报告者用新目录取得 `asenvcfg_` ID 后，向 `/backend-api/wham/tasks` 按官方 CLI 请求体提交，收到 HTTP 500；同环境网页任务成功。 |
| [#51585：CLI、桌面和网页目录不一致](https://github.com/openai/codex/issues/51585) | Open／2026-10-29 | 后续评论报告 0.166.0 仍只看到 Global 与旧环境，升级未解决新环境发现。 |

[#50182 的 0.167.0 复现](https://github.com/openai/codex/issues/50182#issuecomment-6705213203)还记录了重新登录及独立 `CODEX_HOME` 无效。[另一条评论](https://github.com/openai/codex/issues/50182#issuecomment-6771592408)记录 CLI 与网页的 `ChatGPT-Account-Id` 一致，但结果仍为空。

本次读取 #50182 的 28 条评论、#56350 的 6 条评论及 #56995 的评论列表，没有看到 GitHub 标记为 MEMBER／OWNER 的回复提供修复版本、发布日期或已支持的新命令。自动重复检测评论不能视为维护者的根因确认。

[#55757](https://github.com/openai/codex/issues/55757#issuecomment-6357986312)有 OpenAI 成员回复，内容是改进网页环境选择器的不可用原因提示并收集账号、仓库访问与客户端差异；它没有给出本次 CLI 新旧目录问题的修复方案。

## 稳定版源码与文档

`0.167.2` 的 [env_detect.rs](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/cloud-tasks/src/env_detect.rs#L307-L405)查询全局及仓库专属的 `wham/environments`。其 [resolve_environment_id](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/cloud-tasks/src/lib.rs#L203-L247)先判断目录是否为空，然后才匹配输入的 ID 或名称。因此，改用完整 ID、版本 ID，或者只改变环境名称，不能绕过空目录判断。

[官方命令文档](https://learn.chatgpt.com/docs/developer-commands#codex-cloud)仍将 `codex cloud` 标为 Experimental，并说明 `cloud exec --env` 的提交方式；[新版环境指南](https://learn.chatgpt.com/docs/environments/cloud-environments)区分了当前 Cloud 与 Legacy 体验。命令文档中没有给出 `asenvcfg_` 环境与旧任务 API 的映射。

## 上游的新客户端进展

下列 PR 均已合入 `main`，但不是 `0.167.2` 已发布修复：

| PR | 提供的能力 |
| --- | --- |
| [#59493](https://github.com/openai/codex/pull/59493) | 把原生 Cloud 客户端适配到 Rust 的 AppServerClient。 |
| [#59693](https://github.com/openai/codex/pull/59693) | Cloud 会话列表、创建、历史、提交用户输入及中断。 |
| [#60007](https://github.com/openai/codex/pull/60007) | 新 Cloud 会话可以根据本地项目的 GitHub origin 准备仓库。 |

本次 [稳定分支与 #60007 合并提交的比较](https://github.com/openai/codex/compare/rust-v0.167.2...7de8a0afc0c14fb600ec657befafa1312845f155)为 diverged，合并提交不包含于稳定分支；#59493、#59693 的比较结果相同。稳定版的 [cloud-client README](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/cloud-client/README.md)仍只描述已有会话的 Resume／Attach；新 prewarm 实现和 native cloud_backend 模块未包含在该 tag 中。

在本次检查的 `main` 快照中，TUI 接入受 `tui_multi_backend` 控制，该 flag 为 UnderDevelopment、默认关闭；入口还限制为 macOS／Linux 等条件。[flag 定义](https://github.com/openai/codex/blob/d2f76324729d7c4a2b3225cfe42c7dbf162d98b7/codex-rs/features/src/lib.rs)、[TUI 接入](https://github.com/openai/codex/blob/d2f76324729d7c4a2b3225cfe42c7dbf162d98b7/codex-rs/tui/src/lib.rs)、[原生连接](https://github.com/openai/codex/blob/d2f76324729d7c4a2b3225cfe42c7dbf162d98b7/codex-rs/app-server-client/src/cloud_backend/auth.rs)。

这条路线使用 `codex-cloud-backend.chatgpt.com` 的原生 gRPC。当前公开的 [prewarm 接口](https://github.com/openai/codex/blob/d2f76324729d7c4a2b3225cfe42c7dbf162d98b7/codex-rs/cloud-client/src/prewarm.rs)支持默认环境及项目仓库覆盖，项目分支内写入的是 `asenvcfg_base`，没有向调用方开放任意已发布环境的配置 ID。Rust 内部客户端接入不等于 `codex app-server` 可执行程序已经提供对应的远端转发 RPC。

[#56350 的一条社区评论](https://github.com/openai/codex/issues/56350#issuecomment-6450634095)报告通过桌面后台的 WebSocket 协议创建了指定环境的会话。该评论明确说明这是观察到的桌面协议行为，没有声称它是受支持的公开 API；没有关联的稳定版 CLI 修复。

## 与本项目实测的对应关系

本项目在 NshDev 的 App Linux 中使用 App 自有 Codex OAuth 凭据直接请求云端，未使用开发机 CLI 或开发机凭据：

| 请求 | 实际结果 |
| --- | --- |
| 旧 `/backend-api/wham/environments` | HTTP 200，空数组；有无账号头结果相同。 |
| 新 `/api/codex-cloud/v1/environment-configs`，`scope=user` | HTTP 200，含 `Default environment` 和 `video2rig`。 |
| 同一新接口，`scope=workspace` | HTTP 200，仅默认环境。 |
| 网页读取 `video2rig` 详情 | `provider=caas`、`status=ready`。 |

这是本项目对目录不兼容的直接证据，与 #50182 相符；不应再把 CLI 空目录解释成该账号没有环境。新目录可读，也不证明新会话创建、输入提交、状态和结果读取已经贯通。[本项目排查记录](codex-linux-login-diagnosis.md)。

对现有双工具契约的影响是：EXEC 可继续使用内置 CLI；Cloud 的修复必须覆盖新版会话的创建与提交协议，单独替换环境列表请求不够。采用上游新客户端还需要处理尚未开放的指定环境选择，以及会话受理／执行结果转换；这部分复杂度不能按“升级 CLI”或“换一个 GET 地址”估算。
