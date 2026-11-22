# 狼人杀环视认座、内置具身视觉插件与底座发牌技术方案

## 1. 目标与边界

本方案把桌游狼人杀的“环视认座（Tabletop Seat Scan）”与“底座物理转向发牌（Turn-Only Card Dealing）”收敛为 App 自主运行的具身闭环系统，所有硬件感知与运动能力均由终端 App 原生承载，不依赖开发机 CLI、中转进程或外部云端视觉服务。

核心边界拆分为以下两层：
1. **原生与具身能力层（归属 `Host Runtime`（宿主运行时）与内置核心插件 `vision-person-tracker`）**：负责相机采集、单人头像本地磁盘裁剪缓存、无磁力计的六轴惯性测量单元（IMU，Inertial Measurement Unit）世界航向推算、底座原语驱动与实时悬崖传感器解析、实验性闭环转向标定（Calibration）与座位表维护。
2. **桌游业务编排层（归属 `werewolf-judge`）**：仅通过插件服务契约消费空间感知结果与相对座位偏航角（Yaw）映射，在夜间轮次与开牌阶段向底座发起带“按下即冻结”约束的转向指令，不直接操作底层蓝牙（BLE）字节流或传感器队列。

---

## 2. 插件职责划分与内置核心插件（`builtinCore`）设计

### 2.1 `PluginManifest` 与 `PluginHost`

在 [shared-types.ts](../../apps/nsh/runtime/plugins/shared-types.ts) 中新增两个核心契约字段与权限项：
- `PluginManifest.builtinCore?: boolean`：标记插件为宿主运行所需的基础内置核心插件。
- `PLUGIN_PERMISSIONS` 新增 `"sensor.motion"` 权限，对应 `PluginContext.motion?: PluginMotionCapability`。

在 [host.ts](../../apps/nsh/runtime/plugins/host.ts) 中强化生命周期约束：
- 应用启动恢复持久化安装记录时，若清单声明 `builtinCore === true`，无条件强制 `enabled = true` 写入并启动，忽略历史禁用状态。
- 调用 `setEnabled(id, false)` 时，若目标插件为 `builtinCore === true`，拒绝修改状态，抛出携带结构化上下文的错误：`{ stage: "plugin_host.set_enabled", code: "ERR_PLUGIN_CORE_CANNOT_DISABLE", reason: ... }`，保障上层 UI 或调测脚本不会静默吞错。
- 在 [PluginsSpaceView.tsx](../../apps/nsh/ui/PluginsSpaceView.tsx) 的插件顶部控制栏中，对 `builtinCore` 插件隐藏启用/停用开关（`ToggleSwitch`），改以不可切换的只读核心徽标 `testID="plugin-builtin-core-badge"`（“内置核心 / Built-in Core”）呈现。

### 2.2 两个插件的边界收敛

| 维度 | `vision-person-tracker`（内置核心插件 `builtinCore: true`） | `werewolf-judge`（桌游插件） |
| :--- | :--- | :--- |
| 版本与权限 | `1.1.0`，声明 `camera.front`、`sensor.motion`、`face.control`、`body.motion` | `2.0.0+`，消费 `vision-person-tracker` 暴露的服务契约与 `body.motion` |
| 拥有的数据与硬件态 | 相机水平视场角（HFOV）、人脸几何追踪、IMU 世界航向角、单人头像磁盘缓存文件（`file://` URI）、实验性标定参数、桌游座位坐标系状态机 | 狼人杀身份分配、轮次状态机、声纹/文本裁判、单局座位与玩家的绑定关系 |
| 生命周期职责 | 启动即就绪；未接管底座时仅作为按需相机/IMU 观察者；环视标定与闭环扫视期间持有 `acquireServo` 租约 | 开局前发起环视建图、重开局触发 `"对齐 1 号"` 航向归零、夜间发牌调用对准接口并支持语音/长按触控冻结 |

---

## 3. 架构深度模块化与方案对比（Design-It-Twice）

遵循 `.agents/skills/codebase-design/SKILL.md` 的深模块（Deep Module）原则，避免将底层校准公式、多传感器时间对齐或驱动帧节流泄漏给业务插件，针对两个关键基础设施做显式方案对比与取舍。

### 3.1 IMU 原生实现方式：独立新 Java 桥接 vs. 纯 Rust `libandroid.so` 直连 NDK + iOS 轻量 ObjC

