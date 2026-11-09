import { TaskShellOutput } from "./TaskShellOutput";
import { t, translateMessage, formatDate } from "../i18n";
import { Text, View } from "nsh";
import type { createAppStore } from "../store";
import { ActionButton, Panel } from "./Controls";

export function taskState(state: string): string {
  return (
    (
      {
        queued: t("queued"),
        running: t("running"),
        awaiting_approval: t("awaitingApproval"),
        awaiting_input: t("awaitingYourAnswer"),
        cancelling: t("stopping"),
        succeeded: t("completed"),
        failed: t("incomplete"),
        cancelled: t("stopped"),
        unknown: t("resultUnverified"),
      } as Record<string, string>
    )[state] ?? t("stateUnverified")
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
      title={props.store.task() ? t("taskDetails") : t("taskHistory")}
      height={560}
      wide={true}
      onClose={props.onClose}
    >
      <If
        when={props.store.task()}
        else={
          <View class="gap-4">
            <Text class="text-muted-foreground text-sm">
              {t("unverifiedTasksAppearFirstANewConversation")}</Text>
            <View class="flex-row gap-2">
              <ActionButton
                label={t("newConversation")}
                disabled={props.store.busy()}
                onPress={props.onNewConversation}
              />
              <ActionButton
                label={t("refresh")}
                onPress={() =>
                  props.store.refreshTasks(props.store.tasks().offset)
                }
              />
            </View>
            <If when={!props.store.tasks().total}>
              <Text class="text-muted-foreground text-base">
                {t("noTasksYet")}</Text>
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
                    {formatDate(item().updatedAt, { dateStyle: "short", timeStyle: "short" })}
                  </Text>
                  <Text class="text-foreground text-base">{item().prompt}</Text>
                  <ActionButton
                    label={t("viewDetails")}
                    testID={`task-${item().id}`}
                    onPress={() => props.store.inspectTask(item().id)}
                  />
                </View>
              )}
            </Each>
            <If when={props.store.tasks().total > 10}>
              <View class="flex-row items-center justify-between gap-2">
                <ActionButton
                  label={t("previous")}
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
                  label={t("next")}
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
            label={t("backToTaskHistory")}
            onPress={() => props.store.closeTask()}
          />
          <Text class="text-foreground text-lg font-semibold">
            {taskState(props.store.task()?.state ?? "unknown")}
          </Text>
          <If when={props.store.task()?.state === "unknown"}>
            <Text class="text-destructive text-sm">
              {t("thePreviousActionsOutcomeIsUnknownCheck")}</Text>
          </If>
          <View selectable={true} class="gap-3">
            <Text class="text-muted-foreground text-xs">
              {props.store.task()?.id}
            </Text>
            <Text class="text-foreground text-base">
              {props.store.task()?.prompt}
            </Text>
            <If when={translateMessage(props.store.task()?.error ?? "")}>
              <Text class="text-destructive text-sm">
                {translateMessage(props.store.task()?.error ?? "")}
              </Text>
            </If>
            <If when={props.store.task()?.result?.answer}>
              <Text class="text-foreground text-base">
                {props.store.task()?.result?.answer}
              </Text>
            </If>
            <Text class="text-muted-foreground text-sm">
              {props.store.task()?.runtimeExited
                ? t("executorExited")
                : t("executorExitUnconfirmed")}
            </Text>
            <If when={props.store.task()?.homeActions.length}>
              <Text class="text-muted-foreground text-sm">
                {t("homeActionsAndReceiptsUnknownMeansUnverified")}</Text>
              <Text class="text-foreground text-sm">
                {JSON.stringify(props.store.task()?.homeActions, null, 2)}
              </Text>
            </If>
            <TaskShellOutput output={props.store.shellOutput()} taskId={props.store.task()?.id} />
            <Text class="text-muted-foreground text-sm">{t("executionLog")}</Text>
            <Text class="text-foreground text-sm">
              {props.store
                .task()
                ?.steps.map((step) => `${step.step}. ${translateMessage(step.summary)}`)
                .join("\n") || t("noExecutionLogAvailable")}
            </Text>
            <If when={props.store.task()?.result?.executions?.length}>
              <Each of={props.store.task()?.result?.executions ?? []} key={(e) => e.callId}>
                {(e) => <View class="gap-1" selectable={true}>
                  <Text class="text-foreground text-xs font-mono">{t("commandReceipt", {command:e().command,code:e().exitCode ?? t("unknown"),signal:e().signal ?? t("none")})}</Text>
                  <If when={Boolean(e().stdout)}><Text class="text-foreground text-xs font-mono">{e().stdout}</Text></If>
                  <If when={Boolean(e().stderr)}><Text class="text-muted-foreground text-xs font-mono">{e().stderr}</Text></If>
                </View>}
              </Each>
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
