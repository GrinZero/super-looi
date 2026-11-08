# 72 桌宠表情声明式目录与 Canvas 原语引擎接入计划

日期：2026-11-09 · 关联视觉规范：[super-looi-72-expressions-design.md](../super-looi-72-expressions-design.md)

## 1. 目标与范围边界

将已定稿的 **72 个桌宠表情（`#01–#72`）** 以**声明式配方表 + 正交 `Canvas` 几何原语**接入运行时与 NSH 前台渲染层，为后续状态机编排、语音情绪联动、底座体感反馈和闲置小剧场提供底层表达能力。本阶段聚焦类型契约、行为特征元数据、主题语义色 Token、72 态声明式配方及原语渲染器接入，不改动现有前台业务触发逻辑（现有 `neutral / listening / thinking / speaking / curious / sleeping / alarmed` 7 态视觉与调用行为保持 1:1 兼容）。

## 2. 模块边界与方案取舍（`codebase-design`）

### 2.1 候选架构对比

| 维度 | 方案 A：单一枚举表 + UI 侧声明式配方 + 正交原语渲染器（采用） | 方案 B：按表情编写 72 个命令式绘制函数 / 类继承 |
| :--- | :--- | :--- |
| **职责与包体积边界** | `packages/looi-runtime` 仅持有 72 个 `FaceExpression` 标识与眨眼/静息行为特征；`apps/nsh/ui/face-recipes.ts` 持有纯数据配方；`RobotFace.tsx` 持有通用原语渲染器。避免同一份视觉几何数据跨 `generated/looi-runtime.js` 与 NSH UI 双 bundle 重复打包。 | 每个表情手写 `draw(cx)` 回调，梯度、光晕、视线位移与眨眼缩放逻辑重复 72 次，难以静态校验坐标合法性与主题 Token 约束。 |
| **可维护性与可测试性** | `Record<FaceExpression, FaceExpressionRecipe>` 由 TypeScript 穷尽性检查保证 72 态零遗漏；纯数据配方与纯函数 `drawRobotFace` 可在单测中逐一遍历全部 72 态校验 `save/restore` 栈平衡、坐标非 `NaN` 与非硬编码色值。 | 新增或微调单个表情需修改命令式状态机代码，容易引入 `CGContext` / Android `Canvas` 状态栈泄漏。 |

### 2.2 模块职责划分

1. **`packages/looi-runtime/src/shell/face-expressions.ts`**：
   - 定义有序常量元组 `FACE_EXPRESSION_IDS`（72 项）、联合类型 `FaceExpression`、类型守卫 `isFaceExpression` 及动力学特征查询 `getFaceExpressionBehavior(expression)`（区分 `closedRest` 闭眼静息态、`allowsBlink` 可随机眨眼态、`allowsAudioResonance` 声波共振许可态）。
   - `PresenceStateManager` 与 `RobotFaceController` 复用该行为特征：例如切换至 `happy_squint`、`love_eyes`、`dizzy_spiral` 等非圆眼态时自动跳过随机眨眼定时器干扰；切换至 `sleeping`、`deep_snore`、`privacy_shield` 时统一锁定闭眼静息与波形归零。
2. **`apps/nsh/theme.json`**：
   - 补齐低饱和 OLED 表情语义色 Token（`face-ivory-*`、`face-amber-*`、`face-sage-*`、`face-rose-*`、`face-mist-*`），兼顾 `light`（抗反光深炭底）与 `dark`（纯黑省电底），确保 TSX 渲染代码零硬编码 Hex/RGBA。
3. **`apps/nsh/ui/face-recipes.ts`**：
   - 定义五通道声明式结构 `FaceExpressionRecipe`（眼型基底、眼睑裁剪遮罩、双目独立姿态、眉嘴描边、平面微符号与语义色）及完整 72 项 `FACE_EXPRESSION_RECIPES`。
4. **`apps/nsh/ui/RobotFace.tsx`**：
   - 实现 `drawRobotFace` 正交原语绘制引擎与 `<RobotFace />` NSH 组件，严格遵循无黑瞳孔挖空、无白翳反光准则，保留现有 7 态 1:1 几何参数。

## 3. 实施与验证步骤

1. **Step 1**：在 `packages/looi-runtime` 建立 `face-expressions.ts`，扩展 `FaceExpression` 与 `RobotFaceController` 眨眼/静息守卫，更新 `apps/nsh/scripts/build-runtime.ts` 导出声明并补齐运行时单测。
2. **Step 2**：在 `apps/nsh/theme.json` 与 `apps/nsh/DESIGN.md` 增补表情语义色 Token，实现 `apps/nsh/ui/face-recipes.ts`（72 态配方）与 `apps/nsh/ui/RobotFace.tsx`（五通道 `Canvas` 原语渲染器）。
3. **Step 3**：新增 72 表情配方完整性与 `Canvas` 原语绘制回归测试（遍历 72 态验证开闭眼、`save/restore` 平衡、Token 解析与 NSH Headless 挂载），通过全套构建与类型检查。
4. **Step 4**：运行独立子 agent 代码审查，修复审查发现后归档提交。