| 对比维度 | 方案 A：在 Android 新增 Java `SensorEventListener` + JNI 桥 | 方案 B：Android 纯 Rust `dlopen("libandroid.so")` 直连 `ASensorManager` + iOS 极简 `CoreMotion` ObjC（选用） |
| :--- | :--- | :--- |
| 跨端复用与胶水代码 | Android 侧需新增 Java 类、线程池生命周期、JNI 字符串/对象封送与 Proguard 规则 | Android **零新增 Java 文件**，与 `DeviceMotionHost` 同处 Rust crate 内；仅 iOS 因无稳定 C ABI 保留轻量 `DeviceMotion.m` |
| 线程与内存开销 | Java 主/后台线程经 JNI 频繁回调 Rust，触发额外堆分配与全局引用管理 | Rust 专属传感器线程直接操作 `ALooper_prepare` + `ASensorEventQueue_getEvents` 读取固定 104 字节 `ASensorEvent` 结构体 |
| 权限与构建耦合 | 需要维护 Android Gradle/Java manifest 与符号导出 | NDK `libandroid.so` 属于系统标准库（运行期动态加载）；加速度计/陀螺仪熔合无需 Android 运行时权限弹窗 |
| 与现存代码的一致性 | 与现存 `DeviceCameraBridge.java` 一致，但会继续膨胀 Java 资产体积 | 与仓库现有 [audio/android.rs](../../apps/nsh/src/audio/android.rs) 的 `libc::dlopen` 动态加载范式完全一致；已验证可正常运行的 `LooiBleBridge.java` 与 `DeviceCameraBridge.java` 维持最小增量不重写 |

**最终选型**：采用方案 B。在 Android 上使用纯 Rust `dlopen("libandroid.so")` 获取无磁力计的 `ASENSOR_TYPE_GAME_ROTATION_VECTOR = 15`（缺失时按阶降级记录实际底层错误与事件原因，或按硬件支持回退为同为六轴无磁方案并显式暴露传感器类型 `sensorKind`），在 iOS 上通过 [DeviceMotion.m](../../apps/nsh/native/ios/DeviceMotion.m) 调用 `CMMotionManager` 的 `CMAttitudeReferenceFrameXArbitraryZVertical`（同样禁用磁力计）。

### 3.2 底座闭环控制队列：严格 FIFO 缓冲队列 vs. Latest-Wins（最新优先覆盖）+ 高频传感器旁路

| 对比维度 | 方案 A：沿用 `writePacedUnacked` 全量 FIFO 排队 | 方案 B：传感器事件旁路广播 + 伺服周期目标向量 Latest-Wins 合并（选用） |
| :--- | :--- | :--- |
| 控制延迟特性 | 当视觉或 PID 控制频率高于 BLE 发包节奏时，旧速度指令在队列尾部堆积，引起严重的相位滞后与过冲振荡 | 伺服循环（Servo Loop）仅在槽位空闲或上一个 BLE 写入完成后取**最新一次** `setDriveVector` 指令下发；前序未发出的中间目标直接被新设定值覆盖 |
| 急停安全性 | “停止/冻结”指令需要排队等待前面积压的多条运动指令发完后才生效 | `stop()` 与 `preempt()` 直接清空待发向量并优先插队零速停止帧（Zero Vector） |
| BLE 通知兼容性 | `FED9` 仅在长度匹配 1 字节 `05`/`06` 时触发 `dockChange`，5 字节悬崖传感器帧 `01 FL FR RL RR` 被静默丢弃 | 在 `BodySupervisor` 增加原始通知钩子 `onRawNotification(characteristicUuid, hex)`，`FED9` 5 字节悬崖帧实时解析并驱动急停刹车与状态订阅 |

**最终选型**：采用方案 B。对 `acquireServo().setDriveVector` 与 `BodyRuntime` 内的电机控制环统一应用 Latest-Wins 合并，保留单点单向节流保护以适配 Meizu 20 Pro 等 BLE 写入速率限制（参考 [looi-ble-live-verification.md](../../docs/looi-ble-live-verification.md)），并在 `BodySupervisor` 侧透传完整原生通知帧供悬崖与自检状态观测。

---

## 4. 新增模块、依赖与复杂度成本审查

