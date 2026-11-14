# Super LOOI 插件系统 v2 与可变形首屏舞台架构方案

## 1. 背景与目标

第一版插件骨架（`apps/nsh/runtime/plugins/contracts.ts`、`host.ts`、`ui/PluginsSpaceView.tsx`）仅围绕单一内置插件 `codex` 构建，存在四项结构性局限：

1. **元数据与分类写死在宿主**：缺少独立的静态清单（`PluginManifest`），分类筛选与配置页 JSX 硬编码在 `PluginsSpaceView.tsx` 中，且插件自身版本与内部 CLI 版本混用同一字段。
2. **插件孤岛化，底层能力无法跨插件复用**：单向星型结构使未来的底层能力插件（如人脸/人体视觉识别）无法向其他玩法插件（如“粘人小猫”跟随、“狼人杀上帝裁判”）暴露可复用的感知服务。
3. **UI 扩展能力缺失**：插件无法自定义复杂配置界面；横屏首屏（`App.tsx`）将 `RobotFace` 固定铺满主舞台，无法弹出多档位交互抽屉或联动缩放悬浮机器人表情脸。
4. **底座上下文与 AI 介入粒度过粗**：宿主仅向后台 `PiAgentExecutor` 合并静态工具数组与 `skillPaths`，插件无法动态注册表情、正交控制视线、借用电机连续伺服、读取手机本机前/后置摄像头，也无法对实时语音环（`VoiceRuntime`）与深度任务环（`PiAgentExecutor`）执行确定性拦截或按需多模态上下文组装。

本方案面向插件生态与插件市场（Plugin Marketplace），构建由五大子系统组成的受保护具身插件微内核：
- **包与拓扑管理器（Package & DAG Service Manager）**：管理一级分类、SemVer 版本迁移与跨插件有向无环服务依赖图（`provides` / `dependencies`）；
- **可逆副作用作用域树（Reversible `EffectScope` Tree）**：统一管理插件级与子阶段级（`forkScope`）硬件租约、表情注册、AI 拦截器与跨插件监听的逆序原子回滚；
- **具身硬件租约调度器（Capability & Priority Lease Scheduler）**：仲裁动态表情与正交视线栈、可抢占底座电机伺服租约及手机本机前后摄像头帧流；
- **首屏可变形舞台合成器（Morphable Stage Compositor）**：编排 `RobotFace` 空间姿态（全屏、顶部缩放悬浮、角落画中画、左右分屏）与底部四档位抽屉共存；
- **双环 AI 认知管线（Dual-Loop AI Pipeline）**：打通双环 `bail` 短路守卫、带硬超时预算的 `waterfall` 按需上下文组装与主动语音播报同步。

---

## 2. 关键设计取舍与复杂度成本核算

### 2.1 核心设计取舍

1. **跨插件拓扑（受保护具身微内核 + DAG 服务图 vs 纯星型孤岛 / 全系统无特权插件化）**
   - 保留 `VoiceRuntime`、`LooiBle`、`RobotFace` 渲染引擎与首屏安全控制柄在强类型宿主微内核中，确保物理电机急停与首屏逃生通道不可被第三方插件覆写；
   - 在插件层引入受静态清单约束的 `provides` 与 `dependencies`（支持硬依赖 `optional: false` 级联挂起恢复与软依赖 `optional: true` 子作用域热插拔），实现单次传感器采集与识别推理赋能多个上层插件。
2. **UI 交付边界（Dual-Realm 双面满血 NSH TSX vs JSON Schema 表单 / 单文件混写）**
   - 顺应 `looi-runtime`（esbuild Node 兼容层）与 NSH 视图层（QuickJS 正式包禁用 `eval` / `Function`）的双编译管线，插件拆分为 `runtime/` 与 `ui/` 两个编译面；
   - UI 组件禁止直接触碰后台 `PluginContext` 句柄，仅消费响应式快照投影 `PluginViewContext<TState, TCommand>` 并通过类型化 `sendCommand` 交互；内置插件通过 NSH Split Chunks 按需加载，市场插件通过 `nsh-package` 双层 Ed25519 签名包下发。
