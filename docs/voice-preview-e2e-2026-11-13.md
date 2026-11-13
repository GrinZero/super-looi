# 语音配置页模拟器 E2E 验收

2026-11-13，iPhone 16e / iOS 26.3，横屏，NSH 0.5.0 开发宿主。通过 Simulator 的实际控件操作 App，由 App 直连语音云服务；网络与音频未替换为测试桩。使用当前工作区版本，基线提交 `619fcf7`。

## 结论

确认两项问题：MOSS-Live 间歇性 TLS 建连失败；开启自动唤醒后，停止试听或试听中切换音色会短暂误显示“对话中／正在回复”。豆包云舟 2.0 连续五轮完整试听均返回音频并自动恢复“准备就绪”。

## 已确认问题

### 1. MOSS-Live 间歇性 TLS 握手失败

复现：选择 MOSS-Live → 暖暖或木木 → 试听；失败后再点试听，有时成功返回音频，有时再次失败。

本轮三个明确失败样本：18:48:53、18:50:35、18:55:22，均在约 5.0 秒后报告：

```text
provider=moss
stage=websocket.connect
code=ERR_SOCKET_CLOSED
WebSocket handshake failed: IO error: tls handshake eof
```

同一配置的成功样本包括 18:49:22 和 18:55:49，均返回 22 帧、96000 字节 PCM。因而这不是稳定的音色 ID 校验错误；本轮未进一步确定 TLS 中断发生于服务端还是网络路径。失败后的按钮能恢复并再次触发请求，页面保留真实失败阶段与原因。

证据：[失败截图](artifacts/voice-preview-e2e/moss-tls-failure.png)、[会话指标](artifacts/voice-preview-e2e/session-metrics.json)。相关既有排查见 [MOSS TLS 诊断](moss-live-tls-diagnosis.md)。

### 2. 停止试听后误显示对话状态

复现：开启 Hey LOOI 自动唤醒 → 开始试听 → 点击“停止试听”；试听时改选另一个预置音色也可复现。页面先出现“对话中／正在回复”，按钮变成“结束并试听”“结束对话”，随后才恢复“等待唤醒”。本轮实际观察到三次。

`apps/nsh/runtime/voice/runtime.ts` 的 `endSession()` 已移除活动 session，并清除 `purpose`，但没有同时清除 `phase="speaking"`。异步 `enterStandby()` 准备完成之前，页面把“活动 phase + 非 preview”解释为对话。该阶段没有创建新的云端对话。

独立审查用内联运行时探针复现：让 `startWake()` 保持 pending，停止后快照为 `phase:"speaking", purpose:undefined, activeVoiceId:undefined`。状态应由 `VoiceRuntime` 在结束 session 时一致发布；无需增加新的模块或依赖。

证据：[停止后可访问性状态](artifacts/voice-preview-e2e/stop-with-wake.txt)。[随后恢复待机的截图](artifacts/voice-preview-e2e/stop-returned-to-standby.png)拍摄于闪变结束后，不能单独作为错误状态截图。

## 交互覆盖

| 场景 | 实际结果 |
| --- | --- |
| 豆包知性女声 2.0 试听 | 返回真实音频，完整播放后恢复就绪 |
| 豆包切换云舟 2.0 后试听 | 选中值更新，后续请求返回音频 |
| 云舟 2.0 连续五轮完整试听 | 五轮均返回音频、会话结束并恢复就绪，见下表 |
| 快速开始 → 停止 → 再开始 | 按钮状态随操作切换，后续试听正常返回音频 |
| 试听期间切换预置音色 | 停止当前试听并保存新选择；开启唤醒时有问题 2 |
| 小何 2.0 的未保存 Speaker ID 草稿试听 | 返回音频；取消草稿后，已保存音色仍为云舟 2.0 |
| 建连期间切换 MOSS → 豆包 | 豆包回到就绪，保留自己的音色选择 |
| 建连期间进入模型页再返回 | 当前试听停止，返回后保留音色且可重新试听 |
| 豆包 → OpenAI → MOSS | 每个服务保留自己的配置；OpenAI 无凭据，试听和开始对话入口禁用 |
| 开关自动唤醒 | 关闭时停止试听直接回就绪；开启时最终回待机，但有问题 2 |

### 连续五轮指标

