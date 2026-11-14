# NSH 开发包循环断线：传输限制与上游修复调研

调研日期：2026-11-14。项目固定 NSH `0.5.0`，提交 `f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1`。

本故障可以在 NSH 公共开发客户端内修复：显式让单帧接收上限与已有 64 MiB 消息上限一致，并把真实读取错误送到开发提示和日志。实测普通包约 31.35 MiB，独立探针可完整接收；这条传输路径支持保留正常开发构建和热更新。

## 本地复现与因果确认

恢复前，8790 端口没有监听，截图中的旧宿主持续重连。重新启动普通开发服务后，宿主出现快速的 connected／disconnected 循环；这是大包读取失败暴露出的第二个问题。端口无人监听只能证明当时服务已停止，不能确定其退出触发原因。

在独立 8793 端口运行同一项目的普通开发服务，使用与固定版本宿主源码依赖相同的 tungstenite `0.30.0` 编译临时 Rust 客户端。客户端发送协议版本 2 与匹配的字节码版本 `quickjs-ng-0.16.2+0fdea21/bc28/le`，接收真实项目构建，不执行 App 代码。

| 客户端配置 | 实际结果 |
| --- | --- |
| `tungstenite::connect` 默认配置 | 控制消息成功；读取字节码时得到 `Capacity(MessageTooLong { size: 32873600, max_size: 16777216 })` |
| 只设置 `max_frame_size(Some(64 << 20))`，消息上限仍为默认 64 MiB | 完整收到 32,873,600 字节字节码与 14,215,726 字节 source map，分别约 31.35 MiB 与 13.56 MiB |

默认读取失败的原始显示信息为：

```text
Space limit exceeded: Message too long: 32873600 > 16777216
```

两次读取使用同一服务会话和构建，唯一有意改变的条件是客户端帧上限，因而直接确认了该容量配置对本次传输失败的影响。64 MiB 是每条消息的上限，字节码和 source map 分别计数。探针证明了传输可行性，没有替代重建宿主后的加载与热更新验收。

压缩构建使用 `dev --server-only --port 8790 --release`，CLI 显示 7.7 MB 字节码，原宿主接收后保持连接。

## 开发包体来源

项目的 `apps/nsh/scripts/build-runtime.ts` 已启用 esbuild `minify: true`，生成的开发运行时约 5.73 MB。因此再建议“打开 minify”没有对应的未启用选项。

