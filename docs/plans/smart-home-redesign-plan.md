# 智能家居空间重构方案：`@super-looi/home-devices` 领域包、可自定义 Bento 网格与多源服务解耦

## 1. 现状诊断

当前智能家居页面（[`apps/nsh/ui/HomeSpaceView.tsx`](../../apps/nsh/ui/HomeSpaceView.tsx) 与 [`apps/nsh/ui/ManagementShell.tsx`](../../apps/nsh/ui/ManagementShell.tsx)）及底层 [`@super-looi/home-assistant`](../../packages/home-assistant) 存在四个核心设计缺陷：

1. **「日常设备管理」与「低频服务登录」强行塞在同一页面**：
   - 顶栏直接把 `米家直连`、`Home Assistant`、`离线演示` 三个登录配置入口当作一级导航；页面左栏常驻登录表单与 Token 输入框，高频使用的设备列表被挤压在右栏。
2. **单一数据源互斥，无法同时挂载多服务**：
   - [`HomeRuntime`](../../apps/nsh/runtime/home.ts) 仅维护单一 `mode`（`disabled | simulation | external_ha | direct_miot`）。连接 Home Assistant 会断开米家直连，无法将多源设备汇总到同一全屋面板。
3. **仅支持灯具/风扇/单路开关，复杂家电爆炸成数百条原始工程实体**：
   - 以仓库内真实家庭快照（[`data/home-assistant/.storage/`](../../data/home-assistant/.storage/)「源心锁的家」，4 个区域、31 台物理设备）为例，HA 底层共有 **600+ 个原始 `entity_id`**（仅大厅空调就有 92 个实体、扫地机器人 73 个、电饭煲 43 个、微烤一体机 28 个、天台洗衣机 20+ 个）。
   - 现有 `ha-entity-policy.ts` 与 `miot-entity-mapper.ts` 仅允许 `light`/`fan`/`switch` 控制，导致监控摄像头、电饭煲、洗衣机、洗碗机、空调、三键开关、宠物喂食器等真实复杂设备无法聚合与操控。
4. **缺乏房间第一层级、卡片尺寸自定义与渐进式信息披露**：
   - 缺少房间级环境指标（温度/湿度/CO₂/有人状态）聚合；
   - 等大 `1×1` 网格无法兼顾监控摄像头的 16:9 画面与电饭煲的多工序倒计时展示；同时需要严格控制卡片表面文字密度，遵循渐进式披露（Progressive Disclosure）。

---

## 2. 模块边界与复杂度成本论证（遵循 `AGENTS.md` 第 12 & 15 条 `codebase-design`）

### 2.1 新增独立包 `@super-looi/home-devices`（`packages/home-devices`）的必要性与边界

- **具体用途与收益**：
  1. **深模块信息隐藏（Deep Module）**：将 600+ 个碎片化 HA / MIoT 原始实体（`sensor.*`、`select.*`、`button.*`、`number.*`、`climate.*`、`event.*`）按物理设备归并为结构化的 `HomeAppliance` 领域模型，屏蔽不同协议（HA WebSocket/REST vs 米家 MIoT Spec）的命名与属性差异。
  2. **房间净化与环境指标聚合**：自动剥离同步产生的冗余家庭前缀（如将 `"源心锁的家 大厅"` 净化为家庭 `"源心锁的家"` + 房间 `"大厅"`），并将房间内的温湿度计、空气检测器、人在传感器提炼为房间抬头指标（`RoomEnvironmentSummary`）。
  3. **6 大设备原型 + 10 类领域能力组件 + 多尺寸 Bento 布局持久化**：统一管理卡片的默认尺寸（监控 `2×2`、电饭煲/空调 `2×1`、开关/插座/喂食器 `1×1`）与用户自定义尺寸/顺序配置（`HomeLayoutPreferences`）。
  4. **真实家庭快照驱动测试**：直接挂载 `data/home-assistant/.storage/` 下的 31 台真实设备进行确定性单元测试。
- **复杂度成本控制**：
  - 零第三方外部依赖，仅依赖 `@super-looi/contracts` 与 `@super-looi/home-assistant` 类型契约；在 `apps/nsh/scripts/build-runtime.ts` 中通过源码别名直接打入运行时 bundle。

### 2.2 6 大设备原型（Appliance Archetypes）与三档 Bento 尺寸（`1×1` / `2×1` / `2×2`）

