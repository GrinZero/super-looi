# MobileRuntime 瘦身与后台 Agent / Schedule 移动端宿主拆解计划

## 目标描述

把 `apps/nsh/runtime/application.ts` 从混杂 Composition Root（应用组装根）、后台 Agent 宿主、LLM 模型目录与 OAuth 状态机、Schedule 宿主桥接、MIoT 登录状态机以及大量透传方法的上帝类，重构为薄组装根 `MobileRuntime`（仅暴露 `uiSessionId`、`tracer`、6 个分域子门面 `agent` / `schedule` / `home` / `body` / `plugins` / `github`、`redactSecrets`、`cancelForeground`、`close`）。

## 关键架构决策

1. **动态任务工具组装，消除配置变更误杀执行器**：在 `AgentRuntime` 的 `taskTools(context)` 中按单次任务动态评估 `home.configuration().mode !== "disabled"` 与 `body.configuration().mode !== "disabled"`，使 `configureHome` / `configureBody` 不再触发 `closeExecutorForRebuild()`，避免中断运行中的定时任务或插件后台任务。
2. **MIoT 登录态（`home.isLoginPending`）收归 `HomeController` 内部**：仅锁定家居域操作及家居工具（`list_home_devices` / `control_home_device`），不再阻塞聊天对话、模型配置和底座控制。
3. **后台 Agent 成为与 `VoiceRuntime` 对等的一等子系统（`apps/nsh/runtime/agent/`）**：拆分 `runtime.ts`（`AgentRuntime`）、`models.ts`（`LlmModelManager`，统一 `commitVaultTransaction()` 回滚原语）、`oauth.ts`（`LlmOAuthFlow`）、`history.ts`（`TaskHistoryStore`）与 `types.ts`，对外通过 `agent.ts` 重导出，可脱离 Home / Body / Plugins / Schedule 独立单测。
4. **单向无环模块边界**：抽离 `apps/nsh/runtime/vault.ts` 消除 `body.ts` / `voice/*` 对 `application.ts` 的反向依赖；新增 `schedule.ts`（`ScheduleRuntime`）、`home-controller.ts`（`HomeController`）、`plugins/controller.ts`（`PluginController`），并在 `github-pr-status.ts` 提供 `createGitHubCredentials()` 工厂，不引入额外浅包装类与进程内 EventBus（事件总线）。
5. **两阶段迁移**：Phase 1 完成内部拆分、兼容转发、内核 `sessionId` 透传与独立单测并验证提交；Phase 2 将全部 5 处调用方切换到分域子门面、删除平铺转发壳、更新 `generated/looi-runtime.d.ts` 与 `docs/arch/` 后验证并经独立子 Agent 审查提交。