| 新增概念 / 文件 / 实体 | 核心用途 | 引入复杂度成本 | 收益权衡评估 |
| :--- | :--- | :--- | :--- |
| `PluginManifest.builtinCore` 与 `"sensor.motion"` 权限 | 锁定基础视觉插件始终启用，按权限最小化分配 IMU 访问能力 | 在 [shared-types.ts](../../apps/nsh/runtime/plugins/shared-types.ts)、[host.ts](../../apps/nsh/runtime/plugins/host.ts)、UI 增加 1 个布尔分支与 1 个只读标签 | 避免玩家误关底层视觉插件导致发牌、眼神追踪同步瘫痪，成本极低 |
| `DeviceMotionHost`（Rust + iOS `.m`）与 `MotionBroker`（TS） | 为桌面 360° 扫描提供抗磁干扰的世界竖直轴（Gravity-Axis +Z）航向角积分 | 新增 1 个原生宿主模块、1 份纯 Rust NDK FFI 绑定、1 份 iOS `CoreMotion` 文件，无新增第三方库 | LOOI 底座内含强永磁铁、直流电机与无线充线圈，磁力计必然失真；六轴纯重力参考系是低成本获得精确偏航角的唯一可行路径 |
| 原生头像磁盘裁剪缓存（`<sys.data_dir>/portraits/*.jpg` -> `file://` URI） | 在环视发现单人时于原生层直接按人脸扩展框裁剪并写盘，避免整帧高清 JPEG 长期驻留 JS 内存 | `DeviceCameraHost` 新增 `System` 数据目录注入及 `capture_cropped_portrait` / `delete_portrait` 接口 | NSH 原生 `<Image>` 组件在双端原生直接支持 `file://` URI 渲染，将 JS 堆拷贝与编解码降至 0 帧阻塞 |
| `BodySupervisor.onRawNotification` 与 `Latest-Wins` 伺服队列 | 解析 `FED9 01 FL FR RL RR` 悬崖传感器帧并消除闭环转向控制滞后 | 在 [body-supervisor.ts](../../packages/looi-driver/src/body-supervisor.ts) 与 [body.ts](../../apps/nsh/runtime/body.ts) 扩展状态槽与包解析器 | 直接决定发牌转向过冲误差能否收敛以及桌沿防跌落安全响应速度 |

---

## 5. 原生数学模型与接口详细设计

### 5.1 横屏倾斜手机的重力竖直轴扭转角提取（Gravity-Axis Twist Projection）

由于手机在 LOOI 磁吸底座上通常以横屏形态呈现，且存在 $25^\circ \sim 85^\circ$ 不等的俯仰角（`FED1` 抬头/低头电机），直接使用欧拉角 `yaw` 会在接近 $90^\circ$ 或大倾角时受万向锁与横滚/偏航轴耦合（Gimbal Lock / Cross-Axis Coupling）干扰。

设上一帧与当前帧的四轴四元数（Unit Quaternion，由世界参考系 `World Z` 竖直向上、`Gravity` 对齐）为 $q_{\text{prev}} = (w_1, x_1, y_1, z_1)$ 与 $q = (w_2, x_2, y_2, z_2)$。在 `HeadingAccumulator` 中计算相对世界坐标系的增量四元数（Delta Quaternion）：

$$\Delta q = q \otimes q_{\text{prev}}^{-1} = (dw, dx, dy, dz)$$

其中四元数共轭逆为 $q_{\text{prev}}^{-1} = (w_1, -x_1, -y_1, -z_1) / \|q_{\text{prev}}\|^2$。针对世界坐标系竖直轴 $\hat{k} = (0, 0, 1)$ 做 Swing-Twist 分解，抽出绕重力轴的扭转（Twist）分量 $(dw, 0, 0, dz)$，并在 $dw < 0$ 时取负以走最短圆弧路径：

$$\Delta \theta_{\text{ccw}} = 2 \cdot \operatorname{atan2}(dz', dw') \quad \text{(弧度，逆时针为正)}$$

转化为以俯视顺时针（Clockwise）为正的度数累积：

$$\text{headingDeg} \mathrel{+}= -\Delta \theta_{\text{ccw}} \cdot \frac{180}{\pi}$$

该投影天然对齐物理桌面法线，底座旋转过程中即使手机随抬头舵机产生剧烈俯仰变化，水平投影角度仍保持线性无畸变。

### 5.2 Android NDK `ASensorEvent` ABI 与动态加载

