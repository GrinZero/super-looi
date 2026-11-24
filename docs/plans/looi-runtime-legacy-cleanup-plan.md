# `packages/looi-runtime` 历史包袱清理与分域导出收口计划

## 目标描述

清理 `packages/looi-runtime` 中从 Hub / Expo 时期遗留、已被 `apps/nsh` 与各独立包取代的死代码和单行转发壳，收口包导出边界与 workspace 依赖，消除跨包相对路径导入与测试状态目录泄漏，为后续的声明式配置（Declarative Configuration）改造建立清晰的包结构。

## 关键架构决策

1. **清除零引用遗留模块与转发壳**：删除仅服务于已废弃 Hub 验收套件的 `acceptance/`、`home/`、`vision/`、`productivity/{dsh-runner,task-supervisor}`、`shell/{longevity-supervisor,presence-state}`、`ui/{cabin-space,light-toast-queue,memories-space,tasks-and-rules-space,theme}`、`voice/loopback` 以及 `robot-face-controller.ts` 中未使用的 `KeepAwakeController`，并移除 6 个单行兼容转发壳（`schedule.ts`、`agent/{conversation-language,pi-executor,task-store,tool-approval,workspace-path}.ts`）。
2. **按真实归属重组活跃模块**：将 UI 操作校验 `authorization.ts` 归入 `agent/governance/` 并由 `interaction-gate.ts` 与 `agent/governance/index.ts` 统一导出；将 72 态表情契约 `face-expressions.ts` 与 `robot-face-controller.ts` 合并到独立的 `src/face/` 域模块。
3. **显式分域 Barrel 与严格 `exports` 映射**：新增 `src/agent/index.ts`（不重新导出含完整 Provider 目录的 `llm-providers.ts`）、`src/face/index.ts` 与 `src/telemetry/index.ts`（不重新导出依赖 `@earendil-works/pi-ai` 的 `llm-observer.ts`）；在 `packages/looi-runtime/package.json` 中移除通配符 `./*` 与未使用的 `@super-looi/home-assistant`、`@super-looi/looi-driver` 依赖，固定 10 个显式子路径入口（`.`、`./agent`、`./agent/llm-providers`、`./agent/language`、`./agent/shell-output`、`./face`、`./schedule`、`./storage`、`./telemetry`、`./voice`）。
4. **单一导出事实源的打包解析**：`apps/nsh/scripts/build-runtime.ts`、`apps/nsh/scripts/build-compat-probe.ts` 与 `packages/nsh-node-compat/scripts/verify.ts` 均读取 `packages/looi-runtime/package.json` 的 `exports` 字段将 `@super-looi/runtime` 及其子路径映射到对应 `src/*.ts`；`apps/nsh` 与 `packages/nsh-node-compat/test` 统一使用包名子路径导入，消除跨包相对深路径引用；测试用临时目录补齐 `llm-providers.test.ts` 与 `agent-web-search.test.ts` 的隔离 `stateDirectory` / `workspaceRoot`，杜绝向 `packages/looi-runtime/data/` 泄漏状态文件。
