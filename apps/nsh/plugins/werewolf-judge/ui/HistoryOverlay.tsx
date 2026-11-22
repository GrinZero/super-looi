import { cleanup, effect, reduceMotion, safeAreaInsets, signal, Text, View } from "nsh";
import { Button, Dialog } from "nsh/base";
import { formatDate } from "../../../i18n";
import { LoadingIndicator } from "../../../ui/Controls";
import type { PluginViewContext } from "../../../ui/plugins/ui-contracts";
import type {
  WerewolfCommand,
  WerewolfMatchRecord,
  WerewolfMatchSummary,
  WerewolfPublicState,
  WerewolfReplaySource,
} from "../contracts";
import {
  formatBoardLabel,
  type HistoryOrigin,
  WEREWOLF_HISTORY_TITLE,
  WerewolfHistoryHeader,
  WerewolfHistoryView,
} from "./HistoryView";
import { WerewolfReplayView } from "./ReplayView";
import { readWerewolfState } from "./StageCapsule";

export type WerewolfHistoryRoute =
  | { readonly view: "history"; readonly origin: HistoryOrigin }
  | { readonly view: "current" };

type ReplaySelection =
  | { readonly source: WerewolfReplaySource; readonly status: "loading" }
  | { readonly source: WerewolfReplaySource; readonly status: "failed"; readonly error: string }
  | { readonly source: WerewolfReplaySource; readonly status: "ready"; readonly record: WerewolfMatchRecord; readonly historyVersion: number };

