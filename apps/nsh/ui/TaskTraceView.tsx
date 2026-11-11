import { signal, Text, View } from "nsh";
import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, AccordionTrigger } from "nsh/base";
import type { NativeObservation, NativeTask } from "../generated/looi-runtime.js";
import { t, formatDate, translateMessage } from "../i18n";
import { contextMessages, traceError, traceInput, traceOutput, tracePreview, traceRows, traceState, traceText } from "./task-trace-model";

function nodeTitle(node: NativeObservation): string {
  const names: Record<string, string> = {
    "voice.session": t("traceVoiceSession"), "realtime.handshake": t("traceConnection"),
    "realtime.user_turn": t("traceUserSpeech"), "realtime.response": t("traceVoiceResponse"),
    "realtime.context": t("traceVoiceContext"), "realtime.tool_call": t("traceDelegation"),
    "realtime.cancel": t("stopping"), "realtime.error": t("traceError"),
    "agent.run": t("traceTask"), "agent.context": t("traceHistory"), "llm.chat": t("traceGeneration"),
    "agent.approval": t("traceApproval"), "agent.question": t("traceQuestion"),
    "voice.notice": t("traceNotice"), "voice.delivery": t("traceDelivery"),
  };
  return names[node.name] ?? node.name.replace(/^agent\.tool\./, "");
}

function TraceData(props: { label: string; value: unknown; json?: boolean }) {
  return (
    <If when={props.value !== undefined}>
      <View class="gap-1.5 min-w-0">
        <Text class="text-muted-foreground text-xs font-medium">{props.label}</Text>
        <View class="bg-muted rounded-lg p-3 min-w-0" selectable={true}>
          <Text class={props.json ? "text-foreground text-xs font-mono" : "text-foreground text-sm"}>
            {props.json ? JSON.stringify(props.value, null, 2) : traceText(props.value)}
          </Text>
        </View>
      </View>
    </If>
  );
}