参考 Android NDK 27 系统头文件 `<android/sensor.h>`，采用 `libc::dlopen("libandroid.so", libc::RTLD_NOW)` 动态查找符号，不在 `build.rs` 静态硬链接特定 API Level，保持构建环境解耦：
- `ASensorManager_getInstance`（并在可用时优先探查 `ASensorManager_getInstanceForPackage`）
- `ASensorManager_getDefaultSensor`（`ASENSOR_TYPE_GAME_ROTATION_VECTOR = 15`）
- `ALooper_prepare`、`ALooper_pollOnce`
- `ASensorManager_createEventQueue`、`ASensorManager_destroyEventQueue`
- `ASensorEventQueue_enableSensor`、`ASensorEventQueue_disableSensor`、`ASensorEventQueue_setEventRate`、`ASensorEventQueue_getEvents`

在 Rust 中通过 `#[repr(C)]` 定义 104 字节固定大小的 `ASensorEvent` 内存布局（前 16 字节为 4 个 `i32`：结构大小、传感器句柄、类型、保留字，随后为 8 字节对齐的 `i64 timestamp` 与 64 字节数据联合体，总计 `16 + 8 + 64 + 16 = 104` 字节，并用编译期断言校验 `size_of::<ASensorEvent>() == 104`），直接从 `data.vector`（`[f32; 4]`，对应 `[x, y, z, w]`）提取四元数（若传感器硬件省略第 4 分量 $w$ 则按单位长度补全 $\sqrt{\max(0, 1 - x^2 - y^2 - z^2)}$）。

### 5.3 相机扩展契约与单人头像落盘缓存

1. **水平视场角（`hfovDeg`）与单调时钟（Monotonic Timestamp）**：
   - Android Camera2 通过 `LENS_INFO_AVAILABLE_FOCAL_LENGTHS` 与 `SENSOR_INFO_PHYSICAL_SIZE` 依据针孔相机模型实时计算 $\text{HFOV} = 2 \cdot \operatorname{atan}\left(\frac{W_{\text{sensor}}}{2 f}\right)$ 转为角度，并考虑裁剪后有效图像区域；iOS `AVCaptureDevice` 直接读取 `activeFormat.videoFieldOfView` 并按设备横屏方向折算水平视场角。
   - 统一返回基于单调时钟（`CLOCK_MONOTONIC` / `CACurrentMediaTime`）的毫秒时间戳 `capturedMonotonicMs` 与 `facesMonotonicMs`，显式分离图像曝光瞬间与最近一次人脸检测结果时刻，使上层闭环控制器可准确判断特征是否陈旧（Staleness）而无须受系统墙上时钟校时跳变影响。
   - **重要兼容约定**：保留现有 `DeviceCamera.m` 与 `DeviceCameraBridge.java` 的人脸快照 `1500ms` 默认缓存以兼容既有人脸交互逻辑，但新增显式字段区分采样时刻，同时提供纯人脸轻量采样模式（`capture_faces` / `includeJpeg: false`），跳过全帧 JPEG 压缩与跨 FFI 传输，大幅提升闭环扫视帧率。
2. **单人头像本地裁剪落盘（`capture_cropped_portrait` / `delete_portrait`）**：
   - `DeviceCameraHost` 通过 NSH `System` 依赖注入获取 `data_dir`（同时保留无参测试构造兼容或默认测试目录），将裁切后的单人头像存储至 `<data_dir>/portraits/<portraitId>.jpg`。
   - 原生侧根据入参归一化人脸矩形框按设定比例外扩裁剪并编码为紧凑 JPEG，返回 `{ uri: "file://...", width, height, byteLength, portraitId }`；上层不再在 JS 内存缓存裸字节数组，UI 组件直接使用 NSH 原生 `<Image source={uri} />` 渲染。
   - 删除或重置局次时，调用 `delete_portrait` 清理磁盘文件，若文件不存在则返回明确状态，若权限/IO 异常沿调用链上报完整 `{ stage, code, reason }`。

### 5.4 `BodySupervisor` 与 `BodyRuntime` 扩展

- **原始传感器通知旁路**：`BodySupervisorEvents` 新增 `onRawNotification?: (characteristicUuid: string, hex: string, receivedAtMs: number) => void`。
- **`FED9` 悬崖传感器（Cliff Sensor）解析**：识别以 `01` 开头且长度为 5 字节的 `FED9` 通知负载（`01 FL FR RL RR`）。按照底座硬件逻辑低电平有效（Active-Low：`01` 表示安全桌面接触，`00` 表示悬崖/悬空触发），解析四路状态 `{ flTriggered, frTriggered, rlTriggered, rrTriggered, anyTriggered, rawHex, receivedAtMs }`，并在 `BodyRuntime` 暴露最近数据包查询与实时订阅能力（供 `createBodyCapability` 与 Stage 2 防跌落刹停消费）。