| 原型标识 (`ApplianceArchetype`) | 覆盖的真实设备品类 | 默认尺寸 (`TileSpan`) | 卡片表面核心信息（严格减字降噪） | 二级详情面板（Inspector）完整能力 |
| :--- | :--- | :--- | :--- | :--- |
| **`vision_security`**<br>视觉监控与安防 | 大厅监控、卧室小鸟摄像头、天台摄像头、智能门铃 3、天台门锁 | **`2×2 大`**（摄像头）<br>`1×1`（门铃/门锁） | 摄像头：16:9 画面视窗 + 单行状态（`在线 · 3m前移动`）+ `实时画面` / `休眠` 2 个主按钮；门锁严格只读 | 8 向云台控制、巡航/移动侦测/遮蔽开关、SD 卡状态、离散安防事件时间轴 |
| **`cycle_appliance`**<br>周期厨电与洗护 | 电饭煲、微烤一体机、天台洗衣机、洗碗机、扫地机器人 | **`2×1 宽`**（电饭煲/洗衣机）<br>`1×1`（非活跃态可选） | 左区大字倒计时 `18:24`；右区当前工序胶囊（如 `沸腾中` / `洗涤中`）+ `开始` / `取消` 主按钮 | 五段完整工序条（`浸泡→升温→沸腾→焖饭→保温`）、模式选择（精煮/快煮/煮粥/煲汤）、锅内温度、童锁与耗材寿命 |
| **`climate`**<br>暖通与双温闭环 | 大厅空调、卧室新风、除湿机 22L、电热水瓶 5L、电热毯 | **`2×1 宽`**（主空调）<br>`1×1`（其余温控） | 头部显示实测温度（`室温 27.4°C`），中部 `[-] 26.0°C [+]` 步进器 + `制冷/除湿/自动` 3 个核心胶囊 | 完整模式矩阵、1~7 档风速滑杆、上下/左右扫风、电辅热、睡眠模式、滤网寿命 |
| **`lighting_power`**<br>照明与多路电工 | 调光台灯、主卧三键开关、带功率计量的智能插座 | **`1×1 紧凑`** | 三键开关：单卡并排 `[左键] [中键] [右键]` 独立点按；插座：开关 + 单一功率读数 `42W`；台灯：开关 + 亮度条 | 完整亮度/色温调节、今日累计耗电量 `kWh`、设备温度、延时关灯设置 |
| **`media`**<br>影音与语音终端 | 客厅 Redmi 电视 X 55"、小爱音箱 Pro、小爱触屏音箱 | **`1×1 紧凑`** | 播放/待机状态 + 电源/静音快捷按钮 | 遥控方向键（首页/菜单/返回/左右）、音量滑杆、唤醒/播报动作 |
| **`sensor_pet`**<br>宠物看护与传感 | 宠物喂食器 2、宠物饮水机、空气检测器 6合1、人在传感器、路由器 | **`1×1 紧凑`** | 喂食器：`今日 45g` + `[立即出粮]`；传感器：核心 1~2 项指标读数 | 余粮/缺水状态、滤芯/干燥剂寿命、6 合 1 全量空气指标（PM2.5/CO₂/TVOC/甲醛） |

### 2.3 信息密度控制准则（Progressive Disclosure）

1. **左栏房间导航列（`房间与区域`）**：每个房间卡片最多两行文字——第一行「房间名 + 开启数徽标」，第二行最多展示 1~2 个核心环境指标（如 `26.8°C · 58%`），不堆砌长文本。
2. **卡片表面「三不写」**：
   - **非编辑态不显示尺寸标签**：`[1×1 | 2×1 | 2×2]` 胶囊与排序箭头仅在用户开启顶栏「调整布局」模式时浮现。
   - **不显示冗余协议后缀与诊断长文**：卡片副标题限 1~2 个短词（`<= 12` 字符，如 `精煮中 · 96°C` 或 `制冷 · 室温 27.4°C`）。
   - **单卡表面最多 1 组主交互控件**：其余低频模式、扫风、辅热、五段工序全链路、安防事件历史统一收进点击卡片弹出的二级详情面板（Inspector Dialog）。

---

## 3. 实施步骤与验证计划

- [ ] **Step 1：创建 `@super-looi/home-devices`（`packages/home-devices`）并验证 31 台真实设备聚合**
  - 实现房间名称净化（`room-normalizer.ts`）、物理设备归并与 6 大原型识别（`device-aggregator.ts`）、多尺寸 Bento 布局持久化模型（`layout-store.ts`）与指令映射器（`command-mapper.ts`）。
  - 编写单元测试 `packages/home-devices/test/real-home-aggregation.test.ts`，直接读取 `data/home-assistant/.storage/` 验证「源心锁的家」31 台真实设备的房间归属、原型识别与控制能力槽位。
- [ ] **Step 2：升级 `@super-looi/home-assistant` 与 `HomeRuntime` 支持多源并发与全品类控制**
  - 扩展 `ha-entity-policy.ts` 与 `miot-entity-mapper.ts`，支持 `climate`、`humidifier`、`fan`、`media_player`、`vacuum`、`button`、`select`、`number`、`notify`、`camera` 等域的状态归一与安全动作调用（保留 `lock` 等高危解锁动作为只读）。
  - 升级 `apps/nsh/runtime/home.ts` 支持 `direct_miot`、`external_ha`、`simulation` 多源同时在线与聚合路由，并将离线演示升级为包含「大厅监控、电饭煲、天台洗衣机、大厅空调、主卧三键开关、宠物喂食器、书房吸顶灯」的完整多房间演示集。
- [ ] **Step 3：贯通 `MobileRuntime`、`store.ts`、Bento 布局持久化与双语词条**
  - 在 `MobileRuntime` 与 `store.ts` 暴露多源配置、设备动作执行（`controlHomeAppliance`）以及 Bento 卡片尺寸/顺序持久化（`home.layout.v1`）。
- [ ] **Step 4：重构 `ManagementShell.tsx` 与 `HomeSpaceView.tsx`（「我的设备」Bento 看板 + 二级详情面板 +「服务绑定」）**
  - 顶栏二级胶囊切换 `我的设备` 与 `服务绑定`；
  - 「我的设备」落地左栏房间导航 + 右栏多尺寸响应式 Bento 网格（`1×1` / `2×1` / `2×2`）+「调整布局」模式 + 二级设备详情控制浮层；
  - 「服务绑定」落地米家直连、Home Assistant、离线演示三张独立服务绑定卡。
- [ ] **Step 5：全量测试、魅族 20 Pro 真机安装验证、架构图更新与子 Agent 独立 Review**
  - 运行 `pnpm typecheck`、`pnpm test`、Rust `app_ui` Headless 测试；
  - 更新 `docs/arch/index.html` 反映新增 `@super-looi/home-devices` 包；
  - 构建并安装至魅族 20 Pro 真机核验；调度独立子 Agent 完成代码与 UI 审查。
