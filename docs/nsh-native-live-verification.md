# NSH 原生模型验证（2026-11-07）

固定版本：NSH 0.4.0 / e626a8d、Pi 四包 1.5.0，使用当前 lockfile。

## 本轮实跑结果

| 宿主或路径 | 结果 | 范围 |
| --- | --- | --- |
| 独立 Rust / QuickJS | PASS | Rust 5 项；十套 JS 验证、SIGKILL durable 恢复与 runner deadline |
| NSH hardened engine | PASS | 真实 native class、应用初始化及交互测试 |
| iOS 26.3 ARM64 模拟器 | PASS | 原有九套兼容探针、Keychain CRUD |
| Android API 34 ARM64 模拟器 | PASS | 原有九套兼容探针、Keystore CRUD |
| iOS MobileRuntime 真网 | PASS | 原生 fetch → 实际 PiAgentExecutor → 模型回复、SQLite 任务完成、关闭 |
| Android MobileRuntime 真网 | PASS | 同上 |
| 双端实际 coding SDK 真网 | PASS | 原生 fetch → createAgentSession → 模型 write/read 同一文件 → 精确 OK 回复 → JSONL 工具回执/最终回复恢复 |
| 显式移动 SDK profile | PASS | 实际 createAgentSession、七默认工具、JSONL 重开；模型是 fixture |
| 桌面 root SDK 透明构建 | FAIL | 36 个构建错误；需 Node-only 网络/VM/worker 等能力，不属于移动 profile 通过范围 |

手机真网测试使用 `.env` 的模型配置，但不写入产品 Keychain/Keystore 槽位。测试入口单独生成，调用生产 `openRuntime`，使用内存 Vault。产品 App 的依赖图不包含测试入口。测试退出清理源文件、测试 bytecode/source maps；超时杀进程组并终止设备开发宿主。测试日志仅保留脱敏失败信息，不输出模型凭据或响应内容。

命令：

```sh
pnpm --filter @super-looi/nsh test:live:ios
pnpm --filter @super-looi/nsh test:live:android
pnpm --filter @super-looi/nsh test:live:sdk:ios
pnpm --filter @super-looi/nsh test:live:sdk:android
pnpm --filter @super-looi/nsh-node-compat test
```

实际 coding SDK 真网测试将写入与独立读取分为两轮，严格核对 tool call ID、目标路径、回执顺序、读取内容、最终回复和重开后的 JSONL。Android 初轮模型未执行读取时真实失败；拆成明确两轮后，双端最终测试通过。独立 reviewer 另验证“读取其他文件”和“空最终回复”均被拒绝。

## 本轮修复

- 原生安全存储写入模型配置失败时，恢复旧配置的执行器。此前执行器已关闭但旧配置仍显示可用。新增 `verify-mobile-runtime.ts` 覆盖拒绝、旧配置保留、执行器可入场、保存重试和关闭。
- iOS simulator Release 使用产品包身份的 Keychain entitlement；开发宿主继续使用其原身份。真机签名另走 provisioning 流程。

## 未完成门禁

本轮手机真网与产品 Release 证据分开记录；扩展、OAuth、图片和完整流式取消组合仍有单独验收边界。新配置失败及持久会话回归已在独立 QuickJS、NSH engine 与双端十套原生探针通过。

多轮会话已接线：每轮独立任务，共享 transcript；conversationId 随模型配置保存到安全凭据，重开后恢复。配置切换旋转会话，同会话并发/unknown 与跨 workspace 续跑受阻；成功任务缓存读取不被活动兄弟任务阻断。Node 11 项及 QuickJS App reopen/config isolation 回归通过。

当前业务仍缺 unknown 任务明细与核验入口、家居和语音接线、原生媒体/BLE、旧数据迁入。两端阶段 Release（`73a667c` 对应快照）已通过离线记忆写入/强制退出/回忆/删除及安全配置重开；最终 Release（`40a592c`）重打包后再次验证无开发服务器冷启动与配置保留。Android 产品界面还通过真实模型两轮对话。网络接口没有关闭，因此“离线记忆”指本机操作不依赖服务，不声称物理断网验收。最终产品代码为 `40a592c`，双端字节码 SHA256 一致，见 `docs/artifacts/nsh-node-compat/release-audit.json`。商店签名、Android API 36/AAB、32 位 ABI 执行与真机外设验收没有被模拟器结果替代。

删除 Hub / Expo 的业务替代门禁未满足，保留旧实现。


## 模拟器配置副作用与恢复

Android 产品模拟器验收前已有模型配置，验收脚本未先备份即覆盖为无效测试值，原配置来源和原值无法可靠确认。已向用户说明，并按用户明确授权用仓库 `.env` 配置恢复；重启读回与真实两轮对话通过。当前可用配置是 `.env` 配置，不称为恢复未知原值。iOS 验收前未配置模型，目前保留明确无效的测试配置。后续配置验收须隔离测试 appId 或可靠备份并恢复原值。
