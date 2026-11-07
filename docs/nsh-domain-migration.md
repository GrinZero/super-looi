# NSH 领域迁移软件验收

2026-11-07。用户确认当前只有模拟器，先完成软件验收。Pi 1.5.0、NSH 0.4.0 的基础版本矩阵见 `nsh-native-live-verification.md`。

## 本阶段实现

家居运行时默认关闭，演示模式需要显式选择。HA 使用 HTTPS 与系统安全存储；不同地址不复用令牌。无法识别设备元数据时只读；服务 ACK 不代表设备已生效。MIoT OAuth 已接入双端原生登录窗口和家居设置；完整原生回调的零请求 fixture 仍待验收。

Agent 家居控制经过单次 UI 审批。下发前在同一个 SQLite 数据库保存 intent，完成后保存领域回执。取消使连接代际失效并中止请求；预读后不能继续派发，已经发出的操作无法确认时保留 unknown。任务列表、取消结果与恢复计数均合并领域 unknown；原会话不得继续，新对话保留旧证据。

底座 `executePulse` 仅记录停止指令；settling 计时不再生成停稳时间或证据 ID。主动观察必须收到本次动作之后、顺序有效且不在未来的停止/停稳/取帧时间和非空字符串证据，否则立即返回停稳未确认，不调用视觉服务，也不继续下一次动作。A04/A05 的正向测试显式注入模拟稳定观测，不能作为真机证明。物理停稳传感器与帧绑定仍待接入。

任务面板提供每页十项的列表和只读详情，展示执行步骤、文件、命令及家居操作证据。新对话更换 session，不删除旧任务。

原生 VoiceAudio 支持显式权限、16kHz PCM 采集、24kHz PCM 播放、有界队列、静音及背压。iOS 原生通知处理后台/中断/路由变化，Android 原生线程检查锁存的失焦状态。重新获得焦点不会恢复旧音频。Android manifest 和 Application 均由 app 自有插件合并；没有修改 Expo prebuild 产物。

## 已执行验证

- 真 QuickJS：家居 fixture、实际 Agent 审批与演示控制、SQLite 回执重开、intent-only 中断边界、unknown 会话阻断、新对话隔离均通过。
- 独立 Sol 复审：取消穿透、领域 unknown、原生生命周期与队列清理问题修复后通过。
- 原生音频七项 Rust 测试及 iOS Simulator / Android ARM64 实际交叉检查通过。
- 双端模拟器兼容探针：新增家居 fixture、系统凭据 CRUD、原生静音 PCM enqueue/clear/stop 均通过。Android 还运行了 Agent 家居证据重开测试；后续统一最终代码再次复验。
- 双端十二套原生探针全部通过；新增语音 fixture 覆盖权限、握手、PCM、打断旧响应、重复工具与迟到连接隔离。
- NSH 17 项测试通过，含七项音频 Rust、六项登录 Rust、两项真实 engine、首页及账号区域作用域界面测试。
- Android manifest 插件测试验证保留既有权限、增量添加录音/音频设置权限、重复合并无重复节点。

全仓 `pnpm build`、`pnpm typecheck`、`pnpm test` 通过：326 项 JavaScript 测试；后续账号区域 UI 修订后 NSH 17 项测试通过。软件通过不等同物理设备验收。

## 米家原生登录浏览器基础

专用 `MiotLoginBrowser` 已注册到 app 自有 native 模块。iOS 使用非持久 WKWebsiteDataStore，先安装回调主机资源阻断规则，再加载登录页；Android 使用独立 Dialog/WebView，关闭文件访问、页面调试、console 输出和混合内容。两端不安装 JS 消息桥，不记录授权 URL，错误只返回固定代码。

Android 插件强制 `usesCleartextTraffic=false`，浏览器启动前还检查回调主机的 NetworkSecurityPolicy；开发与产品包均不依赖 WebView 回调去覆盖 POST 重定向。该限制与当前家居 HTTPS 配置一致。Android CookieStore 是进程共享的，不能称为无持久 cookie。

登录会话限制为单一 owner；回调只消费一次，取消/超时清理未消费 code。原生后台监听在窗口关闭后仍能使 callback/consumed 状态失效，防止 JS 暂停时残留授权继续被消费。产品 token 提交已接入动态 guard：在交换、凭据读写和最终提交边界检查原生 consumed 状态、授权有效期及各层代际；原生 getter 抛错按失效处理。取消已写入的新 token 使用 CAS 从当前加密槽读取最新 envelope，仅回滚本次值，保留后续账号、配置及其他凭据。普通凭据读写仍受代际守卫。

验证：6 项 Rust 登录状态/URL 策略测试、Android 插件增量/幂等测试通过；NSH 共 17 项测试通过。双端模拟器运行 `test:login:ios` / `test:login:android`，验证真实原生窗口展示、无效初始 URL 拒绝、第二个 owner 拒绝、取消及空 callback。探针不使用用户账户、不授权、不读写凭据。此冒烟不证明 OAuth 成功，也不证明全部回调路径零网络请求；GET/POST 307/子资源请求计数 fixture 仍待完成。

产品 UI 支持区域选择、登录、取消、退出、刷新设备及重新连接已保存账号。已保存账号操作仅显示在其所属区域，切换选择不会误退出另一地区账号。首次登录按已发现的连接读取设备状态，不把尚未建立的 healthy 状态当成读取前提。

实际交互验收：iOS 通过 NSH UI 脚本选择新加坡并进入小米官方登录页，再由 CUA 点击原生取消，脚本确认“米家登录已取消”并关闭家居；`ui-miot-ios` 的原生取消步骤需要系统 UI 自动化配合。Android `test:ui:android` 的独立 UiAutomation APK 完成同一流程（返回提示位于滚动区域，先滚动再断言）。两端未输入账户、未同意授权、未写入产品 App 凭据。OAuth 13 项、单槽回滚六类竞态、Flow 与真实 QuickJS fixture 已通过；独立 Sol 复审通过。

## 尚未完成

MIoT 原生回调完整 fixture、BLE 桥及旧数据迁移继续推进。双端家居/任务界面已通过实际输入验收。实时语音协议及共享 Agent 的 UI 确认流程已通过 fixture；取消后只在服务确认取消时恢复输出，无确认则四秒后结束会话，实际服务双端原生测试确认使用 `response.canceled`（单个 l），实现已兼容该事件。双端各接收 247808 字节合成 PCM 并确认取消，未开启麦克风或写入产品凭据；证据见 `artifacts/nsh-node-compat/voice-native-audit.json`。合成语音输入至实际 Agent 查询本机记忆再生成原生 PCM 回复已在双端通过（iOS 55296 字节，Android 75776 字节，各一次工具调用）；产品 UI 确认单独由 fixture 和审查覆盖。真实麦克风与 AEC 效果仍未验收。静音输出验证不代表麦克风、外放 AEC、物理 BLE 或底座验收。Hub/Expo 删除门禁仍未满足。
