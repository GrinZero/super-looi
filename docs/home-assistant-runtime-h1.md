# 本机家居运行时 · H1 实施记录

日期：2026-11-06

研究路线见 [本机控制中心调研](home-assistant-mobile-runtime-research.md)。H1 已完成：`packages/home-assistant` 提供 `@super-looi/home-assistant`，Hub 家居请求和语音工具已使用该共享实现。Mobile 已声明工作区依赖并验证源码入口，后续在 H3 接入本机家居页面。

## 实现

- `core/`：迁入 `HomeAssistantGateway`、`HomeRulesEngine`、`HOME_VOICE_TOOLS` 和 `executeHomeVoiceTool`；语音工具采用独立的 `HomeVoiceToolDefinition`，不再引用 Hub 的豆包实现。
- `transports/`：提供仿真传输、标准 fetch REST 传输及标准 WebSocket 注册表读取。注册表保留集成筛选、房间与设备关联、敏感设备控制限制。
- `types.ts`：导出 `HaTransportAdapter` 与可注入的注册表 Socket 接口。
- Node 的深比较改为 JSON 值递归比较，Node 延时改为标准定时器；REST 使用 `AbortController` 与清理定时器，覆盖请求及响应体读取的超时。
- Hub 的原模块路径保留薄兼容导出；Fastify 路由、环境变量和发现配置继续由 Hub 管理。Hub 注入 `ws` Socket，保留握手超时、禁止重定向与超时终止策略。
- 包提供 `react-native` 源码字段和条件导出。编译配置为 `ES2022 + DOM`、`types: []`，不引入 Node 全局类型或 Node 专属运行时模块。

网关的高危域、白名单、参数边界、禁止 toggle、新鲜 No-op、真实回读与禁止重放逻辑沿用迁移前实现。服务调用成功仍须经过状态回读，才会产生 `verified / applied`。

## 验证

本阶段执行以下命令，均退出 0：

```sh
pnpm install --frozen-lockfile --offline --ignore-scripts
pnpm build
pnpm typecheck
pnpm test
```

- 全仓共 246 项测试通过（contracts 5、looi-driver 11、home-assistant 14、mobile 127、hub 89）。
- 共享包 14 项测试通过：原有网关与规则测试迁入包内，并增加无 Node 全局环境的公开 API 加载、语音查询与控制闭环、注册表失败清理、REST 请求与响应体超时取消测试。
- Hub 验证包含原有家居接口、集成 / 设备 / 房间的注册表筛选逻辑、千实体批量读取以及 48 项核心验收运行器；另用本地真实 WebSocket 服务验证标准全局 WebSocket 的认证与注册表读取。
- Mobile Metro 用例覆盖 iOS / Android，分别启用及禁用 package exports；均解析到 `src/index.ts` 和包内相对 TypeScript 模块。
- 子 agent 独立 review 完成，无可确认的功能或安全回归；提出的真实条件导出测试建议已落实并复核。

## 后续边界

H2 将加入米家 OAuth、凭据生命周期、MIoT 规格映射与云端直连适配器；H3 再接移动端登录与连接模式；H4 接本机记忆和语音。待办继续在 [todo.md](../todo.md) 跟踪。

本阶段的跨平台证据来自无 Node 类型编译、隔离运行环境和 Metro 解析；iOS / Android 模拟器、真机以及真实设备物理控制验收仍需在接入阶段完成。当前 Expo 提供标准 WHATWG URL、fetch、AbortController 和 WebSocket；其他宿主需提供相同网络 API。性能和内存数字尚未实测。