3. **横屏首屏扩展（Morphable Stage 可变形合成器 vs 静态侧栏 / 全屏遮挡）**
   - 首屏保留单一 `<RobotFace />` 实例不断帧运行，通过弹簧几何插值切换 `FaceStagePosture`（如 `floating_top` 顶部悬浮迷你脸），下方配合四档位 `StageDrawer` 承载发牌、选人等重触控交互。
4. **双环 AI 介入（超时受控的 `bail` + `waterfall` + 可逆槽位 vs 纯静态提示词拼接）**
   - 安全审批与游戏防泄密采用确定性 `bail` 短路守卫（遵循 Fail-Closed 失败即拒绝，淘汰 `application.ts` 中的硬编码 `toolApprovalRules`）；
   - 按需上下文与多模态抓拍采用带硬超时预算的 `waterfall` 管线（实时语音环 `80ms`、后台任务环 `1500ms`），超时仅跳过慢插件增强，不阻塞实时对话。

### 2.2 新增概念与复杂度成本账本

| 模块 / 概念 | 具体用途 | 复杂度成本与删除测试结果 |
| --- | --- | --- |
| `PluginManifest`（含 `provides` / `dependencies`） | 静态声明分类、SemVer、底座权限与跨插件服务拓扑 | 纯静态结构；若删除则无法在不启动插件运行时的前提下渲染分类目录、校验权限与检测循环依赖 |
| `EffectScope` & `forkScope()` | 统一收集并按 LIFO 逆序回滚硬件租约、表情、AI 钩子与服务监听 | 约 60 行无外部依赖树形析构栈；消除多阶段插件（如狼人杀各夜晚环节）对称清理样板代码与状态泄漏 |
| `PluginServiceRegistry` | 管理跨插件类型化服务注册、Kahn 拓扑排序、SemVer 校验与热插拔代理 | 约 100 行拓扑与存活代理逻辑；支撑底层视觉/记忆能力跨插件复用 |
| `PluginBridge<S, C>` & `StageManager` | 桥接后台状态快照与满血 NSH TSX 配置页/首屏可变形舞台，提供 `<ErrorBoundary>` 隔离 | 替代 `PluginsSpaceView.tsx` 与 `App.tsx` 的特判分支，支撑全部未来配置页与首屏舞台插件 |
| `ExpressionRegistry` & 分层表情栈 | 支持命名空间表情动态注册与 P0–P5 表情/视线 `gaze` 正交叠加 | 复用现有 60fps 几何插值渲染器，仅在 `RobotFaceController` 增加分层求值逻辑 |
| `BodyServoLease` & `DeviceCameraHost` | 提供可被用户指令实时抢占的电机连续伺服租约与手机本机前后摄像头抽帧/预览 | 填补本机前后摄能力缺口，确立多插件与用户手动控制间的电机抢占边界 |
| `DualLoopAiBus` | 统一承载双环 `useContextSlice`、`usePersonaOverlay`、`useTurnAssembler`、`interceptUserTurn`、`interceptToolCall` 与 `speak` | 收敛散落在 `application.ts` 与 `voice/` 的胶水逻辑，提供统一可观测追踪 |

---

## 3. 系统架构与核心接口契约

### 3.1 目录规范

```text
apps/nsh/plugins/<plugin-id>/
├── manifest.ts          # 静态清单：ID、SemVer、分类、权限白名单、provides/dependencies
├── contracts.ts         # 插件私有状态快照 TState、指令 TCommand 与导出服务 TS 接口
├── runtime/
│   └── index.ts         # 后台运行时：基于 PluginContext 与 EffectScope 编排业务状态与硬件/AI
└── ui/
    ├── index.ts         # UI 模块导出：注册 SettingsView、StageCapsule、StageDrawer、StageCanvas
    └── SettingsView.tsx # 插件自定义配置页 TSX
```

### 3.2 清单、拓扑与 `EffectScope` 契约（`apps/nsh/runtime/plugins/contracts.ts`）

