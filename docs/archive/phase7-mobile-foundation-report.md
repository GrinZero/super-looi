# Phase 7.1 / 7.2 mobile 组件与首页交付记录

本报告仅记录 `@super-looi/mobile` Step 7.1、Step 7.2，以及用户提前指定的 `RobotFaceView` avatar。并行开展的 Step 7.3 共形外壳/四大空间工作保留在其原有记录中，本报告不代为标记完成。记录日期：2026-11-04。

## 实际交付

- `humanize.ts` 提供记忆来源与认识论徽章、家居实体/条件/动作与约定、工作区/任务摘要/产物名称的中文转译；未知或不完整输入保留诚实边界。helpers 已由包入口导出。
- `resolveMemorySceneTarget(whereText, itemTitle)` 返回 0–100 的归一化百分比坐标与键盘左侧、显示器右侧、书架、右侧抽屉四区；显式位置优先于物品默认位置。空间组件接入由并行 7.3 负责。
- `LooiIcon` 保留 30 个名称和既有 props，以 Ionicons 渲染；字体未就绪或 Node 测试环境使用安全回退。新增 `LooiBrandMark` 与对称声波 `LooiWaveOrnament`。
- `RobotFaceView` 使用 RN 原生径向/线性渐变与外辉光、内嵌蓝色折射替代离散光圈层，移除眼顶贴条及 neutral/listening 悬浮眉毛。196×180pt 双眼按视口缩放，抽屉开启时平滑缩放并上移；148×82pt avatar 提供金属壳、顶部灯阵、侧耳灯、凹面屏与视线跟随。
- 首页保留低调状态入口和 Lab 入口，提供声波括号唤醒栏及底缘辉光；QuickDrawer / SimLab 打开时隐藏唤醒栏。四大空间角标读取当前计数/核验状态，未执行验收时显示“尚未核验”；隐私与 Lab 独立为工具操作，speaking 演示采用自然中文说明。
- Metro 配置修复随本轮 Node/原生集成暴露的解析兼容问题，聚焦回归覆盖现有 `.js` → TypeScript 路径约定。

## 原生运行约束

使用现成 RN 0.85.3 New Architecture 模拟器应用已提供的 ExpoFont、ExpoImage 与原生样式能力。未新增 `react-native-svg`，不依赖未链接的 RNSVG，也未直接修改 Expo prebuild 产物。TypeScript `build` 不等同于重新编译原生二进制。

## 验证记录

- 独立 review：无阻断发现。
- humanize + Metro 聚焦测试：17 项通过。
- `pnpm --filter @super-looi/mobile typecheck`：退出码 0。
- `pnpm --filter @super-looi/mobile test`：退出码 0；16 suites、61 tests 全通过，失败/跳过/取消均为 0。
- `pnpm --filter @super-looi/mobile build`：退出码 0。
- iOS 首屏：已读取核验 [首屏截图](artifacts/phase7/steps-7.1-7.2/ios-firstscreen.png)，可见连续眼球辉光、青色弧嘴、柔和底边氛围光和克制入口，未观察到原来的同心塑料环。此结论限定于该横屏截图，不代表全设备逐像素一致。
- iOS avatar：已读取核验 [任务页头盔截图](artifacts/phase7/steps-7.1-7.2/ios-avatar-tasks.png)，确认头盔壳、顶部传感器、侧耳辉光、Ionicons 和品牌标实际呈现。
- 抽屉：操作中观察到唤醒栏隐藏与大脸缩小上移；并发模拟器操作干扰后未保留稳定截图，因此仍需补充可复查的抽屉证据。
- SimLab 完整交互与 portrait 实机：未完成。迁移到独立 iPhone 17 模拟器后 CUA native pipe 关闭，重置仍不可用；现有原生应用还锁定横屏，不能用旋转该二进制证明竖屏适配。详情见 [验证说明](artifacts/phase7/steps-7.1-7.2/validation-notes.md)。

三项命令针对当时共享工作区执行，包含并行 mobile 变更，具体执行基线见 [validation-context.log](artifacts/phase7/steps-7.1-7.2/validation-context.log)。核心实现最终由共享工作区提交 `99bcc10` 和 `819fa8b` 收录；它们同时包含其他批次内容，本报告的交付范围仍只限 7.1/7.2。

本批次截图及日志统一保存在 [`artifacts/phase7/steps-7.1-7.2/`](artifacts/phase7/steps-7.1-7.2/)，与并行 7.3 产物分开归档。

## 后续边界

7.3 的空间集成和 7.4 的 Hub Web 同步、完整双端逐屏检查按各自进度继续跟踪。iOS 未实际覆盖的屏幕或状态保留在 `todo.md`；物理设备回读、BLE、语音链路与长稳验收不由本轮 UI 自动化结果替代。
