import { Text, View } from "nsh";
import { t, translateMessage } from "../i18n";

/** The store owns the bounded, transient buffer; task history owns receipts. */
export function TaskShellOutput(props: { output?: {taskId:string;command:string;text:string;status:string}; taskId?: string }) {
  return <If when={props.output?.taskId === props.taskId && Boolean(props.output)}>
    <View class="gap-1.5">
      <Text class="text-muted-foreground text-xs">{t("shellLiveOutput")}</Text>
      <View class="rounded-xl border border-border bg-muted p-3 gap-1" selectable={true}>
        <Text class="text-foreground text-xs font-mono">$ {props.output?.command}</Text>
        <If when={Boolean(props.output?.status)}>
          <Text class="text-muted-foreground text-xs">{translateMessage(props.output?.status ?? "")}</Text>
        </If>
        <If when={Boolean(props.output?.text)}>
          <Text class="text-foreground text-xs font-mono">{props.output?.text}</Text>
        </If>
      </View>
    </View>
  </If>;
}
