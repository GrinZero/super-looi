import { t, translateMessage, formatDate } from "../i18n";
import { Text, View, Scroll, windowSize } from "nsh";
import type { createAppStore } from "../store";
import { ActionButton } from "./Controls";

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
                      {formatDate(item().updatedAt, { dateStyle: "short", timeStyle: "short" })}
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
                      label={t("viewDetails")}
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
              label={t("closeDetails")}
              compact={true}
              onPress={() => props.store.closeTask()}
            />
          </View>

          <If when={currentTask()?.state === "unknown"}>
            <View class="rounded-xl border border-destructive bg-muted p-3">
              <Text class="text-destructive text-xs font-medium">
                {t("theTaskEndedUnexpectedlyOrTimedOut")}</Text>
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
              <Text class="text-muted-foreground text-xs">{t("agentReply")}</Text>
              <View class="rounded-xl border border-border bg-muted p-3" selectable={true}>
                <Text class="text-foreground text-sm">
                  {currentTask()?.result?.answer}
                </Text>
              </View>
            </View>
          </If>

          <If when={(currentTask()?.steps.length ?? 0) > 0}>
            <View class="gap-1.5">
              <Text class="text-muted-foreground text-xs">{t("executionSteps")}</Text>
              <View class="gap-1.5">
                <Each of={currentTask()?.steps ?? []} key={(s) => String(s.step)}>
                  {(s) => (
                    <View class="rounded-xl border border-border bg-muted p-2.5 flex-row items-center justify-between">
                      <Text class="text-foreground text-xs">
                        {s().step}. {translateMessage(s().summary)}
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
              <Text class="text-muted-foreground text-xs">{t("shellCommandReceipts")}</Text>
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
