# LLM Tool Use 支持 — 实现计划

## 目标
让 LOOI 的 LLM 能通过 tool use 机制调用工具（第一个工具：`get_current_time`），使其能回答时间类问题。

## 架构设计

```
User: "现在几点了"
  → LLM 收到 tools 定义
  → LLM 返回 toolCall: get_current_time
  → Server 执行工具，拿到结果
  → 把 ToolResultMessage 追加到 messages
  → 再调一次 LLM
  → LLM 返回自然语言回复
  → 流式输出给客户端
```

## 改动文件

### 1. 新建 `server/src/infra/tools.ts` — 工具定义与执行

- 定义 `Tool` 注册表
- `get_current_time` 工具：返回 `{ datetime, timezone }` 格式的当前时间
- `executeTool(name, args)` 函数：根据 name 查表执行

### 2. 修改 `server/src/infra/llm.ts` — Context 加入 tools

- `buildContext` 接收可选 `tools` 参数，填入 `Context.tools`
- 新增 `chatCompleteWithTools` — 循环处理 tool call 直到 LLM 返回文本
- 新增 `chatStreamWithTools` — streaming 版本，tool call 阶段静默处理，文本阶段正常流式

### 3. 修改 `server/src/routes/llm.ts` — 使用新的 tool-aware 函数

- `generate-response` 和 `generate-response-stream` 路由改用带 tools 的调用
- `chat` intent 带上 tools（store/search/remind 不需要工具）
- streaming 中，当收到 `toolcall_end` 事件时执行工具并继续

## 工具定义细节

```typescript
// get_current_time
{
  name: "get_current_time",
  description: "获取当前的日期和时间",
  parameters: Type.Object({}) // 无参数
}

// 执行结果示例
{
  datetime: "2026-06-29 14:30:25",
  timezone: "Asia/Shanghai",
  weekday: "星期日"
}
```

## 关键设计决策

1. **Tool loop 最大次数**：限制 3 次，防止无限循环
2. **哪些 intent 带 tools**：只有 `chat` intent 带工具（store/search/remind 走专用流程）
3. **Streaming 中 tool call 的处理**：tool call 阶段不向客户端发送 token，执行完工具后继续 stream 第二轮 LLM 回复
4. **typebox 依赖**：`@earendil-works/pi-ai` 已 re-export `Type` from typebox，直接用

## 扩展性

后续添加新工具只需在 `tools.ts` 的注册表里加一项，无需改动 llm 层。
