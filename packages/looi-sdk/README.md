# @sourcebug/looi-sdk

LOOI 第一版 SDK 现在只保留 4 类核心能力：

1. 高层移动控制：前后左右，适合轮盘或长按按钮驱动
2. 高层头部控制：抬头 / 中位 / 低头
3. 简单灯光控制：开灯 / 关灯
4. 吸附状态回调 + 原始特征值写入

SDK 仍然是 TypeScript 项目，并产出类型声明文件。

## 核心 API

```ts
import { LooiRobot, WebBluetoothLooiTransport } from "@sourcebug/looi-sdk";

const robot = new LooiRobot(new WebBluetoothLooiTransport());

await robot.connect({
  onDock: ({ docked }) => {
    console.log("吸附状态", docked);
  },
});

await robot.move("forward");
robot.startMoveLoop("left");
await robot.setHead("center");
await robot.setLight(true);

await robot.writeRaw("fe00", "00100000010032030a0001ff00010a3203ff0003", {
  response: true,
});
```

## 设计原则

- 默认暴露高层能力，不要求业务侧理解全部 BLE 协议细节
- `connect()` 后默认立即握手
- 吸附事件直接走 `onDock`
- 只有在确实需要时，才通过 `writeRaw()` 直接操作 `fe00` / `fed2` / `feda` 这类通道

## 导出内容

- `LooiRobot`
- `WebBluetoothLooiTransport`
- `normalizeHex()`
- `hexToBytes()`
- `bytesToHex()`
- `createInitTimeHex()`
- `LOOI_MOVE_VALUES`
- `LOOI_HEAD_VALUES`
- `LOOI_LIGHT_VALUES`
