// Shared by the browser and build-sources.mjs; no browser-only APIs here.
globalThis.LOOI_ARCH = {
  width: 1040,
  height: 800,
  views: [
    { id: "all", label: "架构总览", description: "手机本地运行 Agent，直接连接模型、语音与家居服务。", nodes: [] },
    { id: "agent", label: "任务执行", description: "文字从界面进入共享任务入口，Pi 执行工具并将结果写回界面。", nodes: ["app", "store", "runtime", "agent", "models", "compat", "native", "contracts"] },
    { id: "voice", label: "实时语音", description: "VoiceRuntime 直连豆包；语音工具通过 store.requestTask 进入同一个 Agent。", nodes: ["app", "store", "runtime", "agent", "models", "voice", "audio", "doubao", "native"] },
    { id: "home", label: "家居控制", description: "管理界面与 Agent 家居工具共用 HomeRuntime，经网关访问 HA 或 MIoT。", nodes: ["app", "store", "runtime", "agent", "home", "gateway", "services", "contracts"] },
  ],
  nodes: [
    {
      id: "app", x: 28, y: 86, title: "应用界面", symbol: "window", category: "TSX · 交互入口", detail: "大脸舞台 / 四个管理空间", path: "apps/nsh/App.tsx",
      description: "App 创建响应式 store，在桌宠舞台与模型、语音、家居、任务管理空间之间切换。mount(App) 是界面启动入口。",
      files: [
        { path: "apps/nsh/App.tsx", entry: "function App()", anchors: [{ label: "组件入口", match: "function App()" }, { label: "挂载应用", match: "mount(App)" }] },
        { path: "apps/nsh/ui/ManagementShell.tsx", entry: "export function ManagementShell" },
        { path: "apps/nsh/ui/RobotFace.tsx", entry: "export function RobotFace" },
      ],
    },
    {
      id: "runtime", x: 280, y: 86, title: "MobileRuntime", symbol: "layers", category: "TypeScript · 本机业务", detail: "会话 / 任务 / 模型 / 家居工具", path: "apps/nsh/runtime/application.ts",
      description: "本机业务入口，维护任务与会话，创建 Pi 执行器、模型目录和 HomeRuntime。任务保存在 SQLite 中，家居能力通过 additionalTools 注入。",
      files: [
        { path: "apps/nsh/runtime/application.ts", entry: "export class MobileRuntime", anchors: [{ label: "运行时入口", match: "export class MobileRuntime" }, { label: "创建执行器", match: "private createExecutorForSelection(" }, { label: "家居工具", match: "private homeTools()" }] },
        { path: "packages/looi-runtime/src/agent/task-store.ts", entry: "export class AgentTaskStore" },
        { path: "packages/looi-runtime/src/storage/sqlite.ts", entry: "export class SqliteRuntimeStore" },
      ],
    },
    {
      id: "agent", x: 535, y: 86, title: "Pi Agent Loop", symbol: "spark", category: "TypeScript · 任务执行", detail: "模型推理 / 文件 / Shell / 问答", path: "packages/looi-runtime/src/agent/pi-executor.ts",
      description: "PiAgentExecutor 封装 pi-agent-core 的 Agent。执行读写文件、Shell、用户问答及家居工具，把步骤事件和最终结果交回 MobileRuntime。",
      files: [
        { path: "packages/looi-runtime/src/agent/pi-executor.ts", entry: "export class PiAgentExecutor", anchors: [{ label: "执行器入口", match: "export class PiAgentExecutor" }, { label: "创建 Agent", match: "new Agent(" }] },
        { path: "packages/looi-runtime/src/agent/executor.ts", entry: "export interface AgentExecutor" },
      ],
    },
    {
      id: "models", x: 790, y: 86, title: "模型服务", symbol: "cloud", category: "外部服务 · HTTPS", detail: "OpenAI / Kimi / MiniMax 等", path: "packages/looi-runtime/src/agent/llm-providers.ts", external: true,
      description: "手机通过 pi-ai 直接访问模型服务。仓库中的接入入口是 Provider 目录与 Models 注册表，支持 API Key、OAuth 以及自定义兼容 API。",
      files: [
        { path: "packages/looi-runtime/src/agent/llm-providers.ts", entry: "export const LLM_PROVIDER_CATALOG", anchors: [{ label: "服务目录", match: "export const LLM_PROVIDER_CATALOG" }, { label: "注册模型", match: "export function createLooiModelsRegistry" }, { label: "凭据适配", match: "export class VaultCredentialStore" }] },
        { path: "apps/nsh/ui/ModelsSpaceView.tsx", entry: "export function ModelsSpaceView" },
      ],
    },
    {
      id: "store", x: 28, y: 274, title: "响应式应用状态", symbol: "sliders", category: "TypeScript · 状态编排", detail: "signal / 生命周期 / 运行时接线", path: "apps/nsh/store.ts",
      description: "createAppStore 把原生宿主、MobileRuntime、VoiceRuntime 和界面接在一起。语音 requestTask 通过 api.send 复用文字任务链路，状态变更驱动表情与字幕。",
      files: [
        { path: "apps/nsh/store.ts", entry: "export function createAppStore", anchors: [{ label: "状态入口", match: "export function createAppStore" }, { label: "原生接线", match: "const opened = await openRuntime" }, { label: "语音转任务", match: "requestTask: async" }] },
      ],
    },
    {
      id: "voice", x: 280, y: 274, title: "VoiceRuntime", symbol: "wave", category: "TypeScript · 实时语音", detail: "PCM 音频 / 字幕 / 工具调用", path: "apps/nsh/runtime/voice.ts",
      description: "建立豆包 Duplex 会话，收发 PCM 音频、更新字幕，并处理语音工具调用。音频交给 VoiceAudio；需要执行任务时调用注入的 requestTask。",
      files: [
        { path: "apps/nsh/runtime/voice.ts", entry: "export class VoiceRuntime", anchors: [{ label: "语音入口", match: "export class VoiceRuntime" }, { label: "建立会话", match: "async start():" }, { label: "工具分发", match: "private tool(" }] },
        { path: "apps/nsh/ui/VoiceSpaceView.tsx", entry: "export function VoiceSpaceView" },
      ],
    },
    {
      id: "audio", x: 535, y: 274, title: "原生音频", symbol: "mic", category: "Rust · iOS / Android", detail: "麦克风采集 / PCM 播放 / 静音", path: "apps/nsh/src/audio.rs",
      description: "VoiceAudio 是暴露给 JavaScript 的 Rust 原生类，管理麦克风权限、采集队列与播放队列。iOS 和 Android 各有平台音频实现。",
      files: [
        { path: "apps/nsh/src/audio.rs", entry: "pub struct VoiceAudio", anchors: [{ label: "原生类", match: "pub struct VoiceAudio" }, { label: "采集入口", match: "pub fn start(" }, { label: "播放入口", match: "pub fn enqueue(" }] },
        { path: "apps/nsh/src/audio/ios.rs", entry: "pub struct Audio" },
        { path: "apps/nsh/src/audio/android.rs", entry: "pub struct Audio" },
      ],
    },
    {
      id: "doubao", x: 790, y: 274, title: "豆包 Realtime", symbol: "wave", category: "外部服务 · WebSocket", detail: "Duplex V3 / 流式语音 / 转写", path: "apps/nsh/runtime/voice.ts", external: true,
      description: "实时语音服务的本仓库接入源码位于 voice.ts：WebSocket endpoint、会话配置、收发循环与音频事件处理都在这里。",
      files: [{ path: "apps/nsh/runtime/voice.ts", entry: "const endpoint =", anchors: [{ label: "服务地址", match: "const endpoint =" }, { label: "连接会话", match: "async start():" }, { label: "接收事件", match: "private async read(" }] }],
    },
    {
      id: "face", x: 28, y: 462, title: "表情与陪伴", symbol: "eyes", category: "TypeScript · 界面反馈", detail: "情绪 / 眨眼 / 视线 / 音量响应", path: "packages/looi-runtime/src/ui/robot-face-controller.ts",
      description: "RobotFaceController 管理表情、眨眼与音频驱动状态，store 将这些状态传给 RobotFace 绘制。它控制屏幕表情，身体动作由独立驱动包定义。",
      files: [
        { path: "packages/looi-runtime/src/ui/robot-face-controller.ts", entry: "export class RobotFaceController" },
        { path: "apps/nsh/ui/RobotFace.tsx", entry: "export function RobotFace" },
        { path: "apps/nsh/theme.json", entry: '"light"' },
      ],
    },
    {
      id: "home", x: 280, y: 462, title: "HomeRuntime", symbol: "home", category: "TypeScript · 家居业务", detail: "连接配置 / 米家登录 / 设备操作", path: "apps/nsh/runtime/home.ts",
      description: "在 disabled、simulation、external_ha 与 direct_miot 模式间配置家居连接。封装米家 OAuth、设备发现、网关访问及操作结果回读。",
      files: [
        { path: "apps/nsh/runtime/home.ts", entry: "export class HomeRuntime" },
        { path: "apps/nsh/runtime/miot-login.ts", entry: "export class MiotLoginFlow" },
        { path: "apps/nsh/ui/HomeSpaceView.tsx", entry: "export function HomeSpaceView" },
      ],
    },
    {
      id: "gateway", x: 535, y: 462, title: "家居网关与传输", symbol: "network", category: "TypeScript · 协议适配", detail: "HA REST / MIoT / 状态回读", path: "packages/home-assistant/src/core/gateway.ts",
      description: "HomeAssistantGateway 提供统一的设备控制与状态读取接口。传输适配器分别调用 Home Assistant REST 和小米 MIoT，仿真模式使用内存传输。",
      files: [
        { path: "packages/home-assistant/src/core/gateway.ts", entry: "export class HomeAssistantGateway" },
        { path: "packages/home-assistant/src/transports/ha-rest-transport.ts", entry: "export class HomeAssistantRestTransport" },
        { path: "packages/home-assistant/src/transports/direct-miot-transport.ts", entry: "export class DirectMiotTransportAdapter" },
      ],
    },
    {
      id: "services", x: 790, y: 462, title: "家居服务与设备", symbol: "plug", category: "外部连接 · HTTP(S)", detail: "Home Assistant / 小米 MIoT", path: "packages/home-assistant/src/transports/ha-rest-transport.ts", external: true,
      description: "external_ha 访问配置的 Home Assistant 实例；direct_miot 直连小米云 API。点击下方文件可直接查看各协议的请求实现。",
      files: [
        { path: "packages/home-assistant/src/transports/ha-rest-transport.ts", entry: "export class HomeAssistantRestTransport" },
        { path: "packages/home-assistant/src/miot/miot-http-client.ts", entry: "export class MiotHttpClient" },
        { path: "packages/home-assistant/src/auth/miot-oauth.ts", entry: "export class MiotOAuthClient" },
      ],
    },
    {
      id: "native", x: 28, y: 676, compact: true, title: "NSH 原生宿主", symbol: "chip", category: "Rust · 原生模块注册", detail: "src/lib.rs", path: "apps/nsh/src/lib.rs",
      description: "原生模块注册入口 super-looi/native。向 TSX 暴露 NodeCompat、CredentialVault、VoiceAudio 与 MiotLoginBrowser，供 store 完成接线。",
      files: [
        { path: "apps/nsh/src/lib.rs", entry: 'fn native(' },
        { path: "apps/nsh/src/credentials.rs", entry: "pub struct CredentialVault" },
        { path: "apps/nsh/src/login_browser.rs", entry: "pub struct MiotLoginBrowser" },
      ],
    },
    {
      id: "compat", x: 280, y: 676, compact: true, title: "Node 兼容层", symbol: "braces", category: "TypeScript + Rust", detail: "fs / SQLite / Shell / 构建适配", path: "packages/nsh-node-compat/src/native-host.ts",
      description: "构建时替换 Node 模块，运行时安装 __nsh_compat 等桥接函数。NodeCompat 将 JavaScript 请求交给 Rust Bridge，执行本机文件、SQLite 与 Shell 操作。",
      files: [
        { path: "packages/nsh-node-compat/src/native-host.ts", entry: "export function installNshNativeCompat" },
        { path: "apps/nsh/src/compat.rs", entry: "pub struct NodeCompat" },
        { path: "packages/nsh-node-compat/rust/src/bridge.rs", entry: "pub struct Bridge" },
        { path: "apps/nsh/scripts/build-runtime.ts", entry: "export async function buildRuntime" },
      ],
    },
    {
      id: "contracts", x: 535, y: 676, compact: true, title: "共享契约", symbol: "file", category: "TypeScript · 跨包类型", detail: "动作 / 任务 / 家居 / 身体协议", path: "packages/contracts/src/index.ts",
      description: "跨包共享的类型与协议定义。Agent 任务、家居命令与动作回执、LOOI 身体动作及状态机都使用这些契约表达数据。",
      files: [{ path: "packages/contracts/src/index.ts", entry: "export type Id", anchors: [{ label: "类型定义", match: "export type Id" }, { label: "动作回执", match: "export interface ActionReceipt" }] }],
    },
    {
      id: "body", x: 790, y: 676, compact: true, title: "LOOI 身体驱动", symbol: "eyes", category: "TypeScript · 原生 BLE 待接入", detail: "身体状态机 / BLE 传输协议", path: "packages/looi-driver/src/body-supervisor.ts", planned: true,
      description: "已保留 BodySupervisor、BLE 协议和跨平台传输接口。当前 apps/nsh 尚未接入原生 BLE，驱动包没有连入上方运行链路。",
      files: [
        { path: "packages/looi-driver/src/body-supervisor.ts", entry: "export class BodySupervisor" },
        { path: "packages/looi-driver/src/transport.ts", entry: "export interface NativeBleAdapter" },
        { path: "packages/looi-driver/src/constants.ts", entry: "export const LOOI_SERVICE_UUID" },
      ],
    },
  ],
  // Points are authored in viewBox coordinates. Arrows describe calls/data flow,
  // not package imports; shared foundations are grouped separately below.
  edges: [
    { from: "app", to: "store", d: "M130 202 V274", label: "创建 store", x: 165, y: 240 },
    { from: "store", to: "runtime", d: "M232 306 H256 V144 H280", label: "send / 订阅", x: 256, y: 225, vertical: true },
    { from: "runtime", to: "agent", d: "M484 144 H535", label: "run", x: 510, y: 129 },
    { from: "agent", to: "models", d: "M739 144 H790", label: "HTTPS", x: 764, y: 129 },
    { from: "store", to: "voice", d: "M232 350 H280", label: "接线", x: 256, y: 374 },
    { from: "voice", to: "store", d: "M280 300 H232", label: "任务", x: 256, y: 290 },
    { from: "voice", to: "audio", d: "M484 332 H535", label: "PCM ↔", x: 510, y: 317 },
    { from: "voice", to: "doubao", d: "M382 390 V419 H892 V390", label: "WebSocket · PCM / 转写 / 工具", x: 645, y: 419 },
    { from: "store", to: "face", d: "M130 390 V462", label: "状态驱动", x: 165, y: 430 },
    { from: "runtime", to: "home", d: "M306 202 V246 H269 V438 H306 V462", label: "homeTools", x: 313, y: 446 },
    { from: "home", to: "gateway", d: "M484 520 H535", label: "控制", x: 510, y: 505 },
    { from: "gateway", to: "services", d: "M739 520 H790", label: "HTTP(S)", x: 765, y: 505 },
  ],
};
