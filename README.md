# Super-LOOI

以手机为交互入口、以 LOOI 为身体的个人 Agent。唯一应用是 `apps/nsh`：NSH 0.4.0 原生宿主、Rust 系统能力与 TSX 界面，QuickJS 内运行 Pi Agent Loop，手机直接连接模型和实时语音服务。

## 仓库结构

- `apps/nsh`：iOS / Android 应用、原生音频、安全凭据、米家登录和界面。
- `packages/looi-runtime`：共享 Agent、任务、领域逻辑与回归测试。
- `packages/nsh-node-compat`：QuickJS 的 Node API 适配与 Rust 文件、SQLite、Shell 能力。
- `packages/contracts`：跨模块契约。
- `packages/looi-driver`：LOOI 协议与身体状态机。
- `packages/home-assistant`：Home Assistant / MIoT 客户端。

## 开发

使用 pnpm 9，Node.js 24.9+。原生工具链和固定 NSH CLI 配置见 [应用说明](apps/nsh/README.md)。环境变量放在根目录 `.env`。

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm ios
```

`pnpm mobile` 同样启动 NSH iOS 应用。模型与豆包语音 API Key 在应用的连接设置中保存到系统安全存储。

可选的本地 Home Assistant 使用 `docker compose -f docker-compose.home.yml up -d`。

## 旧端归档

Expo / React Native 应用和 Hub 服务已退出工作区。删除前源码及当时未提交的旧端修改保存在 Git 分支 `archive/legacy-hub-and-expo`（`55f77ef`）。历史设计和验收记录位于 `docs/`；当前剩余功能见 [todo.md](todo.md)。
