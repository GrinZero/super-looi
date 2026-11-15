# 「视觉座位追踪」取景频闪修复与具身跟脸伴随增强方案

## 根因定位

1. **取景框 6Hz 持续频闪**
   - [SettingsView.tsx](file:///Users/bugyaluwang/project/super-looi/apps/nsh/plugins/vision-person-tracker/ui/SettingsView.tsx#L87-L95) 中，`effect` 直接调用 `previewSessionId()`（来自 `props.ctx.state()`，底层订阅整棵 `store.plugins()` signal）。
   - 开启实时取景后，[runtime/index.ts](file:///Users/bugyaluwang/project/super-looi/apps/nsh/plugins/vision-person-tracker/runtime/index.ts#L461-L466) 按默认 6 FPS（约每 166ms）调用 `syncSnapshotState` 更新 `faceCount` 与 `primaryTarget`。
   - 由于缺少会话 ID 去重与 `computed` 派生隔离，每次帧更新都触发 `effect` 清理函数 `previewReveal.stop()` 与 `previewReveal.play("fadeIn")`，将取景框容器透明度重置为 `0` 后再淡入，造成肉眼可见的 6Hz 闪烁。

2. **iOS 模拟器取景黑屏与固定居中偏移**
   - [view_ios.rs](file:///Users/bugyaluwang/project/super-looi/apps/nsh/src/device_camera/view_ios.rs#L27-L35) 的 `active_platform_handle` 对 `SessionBackend::Sample` 返回空指针，`<DeviceCameraPreview />` 无帧入队，只呈现黑色底面。
   - [device_camera/mod.rs](file:///Users/bugyaluwang/project/super-looi/apps/nsh/src/device_camera/mod.rs#L190-L205) 的 `build_sample_faces` 将水平偏移固定在 `±0.08` 振幅内，始终落入居中死区 `[-0.12, 0.12]`，无法在模拟器中观察左/右偏转与跟脸联动。

3. **缺乏独立具身跟脸伴随与头像抓拍闭环**
   - `vision-person-tracker` 仅声明 `["camera.front"]`，未申请 `face.control` 与 `body.motion` 权限，也未在无上层插件消费时驱动眼神和底座伺服跟随人脸。
   - 配置页缺少后台常驻伴随开关与头像抓拍入口及结果预览。

---

## 模块边界与设计

### 1. 原生相机模拟器合成预览层（`device_camera`）
- **职责归属**：由 Rust `DeviceCameraHost` 与 ObjC `LCDeviceCameraView` 在原生层为 `SessionBackend::Sample` 提供真实图形帧输出，TS UI 层保持单一 `<DeviceCameraPreview />` 组件契约不变。
- **`build_sample_faces`**：`seq <= 3` 保持小偏移（`0.08` 振幅）以保证快速单元测试在首帧即可通过居中断言；`seq > 3` 切换为 `±0.42` 水平平滑正弦往返轨迹，完整覆盖偏左、居中、偏右三种状态。
- **`looi_device_camera_view_present_sample`**：在 `DeviceCamera.m` 中使用 CoreGraphics 绘制 `320x180` BGRA 合成取景图（深色参考网格、中心十字准心与随人脸 `(offsetX, offsetY, width, height)` 移动的人物头肩剪影），封装为 `CMSampleBufferRef` 送入 `LCDeviceCameraView` 的 `AVSampleBufferDisplayLayer`，并在 `SampleStreamState` 状态中回报 `displayed = true`（`frames > 0`）。
- **`encode_sample_jpeg`**：在 8x8 灰度 MCU 编码中结合同步人脸坐标绘制人物剪影明暗轮廓，使 `capturePortrait` 返回直观可辨的 Base64 JPEG。

### 2. 视觉追踪服务与独立伴随控制（`vision-person-tracker/runtime`）
- **状态与指令扩展**：
  - `manifest.ts` 声明 `["camera.front", "face.control", "body.motion"]`。
  - `VisionPersonTrackerState` 新增 `companionFollowEnabled`（默认 `false`，保持冷启动 0 订阅者不开流不耗电不变量）、`trackingStatus`（`"idle" | "centered" | "turning_left" | "turning_right" | "searching"`）、`actuatorMode`（`"idle" | "servo_and_gaze" | "gaze_only" | "yielded_to_consumer" | "preempted"`）、`commandedTurn`、`commandedPitchDegrees` 与 `lastPortrait`。
  - `VisionPersonTrackerCommand` 新增 `set_companion_follow` 与 `capture_portrait`。
- **跟脸控制与让渡仲裁**：
  - `desiredStreamParameters()` 在 `consumers.size > 0 || calibrationOpen || companionFollowEnabled` 时开启前摄流；全部关闭后立即熄灯断流并释放租约。
  - 当上层消费插件（如 `werewolf-judge`）持有 `acquireTracking` 时（`consumers.size > 0`），立即释放自身伴随 `FaceLease` 与 `BodyServoLease` 并标记 `actuatorMode = "yielded_to_consumer"`，避免与前台舞台争夺表情与电机控制权。
  - 仅在 `(calibrationOpen || companionFollowEnabled) && consumers.size === 0` 时申请 `ctx.face?.acquireLease("background_ambient")` 驱动眼神跟随，并在底座已连接且吸合时申请 `ctx.body?.acquireServo("background_companion")` 执行 `speed = 0` 原地转向与俯仰对准（水平死区 `±0.12`，比例系数 `55`，转向限幅 `±45`；俯仰角 `32°–78°`）。被用户控制或高优先级任务抢占时监听 `onPreempted` 标记 `actuatorMode = "preempted"`。
  - 所有 `ctx.face` / `ctx.body` 访问使用可选链保护，确保未注入这两种能力的 `PluginHost` 测试环境仍可正常运行。

### 3. 设置页稳定性与交互完善（`vision-person-tracker/ui/SettingsView.tsx`）
- **去重动画与渲染稳定**：
  - 使用 `computed(() => st()?.previewSessionId ?? null)` 与 `computed(() => { const id = previewSessionId(); return id ? [id] : []; })` 隔离每帧坐标变化带来的重复变更。
  - `effect` 记录 `revealedSessionId`，仅当新 `previewSessionId` 首次建立时触发一次 `previewReveal.play("fadeIn")`，持续帧到达时不重启或停止淡入动画。
  - `cleanup()` 仅在未开启 `companionFollowEnabled` 时关闭 `calibrationPreviewOpen`。
- **交互控制**：
  - 保留唯一主按钮「开启实时取景校准 / 关闭实时取景校准」，补充「常驻跟脸伴随」开关与「抓拍头像」操作按钮，并在右侧展示具身跟脸与伺服遥测（当前动作、转向 `Turn`、俯仰 `Pitch`）及最近抓拍头像缩略图。

---

## 验收标准
1. 开启实时取景校准后，取景框不再发生 6Hz 频闪；iOS 模拟器取景框内可稳定显示随追踪目标移动的合成取景画面与绿/黄追踪框，偏移读数与「偏左 / 水平已居中 / 偏右」状态随时间变化。
2. 开启校准或「常驻跟脸伴随」后，可观察到追踪动作状态、转向与俯仰读数联动更新，首屏 LOOI 眼神跟随目标偏移转动；点击「抓拍头像」可生成并在卡片中预览内存态 Base64 JPEG 头像；开启「常驻跟脸伴随」后返回首页仍持续伴随跟踪。
3. 存在上层消费者调用 `acquireTracking` 时，自身伴随租约立即让渡释放；全部校准、伴随与订阅关闭后，`streaming` 与相机硬件会话立即关闭归零。
4. `build:runtime`、`nsh check`、`nsh build`、`cargo test --lib`、`werewolf-plugin.node.ts`、`plugin-ecosystem-v2.node.ts`、`DeviceCameraBridge.test.tsx`、`WerewolfStage.test.tsx` 及 iOS 模拟器横屏实测截图均通过。
