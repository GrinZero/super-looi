# 智能家居侧栏折叠修复、全屋设备能力收敛与横屏详情重构计划

## 1. 背景与根因诊断

基于 `iPhone 16e` 横屏（`844×390pt`）实机模拟器与 44 台真实米家设备规格（`miot-spec-v2` + MISS/CS2 社区协议）核查，当前家居空间存在三类核心问题：

1. **左侧房间栏收缩后布局崩坏（`apps/nsh/ui/HomeSpaceView.tsx`）**
   - **Bento 网格右侧整列空洞**：展开侧栏（`196pt`）时可用画布约 `430pt`，`gridColumns() = 2`，`大厅` 前排设备 `[监控(2x2), 扫地机(2x1), 微烤一体机(2x1), 电饭煲(2x1), 电热水瓶(2x1)]` 占满 2 列无空洞；收缩侧栏至 `56pt` 后可用画布增至约 `570pt`，`gridColumns() = 3`。由于网格使用 `gridAutoFlow: "row"`（稀疏行优先放置），`监控(2x2)` 占据 `col 1..2, row 1..2`，紧随其后的四台 `2x1` 设备无法放入 `col 3`，直接折行到 `row 3..6` 的 `col 1..2`，导致 **`col 3` 在前 6 行完全留白**，后续 `1x1` 卡片无法回填。
   - **收缩侧栏底部裁切与活动卡片边框过重**：`390pt` 横屏高度下，收缩侧栏 `w-11 h-11` 按钮加间距使第 5 个房间（`杂物`）在底部被半截裁切；活动态 Bento 卡片使用 `border-ring`（浅色模式下为 `#171717` 纯黑边），视觉割裂。

2. **大厅监控云台旋转与多品类米家能力缺失**
   - **云台旋转协议归属**：`[大厅] 监控`（`chuangmi.camera.039a01`）在 `miot-spec-v2` 中仅有 `s2 camera-control`、`s9 cruise`、`s10 camera-fav-area`，**不含 MIoT `ptz-camera` 服务**；其四向旋转通过原生加密 MISS/CS2 TCP 通道发送命令 `0x1001`、媒体载荷头 `0x112`（BE u32）加紧凑 JSON `{"operation": 1|2|3|4}`（左 1、右 2、上 3、下 4）执行。
   - **只写属性与带参动作在映射层被丢弃**：`miot-entity-mapper.ts` 跳过所有 `!rawProperty.readable` 属性，并丢弃 `in=[...]` 无默认值的动作，导致：
     - 电饭煲 `chunmi.cooker.cmwy4`：`s2.p5 cook-mode`（只写）与 `s2.a1 start-cook`（`in=[5]`）丢失；
     - 电热水瓶 `xiaomi.kettle.mek01`：`s2.a1 start-cook`（`in=[17,5,7,8,10,12,13,14]`）丢失；
     - 宠物喂食器 2 `xiaomi.feeder.pi2001`：`s2.a1 pet-food-out`（`in=[8]`）丢失，且 `s3 indicator-light` 的 `Mode (Off/On)` 被误识别为主工作模式（`工作模式: 关闭/开启`），`target-feeding-measure` 被标为泛化文案 `数值调节`；
     - 宠物饮水机 `xiaomi.pet_waterer.002`：只写属性 `mode`（感应/间歇）、`out-water-interval`、`out-water`、`no-disturb`、`physical-controls-locked` 丢失；
     - 洗衣机 `midjd8.washer.44`：`start-shake-disperse`（清新抖散）丢失。
   - **英文枚举值与泛化命名**：摄像头 `All Record / Motion Record / No Record`、`Panoramic Cruise / Fixed Point Cruise`，台灯 `Computer / Warmth / Leisure / Office / Reading`，洗碗机、洗衣机、电热毯等枚举选项未收敛为中文语义标签。

3. **详情页横屏利用率低**
   - 详情页大量采用单列全宽堆叠（约 `680pt` 宽一栏到底），简单开关或双项选择占满整行；超过 6 个模式的周期家电退化为单一下拉框，未利用横屏双栏主次分区。

---

## 2. 模块边界与设计取舍（Deep-Module 设计审视）

1. **Bento 二维紧凑排布：纯函数 `packBentoTiles(items, columns)` vs CSS `grid-auto-flow: row dense`**
   - **取舍**：在 `@super-looi/home-devices` 的 `layout-store.ts` 实现纯二维网格占用表（2D occupancy bitmap）算法 `packBentoTiles`，返回每张卡片显式的 `{ colStart, colSpan, rowStart, rowSpan }`，由 `HomeSpaceView.tsx` 绑定 `gridColumn` / `gridRow`。
   - **复杂度与收益**：约 45 行纯函数，零外部依赖；规避不同 WebView / 原生布局引擎对 `dense` + 跨行列高度计算的差异，保证 `1x1` 卡片确定性回填 `2x2` / `2x1` 右侧空列，且可在 Node 单测直接对 `大厅` 2→3 列切换做零空洞不变量断言。

