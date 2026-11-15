# iOS 模拟器热重载死锁

2026-11-15，对正在运行的 iPhone 16e／iOS 26.3 横屏 App 采样，确认界面无响应由热重载与原生音频状态查询之间的线程死锁造成。进程为 `nsh-ios-host`，PID 16286，开发服务器端口 8790。画面停留在狼人杀第 1 天「狼人行动」，点击设置后未切换页面。

## 直接证据

两次独立 `sample` 分别采集 4 秒、2 秒。第一次主线程与引擎线程各 2,270 次采样、第二次各 1,611 次采样，均保持同一等待链：

```text
主线程
  DevSession.handle → Inner.load → Surface.reload → RootView.stop
  → Engine::drop → thread.join → _pthread_join
  等待 nsh-engine 退出

nsh-engine
  Driver.turn → Script.run_timers → JavaScript 定时器
  → VoiceAudio.status → refresh_native → iOS Audio.refresh
  → application_active → DispatchQueue::main().exec_sync
  等待主线程执行 UIApplication.applicationState 查询
```

主线程必须等引擎退出才能继续处理主队列；引擎必须等主队列返回才能完成当前调用并响应停止请求，形成闭环。JavaScript 中断不能解除已经进入 Rust 原生同步派发的等待。

原始证据：[第一次采样](artifacts/ios-hot-reload-deadlock-2026-11-15/first.sample.txt)、[第二次采样](artifacts/ios-hot-reload-deadlock-2026-11-15/repeat.sample.txt)。

## 对应代码

- `apps/nsh/src/audio.rs:536`：`VoiceAudio.status()` 同步执行 `refresh_native()`。
- `apps/nsh/src/audio/ios.rs:336`：`Audio.refresh()` 每次执行 `application_active()`。
- `apps/nsh/src/audio/ios.rs:56`：非主线程调用时，通过 `DispatchQueue::main().exec_sync` 同步读取 UIKit 状态。
- NSH 固定版本 `f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1`：`crates/nsh-platform-ios/src/surface.rs:1097` 的 `Surface.reload()` 调用 `RootView.stop()`；`:854` 同步销毁 Engine；`crates/nsh-engine/src/lib.rs:1672` 调用 `thread.join()`。

`/private/tmp/super-looi-dev-8790-20261115.log` 中仍有整包 rebuild 记录。云端日志另含 `websocket.connect / ERR_SOCKET_CLOSED / tls handshake eof`、`provider.error / 55000000 / 52000033 / AudioServerNoAudioInputTooLongError`、`websocket.read / WS_1000 / connection expired`，以及实际触发的 15 秒连接超时 `ETIMEDOUT`。它们应分别处理；本次采样显示界面阻塞在本地线程等待，不能用这些云端错误解释卡死。

## 修复位置与取舍

优先在 App 的 iOS 音频适配层消除引擎线程对主线程的同步生命周期查询：主线程初始化前后台状态，由生命周期通知更新，音频状态轮询读取原子状态。这样仍由 App 承担音频与生命周期职责，无须新增依赖或修改 NSH 析构机制；成本是维护一个状态值及其通知订阅生命周期。

需要一并检查 `application_active()` 在权限申请、音频启动、启动后检查与刷新中的调用，初始化也不能通过引擎同步等待主线程完成。仅替换 `refresh()` 中的一次读取会留下其他调用的同类等待窗口。

本次为现存故障诊断，未修改产品代码，也未重启宿主；当前死锁现场保留。已确认开发热重载触发此实例，尚无发布包复现证据。独立 review 核对线程栈与上述源码，确认死锁及修复方向。