---

## 6. 里程碑拆解

### Milestone 0A：插件边界重划分 + IMU 纯 Rust 主机 + 相机时间戳/视场角/头像落盘 + 底座 Latest-Wins 与 `FED9` 解析（当前执行）
1. 完善 `PluginManifest.builtinCore`、`"sensor.motion"`、`PluginHost` 核心强制启用语义及 `PluginsSpaceView` 核心徽标，并将 `vision-person-tracker` 升级为 `builtinCore: true` 内置核心插件。
2. 落地纯 Rust NDK `DeviceMotionHost`（Android `libandroid.so` 动态加载，零新 Java）+ iOS `DeviceMotion.m` + `MotionBroker`，通过四元数重力轴扭转投影及俯仰角解耦单元测试。
3. 扩展 `DeviceCameraHost`（Rust / iOS / Android）与 `VisionBroker`：`hfovDeg`、`capturedMonotonicMs` / `facesMonotonicMs`、无 JPEG `capture_faces` 模式、单人头像 `<data_dir>/portraits/*.jpg` 落盘与 `delete_portrait`。
4. 升级 `BodySupervisor`（原始 `FED9` 回调）与 `BodyRuntime`（`FED9 01` 悬崖解析、`acquireServo().setDriveVector` Latest-Wins 合并），并完成全量 TypeScript / Rust 单元测试与编译构建校验。

### Milestone 0B：真机实验性旋转标定（Experimental Calibration）与闭环扫视原语（待 0A 通过后在真机开展）
1. 在 `vision-person-tracker` 实现实验性转角标定状态机：指令底座按标称角速度微步试转并同步采集 IMU 航向增量与静态人脸水平像素偏移增量，标定视觉-IMU 尺度增益 $k_{\text{visual}}$、有效驱动增益与死区摩擦阈值（Deadzone）及开环角速度映射曲线，参数本地持久化存储。
2. 构建无磁闭环角位移控制器（结合 IMU 陀螺积分与人脸重定位偏移），支持指定相对角度旋转并附带悬崖中断安全钩子，确保桌面静止条件下单次转向过冲与重复归位收敛。

### Milestone 1：360° 环视认座、重开局 `"对齐 1 号"` 与底座发牌（On-Device 单机优先）
1. 开局前引导 LOOI 360° 平滑自转扫视，结合人脸检测稳定度自动提取座位分布与方位角度表，同时对每位入座玩家就地调用 `capture_cropped_portrait` 落盘单人头像。
2. 重开新局支持语音或界面触发 `"对齐 1 号"` 重校准：转动镜头重新锁定 1 号玩家面孔并将该时刻 IMU 世界角置为新的零度参考基准。
3. 将 `werewolf-judge` 发牌与夜间唱票动作接入 `setDealingTarget` 底座仅转向接口；严格执行夜间纯听写禁令、语音/长按屏幕查看身份期间底座电机即时冻结，退出按键后恢复轮询。

### Milestone 2：双机协同模式边界、白天复用与 Stage 2 高级运动优化
1. 落地局域网（LAN）双机协同房间下的能力分层：桌面主机承担底座环视/发牌，伴随客户端仅通过房主同步状态展现桌面座位UI。
2. 支持白天自由发言阶段可选复用已有座位角度表执行眼神追随注视，严格禁止夜间回合开启主动人脸抓拍或视线追踪。
3. 完成左右轮差校准与 `FED9` 实时悬崖触发紧急刹停策略回归测试，同步更新 `docs/arch/index.html` 系统架构图。

---

## 7. 验证基线与执行约束

- **错误暴露原则**：所有原生 FFI、蓝牙发送、传感器打开与磁盘裁剪失败必须沿调用链完整携带 `{ stage, code, reason }`，仅对敏感凭据脱敏，禁止将底层驱动失败统一改写为“超时”或“未知错误”。
- **横屏与真机约束**：App 与 Stage UI 仅支持与验证横屏视角；真机装包及底座实际运动标定仅在连接实体机（如 ADB 设备与物理 LOOI 底座）时执行，纯算法、插件契约与 FFI 内存布局通过本地 Rust `cargo test --lib` 与 Node 插件单测集覆盖验证。