每轮等页面自动回到“准备就绪”后，再点击试听；未手动结束这五轮。

| 开始时间（UTC+8） | 握手耗时 | 返回 PCM 字节 | 估算音频时长 | 会话总耗时 |
| --- | ---: | ---: | ---: | ---: |
| 18:53:33 | 3425 ms | 152300 | 3173 ms | 8351 ms |
| 18:53:50 | 2600 ms | 144270 | 3006 ms | 6655 ms |
| 18:54:09 | 3013 ms | 152574 | 3179 ms | 7292 ms |
| 18:54:26 | 3632 ms | 152380 | 3175 ms | 7889 ms |
| 18:54:45 | 2712 ms | 144498 | 3010 ms | 6745 ms |

证据：[五轮完成后的页面](artifacts/voice-preview-e2e/doubao-five-replays.png)。指标来自 App 本地 `runtime_observations`，保留 trace ID 以便定位同轮记录。

## 需要继续定位的实测现象

MOSS 的两轮自然结束会话耗时分别为 20163 ms、21872 ms，均收到约 2 秒 PCM，响应记录带 `cancelled:true`。页面最终恢复就绪，没有确认永久卡在试听中。下一次定位应采集同轮 `response.interrupted`、`response.audio.done`、`response.ended` 的原始时间及播放队列排空时间，以解释耗时；不能仅凭帧数认定结束事件丢失。

本轮通过页面状态与返回 PCM 验证流程和有音频输出；未采集扬声器录音，因此音色听感是否与名称一致、是否有叠音仍需听音复核。OpenAI 没有可用凭据，未执行真实播放。

## 执行产物

[会话指标](artifacts/voice-preview-e2e/session-metrics.json)截取 18:47:59 起的 19 组可观测会话，其中 16 组收到音频、3 组 TLS 失败。建连完成前即被取消的尝试可能尚未创建本地会话记录，不计入这 19 组。

结束时已恢复原配置：MOSS-Live、木木、自动唤醒开启；豆包恢复知性女声 2.0。[最终页面](artifacts/voice-preview-e2e/restored-settings.png)。本轮未修改业务代码，独立审查已确认问题 2 的运行时原因。

## 用户确认独占后的复测（20:37–20:40，UTC+8）

用户确认已停止其他调试后，重新启动 iPhone 16e 模拟器并以横屏复测。新增 8 组可观测会话：7 组返回音频，1 组 TLS 失败。以下结果独立于前一轮操作。

- MOSS 木木在 20:37:40 再次返回 `websocket.connect / ERR_SOCKET_CLOSED / tls handshake eof`，耗时 5034 ms；[独占环境失败截图](artifacts/voice-preview-e2e/exclusive-moss-tls.png)。
- 重试在 20:38:04 成功返回 22 帧／96000 字节 PCM，自动结束总耗时 21124 ms，`cancelled:true`；前述耗时偏长的现象也在独占环境出现。
- 20:38:28 开始的另一轮木木试听中手动停止，再次出现“对话中／正在回复／结束对话”，随后回到唤醒待机；[独占环境错误状态](artifacts/voice-preview-e2e/exclusive-stop-with-wake.txt)。
- 豆包知性女声 2.0 连续五轮均返回真实音频并自动回到“准备就绪”。每轮都等待自动结束后再点下一轮，没有手动停止；[五轮结束截图](artifacts/voice-preview-e2e/exclusive-five-replays.png)。

| 开始时间 | 握手耗时 | PCM 字节 | 估算音频时长 | 会话总耗时 |
| --- | ---: | ---: | ---: | ---: |
| 20:38:53 | 2999 ms | 191622 | 3992 ms | 8239 ms |
| 20:39:14 | 2603 ms | 172110 | 3586 ms | 7452 ms |
| 20:39:33 | 2759 ms | 191014 | 3979 ms | 8056 ms |
| 20:39:56 | 2726 ms | 171108 | 3565 ms | 7526 ms |
| 20:40:17 | 2440 ms | 182422 | 3800 ms | 7477 ms |

[独占复测指标](artifacts/voice-preview-e2e/exclusive-session-metrics.json)保留同轮 trace ID。复测后恢复 MOSS-Live、木木、自动唤醒开启，并确认页面回到“等待唤醒”。两项问题及 MOSS 耗时现象均在独占环境复现。