2. **云台控制通道：复用 `apps/nsh/src/camera/` 现有加密会话 vs 独立每次新建连接**
   - **取舍**：在 `apps/nsh/src/camera/transport.rs` 抽出轻量可克隆句柄 `CommandHandle`（持有 `mpsc::Sender<Outgoing>`、原子序号 `Arc<AtomicU16>` 与 `32B` 会话密钥），`Session` 保存当前活动预览的 `CommandHandle`。当用户在监控详情页边看实时画面边点按四向云台时，`XiaomiCameraHost::pan_tilt(did, direction)` 直接复用当前 TCP 会话发送 `0x112` 帧，**不断流、不重握手**；仅当未开启预览时才以 `start_video = false` 短连发送单步指令并在 `450ms` 步进保护后关闭。
   - **复杂度与收益**：不新增 crate 或线程模型，复用现有 `Miss` 读写协程与 `AtomicBool` 节流锁，避免云台连点打断视频解码。

3. **MIoT 只写属性与带参动作收敛：传输层状态缓存拼装 vs 暴露底层 `piid` 给 UI**
   - **取舍**：UI 层保持面向领域能力的窄接口（`select_option`、`set_number`、`button.press`），不在前端拼装 `miot-spec` 参数数组。在 `@super-looi/home-assistant` 内部：
     - `miot-entity-mapper.ts` 仅放行白名单内的用户控制类只写属性（如 `cook-mode`、`mode`、`feeding-measure`、`out-water-interval`、`out-water`、`no-disturb`、`physical-controls-locked` 等），标记 `attributes.write_only = true`；
     - `direct-miot-transport.ts` 维护 `(did, siid, piid)` 最近读取与写入值缓存，跳过对 `write_only` 属性的 `get_properties` 轮询，并在执行 `callAction` 时按 `actionSpec.in` 顺序自动从缓存/可读属性/范围默认值拼装参数；
     - `gateway.ts` 对 `write_only` 实体的写操作采用 `action_accepted_no_state_criterion` 判定，避免因设备不支持回读而误报超时。

4. **横屏详情页布局架构：按品类主次分栏，严格沿用 Super-LOOI 暖石色扁平设计体系**
   - 保持 `DESIGN.md` 与 `theme.json` 语义 Token（`bg-background`、`bg-card`、`bg-secondary`、`border-border` `1px` 细边、`>= 44×44pt` 触控热区、`>= 12pt` 字号），参考米家 App 的功能组织而非照搬其高饱和渐变视觉：
     - **监控详情页**：左栏 16:9 实时画面 + 画面辅助开关胶囊；右栏（`supportsPtz` 时）圆形四向云台控制盘 + 夜视/录制/灵敏度分段设置与存储卡状态。
     - **宠物喂食器 / 饮水机**：左栏主状态与手动出粮（今日进食克数/余粮状态、单次份数步进 +「立即出粮」主按钮、称重校准）；右栏耗材寿命进度与重置 + 设备辅助设置（面板指示灯、童锁、勿扰等）。
     - **电热水瓶 & 周期家电（电饭煲、微烤、洗衣机、洗碗机）**：左栏温度/工序英雄卡 + 启动/暂停/停止控制栏；右栏可视化程序矩阵（优先直显核心程序网格，超长模式如洗衣机 26 种程序提供内联展开选择）+ 双列紧凑参数卡。
     - **照明 / 温控 / 多键开关 / 插座 / 通用家电**：横屏宽视口下采用左右均衡双栏检视面板（左栏主控：调光调色温 / 温控步进 / 多路开关通道；右栏情景模式网格、风速摆风、辅助开关与遥测指标网格），消除单控件横跨全屏的空旷感。

---

## 3. 实施步骤

1. **`@super-looi/home-assistant` 能力收敛与单测**
   - 扩展 `miot-spec-resolver.ts`、`miot-entity-mapper.ts`、`direct-miot-transport.ts`、`core/gateway.ts` 支持受控 `write_only` 属性与 `action.in` 动态参数解析，补齐单测。
2. **`@super-looi/home-devices` 二维紧凑排布与全品类语义收敛**
   - 在 `layout-store.ts` 实现并导出 `packBentoTiles`；
   - 在 `types.ts` 与 `device-aggregator.ts` 新增 `CameraCapability.supportsPtz`、宠物设备/电水壶/周期家电/监控/照明/温控全量枚举汉化与服务语义纠偏（修正喂食器指示灯误判与泛化文案），补齐单测。
3. **原生摄像头 MISS `0x112` 云台控制链路**
   - 在 `apps/nsh/src/camera/transport.rs` 与 `mod.rs` 实现 `XiaomiCameraHost::pan_tilt`，串联 `apps/nsh/runtime/camera.ts`、`home.ts`、`application.ts`、`build-runtime.ts` 与 `store.ts`。
4. **`HomeSpaceView.tsx` 侧栏折叠修复与横屏双栏详情重构**
   - 接入 `packBentoTiles`、优化收缩房间栏高度与卡片 `border-border` 边框；
   - 实现监控圆形四向云台盘、喂食器/饮水机双栏页、电水壶/周期家电程序网格双栏页及通用设备横屏双栏检视器。
5. **全链路构建、iOS 模拟器横屏实测与独立子 Agent 审查**
   - 执行 `pnpm` 单测、`typecheck`、`nsh` 构建与 `cargo test --test home_grid`；
   - 部署至已启动的 `iPhone 16e` 横屏模拟器，实测侧栏收放、`大厅监控` 实时流云台旋转及各品类横屏详情页截图验收；
   - 调用独立子 Agent 进行代码与 UI 设计审查，收敛问题并分步提交。
