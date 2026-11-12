# App Linux 中的 Codex 登录修复

验证平台：iPhone 16e／iOS 26.3 系统模拟器，NshDev 横屏开发包。CLI 为官方 `0.167.2`、`aarch64-unknown-linux-musl`；iSH 固定为 `0fd17a135e78b7a0cf08a4f5831217bbb76ed22f`。

## 登录进程空闲强退与清理死锁

浏览器授权需要 CLI 在本地端口 1455 等待回调。固定版 iSH 在 `poll_wait` 中把空闲 60 秒、没有子进程和 TTY 的进程视为可退出进程。这会误杀正常等待授权的 CLI。

原生线程采样确认：`poll_wait → do_exit_group → fdtable_release → fd_close → poll_cleanup_fd` 在已经持有 poll 锁时再次请求同一把锁，导致退出清理无法完成。App 最终收到 `ERR_SHELL_CLEANUP`。

`78d6522` 通过现有 `tgroup.fs_context` 区分 App 所有的进程，让其超时和取消由 `ShellRequest` 管理。NshDev 实测等待 70 秒仍存活、主动取消正常回收、显式 4 秒超时返回 `timed_out`，结束后端口关闭。

## TLS 失败与半字向量通道错误

浏览器完成确认后，CLI 回调页返回 `token_exchange_failed`，stderr 为向 `/oauth/token` 发送请求失败。使用相同版本的 reqwest／native-tls 打印底层错误链后，得到 `0A000119 decryption failed or bad record mac` 与 `0A000139 record layer failure`，其中 `X509VerifyResult=ok`。

指定 `SSL_CERT_FILE` 会触发 Codex 的另一条路径：先初始化 rustls provider，再读取证书文件。该路径曾在 `ECDSA_NISTP521_SHA512` 检查处 panic。[官方 CA 配置实现](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/http-client/src/custom_ca.rs)、[provider 初始化实现](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/utils/rustls-provider/src/lib.rs)。

无网络探针证明，provider 原始算法表包含 P521，但 `supported_schemes()` 的向量复制把前 8 项变为原表第 1 项、零、第 3 项、零等错误数据；标量复制的后 5 项正确。反汇编将首次分歧定位到 `LD1 {v.h}[lane]`。

Halfword 通道编号的编码是 `Q:S:size<1>`。iSH 的无后索引与后索引两处分支误取 `size & 1`，使通道 `0…7` 被解码成 `0,0,2,2,4,4,6,6`。`d8aeb31` 将这两处改为 `size >> 1`，并确保增量构建实际更新 `libish_emu.a`。[Arm 指令编码说明](https://documentation-service.arm.com/static/67e40f3398aa3c3b6eea6a85)。

仓库中的 `apps/nsh/native/linux/tests/arm64-halfword-lanes.S` 独立检查半字加载与存储，覆盖全部 8 个通道及三种寻址方式。在同一开发包中，修复前退出码为 3（加载、存储均失败），修复后为 0。修复后的 provider 完整复制 13 项算法，P521 查询成功，rustls HTTPS 请求收到服务端 HTTP 405。

## Codex 进程配置与真实授权验证

Codex runner 为登录、EXEC 和 Cloud 统一设置 `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`，使用 App 所有的 Alpine 系统证书选择官方 rustls 后端。默认 vendored OpenSSL 的记录解密错误与上述半字通道错误分开记录；该配置保留 TLS 证书校验。

修复后的原版 CLI 成功获取设备验证码；正常浏览器流程随后显示 `Signed in to Codex`，插件读取到“已登录”。Task Agent 的纯文本回复验证返回 `NSH_CODEX_OK`，使用同一会话 ID 续聊返回 `NSH_CODEX_RESUME_OK`。

实际 `pwd` 命令的进程创建仍返回 `Failed to create unified exec process: Invalid argument (os error 22)`，该命令执行缺口单独记录在 `todo.md`。Cloud 实测返回当前工作区没有环境，工具记录为 `not_submitted`，未生成云端任务 ID。

客户端、浏览器授权产生的 CLI 凭据及执行进程均属于 App。开发机承担构建、安装和调试；模拟器代理是该验证环境的网络配置。
