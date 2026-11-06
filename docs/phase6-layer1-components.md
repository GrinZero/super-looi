# Phase 6 第一层组件交付说明

本文为 Step 6.1 与 Step 6.2 第一层组件的历史交付记录，下文“本次”与“后续”均指该次组件交付时点。首屏接线和四空间的当前实现、验证与局限见 [Phase 6 首屏接线与四大共形空间](phase6-conformal-spaces.md)。历史检查记录保留原样，不代表当前页面仍未接线。

本次依据 `docs/design-v2/ui-v2.1-redesign-spec.md` 完成 Step 6.1 基础设施与 Step 6.2 可复用表现组件。`apps/mobile/app/index.tsx` 未修改；首屏接线、控制器挂载、顶栏及 QA 按钮移除、模拟器截图验收留待后续，Step 6.2 整体尚未完成。

## TypeScript 与主题兼容性

- `apps/mobile/tsconfig.build.json` 继承 `../../tsconfig.base.json`，以 `src` 为 `rootDir`、`dist` 为 `outDir`，使用 `jsx: react-native`，仅编译 `src/**/*`；mobile `build` 执行 `tsc -p tsconfig.build.json`。
- `apps/mobile/tsconfig.json` 使用 `noEmit: true` 和 `jsx: react-native`，同时包含 `src/**/*` 与 `app/**/*`，使路由页面进入类型检查。
- `LOOI_PALETTE` 原有字段和色值全部保留，新增 12 个设备屏 Token：`emergencyCoral`、`cautionAmber`、`bgDeep`、`bgRaised`、`surfaceGlass`、`surfaceElevated`、`surfaceRail`、`lineSubtle`、`lineActive`、`electricBlue`、`eyeRimBlue`、`eyeHaloGlow`。`LOOI_TYPE` 提供 12–28 的视距字号。
- 将 `app` 纳入检查后，暴露现有 `index.tsx` 第 351/354 行的局部颜色变量推断问题：从一个调色板字段初始化的变量被收窄为单个颜色字面量，不能再赋另一个颜色。主题现先定义字符串字段对象，再 `Object.freeze` 导出，保留只读/运行时冻结行为，同时让字段类型为 `string`；无需修改页面或旧色值。

## Metro 运行时模块解析

TypeScript NodeNext 源文件使用指向产物的相对 `.js` 导入，Metro 默认不会像 TypeScript 一样将这些路径替换为 `.ts`/`.tsx`。仅通过类型检查仍会让新组件在接入 Expo 时出现模块解析失败。

`apps/mobile/metro.config.js` 现保留 Expo 上游 resolver 并先解析原始请求；只有相对 `.js` 请求抛出 `FailedToResolvePathError` 时，才去掉 `.js` 后缀交给同一 resolver 重试。真实 `.js` 优先，平台后缀与包解析仍由 Metro 负责；外部包请求、其他错误类型不触发回退。因此新组件中的 `theme.js`、`LooiIcon.js` 导入可以映射到实际 TypeScript 文件，不必改变 NodeNext 源码约定。

`apps/mobile/test/metro-resolver.test.ts` 使用真实 Metro resolver，新增 4 项聚焦回归覆盖扩展名映射及边界；最终独立验证 mobile 测试共 32/32 通过。此模块解析验证不代表已接入首屏或通过 iOS 模拟器截图验收。

## LooiIcon

文件：`apps/mobile/src/ui/components/LooiIcon.tsx`。导出 `LooiIconName`、`LooiIconProps` 与 `LooiIcon`。

| 属性 | 契约 |
| --- | --- |
| `name` | 必填，以下 30 个图标名称之一 |
| `size` | 可选，默认 24；有限数值最小限制为 1，非有限值回退 24 |
| `color` | 可选，默认 `LOOI_PALETTE.textPrimary` |

支持名称：`eye`、`book`、`tasks`、`home`、`wrench`、`shield`、`sparkles`、`mic`、`camera`、`radar`、`dock`、`undock`、`stop`、`check`、`warning`、`close`、`search`、`sun`、`lamp`、`wind`、`sensor`、`bluetooth`、`server`、`gateway`、`play`、`edit`、`box`、`trash`、`clock`、`chevron-up`。

所有笔画均由原生 `View` 的边框、圆角、线段及旋转组合，无 Emoji、Unicode 图标字符或字体图标依赖。图标为装饰性内容，容器按钮/卡片承担可访问名称。

## RobotFaceView

文件：`apps/mobile/src/ui/components/RobotFaceView.tsx`。导出 `RobotFaceViewProps` 与 `RobotFaceView`，`FaceExpression` 沿用 `shell/presence-state.ts`。

| 属性 | 契约 |
| --- | --- |
| `mode` | 必填，`fullscreen` 或 `avatar` |
| `expression` | 必填，`neutral` / `listening` / `thinking` / `speaking` / `curious` / `sleeping` / `alarmed` |
| `gaze` | 必填，`{ x, y }`；分别限制到 `[-1, 1]`，x 正值朝右，y 正值朝上 |
| `blinkProgress` | 必填，限制到 `[0, 1]`；0 睁眼，1 闭眼，达到 0.98 时显示闭眼细线 |
| `waveformBars` | 必填，真实麦克风/TTS 的归一化幅度数组；每项限制到 `[0, 1]`，线性重采样为 7 根共振柱 |
| `microShift` | 必填，`{ dx, dy }`；独立限制到 `[-6, 6]`，作用于脸部整体且不随脸部缩放放大 |
| `onPress` | 可选；fullscreen 用于打开快捷功能，avatar 用于返回大脸；未传入时无点击行为 |

