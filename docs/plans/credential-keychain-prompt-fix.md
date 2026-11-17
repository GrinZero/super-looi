# UI 测试触发钥匙串授权弹窗修复

- [x] Step 1：定位截图中的 `app_ui-*` 测试程序与真实钥匙串调用路径，停止遗留测试进程。
- [x] Step 2：在 CredentialVault 内隔离跨平台模拟凭据，保留真实平台存储行为与调用接口。
  - [x] 使用 NSH 当前 VM 的 locals 管理内存槽位，覆盖同 VM 重开与不同 VM 隔离。
  - [x] 增加针对本次回归的测试，更新凭据存储说明。
- [x] Step 3：运行凭据回归、横屏 UI 原场景和原生编译检查，独立审查后隔离提交。

## 原因与设计

`5f204a4` 启用桌面系统凭据库后，CredentialVault 只按编译平台选后端。macOS 上模拟移动 UI 的 Headless 测试因而访问 `com.superlooi.app.credentials.v1`，临时数据目录没有隔离钥匙串槽位。截图中的 `app_ui-*` 是重建的测试可执行文件，系统授权对话框阻塞了测试。

保留 get/set/remove，由 CredentialVault 比较宿主声明的 `System.os` 与编译平台；不一致说明正在模拟另一平台，凭据归该 VM 的 locals 所有。用现有 NSH locals 和标准库内存表即可，不需要新增依赖、环境变量或修改每个 UI 调用方。实际平台仍使用现有系统后端，系统错误继续原样携带阶段与错误码。

## 验证记录

- 修复前：新增路由测试实际返回 `macos-keychain`，预期 `emulated-memory`，断言失败；没有执行钥匙串读写。
- 修复后：`pnpm --filter @super-looi/nsh exec cargo test --locked --lib credentials::tests -- --nocapture`：2 项通过，手动系统凭据库回归保持 ignored。覆盖移动平台模拟、缺失、Unicode、同 VM 重开、覆盖、跨 VM 隔离、幂等删除与同 OS 原生后端选择。
- 原调用链：`pnpm --filter @super-looi/nsh exec cargo test --locked --test app_ui werewolf_stage_resilience_reentry_and_controls_work_in_landscape -- --nocapture`：1 项通过，17.74 秒，无钥匙串授权阻塞。
- `pnpm --filter @super-looi/nsh typecheck`、`pnpm --filter @super-looi/nsh exec cargo clippy --all-targets --locked` 通过；现有音频、蓝牙、摄像头等模块警告未改动。
- 独立只读审查确认 NSH 在执行前设置 System.os，locals 归当前 VM，凭据结构保持相机 Host 的 Send/Sync；无可操作发现。
