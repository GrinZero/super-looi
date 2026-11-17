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
const legacy: NativeTask = { ...initial, id: "legacy", prompt: "旧任务的请求", state: "failed", error: "[stage=write code=EIO] 写入失败", trace: undefined, observations: [], steps: [{ step: 1, phase: "tool_start", summary: "旧版步骤甲" }, { step: 1, phase: "tool_end", summary: "旧版步骤乙" }] };
const history = Array.from({ length: 9 }, (_, index) => ({ ...initial, id: `history-${index}`, prompt: `历史任务 ${index + 1}`, state: "succeeded" }));

function Fixture() {
  const task = signal(initial);
  const offset = signal(0);
  const selected = signal<string | undefined>(initial.id);
  const firstPage = () => [task(), ...history];
  const items = () => offset() === 0 ? firstPage() : [legacy];
  const store = {
    task: () => items().find(item => item.id === selected()),
    tasks: () => ({ items: items(), offset: offset(), total: 11 }),
    inspectTask: (id: string) => { selected.set(id); },
    closeTask: () => { selected.set(undefined); },
    refreshTasks: (next: number) => { offset.set(next); selected.set(items()[0]?.id); },
    shellOutput: () => ({ taskId: initial.id, callId: "command", command: "pwd", text: "实时命令输出", status: "" }),
  };
  return (
    <View class="flex-1 p-4 gap-4">
      <View class="flex-row gap-2">
        <ActionButton testID="finish-search" label="完成搜索" onPress={() => task.set({
          ...task(),
          state: "succeeded",
          result: { answer: "这是最终回答。", executions: [{ callId: "command", command: "pwd", stdout: "/fixture/project", exitCode: 0, signal: null, timedOut: false, aborted: false }] },
          observations: nodes.map(node => node.spanId === "search" ? { ...node, endedAt: startedAt + 200, attributes: { ...node.attributes, "langfuse.observation.output": { status: "completed", action: { type: "search", queries: ["真实搜索词"] } } } } : node),
        })} />
      </View>
      <TasksSpaceView store={store} />
    </View>
  );
}
mount(Fixture);
