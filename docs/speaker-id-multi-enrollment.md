# 声纹识别多样本注册方案

## 背景

当前声纹识别只使用单次录入的一个 embedding 作为 owner 模板。用户换一种说话方式（语速、音量、情绪、距离）后，cosine similarity 显著下降，导致频繁误拒。

## 目标

通过多样本注册，让声纹模板覆盖用户日常说话的声音变化范围，提升验证通过率，同时保持对非 owner 的拒绝能力。

## 方案设计

### 1. 注册流程

#### 引导式多样本采集

注册时引导用户录制 3-5 段不同风格的语音：

| 序号 | 提示 | 目的 |
|------|------|------|
| 1 | "请用正常音量说一句话" | 基线 |
| 2 | "请稍微轻声说一句话" | 低能量覆盖 |
| 3 | "请稍微快一点说一句话" | 语速变化覆盖 |
| 4 | "请随意说几句话" | 自然状态 |
| 5 | (可选) "请离远一点说一句话" | 远场覆盖 |

每段最少 2 秒有效语音（静音段去除后）。

#### 数据结构变更

```typescript
interface StoredSpeakerEmbedding {
  version: 2; // bump version
  speakerName: string;
  // 保留多个模板 embedding
  embeddings: number[][];
  // 聚合后的中心 embedding（用于快速验证）
  centroid: number[];
  createdAt: string;
  updatedAt: string;
}
```

兼容 version 1：读取时如果 version === 1，将单个 embedding 包装为 `embeddings: [embedding]` 并计算 centroid。

### 2. 验证策略

采用 **centroid + max-similarity** 双重判定：

```
score = max(
  cosineSimilarity(input, centroid),
  max(cosineSimilarity(input, template_i) for each template_i)
)

verified = score >= threshold
```

- centroid 匹配：覆盖「平均状态」的快速通过
- max-similarity 匹配：任何一个注册样本与当前输入接近即通过，覆盖边缘状态

阈值可以比单样本时适度提高（比如从 0.35 提到 0.40），因为多模板天然提供了更好的覆盖。

### 3. 渐进式自适应更新（Phase 2）

验证通过后，如果 score 高于一个 **强确认阈值**（如 0.55），将该次的 embedding 加权融合到 centroid：

```
centroid_new = normalize(0.95 * centroid_old + 0.05 * new_embedding)
```

同时可选择性替换 embeddings 中与新 embedding 最相似的那个模板（避免模板数量无限增长）。

模板数量上限：8 个。超过后替换最老或最冗余的模板。

### 4. 存储与迁移

- 仍使用 MMKV 存储，key 不变
- version 字段升到 2
- 读取 version 1 数据时自动迁移为 version 2 格式
- centroid 在每次模板变更后重新计算

### 5. 注册 UI 变更

- 注册页面改为分步引导，每步一个录音
- 每段录音完成后显示质量反馈（时长是否足够、信噪比是否 OK）
- 最少完成 3 段即可注册，4-5 段为推荐
- 支持「追加录入」：已注册用户可以在设置中补录更多样本

## 实现步骤

1. [ ] 修改 `StoredSpeakerEmbedding` 数据结构（version 2）
2. [ ] 实现 version 1 → 2 自动迁移
3. [ ] `SpeakerIdService.enroll` 支持接收多段音频
4. [ ] 实现 centroid 计算与 max-similarity 验证逻辑
5. [ ] 修改 `verifySpeaker` 为本地多模板比对（不依赖 sherpa 内置 verify）
6. [ ] 注册 UI 改为分步引导
7. [ ] 追加录入入口
8. [ ] (Phase 2) 渐进式自适应更新

## 风险与取舍

- **安全性**：多模板 + max-similarity 会略微增加 false accept rate，但对于 owner-only 设备场景可接受
- **存储**：8 个 512 维 embedding ≈ 32KB，MMKV 可以轻松承载
- **计算**：验证时做 8 次 cosine similarity 计算，耗时可忽略

## 短期过渡

在多样本方案落地前，先将 `verificationThreshold` 从 0.45 降到 0.35，缓解误拒问题。
