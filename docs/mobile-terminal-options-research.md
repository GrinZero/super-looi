# 手机端 Terminal 执行后端调研

调研日期：2026-11-09（Asia/Taipei）。目标是让现有 `apps/nsh` 的 Agent `bash` 能运行真正的开发工具，而不只解析 Shell 语法。本文依据各项目的官方仓库、构建说明和源码；未将候选集成进 Super LOOI，也未在两端真机运行候选。关于 Super LOOI 的接法与优先级属于本项目架构推断。

OpenMinis 的双端执行链、会话目录映射和 NSH 接入边界详见[源码深度分析](openminis-terminal-architecture-analysis.md)。

## 结论

**如果需求是 `git`、Python、Node、`pnpm` 和用户安装的 CLI，Shell 解析器或增加几十个内置命令都无法补齐；需要可执行程序的运行环境。** Android 已有成熟的 Termux/PRoot 生态；iOS 已有上架的 iSH、a-Shell，以及 OpenMinis 把 ARM64 iSH/Alpine guest 放进 Agent App 的公开实现。跨端自有 App 的最有价值参考是 [OpenMinis 构建说明](https://github.com/OpenMinis/OpenMinis/blob/main/BUILDING.md)；Android 先用 [Termux RUN_COMMAND](https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent) 做外部执行探针，是投入最小的能力验证，但要求用户安装和配置另一个 App。

| 方案 | Git / Python / Node / pnpm | Shell / PTY | 集成成熟度与新增成本 | 对本项目判断 |
| --- | --- | --- | --- | --- |
| 继续扩展当前 Rust Shell | 每个命令要逐个实现；不能运行任意 ELF/Mach-O | 有部分语法；无真正进程或 PTY | 现有实现最容易扩展，但维护命令兼容性会随需求增长 | 适合文件搜索、轻量文本处理，不解决用户所说的“什么都跑不了” |
| [Vercel `just-bash`](https://github.com/vercel-labs/just-bash/blob/main/packages/just-bash/README.md) | 核心版无 Git/包管理器；可选 Python、`js-exec` 需要 Node，不能在 browser 版启用 | 广泛 Bash 语法和内置命令；无任意二进制 | TS 包可尝试适配 QuickJS，但需接本机 FS；项目自称 beta | 改善 Shell 语法与命令覆盖，仍达不到通用开发终端 |
| Android 独立 [Termux](https://github.com/termux/termux-app) + [RUN_COMMAND](https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent) | Termux 包仓库有 Git、Python、Node/npm；`pnpm` 要在 Node/npm 环境中另装并实测 | 真进程；可启动终端会话，后台命令能回传结果 | 终端产品成熟；集成需额外 App、用户授权、工作区交换 | 最快证明 Android 真命令能否满足 Agent 任务；非自包含交付 |
| Android 自带 [PRoot + Linux rootfs](https://github.com/termux/proot-distro/blob/master/README.md) | 取决于镜像和所装包；可用发行版包管理器补足 | Linux 用户态进程与 Shell；PTY 需宿主桥接 | [dsh-Go](https://github.com/ccch1mneyyy/dsh-Go/blob/main/runtime/build-runtime.sh)、[OpenMinis](https://github.com/OpenMinis/OpenMinis/blob/main/BUILDING.md) 已做进 App；需维护 rootfs、进程和安装升级 | 自包含 Android 强 Terminal 的主选项 |
| iOS [a-Shell / `ios_system`](https://github.com/holzschu/ios_system) | 已移植 Python 和一批工具；Node/Git 依赖专门移植；不能运行任意下载的原生二进制 | 类 Unix 命令调度，非真正 fork/exec；有限交互 | a-Shell 已在 App Store，`ios_system` 有嵌入说明；每新增命令要链接和维护框架 | 若只要固定工具集，可作比自写 Rust 命令更成熟的 iOS 方案 |
| iOS [iSH](https://github.com/ish-app/ish) / [OpenMinis ARM64 fork](https://github.com/OpenMinis/OpenMinis/blob/main/docs/specs/ios-sandbox-ish-summary.md) + Alpine | guest 内可用 `apk` 装对应架构包；特定 Node/pnpm 组合须真机验证，minirootfs不预装 | guest 内有 fork/exec、PTY；宿主 iOS 仍无通用子进程 | iSH 已在 App Store；OpenMinis 是更贴近 Agent App 的嵌入实例；新增 C/Swift 桥、fakefs、包构建与维护 | iOS 要达到真实 Linux CLI 时最有依据的路线，工程量最高 |
| WASI / 预编译 WebAssembly 命令 | 只能运行已移植成 WASM 的程序；不能直接安装普通 Linux 包 | 依宿主实现；不能替代完整 OS 进程环境 | [a-Shell commands](https://github.com/holzschu/a-Shell-commands) 已示范可加载 WASM 命令 | 适合增添单个 CLI，不适合作为通用 Terminal 基座 |

### 证据与关键边界

1. **当前产品边界**：`PiAgentExecutor` 的工具名是 `bash`，但移动端 `node:child_process` [被映射到 shim](../packages/nsh-node-compat/src/bundler.ts)，shim 将 `sh -c` 送给 [Rust 内置执行器](../packages/nsh-node-compat/rust/src/shell_bridge.rs)。它只认固定命令和参数；未知命令返回 127，默认 1 秒，最大 30 秒，输出结束后才交付。见 [兼容包说明](../packages/nsh-node-compat/README.md)。
2. **Termux 方案**：官方 [RUN_COMMAND](https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent) 允许第三方 App 调用命令并以 `PendingIntent` 收到结果；需要用户安装 Termux，授予 `com.termux.permission.RUN_COMMAND`，并设置 `allow-external-apps=true`。官方 [`nodejs-lts` 包](https://github.com/termux/termux-packages/blob/master/packages/nodejs-lts/build.sh)、[`python` 包](https://github.com/termux/termux-packages/blob/master/packages/python/build.sh) 及 [Git 包目录](https://github.com/termux/termux-packages/tree/master/packages/git) 说明工具在 Termux 生态中有维护。Termux 包默认前缀为 `/data/data/com.termux/files/usr`，所以把其包原样塞进我们的包名/数据目录并非改一个路径就行，见[官方文件布局](https://github.com/termux/termux-packages/wiki/Termux-file-system-layout)。
3. **Android PRoot 自带环境**：[`proot-distro`](https://github.com/termux/proot-distro/blob/master/README.md) 支持安装镜像、`login ... -- command` 和包管理。dsh-Go 的 [runtime 构建脚本](https://github.com/ccch1mneyyy/dsh-Go/blob/main/runtime/build-runtime.sh) 固定 Ubuntu、Node 和 PRoot；其 [Android `DshProcess`](https://github.com/ccch1mneyyy/dsh-Go/blob/main/app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/runtime/DshProcess.kt) 管启动、退出和进程清理。官方 README 要求本机环境预留约 1 GB。OpenMinis 的 [Android 构建说明](https://github.com/OpenMinis/OpenMinis/blob/main/BUILDING.md) 还给出 Android 10+ 可执行文件布局所需的自有 loader 构建过程。以上属于真实宿主工程，不是引入一个 npm 包。
4. **iOS 固定工具集**：[`ios_system`](https://github.com/holzschu/ios_system) 是 `system()` 的 iOS 替代，执行编译进 App 的命令函数；文档列出文件、网络和 Python 等移植件，也明确新命令需编译并嵌入对应 framework。其使用方 [a-Shell](https://github.com/holzschu/a-shell) 已在 App Store，但源码构建中的 Python framework 当前不公开下载。a-Shell 的 [WASM 命令仓库](https://github.com/holzschu/a-Shell-commands) 只解决已编译命令的分发。
5. **iOS Linux guest**：上游 [iSH](https://github.com/ish-app/ish) 采用 x86 用户态仿真和系统调用翻译，已有 App Store 版本。OpenMinis 的 [ARM64 fork 集成说明](https://github.com/OpenMinis/OpenMinis/blob/main/docs/specs/ios-sandbox-ish-summary.md) 列出 Alpine aarch64 guest、PTY、命令回执、输出回调和 session 目录挂载；其 [构建说明](https://github.com/OpenMinis/OpenMinis/blob/main/BUILDING.md) 列出 iSH 与 rootfs 生成步骤，[README](https://github.com/OpenMinis/OpenMinis/blob/main/README.md) 提供 TestFlight 与 Android APK。它的 [rootfs 生成脚本](https://github.com/OpenMinis/OpenMinis/blob/main/deps/prepare_alpine_rootfs.sh) 从 Alpine minirootfs 起步，所以“guest 可装包”不能等同“首次启动已有 Python/Node/pnpm”。直接链接 iSH 代码还会影响项目许可分发方式；OpenMinis [明确记录自身因 iSH/PRoot 采用 GPLv3](https://github.com/OpenMinis/OpenMinis/blob/main/README.md#license)。
6. **`just-bash` 边界**：官方 [README 的 Browser Support](https://github.com/vercel-labs/just-bash/blob/main/packages/just-bash/README.md#browser-support) 只承诺核心解析、执行、文件系统与内置命令；Python、SQLite、`js-exec` 和真实磁盘 FS 需要 Node。我们的 NSH QuickJS 有 JS 运行环境，但不能因此直接启用这些 Node 专属后端。

## 建议的选择与验证顺序

**推荐把“自包含的 Linux guest”作为强 Terminal 的目标架构，把外部 Termux 作为 Android 能力探针。** 这样新增的 PRoot/iSH、rootfs 和原生桥接都有明确用途：运行 Git、Python、Node、包管理器及真实 CLI；其成本是双端构建产物、包更新、工作区映射、命令输出/取消及 App 生命周期维护。若真实需求只是一组固定文件/搜索命令，这笔复杂度便不值得引入。

落地接口应放在现有 `bash` 工具之后，返回流式 stdout/stderr、退出码和取消回执，保留当前 Pi Agent、任务账本、审批与 NSH UI。先在 Android 真机用 Termux `RUN_COMMAND` 跑 `git status`、`python3 -c`、`node -v`、`pnpm -v` 与长输出/取消，确认 Agent 的体验目标；之后比较 Android 内嵌 PRoot 与 iOS 内嵌 iSH 的真实设备结果。前者能验证功能需求，后者才验证自包含架构。按仓库规则，任何调试开发包只装真机，原生改动走 app 自有插件/注册入口。
