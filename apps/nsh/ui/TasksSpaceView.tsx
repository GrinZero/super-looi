import { t, formatDate, translateMessage } from "../i18n";
import { Text, View, Scroll, windowSize } from "nsh";
import { Button, TextView } from "nsh/base";
import type { createAppStore } from "../store";
import { TaskShellOutput } from "./TaskShellOutput";
import { ActionButton } from "./Controls";
import { TaskTraceView } from "./TaskTraceView";

export function taskStateLabel(state: string): string {
  switch (state) {
    case "queued":
      return t("queued");
    case "running":
      return t("running");
    case "awaiting_approval":
      return t("awaitingApproval182");
    case "awaiting_input":
      return t("awaitingAnswer");
    case "cancelling":
      return t("stopping");
    case "succeeded":
      return t("completed");
    case "failed":
      return t("incomplete");
    case "cancelled":
      return t("stopped");
    case "unknown":
      return t("resultUnverified");
    default:
      return t("stateUnverified");
  }
}

function taskStateDotClass(state: string): string {
  switch (state) {
    case "succeeded":
      return "w-1.5 h-1.5 rounded-full bg-verified";
    case "running":
    case "queued":
    case "awaiting_approval":
    case "awaiting_input":
    case "cancelling":
      return "w-1.5 h-1.5 rounded-full bg-warning";
    case "failed":
    case "unknown":
      return "w-1.5 h-1.5 rounded-full bg-destructive";
    default:
      return "w-1.5 h-1.5 rounded-full bg-subtle-text";
  }
}

