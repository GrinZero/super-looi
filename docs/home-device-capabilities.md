# 家居能力与布局

家居页面、文字 Agent 与语音工具使用同一套设备能力和命令转换。账号连接与使用入口见 [应用说明](../apps/nsh/README.md#家居连接)。

## 模块边界

| 模块 | 职责 |
| --- | --- |
| [home-assistant](../packages/home-assistant/src/index.ts) | 米家／HA／演示数据传输、规格映射、服务执行和回读 |
| [home-devices](../packages/home-devices/src/index.ts) | 聚合同一物理设备，生成卡片、能力、房间环境和布局模型 |
| [HomeRuntime](../apps/nsh/runtime/home.ts) 与 store | 连接、轮询、命令状态、设备当前值与布局持久化 |
| [HomeSpaceView](../apps/nsh/ui/HomeSpaceView.tsx) | 房间、设备卡片、详情与布局手势 |

UI 通过 `entityId/domain/service/parameterKey` 组织命令；MIoT 的 did／siid／piid／aiid 由传输层处理。能力类型见 [types.ts](../packages/home-devices/src/types.ts)，按设备实际提供的属性和动作组装。

| 能力类型 | 用途 | 保留的信息 |
| --- | --- | --- |
| `toggle`（开关） | 电源、摇头等布尔控制 | 当前值与开／关命令 |
| `range`（数值调节） | 温度、亮度、角度 | 单位、最小值、最大值与步长 |
| `choice`（选项） | 档位、模式、风类 | 原始枚举值、标签与当前选项 |
| `action`（动作） | 清扫、回充等操作 | 动作标识与输入参数 |
| `metric`（指标） | 电量、温湿度、剩余时间 | 来源、单位及只读值 |

同一设备可以组合多个能力；卡片显示摘要，详情承载完整控制。读取失败、零值、关闭与缺字段分别呈现。分辨率、播放状态、周期进度等内容需要实际来源，不能从设备在线或电源状态推导。

## 布局与设备语义

卡片支持 `1x1`、`2x1`、`1x2`、`2x2`，列数按家居画布的实际可用宽度计算。房间编辑采用拖动排序及边缘缩放，布局由 [layout-store.ts](../packages/home-devices/src/layout-store.ts) 保存。

洗碗机与洗衣机分别分类；扫地机耗材保留服务身份；电饭煲程序和进度使用真实字段；相机的设备控制与视频会话分开。原生预览与 Agent 取帧设计见 [相机接入计划](plans/xiaomi-camera-native-integration-plan.md)。

## 设备证据

2026-11-10 魅族 20 Pro 横屏调研记录了风扇、空调和台灯等真实设备能力。规格与读取结果见 [能力清单](artifacts/home-repair-audit/capability-inventory.json)，页面见 [布局编辑](artifacts/home-repair-audit/03-layout-edit.png) 和 [风扇详情](artifacts/home-repair-audit/04-fan-detail.png)。型号对应的范围、枚举和动作参数应从当前规格读取。

问题根因、修复步骤及当次验收保存在 [家居修复历史计划](plans/archive/smart-home-device-and-design-repair-plan.md)。后续设备排序、即时开关反馈、离线卡片及设备实测见 [todo.md](../todo.md)。
