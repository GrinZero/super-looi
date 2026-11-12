import { mount, signal, View } from "nsh";
import type { NativeObservation, NativeTask } from "../../generated/looi-runtime.js";
import { TasksSpaceView } from "../../ui/TasksSpaceView";
import { ActionButton } from "../../ui/Controls";

const startedAt = 1_700_000_000_000;
const nodes: NativeObservation[] = [
  { traceId: "trace", spanId: "task", name: "agent.run", type: "agent", startedAt, attributes: {} },
  { traceId: "trace", spanId: "context", parentSpanId: "task", name: "agent.context", type: "span", startedAt, endedAt: startedAt + 1, attributes: {
    "langfuse.observation.input": { history: [{ role: "user", content: "获取当前准确的具体时间，精确到时分秒" }], systemPrompt: "真实系统指令", userPrompt: "我上一轮问了什么？" },
    "langfuse.observation.output": { historyMessages: 1 },
  } },
  { traceId: "trace", spanId: "model", parentSpanId: "task", name: "llm.chat", type: "generation", startedAt: startedAt + 2, attributes: { "langfuse.observation.model.name": "test-model" } },
  { traceId: "trace", spanId: "search", parentSpanId: "model", name: "agent.tool.web_search", type: "tool", startedAt: startedAt + 3, attributes: { "langfuse.observation.input": { type: "provider_hosted" } } },
];
const initial: NativeTask = { id: "fixture-task", sessionId: "fixture-session", prompt: "我上一轮问了什么？", state: "running", createdAt: new Date(startedAt).toISOString(), updatedAt: new Date(startedAt).toISOString(), homeActions: [], steps: [], trace: { traceId: "trace", spanId: "task" }, observations: nodes };

function Fixture() {
  const task = signal(initial);
  const selected = signal(true);
  const store = {
    task: () => selected() ? task() : undefined,
    tasks: () => ({ items: [task()], offset: 0, total: 1 }),
    inspectTask: () => { selected.set(true); },
    closeTask: () => { selected.set(false); },
    refreshTasks: () => {},
    shellOutput: () => undefined,
  };
  return (
    <View class="flex-1 p-4 gap-4">
      <View class="flex-row gap-2">
        <ActionButton testID="finish-search" label="完成搜索" onPress={() => task.set({ ...task(), observations: nodes.map(node => node.spanId === "search" ? { ...node, endedAt: startedAt + 200, attributes: { ...node.attributes, "langfuse.observation.output": { status: "completed", action: { type: "search", queries: ["真实搜索词"] } } } } : node) })} />
        <ActionButton testID="legacy-task" label="旧任务" onPress={() => task.set({ ...initial, id: "legacy", trace: undefined, observations: [], steps: [{ step: 1, phase: "tool_start", summary: "旧版步骤甲" }, { step: 1, phase: "tool_end", summary: "旧版步骤乙" }] })} />
      </View>
      <TasksSpaceView store={store} />
    </View>
  );
}
mount(Fixture);
