import { computed, Scroll, signal, Text, View, windowSize } from "nsh";
import { Button, Tab, Tabs, TextView } from "nsh/base";
import type { NativeTask, NativeTaskSummary } from "../generated/looi-runtime.js";
import { formatDate, t, translateMessage } from "../i18n";
import type { createAppStore } from "../store";
import { IconButton } from "./Controls";
import { RetainedPage } from "./RetainedPage";
import { TaskReceipts } from "./TaskReceipts";
import { TaskShellOutput } from "./TaskShellOutput";
import { TaskTraceView } from "./TaskTraceView";
import { traceText } from "./task-trace-model";

type TaskStore = Pick<
  ReturnType<typeof createAppStore>,
  "task" | "tasks" | "inspectTask" | "closeTask" | "refreshTasks" | "shellOutput"
>;

const pageSize = 10;
const panel = "min-w-0 min-h-0 rounded-2xl border border-border bg-card overflow-hidden";
const timestampStyle = { fontVariant: ["tabular-nums"] as ["tabular-nums"], numberOfLines: 1 };

function taskTitle(item: NativeTaskSummary): string {
  if (!item.voiceToolName) return item.prompt;
  const tool = item.voiceToolName;
  const label = tool === "control_home_device" ? t("taskVoiceHomeControl")
    : tool === "list_home_devices" ? t("taskVoiceHomeQuery")
    : tool === "control_looi_body" ? t("taskVoiceBodyControl")
    : t("taskVoiceTool", { name: tool });
  return item.prompt ? `${label} · ${item.prompt}` : label;
}

function taskStatus(state: string) {
  switch (state) {
    case "queued": return { label: t("queued"), dot: "bg-subtle-text", active: true };
    case "running": return { label: t("running"), dot: "bg-warning", active: true };
    case "awaiting_approval": return { label: t("awaitingApproval182"), dot: "bg-warning", active: true };
    case "awaiting_input": return { label: t("awaitingAnswer"), dot: "bg-warning", active: true };
    case "cancelling": return { label: t("stopping"), dot: "bg-warning", active: true };
    case "succeeded": return { label: t("completed"), dot: "bg-verified", active: false };
    case "failed": return { label: t("taskFailed"), dot: "bg-destructive", active: false };
    case "cancelled": return { label: t("stopped"), dot: "bg-subtle-text", active: false };
    case "needs_selection": return { label: t("taskNeedsSelection"), dot: "bg-warning", active: false };
    case "unknown": return { label: t("resultUnverified"), dot: "bg-destructive", active: false };
    default: return { label: t("stateUnverified"), dot: "bg-subtle-text", active: false };
  }
}

function TaskStatus(props: { state: string }) {
  const status = computed(() => taskStatus(props.state));
  return (
    <View class="min-w-0 flex-row items-center gap-1.5">
      <View class={`h-1.5 w-1.5 shrink-0 rounded-full ${status().dot}`} />
      <Text class="text-muted-foreground text-xs font-medium" style={{ numberOfLines: 1 }}>
        {status().label}
      </Text>
    </View>
  );
}