fullscreen 使用 `#03070D` 背景、低透明网格/点阵、蓝青双层光晕，以及标准尺寸 152×134、圆角 67 的青色眼睛。下缘采用 `#0066FF`、顶部采用低透明月牙高光；脸部画布按可用宽高等比缩小，最大保持原尺寸。7 态眉形各自独立：neutral/curious 采用几何微笑弧，thinking 采用短横线，sleeping 使用闭眼及低亮短横嘴，alarmed 切换为珊瑚红和张口轮廓。

listening/speaking 仅在真实幅度大于 0.06 时显示波形，空数组、静音及待机不会生成伪随机声波。呼吸光晕使用原生驱动，尊重系统减少动态效果设置；休眠/警示时停止呼吸循环，卸载时清理动画和设置监听。

avatar 占用 108×66，包含深色圆角头盔、护目镜、两侧青色灯条、顶部指示点、随 gaze 聚焦的双眼及小微笑。表情/眨眼与微移同样通过 props 驱动。组件只展示状态，不持有摄像头、麦克风、运动控制或控制器实例。

## 快捷抽屉与浮层

文件：`apps/mobile/src/ui/components/QuickDrawerModal.tsx`。四个组件均导出对应 `Props` 接口，抽屉另导出 `QuickDrawerDestination`。

| 组件 | 属性与行为 |
| --- | --- |
| `QuickDrawerOverlay` | 必填 `visible`、`onClose()`、`onSelect(destination)`；可选 `memoryCount`、`taskCount`。destination 为 `memories`、`tasks_and_rules`、`home`、`cabin`、`privacy_pause`、`sim_lab`。选择入口先调用关闭，再通知目的地。 |
| `SimLabSheet` | 必填 `visible`、`onClose()`、`isDocked` 和 `onSpeakingTest()`、`onRememberFrame()`、`onMicroObservation()`、`onToggleDock()`、`onEmergencyStop()`、`onRunAcceptance()`；可选 `acceptanceRunning`，默认 false，运行中禁用验收按钮。脱座/归座标签跟随 `isDocked`。 |
| `PrivacyPauseOverlay` | 必填 `visible`、`privacyEpoch: PrivacyEpoch`、`onResume()`。从真实纪元读取 `capture_epoch`、`camera`、`microphone`、`local_buffer_state`，关闭未确认或缓冲清理中时诚实展示待确认状态。只在点击明确恢复按钮时调用 `onResume`，系统返回不会自行恢复感知。 |
| `ConversationSubtitleOverlay` | 必填 `visible`、`text`；可选 `mode: listening \| speaking`，默认 listening。隐藏或空白文本不渲染，胶囊最多两行并截断；不拦截触摸，提供礼貌级实时字幕可访问提示。 |

抽屉和仿真台采用透明 Modal、半透明深色玻璃表面/高光/描边与淡入淡出；这是原生 View 玻璃视觉，不依赖额外模糊库。卡片最小高度 84，满足 52pt 入口要求；横屏按宽度切换三列/两列/一列，大字体切换单列，并提供滚动及安全区布局。

只有快捷抽屉在 4.5 秒无操作后调用 `onClose`；触摸、滚动和焦点活动重置计时，关闭/卸载时清理定时器。仿真台保持打开，操作仅委托相应回调。抽屉/仿真台可通过背景、关闭按钮及系统关闭请求退出；隐私面板使用独立全屏 Modal，恢复动作由外部状态/硬件所有者执行。字幕位于宿主页面底部，宿主需提供 `SafeAreaProvider`。

## 验证与后续接线

- [x] 最终独立验证：`pnpm --filter @super-looi/mobile typecheck`，退出码 0。
- [x] 最终独立验证：`pnpm --filter @super-looi/mobile test`，7 个 suite，32/32 通过（含 4 项 Metro resolver 回归）。
- [x] 最终独立验证：`pnpm --filter @super-looi/mobile build`，退出码 0。
- [x] `git diff --check`，退出码 0；`apps/mobile/app/index.tsx` 的 SHA-256 与任务基线完全一致。
- [ ] 后续在 `index.tsx` 实际挂载组件，接入 `RobotFaceController`、`DockedLongevitySupervisor`、隐私纪元与仿真回调，再移除旧顶栏/QA 按钮。
- [ ] 后续实现首屏轻触/上滑打开抽屉、运动态 `<100ms` 急停大胶囊和 `LightToastQueue` 提示接线。
- [ ] 接线后在 iOS 模拟器核验逐态外观、波形静音行为、点击/超时、隐私恢复和安全区，并保存截图。

本次尚无已接线页面的模拟器视觉验收结论；类型与单元测试结果仅覆盖相应静态/自动化检查，不能代替视觉还原或硬件链路验证。
