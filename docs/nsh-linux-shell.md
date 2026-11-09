# NSH Linux Shell

Android ARM64 通过独立 PRoot 进程执行 Alpine Linux；iOS ARM64 通过静态链接的 iSH 内核执行同一 Alpine `/bin/sh`。Pi Agent 的 `bash` 工具使用此通路，任务详情显示最近 16 KiB 输出，任务回执保留合计最多 8 KiB 的 stdout/stderr 尾部。

## 使用

命令从 `/workspace` 开始。文件工具与 Shell 直接访问同一个工作区；Shell 的 `/root`、`/tmp`、系统目录和软件包数据库位于独立 guest，宿主 `/home/agent` 账本不挂载给 guest。

镜像是 Alpine 3.21.3 aarch64 minirootfs，只包含基础 BusyBox 命令。需要的软件通过工具安装：

```sh
apk add git python3 nodejs npm ripgrep
npm install -g pnpm
```

`local_auto` 对工作区内命令自动允许，对 `apk` 系统变更、`npm/pnpm` 全局安装和工作区外路径变更请求确认。软件包写入私有 guest，关闭应用和应用升级保留已有安装。工具名 `bash` 对应 `/bin/sh -c`，需要 Bash 专用语法时先安装 Bash。

单命令默认期限为五分钟，移动端任务总期限为十分钟。取消后继续读取已写入管道的输出，进程回收完成才发出终态。回收未确认时任务保留 `unknown`，`runtimeExited` 为 `false`。

## 模块边界

- `nsh-node-compat-rs::ShellRunner` 只暴露命令、工作目录、环境覆盖、期限、取消令牌、输出接收端和退出结果；JNI、Objective-C、PRoot 与 iSH 由 App 原生宿主负责。
- `shell.drain` 消费带序号的输出队列；`wait` 在同一把锁下取剩余尾块再释放槽位。每个管道读取器先拼齐 UTF-8 字符，再写入队列。
- Android 每命令启动新的 PRoot；guest 状态文件保留根命令退出码，`SIGQUIT` 清理全部 tracee，再等待 PRoot 回收与双流排空。子进程单独解除 ART 的 `SIGPIPE/SIGQUIT` 屏蔽。
- iOS 的 PID 1 绑定常驻线程，持续回收孤儿。每命令用唯一 `fs_context` 归属标记，fork 继承，`setsid` 和重新认父不改变归属。取消与正常完成均清理该归属全部任务。
- iOS `/workspace` 使用 `realfs` 挂载，系统 rootfs 使用 fakefs。没有使用 fakefs 路径 hook 承载工作区，避免其软链接限制。
- 文件桥逐组件解释 guest 软链接及 Android `.l2s.*` 链，文件打开继续使用 `cap-std` 目录能力；工作区外链接由文件工具拒绝，产物扫描跳过不可解引用链接。
- 同步 `spawnSync`、显式标记的直接 `rg/fd` 以及未注入宿主的桌面环境继续使用基础执行器。Pi SDK 的环境适配只传调用方覆盖值，guest 默认环境集中在执行后端。

默认 guest 环境是 `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`、`HOME=/root`、`TMPDIR=/tmp`、`LANG=C.UTF-8`。调用方的字符串值逐键覆盖默认值。Android 的 `PROOT_LOADER/PROOT_TMP_DIR` 由宿主设置。

## 构建

先安装 `pnpm`、Rust、Xcode、Android SDK/NDK，以及 Homebrew `meson ninja llvm lld libarchive`。工具链环境变量放在仓库 `.env`。依赖版本和下载摘要见 `apps/nsh/native/linux/sources.lock.json`，二进制和 rootfs 只进入本机缓存 `~/Library/Caches/super-looi-linux/`。

```sh
pnpm install --frozen-lockfile
pnpm --filter @super-looi/runtime build
pnpm --filter @super-looi/nsh exec node scripts/prepare-linux-shell.mjs all
pnpm --filter @super-looi/nsh typecheck
pnpm --filter @super-looi/nsh build
```

Android 通过签名前插件打入 PRoot、Termux loader 和 rootfs，并设置 `extractNativeLibs=true`；两个可执行 ELF 均检查 16 KiB `PT_LOAD` 对齐。iOS 按 SDK 选择 iSH 库切片，`libfakefs` 使用 Rust `rusqlite` 提供的 SQLite 符号，Clang builtins 使用对应 SDK 的 arm64 薄切片。

