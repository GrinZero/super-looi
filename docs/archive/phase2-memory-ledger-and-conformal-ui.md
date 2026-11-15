# Phase 2: 可追溯证据记忆账本与“脸与页面共形”内页架构与实现文档

## 1. 概述与核心哲学

在具身陪伴与桌面智能体场景中，大语言模型与多模态 VLM 最容易犯的两大致命错误是：
1. **幻觉确凿性 (Hallucinated Certainty)**：用确定无疑的口吻回答早已过时或推断出的信息（例如将 5 小时前看到的钥匙直接说成“就在键盘旁边”）。
2. **黑盒记忆污染与失控 (Black-box Memory Pollution)**：用户无法追溯 AI 记忆的事实依据，删除某条记忆后后台异步任务依然将旧推理写回，造成“僵尸记忆”。

Super-LOOI Phase 2 建立了严格遵循工业级规范的**可追溯证据记忆账本**与**具身共形内页系统**：
- **事实与证据分离**：所有记忆断言 (`MemoryClaim`) 必须绑定独立的证据根 (`derivation_roots`) 与抓拍/拾音原始事件 (`evidence_ids`)。
- **双时间模型 (Dual-Time Model)**：严格区分事实物理发生时间 (`observed_at`) 与系统断言时间 (`asserted_at`)。
- **诚实认识论语态 (Epistemic Honesty)**：主动微调视角仍被遮挡时坦率承认，查询最后位置时明确附带观测时刻与时效性限定语。
- **代际墓碑与迟到写回阻断 (Late Writeback Guard)**：用户一键遗忘或隐私暂停时，异步排队推理任务在写回瞬间被强行拒收，物理杜绝污染。
- **脸与页面共形 (Conformal UI Space)**：陪伴大脸的双眼平滑坍缩为时间轴导航节点，右上角迷你小 LOOI 的视线实时转头盯视用户当前选中的回忆卡片。

---

## 2. 数据库 Schema 与存储设计 (`apps/hub/src/memory/schema.sql`)

PostgreSQL + `pgvector` 数据模式由 6 张核心表构成：

```
+------------------+         +-------------------+
|  privacy_epochs  |         |  evidence_events  |
+------------------+         +-------------------+
         |                             |
         v                             v
+------------------+         +-------------------+
| deletion_tombstones| <----+ |     episodes      |
+------------------+         +-------------------+
         |                             |
         v                             v
+------------------+         +-------------------+
|   memory_claims  | <-----+ |   context_packs   |
+------------------+         +-------------------+
```

### 核心表结构定义
1. **`privacy_epochs`**: 记录用户隐私暂停纪元与代际演进，`capture_epoch` 单调递增。
2. **`evidence_events`**: 原始多模态观测帧（摄像头抓拍、音频片段、超声测距、触碰等）。
   - 幂等唯一键：`UNIQUE (source_id, boot_epoch, sequence)`。
   - 内容哈希：`content_hash` (SHA-256)，同一序列号但哈希不匹配时判定为通道冲突 (`hash_conflict`) 并拒收。
3. **`episodes`**: 上下文片段，聚合独立视觉与音频派生根 (`derivation_roots`)，并记录因自运动产生的传感器盲区标记 (`gap_markers`)。
4. **`memory_claims`**: 记忆断言账本。
   - 支持三态生命周期：`inferred` (推测) -> `observed` (观测) -> `confirmed` (主人确认) / `retracted` (已撤销)。
   - 包含事实物理区间 `valid_from` ~ `valid_to` 与时效性状态 (`retained` vs `source_expired`)。
   - 1536 维语义向量索引：`embedding vector(1536)` 支持余弦相似度检索。
5. **`context_packs`**: 装配给下游 LLM 消费的任务上下文清单，显式标明 `instruction_trust: "untrusted_context_data"`。
6. **`deletion_tombstones`**: 物理代际墓碑，记录作用域、被删除证据源 ID、级联派生根与撤回的断言集合。

---

## 3. 记忆账本核心服务 (`MemoryLedgerService`)

位于 `apps/hub/src/memory/ledger.ts`，提供了完整的记忆摄取、流转与治理逻辑：