export function WerewolfHistoryOverlay(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
  route: WerewolfHistoryRoute | null;
  onClose: () => void;
}) {
  const insets = safeAreaInsets();
  const selection = signal<ReplaySelection | null>(null);
  const removing = signal<WerewolfMatchSummary | null>(null);
  const deleteError = signal("");
  let readSequence = 0;
  let pendingRead: number | null = null;
  let alive = true;

  const st = () => readWerewolfState(props.ctx);
  const locale = () => props.ctx.locale();
  const t = (chinese: string, english: string) => locale() === "en-US" ? english : chinese;
  const replayTitle = () => t("对局复盘", "Match Replay");
  const deleteTitle = () => t("删除记录", "Delete Record");
  const readySelection = () => {
    const current = selection();
    return current?.status === "ready" ? current : null;
  };
  const readError = () => {
    const failure = props.ctx.lastError();
    return failure
      ? `[${failure.stage} · ${failure.code ?? ""}] ${failure.reason}`
      : props.ctx.uiError();
  };

  const readMatch = async (source: WerewolfReplaySource, refresh = false) => {
    const request = ++readSequence;
    pendingRead = request;
    const historyVersion = st().matchHistoryVersion;
    if (!refresh) selection.set({ source, status: "loading" });
    const record = await props.ctx.sendCommand<WerewolfMatchRecord>({ type: "read_match_replay", source });
    if (pendingRead === request) pendingRead = null;
    if (!alive || request !== readSequence) return;
    if (record) {
      selection.set({ source, status: "ready", record, historyVersion });
    } else {
      selection.set({
        source,
        status: "failed",
        error: readError() || t("暂时无法读取这局，请重试。", "The match could not be read. Try again."),
      });
    }
  };

  const clearSelection = () => {
    readSequence += 1;
    selection.set(null);
  };

  effect(() => {
    const route = props.route;
    clearSelection();
    removing.set(null);
    deleteError.set("");
    if (route?.view === "current") {
      const request = readSequence;
      void Promise.resolve().then(() => {
        if (alive && request === readSequence) return readMatch({ current: true });
      });
    }
  });
  effect(() => {
    const active = readySelection();
    if (!active || "current" in active.source || active.historyVersion === st().matchHistoryVersion) return;
    // The host clears busy before the read promise delivers its result.
    if (props.ctx.busy() || !props.ctx.enabled() || pendingRead !== null) return;
    const request = readSequence;
    void Promise.resolve().then(() => {
      if (alive && request === readSequence && pendingRead === null && !props.ctx.busy()) {
        return readMatch(active.source, true);
      }
    });
  });
  cleanup(() => { alive = false; });

  const back = () => {
    if (props.route?.view === "history" && selection()) clearSelection();
    else props.onClose();
  };

  const openRecord = (summary: WerewolfMatchSummary) => {
    const source = { matchId: summary.id };
    if (props.ctx.enabled()) void readMatch(source);
    else selection.set({ source, status: "ready", record: summary, historyVersion: st().matchHistoryVersion });
  };

  const deleteRecord = async (matchId: string) => {
    deleteError.set("");
    const result = await props.ctx.sendCommand({ type: "delete_match_record", matchId });
    if (!alive || removing()?.id !== matchId) return;
    if (result) removing.set(null);
    else deleteError.set(readError() || t("暂时无法删除这局，请重试。", "The match could not be deleted. Try again."));
  };

  return (
    <Dialog
      testID="werewolf-history-page"
      open={Boolean(props.route)}
      presentation="fullScreen"
      animation={reduceMotion() ? "none" : "fade"}
      accessibilityLabel={props.route?.view === "current" || selection() ? replayTitle() : WEREWOLF_HISTORY_TITLE[locale()]}
      closeOnEscape={false}
      closeOnSwipe={false}
      closeOnBackdropPress={false}
      onCancel={back}
      class="flex-1 w-full h-full bg-stage-bg"
    >
      <View class="flex-1 min-h-0" style={{
        paddingTop: insets().top,
        paddingBottom: insets().bottom,
        paddingLeft: insets().left,
        paddingRight: insets().right,
      }}>
        <If when={props.route?.view === "history"}>
          <View class="flex-1 min-h-0" style={{ display: selection() ? "none" : "flex" }}>
            <WerewolfHistoryView
              locale={locale()}
              origin={props.route?.view === "history" ? props.route.origin : "settings"}
              records={st().matchHistory}
              loadError={st().matchHistoryLoadError}
              busy={props.ctx.busy()}
              canDelete={props.ctx.enabled()}
              onOpen={openRecord}
              onDelete={(match) => { deleteError.set(""); removing.set(match); }}
              onBack={back}
            />
          </View>
        </If>
        <If when={props.route?.view === "current" || Boolean(selection())}>
          <WerewolfHistoryHeader
            testID="werewolf-replay-back"
            title={replayTitle()}
            subtitle={readySelection() ? formatBoardLabel(readySelection()!.record, locale()) : undefined}
            backLabel={props.route?.view === "history" ? t("返回历史对局", "Back to Match History") : t("返回终局", "Back to Results")}
            onBack={back}
          />
          <If when={readySelection()}>
            {(replay) => (
              <WerewolfReplayView
                locale={locale()}
                match={replay().record}
                pluginDisabled={!props.ctx.enabled()}
                review={st().completedMatchId === replay().record.id ? st().aiMvpReview : replay().record.replay?.review}
                onRegenerate={props.route?.view === "current"
                  ? () => { void props.ctx.sendCommand({ type: "regenerate_mvp_review" }); }
                  : undefined}
              />
            )}
          </If>
          <If when={selection()?.status === "loading"}>
            <View class="flex-1 items-center justify-center">
              <LoadingIndicator stage label={t("读取复盘", "Loading replay")} />
            </View>
          </If>
          <If when={selection()?.status === "failed"}>
            <View class="flex-1 items-center justify-center gap-3 px-4">
              <Text class="text-stage-fg text-lg font-bold">{t("读取复盘失败", "Could not load replay")}</Text>
              <Text class="text-stage-pill-muted text-sm text-center">
                {(() => { const failed = selection(); return failed?.status === "failed" ? failed.error : ""; })()}
              </Text>
              <Button
                disabled={props.ctx.busy()}
                onPress={() => { const failed = selection(); if (failed) void readMatch(failed.source); }}
                class="min-h-11 rounded-xl px-4 items-center bg-stage-tile border border-stage-pill-border"
              >
                <Text class="text-stage-fg font-semibold">{t("重试", "Retry")}</Text>
              </Button>
            </View>
          </If>
        </If>
      </View>
      <Dialog
        open={Boolean(removing())}
        role="alertdialog"
        accessibilityLabel={deleteTitle()}
        animation={reduceMotion() ? "none" : "fade"}
        presentation="fullScreen"
        closeOnBackdropPress={false}
        closeOnSwipe={false}
        closeOnEscape={false}
        onCancel={() => { if (!props.ctx.busy()) removing.set(null); }}
        backdropClass="bg-backdrop"
        class="m-auto w-96 max-w-full rounded-2xl border border-stage-pill-border bg-stage-panel p-5"
      >
        <If when={removing()}>
          {(match) => (
            <View class="gap-3">
              <Text role="header" class="text-stage-fg text-xl font-bold">{deleteTitle()}</Text>
              <Text class="text-stage-pill-muted text-base">
                {formatBoardLabel(match(), locale())} · {formatDate(match().endedAtMs, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </Text>
              <If when={Boolean(deleteError())}><Text class="text-face-rose-core text-sm">{deleteError()}</Text></If>
              <View class="flex-row justify-end gap-2">
                <Button
                  disabled={props.ctx.busy()}
                  onPress={() => removing.set(null)}
                  class="min-h-11 px-4 rounded-xl border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75 focus-visible:ring-2 focus-visible:ring-face-amber-edge"
                >
                  <Text class="text-stage-fg font-semibold">{t("取消", "Cancel")}</Text>
                </Button>
                <Button
                  testID="werewolf-history-confirm-delete"
                  disabled={props.ctx.busy()}
                  onPress={() => { void deleteRecord(match().id); }}
                  class="min-h-11 px-4 rounded-xl bg-face-rose-core items-center justify-center active:opacity-75 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-face-amber-edge"
                >
                  <Text class="text-stage-bg font-bold">{t("删除", "Delete")}</Text>
                </Button>
              </View>
            </View>
          )}
        </If>
      </Dialog>
    </Dialog>
  );
}
