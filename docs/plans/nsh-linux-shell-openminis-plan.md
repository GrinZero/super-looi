# NSH 双端 Linux Shell 接入计划

依据：[OpenMinis 源码分析](../openminis-terminal-architecture-analysis.md)、[手机端 Terminal 方案比较](../mobile-terminal-options-research.md)。OpenMinis 参考源码固定在 [`1a71df0`](https://github.com/OpenMinis/OpenMinis/tree/1a71df0f381cefde80bf912b723de6f9831bc177)，其 `ish-arm64` 与 `proot` 子模块分别为 `0fd17a135e78b7a0cf08a4f5831217bbb76ed22f`、`8b31a69345730692f2f49a88694fdcaec78b2031`。

## 目标与已定取舍

将现有 Pi Agent 的 `bash` 工具接到 App 内 Linux guest，让 Android ARM64 的 PRoot 与 iOS 的 ARM64 iSH 执行真实 Alpine `/bin/sh` 命令。两端同步开发、共同验收；首版只接非交互式 `pipe` 命令通路，不增加交互式终端页面或 PTY（伪终端）。

- **镜像边界与内置搜索分工**：Alpine `3.21.3` `aarch64` 镜像保持 `minirootfs` 精简形态，不预装 Git、Python、Node、`pnpm`、`ripgrep` 或 `fd`。Agent 在 `bash`（`/bin/sh -c`）中按审批使用 `apk`、`npm` 安装并跨重启持久化；Pi SDK 的 `grep` 与 `find` 工具直接发起的非 Shell `spawn("rg" | "fd", ...)`（`!options.shell`，对应 `headless-coding.ts` 的 `ensureTool`）由 `child_process.ts` 显式标记 `builtin: true`，继续走 `nsh-node-compat` 进程内 Rust `rg`/`fd`，保证未装包状态下七大默认工具与兼容层测试门禁（`CompatProbe`）直接可用。
- **ABI 范围与失败语义**：Android 强 Shell 首版只覆盖 `arm64-v8a`，其他 Android ABI 及未注入 `ShellRunner` 的桌面 `qjs_runner` 保持现有基础执行器；移动端 ARM64 guest 启动失败时直接返回明确错误，不在同一次命令中静默回退到旧内置 Shell。
- **实时流与持久化回执分工**：命令运行中在任务详情实时显示最近 `16 KiB` 输出；任务结束（含成功、失败、超时、取消）在 `AgentCommandEvidence` 中保留受限长度（单条上限 `8 KiB`）的输出尾部与命令回执。
- **命令进程归属**：每次调用拥有本次启动的全部 guest 后代，包括另建进程组或会话的子进程；根命令结束、取消或超时后统一回收。进程归属与输出排空由原生 `ShellRunner` 内部处理，沿用现有取消令牌与终态回执接口。
- **开源许可合规边界**：Android 端 `PRoot`（GPLv2）以独立子进程 `fork/exec` + 管道方式运行（聚合分发）；iOS 端将 `OpenMinis/ish-arm64`（GPLv3 + `LICENSE.IOS` App Store 例外条款）静态链接进主程序 Mach-O，对外分发 iOS 二进制包（IPA / TestFlight / App Store）时须按 GPLv3 提供整个链接后 iOS 应用的完整对应源码（Corresponding Source）、构建说明与许可证文本。

## Step 1：固定依赖、工具链前置与双端打包

- [x] 在 `apps/nsh` 构建准备脚本中固定上述 `ish-arm64`/`proot` 提交、Termux `libproot-loader.so` 固定版本及 Alpine `3.21.3` `aarch64` minirootfs 的 SHA-256 校验值，产物写入本机缓存目录；脚本启动时自检宿主机编译前置依赖（`meson`、`ninja`、编译 iSH VDSO 所需的 Homebrew `llvm`、编译 `fakefsify` 所需的 `libarchive` 以及 Android NDK），只提交脚本与锁定信息，不提交 rootfs 或二进制产物。
- [x] **iOS 静态库编译与真机打包闭环**：
  - 从固定 Alpine 镜像经 `fakefsify` 生成 iSH fakefs rootfs，分别为 `iphoneos`（`arm64`）和 `iphonesimulator`（`arm64`）编译 `libish.a`、`libish_emu.a`、`libfakefs.a`；确保 `libfakefs` 与 Rust `rusqlite` 共用同一套 SQLite 符号（避免与 `libsqlite3-sys` 产生重复 `sqlite3_*` 静态符号冲突）。
  - 在 `apps/nsh/build.rs` 按目标 SDK 选择真机或模拟器库切片，同时补齐 Clang builtins（`libclang_rt.ios.a`）解决现有 ONNX 静态库缺失 `___chkstk_darwin` 的真机链接阻塞；修正 `apps/nsh/scripts/nsh.ts` 中将 `target === "ios"` 混同为 `iosSimulator` 的分支，拆分真机打包/运行与模拟器编译检查路径，并通过签名前插件将 rootfs 归档打入 `.app` 资源目录。
- [x] **Android 可执行装载与 16 KB 页对齐**：
  - 编译 `arm64-v8a` `libproot.so` 并连同 `libproot-loader.so` 放入原生插件 `lib/arm64-v8a/*.so`，rootfs 归档作为 APK `assets` 打包；在准备脚本中对两个 `.so` 执行 16 KB ELF `PT_LOAD` 对齐校验。
  - 在 `apps/nsh/native/android/patch_manifest.py` 为 `<application>` 写入 `android:extractNativeLibs="true"`（属性 ID `0x010104ea`），确保系统安装 APK 时将 `libproot.so` 与 loader 解压到可执行的 `nativeLibraryDir` 磁盘目录；由 `SuperLooiApplication.java` 经 JNI 向 `apps/nsh/src/compat.rs` 注入 `nativeLibraryDir` 与 asset 解压入口，不直接修改 NSH 生成产物。
- [x] **首次解压、异常锁恢复与带外状态上报**：
  - 两端首次执行 Linux 命令时由宿主单次初始化锁保护，将镜像原子解压（先写临时目录再重命名）至 App 私有 `node-compat/linux/`；单条命令在中途被取消时仅解除自身等待，不中断正在进行的首次解压；rootfs 版本标记仅控制首次安装，App 升级保留已有 guest 与已安装软件包。启动前清理上次进程异常退出残留的临时解压目录与 `/lib/apk/db/lock`。
  - 解压阶段通过带外 `status` 事件（独立于 `stdout`/`stderr`，不混入 `ChildProcess` 标准输出流，确保 `CompatProbe` 输出断言纯净）向当前任务推送安装状态，安装完成后再启动命令；同步将 `apps/nsh/scripts/nsh.ts` 中真机 `--device` 运行 `CompatProbe` 的等待超时放宽至 60 秒。

## Step 2：实现原生执行、宿主不变量与隔离挂载

- [x] **定义深模块 `ShellRunner` 接口**：在 `nsh-node-compat-rs` 内定义宿主注入的 `ShellRunner` trait（输入 `command`、`cwd`、`env`、`timeout`、取消令牌与流式块/状态接收端；输出退出码、`timedOut`、`cancelled`）。由 `apps/nsh/src/compat.rs` 注入 Android `arm64-v8a` 与 iOS `arm64` 实现，使通用 `nsh-node-compat-rs` 不依赖 JNI/Objective-C 或 GPL 代码；同步 `shell` API（`spawnSync`）、显式 `builtin: true` 的直接 `rg`/`fd` 调用（`!options.shell`）及未注入 `ShellRunner` 的环境保持原内置执行器，其余异步 `spawn`（含 `sh`/`bash` `-c`/`-lc`、`options.shell` 及其他 guest 可执行程序）统一路由至 `ShellRunner`。
- [x] **guest 默认环境与覆盖顺序**：由 `ShellRunner` 为双端构造同一套 guest 基础环境：`PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`、`HOME=/root`、`TMPDIR=/tmp`、`LANG=C.UTF-8`，再按键覆盖调用方传入的 `env` 字符串值；未传 `env` 时仍使用这些默认值。Android 在执行 PRoot 的宿主环境中另外注入构建产物路径所需的 `PROOT_TMP_DIR`、`PROOT_LOADER`，guest 的命令查找与 home 不继承 ART 的环境。非登录 `/bin/sh -c` 直接使用构造后的环境，不依赖 `/etc/profile`；环境构造集中在现有执行后端，调用方只传覆盖值。参考固定上游的 [Android 默认环境](https://github.com/OpenMinis/OpenMinis/blob/1a71df0f381cefde80bf912b723de6f9831bc177/src/android/app/src/main/java/com/openminis/app/sandbox/PRootKernel.kt#L141-L143)。
- [x] **Android PRoot 独立进程执行（`FRESH_PROCESS`）**：
  - 每条命令新建 `libproot.so` 子进程并建立独立宿主进程组，携带 `-0`（伪造 root UID 以支持 `apk`/`npm`）、`--link2symlink`（规避 Android `app_data_file` SELinux 硬链接限制）、`-v -1`（关闭 PRoot 自身的非错误诊断，避免正常清理提示进入命令 stderr）、`-r <rootfs>`、`-b /dev`、`-b /proc`、`-b /sys`、`-b <host_workspace>:/workspace`、`-b <host_resolv_conf>:/etc/resolv.conf`、`-w <cwd>`，设置 `PROOT_TMP_DIR` 指向应用私有临时目录、`PROOT_LOADER` 指向 `nativeLibraryDir/libproot-loader.so`，在 guest 内执行 `/bin/sh -c`。
  - **子进程信号状态**：在 `fork` 后、`exec` 前，仅由子进程解除从 ART 继承的 `SIGPIPE` 与 `SIGQUIT` 屏蔽，并将 `SIGPIPE` 的处理方式恢复为 `SIG_DFL`；宿主线程保持原信号状态。`SIGPIPE` 可使 Alpine BusyBox `yes work | head -c 50000` 在 `head` 退出后正常结束；`SIGQUIT` 解屏蔽后，PRoot 事件循环注册的清理处理器才能收到下一项的宿主清理信号。固定版本的 [`SpawnSignalMask`](https://github.com/OpenMinis/OpenMinis/blob/1a71df0f381cefde80bf912b723de6f9831bc177/src/android/app/src/main/java/com/openminis/app/sandbox/SpawnSignalMask.kt) 与 [`pty_bridge.c`](https://github.com/OpenMinis/OpenMinis/blob/1a71df0f381cefde80bf912b723de6f9831bc177/src/android/app/src/main/cpp/pty_bridge.c) 可参考其子进程信号调整入口；本方案另需解除其仍保留的 `SIGQUIT` 屏蔽。
  - **完成条件与进程收尾**：独立线程从命令启动起分别排空 `stdout` 与 `stderr`。guest 包装进程写出的每命令独立状态文件表示根命令已经结束；宿主一旦读到完整状态即保存原退出码，随后清理本次 PRoot 的全部 tracee（受跟踪进程），不先等待两条管道 EOF 或 PRoot 自行退出。固定版本 PRoot 的 [`SIGQUIT` 处理会调用 `kill_all_tracees` 并继续事件循环回收](https://github.com/OpenMinis/proot/blob/8b31a69345730692f2f49a88694fdcaec78b2031/src/tracee/event.c#L109-L121)，据此终止仍存活的后台后代（包括 `setsid` 后代）；取消、超时在 guest 包装进程启动确认后走同一清理入口。清理期间继续读取已写入两条管道的字节，等待 PRoot 回收及双流 EOF、读取线程结束后才发布终态并释放 `ShellJob`。正常完成保留状态文件中的根命令退出码，清理信号不将其改成失败或取消；启动失败没有状态文件时返回启动错误。清理过程受 `stopGraceMs` 约束，回收未确认时不返回成功回执。
- [x] **iOS iSH 进程内内核与 5 项宿主运行不变量**：
  - 以精简 Objective-C/C 桥连接 Rust 宿主，在专用常驻内核线程上启动一次 iSH 内核并完整保留以下 5 项宿主不变量：
    1. 注册 `install_jit_crash_handler` 处理 `asbestos` 并发写时复制（CoW）缺页触发的 `SIGSEGV`/`SIGBUS`，非 iSH 线程信号链式转发给原处理器；
    2. 在常驻内核线程执行 `become_first_process`，保证 PID 1 绑定的 `pthread_t` 在 App 生命周期内不悬空；
    3. 启动 250ms 内存治理定时器与 `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE` 监听喂入 `ish_set_memory_status`，并按 iOS 宿主 `getpagesize()`（16 KB）折算 `ish_set_anon_page_limit`，防止包安装触发 Jetsam 杀进程或因状态过期阻塞分配；
    4. 将 `sock_tmp_prefix` 指向沙盒 `NSTemporaryDirectory()` 下的短路径（满足 Darwin `sun_path` 104 字节上限）；
    5. 内核初始化前在宿主环境设置 `ISH_NETLINK_STUB=1`，使 Node.js/`npm` 的 `libuv` `AF_NETLINK` 探测正常返回。
  - 每条命令 fork 独立 guest `/bin/sh -c` 子进程并建立独立 guest 进程组，通过独立 `stdout`/`stderr` pipe 流式读取输出。在 iSH 创建根任务时绑定本次命令归属，并在 fork 路径让后代继承；归属随任务生命周期维护，`setpgid`、`setsid` 以及中间父进程退出后由 PID 1 接管均不改变归属。任务身份须能区分 PID 复用，不能仅在清理时扫描当前父链或进程组来推断归属。正常退出、超时与取消均在原生工作线程按该归属清理全部命令后代：先发 `SIGTERM`，`200ms` 后对仍存活且归属未变的任务发 `SIGKILL`，再回收并排空两条输出管道；回收完成后释放本次归属记录。该机制增加 iSH 任务创建与退出路径的接入成本，用于兑现全部后代回收契约，保持在原生执行器内部，不新增对外进程管理接口。参考上游 [`killProcessGroup` 的进程组与后代联合匹配](https://github.com/OpenMinis/OpenMinis/blob/1a71df0f381cefde80bf912b723de6f9831bc177/src/ios/iSH/ISHShellExecutor.m#L679-L785)。
- [x] **文件系统映射、DNS 生成与 Agent 账本隔离**：
  - **DNS 注入**：两端在宿主侧生成包含有效上游 DNS 的 `resolv.conf` 并挂载至 guest `/etc/resolv.conf`，保证 musl `getaddrinfo` 域名解析可用。
  - **目录隔离与直通挂载**：只将 guest `/workspace` 映射到 `NodeCompat` 宿主目录 `node-compat/files/workspace`（iOS 端必须通过宿主目录直通路由/`realfs` 挂载并配置 `fakefs_set_rootfs_data_path` 防环保护，不能放入基于 SQLite `meta.db` 索引的 `fakefs`，确保 `write_file`/`read_file` 与 `bash` 双向即时可见）。guest 的 `$HOME`（`/root`）、`/tmp`、`/usr` 与 `apk` 数据库均留在独立 rootfs 内；**不映射**宿主 `files/home`，避免暴露 `files/home/agent` 中的任务审计账本与会话记录。
  - **工作区软链接路径一致性**：在原生 `Sandbox` / `fs_bridge` 中集中处理工作区路径各级软链接的 guest 路径语义：目标落在 `/workspace` 内的绝对链接（如 `link.txt -> /workspace/original.txt`）映射到宿主工作区内对应文件，供 `read_file`、`write_file` 与跟随链接的文件元数据操作共用；内置搜索显式指定链接路径时复用同一解析，保持现有默认链接遍历策略，相对链接保持一致行为。路径转换由现有文件桥统一承担，文件打开仍基于 `cap-std` 目录能力。
  - **PRoot 硬链接转换的宿主路径**：Android `--link2symlink` 会将原文件和新硬链接转换成指向 `.l2s.*` 的软链接链，目标是绝对宿主路径，见[固定实现](https://github.com/OpenMinis/proot/blob/8b31a69345730692f2f49a88694fdcaec78b2031/src/extension/link2symlink/link2symlink.c#L67-L175)。现有文件桥在解释 guest 绝对链接前识别该内部链，将实际位于规范化宿主工作区目录内的 `.l2s.*` 绝对目标转成工作区相对路径，并逐级解析；每一级仍须落在同一工作区目录能力内，不能仅凭 `.l2s.` 名称放行。文件读写、跟随链接的元数据、内置搜索显式路径及产物扫描共用此转换，避免硬链接创建后连原文件也无法被文件工具访问。该转换并入上一项路径解析，复用已有目录能力与调用链；普通 guest 链接继续按 `/workspace` 语义解释。
  - **外部软链接容错**：工作区链接按 guest 路径解析后指向 `/workspace` 外（如 `/usr/bin/python3`）时，文件工具保持拒绝访问；修改 `PiAgentExecutor.recordArtifact` 的工作区产物扫描逻辑，使用 `lstatSync` 与文件桥的链接目标解析能力识别并跳过这类链接，防止 `EACCES` 中断扫描其余产物。指向 `/workspace` 内文件的绝对链接按上一项正常访问。

## Step 3：贯通流式传输、超时取消与命令回执

- [x] **无竞态流式输出块与 UTF-8 跨块拼帧**：
  - 原生管道读取器在每次 `read()` 后缓存末尾不完整的 UTF-8 多字节序列（1–3 字节），拼齐后再生成递增序号的 `{sequence, stream, text}` 输出块存入 `ShellJob` 的 `Mutex` 有界队列，杜绝中文分块乱码。
  - 保持 `NodeCompat` 现有 `request`/`begin`/`wait` 类签名不变：在 `Bridge::request` 新增同步 `shell.drain(jobId, afterSequence)` 供 QuickJS 在 `__nsh_shell_wait` 挂起期间轮询并实时推入 `stdout`/`stderr` stream（仅消费 `stdout`/`stderr` 块，带外 `status` 触发独立事件），同时推进 `last_drained_seq`；`Bridge::wait(ticket)` 在后台线程完成唤醒后、`ShellLease` drop 释放槽位前，在同一把 `Mutex` 下原子取出 `sequence > last_drained_seq` 的剩余 `tailChunks` 连同 `{ status, timedOut, cancelled }` 一并返回，消除丢尾部输出、重复推送与 16 槽位泄漏竞态。
  - 对齐 `child_process.ts` 事件语义：`child.killed || result.cancelled` 时继续发出 `close(null, "SIGTERM")`（兼容 `verify-budgets.ts` 取消断言），并在发出终止事件前将 `result.timedOut` 暴露为 `child.timedOut`，供 `PiAgentExecutor` 与 `NshExecutionEnv` 读取。
  - **迁移 `NshExecutionEnv` 超时契约**：同步修改 `packages/nsh-node-compat/src/adapters/pi-durable-env.ts` 的 `close` 分支，先依据 `child.timedOut` 返回 `ExecutionError("timeout")`，其余结果沿用取消与正常退出逻辑；继续识别基础执行器经 `error` 事件返回的 `ETIMEDOUT`。结构化 `{status:124,timedOut:true}` 必须保持原有超时错误语义；命令自行 `exit 124` 且 `timedOut:false` 时仍返回普通退出码。
- [x] **超时、取消宽限期与前后台生命周期收敛**：
  - 在 `PiAgentExecutor` 调用 `spawn` 时显式透传单命令 `timeout`（默认 5 分钟）并按真实结果写入 `timedOut`（替换现有硬编码 `false`），移动端任务总期限 `deadlineMs` 设为 10 分钟。
  - 将 `PiAgentExecutor` 的取消宽限期 `stopGraceMs` 从 `200ms` 上调至 `3000ms`，给足 PRoot 进程树清理与 iSH 进程组回收时间，避免正常取消超时落入 `"unknown"` 状态误锁死会话。
  - **取消后继续接收尾部输出**：调整 `PiAgentExecutor.killChild()`，取消时只请求终止，不立即 `destroy()` `stdout`/`stderr`，保留数据监听直到原生完成进程回收、管道排空并由兼容层发出 `close`；随后再释放监听与流资源、生成取消回执。与前述原生终态及 `tailChunks` 顺序保持一致，确保取消前及清理期间已写入管道的输出进入实时缓冲与受限长度的回执尾部。
  - 收敛 `apps/nsh/store.ts` 对生命周期失焦的处理：短暂 `inactive`（如下拉通知栏或系统弹窗）不立即调用 `stop()` 强杀正在执行的命令，仅在真正进入后台需停止时走完整取消回收流程。
- [x] **正式流式输出回调与全终止态回执落盘**：
  - 在 `AgentRunOptions` 新增正式 `onShellOutput` 回调（携带 `taskId`、`callId`、`command`、`stream: "stdout" | "stderr" | "status"`、`chunk`），由 NSH store 维护当前运行命令状态及最近 `16 KiB` 实时输出缓冲；高频逐块输出不写入持久化 `AgentStepEvent` 账本。
  - 修正 `PiAgentExecutor` 输出截断逻辑为按 UTF-8 字符边界保留**尾部**（单条上限 `8 KiB`，受控于 `SqliteRuntimeStore` 单任务快照 `2 MiB` 上限），并在 `succeeded`、`failed`、`cancelled` 及超时全部分支都将已产生的 `executions`（`AgentCommandEvidence`）写入 `task.result`。
  - 修复 `apps/nsh/store.ts` 中 `inspectTask` 随步骤/完成事件实时刷新当前任务快照，并将 `TasksSpaceView.tsx` 与 `TasksPanel.tsx` 中命令列表的渲染 key 从 `e.command` 改为唯一 `e.callId`。
- [x] **工具提示词与既有 `local_auto` 边界对齐**：
  - 更新 `bash` 工具描述为 Alpine `/bin/sh` 环境（基础命令直接可用，其余工具可通过 `apk` 安装；不宣称预装 Git、Python、Node 或 `pnpm`）。
  - 对齐 `PiAgentExecutor` 中既有 `local_auto`（工作区内自动允许、工作区外变更需确认）契约：将修改工作区外 guest 系统的命令（如 `apk add`/`apk del`、`npm`/`pnpm` 全局 `-g` 安装）归入工作区外变更并触发确认，而非在 `local_auto` 下无条件放行全部 `bash` 调用。

## Step 4：真机验收与文档交付

本次交付范围：Android ARM64 真机验收，iOS 按用户确认完成设备与模拟器双 SDK 构建检查。下列“双端真机”项目的 Android 部分见 [验证记录](../nsh-linux-shell-verification.md)，iPhone 运行验收未执行。

- [x] 运行相关 `pnpm` 类型检查、构建、兼容层测试（桌面 `qjs_runner` 及 Android ARM64 真机 `CompatProbe`）、iOS 双 SDK 构建与原生插件测试；独立子 Agent 复核执行接口、目录隔离、UTF-8 流式分块、审批分支与取消/超时回执通过。调试开发包只安装到 Android ARM64 真机，iOS 模拟器仅用于编译检查。
- [ ] 双端真机分别验收首次解压进度与完成、`pwd`、`write_file`/`read_file` 与 guest `/workspace` 的双向即时可见性、guest 内创建外部绝对软链接不打断任务、非零退出码、独立 `stdout`/`stderr`、中文跨块流式输出、运行中任务详情实时更新、手动取消（不锁死会话）、单命令超时回执及 App 重启后的包持久化。
- [x] Android ARM64 真机执行 `yes work | head -c 50000`，确认输出恰为 `50000` 字节、管道正常结束且退出码为 `0`，不等待单命令超时。
- [ ] 双端真机在不传 `env` 时执行 `printf '%s\n' "$PATH" "$HOME"` 与 `command -v apk`，确认默认路径指向 Alpine、home 为 `/root`；传入自定义环境变量及 `HOME` 时确认覆盖生效，未覆盖的 `PATH` 仍保留默认值。
- [x] Android ARM64 真机分别执行 `sleep 600 & echo done` 和 `setsid sh -c 'sleep 600' >/dev/null 2>&1 & echo done`，确认根命令结束后在 `3000ms` 回收宽限期内返回退出码 `0`，双流结束，相关 guest 后代与 PRoot 均已回收；正常结束前分别向双流写入超过一个读取块的内容，确认清理后尾部仍完整。
- [ ] iPhone 真机执行 `setsid sh -c 'sleep 600' & wait`，分别触发手动取消与单命令超时，确认另建会话的后代也被回收，保留正确的取消/超时回执，随后立即执行 `echo next` 成功；另验收根命令正常结束后同样回收其残留后代。
- [ ] iPhone 真机构造“中间父进程启动 `setsid` 后代后提前退出”的命令，确认该后代已由 PID 1 接管；分别在根命令正常结束、手动取消与超时时验收后代仍被回收，随后 `echo next` 成功。
- [ ] 双端真机在命令持续运行时向 `stdout`/`stderr` 写入可识别尾部标记后触发取消，并覆盖清理期间继续输出的情况；确认终态前输出继续送达、取消回执保留受限长度的双流尾部，且 `close` 后释放监听与流资源。
- [ ] 双端真机在 `/workspace` 创建普通文件、相对软链接、指向该文件的 `/workspace/...` 绝对软链接，验收 Shell 与文件工具经链接双向读写、文件元数据以及内置搜索显式访问链接路径时解释一致，递归搜索保持原有链接遍历行为；指向 `/usr/bin/python3` 的外部链接由文件工具拒绝，产物扫描继续处理其余文件。
- [x] Android ARM64 真机在 `/workspace` 执行 `printf a > original; ln original hardlink`，通过 `read_file`/`write_file` 分别访问两个路径，确认 Shell 与文件工具修改后双方立即可见、跟随链接元数据及内置搜索显式路径均可用、产物扫描能收集文件；工作区外的链接仍按外部链接规则处理。
- [x] 兼容层定向验证 `NshExecutionEnv` 的四种结果：旧 `ETIMEDOUT` 错误与新 `{status:124,timedOut:true}` 均返回 `ExecutionError("timeout")`；用户取消返回 `ExecutionError("aborted")`；命令自行 `exit 124` 返回 `ok({exitCode:124})`。
- [ ] 在精简镜像中经审批实际执行 `apk add git python3 nodejs npm ripgrep`、`npm install -g pnpm`，双端真机共同验收 `git status`、`python3 -c`、`node -v`、`pnpm -v`、`rg --version` 通过。
- [x] 将实施步骤与验证结果更新至 `progress.md`，阶段性待解决问题记入 `todo.md`，按步骤分阶段提交。完成后同步更新 `docs/arch/index.html`、使用说明、第三方许可证及 iOS GPLv3 对应源码与构建说明。

## 完成标准

Pi Agent 在 Android ARM64 真机与 iPhone 真机的同一持久化 `/workspace` 中运行真实 Alpine `/bin/sh` 命令，与文件工具双向即时共享工作区且隔离保护 Agent 内部账本；能按审批规则联网安装并在重启后继续使用 Git、Python、Node、`pnpm` 等软件包；任务详情在运行期实时展示流式输出，在成功、失败、取消、超时四类终态均保留准确回执，且满足双端各自组件的开源许可要求。
