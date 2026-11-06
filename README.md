# Super-LOOI (Presence v0.2)

> 以手机为感知与交互入口、以 LOOI 为身体、以 DeepSeek Harness 为任务执行内核的个人具身 Agent。

## 架构概览

本项目采用净室重构的 `pnpm` Monorepo 架构，分层清晰，职责严格隔离：

```
super-looi/
├── packages/
│   ├── contracts/    # (@super-looi/contracts) 零依赖 TypeScript 契约与协议规范
│   └── looi-driver/  # (@super-looi/looi-driver) LOOI BLE 驱动与 BodySupervisor 状态机
├── apps/
│   ├── hub/          # (@super-looi/hub) Fastify 服务端、双轨语音、证据账本与生产力调度
│   └── mobile/       # (@super-looi/mobile) Expo React Native 跨端横屏驻留本体
├── docs/
│   ├── design-v2/    # V2 核心设计规范 (PRD、技术架构、48条验收场景、协议草案)
│   └── golden-reference/ # 验证通过的黄金资产 (字节跳动 OpenSpeech 全双工二进制实现等)
├── docker-compose.yml# 记忆账本 PostgreSQL + pgvector 服务定义
└── progress.md       # 全局演进阶段看板与任务检查清单
```

## 核心设计准则

1. **上下文连续**: 记忆三态流转（Candidate -> Inferred -> Confirmed），区分事实、观察与推断；单次行为必须具备可追溯的证据来源（Evidence Identity）。
2. **行动可核验**: 物理世界操作以真实设备状态回读为准（`ActionReceipt`）；智能家居必须核验设备回报，生产力任务必须核验实际产物与进程 exit code。
3. **身体安全第一**: 下位机动作由本地 `BodySupervisor` 强管控。单动作互斥租约（`BodyActionLease`）、有界超时自动停车、脱座 (`06`) 瞬时硬件急停与租约吊销。
4. **相处可掌控**: 支持一键“隐私暂停”（`PrivacyEpoch` 纪元推进并清空本地短时缓冲）；支持用户随时“纠错”与代际“墓碑删除”（Tombstone），彻底隔绝已删除记忆的迟到写回与复活。

## 快速开始

### 依赖安装与构建

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

### 启动本地记忆与任务账本数据库

```bash
docker compose up -d
```
