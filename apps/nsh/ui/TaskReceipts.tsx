import { signal, Text, View, type JSX } from "nsh";
import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, AccordionTrigger } from "nsh/base";
import type { NativeTask } from "../generated/looi-runtime.js";
import { formatDate, t } from "../i18n";

function ReceiptItem(props: {
  id: string;
  title: string;
  summary: string;
  expanded: boolean;
  monospace?: boolean;
  children?: JSX.Element;
}) {
  return (
    <AccordionItem value={props.id} class="rounded-xl border border-border bg-background min-w-0">
      <AccordionHeader>
        <AccordionTrigger
          testID={props.id}
          class="min-h-12 px-3 py-2 flex-row items-center gap-3 rounded-xl border border-transparent active:bg-accent hover:bg-muted focus-visible:border-ring"
        >
          <Text class="w-4 shrink-0 text-muted-foreground text-sm">
            {props.expanded ? "−" : "+"}
          </Text>
          <View class="gap-1 flex-1 min-w-0">
            <Text
              class={props.monospace ? "text-foreground text-sm font-mono" : "text-foreground text-sm font-medium"}
              style={{ numberOfLines: 2 }}
            >
              {props.title}
            </Text>
            <Text class="text-muted-foreground text-xs">{props.summary}</Text>
          </View>
        </AccordionTrigger>
      </AccordionHeader>
      <AccordionPanel>
        <View class="px-3 pb-3 pt-1 gap-3 min-w-0" selectable={true}>{props.children}</View>
      </AccordionPanel>
    </AccordionItem>
  );
}

function ReceiptData(props: { label: string; value: string }) {
  return (
    <View class="gap-1.5 min-w-0">
      <Text class="text-muted-foreground text-xs font-medium">{props.label}</Text>
      <Text class="text-foreground text-xs font-mono">{props.value}</Text>
    </View>
  );
}

export function TaskReceipts(props: { task: NativeTask; count: number }) {
  const expanded = signal<string[]>([]);
  const executions = () => props.task.result?.executions ?? [];
  const artifacts = () => props.task.result?.artifacts ?? [];
  const bodyActions = () => props.task.bodyActions ?? [];

  return (
    <If when={props.count > 0} else={
      <Text class="text-muted-foreground text-sm">{t("taskNoReceipts")}</Text>
    }>
      <Accordion multiple={true} value={expanded()} onChange={(event) => expanded.set(event.value)} class="gap-4 min-w-0">
        <If when={executions().length > 0}>
          <View class="gap-2 min-w-0">
            <Text class="text-foreground text-sm font-semibold" role="header">{t("shellCommandReceipts")}</Text>
            <Each of={executions()} key={(execution) => execution.callId}>
              {(execution) => {
                const id = () => `receipt-command-${execution().callId}`;
                const exit = () => [
                  t("taskExitCode", { code: execution().exitCode ?? t("unknown") }),
                  execution().signal,
                  execution().timedOut ? t("taskCommandTimedOut") : "",
                  execution().aborted ? t("taskCommandAborted") : "",
                ].filter(Boolean).join(" · ");
                return (
                  <ReceiptItem id={id()} title={`$ ${execution().command}`} summary={exit()} expanded={expanded().includes(id())} monospace={true}>
                    <ReceiptData label={t("taskCommand")} value={execution().command} />
                    <If when={Boolean(execution().stdout)}>
                      <ReceiptData label="stdout" value={execution().stdout!} />
                    </If>
                    <If when={Boolean(execution().stderr)}>
                      <ReceiptData label="stderr" value={execution().stderr!} />
                    </If>
                    <If when={!execution().stdout && !execution().stderr}>
                      <Text class="text-muted-foreground text-xs">{t("taskCommandNoOutput")}</Text>
                    </If>
                  </ReceiptItem>
                );
              }}
            </Each>
          </View>
        </If>
        <If when={artifacts().length > 0}>
          <View class="gap-2 min-w-0">
            <Text class="text-foreground text-sm font-semibold" role="header">{t("taskArtifacts")}</Text>
            <Each of={artifacts()} key={(artifact) => artifact.path}>
              {(artifact) => {
                const id = () => `receipt-artifact-${artifact().path}`;
                return (
                  <ReceiptItem id={id()} title={artifact().path} summary={`${artifact().size} B`} expanded={expanded().includes(id())} monospace={true}>
                    <ReceiptData label={t("taskFilePath")} value={artifact().path} />
                    <ReceiptData label="SHA-256" value={artifact().sha256} />
                  </ReceiptItem>
                );
              }}
            </Each>
          </View>
        </If>
        <If when={props.task.homeActions.length > 0}>
          <View class="gap-2 min-w-0">
            <Text class="text-foreground text-sm font-semibold" role="header">{t("homeActionReceipts")}</Text>
            <Each of={props.task.homeActions} key={(action) => action.requestId}>
              {(action) => {
                const id = () => `receipt-home-${action().requestId}`;
                const title = () => {
                  const target = action().command.entity_id;
                  return typeof target === "string" ? target : action().requestId;
                };
                const summary = () => [action().command.service, action().status]
                  .filter((value): value is string => typeof value === "string" && value.length > 0)
                  .join(" · ");
                return (
                  <ReceiptItem id={id()} title={title()} summary={summary()} expanded={expanded().includes(id())} monospace={true}>
                    <ReceiptData label={t("traceRaw")} value={JSON.stringify(action(), null, 2)} />
                  </ReceiptItem>
                );
              }}
            </Each>
          </View>
        </If>
        <If when={bodyActions().length > 0}>
          <View class="gap-2 min-w-0">
            <Text class="text-foreground text-sm font-semibold" role="header">{t("bodyActionReceipts")}</Text>
            <Each of={bodyActions()} key={(action) => action.requestId}>
              {(action) => {
                const id = () => `receipt-body-${action().requestId}`;
                return (
                  <ReceiptItem
                    id={id()}
                    title={action().command.action}
                    summary={`${action().status} · ${formatDate(action().recordedAt, { timeStyle: "medium" })}`}
                    expanded={expanded().includes(id())}
                    monospace={true}
                  >
                    <ReceiptData label={t("traceRaw")} value={JSON.stringify(action(), null, 2)} />
                  </ReceiptItem>
                );
              }}
            </Each>
          </View>
        </If>
      </Accordion>
    </If>
  );
}