普通 NSH 开发路径使用 `compile_hot`，保留热更新模块，并以 `compile_bytecode_with(..., false, ...)` 编译。此处 `false` 对应 `Strip::Nothing`：QuickJS 字节码保留函数源码、行号和列号表。release 路径使用另一套打包／压缩流程及 `Strip::All`；存在动态 import 时仍可能保留解析所需的调试数据。所以 31.4 MB 到 7.7 MB 的变化不能只归因于 JS 压缩。[普通开发编译](https://github.com/longbridge/nsh/blob/f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1/crates/nsh-cli/src/build.rs#L306-L325)、[字节码 Strip 定义](https://github.com/longbridge/nsh/blob/f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1/crates/nsh-js/src/bytecode.rs#L29-L51)、[实际写入选项](https://github.com/longbridge/nsh/blob/f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1/crates/nsh-js/src/bytecode.rs#L128-L136)。

`Strip::Source` 可以移除函数源码并保留栈位置信息，但会改变 `Function.prototype.toString()` 的行为。它属于独立的包体优化取舍；本次未测量其体积和 SDK 兼容性，不作为容量修复的前提。

## 上游实现确认

NSH 开发协议把一个构建作为 JSON 控制消息、一个完整二进制 payload（载荷）和可选的一个完整 source map（源码映射）发送；热更新 Patch 使用同样的消息布局。固定版本服务端直接调用 `socket.send(Message::Binary(payload))`，源码映射也单独作为完整 Binary message（消息）发送。宿主的 `DevClient` 调用 `tungstenite::connect`，没有传入自定义 WebSocket 配置。[协议定义](https://github.com/longbridge/nsh/blob/f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1/crates/nsh-dev/src/protocol.rs#L1-L8)、[服务端发送](https://github.com/longbridge/nsh/blob/f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1/crates/nsh-dev/src/server.rs#L1051-L1076)、[客户端连接](https://github.com/longbridge/nsh/blob/f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1/crates/nsh-dev/src/client.rs#L153-L177)。

tungstenite `0.30.0` 默认允许单个消息最多 **64 MiB**，但单个 frame（帧）最多 **16 MiB**。因此，消息本身没有超过 64 MiB，也可能因为服务端用一个超过 16 MiB 的帧承载它而在读取阶段被拒绝。`max_frame_size` 与 `max_message_size` 是两个不同约束。[官方 WebSocketConfig 文档](https://docs.rs/tungstenite/0.30.0/tungstenite/protocol/struct.WebSocketConfig.html#structfield.max_frame_size)。

固定版本把除 WouldBlock／实际读取超时之外的 `socket.read()` 错误统一映射为不携带原因的 `SessionEnd::Disconnected`；连接线程随后发出 `DevEvent::Disconnected` 并继续重连。因此实际的容量错误不会到达现有断线提示，也不能从服务端的 connected／disconnected 行恢复出来。[客户端读取与错误分支](https://github.com/longbridge/nsh/blob/f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1/crates/nsh-dev/src/client.rs#L252-L276)、[重连循环](https://github.com/longbridge/nsh/blob/f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1/crates/nsh-dev/src/client.rs#L153-L177)。

## 最新版本是否已修复

2026-11-14 发布的最新稳定版为 **NSH 0.5.1**，提交 `224d9a795c7ac9d10d75750de9351adac5549675`。发布说明将其定义为面向 0.5.0 的 bugfix（缺陷修复）版本，无公开 API 变化。[0.5.1 发布页](https://github.com/longbridge/nsh/releases/tag/v0.5.1)。

但是，0.5.1 的 `client.rs:170` 仍使用默认 `tungstenite::connect`，`:282` 仍丢弃读取错误详情；`server.rs:1124–1126` 仍发送完整 Binary payload 和 map。调研时的 `main` 提交 `a68a2e388bee36a4efdccbd9f53440d3bd9e933f` 也保留这三处实现。**单纯升级到 0.5.1 或该 main 提交，不能解决当前大包读取失败。** [0.5.1 客户端](https://github.com/longbridge/nsh/blob/224d9a795c7ac9d10d75750de9351adac5549675/crates/nsh-dev/src/client.rs#L160-L190)、[0.5.1 读取错误](https://github.com/longbridge/nsh/blob/224d9a795c7ac9d10d75750de9351adac5549675/crates/nsh-dev/src/client.rs#L270-L284)、[0.5.1 服务端](https://github.com/longbridge/nsh/blob/224d9a795c7ac9d10d75750de9351adac5549675/crates/nsh-dev/src/server.rs#L1110-L1129)、[main 客户端](https://github.com/longbridge/nsh/blob/a68a2e388bee36a4efdccbd9f53440d3bd9e933f/crates/nsh-dev/src/client.rs#L160-L190)。

与重连有关的 [PR #1983](https://github.com/longbridge/nsh/pull/1983) 已进入 0.5.1：客户端在 Hello 中声明运行中的构建，服务端保留最近 32 个构建的补丁，使同一服务会话内的断线重连能补齐遗漏更新。它解决重连时的状态丢失；它仍在补丁之后发送最新整包，首次加载也仍需整包，因此不解决帧容量问题。该 PR 的 optional（可选）字段保持协议版本 2。[实现提交](https://github.com/longbridge/nsh/commit/956b8170b5e64bc26a42dbb7f9c1a69f09e8622d)。

公开搜索还找到 [Issue #1644](https://github.com/longbridge/nsh/issues/1644) 讨论初始 TSX 应用安装包偏大，但正文仅标明 NSH 0.4.0，没有大帧断线诊断或可直接采用的传输修复。检索 `MessageTooLong`、`tungstenite`、`large bundle`、`fragmentation` 与 `bundle disconnect` 后，对已核对的 0.5.1 和 main 源码仍需自行修复接收配置。

## 修复方案与复杂度

| 方案 | 实际用途 | 修改边界与成本 | 判断 |
| --- | --- | --- | --- |
| 宿主显式配置 `max_frame_size = max_message_size = 64 MiB`，并保留读取错误 | 让当前 31.4 MB 整帧包在已有 64 MiB 消息契约内可读取，恢复普通开发构建与热更新 | 改公共 `nsh-dev` 客户端一处配置及错误链；重新构建含该客户端的开发宿主。没有新服务、协议实体或产品运行依赖 | 当前优先方案；修复发送方式与接收配置不匹配，而不是依赖压缩率 |
| RFC 6455 continuation frames（连续帧） | 把一个大消息按标准拆成多个小帧，客户端仍收到一个完整消息 | NSH 当前服务端使用 axum 的 `ws::Message`，其公开变体只有 Text／Binary／Ping／Pong／Close，未暴露 raw Frame。需要下沉到支持发送原始帧的抽象，不能只循环调用 Binary | 标准可行，但当前工程成本高于客户端配置修复 |
| 协议级 chunk（分块）消息 | 使大于现有消息上限的包也能传输，支持按块管理进度 | 新增消息元数据、拼装状态、完成条件与宿主兼容处理；需要变更双方及浏览器客户端 | 当前 31.4 MB 没有超过 64 MiB，收益不足以抵偿新协议成本 |
| WebSocket 只通知，HTTP 拉取 bundle／map | 将构建数据交给现有 HTTP 服务传输 | 新增构建地址、版本绑定、下载与载入生命周期，以及所有宿主的下载路径 | 可作为更大规模开发协议的独立演进，目前不必引入 |
| 始终 `--release` 或继续压缩包体 | 缩小目前的载荷，使其低于 16 MiB | 不改传输，但把可否开发绑定到包体尺寸；当前 NSH release 分支每次构建发布整包 | 可恢复运行，不能修复传输约束不匹配 |

64 MiB 沿用当前 tungstenite 消息上限，不需要再设一个任意的新容量值。服务端当前也显式设置 `max_message_size(64 << 20)`；这是对其接收路径的配置，不会自动改变客户端的入站帧上限。[服务端升级配置](https://github.com/longbridge/nsh/blob/224d9a795c7ac9d10d75750de9351adac5549675/crates/nsh-dev/src/server.rs#L677-L692)、[tungstenite 配置](https://docs.rs/tungstenite/0.30.0/tungstenite/protocol/struct.WebSocketConfig.html)。

WebSocket 的标准分帧与多个 Binary message 不是同一件事。RFC 6455 §5.4 规定首帧、continuation 和 FIN 的组合，接收端按一个消息重组。NSH 当前 pending 状态则把第一个完整 Binary message 当 payload、第二个完整 Binary message 当 source map；简单把 payload 切片后多次 `send(Binary(chunk))` 会改变协议含义。[RFC 6455 §5.4](https://www.rfc-editor.org/rfc/rfc6455.html#section-5.4)、[axum 0.8.9 Message 源码](https://docs.rs/axum/0.8.9/src/axum/extract/ws.rs.html#772-807)、[NSH 客户端 Binary 消息处理](https://github.com/longbridge/nsh/blob/224d9a795c7ac9d10d75750de9351adac5549675/crates/nsh-dev/src/client.rs#L354-L411)。

## 项目接入与版本取舍

项目已有 `apps/nsh/scripts/prepare-dev-cli.mjs` 为固定提交应用可重现补丁；该入口目前只构建 CLI（命令行工具），不会因此更新已安装宿主内的 `nsh-dev`。客户端容量修复必须进入宿主构建输入，不能只把新客户端代码补进 CLI 缓存后就宣称 App 已修复。

若为合并其他 0.5.1 修复而升级，需要同步 `apps/nsh/scripts/nsh.ts` 的 revision／版本校验、`apps/nsh/Cargo.toml` 中所有 NSH 依赖、锁文件与本地补丁适用性，并重建需要调试的宿主。公开 API 不变降低了应用代码迁移量，但不消除工具链固定版本与自定义补丁的维护成本。本故障本身没有要求升级整套依赖的理由。

修复集中在公共 `nsh-dev`，由它拥有传输容量和失败原因；iOS、Android 等宿主只消费统一的开发事件。无需把接收容量暴露为每个页面或业务模块的配置，也无需新增客户端包装类。

现有 `DevEvent::Disconnected` 不带原因。扩展这一事件的失败信息需要同步修改各宿主的匹配与开发提示，成本在多个平台消费点；用途是保留 `connect`／`read`／`write` 阶段、底层错误及实际／允许字节数，使这次真实发生的容量拒绝不再仅显示“reconnecting”。容量不匹配不能继续按同一包每 100 ms 重试；应显示不可通过重连修复的原因，网络中断保留原有重连语义。沿现有事件链传递即可，不需要另建错误框架。

修改后的验收只需针对本故障：实际普通包首载成功、一次源码修改走 Patch（热更新补丁）、一次断开再连接成功，以及容量拒绝能输出原始错误信息。传输探针已经确认第一项的数据可接收；宿主实际载入与 Patch 仍须在实现后验证。

分帧只改变单帧长度，不会自动改变消息总长限制。当前数据在已有 64 MiB 消息范围内，接收配置和错误链修复足以处理已复现故障；尚无超过消息上限的实际需求来支持引入分块协议或 HTTP 下载状态。