```ts
export type PluginCategory =
  | "productivity"       // 开发与生产力
  | "vision_motion"      // 视觉感知与躯体伴随
  | "games_social"       // 聚会桌游与互动主持
  | "persona_expression" // 角色人设与表情扩展
  | "smart_space"        // 智能空间与家居联动
  | "utilities";         // 实用工具

export type PluginPermission =
  | "face.control"
  | "face.register"
  | "body.motion"
  | "camera.front"
  | "camera.back"
  | "ai.tools"
  | "ai.context"
  | "ai.intercept"
  | "ai.proactive"
  | "stage.ui"
  | "linux.exec"
  | "network.https";

export type PluginServiceId = `${string}.${string}`;

export interface PluginServiceDescriptor {
  readonly id: PluginServiceId;
  readonly version: string;
  readonly summary?: LocalizedText;
}

export interface PluginServiceDependency {
  readonly service: PluginServiceId;
  readonly versionRange: string;
  readonly optional?: boolean;
}

export interface LocalizedText {
  readonly "zh-CN": string;
  readonly "en-US": string;
}

export const HOST_PLUGIN_API_VERSION = 2;

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly minHostApiVersion: number;
  readonly category: PluginCategory;
  readonly icon: string;
  readonly name: LocalizedText;
  readonly summary: LocalizedText;
  readonly author: { readonly name: string; readonly verified?: boolean };
  readonly permissions: readonly PluginPermission[];
  readonly provides?: readonly PluginServiceDescriptor[];
  readonly dependencies?: readonly PluginServiceDependency[];
  readonly marketplace?: {
    readonly packageUrl?: string;
    readonly changelog?: LocalizedText;
  };
}

export type PluginLifecycleState =
  | "registered"
  | "waiting_dependency"
  | "starting"
  | "active"
  | "stopping"
  | "stopped"
  | "failed";

export type Dispose = () => void | Promise<void>;

export interface EffectScope {
  readonly id: string;
  readonly active: boolean;
  onDispose(cleanup: Dispose): Dispose;
  fork(label?: string): EffectScope;
  dispose(): Promise<void>;
}

export interface PluginServiceRegistry {
  provide<TService extends object>(
    serviceId: PluginServiceId,
    implementation: TService,
    scope?: EffectScope,
  ): Dispose;
  get<TService extends object>(serviceId: PluginServiceId): TService;
  whenAvailable<TService extends object>(
    serviceId: PluginServiceId,
    callback: (service: TService, depScope: EffectScope) => void | Promise<void>,
    scope?: EffectScope,
  ): Dispose;
}
```

### 3.3 硬依赖级联与存储迁移规则

1. **SQLite 持久化结构**：
   - `plugin_installations(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, installed_version TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL)`；
   - `plugin_kv_storage(plugin_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (plugin_id, key))`；
   - 宿主初始化时自动检测旧表 `plugin_settings`，将其中的启用状态与配置键值无损迁移至新表。
2. **平滑版本升级**：当 `manifest.version !== installed_version` 时，宿主在激活插件前调用可选的 `migrate?(fromVersion, toVersion, storage)`，成功后原子更新 `installed_version`。
3. **运行期停用级联**：当底层插件 A 被上层插件 B 硬依赖（`optional: false`）时，若用户主动关闭 A，宿主允许关闭并将 B 切换为 `waiting_dependency` 挂起态（立即回滚 B 的运行期 `EffectScope` 释放硬件租约）；当 A 重新启用时自动唤醒恢复 B。

### 3.4 UI 桥接与可变形首屏舞台契约（`apps/nsh/ui/plugins/ui-contracts.ts`）

- **`FaceStagePosture`**：支持 `full`、`floating_top`（`scale?: 0.22..0.48`, `chrome?: "pill" | "frameless"`）、`docked_corner`、`split_left`、`minimized_pill` 五种空间姿态。
- **`StageDrawerDetent`**：支持 `closed`、`peek`、`medium`、`large` 四档位底部弹出抽屉。
- **宿主安全不变量**：右上角系统控制柄始终置顶不可遮挡；任意插件 TSX 视图抛错由独立 `<ErrorBoundary>` 捕获并将首屏姿态自动复位至 `{ kind: "full" }`。