function TaskRow(props: {
  item: NativeTaskSummary;
  selected: boolean;
  onPress: () => void;
}) {
  const fullDate = () => formatDate(props.item.updatedAt, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const date = () => {
    const width = windowSize().width;
    return width >= 600 && width < 720
      ? formatDate(props.item.updatedAt, { month: "2-digit", day: "2-digit" })
      : fullDate();
  };
  return (
    <Button
      testID={`task-${props.item.id}`}
      accessibilityLabel={`${taskTitle(props.item)} · ${taskStatus(props.item.state).label} · ${fullDate()}`}
      selected={props.selected}
      onPress={props.onPress}
      class="min-h-14 rounded-xl border border-transparent px-3 py-2.5 justify-center gap-1.5 selected:bg-muted selected:border-border hover:bg-muted active:bg-accent focus-visible:border-ring transition-colors duration-120 motion-reduce:duration-0"
    >
      <View
        class={`absolute left-0 top-3 bottom-3 w-0.5 rounded-full ${props.selected ? "bg-primary" : "bg-transparent"}`}
        style={{ pointerEvents: "none" }}
      />
      <Text class="text-foreground text-sm font-semibold" style={{ numberOfLines: 2 }}>
        {taskTitle(props.item)}
      </Text>
      <View class="min-w-0 flex-row items-center justify-between gap-1.5">
        <TaskStatus state={props.item.state} />
        <Text class="text-muted-foreground text-xs shrink-0" style={timestampStyle}>{date()}</Text>
      </View>
    </Button>
  );
}

function TaskHistory(props: { store: TaskStore }) {
  const page = () => props.store.tasks();
  return (
    <View class={`${panel} flex-1`}>
      <View class="min-h-11 px-4 flex-row items-center justify-between gap-2 border-b border-border shrink-0">
        <Text class="text-foreground text-sm font-semibold" role="header">{t("taskHistory")}</Text>
        <Text class="text-muted-foreground text-xs" style={timestampStyle}>
          {t("taskHistoryTotal", { count: page().total })}
        </Text>
      </View>
      <If when={page().items.length > 0} else={
        <View class="flex-1 items-center justify-center px-4">
          <Text class="text-muted-foreground text-sm text-center">{t("noTaskHistoryYet")}</Text>
        </View>
      }>
        <Each of={[page().offset]} key={(offset) => offset}>
          {() => (
            <Scroll class="flex-1 min-h-0" contentClass="px-2 py-2 gap-1">
              <Each of={page().items} key={(item) => item.id}>
                {(item) => (
                  <TaskRow
                    item={item()}
                    selected={props.store.task()?.id === item().id}
                    onPress={() => props.store.inspectTask(item().id)}
                  />
                )}
              </Each>
            </Scroll>
          )}
        </Each>
      </If>
      <If when={page().total > pageSize}>
        <View class="px-2 py-1 border-t border-border flex-row items-center justify-between gap-2 shrink-0">
          <IconButton
            testID="tasks-prev"
            icon="move_left"
            label={t("previous")}
            kind="outline"
            disabled={page().offset === 0}
            onPress={() => props.store.refreshTasks(Math.max(0, page().offset - pageSize))}
          />
          <Text class="text-muted-foreground text-xs" style={timestampStyle}>
            {t("taskPagePosition", {
              page: Math.floor(page().offset / pageSize) + 1,
              pages: Math.ceil(page().total / pageSize),
            })}
          </Text>
          <IconButton
            testID="tasks-next"
            icon="move_right"
            label={t("next")}
            kind="outline"
            disabled={page().offset + pageSize >= page().total}
            onPress={() => props.store.refreshTasks(page().offset + pageSize)}
          />
        </View>
      </If>
    </View>
  );
}

type TaskSection = "overview" | "activity" | "receipts";

function TaskInspector(props: {
  task: NativeTask;
  output: ReturnType<TaskStore["shellOutput"]>;
  onBack?: () => void;
}) {
  const section = signal<TaskSection>("overview");
  const active = computed(() => taskStatus(props.task.state).active);
  const receiptCount = () =>
    (props.task.result?.executions?.length ?? 0) +
    (props.task.result?.artifacts?.length ?? 0) +
    props.task.homeActions.length +
    (props.task.bodyActions?.length ?? 0) +
    Number(props.task.voiceToolCall?.output !== undefined);
  const commandOutput = () => {
    const output = props.output;
    if (!output || output.taskId !== props.task.id) return;
    const archived = props.task.result?.executions?.some((receipt) => receipt.callId === output.callId);
    return archived ? undefined : output;
  };
  const sections = [
    { id: "overview", label: () => t("taskOverview") },
    { id: "activity", label: () => t("taskExecution") },
    { id: "receipts", label: () => t("taskReceipts") },
  ] as const;

  return (
    <View class="flex-1 min-h-0 min-w-0">
      <View class="min-h-11 px-4 flex-row items-center gap-2 min-w-0 shrink-0">
        <If when={Boolean(props.onBack)}>
          <IconButton testID="task-detail-close" icon="back" label={t("backToTaskList")} onPress={() => props.onBack?.()} />
        </If>
        <Text class="text-foreground text-sm font-semibold flex-1 min-w-0" role="header" style={{ numberOfLines: 1 }}>
          {taskTitle(props.task)}
        </Text>
        <View class="px-2.5 py-1 rounded-full bg-muted shrink-0">
          <TaskStatus state={props.task.state} />
        </View>
      </View>
      <Tabs
        class="flex-row px-3 border-b border-border shrink-0"
        indicatorClass="bottom-0 h-0.5 mx-1 bg-primary rounded-full"
      >
        <Each of={sections} key={(item) => item.id}>
          {(item) => (
            <Tab
              testID={`task-tab-${item().id}`}
              selected={section() === item().id}
              onPress={() => section.set(item().id)}
              class="group flex-1 min-w-0 min-h-12 px-1 border border-transparent rounded-t-lg flex-row items-center justify-center gap-1 hover:bg-muted active:bg-accent focus-visible:border-ring"
            >
              <Text class="min-w-0 text-muted-foreground text-sm font-semibold group-selected:text-foreground" style={{ numberOfLines: 1 }}>
                {item().label()}
              </Text>
              <If when={item().id === "receipts" && receiptCount() > 0}>
                <Text class="text-muted-foreground text-xs shrink-0" style={timestampStyle}>{receiptCount()}</Text>
              </If>
            </Tab>
          )}
        </Each>
      </Tabs>
      <RetainedPage active={section() === "overview"}>
        <Scroll class="flex-1 min-h-0" contentClass="px-4 py-3 gap-4">
          <If when={Boolean(props.task.error)}>
            <View class="rounded-xl border border-destructive bg-muted px-3 py-2.5 gap-1" selectable={true}>
              <Text class="text-destructive text-xs font-semibold" role="header">{t("traceError")}</Text>
              <Text class="text-foreground text-sm">{translateMessage(props.task.error ?? "")}</Text>
            </View>
          </If>
          <If when={Boolean(props.task.result?.answer)} else={
            <If when={!props.task.error && (!props.task.voiceToolCall || active())}>
              <Text class="text-muted-foreground text-sm">
                {active() ? t("taskResultPending") : t("taskNoAnswer")}
              </Text>
            </If>
          }>
            <View class="gap-2 min-w-0">
              <Text class="text-foreground text-sm font-semibold" role="header">{t("taskAnswer")}</Text>
              <TextView class="text-foreground text-base" markdown={props.task.result?.answer} links="open" selectable={true} />
            </View>
          </If>
          <View class="gap-2 border-t border-border pt-3 min-w-0">
            <Text class="text-foreground text-sm font-semibold" role="header">{t(props.task.voiceToolCall ? "traceInput" : "taskRequest")}</Text>
            <View selectable={true}>
              <Text class={props.task.voiceToolCall ? "text-foreground text-xs font-mono" : "text-foreground text-sm"}>
                {props.task.voiceToolCall ? traceText(props.task.voiceToolCall.input) : props.task.prompt}
              </Text>
            </View>
          </View>
          <View class="gap-1.5 border-t border-border pt-3 min-w-0" selectable={true}>
            <Text class="text-muted-foreground text-xs">
              {t("taskUpdatedAt", { time: formatDate(props.task.updatedAt, { dateStyle: "medium", timeStyle: "medium" }) })}
            </Text>
            <Text class="text-muted-foreground text-xs font-mono">{t("taskIdentifier", { id: props.task.id })}</Text>
          </View>
        </Scroll>
      </RetainedPage>
      <RetainedPage active={section() === "activity"}>
        <Scroll class="flex-1 min-h-0" contentClass="px-4 py-3 gap-4">
          <TaskShellOutput output={commandOutput()} taskId={props.task.id} live={active()} />
          <TaskTraceView task={props.task} />
        </Scroll>
      </RetainedPage>
      <RetainedPage active={section() === "receipts"}>
        <Scroll class="flex-1 min-h-0" contentClass="px-4 py-3 gap-3">
          <TaskReceipts task={props.task} count={receiptCount()} />
        </Scroll>
      </RetainedPage>
    </View>
  );
}

export function TasksSpaceView(props: { store: TaskStore }) {
  const wide = () => windowSize().width >= 600;
  const currentTask = () => props.store.task();
  const selected = computed(() => {
    const task = currentTask();
    return task ? [task] : [];
  });

  return (
    <View class="flex-1 flex-row gap-3 min-h-0 min-w-0">
      <View
        class="min-w-0 min-h-0"
        style={{ flex: wide() ? 4 : 1, display: wide() || !currentTask() ? "flex" : "none" }}
      >
        <TaskHistory store={props.store} />
      </View>
      <If when={wide() || Boolean(currentTask())}>
        <View class={panel} style={{ flex: wide() ? 8 : 1 }}>
          <If when={Boolean(currentTask())} else={
            <View class="flex-1 items-center justify-center px-4">
              <Text class="text-muted-foreground text-sm text-center">
                {t(props.store.tasks().total ? "taskSelectFromHistory" : "taskEmptyDescription")}
              </Text>
            </View>
          }>
            <Each of={selected()} key={(task) => task.id}>
              {(task) => (
                <TaskInspector
                  task={task()}
                  output={props.store.shellOutput()}
                  onBack={wide() ? undefined : () => props.store.closeTask()}
                />
              )}
            </Each>
          </If>
        </View>
      </If>
    </View>
  );
}
