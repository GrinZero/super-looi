# LLM 凭证配置标准化与 NSH 前后台一体化设计方案 (Plan)

## 1. 目标与核心设计原则

本计划包含三个紧密耦合的目标：
1. **LLM（Large Language Model，大语言模型）凭证与调度标准化**：将当前的“硬编码单一生效三元组（`baseUrl` + `model` + `apiKey`）”升级为**直接复用 `@earendil-works/pi-ai@1.5.0` 原生生态的多服务商凭证架构**，引入 `OpenAI / ChatGPT`、`Kimi`、`MiniMax`、`小米 MiMo`、`智谱 / Z.AI` 五大预置服务商，并支持手动配置兼容性 API（Application Programming Interface，应用程序接口）。
2. **搭建「结构 3」后台管理框架 (`ManagementShell`)**：放弃局促的模态对话框（`Panel` / `Dialog`）嵌套，在 `apps/nsh` 中采用**「`58pt` 极窄导航轨 + `48pt` 横向上下文胶囊顶栏 + `7:5` 平衡双栏工作区」**（竖屏手持自动流式折为底栏 + 单列），将 **`模型`**、**`语音`**（独立拆出）、**`家居`**、**`任务`** 四大空间统一收敛。
3. **省电深色桌宠主页 + A/B 明暗双主题后台（去青色系束缚）**：解除对高饱和青色系的绑定，在 [`apps/nsh/DESIGN.md`](file:///Users/bugyaluwang/project/super-looi/apps/nsh/DESIGN.md) 与 [`apps/nsh/theme.json`](file:///Users/bugyaluwang/project/super-looi/apps/nsh/theme.json) 中统一建立双舞台语义体系——**桌宠主页全天保持深色省电底**（白天为 `#11100F` 深炭底 + `#FBF7F0` 清朗暖奶米圆眼，夜间为 `#040405` 纯黑 OLED 零功耗底 + `#E8DAC3` 柔暗暖燕麦米圆眼，去除吓人的拟真眼球高光白斑），**后台管理空间则按白天方案 B（暖石日光 `#F5F4F0`）与夜间方案 A（中性锌灰 `#111113`）自适应切换**。

### 1.1 为什么优先复用 `@earendil-works/pi-ai@1.5.0` 而不自建抽象层？

当前 [`packages/looi-runtime/src/agent/pi-executor.ts`](file:///Users/bugyaluwang/project/super-looi/packages/looi-runtime/src/agent/pi-executor.ts#L382-L450) 在 `createModelAndStream()` 中手动构造了一个名为 `"looi"` 的临时 Provider（服务提供方）并固定绑定 `openAICompletionsApi()`，绕开了 `@earendil-works/pi-ai@1.5.0` 已经内置的核心能力：

1. **标准凭证模型 (`Credential` & `CredentialStore`)**：Pi 已内置区分 `ApiKeyCredential`（`{ type: "api_key", key }`）与 `OAuthCredential`（`{ type: "oauth", access, refresh, expires, ... }`）的联合类型（Union Type），并在 `Models.getAuth()` 中实现了基于 `CredentialStore.modify(providerId, fn)` 互斥锁（Mutex Lock）的双重检查锁定（Double-Checked Locking）自动令牌刷新（距离过期不足 5 分钟时自动调用 `oauth.refresh` 并原子落盘）。
2. **多协议流式引擎 (`api/*`)**：Pi 已内置 `openAICompletionsApi()`（OpenAI Chat Completions 协议）、`openAIResponsesApi()`（OpenAI Responses 协议）和 `anthropicMessagesApi()`（Anthropic Messages 协议），自动处理各协议的工具调用（Tool Call）、思考链（Reasoning/Thinking）和流式事件归一化。
3. **预置服务商与模型目录 (`providers/*` & `auth/oauth/*`)**：Pi 1.5.0 已内置 OpenAI/ChatGPT、Kimi、MiniMax、小米 MiMo、智谱/Z.AI 的工厂函数与模型元数据（上下文窗口、最大输出 Token、思考能力标记）。

### 1.2 新增概念与模块成本审视

| 新增/调整项 | 具体用途 | 复杂性成本与收益评估 |
| :--- | :--- | :--- |
| `LlmProviderCatalog` 与 `VaultCredentialStore`（位于 `packages/looi-runtime/src/agent/llm-providers.ts`） | 将本机 `CredentialVault`（`"model"` 槽位）适配为 Pi 标准的 `CredentialStore` 接口，并组装 5 家预置服务商 + 智谱标准计费端点 + `"custom"` 手动兼容 Provider 到同一个 Pi `Models` 容器中。 | **零外部依赖新增**；约 220 行 TypeScript 代码即可替换硬编码 `"looi"` Provider，无损兼容旧版 `{ baseUrl, model, apiKey }` 存储格式，无需修改 iOS Keychain / Android Keystore 原生 Rust 槽位白名单。 |
| 静态 OAuth 加载器注册（位于 `packages/nsh-node-compat`） | 调用 Pi 内置的 `registerBundledOAuthFlowLoaders` 注入 `kimiCodingOAuth` 与移动端适配的 `openaiChatGPTOAuth`。 | Pi 默认通过动态变量 `import(specifier)` 懒加载 OAuth 模块，在 `esbuild` 单文件打包下无法静态分析。调用 Pi 官方预留的 `registerBundledOAuthFlowLoaders` 钩子仅需约 40 行代码即可在 QuickJS 沙盒内跑通原生 OAuth。 |
| `ManagementShell` 与四空间视图（位于 `apps/nsh/ui/`） | 采用「结构 3」统一承载 `模型`、`语音`、`家居`、`任务`，替代原先独立的模态弹窗嵌套。 | 复用现有 `RobotFace.tsx`（零代码改动即可吃下新主题 Token）、`Controls.tsx` 与 `theme.json`，消除弹窗遮挡与横屏纵向裁切问题。 |

---

## 2. 五大预置服务 + 手动兼容 API 标准化映射矩阵

以 `@earendil-works/pi-ai@1.5.0` 的 `Provider.id` 为唯一凭证键（Key），将用户可选择的连接方式标准化为以下矩阵：

| 服务品牌 | 连接变体 / 计费通道 | Pi Provider ID | 底层复用工厂 / 协议 | 认证方式 (`AuthType`) | 默认端点 (`baseUrl`) | 预置模型目录来源 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **OpenAI / ChatGPT** | 官方 API / ChatGPT 订阅 | `openai` | `openaiProvider()`<br>`openAIResponsesApi` | `api_key` 或 `oauth` (`openaiChatGPTOAuth`) | `https://api.openai.com/v1` | `OPENAI_MODELS` (`gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-4.1`, `o4-mini` 等) |
| **Kimi** | Kimi Code (会员/订阅) | `kimi-coding` | `kimiCodingProvider()`<br>`openAICompletionsApi` | `oauth` (设备码 `kimiCodingOAuth`) 或 `api_key` | `https://api.kimi.com/coding/v1` | `KIMI_CODING_MODELS` (`k3.1-pro`, `k3.1-pro-highspeed`, `k3`, `k3-256k`, `kimi-for-coding`) |
| **Kimi** | Moonshot 开放平台 (国内) | `moonshotai-cn` | `moonshotaiCnProvider()`<br>`openAICompletionsApi` | `api_key` | `https://api.moonshot.cn/v1` | `MOONSHOTAI_CN_MODELS` (`kimi-k3.1-pro`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`) |
| **Kimi** | Moonshot 开放平台 (国际) | `moonshotai` | `moonshotaiProvider()`<br>`openAICompletionsApi` | `api_key` | `https://api.moonshot.ai/v1` | `MOONSHOTAI_MODELS` (同上) |
| **MiniMax** | 国内站 (Anthropic 协议) | `minimax-cn` | `minimaxCnProvider()`<br>`anthropicMessagesApi` | `api_key` | `https://api.minimaxi.com/anthropic` | `MINIMAX_CN_MODELS` (`MiniMax-M3.1-Flash`, `MiniMax-M3`, `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`) |
| **MiniMax** | 国际站 (Anthropic 协议) | `minimax` | `minimaxProvider()`<br>`anthropicMessagesApi` | `api_key` | `https://api.minimax.io/anthropic` | `MINIMAX_MODELS` (同上) |
| **小米 MiMo** | 普通按量 API | `xiaomi` | `xiaomiProvider()`<br>`openAICompletionsApi` | `api_key` | `https://api.xiaomimimo.com/v1` | `XIAOMI_MODELS` (`mimo-v2.6-flash`, `mimo-v2.6-pro`, `mimo-v2.6-pro-ultraspeed`) |
| **小米 MiMo** | Token Plan (国内 / 新加坡 / 欧洲) | `xiaomi-token-plan-cn`<br>`xiaomi-token-plan-sgp`<br>`xiaomi-token-plan-ams` | `xiaomiTokenPlan{Cn,Sgp,Ams}Provider()`<br>`openAICompletionsApi` | `api_key` | `https://token-plan-{cn,sgp,ams}.xiaomimimo.com/v1` | `XIAOMI_TOKEN_PLAN_*_MODELS` (`mimo-v2.6-flash`, `mimo-v2.6-pro`) |
| **智谱 / Z.AI** | **标准 API (国内 BigModel)** | `zai-cn` *(基于 Pi 派生)* | `createProvider` + `openAICompletionsApi` | `api_key` | `https://open.bigmodel.cn/api/paas/v4` | 复用 `ZAI_CODING_CN_MODELS` (`glm-5.3`, `glm-5.3-flash`, `glm-5.3-highspeed`, `glm-4.6v`) |
| **智谱 / Z.AI** | **标准 API (国际 Z.AI)** | `zai-intl` *(基于 Pi 派生)* | `createProvider` + `openAICompletionsApi` | `api_key` | `https://api.z.ai/api/paas/v4` | 复用 `ZAI_MODELS` (`glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `glm-5-turbo`, `glm-4.7`) |
| **智谱 / Z.AI** | Coding Plan 专属端点 (国内 / 国际) | `zai-coding-cn`<br>`zai` | `zaiCodingCnProvider()`<br>`zaiProvider()` | `api_key` | `https://open.bigmodel.cn/api/coding/paas/v4`<br>`https://api.z.ai/api/coding/paas/v4` | `ZAI_CODING_CN_MODELS` / `ZAI_MODELS` |
| **兼容 API (手动)** | 自定义第三方 / 网关 | `custom` | `createProvider` + 可选协议 (`openai-completions` / `openai-responses` / `anthropic-messages`) | `api_key` | 用户手动输入 HTTPS 地址 | 用户手动输入 `modelId` |

> **关键设计细节（智谱 / Z.AI 计费端点修正）**：
> 在 `@earendil-works/pi-ai@1.5.0` 中，`zaiCodingCnProvider()` 和 `zaiProvider()` 默认的 `baseUrl` 均为 `/api/coding/paas/v4`（Coding Plan 专用端点）。为避免标准按量 API Key 请求被拒，注册表显式派生 `zai-cn`（`https://open.bigmodel.cn/api/paas/v4`）与 `zai-intl`（`https://api.z.ai/api/paas/v4`）作为智谱默认选项，Coding Plan 作为显式切换项。

---

## 3. 存储结构 (`ModelVaultEnvelope`) 与旧配置无缝迁移

在不改动 Rust 原生层 [`apps/nsh/src/credentials.rs`](file:///Users/bugyaluwang/project/super-looi/apps/nsh/src/credentials.rs#L12-L18) 槽位白名单（`"model" | "voice" | "home" | "probe"`）的前提下，`"model"` 槽位升级为版本化结构（读取时自动将旧版 `{ baseUrl, model, apiKey }` 迁移至 `"custom"` 通道）：

```ts
import type { AuthType, Credential } from "@earendil-works/pi-ai";

export type CompatibleApiProtocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";

export interface CustomEndpointConfig {
  api: CompatibleApiProtocol;
  baseUrl: string;
  modelId: string;
}

export interface ActiveLlmSelection {
  providerId: string;
  modelId: string;
  authType: AuthType;
}

export interface ModelVaultEnvelope {
  version: 2;
  deviceId: string;
  conversationId: string;
  active?: ActiveLlmSelection;
  custom?: CustomEndpointConfig;
  customModelsByProvider?: Record<string, string[]>;
  credentials: Record<string, Credential>;
}
```

---

## 4. 前后台一体化视觉规范与「结构 3」布局设计 (`apps/nsh`)

### 4.1 省电深色桌宠主页 + A/B 双主题后台（对齐 `apps/nsh/DESIGN.md`）

完整 Token 表与交互约束以 [`apps/nsh/DESIGN.md`](file:///Users/bugyaluwang/project/super-looi/apps/nsh/DESIGN.md) 为准：

| 语义角色 | **Dark · 暗黑模式（夜间）** | **Light · 白天模式（日间）** |
| :--- | :--- | :--- |
| **桌宠主页舞台基底 (`stage-bg`)** | `#040405`（纯黑 OLED 零功耗基底，隐入屏幕黑边） | `#11100F`（温润深炭基底，省电且抗日间环境眩光） |
| **桌宠纯净自发光圆眼 (`eye-core` / `eye-halo`)** | `#E8DAC3`（柔和压暗的暖燕麦米色 + `0.14` 暖光晕，无高光白斑） | `#FBF7F0`（清朗暖奶米色 + `0.16` 暖光晕，无高光白斑） |
| **后台页面与侧轨基底 (`background` / `sidebar`)** | **方案 A（中性锌灰）**：`#111113` / `#161619` | **方案 B（暖石日光）**：`#F5F4F0` / `#EBE9E2` |
| **后台卡片与分割线 (`card` / `border`)** | `#1B1B1F` / `#2C2C33` | `#FFFFFF` / `#DFDDD5` |
| **后台文本与主按钮 (`foreground` / `primary`)** | `#F4F4F5` / `#F4F4F5`（纯白主按钮深色字） | `#18181B` / `#18181B`（深墨主按钮纯白字） |
| **状态语义色 (`verified` / `destructive` / `warning`)** | `#22C55E` / `#F87171` / `#FBBF24` | `#16A34A` / `#DC2626` / `#D97706` |

### 4.2 后台管理空间统一布局（「结构 3」语法）

- **横屏底座态 (`width >= 600pt`)**：
  1. **左侧极窄导航轨 (`58pt`)**：
     - 顶部 `40×40pt` 双圆点微缩桌宠按钮（同色系卡片底 + 双眸圆点），点击即刻切回全屏桌宠大脸。
     - 中部 4 个 `>=44×44pt` 导航项：**`模型`**、**`语音`**、**`家居`**、**`任务`**（选中态仅用圆角底色填充，不加单侧竖条）。
  2. **顶部横向上下文胶囊栏 (`48pt`)**：
     - **`模型` 空间**：横向可滚动服务商胶囊条 `[OpenAI / ChatGPT]`、`[Kimi]`、`[MiniMax]`、`[小米 MiMo]`、`[智谱 / Z.AI]`、`[+ 兼容 API]`（带已配置绿点标记），右侧辅以外观切换入口。
     - **`语音` 空间**：展示 `豆包端到端实时语音` 状态摘要与采样规格。
     - **`家居` 空间**：横向切换 `[米家账号直连]`、`[Home Assistant]`、`[离线演示]` 与停用操作。
     - **`任务` 空间**：展示任务总数、`开始新对话` 与 `刷新` 动作。
  3. **下方 `7:5` 平衡双栏工作区（`flex-1`）**：
     - **`模型` 空间**：左栏（7 列）承载「接入通道胶囊切换 + OAuth 授权卡 / API Key 掩码输入 + 计费端点回显 + 保存按钮」；右栏（5 列）承载「可用模型列表（点击即设为全局生效模型）+ 自定义 Model ID 输入」。
     - **`语音` 空间**：左栏管理豆包实时语音 API Key（独立存储于 `"voice"` 槽位）；右栏控制 LIVE 会话开关与麦克风隐私说明。
     - **`家居` 空间**：左栏承载当前选中模式的配置（米家服务区域与登录/刷新/登出，或 HA 地址与令牌）；右栏实时展示已发现设备与状态回读预览。
     - **`任务` 空间**：左栏（5 列）为任务列表；右栏（7 列）原地展示当前选中任务的步骤、命令退出码、家居回执与产物哈希。
- **竖屏手持态 (`width < 600pt`)**：
  - 左侧导航轨自动转为底部安全区导航栏（含返回桌宠入口），`7:5` 双栏自然流式折为单列纵向滚动，方便双手握持粘贴 API Key 与完成浏览器 OAuth 授权。

---

## 5. 分阶段实施步骤 (Implementation Steps)

### Step 1：构建标准化 LLM Provider 目录与 `VaultCredentialStore`
- 新增 [`packages/looi-runtime/src/agent/llm-providers.ts`](file:///Users/bugyaluwang/project/super-looi/packages/looi-runtime/src/agent/llm-providers.ts)，实现 `LLM_PROVIDER_CATALOG`、`VaultCredentialStore`、`createLooiModelsRegistry` 及旧版三字段配置无损迁移，并补充单元测试。

### Step 2：升级 `PiAgentExecutor` 与 `packages/nsh-node-compat` OAuth 支持
- 在 [`packages/nsh-node-compat`](file:///Users/bugyaluwang/project/super-looi/packages/nsh-node-compat/src/bundler.ts) 中提供轻量 `node:http` 垫片并通过 `registerBundledOAuthFlowLoaders` 静态注册 `kimiCodingOAuth` 与 `openaiChatGPTOAuth`。
- 升级 [`packages/looi-runtime/src/agent/pi-executor.ts`](file:///Users/bugyaluwang/project/super-looi/packages/looi-runtime/src/agent/pi-executor.ts) 支持直接从 `Models` 实例按 `{ providerId, modelId }` 获取模型与流式通道。

### Step 3：升级 `theme.json`、`RobotFace.tsx` 与 `DESIGN.md`（省电深色桌宠主页 + A/B 双主题后台落地）
- 更新 [`apps/nsh/theme.json`](file:///Users/bugyaluwang/project/super-looi/apps/nsh/theme.json) 的 `dark`（夜间纯黑 OLED 桌宠 `#040405` + 暖燕麦米眼 `#E8DAC3`；后台方案 A 中性锌灰 `#111113`）与 `light`（白天温润深炭桌宠 `#11100F` + 暖奶米眼 `#FBF7F0`；后台方案 B 暖石日光 `#F5F4F0`）全量语义 Token，并在 [`apps/nsh/ui/RobotFace.tsx`](file:///Users/bugyaluwang/project/super-looi/apps/nsh/ui/RobotFace.tsx) 中去除拟真眼球高光白斑与暗底月牙内缘，严格对齐 [`apps/nsh/DESIGN.md`](file:///Users/bugyaluwang/project/super-looi/apps/nsh/DESIGN.md)。

### Step 4：升级 `MobileRuntime`、`store.ts` 与「结构 3」后台四空间 UI
- 在 [`apps/nsh/runtime/application.ts`](file:///Users/bugyaluwang/project/super-looi/apps/nsh/runtime/application.ts) 与 [`apps/nsh/store.ts`](file:///Users/bugyaluwang/project/super-looi/apps/nsh/store.ts) 中暴露多 Provider 凭证状态、保存、清除与 OAuth 登录/取消/登出接口。
- 实现 `ManagementShell.tsx` 及 `ModelsSpaceView.tsx`、`VoiceSpaceView.tsx`、`HomeSpaceView.tsx`、`TasksSpaceView.tsx`，连通 [`apps/nsh/App.tsx`](file:///Users/bugyaluwang/project/super-looi/apps/nsh/App.tsx) 前后台切换，保持现有测试契约兼容并新增多 Provider / 后台切换测试。

### Step 5：全量验证与独立子 Agent 审查
- 运行 `packages/looi-runtime`、`packages/nsh-node-compat` 与 `apps/nsh` 全部单元测试、类型检查与构建。
- 在 iOS 模拟器中实机验证深色 A / 浅色 B 下的桌宠光学大脸与「结构 3」后台四空间交互，采集实机截图并交由独立子 Agent 审查。