```sh
pnpm --filter @super-looi/nsh exec node --import tsx scripts/nsh.ts package --target ios --out .nsh/linux-ios
pnpm --filter @super-looi/nsh exec node --import tsx scripts/nsh.ts package --target ios-simulator --out .nsh/linux-ios-simulator
```

iPhone 安装运行需在 `.env` 配置 `IOS_SIGN_IDENTITY` 与 `IOS_PROVISIONING_PROFILE`。`run --target ios --device <UDID>` 和 `test:ios --device <UDID>` 通过 iOS 设备打包、签名和 `devicectl` 执行；NSH 0.4 自带的 iOS 开发宿主只支持模拟器，因此此处由 App 脚本处理真机路径。

## 验证入口

```sh
pnpm --filter @super-looi/nsh-node-compat test:rust
pnpm --filter @super-looi/nsh-node-compat test
pnpm --filter @super-looi/runtime test
pnpm --filter @super-looi/nsh test
pnpm --filter @super-looi/nsh test:plugins
pnpm --filter @super-looi/nsh test:android --device <ADB_SERIAL>
pnpm --filter @super-looi/nsh test:linux:android --device <ADB_SERIAL>
pnpm --filter @super-looi/nsh test:ios --device <IPHONE_UDID>
pnpm --filter @super-looi/nsh test:linux:ios --device <IPHONE_UDID>
```

Linux 专项探针实际运行包安装命令，并使用测试模型触发 `local_auto` 审批分支。它使用 NSH 测试宿主的独立数据目录。验证记录见 [真机与构建结果](nsh-linux-shell-verification.md)。

## 第三方许可证与 iOS 对应源码

主仓库使用 GPL-3.0-only。iSH 的 GPLv3 与 `LICENSE.IOS` 文本、PRoot 的版权声明和 GPLv2 文本、talloc 的 LGPLv3 文本保存在 `apps/nsh/native/linux/licenses/`，并随 APK 的 `assets/licenses/linux-shell/`、iOS `.app/ThirdPartyLicenses/LinuxShell/` 分发。

iOS 链接后应用的对应源码包括：本仓库完整源码与 `pnpm-lock.yaml`、`apps/nsh/Cargo.lock`，锁定 NSH 与 Rust 依赖，固定 iSH 源码，以及 sherpa-onnx v1.12.26 和 ONNX Runtime v1.17.1 的源码与构建脚本。iSH 内核桥在 `apps/nsh/native/linux/ish_host.m`；iSH 原库没有另加源代码 patch。App 的准备、编译、资源打包和签名入口均在 `apps/nsh/scripts/` 与 `apps/nsh/build.rs`。

发布 iOS 二进制时，将对应版本源码与二进制放在同一下载位置。源码材料可按以下步骤整理，保留上游许可证与构建脚本：

```sh
# 在发布版本提交上导出整个应用源码。
git archive --format=tar --prefix=super-looi/ HEAD -o super-looi-source.tar
# 将锁定的 Rust 依赖源码及 Cargo 源替换配置一并提供。
cargo vendor --locked --manifest-path apps/nsh/Cargo.toml vendor > vendor-config.toml
# 准备脚本检出的固定上游保存在以下目录，分别导出原始源码。
git -C ~/Library/Caches/super-looi-linux/openminis archive --format=tar HEAD -o /tmp/openminis-source.tar
git -C ~/Library/Caches/super-looi-linux/openminis/deps/ish archive --format=tar HEAD -o /tmp/ish-source.tar
```

同时提供 [sherpa-onnx v1.12.26](https://github.com/k2-fsa/sherpa-onnx/tree/v1.12.26)、[ONNX Runtime v1.17.1](https://github.com/microsoft/onnxruntime/tree/v1.17.1) 的源码快照。它们的 iOS 构建脚本与本仓库 `prepare-sherpa-kws.mjs` 的固定下载版本共同说明语音静态库来源。Alpine 镜像内容及安装包的源码由其 [v3.21 软件包仓库](https://pkgs.alpinelinux.org/packages?branch=v3.21&arch=aarch64) 的对应版本提供。