function NodeDetails(props: { node: NativeObservation }) {
  const raw = signal<string[]>([]);
  const messages = () => contextMessages(traceInput(props.node));
  const input = () => traceInput(props.node) as Record<string, unknown> | undefined;
  const hosted = () => props.node.name === "agent.tool.web_search";
  return (
    <View class="gap-4 pb-4 min-w-0">
      <If when={messages().length > 0} else={<TraceData label={t("traceInput")} value={traceInput(props.node)} />}>
        <View class="gap-2">
          <Text class="text-muted-foreground text-xs font-medium">{t(props.node.attributes["langfuse.observation.metadata.inputKind"] === "observed_transcripts" ? "traceObservedMessages" : "traceInputMessages", { count: messages().length })}</Text>
          <Each of={messages().map((message, index) => ({ ...message, id: String(index) }))} key={message => message.id}>
            {(message) => (
              <View class="gap-1 bg-muted rounded-lg p-3 min-w-0" selectable={true}>
                <Text class="text-muted-foreground text-xs font-mono">{message().role}</Text>
                <Text class="text-foreground text-sm">{traceText(message().content)}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
      <If when={props.node.name === "agent.context"}>
        <TraceData label={t("traceSystemPrompt")} value={input()?.systemPrompt} />
        <TraceData label={t("traceCurrentPrompt")} value={input()?.userPrompt} />
      </If>
      <If when={hosted()}>
        <Text class="text-muted-foreground text-xs">{t("traceHostedSearchDetail")}</Text>
      </If>
      <TraceData label={hosted() ? t("traceSearchAction") : props.node.type === "generation" ? t("traceModelOutput") : t("traceOutput")} value={traceOutput(props.node)} />
      <TraceData label={t("traceError")} value={traceError(props.node)} />
      <If when={props.node.attributes["langfuse.observation.usage_details"] !== undefined}>
        <TraceData label={t("traceUsage")} value={props.node.attributes["langfuse.observation.usage_details"]} />
      </If>
      <Accordion value={raw()} onChange={event => raw.set(event.value)}>
        <AccordionItem value="raw">
          <AccordionHeader>
            <AccordionTrigger class="min-h-11 flex-row items-center gap-2 rounded-lg px-2 active:bg-muted focus:bg-muted">
              <Text class="text-muted-foreground text-xs">{t("traceRaw")}</Text>
              <Text class="text-muted-foreground text-xs">{raw().length ? "−" : "+"}</Text>
            </AccordionTrigger>
          </AccordionHeader>
          <AccordionPanel accessibilityLabel={t("traceRaw")}>
            <TraceData label={`${props.node.traceId} / ${props.node.spanId}`} value={props.node} json={true} />
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </View>
  );
}

/** Read-only inspector; every retained row is one recorded span. */
export function TaskTraceView(props: { task: NativeTask }) {
  const expanded = signal<string[]>([]);
  const rows = () => traceRows(props.task.observations ?? []);
  const history = () => props.task.observations?.find(node => node.name === "agent.context" && node.parentSpanId === props.task.trace?.spanId);
  const stateLabel = (node: NativeObservation) => {
    const state = traceState(node);
    return state === "active" ? t("traceActive") : state === "error" ? t("traceFailed") : state === "cancelled" ? t("stopped") : state === "interrupted" ? t("traceInterrupted") : t("traceEnded");
  };
  return (
    <View class="gap-4 min-w-0" testID="task-trace">
      <View class="gap-1">
        <Text class="text-foreground text-base font-semibold" role="header">{t("traceChain")}</Text>
        <If when={Boolean(history())}>
          <Text class="text-muted-foreground text-xs">{t("traceHistoryCount", { count: Number((history() ? traceOutput(history()!) as { historyMessages: number } : undefined)?.historyMessages ?? 0) })}</Text>
        </If>
      </View>
      <If when={rows().length > 0} else={
        <View class="gap-3">
          <Text class="text-muted-foreground text-sm">{t("traceMissing")}</Text>
          <Each of={props.task.steps.map((step, index) => ({ ...step, id: `${props.task.id}:${index}` }))} key={step => step.id}>
            {step => <Text class="text-muted-foreground text-xs">{translateMessage(step().summary)}</Text>}
          </Each>
        </View>
      }>
        <Accordion multiple={true} value={expanded()} onChange={event => expanded.set(event.value)} class="min-w-0">
          <Each of={rows()} key={row => row.node.spanId}>
            {row => (
              <AccordionItem value={row().node.spanId} class="border-b border-border min-w-0">
                <AccordionHeader>
                  <AccordionTrigger testID={`trace-${row().node.spanId}`} class="min-h-11 flex-row items-start gap-2 py-3 rounded-lg active:bg-muted focus:bg-muted" style={{ paddingLeft: row().depth * 12 }}>
                    <Text class="text-muted-foreground text-sm w-4">{expanded().includes(row().node.spanId) ? "−" : "+"}</Text>
                    <View class="flex-1 min-w-0 gap-1">
                      <View class="flex-row items-center gap-2">
                        <Text class="text-foreground text-sm font-medium">{nodeTitle(row().node)}</Text>
                        <If when={row().node.spanId === props.task.trace?.spanId}>
                          <Text class="text-foreground text-xs font-semibold">{t("traceCurrentTask")}</Text>
                        </If>
                      </View>
                      <Text class="text-muted-foreground text-xs" style={{ numberOfLines: 2 }}>{row().node.name === "agent.context" ? t("traceHistoryCount", { count: Number(tracePreview(row().node)) }) : tracePreview(row().node)}</Text>
                      <Text class="text-muted-foreground text-xs font-mono">{formatDate(row().node.startedAt, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}{row().node.endedAt === undefined ? "" : ` · ${row().node.endedAt! - row().node.startedAt} ms`}</Text>
                    </View>
                    <Text class={traceState(row().node) === "error" ? "text-destructive text-xs" : "text-muted-foreground text-xs"}>{stateLabel(row().node)}</Text>
                  </AccordionTrigger>
                </AccordionHeader>
                <AccordionPanel accessibilityLabel={nodeTitle(row().node)}>
                  <NodeDetails node={row().node} />
                </AccordionPanel>
              </AccordionItem>
            )}
          </Each>
        </Accordion>
      </If>
    </View>
  );
}