### 3.1 摄取幂等与内容哈希冲突防护
```typescript
public async ingestEvent(event: EventEnvelope): Promise<{ deduplicated: boolean }> {
  const dedupKey = `${event.source_id}:${event.boot_epoch}:${event.sequence}`;
  const existing = this.eventsByKey.get(dedupKey);

  if (existing) {
    if (existing.content_hash !== event.content_hash) {
      throw new Error(`Integrity hash conflict on event sequence ${event.sequence}`);
    }
    return { deduplicated: true }; // 相同内容安全幂等
  }
  // 正常写入...
}
```

### 3.2 诚实认识论查询 (`queryObjectLastSeen`)
当用户询问“我的眼镜在哪里？”时，系统绝不给出模棱两可或凭空捏造的答复，而是严格提取最后观测证据的时间与视点，并附带时效性诚实修饰：
```typescript
// 生成样例:
// "我最后在 19:42 看到它在茶几左侧（依据当时抓拍记录，不排除之后已被移动）"
```

### 3.3 迟到写回守卫 (`commitDerivedWrite` & Late Writeback Guard)
耗时较长的异步 VLM 或 ASR 分析任务启动时，持有当时的 `EpochBinding (capture_epoch, deletion_generation)`。如果在执行期间用户触发了隐私暂停（`capture_epoch` 自增）或删除了原始照片/撤回了该事实（`deletion_generation` 自增），写回时将被阻断并抛出 `LateWritebackRejectedError`：
```typescript
if (currentGen !== jobEpochBinding.deletion_generation) {
  throw new LateWritebackRejectedError(
    `Writeback rejected: deletion generation advanced from ${jobEpochBinding.deletion_generation} to ${currentGen}`
  );
}
```

---

## 4. 上下文触发总线与主动微观察协调器

### 4.1 `ContextTriggerBus` & `NoveltyGate` (`apps/hub/src/memory/context-engine.ts`)
- **后台触发频控**：后台自动检测触发器强制执行 `minBackgroundIntervalMs`（默认 3000ms）静默窗口，防止过多抓拍打扰设备。
- **用户显式优先级穿透**：用户显式指令（`explicit_remember` 或 `priority: "high"`）立即穿透，不计入频控阻断。
- **400ms 合并窗口**：短时间内的同类型触发自动合并，保留高优先级。
- **Novelty 门控**：过滤相同 `viewId` 且指纹相同的静止无变化帧；身体旋转俯仰导致 `viewId` 改变或局部区域 ROI 变化时立刻放行。

### 4.2 `BoundedActiveLookCoordinator` (`apps/hub/src/vision/active-look.ts`)
当用户询问某物体位置但在当前视野内不确定时，LOOI 可发起微俯仰/微转向主动观察：
- **脱座硬件保护**：若 `getIsDocked() === false`，立即放弃动作，返回诚实提示：`"机器人未在底座上，无法执行主动转向观察。"`。
- **严格预算约束**：
  - 最大尝试次数：硬上限 `maxAttempts ≤ 2`（拒绝无休止转头晃眼）。
  - 单次脉冲耗时：硬上限 `pulseDurationMs ≤ 250ms`。
  - 运动总耗时：硬上限 `totalMotionMs ≤ 3000ms`。
  - 防抖稳定等待：脉冲后严格休眠等待 `settling_ms ≥ 200ms` 后再取帧。
- **遮挡诚实放弃 (Occlusion Honest Fallback)**：
  两次微调视野后若目标依然被遮挡，绝不假装找到，而是返回：
  `"微调视角后这边还是被挡住了，可以帮我把它移开一下吗？"`。

---

## 5. 移动端“脸与页面共形”与回忆册内页 (`apps/mobile/src/ui/memories-space.ts`)

为了打破传统机器人“切出脸模就变成冰冷管理表格”的割裂感，Super-LOOI 设计了“**脸与页面共形**”交互规范：

```
+--------------------------------------------------------------+
| [O   O]  (Fullscreen Face)                                   |
|    |                                                         |
|    v  (openMemoriesTimeline)                                 |
|                                                              |
| (*) Cyan Anchor Node 1                      (*) Cyan Node 2  |
|  |                                               |           |
|  +================= Timeline Track ==============+           |
|                                                              |
|  +--------------------+   +-------------------------------+  |
|  | Mini LOOI Avatar   |   | Selected Memory Card          |  |
|  | Gaze: (0.65, 0.35) |---> [When] 6月24日 19:42          |  |
|  | Expression: curious|   | [Where] 电视柜右侧            |  |
|  +--------------------+   | [How] 摄像头抓拍分析          |  |
|                           | [Trust] 由摄像头抓拍观测      |  |
|                           | [Actions] 不是这里 | 拿走了   |  |
|                           +-------------------------------+  |
+--------------------------------------------------------------+
```

