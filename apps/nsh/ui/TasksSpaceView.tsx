import { Text, View, Scroll, windowSize } from "nsh";
import type { createAppStore } from "../store";
import { ActionButton } from "./Controls";

export function taskStateLabel(state: string): string {
  switch (state) {
    case "queued":
      return "等待执行";
    case "running":
      return "执行中";
    case "awaiting_approval":
      return "等待允许";
    case "awaiting_input":
      return "等待回答";
    case "cancelling":
      return "正在停止";
    case "succeeded":
      return "已完成";
    case "failed":
      return "未完成";
    case "cancelled":
      return "已停止";
    case "unknown":
      return "结果待核实";
    default:
      return "状态待核实";
  }
}

export function TasksSpaceView(props: {
  store: ReturnType<typeof createAppStore>;
}) {
  const currentTask = () => props.store.task();

  const sortedItems = () => {
    const raw = props.store.tasks().items;
    return [...raw].sort((a, b) => {
      if (a.state === "unknown" && b.state !== "unknown") return -1;
      if (a.state !== "unknown" && b.state === "unknown") return 1;
      return 0;
    });
  };

  const renderTaskList = () => (
    <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
      <View class="flex-row items-center justify-between border-b border-border pb-2.5">
        <View class="gap-0.5">
          <Text class="text-foreground text-sm font-semibold">任务审计记录</Text>
          <Text class="text-muted-foreground text-xs">
            共 {props.store.tasks().total} 条历史操作与 Agent 审计记录
          </Text>
        </View>
        <If when={props.store.recoveryCount() > 0}>
          <View class="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full bg-destructive">
            <Text class="text-primary-foreground text-xs font-semibold">
              {props.store.recoveryCount()} 条待核实
            </Text>
          </View>
        </If>
      </View>

      <If
        when={props.store.tasks().total > 0}
        else={
          <View class="py-8 items-center justify-center">
            <Text class="text-muted-foreground text-xs">暂无历史任务记录</Text>
          </View>
        }
      >
        <View class="gap-2">
          <Each of={sortedItems()} key={(item) => item.id}>
            {(item) => {
              const isSelected = () => currentTask()?.id === item().id;
              const isUnknown = () => item().state === "unknown";

              return (
                <View
                  class={
                    isSelected()
                      ? "rounded-xl border border-primary bg-muted p-3 gap-1.5"
                      : "rounded-xl border border-border bg-card p-3 gap-1.5"
                  }
                >
                  <View class="flex-row items-center justify-between">
                    <Text
                      class={
                        isUnknown()
                          ? "text-destructive text-xs font-bold"
                          : "text-muted-foreground text-xs font-medium"
                      }
                    >
                      {taskStateLabel(item().state)}
                    </Text>
                    <Text class="text-muted-foreground text-xs font-mono">
                      {item().updatedAt.slice(0, 19).replace("T", " ")}
                    </Text>
                  </View>
                  <Text
                    class="text-foreground text-sm font-medium"
                    style={{ numberOfLines: 2 }}
                  >
                    {item().prompt}
                  </Text>
                  <View class="flex-row justify-end pt-1">
                    <ActionButton
                      label="查看详情"
                      testID={`task-${item().id}`}
                      compact={true}
                      kind={isSelected() ? "primary" : undefined}
                      onPress={() => props.store.inspectTask(item().id)}
                    />
                  </View>
                </View>
              );
            }}
          </Each>
        </View>
      </If>

      <If when={props.store.tasks().total > 10}>
        <View class="flex-row items-center justify-between pt-2 border-t border-border">
          <ActionButton
            label="上一页"
            compact={true}
            disabled={props.store.tasks().offset === 0}
            onPress={() =>
              props.store.refreshTasks(
                Math.max(0, props.store.tasks().offset - 10),
              )
            }
          />
          <Text class="text-muted-foreground text-xs font-mono">
            {Math.floor(props.store.tasks().offset / 10) + 1} /{" "}
            {Math.ceil(props.store.tasks().total / 10)}
          </Text>
          <ActionButton
            label="下一页"
            compact={true}
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
  );

  const renderTaskDetails = () => (
    <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
      <If
        when={Boolean(currentTask())}
        else={
          <View class="py-12 items-center justify-center gap-2">
            <Text class="text-foreground text-sm font-semibold">
              审计凭证检视
            </Text>
            <Text class="text-muted-foreground text-xs text-center">
              点击左侧列表中的任意任务，可在此处原地核验步骤日志、终端命令退出码、生成产物
              SHA-256 摘要与智能家居操作回执。
            </Text>
          </View>
        }
      >
        <View class="gap-3">
          <View class="flex-row items-center justify-between border-b border-border pb-2.5">
            <View class="flex-row items-center gap-2">
              <Text
                class={
                  currentTask()?.state === "unknown"
                    ? "text-destructive text-sm font-bold"
                    : "text-foreground text-sm font-semibold"
                }
              >
                {taskStateLabel(currentTask()?.state ?? "unknown")}
              </Text>
              <Text class="text-muted-foreground text-xs font-mono">
                {currentTask()?.id}
              </Text>
            </View>
            <ActionButton
              label="关闭详情"
              compact={true}
              onPress={() => props.store.closeTask()}
            />
          </View>

          <If when={currentTask()?.state === "unknown"}>
            <View class="rounded-xl border border-destructive bg-muted p-3">
              <Text class="text-destructive text-xs font-medium">
                由于此前非正常退出或超时，此任务的最终执行结果尚无法确认。请核对下方执行明细。
              </Text>
            </View>
          </If>

          <View class="gap-1">
            <Text class="text-muted-foreground text-xs">用户指令 (Prompt)</Text>
            <View class="rounded-xl border border-border bg-muted p-3" selectable={true}>
              <Text class="text-foreground text-sm font-medium">
                {currentTask()?.prompt}
              </Text>
            </View>
          </View>

          <If when={Boolean(currentTask()?.result?.answer)}>
            <View class="gap-1">
              <Text class="text-muted-foreground text-xs">Agent 回复 (Answer)</Text>
              <View class="rounded-xl border border-border bg-muted p-3" selectable={true}>
                <Text class="text-foreground text-sm">
                  {currentTask()?.result?.answer}
                </Text>
              </View>
            </View>
          </If>

          <If when={(currentTask()?.steps.length ?? 0) > 0}>
            <View class="gap-1.5">
              <Text class="text-muted-foreground text-xs">执行步骤明细</Text>
              <View class="gap-1.5">
                <Each of={currentTask()?.steps ?? []} key={(s) => String(s.step)}>
                  {(s) => (
                    <View class="rounded-xl border border-border bg-muted p-2.5 flex-row items-center justify-between">
                      <Text class="text-foreground text-xs">
                        {s().step}. {s().summary}
                      </Text>
                      <Text class="text-muted-foreground text-xs font-mono">
                        {s().phase}
                      </Text>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          </If>

          <If when={(currentTask()?.result?.executions?.length ?? 0) > 0}>
            <View class="gap-1.5">
              <Text class="text-muted-foreground text-xs">Shell 命令执行回执</Text>
              <View class="gap-1.5">
                <Each
                  of={currentTask()?.result?.executions ?? []}
                  key={(e) => e.command}
                >
                  {(e) => (
                    <View class="rounded-xl border border-border bg-muted p-3 gap-1 font-mono">
                      <Text class="text-foreground text-xs font-mono">
                        $ {e().command}
                      </Text>
                      <Text class="text-muted-foreground text-xs font-mono">
                        exitCode: {String(e().exitCode)} · timedOut:{" "}
                        {String(e().timedOut)}
                      </Text>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          </If>

          <If when={(currentTask()?.result?.artifacts?.length ?? 0) > 0}>
            <View class="gap-1.5">
              <Text class="text-muted-foreground text-xs">产物 SHA-256 完整性摘要</Text>
              <View class="gap-1.5">
                <Each
                  of={currentTask()?.result?.artifacts ?? []}
                  key={(a) => a.path}
                >
                  {(a) => (
                    <View class="rounded-xl border border-border bg-muted p-3 gap-1">
                      <Text class="text-foreground text-xs font-mono">
                        {a().path} ({a().size} B)
                      </Text>
                      <Text class="text-muted-foreground text-xs font-mono">
                        sha256: {a().sha256}
                      </Text>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          </If>

          <If when={(currentTask()?.homeActions.length ?? 0) > 0}>
            <View class="gap-1.5">
              <Text class="text-muted-foreground text-xs">智能家居操作回执</Text>
              <View class="gap-1.5">
                <Each
                  of={currentTask()?.homeActions ?? []}
                  key={(ha) => ha.requestId}
                >
                  {(ha) => (
                    <View class="rounded-xl border border-border bg-muted p-3 gap-1 font-mono">
                      <Text class="text-foreground text-xs font-mono">
                        requestId: {ha().requestId} · status: {ha().status}
                      </Text>
                      <Text class="text-muted-foreground text-xs font-mono">
                        {JSON.stringify(ha().receipt)}
                      </Text>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          </If>
        </View>
      </If>
    </View>
  );

  const wide = () => windowSize().width >= 600;

  return (
    <If
      when={wide()}
      else={
        <Scroll class="flex-1" contentClass="gap-3.5 pb-6">
          <If when={Boolean(currentTask())} else={renderTaskList()}>
            <View class="gap-3">
              <ActionButton
                label="返回任务列表"
                compact={true}
                onPress={() => props.store.closeTask()}
              />
              {renderTaskDetails()}
            </View>
          </If>
        </Scroll>
      }
    >
      <View class="flex-1 flex-row gap-3.5 min-h-0">
        <View style={{ flex: 5, minWidth: 0, minHeight: 0 }}>
          <Scroll class="flex-1" contentClass="gap-3 pb-4">
            {renderTaskList()}
          </Scroll>
        </View>
        <View style={{ flex: 7, minWidth: 0, minHeight: 0 }}>
          <Scroll class="flex-1" contentClass="gap-3 pb-4">
            {renderTaskDetails()}
          </Scroll>
        </View>
      </View>
    </If>
  );
}