export function TasksSpaceView(props: {
  store: Pick<
    ReturnType<typeof createAppStore>,
    | "task"
    | "tasks"
    | "inspectTask"
    | "closeTask"
    | "refreshTasks"
    | "shellOutput"
  >;
}) {
  const currentTask = () => props.store.task();

  const renderTaskList = () => (
    <If
      when={props.store.tasks().total > 0}
      else={
        <View class="py-10 items-center justify-center">
          <Text class="text-muted-foreground text-xs">{t("noTaskHistoryYet")}</Text>
        </View>
      }
    >
      <View class="gap-1.5">
        <Each of={props.store.tasks().items} key={(item) => item.id}>
          {(item) => {
            const isSelected = () => currentTask()?.id === item().id;
            const isUnknown = () => item().state === "unknown";

            return (
              <Button
                testID={`task-${item().id}`}
                selected={isSelected()}
                onPress={() => props.store.inspectTask(item().id)}
                class={
                  isSelected()
                    ? "rounded-xl bg-muted border border-border px-3 py-2.5 gap-1.5 min-h-11 active:opacity-75 focus:border-ring"
                    : "rounded-xl bg-card border border-transparent px-3 py-2.5 gap-1.5 min-h-11 active:bg-muted focus:border-ring"
                }
              >
                <View class="w-full min-w-0 flex-row items-center justify-between gap-2">
                  <View class="flex-row items-center gap-1.5 shrink-0">
                    <View class={taskStateDotClass(item().state)} />
                    <Text
                      class={
                        isUnknown()
                          ? "text-destructive text-xs font-bold"
                          : isSelected()
                            ? "text-foreground text-xs font-semibold"
                            : "text-muted-foreground text-xs font-medium"
                      }
                    >
                      {taskStateLabel(item().state)}
                    </Text>
                  </View>
                  <Text
                    class="text-muted-foreground text-xs font-mono shrink-0"
                    style={{ fontVariant: ["tabular-nums"], numberOfLines: 1 }}
                  >
                    {formatDate(item().updatedAt, {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </Text>
                </View>
                <Text
                  class={
                    isSelected()
                      ? "text-foreground text-sm font-semibold"
                      : "text-foreground text-sm font-medium"
                  }
                  style={{ numberOfLines: 2 }}
                >
                  {item().prompt}
                </Text>
              </Button>
            );
          }}
        </Each>

        <If when={props.store.tasks().total > 10}>
          <View class="flex-row items-center justify-between pt-2 border-t border-border">
            <ActionButton
              label={t("previous")}
              compact={true}
              disabled={props.store.tasks().offset === 0}
              onPress={() =>
                props.store.refreshTasks(
                  Math.max(0, props.store.tasks().offset - 10),
                )
              }
            />
            <Text
              class="text-muted-foreground text-xs font-mono"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {Math.floor(props.store.tasks().offset / 10) + 1} /{" "}
              {Math.ceil(props.store.tasks().total / 10)}
            </Text>
            <ActionButton
              label={t("next")}
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
    </If>
  );

  const renderTaskDetails = () => (
    <If
      when={Boolean(currentTask())}
      else={
        <View class="py-12 px-4 items-center justify-center gap-1.5">
          <Text class="text-foreground text-sm font-semibold">
            {t("inspectActivityReceipts")}
          </Text>
          <Text class="text-muted-foreground text-xs text-center">
            {t("selectATaskToInspectItsSteps")}
          </Text>
        </View>
      }
    >
      <View class="gap-3.5 min-w-0">
        <View class="flex-row items-center justify-between gap-2 border-b border-border pb-2.5 min-w-0">
          <View class="flex-row items-center gap-2 shrink-0">
            <View
              class={
                currentTask()?.state === "unknown" || currentTask()?.state === "failed"
                  ? "px-2.5 py-1 rounded-full bg-muted border border-destructive flex-row items-center gap-1.5"
                  : "px-2.5 py-1 rounded-full bg-muted border border-border flex-row items-center gap-1.5"
              }
            >
              <View class={taskStateDotClass(currentTask()?.state ?? "unknown")} />
              <Text
                class={
                  currentTask()?.state === "unknown" || currentTask()?.state === "failed"
                    ? "text-destructive text-xs font-bold"
                    : "text-foreground text-xs font-semibold"
                }
              >
                {taskStateLabel(currentTask()?.state ?? "unknown")}
              </Text>
            </View>
            <If when={Boolean(currentTask()?.updatedAt)}>
              <Text
                class="text-muted-foreground text-xs font-mono"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {formatDate(currentTask()?.updatedAt ?? 0, {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </Text>
            </If>
          </View>
          <Text
            class="text-muted-foreground text-xs font-mono flex-1 text-right"
            style={{ numberOfLines: 1, flexShrink: 1 }}
          >
            {currentTask()?.id}
          </Text>
        </View>

        <If when={Boolean(currentTask()?.error)}>
          <View class="min-w-0" selectable={true}>
            <Text class="text-destructive text-xs">{translateMessage(currentTask()?.error ?? "")}</Text>
          </View>
        </If>

        <View class="gap-1.5 min-w-0">
          <Text class="text-muted-foreground text-xs font-medium">
            {t("yourRequest")}
          </Text>
          <View class="rounded-xl border border-border bg-muted p-3 min-w-0" selectable={true}>
            <Text class="text-foreground text-sm font-medium">
              {currentTask()?.prompt}
            </Text>
          </View>
        </View>

        <If when={Boolean(currentTask()?.result?.answer)}>
          <View class="gap-1.5 min-w-0">
            <Text class="text-muted-foreground text-xs font-medium">
              {t("traceFinalAnswer")}
            </Text>
            <View class="rounded-xl border border-border bg-muted p-3 min-w-0" selectable={true}>
              <TextView
                class="text-foreground text-sm"
                markdown={currentTask()?.result?.answer}
                links="open"
                selectable={true}
              />
            </View>
          </View>
        </If>

        <TaskShellOutput output={props.store.shellOutput()} taskId={currentTask()?.id} />
        <If when={Boolean(currentTask())}>
          <TaskTraceView task={currentTask()!} />
        </If>

        <If when={(currentTask()?.result?.executions?.length ?? 0) > 0}>
          <View class="gap-1.5 min-w-0">
            <Text class="text-muted-foreground text-xs font-medium">
              {t("shellCommandReceipts")}
            </Text>
            <View class="gap-1.5 min-w-0">
              <Each
                of={currentTask()?.result?.executions ?? []}
                key={(e) => e.callId}
              >
                {(e) => (
                  <View class="rounded-xl border border-border bg-muted p-3 gap-1 font-mono min-w-0">
                    <Text class="text-foreground text-xs font-mono">
                      $ {e().command}
                    </Text>
                    <Text class="text-muted-foreground text-xs font-mono">
                      exitCode: {String(e().exitCode)} · timedOut:{" "}
                      {String(e().timedOut)}
                    </Text>
                    <If when={Boolean(e().stdout)}>
                      <Text class="text-foreground text-xs font-mono">{e().stdout}</Text>
                    </If>
                    <If when={Boolean(e().stderr)}>
                      <Text class="text-muted-foreground text-xs font-mono">{e().stderr}</Text>
                    </If>
                  </View>
                )}
              </Each>
            </View>
          </View>
        </If>

        <If when={(currentTask()?.result?.artifacts?.length ?? 0) > 0}>
          <View class="gap-1.5 min-w-0">
            <Text class="text-muted-foreground text-xs font-medium">
              {t("artifactSha256Hashes")}
            </Text>
            <View class="gap-1.5 min-w-0">
              <Each
                of={currentTask()?.result?.artifacts ?? []}
                key={(a) => a.path}
              >
                {(a) => (
                  <View class="rounded-xl border border-border bg-muted p-3 gap-1 min-w-0">
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
          <View class="gap-1.5 min-w-0">
            <Text class="text-muted-foreground text-xs font-medium">
              {t("homeActionReceipts")}
            </Text>
            <View class="gap-1.5 min-w-0">
              <Each
                of={currentTask()?.homeActions ?? []}
                key={(ha) => ha.requestId}
              >
                {(ha) => (
                  <View class="rounded-xl border border-border bg-muted p-3 gap-1 font-mono min-w-0">
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

        <If when={(currentTask()?.bodyActions?.length ?? 0) > 0}>
          <View class="gap-1.5 min-w-0">
            <Text class="text-muted-foreground text-xs font-medium">
              {t("bodyActionReceipts")}
            </Text>
            <View class="gap-1.5 min-w-0">
              <Each
                of={currentTask()?.bodyActions ?? []}
                key={(ba) => ba.requestId}
              >
                {(ba) => (
                  <View class="rounded-xl border border-border bg-muted p-3 gap-1 font-mono min-w-0">
                    <Text class="text-foreground text-xs font-mono">
                      action: {ba().command.action} · status: {ba().status}
                    </Text>
                    <Text class="text-muted-foreground text-xs font-mono">
                      {JSON.stringify(ba().receipt)}
                    </Text>
                  </View>
                )}
              </Each>
            </View>
          </View>
        </If>
      </View>
    </If>
  );

  const wide = () => windowSize().width >= 600;

  return (
    <If
      when={wide()}
      else={
        <Scroll class="flex-1" contentClass="gap-3.5 pb-6">
          <If
            when={Boolean(currentTask())}
            else={
              <View class="rounded-2xl border border-border bg-card p-3.5 gap-3">
                {renderTaskList()}
              </View>
            }
          >
            <View class="gap-3">
              <ActionButton
                testID="task-detail-close"
                label={t("backToTaskList")}
                compact={true}
                onPress={() => props.store.closeTask()}
              />
              <View class="rounded-2xl border border-border bg-card p-4">
                {renderTaskDetails()}
              </View>
            </View>
          </If>
        </Scroll>
      }
    >
      <View class="flex-1 flex-row gap-3 min-h-0">
        <View
          class="rounded-2xl border border-border bg-card overflow-hidden"
          style={{ flex: 4, minWidth: 0, minHeight: 0 }}
        >
          <Scroll class="flex-1" contentClass="p-3 pb-4">
            {renderTaskList()}
          </Scroll>
        </View>
        <View
          class="rounded-2xl border border-border bg-card overflow-hidden"
          style={{ flex: 6, minWidth: 0, minHeight: 0 }}
        >
          <Scroll class="flex-1" contentClass="p-4 pb-5">
            {renderTaskDetails()}
          </Scroll>
        </View>
      </View>
    </If>
  );
}