### 5.1 共形状态机 (`ConformalMorphState`)
- `face_fullscreen`: 默认陪伴全屏双眼表情。
- `eyes_closing_to_nodes`: 双眼光晕平滑缩小并位移，收缩至顶部时间轴的两侧锚点（保留 `#28D5FF` 荧光青光晕）。
- `memories_timeline_open`: 时间轴展开，左侧呈现迷你 LOOI 伴随头像，右侧呈现生活片段回忆卡片。
- `nodes_converging_to_eyes`: 离开内页时，锚点迅速聚拢、放大复原为全屏机器人灵动大眼。

### 5.2 伴随微头像视线联动 (`MiniRobotAvatarState`)
- 当回忆册处于总览状态时，迷你头像视线轻微环视 (`{ x: 0.1, y: 0.1 }`, expression: `"curious"`)。
- 当用户在时间轴上点击某张回忆卡片时，迷你头像立刻转头，视线聚焦卡片位置 (`{ x: 0.65, y: 0.35 }`)，让用户感知到“LOOI 也正在和我一起回忆这张照片”。

### 5.3 4 问生活片段卡片格式 (`FormattedMemoryCard`)
每张卡片以人类直觉回答 4 个核心问题：
1. **When (何时)**：`"6月24日 19:42"`
2. **Where (何地)**：`"电视柜右侧"`
3. **How (何源)**：`"摄像头抓拍分析"` / `"主人对话记录"` / `"环境拾音分析"`
4. **Trust Level (凭据)**：
   - `confirmed`: 绿色标签，`"主人已确认准确无误"`
   - `observed`: 青色标签，`"由摄像头抓拍观测"`
   - `inferred`: 琥珀色标签，`"依据近期规律推测"`
- **隐私过期徽章**：若原始图片已按隐私策略过期销毁，卡片展示灰色保护标签：`"原始证据已按隐私策略安全删除（仅保留事实摘要）"`，且不暴露失效 URI。

### 5.4 3 个即时用户纠错动作
- **“不是这里” (`location_correction`)**：触发事实修正，旧断言被废弃，新事实以 `confirmed` 写入，并指明由主人纠错产生。
- **“已经拿走了” (`item_removed`)**：将事实标记为失效，结束 `valid_to` 有效期。
- **“忘掉这条” (`forget_memory`)**：生成 `DeletionTombstone`，级联物理撤销断言与上下文包，禁止后续召回。

---

## 6. REST API 接口清单 (`apps/hub/src/app.ts`)

| 路径 | 方法 | 说明 |
| :--- | :--- | :--- |
| `/api/memory/events` | `POST` | 摄取原始观测事件（严格校验幂等唯一键与 SHA-256 冲突） |
| `/api/memory/claims` | `POST` | 写入或更新记忆断言 |
| `/api/memory/claims` | `GET` | 按 `predicate`, `status`, `subjectId` 过滤检索断言列表 |
| `/api/memory/last-seen/:objectName` | `GET` | 查询物体最后出现位置与诚实认识论修饰文本 |
| `/api/memory/claims/:claimId/correct` | `POST` | 用户端纠错接口（产生新修订号并置为 `confirmed`） |
| `/api/memory/claims/:claimId/reject` | `POST` | 用户端否认推测并注册抑制键，防止模型死灰复燃 |
| `/api/memory/evidence/:evidenceId/delete`| `POST` | 删除证据源，触发级联墓碑生成与上下文包失效 |

---

## 7. 测试与验证结果

工作区所有包类型检查与测试 100% 通过：
```bash
pnpm typecheck   # 4 packages: 0 errors
pnpm test        # 55 passing, 0 failing across contracts, driver, mobile, hub
pnpm build       # Clean compilation across workspace
```

- **`packages/contracts`**: 5 项测试，覆盖回执校验、自事件窗口与断言构造。
- **`packages/looi-driver`**: 11 项测试，覆盖 3 步握手重试、脱座刹车、租约互斥与微动作脉冲调度。
- **`apps/mobile`**: 14 项测试，覆盖全屏脸模动力学、波形共振、紧急急停、共形展开、视线注视与纠错动作。
- **`apps/hub`**: 25 项测试，覆盖双轨语音、三层视觉评测、记忆摄取幂等、诚实语态、迟到写回阻断、主动微观察与遮挡回退。