### 3.5 具身硬件与双环 AI 管线契约

- **表情与视线栈（`context.face`）**：动态注册的 `FaceExpressionRecipe` 自动带 `plugin:<id>:<localId>` 命名空间；优先级栈按 `P0 SystemCritical > P1 DockTransient > P2 PluginForeground > P3 Conversational > P4 PluginBackground > P5 DefaultIdle` 求值，且眼球视线 `gaze` 与口型正交合成。
- **底座伺服租约（`context.body`）**：`acquireServo` 支持无级向量闭环控制，遇到用户急停、手动摇杆或语音直接控制时立即抢占并回调 `onPreempted`。
- **手机本机摄像头（`context.vision` + Rust `DeviceCameraHost`）**：iOS `AVCaptureSession` / Android `Camera2` 原生缩放抽帧（`Uint8Array` JPEG 直传）与 `<DeviceCameraPreview />` 预览组件，内置背压丢帧与退后台原子断流。
- **双环 AI 管线（`context.ai`）**：
  - `useContextSlice` / `usePersonaOverlay`：绑定 `EffectScope` 的声明式感知与人设槽位；
  - `useTurnAssembler`：带 `AbortSignal` 硬超时预算（语音环 `80ms`、任务环 `1500ms`）的洋葱组装管线，支持按需塞入多模态抓拍帧；
  - `interceptUserTurn` / `interceptToolCall`：确定性 `bail` 短路守卫，工具守卫抛错时严格遵循 Fail-Closed 拒绝执行并保留完整 `pluginId + stage + code`；
  - `speak`：主动语音播报，返回的 Promise 在本句音频实际播放结束或被打断时完成。

---

## 4. 分阶段实施里程碑

1. **Milestone 1：插件微内核 v2（Manifest + DAG 服务图 + `EffectScope` + 双环 AI 基础守卫）与 Codex 双面迁移**
   - 落地 `EffectScope`、SemVer 解析器、`PluginServiceRegistry`、`DualLoopAiBus` 与 `PluginHost` v2 存储迁移；
   - 建立 `PluginBridge` 与动态 `PluginsSpaceView.tsx`（多分类筛选、依赖状态提示、`<ErrorBoundary>` 动态挂载 `SettingsView`）；
   - 将 `codex` 完整迁移至 `apps/nsh/plugins/codex/` 双面结构，移除 `PluginsSpaceView.tsx` 与 `application.ts` 中的 Codex 硬编码。
2. **Milestone 2：表情动态注册栈、躯体伺服抢占与双环语音/任务深度接线**
   - 升级 `RobotFaceController` 与 `RobotFace.tsx` 支持动态配方注册及 P0–P5 正交视线栈；
   - 升级 `BodyRuntime` 支持 `acquireServo` 抢占仲裁；
   - 将 `DualLoopAiBus` 完整接入 `VoiceRuntime`（`80ms` 组装预算、语音轮次短路守卫、播放完成回执 `speak`）与 `PiTaskRunner`（`1500ms` 多模态上下文组装）。
3. **Milestone 3：横屏首屏“可变形舞台（Morphable Stage）”合成器**
   - 重构 `App.tsx` 首屏舞台层支持 `FaceStagePosture` 弹簧连续变形、`StageCapsule`、四档位 `StageDrawer`、`StageCanvas` 与置顶宿主安全控制柄。
4. **Milestone 4：手机本机前/后置摄像头原生模块（`DeviceCameraHost`）与跨插件生态闭环**
   - 实现 iOS / Android `DeviceCameraHost` 与 `VisionBroker` 多消费者复用；
   - 落地跨插件示范组合（视觉感知服务插件 + 上层伴随/舞台插件）与 `.nshpkg` 签名市场包加载入口。
