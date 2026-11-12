import { t, formatDate, translateMessage } from "../i18n";
import { Text, View, Scroll, windowSize } from "nsh";
import { Button, TextView } from "nsh/base";
import type { createAppStore } from "../store";
import { TaskShellOutput } from "./TaskShellOutput";
import { ActionButton } from "./Controls";
import { TaskTraceView } from "./TaskTraceView";

export function taskStateLabel(state: string, reviewedAt?: string): string {
  if (state === "unknown" && reviewedAt) return t("taskReviewed");
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

export function TasksSpaceView(props: {
  store: Pick<ReturnType<typeof createAppStore>, "task" | "tasks" | "recoveryCount" | "inspectTask" | "reviewTask" | "closeTask" | "refreshTasks" | "shellOutput">;
}) {
  const currentTask = () => props.store.task();

  const sortedItems = () => {
    const raw = props.store.tasks().items;
    return [...raw].sort((a, b) => {
      return Number(b.needsReview) - Number(a.needsReview);
    });
  };

  const renderTaskList = () => (
    <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
      <View class="flex-row items-center justify-between border-b border-border pb-2.5">
        <View class="gap-0.5">
          <Text class="text-foreground text-sm font-semibold">{t("taskActivity")}</Text>
          <Text class="text-muted-foreground text-xs">
            {t("taskCount", { count: props.store.tasks().total })}</Text>
        </View>
        <If when={props.store.recoveryCount() > 0}>
          <View class="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full bg-destructive">
            <Text class="text-primary-foreground text-xs font-semibold">
              {t("recoveryCount", { count: props.store.recoveryCount() })}</Text>
          </View>
        </If>
      </View>

      <If
        when={props.store.tasks().total > 0}
        else={
          <View class="py-8 items-center justify-center">
            <Text class="text-muted-foreground text-xs">{t("noTaskHistoryYet")}</Text>
          </View>
        }
      >
        <View class="gap-2">
          <Each of={sortedItems()} key={(item) => item.id}>
            {(item) => {
              const isSelected = () => currentTask()?.id === item().id;
              const isUnknown = () => item().needsReview;

              return (
                <Button
                  testID={`task-${item().id}`}
                  selected={isSelected()}
                  onPress={() => props.store.inspectTask(item().id)}
                  class={
                    isSelected()
                      ? "rounded-xl bg-muted p-3 gap-2 min-h-11 active:opacity-70 focus:border-ring"
                      : "rounded-xl bg-card p-3 gap-2 min-h-11 active:bg-muted focus:border-ring"
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
                      {taskStateLabel(item().state, item().reviewedAt)}
                    </Text>
                    <Text class="text-muted-foreground text-xs font-mono">
                      {formatDate(item().updatedAt, { dateStyle: "short", timeStyle: "short" })}
                    </Text>
                  </View>
                  <Text
                    class="text-foreground text-sm font-medium"
                    style={{ numberOfLines: 2 }}
                  >
                    {item().prompt}
                  </Text>
                </Button>
              );
            }}
          </Each>
        </View>
      </If>

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
          <Text class="text-muted-foreground text-xs font-mono">
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
  );

  const renderTaskDetails = () => (
    <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
      <If
        when={Boolean(currentTask())}
        else={
          <View class="py-12 items-center justify-center gap-2">
            <Text class="text-foreground text-sm font-semibold">
              {t("inspectActivityReceipts")}</Text>
            <Text class="text-muted-foreground text-xs text-center">
              {t("selectATaskToInspectItsSteps")}</Text>
          </View>
        }
      >
        <View class="gap-3">
          <View class="flex-row items-center justify-between border-b border-border pb-2.5">
            <View class="flex-1 min-w-0 gap-1">
              <Text
                class={
                  currentTask()?.needsReview
                    ? "text-destructive text-sm font-bold"
                    : "text-foreground text-sm font-semibold"
                }
              >
                {taskStateLabel(currentTask()?.state ?? "unknown", currentTask()?.reviewedAt)}
              </Text>
              <Text class="text-muted-foreground text-xs font-mono" style={{ numberOfLines: 1 }}>
                {currentTask()?.id}
              </Text>
            </View>
            <ActionButton
              testID="task-detail-close"
              label={t("closeDetails")}
              compact={true}
              onPress={() => props.store.closeTask()}
            />
          </View>

          <If when={currentTask()?.needsReview}>
            <View class="gap-2.5">
              <Text class="text-muted-foreground text-xs">
                {t("taskReviewHelp")}
              </Text>
              <ActionButton
                testID="review-task-btn"
                label={t("markTaskReviewed")}
                kind="primary"
                compact={true}
                onPress={() => {
                  const id = currentTask()?.id;
                  if (id) props.store.reviewTask(id);
                }}
              />
            </View>
          </If>
          <If when={Boolean(currentTask()?.reviewedAt)}>
            <Text class="text-muted-foreground text-xs">
              {t("taskReviewedAt", { time: formatDate(currentTask()?.reviewedAt ?? "", {
                dateStyle: "short", timeStyle: "short",
              }) })}
            </Text>
          </If>
          <If when={Boolean(currentTask()?.error)}>
            <View class="min-w-0" selectable={true}>
              <Text class="text-destructive text-xs">{translateMessage(currentTask()?.error ?? "")}</Text>
            </View>
          </If>

          <View class="gap-1">
            <Text class="text-muted-foreground text-xs">{t("yourRequest")}</Text>
            <View class="rounded-xl border border-border bg-muted p-3" selectable={true}>
              <Text class="text-foreground text-sm font-medium">
                {currentTask()?.prompt}
              </Text>
            </View>
          </View>

          <If when={Boolean(currentTask()?.result?.answer)}>
            <View class="gap-1">
              <Text class="text-muted-foreground text-xs">{t("traceFinalAnswer")}</Text>
              <View class="rounded-xl border border-border bg-muted p-3" selectable={true}>
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
            <View class="gap-1.5">
              <Text class="text-muted-foreground text-xs">{t("shellCommandReceipts")}</Text>
              <View class="gap-1.5">
                <Each
                  of={currentTask()?.result?.executions ?? []}
                  key={(e) => e.callId}
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
                      <If when={Boolean(e().stdout)}><Text class="text-foreground text-xs font-mono">{e().stdout}</Text></If>
                      <If when={Boolean(e().stderr)}><Text class="text-muted-foreground text-xs font-mono">{e().stderr}</Text></If>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          </If>

          <If when={(currentTask()?.result?.artifacts?.length ?? 0) > 0}>
            <View class="gap-1.5">
              <Text class="text-muted-foreground text-xs">{t("artifactSha256Hashes")}</Text>
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
              <Text class="text-muted-foreground text-xs">{t("homeActionReceipts")}</Text>
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

          <If when={(currentTask()?.bodyActions?.length ?? 0) > 0}>
            <View class="gap-1.5">
              <Text class="text-muted-foreground text-xs">{t("bodyActionReceipts")}</Text>
              <View class="gap-1.5">
                <Each
                  of={currentTask()?.bodyActions ?? []}
                  key={(ba) => ba.requestId}
                >
                  {(ba) => (
                    <View class="rounded-xl border border-border bg-muted p-3 gap-1 font-mono">
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
                label={t("backToTaskList")}
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
        <View style={{ flex: 3, minWidth: 0, minHeight: 0 }}>
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
