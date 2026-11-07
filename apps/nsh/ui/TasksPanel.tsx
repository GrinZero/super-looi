import { Text, View } from "nsh";
import type { createAppStore } from "../store";
import { ActionButton, Panel } from "./Controls";

export function taskState(state: string): string {
  return (
    (
      {
        queued: "等待执行",
        running: "执行中",
        awaiting_approval: "等待你允许",
        awaiting_input: "等待你回答",
        cancelling: "正在停止",
        succeeded: "已完成",
        failed: "未完成",
        cancelled: "已停止",
        unknown: "结果待核实",
      } as Record<string, string>
    )[state] ?? "状态待核实"
  );
}

/** Bounded ten-item pages keep retained rows small; details reuse one scroll owner. */
export function TasksPanel(props: {
  open: boolean;
  store: ReturnType<typeof createAppStore>;
  onClose: () => void;
  onNewConversation: () => void;
}) {
  return (
    <Panel
      open={props.open}
      title={props.store.task() ? "任务详情" : "任务记录"}
      height={560}
      wide={true}
      onClose={props.onClose}
    >
      <If
        when={props.store.task()}
        else={
          <View class="gap-4">
            <Text class="text-muted-foreground text-sm">
              待核实的任务排在前面。开始新对话会保留这些记录，不会重新执行旧操作。
            </Text>
            <View class="flex-row gap-2">
              <ActionButton
                label="开始新对话"
                disabled={props.store.busy()}
                onPress={props.onNewConversation}
              />
              <ActionButton
                label="刷新"
                onPress={() =>
                  props.store.refreshTasks(props.store.tasks().offset)
                }
              />
            </View>
            <If when={!props.store.tasks().total}>
              <Text class="text-muted-foreground text-base">
                还没有任务记录。
              </Text>
            </If>
            <Each of={props.store.tasks().items} key={(item) => item.id}>
              {(item) => (
                <View class="gap-2 border-b border-border pb-3">
                  <Text
                    class={
                      item().state === "unknown"
                        ? "text-destructive text-sm font-medium"
                        : "text-muted-foreground text-sm"
                    }
                  >
                    {taskState(item().state)} ·{" "}
                    {item().updatedAt.slice(0, 19).replace("T", " ")} UTC
                  </Text>
                  <Text class="text-foreground text-base">{item().prompt}</Text>
                  <ActionButton
                    label="查看详情"
                    testID={`task-${item().id}`}
                    onPress={() => props.store.inspectTask(item().id)}
                  />
                </View>
              )}
            </Each>
            <If when={props.store.tasks().total > 10}>
              <View class="flex-row items-center justify-between gap-2">
                <ActionButton
                  label="上一页"
                  disabled={props.store.tasks().offset === 0}
                  onPress={() =>
                    props.store.refreshTasks(
                      Math.max(0, props.store.tasks().offset - 10),
                    )
                  }
                />
                <Text class="text-muted-foreground text-sm">
                  {Math.floor(props.store.tasks().offset / 10) + 1} /{" "}
                  {Math.ceil(props.store.tasks().total / 10)}
                </Text>
                <ActionButton
                  label="下一页"
                  disabled={
                    props.store.tasks().offset + 10 >= props.store.tasks().total
                  }
                  onPress={() =>
                    props.store.refreshTasks(props.store.tasks().offset + 10)
                  }
                />
              </View>
            </If>
          </View>
        }
      >
        <View class="gap-4">
          <ActionButton
            label="返回任务记录"
            onPress={() => props.store.closeTask()}
          />
          <Text class="text-foreground text-lg font-semibold">
            {taskState(props.store.task()?.state ?? "unknown")}
          </Text>
          <If when={props.store.task()?.state === "unknown"}>
            <Text class="text-destructive text-sm">
              无法确认上次操作是否已经生效。请先检查文件或设备的实际状态；这里不会自动重试，也不会将它标为成功。
            </Text>
          </If>
          <View selectable={true} class="gap-3">
            <Text class="text-muted-foreground text-xs">
              {props.store.task()?.id}
            </Text>
            <Text class="text-foreground text-base">
              {props.store.task()?.prompt}
            </Text>
            <If when={props.store.task()?.error}>
              <Text class="text-destructive text-sm">
                {props.store.task()?.error}
              </Text>
            </If>
            <If when={props.store.task()?.result?.answer}>
              <Text class="text-foreground text-base">
                {props.store.task()?.result?.answer}
              </Text>
            </If>
            <Text class="text-muted-foreground text-sm">
              {props.store.task()?.runtimeExited
                ? "执行器已退出"
                : "执行器退出尚未确认"}
            </Text>
            <If when={props.store.task()?.homeActions.length}>
              <Text class="text-muted-foreground text-sm">
                家居操作与回执（unknown 表示仍需核实）
              </Text>
              <Text class="text-foreground text-sm">
                {JSON.stringify(props.store.task()?.homeActions, null, 2)}
              </Text>
            </If>
            <Text class="text-muted-foreground text-sm">执行记录</Text>
            <Text class="text-foreground text-sm">
              {props.store
                .task()
                ?.steps.map((step) => `${step.step}. ${step.summary}`)
                .join("\n") || "没有可用的执行记录"}
            </Text>
            <If when={props.store.task()?.result?.executions?.length}>
              <Text class="text-foreground text-sm font-mono">
                {props.store
                  .task()
                  ?.result?.executions?.map(
                    (item) =>
                      `${item.command}\n退出码：${item.exitCode ?? "未知"}；信号：${item.signal ?? "无"}`,
                  )
                  .join("\n\n")}
              </Text>
            </If>
            <If when={props.store.task()?.result?.artifacts?.length}>
              <Text class="text-foreground text-sm font-mono">
                {props.store
                  .task()
                  ?.result?.artifacts?.map(
                    (item) => `${item.path}\nSHA-256 ${item.sha256}`,
                  )
                  .join("\n\n")}
              </Text>
            </If>
          </View>
        </View>
      </If>
    </Panel>
  );
}
